"use strict";
// Integration test for app.html's script WITHOUT a browser: it extracts the two
// inline <script> blocks (the inlined aapp-client.js + the app UI) and runs them
// in a Node `vm` against a minimal DOM/fetch shim, then verifies the AppClient
// wiring end to end — load, boot, an inbound agent message (render + presence),
// the optimistic send, and the boot sync. Run: `node test/app.test.js`.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const APP_PATH = path.join(__dirname, "..", ".claude", "skills", "aapp", "app.html");
const html = fs.readFileSync(APP_PATH, "utf8");

// ---- extract the inlined library + the app script ----
let b = html.indexOf("<!-- aapp-client.js:begin");
b = html.indexOf("-->", b) + 3;
let e = html.indexOf("<!-- aapp-client.js:end -->", b);
const libBlock = html.slice(b, e);
let libSrc = libBlock.slice(libBlock.indexOf("<script>") + 8, libBlock.lastIndexOf("</script>"));
// Surface event-handler exceptions instead of letting the emitter swallow them,
// so a real wiring bug fails the test rather than hiding.
libSrc = libSrc.replace(
  'if (type !== "error") this.emit("error", { error: e, context: "handler:" + type });',
  'console.error("HANDLER ERROR", type, e && e.stack || e); throw e;'
);
const after = html.indexOf("<!-- aapp-client.js:end -->");
let s = html.indexOf("<script>", after) + 8;
let en = html.indexOf("</script>", s);
const appSrc = html.slice(s, en);

// ---- minimal DOM ----
let appendedToList = 0;
let listEl;
function El(tag) {
  this.tag = tag; this.children = []; this.dataset = {}; this.style = {};
  this._text = ""; this._html = ""; this.value = ""; this.disabled = false; this.className = ""; this._listeners = {};
  const cl = new Set();
  this.classList = {
    add: (...c) => c.forEach((x) => cl.add(x)),
    remove: (...c) => c.forEach((x) => cl.delete(x)),
    toggle: (c, f) => (f === undefined ? (cl.has(c) ? cl.delete(c) : cl.add(c)) : f ? cl.add(c) : cl.delete(c)),
    contains: (c) => cl.has(c),
  };
}
Object.defineProperty(El.prototype, "textContent", { get() { return this._text; }, set(v) { this._text = String(v); } });
Object.defineProperty(El.prototype, "innerHTML", { get() { return this._html; }, set(v) { this._html = String(v); } });
El.prototype.scrollTop = 0; El.prototype.scrollHeight = 100; El.prototype.clientHeight = 50; El.prototype.offsetHeight = 20;
El.prototype.appendChild = function (c) { this.children.push(c); if (this === listEl) appendedToList++; return c; };
El.prototype.removeChild = function (c) { this.children = this.children.filter((x) => x !== c); };
El.prototype.remove = function () {};
El.prototype.querySelector = function () { return null; };
El.prototype.querySelectorAll = function () { return []; };
El.prototype.closest = function () { return null; };
El.prototype.addEventListener = function (ev, fn) { (this._listeners[ev] = this._listeners[ev] || []).push(fn); };
El.prototype.removeEventListener = function () {};
El.prototype.setAttribute = function () {};
El.prototype.getAttribute = function () { return null; };
El.prototype.focus = function () {}; El.prototype.select = function () {};
El.prototype.getContext = function () {
  return { createLinearGradient: () => ({ addColorStop() {} }), beginPath() {}, moveTo() {}, arcTo() {}, closePath() {}, fill() {}, fillRect() {}, drawImage() {}, fillText() {}, set fillStyle(v) {}, set font(v) {}, set textAlign(v) {}, set textBaseline(v) {} };
};
El.prototype.toDataURL = function () { return "data:image/png;base64,xxx"; };
El.prototype.toBlob = function (cb) { cb({ type: "image/jpeg" }); };

const byId = {};
["list","scroll","input","send","dot","statusText","empty","tobottom","unread","title","settingsBtn","fileInput","scrim","sheet","linkVal","shareBtn","copyBtn","actToggle","actSwitch","clearBtn","toast","a2hs","apple-icon"].forEach((id) => { byId[id] = new El("div"); byId[id].id = id; });
listEl = byId["list"];
byId["empty"].querySelector = () => new El("div");

const documentStub = {
  getElementById: (id) => byId[id] || (byId[id] = new El("div")),
  createElement: (t) => new El(t),
  querySelector: () => new El("meta"),
  querySelectorAll: () => [],
  addEventListener: () => {},
  body: new El("body"), head: new El("head"), title: "", hidden: false,
};

