"use strict";
// Unit tests for the aapp-client.js library — no browser, no network. Exercises
// link parsing, byte-aware chunking + reassembly, the inbound de-dupe/dispatch
// paths, presence, bounded pruning, and the send/publish surface (via a stubbed
// fetch). Run: `node test/client.test.js`.
const assert = require("assert");
const path = require("path");
const AappClient = require(path.join(__dirname, "..", ".claude", "skills", "aapp", "aapp-client.js"));

let passed = 0;
function ok(name, cond) { assert.ok(cond, name); passed++; console.log("  ✓ " + name); }

// ---- parseLink ----
console.log("parseLink");
let p = AappClient.parseLink("https://aapp.run/app.html#s=https://ntfy.sh&t=aapp-abc123&n=Nir%20Medical");
ok("server parsed", p.server === "https://ntfy.sh");
ok("topic parsed", p.topic === "aapp-abc123");
ok("name url-decoded", p.name === "Nir Medical");
ok("bare fragment works", AappClient.parseLink("#t=aapp-xyz").topic === "aapp-xyz");
ok("default server", AappClient.parseLink("#t=x").server === "https://ntfy.sh");
ok("trailing slash stripped", AappClient.parseLink("#s=https://n.sh/&t=x").server === "https://n.sh");

// ---- buildLink round-trips ----
console.log("buildLink");
let link = AappClient.buildLink({ appUrl: "https://aapp.run/app.html", server: "https://ntfy.sh", topic: "aapp-q1", name: "My Sess" });
let rt = AappClient.parseLink(link);
ok("round-trip topic", rt.topic === "aapp-q1");
ok("round-trip name", rt.name === "My Sess");

// ---- chunkText ----
console.log("chunkText");
let c1 = AappClient.chunkText("hello world", "js-test");
ok("single part for short text", c1.envelopes.length === 1);
ok("last flag set", c1.envelopes[0].last === true);
ok("shared mid present", !!c1.mid && c1.envelopes[0].mid === c1.mid);
ok("role user default", c1.envelopes[0].role === "user");

let big = "";
for (let i = 0; i < 5000; i++) big += "abcdefghij"[i % 10];
let c2 = AappClient.chunkText(big, "js-test");
ok("large text splits into multiple parts", c2.envelopes.length > 1);
ok("every envelope body <= 3000 bytes", c2.envelopes.every((e) => AappClient.byteLen(JSON.stringify(e)) <= 3000));
ok("parts reassemble to original", c2.envelopes.slice().sort((a, b) => a.seq - b.seq).map((e) => e.text).join("") === big);
ok("only final part has last=true", c2.envelopes.filter((e) => e.last).length === 1);
ok("seqs are 0..n-1", c2.envelopes.every((e, i) => e.seq === i));

let emoji = "🐙🚀✨".repeat(2000);
let c3 = AappClient.chunkText(emoji, "js-test");
ok("emoji: every body <= 3000", c3.envelopes.every((e) => AappClient.byteLen(JSON.stringify(e)) <= 3000));
ok("emoji: reassembles", c3.envelopes.map((e) => e.text).join("") === emoji);

// ---- inbound dispatch via feedLine ----
console.log("inbound dispatch");
const relayLine = (id, env) => JSON.stringify({ id, event: "message", message: JSON.stringify(env) });
let cli = new AappClient({ topic: "t", cid: "js-me", presence: false });
let msgs = [], acts = [], typings = [], attaches = [], titles = [];
cli.on("msg", (m) => msgs.push(m));
cli.on("activity", (a) => acts.push(a));
cli.on("typing", (t) => typings.push(t));
cli.on("attach", (a) => attaches.push(a));
cli.on("title", (t) => titles.push(t));

