"use strict";
// Full end-to-end test: drives the REAL app.html in headless Chromium and the
// REAL bridge.py agent client, talking over a local ntfy-compatible relay
// (mini-ntfy.js) so it never depends on the public ntfy.sh or its rate limits.
//
// It is self-orchestrating — it starts the relay, mints a session, runs the
// agent-side listener, drives the browser, and tears everything down. Run:
//   node test/e2e.test.js
// Requires: playwright + a Chromium (PLAYWRIGHT_BROWSERS_PATH is honored).
const { spawn, execFileSync } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SKILL = path.join(__dirname, "..", ".claude", "skills", "aapp");
const BRIDGE = path.join(SKILL, "scripts", "bridge.py");
const PORT = Number(process.env.MINI_PORT || 8799);
const BASE = "http://localhost:" + PORT;
const STATE = path.join(os.tmpdir(), "aapp-e2e-" + process.pid + ".json");
const MSG_OUT = path.join(os.tmpdir(), "aapp-e2e-captured-" + process.pid + ".json");
const SHOT = process.env.E2E_SHOT || path.join(os.tmpdir(), "aapp-e2e-shot.png");

const PHONE_TEXT = "Hello from the phone 🐙 — does the refactor work?";
const AGENT_REPLY = "Reply from the agent ✅\n\nWith **markdown** and `code`:\n```js\nconsole.log('end to end')\n```";

function loadChromium() {
  const tries = ["playwright", "playwright-core"];
  for (const m of tries) { try { return require(m).chromium; } catch (e) {} }
  try {
    const groot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
    return require(path.join(groot, "playwright")).chromium;
  } catch (e) {}
  return null;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function bridge(args, extraEnv) {
  return execFileSync("python3", [BRIDGE, ...args], { env: { ...process.env, AAPP_STATE: STATE, ...extraEnv }, encoding: "utf8" });
}
function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (function poll() {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on("error", () => { if (Date.now() > deadline) reject(new Error("server not up: " + url)); else setTimeout(poll, 200); });
    })();
  });
}

(async () => {
  const chromium = loadChromium();
  if (!chromium) { console.log("SKIP e2e: playwright not installed (npm i -g playwright && npx playwright install chromium)"); process.exit(0); }

  const children = [];
  const cleanup = () => { for (const c of children) { try { c.kill("SIGKILL"); } catch (e) {} } for (const f of [STATE, MSG_OUT]) { try { fs.unlinkSync(f); } catch (e) {} } };
  process.on("exit", cleanup);

  let browser;
  try {
    // 1) local relay (serves app.html + speaks the ntfy wire subset)
    const relay = spawn("node", [path.join(__dirname, "mini-ntfy.js")], { env: { ...process.env, MINI_PORT: String(PORT) }, stdio: "inherit" });
    children.push(relay);
    await waitForServer(BASE + "/app.html", 8000);
    console.log("✓ local relay up on " + BASE);

    // 2) mint a session pointed at the local relay
    bridge(["new", "--force", "--server", BASE]);
    const topic = JSON.parse(fs.readFileSync(STATE, "utf8")).topic;
    console.log("✓ session minted, topic=" + topic);

    // 3) agent-side listener: beats presence + captures the phone's message
    const wait = spawn("python3", [BRIDGE, "wait", "--presence", "--timeout", "120", "--out", MSG_OUT], { env: { ...process.env, AAPP_STATE: STATE }, stdio: "inherit" });
    children.push(wait);
    await sleep(1000);

    // 4) drive the browser
    const link = BASE + "/app.html#s=" + BASE + "&t=" + topic + "&n=E2E%20Test";
    browser = await chromium.launch({ args: ["--no-sandbox"] });
    const page = await (await browser.newContext()).newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console.error: " + m.text()); });

    console.log("→ open app:", link);
    await page.goto(link, { waitUntil: "domcontentloaded" });

    await page.waitForFunction(() => document.getElementById("title") && document.getElementById("title").textContent === "E2E Test", null, { timeout: 10000 });
    console.log("✓ app loaded, title from link");
    await page.waitForFunction(() => document.getElementById("statusText").textContent === "online", null, { timeout: 20000 });
    console.log("✓ header 'online' (agent presence received)");

    await page.fill("#input", PHONE_TEXT);
    await page.click("#send");
    console.log("→ phone sent a message");
    await page.waitForFunction(() => [...document.querySelectorAll(".row.me .bubble")].some((b) => b.textContent.includes("does the refactor work")), null, { timeout: 8000 });
    console.log("✓ optimistic user bubble rendered");

    let captured = null;
    for (let i = 0; i < 60 && !captured; i++) { if (fs.existsSync(MSG_OUT)) { try { captured = JSON.parse(fs.readFileSync(MSG_OUT, "utf8")); } catch (e) {} } if (!captured) await sleep(500); }
    if (!captured) throw new Error("agent bridge.py wait never captured the phone message");
    if (!(captured.text || "").includes("does the refactor work")) throw new Error("agent captured wrong text: " + JSON.stringify(captured));
    console.log("✓ agent received it via bridge.py wait: " + JSON.stringify(captured.text));

    bridge(["send", "--text", AGENT_REPLY]);
    console.log("→ agent replied via bridge.py send");
    await page.waitForFunction(() => [...document.querySelectorAll(".row.them .bubble")].some((b) => b.textContent.includes("Reply from the agent")), null, { timeout: 15000 });
    const codeRendered = await page.evaluate(() => [...document.querySelectorAll(".row.them .bubble pre code")].some((c) => c.textContent.includes("end to end")));
    const boldRendered = await page.evaluate(() => [...document.querySelectorAll(".row.them .bubble strong")].some((x) => x.textContent.includes("markdown")));
    if (!codeRendered || !boldRendered) throw new Error("agent reply markdown not rendered (code=" + codeRendered + " bold=" + boldRendered + ")");
    console.log("✓ agent reply rendered in a them-bubble with markdown (code + bold)");

    await page.screenshot({ path: SHOT, fullPage: true }).catch(() => {});

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => {
      const me = [...document.querySelectorAll(".row.me .bubble")].some((b) => b.textContent.includes("does the refactor work"));
      const them = [...document.querySelectorAll(".row.them .bubble")].some((b) => b.textContent.includes("Reply from the agent"));
      return me && them;
    }, null, { timeout: 20000 });
    console.log("✓ after reload, history replay rebuilt both messages");

    if (errors.length) throw new Error("page errors observed:\n" + errors.join("\n"));
    console.log("✓ no page errors");

    await browser.close();
    console.log("\ne2e.test.js: END-TO-END PASSED ✅  (screenshot: " + SHOT + ")");
    process.exit(0);
  } catch (e) {
    if (browser) { try { await browser.close(); } catch (_) {} }
    console.error("\n✗ E2E FAILED:", e.message);
    process.exit(1);
  }
})();
