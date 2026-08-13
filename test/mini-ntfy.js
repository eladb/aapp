"use strict";
// A tiny in-memory ntfy-compatible relay for hermetic end-to-end testing, and
// it also serves the app. It implements just the wire subset aapp uses so the
// e2e test never depends on the public ntfy.sh (or its rate limits):
//
//   POST /{topic}                         -> publish (returns {id,...})
//   PUT  /{topic}  (Filename header)      -> attachment upload (returns {attachment})
//   GET  /{topic}/json?since=<cur>        -> live NDJSON stream (open + backlog + push)
//   GET  /{topic}/json?poll=1&since=<cur> -> backlog then close
//   GET  /app.html                        -> the real app (from ../.claude/skills/aapp)
//   GET  /file/{id}                       -> hosted attachment bytes
//
// Because the page and the relay share one origin, the browser only ever talks
// to localhost (no CORS, no proxy). Run standalone: `MINI_PORT=8779 node mini-ntfy.js`.
const http = require("http");
const fs = require("fs");
const path = require("path");

const APP_PATH = process.env.MINI_APP || path.join(__dirname, "..", ".claude", "skills", "aapp", "app.html");
const APP = fs.readFileSync(APP_PATH);
const PORT = Number(process.env.MINI_PORT || 8779);

let seq = 0;
const nextId = () => "m" + (++seq).toString(36).padStart(6, "0");
const topics = new Map(); // topic -> { msgs: [{id,time,message}], subs: Set(res) }
const files = new Map(); // id -> { buf, type, name }
function T(name) {
  let t = topics.get(name);
  if (!t) { t = { msgs: [], subs: new Set() }; topics.set(name, t); }
  return t;
}
function backlog(t, since) {
  if (!since || since === "all") return t.msgs;
  const i = t.msgs.findIndex((m) => m.id === since);
  return i < 0 ? t.msgs : t.msgs.slice(i + 1);
}
function readBody(req) {
  return new Promise((resolve) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => resolve(Buffer.concat(c))); });
}
const line = (o) => JSON.stringify(o) + "\n";

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  const p = u.pathname;

  if (p === "/app.html") { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(APP); }

  const fileM = p.match(/^\/file\/(.+)$/);
  if (fileM && req.method === "GET") {
    const f = files.get(fileM[1]);
    if (!f) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": f.type || "application/octet-stream", "Access-Control-Allow-Origin": "*" });
    return res.end(f.buf);
  }

  // GET /{topic}/json  (stream or poll)
  const streamM = p.match(/^\/([^/]+)\/json$/);
  if (streamM && req.method === "GET") {
    const topic = decodeURIComponent(streamM[1]);
    const t = T(topic);
    const since = u.searchParams.get("since") || "all";
    const poll = u.searchParams.get("poll") === "1";
    res.writeHead(200, { "Content-Type": "application/x-ndjson", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
    if (poll) { backlog(t, since).forEach((m) => res.write(line({ id: m.id, time: m.time, event: "message", topic, message: m.message }))); return res.end(); }
    // no id on the open frame, so the client never parks its cursor onto it
    res.write(line({ time: Math.floor(Date.now() / 1000), event: "open", topic }));
    backlog(t, since).forEach((m) => res.write(line({ id: m.id, time: m.time, event: "message", topic, message: m.message })));
    t.subs.add(res);
    const ka = setInterval(() => { try { res.write(line({ time: Math.floor(Date.now() / 1000), event: "keepalive", topic })); } catch (e) {} }, 20000);
    req.on("close", () => { clearInterval(ka); t.subs.delete(res); });
    return;
  }

  // POST /{topic} (publish) | PUT /{topic} (attach)
  const topicM = p.match(/^\/([^/]+)$/);
  if (topicM && (req.method === "POST" || req.method === "PUT")) {
    const topic = decodeURIComponent(topicM[1]);
    const t = T(topic);
    const buf = await readBody(req);
    if (req.method === "PUT") {
      const id = nextId();
      const type = req.headers["content-type"] || "application/octet-stream";
      const fname = req.headers["filename"] || "file";
      files.set(id, { buf, type, name: fname });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      return res.end(JSON.stringify({ id, attachment: { url: "http://localhost:" + PORT + "/file/" + id, name: fname, type, size: buf.length } }));
    }
    const id = nextId();
    const time = Math.floor(Date.now() / 1000);
    const message = buf.toString("utf8");
    t.msgs.push({ id, time, message });
    if (t.msgs.length > 1000) t.msgs.splice(0, t.msgs.length - 1000);
    const evt = line({ id, time, event: "message", topic, message });
    for (const s of t.subs) { try { s.write(evt); } catch (e) {} }
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    return res.end(JSON.stringify({ id, time, event: "message", topic, message }));
  }

  res.writeHead(404); res.end("not found");
});
server.listen(PORT, "127.0.0.1", () => console.log("mini-ntfy listening on http://localhost:" + PORT));
