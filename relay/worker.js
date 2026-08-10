// aapp-relay — an ntfy.sh-compatible relay on Cloudflare (Worker + Durable Object).
//
// One Worker + one Durable Object class "Topic" (one instance per topic via
// idFromName(topic)). A single dedicated instance idFromName("$files") holds
// uploaded attachments, because the frozen "/file/<id>" URL shape carries no
// topic and must be routable on its own.
//
// Mirrors the subset of the ntfy HTTP API that aapp uses:
//   POST /:topic                     -> publish an opaque envelope, fan out live
//   GET  /:topic/json?since&poll     -> ndjson replay + live stream (or poll)
//   PUT  /:topic  (Filename header)  -> upload an attachment blob
//   GET  /file/:id                   -> serve a stored blob
//
// Envelope bodies are OPAQUE strings; the relay never parses them.

const MAX_BUFFER = 500; // ring buffer size (messages retained per topic)
const MAX_BODY = 16 * 1024; // POST envelope cap (~8KB expected + slack)
const MAX_FILE = 5 * 1024 * 1024; // PUT attachment cap (~5MB)
const FILE_CHUNK = 120 * 1024; // blob chunk size — safely under the DO per-value limit
const KEEPALIVE_MS = 30000; // keepalive heartbeat / dead-sub reap cadence
const SLOW_LIMIT = 1000; // drop a subscriber if this many lines back up unread
const KEY_PAD = 20; // zero-pad width so message keys sort lexically by id
const FILES_NAME = "$files"; // singleton DO instance name for attachments
const LIVE_ONLY = Infinity; // parseSince() sentinel: no replay, stream from now

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Expose-Headers": "*",
};

// ---------------------------------------------------------------------------
// Worker entry: pure routing. All state lives in the Topic DO(s).
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS,
          "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
          // Echo the requested headers: older iOS/Safari WebKit does NOT honor
          // "*" as a wildcard for custom request headers (e.g. the Filename
          // header on the attachment PUT preflight). Echoing is always safe.
          "Access-Control-Allow-Headers":
            request.headers.get("Access-Control-Request-Headers") || "*",
          "Access-Control-Max-Age": "86400",
        },
      });
    }

    const segs = url.pathname.split("/").filter(Boolean);
    if (segs.length === 0) {
      return new Response("aapp-relay ok\n", { status: 200, headers: CORS });
    }

    // Reserved prefix GET /file/:id  -> the attachments singleton DO.
    if (segs[0] === "file") {
      if (!segs[1]) return new Response("missing file id\n", { status: 404, headers: CORS });
      const stub = env.TOPIC.get(env.TOPIC.idFromName(FILES_NAME));
      return stub.fetch(request);
    }

    // PUT /:topic (attachment upload) -> the attachments singleton DO.
    if (request.method === "PUT" && segs.length === 1) {
      const stub = env.TOPIC.get(env.TOPIC.idFromName(FILES_NAME));
      return stub.fetch(request);
    }

    // POST /:topic  and  GET /:topic/json  -> the per-topic DO.
    if (
      (request.method === "POST" && segs.length === 1) ||
      (request.method === "GET" && segs[1] === "json")
    ) {
      const topic = decodeURIComponent(segs[0]);
      // Reserved name: a topic literally named "$files" would collide with the
      // attachments singleton DO. Real topics are "aapp-<hex>", so reject it.
      if (topic === FILES_NAME) {
        return new Response("reserved topic name\n", { status: 400, headers: CORS });
      }
      const stub = env.TOPIC.get(env.TOPIC.idFromName(topic));
      return stub.fetch(request);
    }

    return new Response("not found\n", { status: 404, headers: CORS });
  },
};

// ---------------------------------------------------------------------------
// Topic Durable Object.
// ---------------------------------------------------------------------------
export class Topic {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.enc = new TextEncoder();