cli.feedLine(relayLine("n1", { v: 1, cid: "agent", role: "agent", type: "msg", mid: "m1", seq: 0, last: false, text: "Hello " }));
cli.feedLine(relayLine("n2", { v: 1, cid: "agent", role: "agent", type: "msg", mid: "m1", seq: 1, last: true, text: "there" }));
ok("msg emitted per part", msgs.length === 2);
ok("streaming assembles text", msgs[1].text === "Hello there");
ok("done true on last", msgs[1].done === true && msgs[0].done === false);
cli.feedLine(relayLine("n1", { v: 1, cid: "agent", role: "agent", type: "msg", mid: "m1", seq: 0, last: false, text: "Hello " }));
ok("duplicate ntfy id de-duped", msgs.length === 2);
cli.feedLine(relayLine("n3", { v: 1, cid: "agent", role: "agent", type: "msg", mid: "m1", seq: 1, last: true, text: "there" }));
ok("duplicate (mid,seq) de-duped", msgs.length === 2);
cli.feedLine(relayLine("n4", { v: 1, cid: "js-me", role: "user", type: "msg", mid: "mine", seq: 0, last: true, text: "echo" }));
ok("own cid echo suppressed", msgs.length === 2);
cli.feedLine(relayLine("n5", { v: 2, role: "agent", type: "msg", mid: "x", text: "future" }));
ok("unknown protocol version ignored", msgs.length === 2);
cli.feedLine(relayLine("n6", { v: 1, cid: "agent", role: "agent", type: "activity", kind: "tool", mid: "a1", text: "Read file" }));
cli.feedLine(relayLine("n7", { v: 1, cid: "agent", role: "agent", type: "activity", kind: "tool", mid: "a1", text: "Read file" }));
ok("activity de-duped by mid", acts.length === 1 && acts[0].kind === "tool");
cli.feedLine(relayLine("n8", { v: 1, cid: "agent", role: "agent", type: "typing", state: "on" }));
cli.feedLine(relayLine("n9", { v: 1, cid: "other", role: "user", type: "typing", state: "on" }));
ok("typing from agent only", typings.length === 1 && typings[0].state === "on");
cli.feedLine(relayLine("n10", { v: 1, cid: "agent", role: "agent", type: "attach", mid: "at1", url: "https://ntfy.sh/f/x.jpg", name: "x.jpg", mime: "image/jpeg", size: 100 }));
ok("attach emitted", attaches.length === 1 && attaches[0].mime === "image/jpeg");
cli.feedLine(relayLine("n11", { v: 1, cid: "agent", role: "agent", type: "title", text: "Renamed" }));
ok("title emitted + name updated", titles.length === 1 && cli.name === "Renamed");
ok("cursor tracks last id", cli.cursor === "n11");

// ---- presence ----
console.log("presence");
let pres = [];
let cli2 = new AappClient({ topic: "t", cid: "js-me2", presence: false });
cli2.on("presence", (x) => pres.push(x.state));
ok("initial agentState unknown", cli2.agentState() === "unknown");
cli2.feedLine(relayLine("p1", { v: 1, cid: "agent", role: "agent", type: "presence" }));
ok("agentState online after beat", cli2.agentState() === "online");
ok("presence event fired", pres[pres.length - 1] === "online");

// ---- pruning: bounded de-dupe maps on a long session ----
console.log("pruning");
let cli4 = new AappClient({ topic: "t", cid: "js-me4", presence: false });
for (let i = 0; i < 6000; i++) cli4.feedLine(relayLine("k" + i, { v: 1, cid: "agent", role: "agent", type: "activity", kind: "tool", mid: "act" + i, text: "x" }));
ok("_seenNtfy stays bounded (<=4000)", Object.keys(cli4._seenNtfy).length <= 4000);
ok("_seenAct stays bounded (<=3000)", Object.keys(cli4._seenAct).length <= 3000);

// ---- sendText / publish / requestSync via injected fetch ----
console.log("sendText / publish");
(async () => {
  let posted = [];
  const fakeFetch = (url, init) => { posted.push({ url, body: JSON.parse(init.body), init }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }); };
  let cli3 = new AappClient({ topic: "mytopic", cid: "js-send", fetch: fakeFetch, presence: false });
  let res = await cli3.sendText("hi there");
  ok("sendText resolves with mid", !!res.mid);
  ok("posted one envelope", posted.length === 1);
  ok("POST to topic url", posted[0].url === "https://ntfy.sh/mytopic");
  ok("envelope role user + text", posted[0].body.role === "user" && posted[0].body.text === "hi there");
  ok("envelope cid set", posted[0].body.cid === "js-send");
  ok("content-type json", posted[0].init.headers["Content-Type"] === "application/json");
  posted.length = 0;
  await cli3.requestSync();
  ok("sync published", posted.length === 1 && posted[0].body.type === "sync");
  console.log("\nclient.test.js: all " + passed + " assertions passed ✅");
})().catch((e) => { console.error("\n✗ FAILED:", e.stack || e.message); process.exit(1); });
