/*!
 * aapp-client.js — a tiny, dependency-free client for the aapp v1 wire protocol.
 *
 * This is the reusable client extracted from the phone app (`app.html`): all of
 * the transport + protocol logic with none of the DOM. Point it at an ntfy
 * relay + topic (or a full aapp link) and it will connect, de-dupe, reassemble
 * multi-part messages, track agent presence, and let you publish chat messages,
 * attachments, and sync requests. You supply the UI (or none at all).
 *
 * The wire protocol is documented in `reference/protocol.md`; the two reference
 * implementations that speak it are the phone app (`app.html`) and the agent
 * bridge (`scripts/bridge.py`). This library mirrors their semantics exactly —
 * same envelope shape, same byte-aware chunking budget, same presence timings,
 * same de-dupe rules — so it interoperates with both.
 *
 * Runs anywhere there is a `fetch` with a streaming response body: modern
 * browsers and Node 18+. No build step, no dependencies. Ships as UMD so it
 * works as a `<script>` (global `AappClient`), CommonJS `require`, or AMD.
 *
 * Quick start (browser):
 *
 *   const c = AappClient.fromLink(location.href);   // or new AappClient({server, topic})
 *   c.on("msg",        m => renderBubble(m));        // streaming agent/user messages
 *   c.on("activity",   a => renderActivity(a));      // session steps (summaries)
 *   c.on("typing",     t => showDots(t.state === "on"));
 *   c.on("presence",   p => setOnline(p.state === "online"));
 *   c.on("connection", s => setDot(s.state));        // relay link state
 *   c.start();
 *   await c.sendText("hello from my phone");
 *
 * License: MIT (see repo LICENSE).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else if (typeof define === "function" && define.amd) define([], factory);
  else root.AappClient = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- protocol constants (keep in sync with app.html / bridge.py) ----
  var PROTOCOL_VERSION = 1;
  var DEFAULT_SERVER = "https://relay.aapp.run";
  var MAX_ENVELOPE_BYTES = 3000; // keep each JSON body < ~3 KB so ntfy never
  //                                rejects or attaches an oversized message
  var AGENT_TTL = 90000; // agent considered offline after this much silence
  var BOOT_GRACE = 55000; // grace before declaring offline when we've heard nothing yet
  var PRESENCE_POLL = 8000; // how often to re-evaluate presence as time passes

  // ---- environment helpers ----
  var hasFetch = typeof fetch !== "undefined";
  var _TE = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;
  function now() {
    return Date.now();
  }
  function isOnline() {
    return typeof navigator === "undefined" || navigator.onLine !== false;
  }
  function randId(prefix) {
    return (
      (prefix || "") +
      Date.now().toString(36) +
      Math.random().toString(36).slice(2, 8)
    );
  }

  // Byte length of a string as it lands on the wire. TextEncoder counts UTF-8
  // bytes; the fallback approximates the same via encodeURIComponent.
  function byteLen(s) {
    if (_TE) return _TE.encode(s).length;
    return unescape(encodeURIComponent(s)).length;
  }

  // ---- link / hash parsing ----------------------------------------------
  // An aapp link carries the session in its URL *fragment* (never sent to the
  // host): `…/app.html#s=<server>&t=<topic>&n=<name>`. Parse either a full URL,
  // a bare "#…" fragment, or an "s=…&t=…" query string.
  function parseHash(input) {
    var h = String(input || "");
    var hashIdx = h.indexOf("#");
    if (hashIdx >= 0) h = h.slice(hashIdx + 1);
    h = h.replace(/^#/, "");
    var q = {};
    h.split("&").forEach(function (kv) {
      if (!kv) return;
      var i = kv.indexOf("=");
      var k = i < 0 ? kv : kv.slice(0, i);
      var v = i < 0 ? "" : decodeURIComponent(kv.slice(i + 1).replace(/\+/g, "%20"));
      q[k] = v;
    });
    return q;
  }

  // Extract {server, topic, name} from an aapp link (or fragment/query string).
  function parseLink(link) {
    var q = parseHash(link);
    var server = (q.s || "").replace(/\/+$/, "");
    return {
      server: server || DEFAULT_SERVER,
      topic: q.t || "",
      name: q.n || "",
    };
  }

  // Build the canonical shareable link for a session.
  function buildLink(opts) {
    opts = opts || {};
    var appUrl = opts.appUrl || "";
    var parts = [
      "s=" + encodeURIComponent((opts.server || DEFAULT_SERVER).replace(/\/+$/, "")),
      "t=" + encodeURIComponent(opts.topic || ""),
    ];
    if (opts.name) parts.push("n=" + encodeURIComponent(opts.name));
    return appUrl + "#" + parts.join("&");
  }

  // ---- byte-aware message chunking --------------------------------------
  // Mirrors app.html's makeEnvelopes and bridge.py's send-side chunking: split
  // `text` so each envelope's JSON body stays under MAX_ENVELOPE_BYTES, measuring
  // every code point as it serializes on the wire (JSON escapes non-ASCII to
  // \uXXXX). Parts share one `mid`; receivers reassemble by `mid` in `seq` order
  // until `last`. Returns { mid, envelopes }.
  function chunkText(text, cid, opts) {
    opts = opts || {};
    var mid = opts.mid || randId("u");
    var ts = opts.ts || now();
    var role = opts.role || "user";
    var skeleton = {
      v: PROTOCOL_VERSION,
      cid: cid,
      role: role,
      type: "msg",
      mid: mid,
      seq: 0,
      last: true,
      text: "",
      ts: ts,
    };
    var overhead = byteLen(JSON.stringify(skeleton)) + 8;
    var budget = Math.max(200, MAX_ENVELOPE_BYTES - overhead);
    var parts = [];
    var cur = "";
    var curB = 0;
    var chars = Array.from(String(text)); // iterate by code point (astral-safe)
    for (var idx = 0; idx < chars.length; idx++) {
      var ch = chars[idx];
      var b = byteLen(JSON.stringify(ch)) - 2; // minus the surrounding quotes
      if (curB + b > budget && cur) {
        parts.push(cur);
        cur = "";
        curB = 0;
      }
      cur += ch;
      curB += b;
    }
    parts.push(cur);
    var envelopes = parts.map(function (p, i) {
      return {
        v: PROTOCOL_VERSION,
        cid: cid,
        role: role,
        type: "msg",
        mid: mid,
        seq: i,
        last: i === parts.length - 1,
        text: p,
        ts: ts,
      };
    });
    return { mid: mid, envelopes: envelopes };
  }

  // ---- tiny event emitter ------------------------------------------------
  function Emitter() {
    this._handlers = {};
  }
  Emitter.prototype.on = function (type, fn) {
    (this._handlers[type] || (this._handlers[type] = [])).push(fn);
    return this;
  };
  Emitter.prototype.off = function (type, fn) {
    var hs = this._handlers[type];
    if (!hs) return this;
    if (!fn) {
      delete this._handlers[type];
      return this;
    }
    this._handlers[type] = hs.filter(function (h) {
      return h !== fn;
    });
    return this;
  };
  Emitter.prototype.once = function (type, fn) {
    var self = this;
    function wrap(payload) {
      self.off(type, wrap);
      fn(payload);
    }
    return this.on(type, wrap);
  };
  Emitter.prototype.emit = function (type, payload) {
    var hs = this._handlers[type];
    if (hs) {
      hs.slice().forEach(function (h) {
        try {
          h(payload);
        } catch (e) {
          if (type !== "error") this.emit("error", { error: e, context: "handler:" + type });
        }
      }, this);
    }
    return this;
  };

  // =======================================================================
  //  AappClient
  // =======================================================================
  //
  // options:
  //   server   relay base URL (default https://relay.aapp.run)
  //   topic    ntfy topic (the shared secret) — required to start
  //   cid      this instance's id (default random "js-…"); receivers ignore
  //            envelopes carrying their own cid, so this suppresses echoes
  //   cursor   ntfy read cursor to resume from ("all" replays the ~12h cache)
  //   mode     "auto" | "stream" | "poll" (default "auto")
  //   fetch    fetch implementation to use (default global fetch)
  //   presence whether to run the presence re-evaluation timer (default true)
  //   maxBackoff  cap on reconnect backoff ms (default 15000)
  //
  function AappClient(options) {
    if (!(this instanceof AappClient)) return new AappClient(options);
    Emitter.call(this);
    options = options || {};

    this.server = (options.server || DEFAULT_SERVER).replace(/\/+$/, "");
    this.topic = options.topic || "";
    this.name = options.name || "";
    this.cid = options.cid || randId("js-");
    this.cursor = options.cursor || "all";
    this.mode = options.mode || "auto";
    this.maxBackoff = options.maxBackoff || 15000;
    this._fetch = options.fetch || (hasFetch ? fetch.bind(null) : null);
    this._presenceEnabled = options.presence !== false;

    // connection state
    this.connState = "idle"; // idle|connecting|live|reconnecting|offline
    this._stopped = true;
    this._backoff = 1000;
    this._loopPromise = null;

    // de-dupe + reassembly buffers
    this._seenNtfy = Object.create(null); // ntfy line id -> true
    this._seenParts = Object.create(null); // mid -> Set(seq)  (msg/system)
    this._seenAtt = Object.create(null); // mid -> true (attach)
    this._seenAct = Object.create(null); // mid -> true (activity)
    this._msgs = Object.create(null); // mid -> {role,type,ts,parts,done}
    this._handled = 0; // count of inbound envelopes, for periodic pruning

    // presence
    this._bootTs = now();
    this._lastAgentTs = 0;
    this._presenceState = "unknown";
    this._presenceTimer = null;

    // bound listeners so we can remove them on stop
    this._onOnline = this._handleNetOnline.bind(this);
    this._onOffline = this._handleNetOffline.bind(this);
  }
  AappClient.prototype = Object.create(Emitter.prototype);
  AappClient.prototype.constructor = AappClient;

  // ---- static helpers / factory ----
  AappClient.PROTOCOL_VERSION = PROTOCOL_VERSION;
  AappClient.DEFAULT_SERVER = DEFAULT_SERVER;
  AappClient.parseLink = parseLink;
  AappClient.buildLink = buildLink;
  AappClient.chunkText = chunkText;
  AappClient.byteLen = byteLen;

  // Construct a client from a full aapp link / URL fragment.
  AappClient.fromLink = function (link, options) {
    var parsed = parseLink(link);
    var opts = {};
    for (var k in options) if (Object.prototype.hasOwnProperty.call(options, k)) opts[k] = options[k];
    if (opts.server == null) opts.server = parsed.server;
    if (opts.topic == null) opts.topic = parsed.topic;
    if (opts.name == null) opts.name = parsed.name;
    return new AappClient(opts);
  };

  // ---- lifecycle --------------------------------------------------------
  AappClient.prototype.start = function () {
    if (!this._stopped) return this;
    if (!this.topic) throw new Error("aapp: no topic — nothing to connect to");
    if (!this._fetch) throw new Error("aapp: no fetch available (pass options.fetch)");
    this._stopped = false;
    if (typeof addEventListener === "function") {
      addEventListener("online", this._onOnline);
      addEventListener("offline", this._onOffline);
    }
    if (this._presenceEnabled && typeof setInterval === "function") {
      var self = this;
      this._presenceTimer = setInterval(function () {
        self._evalPresence();
      }, PRESENCE_POLL);
    }
    var streaming = this.mode === "poll" ? false : this.mode === "stream" ? true : supportsStreaming();
    this._loopPromise = streaming ? this._streamLoop() : this._pollLoop();
    return this;
  };

  AappClient.prototype.stop = function () {
    this._stopped = true;
    if (this._presenceTimer) {
      clearInterval(this._presenceTimer);
      this._presenceTimer = null;
    }
    if (typeof removeEventListener === "function") {
      removeEventListener("online", this._onOnline);
      removeEventListener("offline", this._onOffline);
    }
    if (this._abort) {
      try {
        this._abort.abort();
      } catch (e) {}
    }
    this._setConn("idle");
    return this;
  };

  // ---- outbound: publish / send -----------------------------------------
  // Low-level publish of a raw envelope. Fills in v/cid/ts when absent.
  AappClient.prototype.publish = function (env) {
    if (!this.topic) return Promise.reject(new Error("aapp: no topic"));
    var full = {};
    for (var k in env) if (Object.prototype.hasOwnProperty.call(env, k)) full[k] = env[k];
    if (full.v == null) full.v = PROTOCOL_VERSION;
    if (full.cid == null) full.cid = this.cid;
    if (full.ts == null) full.ts = now();
    var url = this.server + "/" + encodeURIComponent(this.topic);
    return this._fetch(url, {
      method: "POST",
      body: JSON.stringify(full),
      headers: { "Content-Type": "application/json", Title: "aapp" },
    }).then(function (resp) {
      if (!resp || !resp.ok) throw new Error("aapp: publish failed " + (resp && resp.status));
      return resp;
    });
  };

  // Send a chat message as a `user` (default) — chunks and publishes each part
  // in order. Resolves with { mid } once all parts are on the wire.
  AappClient.prototype.sendText = function (text, opts) {
    opts = opts || {};
    text = String(text == null ? "" : text);
    if (!text.trim()) return Promise.reject(new Error("aapp: empty message"));
    var built = chunkText(text, this.cid, { role: opts.role || "user", mid: opts.mid });
    var self = this;
    var chain = Promise.resolve();
    built.envelopes.forEach(function (env) {
      chain = chain.then(function () {
        return self.publish(env);
      });
    });
    return chain.then(function () {
      return { mid: built.mid, parts: built.envelopes.length };
    });
  };

  // Upload a Blob/Buffer to the relay and announce it as an `attach` envelope.
  // `body` is anything ntfy's PUT accepts (browser Blob/File, or bytes in Node).
  // Resolves with the published attach envelope (incl. hosted url).
  AappClient.prototype.sendAttachment = function (body, meta) {
    meta = meta || {};
    var self = this;
    var mid = meta.mid || randId("a");
    var name = meta.name || "file";
    var mime = meta.mime || "application/octet-stream";
    var url = this.server + "/" + encodeURIComponent(this.topic);
    return this._fetch(url, {
      method: "PUT",
      body: body,
      headers: { Filename: name, "Content-Type": mime },
    })
      .then(function (resp) {
        if (!resp || !resp.ok) throw new Error("aapp: upload failed " + (resp && resp.status));
        return resp.json();
      })
      .then(function (j) {
        // ntfy returns {attachment:{url,name,type,size}}; the aapp relay returns
        // the fields at the TOP LEVEL ({url,id}). Accept either shape.
        var att = (j && j.attachment) ? j.attachment : j;
        if (!att || !att.url) throw new Error("aapp: no attachment url");
        var env = {
          v: PROTOCOL_VERSION,
          cid: self.cid,
          role: meta.role || "user",
          type: "attach",
          mid: mid,
          seq: 0,
          last: true,
          url: att.url,
          name: att.name || name,
          mime: att.type || mime,
          size: att.size != null ? att.size : meta.size,
          w: meta.w,
          h: meta.h,
          text: meta.text || "",
          ts: now(),
        };
        return self.publish(env).then(function () {
          return env;
        });
      });
  };

  // Ask the agent to replay durable history (sent once on boot by a fresh
  // client). The agent re-broadcasts its log tagged replay:true.
  AappClient.prototype.requestSync = function () {
    return this.publish({
      role: "user",
      type: "sync",
      mid: randId("sync-"),
      seq: 0,
      last: true,
    });
  };

  // Publish a typing indicator (`state` "on"|"off"). Rarely needed from a UI —
  // the agent bridge drives typing — but handy for tools driving the protocol.
  AappClient.prototype.sendTyping = function (on, role) {
    return this.publish({ role: role || "user", type: "typing", state: on ? "on" : "off" });
  };

  // ---- presence ---------------------------------------------------------
  // "online"  — heard an agent-side signal within AGENT_TTL
  // "unknown" — haven't heard anything yet, still within the boot grace window
  // "offline" — relay may be fine but no listener is answering
  AappClient.prototype.agentState = function () {
    if (this._lastAgentTs && now() - this._lastAgentTs < AGENT_TTL) return "online";
    if (!this._lastAgentTs && now() - this._bootTs < BOOT_GRACE) return "unknown";
    return "offline";
  };
  AappClient.prototype.isAgentOnline = function () {
    return this.agentState() === "online";
  };
  AappClient.prototype._noteAgent = function () {
    this._lastAgentTs = now();
    this._evalPresence();
  };
  AappClient.prototype._evalPresence = function () {
    var s = this.agentState();
    if (s !== this._presenceState) {
      this._presenceState = s;
      this.emit("presence", { state: s });
    }
  };

  // ---- inbound: envelope handling ---------------------------------------
  AappClient.prototype._handleEnvelope = function (env, ntfyId) {
    if (ntfyId) {
      if (this._seenNtfy[ntfyId]) return;
      this._seenNtfy[ntfyId] = true;
    }
    if ((++this._handled & 511) === 0) this._prune(); // bound de-dupe/buffer growth
    if (!env || env.v !== PROTOCOL_VERSION) return; // unknown/forward-incompatible
    if (env.cid === this.cid) return; // ignore our own echoes

    var role = env.role;
    var type = env.type || "msg";

    // Any signal from the agent side proves a listener is alive right now.
    if (role !== "user") this._noteAgent();

    this.emit("envelope", { env: env, ntfyId: ntfyId });

    switch (type) {
      case "presence":
        return; // liveness beat only — noteAgent already handled it
      case "typing":
        if (role !== "user") this.emit("typing", { state: env.state === "on" ? "on" : "off", role: role });
        return;
      case "status":
        if (role !== "user" && env.text) this.emit("status", { text: env.text, role: role });
        return;
      case "activity":
        return this._handleActivity(env, ntfyId);
      case "title":
        if (env.text) {
          this.name = String(env.text).trim() || this.name;
          this.emit("title", { text: env.text });
        }
        return;
      case "icon":
        this.emit("icon", { emoji: env.emoji || null, url: env.url || null, raw: env });
        return;
      case "reload":
        if (role !== "user") this.emit("reload", { force: !!env.force });
        return;
      case "sync":
        this.emit("sync", { role: role });
        return;
      case "sync-done":
        this.emit("sync-done", { count: env.count || 0 });
        return;
      case "attach":
        return this._handleAttach(env, ntfyId);
      case "msg":
      case "system":
        return this._handleMsg(env, ntfyId);
      default:
        return; // unknown type — ignore (forward-compatible)
    }
  };

  AappClient.prototype._handleMsg = function (env, ntfyId) {
    var mid = env.mid || ntfyId || randId("m");
    var seq = env.seq || 0;
    var set = this._seenParts[mid] || (this._seenParts[mid] = new Set());
    if (set.has(seq)) return; // duplicate part
    set.add(seq);

    var m = this._msgs[mid];
    if (!m) {
      m = {
        mid: mid,
        role: env.role,
        type: env.type,
        ts: env.ts || now(),
        done: false,
        replay: !!env.replay,
        cid: env.cid,
        parts: Object.create(null),
      };
      this._msgs[mid] = m;
    }
    m.parts[seq] = env.text || "";
    m.text = Object.keys(m.parts)
      .map(Number)
      .sort(function (a, b) {
        return a - b;
      })
      .map(function (k) {
        return m.parts[k];
      })
      .join("");
    if (env.last) m.done = true;

    var payload = {
      mid: mid,
      role: m.role,
      type: m.type,
      text: m.text,
      ts: m.ts,
      done: m.done,
      seq: seq,
      last: !!env.last,
      replay: m.replay,
    };
    this.emit(m.type === "system" ? "system" : "msg", payload);
  };

  AappClient.prototype._handleAttach = function (env, ntfyId) {
    var mid = env.mid || ntfyId;
    if (!mid || this._seenAtt[mid]) return;
    this._seenAtt[mid] = true;
    this.emit("attach", {
      mid: mid,
      role: env.role,
      type: "attach",
      mime: env.mime || "",
      url: env.url,
      name: env.name,
      size: env.size,
      w: env.w,
      h: env.h,
      text: env.text || "",
      ts: env.ts || now(),
      replay: !!env.replay,
    });
  };

  AappClient.prototype._handleActivity = function (env, ntfyId) {
    var mid = env.mid || ntfyId;
    if (!mid || this._seenAct[mid]) return;
    this._seenAct[mid] = true;
    this.emit("activity", {
      mid: mid,
      kind: env.kind || "tool",
      text: env.text || "",
      ts: env.ts || now(),
      replay: !!env.replay,
    });
  };

  // Bound the de-dupe indexes and reassembly buffers so a long-lived session
  // doesn't grow without limit. String keys iterate in insertion order, so
  // dropping the first N discards the oldest — the ones the read cursor has
  // long since passed. (The UI keeps its own rendered-message cap separately.)
  AappClient.prototype._prune = function () {
    trimObject(this._seenNtfy, 4000, 2000);
    trimObject(this._seenParts, 3000, 2000);
    trimObject(this._seenAtt, 3000, 2000);
    trimObject(this._seenAct, 3000, 2000);
    trimObject(this._msgs, 3000, 2000);
  };
  function trimObject(obj, cap, keep) {
    var ks = Object.keys(obj);
    if (ks.length <= cap) return;
    for (var i = 0; i < ks.length - keep; i++) delete obj[ks[i]];
  }

  // Feed a single ntfy JSON stream line (the outer `{"id","event","message"}`
  // object, as text). Exposed for tests and custom transports.
  AappClient.prototype.feedLine = function (line) {
    line = String(line || "").trim();
    if (!line) return;
    var outer;
    try {
      outer = JSON.parse(line);
    } catch (e) {
      return;
    }
    if (outer.id) this.cursor = outer.id;
    if (outer.event === "open") this.emit("open", outer);
    if (outer.event !== "message") return;
    var env;
    try {
      env = JSON.parse(outer.message);
    } catch (e) {
      return;
    }
    this._handleEnvelope(env, outer.id);
  };

  // ---- transport: streaming + polling -----------------------------------
  AappClient.prototype._endpoint = function (poll) {
    var base = this.server + "/" + encodeURIComponent(this.topic) + "/json?";
    if (poll) return base + "poll=1&since=" + encodeURIComponent(this.cursor);
    return base + "since=" + encodeURIComponent(this.cursor);
  };

  AappClient.prototype._setConn = function (state) {
    if (state === this.connState) return;
    this.connState = state;
    this.emit("connection", { state: state });
  };

  AappClient.prototype._streamLoop = function () {
    var self = this;
    return (async function () {
      while (!self._stopped) {
        self._setConn(self._haveHistory() ? "reconnecting" : "connecting");
        try {
          self._abort = typeof AbortController !== "undefined" ? new AbortController() : null;
          var resp = await self._fetch(self._endpoint(false), {
            signal: self._abort ? self._abort.signal : undefined,
            headers: { Accept: "application/x-ndjson" },
            cache: "no-store",
          });
          if (!resp.ok || !resp.body) throw new Error("bad response " + resp.status);
          self._setConn("live");
          self._backoff = 1000;
          var reader = resp.body.getReader();
          var dec = new TextDecoder();
          var buf = "";
          while (!self._stopped) {
            var r = await reader.read();
            if (r.done) break;
            buf += dec.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf("\n")) >= 0) {
              var l = buf.slice(0, idx);
              buf = buf.slice(idx + 1);
              self.feedLine(l);
            }
          }
        } catch (e) {
          if (self._stopped) return;
        }
        if (!isOnline()) {
          self._setConn("offline");
          await self._waitOnline();
          continue;
        }
        self._setConn("reconnecting");
        await sleep(self._backoff);
        self._backoff = Math.min(self._backoff * 1.7, self.maxBackoff);
      }
    })();
  };

  AappClient.prototype._pollLoop = function () {
    var self = this;
    return (async function () {
      while (!self._stopped) {
        if (!isOnline()) {
          self._setConn("offline");
          await self._waitOnline();
          continue;
        }
        try {
          var resp = await self._fetch(self._endpoint(true), { cache: "no-store" });
          if (!resp.ok) throw new Error("poll " + resp.status);
          var txt = await resp.text();
          self._setConn("live");
          self._backoff = 1000;
          txt.split("\n").forEach(function (l) {
            self.feedLine(l);
          });
        } catch (e) {
          self._setConn("reconnecting");
        }
        await sleep(1500);
      }
    })();
  };

  AappClient.prototype._haveHistory = function () {
    for (var k in this._msgs) return true;
    return false;
  };
  AappClient.prototype._handleNetOnline = function () {
    this._backoff = 1000;
  };
  AappClient.prototype._handleNetOffline = function () {
    this._setConn("offline");
  };
  AappClient.prototype._waitOnline = function () {
    return new Promise(function (resolve) {
      if (typeof addEventListener !== "function") return resolve();
      function h() {
        removeEventListener("online", h);
        resolve();
      }
      addEventListener("online", h);
    });
  };

  // ---- misc utils -------------------------------------------------------
  function sleep(ms) {
    return new Promise(function (r) {
      setTimeout(r, ms);
    });
  }
  function supportsStreaming() {
    try {
      return (
        typeof ReadableStream !== "undefined" &&
        typeof TextDecoder !== "undefined" &&
        !!new Response(new Blob()).body
      );
    } catch (e) {
      return false;
    }
  }

  return AappClient;
});