    // Transient in-memory subscriber set. Each sub = { controller, lastIntId, dead }.
    // Clients reconnect with their cursor after a DO eviction, so this need not persist.
    this.subs = new Set();

    // Persisted state, cached in memory. Loaded once, atomically, before any
    // request or alarm runs (blockConcurrencyWhile closes the input gate).
    this.counter = 0; // monotonic per-DO integer; base36 -> public id
    this.buffer = []; // ring buffer of {id, time, message}, ascending by id
    this.topicName = "";

    this.loaded = state.blockConcurrencyWhile(async () => {
      const st = state.storage;
      this.counter = (await st.get("counter")) || 0;
      this.topicName = (await st.get("topic")) || "";
      // Zero-padded keys => lexical list order == numeric id order, already sorted.
      const list = await st.list({ prefix: "m:" });
      this.buffer = [...list.values()];
      // Repair after a crash: never re-issue an id below what the buffer proves used.
      for (const item of this.buffer) {
        const ii = parseInt(item.id, 36);
        if (ii > this.counter) this.counter = ii;
      }
      while (this.buffer.length > MAX_BUFFER) {
        const old = this.buffer.shift();
        await st.delete(msgKey(parseInt(old.id, 36)));
      }
    });
  }

  async fetch(request) {
    await this.loaded;
    const url = new URL(request.url);
    const segs = url.pathname.split("/").filter(Boolean);

    if (segs[0] === "file") {
      return this.serveFile(segs.slice(1).join("/"));
    }
    if (request.method === "PUT") {
      return this.storeFile(request, url);
    }

    const topic = decodeURIComponent(segs[0] || this.topicName || "");
    if (topic && this.topicName !== topic) {
      this.topicName = topic;
      await this.state.storage.put("topic", topic);
    }

    if (request.method === "POST") return this.publish(request, topic);
    if (request.method === "GET" && segs[1] === "json") {
      const cursorInt = parseSince(url.searchParams.get("since"));
      const poll = url.searchParams.get("poll") === "1";
      return this.subscribe(topic, cursorInt, poll);
    }
    return new Response("not found\n", { status: 404, headers: CORS });
  }

  // POST /:topic — assign a monotonic id, persist durably, THEN fan out live.
  async publish(request, topic) {
    const declared = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (declared && declared > MAX_BODY) return jsonResp({ error: "envelope too large" }, 413);
    const body = await request.text();
    // Byte length (not UTF-16 code units) against the cap.
    if (this.enc.encode(body).length > MAX_BODY) {
      return jsonResp({ error: "envelope too large" }, 413);
    }

    // From here on there is no non-storage await, so no other event interleaves
    // (the DO input gate stays closed across the storage awaits). A subscriber
    // therefore sees this item via replay XOR live fan-out, never both/neither.
    this.counter += 1;
    const intId = this.counter;
    const id = intId.toString(36);
    const time = Math.floor(Date.now() / 1000);
    const item = { id, time, message: body };

    // 1) Persist counter + message in ONE atomic transaction (both survive eviction,
    //    and the id is durable before any subscriber can observe it -> no id reuse).
    await this.state.storage.put({ counter: this.counter, [msgKey(intId)]: item });

    // 2) Publish to the in-memory ring, then fan out to live subscribers.
    this.buffer.push(item);
    this.fanout(item, topic, intId);

    // 3) Trim the ring (in memory + storage).
    while (this.buffer.length > MAX_BUFFER) {
      const old = this.buffer.shift();
      await this.state.storage.delete(msgKey(parseInt(old.id, 36)));
    }

    return jsonResp({ id, time, event: "message", topic }, 200);
  }

  fanout(item, topic, intId) {
    const line = this.enc.encode(msgLine(item, topic));
    for (const sub of this.subs) {
      // Per-sub high-water mark: skip anything this stream already replayed, so a
      // message straddling the replay/live boundary is delivered exactly once.
      if (sub.dead || intId <= sub.lastIntId) {
        if (sub.dead) this.subs.delete(sub);
        continue;
      }
      if (this.push(sub, line)) sub.lastIntId = intId;
      else this.subs.delete(sub);
    }
  }

  // Enqueue with backpressure guarding: drop a stream that lets too many lines
  // pile up unread (bounds per-connection memory). Returns false if the sub died.
  push(sub, bytes) {
    if (sub.dead) return false;
    try {
      const ds = sub.controller.desiredSize;
      if (ds !== null && ds < -SLOW_LIMIT) {
        sub.dead = true;
        try { sub.controller.close(); } catch (e) {}
        return false;
      }
      sub.controller.enqueue(bytes);
      return true;
    } catch (e) {
      sub.dead = true;
      return false;
    }
  }

  // GET /:topic/json — poll (drain matched buffer + close) or stream (open + replay + live).
  subscribe(topic, cursorInt, poll) {
    if (poll) {
      // poll=1: replay matched buffer, then close. No open/keepalive lines, no waiting.
      // A live-only cursor (absent since) replays nothing.
      let out = "";
      if (cursorInt !== LIVE_ONLY) {
        for (const item of this.buffer) {
          if (parseInt(item.id, 36) > cursorInt) out += msgLine(item, topic);
        }
      }
      return new Response(out, { status: 200, headers: ndjsonHeaders() });
    }

    const self = this;
    let sub = null;
    const stream = new ReadableStream({
      start(controller) {
        // Synchronous: no await between snapshotting this.buffer/this.counter and
        // registering the controller, so no publish() can interleave. That atomic
        // pair is what makes reconnect exactly-once with no gap and no dup.
        const liveOnly = cursorInt === LIVE_ONLY;
        // Live-only: start the high-water mark at the current tail so nothing is
        // replayed but every subsequently-published id still fans out.
        const from = liveOnly ? self.counter : cursorInt;
        sub = { controller, lastIntId: from, dead: false };
        controller.enqueue(self.enc.encode(openLine(topic)));
        if (!liveOnly) {
          for (const item of self.buffer) {
            const ii = parseInt(item.id, 36);
            if (ii > cursorInt) {
              controller.enqueue(self.enc.encode(msgLine(item, topic)));
              sub.lastIntId = ii;
            }
          }
        }
        self.subs.add(sub);
      },
      cancel() {
        if (sub) {
          sub.dead = true;
          self.subs.delete(sub);
        }
      },
    });

    // Fire-and-forget: schedule the keepalive/reap alarm (does a storage await).
    this.ensureAlarm();
    return new Response(stream, { status: 200, headers: ndjsonHeaders() });
  }

  async ensureAlarm() {
    try {
      const cur = await this.state.storage.getAlarm();
      if (cur === null) await this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    } catch (e) {
      /* best-effort */
    }
  }

  async alarm() {
    await this.loaded;
    const line = this.enc.encode(keepaliveLine(this.topicName));
    for (const sub of [...this.subs]) {
      if (sub.dead || !this.push(sub, line)) this.subs.delete(sub);
    }
    // Keep the DO's timer (and thus itself) alive only while streams remain.
    if (this.subs.size > 0) {
      await this.state.storage.setAlarm(Date.now() + KEEPALIVE_MS);
    }
  }

  // PUT /:topic — store an attachment blob, chunked across DO storage values.
  // Metadata is written LAST so a crash mid-upload leaves orphan chunks but is
  // never served as a truncated blob (serveFile requires the meta record).
  async storeFile(request, url) {
    const declared = parseInt(request.headers.get("Content-Length") || "0", 10);
    if (declared && declared > MAX_FILE) return jsonResp({ error: "file too large" }, 413);

    const buf = new Uint8Array(await request.arrayBuffer());
    if (buf.length > MAX_FILE) return jsonResp({ error: "file too large" }, 413);

    // Header values are latin1; strip control chars and cap the length so a
    // stray newline can't corrupt the stored name / JSON response.
    const name = (request.headers.get("Filename") || "file")
      .replace(/[\r\n\t\x00-\x1f]/g, "")
      .slice(0, 256) || "file";
    const contentType = request.headers.get("Content-Type") || "application/octet-stream";

    this.counter += 1;
    await this.state.storage.put("counter", this.counter);
    const id = this.counter.toString(36);
    const chunks = Math.max(1, Math.ceil(buf.length / FILE_CHUNK));

    // Write chunks individually (bounded transaction size), meta last.
    for (let k = 0; k < chunks; k++) {
      // slice() copies into a standalone, structured-cloneable Uint8Array.
      await this.state.storage.put(
        "f:" + id + ":" + k,
        buf.slice(k * FILE_CHUNK, (k + 1) * FILE_CHUNK)
      );
    }
    await this.state.storage.put("f:" + id, { contentType, name, size: buf.length, chunks });

    const origin = new URL(request.url).origin;
    const fileUrl = origin + "/file/" + id;
    return jsonResp(
      {
        id,
        url: fileUrl,
        name,
        size: buf.length,
        // Mirror ntfy's attachment shape too, for clients that read it.
        attachment: { name, url: fileUrl, type: contentType, size: buf.length },
      },
      200
    );
  }

  // GET /file/:id — reassemble and serve a stored blob.
  async serveFile(rawId) {
    const id = decodeURIComponent(rawId || "");
    if (!id) return new Response("missing id\n", { status: 404, headers: CORS });
    const meta = await this.state.storage.get("f:" + id);
    if (!meta) return new Response("not found\n", { status: 404, headers: CORS });

    const parts = [];
    let total = 0;
    for (let k = 0; k < meta.chunks; k++) {
      const c = await this.state.storage.get("f:" + id + ":" + k);
      if (!c) return new Response("corrupt blob\n", { status: 404, headers: CORS });
      const u = c instanceof Uint8Array ? c : new Uint8Array(c);
      parts.push(u);
      total += u.length;
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
    }
    return new Response(out, {
      status: 200,
      headers: {
        ...CORS,
        "Content-Type": meta.contentType || "application/octet-stream",
        "Content-Length": String(total),
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function msgKey(n) {
  return "m:" + String(n).padStart(KEY_PAD, "0"); // fixed width => lexical == numeric
}

// since semantics:
//   absent/empty  -> LIVE_ONLY (stream from now, replay nothing) — matches ntfy,
//                    and required by bridge.py's sync responder which subscribes
//                    with no `since` expecting only new messages.
//   "all" / "0"   -> replay the ENTIRE buffer (cursor 0). app.html uses "all".
//   "<base36 id>" -> replay only ids > cursor.
//   anything else -> replay-all (0): a durations/timestamp-shaped value (ntfy
//                    accepts "10m", unix secs) is NOT a valid relay cursor;
//                    failing to over-replay (client dedups by id) is safe,
//                    whereas a bogus high cursor would silently drop history.
function parseSince(since) {
  if (since === null || since === undefined || since === "") return LIVE_ONLY;
  if (since === "all" || since === "0") return 0;
  if (/^[0-9a-z]+$/.test(since)) {
    const n = parseInt(since, 36);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function msgLine(item, topic) {
  // message is the opaque envelope string; JSON.stringify escapes it correctly.
  return (
    JSON.stringify({
      id: item.id,
      time: item.time,
      event: "message",
      topic,
      message: item.message,
    }) + "\n"
  );
}
function openLine(topic) {
  return JSON.stringify({ event: "open", topic }) + "\n";
}
function keepaliveLine(topic) {
  return JSON.stringify({ event: "keepalive", topic }) + "\n";
}

function ndjsonHeaders() {
  return {
    ...CORS,
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-store, no-transform",
    "X-Accel-Buffering": "no",
  };
}

function jsonResp(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}