// ---- fetch shim (fake relay: streams one queued agent line, POSTs recorded) ----
const posts = [];
let deliverAgentLine = null;
function makeStreamBody() {
  let sent = false;
  return { getReader() { return { read() {
    if (!sent && deliverAgentLine) { sent = true; return Promise.resolve({ value: new TextEncoder().encode(deliverAgentLine + "\n"), done: false }); }
    return new Promise(() => {}); // park until abort
  } }; } };
}
async function fakeFetch(url, init) {
  init = init || {};
  const method = init.method || "GET";
  if (method === "POST") { posts.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({}) }; }
  if (method === "PUT") { return { ok: true, status: 200, json: async () => ({ attachment: { url: "https://ntfy.sh/f/x.jpg", name: "x.jpg", type: "image/jpeg", size: 12 } }) }; }
  if (/\/json\?/.test(url)) { return { ok: true, status: 200, body: makeStreamBody(), text: async () => "" }; }
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
}

// ---- window/global environment (browser-like) ----
const store = {};
const sandbox = {
  document: documentStub, navigator: { onLine: true },
  location: { hash: "#s=https://ntfy.sh&t=aapp-test123&n=Tester", href: "https://aapp.run/app.html#s=https://ntfy.sh&t=aapp-test123&n=Tester" },
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  fetch: fakeFetch, setTimeout, clearTimeout, setInterval: () => 0, clearInterval, requestAnimationFrame: (cb) => cb(), console,
  TextEncoder, TextDecoder, AbortController, Response, Blob, URL, ReadableStream,
  Set, Map, JSON, Math, Date, Promise, Object, Array, RegExp, Number, String, Boolean, isNaN, parseInt, parseFloat, decodeURIComponent, encodeURIComponent, unescape,
};
// In a browser window === self === globalThis; model that so the UMD wrapper
// installs AappClient as a real global the app script can see.
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {}; sandbox.removeEventListener = () => {};
sandbox.window.innerHeight = 800;
sandbox.window.visualViewport = null;
sandbox.CSS = { escape: (s) => String(s).replace(/[^\w-]/g, "_") };
URL.createObjectURL = () => "blob:fake";
vm.createContext(sandbox);

try {
  vm.runInContext(libSrc, sandbox, { filename: "aapp-client-inline.js" });
  assert.ok(sandbox.AappClient, "AappClient global defined by inlined library");
  console.log("  ✓ inlined library defines AappClient");
  deliverAgentLine = JSON.stringify({ id: "ntfy1", event: "message", message: JSON.stringify({ v: 1, cid: "agent", role: "agent", type: "msg", mid: "am1", seq: 0, last: true, text: "Hi from agent" }) });
  vm.runInContext(appSrc, sandbox, { filename: "app-script.js" });
  console.log("  ✓ app script loaded + booted without throwing");
} catch (err) {
  console.error("✗ threw during load/boot:", err && err.stack || err);
  process.exit(1);
}

(async () => {
  await new Promise((r) => setTimeout(r, 40));
  assert.strictEqual(byId["title"].textContent, "Tester", "title rendered from link (n=Tester)");
  console.log("  ✓ title rendered from link (n=Tester)");
  assert.ok(appendedToList > 0, "inbound agent message appended a row");
  assert.strictEqual(byId["statusText"].textContent, "online", "presence went online after agent signal");
  console.log("  ✓ inbound agent msg rendered + presence 'online' (receive wiring)");

  const before = posts.length;
  byId["input"].value = "hello from test";
  const clickHandlers = byId["send"]._listeners["click"] || [];
  assert.ok(clickHandlers.length > 0, "send button has a click handler");
  await clickHandlers[0]();
  await new Promise((r) => setTimeout(r, 10));
  const sent = posts.slice(before).filter((p) => p.body && p.body.type === "msg" && p.body.role === "user");
  assert.ok(sent.length >= 1, "sendMessage published a user msg envelope");
  assert.strictEqual(sent[0].body.text, "hello from test", "published text matches input");
  assert.ok(/aapp-test123/.test(sent[0].url), "published to the session topic");
  assert.ok(appendedToList > 0, "optimistic bubble appended to the list");
  console.log("  ✓ send flow publishes a chunked user msg + renders optimistic bubble");

  await new Promise((r) => setTimeout(r, 950));
  const syncs = posts.filter((p) => p.body && p.body.type === "sync");
  assert.ok(syncs.length >= 1, "boot requestSync published a sync envelope");
  console.log("  ✓ boot requestSync() publishes sync via the client");

  console.log("\napp.test.js: integration test passed ✅");
  process.exit(0);
})().catch((e) => { console.error("✗ FAILED:", e.stack || e.message); process.exit(1); });
