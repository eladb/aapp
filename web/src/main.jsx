import { useState, useEffect, useRef, useReducer, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { Liquid } from "liquid-gooey";
import { AappClient } from "./aapp-client.cjs";
import { esc, renderMarkdown } from "./markdown.js";
import { renderGlyphIcon, applyIcon } from "./icon.js";

// ============================================================================
//  Session params (from URL fragment or storage) — mirrors app.html.
//  The wire protocol lives in AappClient (bundled from aapp-client.js);
//  everything here is the React UI built on top of it.
// ============================================================================
const LS_LAST = "aapp:last";
const qp = AappClient.parseLink(location.href);
let server = qp.server;
let topic = qp.topic;
let name0 = qp.name;
if (!topic) {
  // resume last session if opened bare (e.g. from Home Screen without hash)
  try {
    const last = JSON.parse(localStorage.getItem(LS_LAST) || "null");
    if (last) { server = last.server; topic = last.topic; name0 = last.name || ""; }
  } catch (e) {}
}
if (!server) server = AappClient.DEFAULT_SERVER;
// a live title (streamed from the session) wins over the link's n= param
try { const sn = topic && localStorage.getItem("aapp:name:" + topic); if (sn) name0 = sn; } catch (e) {}
if (name0) {
  try { document.title = name0; } catch (e) {}
  const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]');
  if (meta) meta.setAttribute("content", name0);
}
if (topic) { try { localStorage.setItem(LS_LAST, JSON.stringify({ server, topic, name: name0 })); } catch (e) {} }
const STORE = "aapp:msgs:" + topic;

// Deploy stamps this with the commit sha (see pages workflow). Left as the
// literal placeholder when served unbuilt -> auto-update stays off so an
// unstamped copy never reload-loops.
var BUILD = "__AAPP_BUILD__";

// ---------- persisted history ----------
function loadInitial() {
  const res = { messages: [], cursor: "all", byId: {}, seenAct: {} };
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) {
      const d = JSON.parse(raw);
      res.messages = d.messages || [];
      res.cursor = d.cursor || "all";
      res.messages.forEach(function (m) {
        res.byId[m.mid] = m;
        if (m.type === "activity") res.seenAct[m.mid] = true;
      });
    }
  } catch (e) {}
  return res;
}

// ---------- time helpers (ported) ----------
function fmtTime(ts) { try { return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch (e) { return ""; } }
function dayKey(ts) { try { return new Date(ts).toDateString(); } catch (e) { return ""; } }
function fmtDay(ts) {
  var d = new Date(ts), n = new Date();
  var today = d.toDateString() === n.toDateString();
  var y = new Date(n.getTime() - 86400000);
  var yest = d.toDateString() === y.toDateString();
  if (today) return "Today";
  if (yest) return "Yesterday";
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}
function fmtSize(b) { if (b == null) return ""; if (b < 1024) return b + " B"; if (b < 1048576) return Math.round(b / 1024) + " KB"; return (b / 1048576).toFixed(1) + " MB"; }
function safeSrc(u) { return /^(https?:|blob:|data:image\/)/i.test(u || "") ? u : "#"; }
function cssEsc(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^\w-]/g, "_"); }

// ---------- bubble / attachment HTML (ported; rendered via innerHTML so the
//            markdown Copy buttons and links behave exactly like app.html) ----
function attachHTML(m) {
  if (/^image\//.test(m.mime || "")) {
    return '<a class="attlink" href="' + safeSrc(m.url) + '" target="_blank" rel="noopener noreferrer"><img class="att' + (m.uploading ? " up" : "") + '" src="' + safeSrc(m.url) + '" alt="' + esc(m.name || "image") + '"' + (m.w && m.h ? ' style="aspect-ratio:' + (m.w | 0) + "/" + (m.h | 0) + '"' : "") + "></a>";
  }
  return '<a class="filechip" href="' + safeSrc(m.url) + '" target="_blank" rel="noopener noreferrer" download><span class="fi">📄</span><span class="fn">' + esc(m.name || "file") + '</span><span class="fs">' + fmtSize(m.size) + "</span></a>";
}
function bubbleHTML(m) {
  var inner;
  if (m.type === "attach") { inner = attachHTML(m) + (m.text ? "<p>" + esc(m.text).replace(/\n/g, "<br>") + "</p>" : ""); }
  else if (m.role === "user") { inner = "<p>" + esc(m.text).replace(/\n/g, "<br>") + "</p>"; }
  else { inner = renderMarkdown(m.text || ""); }
  var status = m.type === "attach" && m.uploading ? "uploading… " : "";
  var caret = m.role === "agent" && m.type === "msg" && m.done === false && (m.text || "").length ? '<span class="stream-caret"></span>' : "";
  return inner + caret + '<div class="meta">' + status + fmtTime(m.ts) + "</div>";
}
function bubbleClass(m) { return "bubble" + (m.type === "attach" && /^image\//.test(m.mime || "") ? " media" : "") + (m.failed ? " failed" : ""); }

// ---------- self-update (ported) ----------
function buildStamped() { return BUILD && BUILD.indexOf("__") !== 0; }
let lastUpdCheck = 0;
function doReload(latest) {
  try { sessionStorage.setItem("aapp:reloadedFor", latest); } catch (e) {}
  var base = location.href.split("#")[0].split("?")[0], hash = location.hash || "";
  location.replace(base + "?v=" + encodeURIComponent(latest) + hash);
}
function checkForUpdate(force) {
  if (!buildStamped() && !force) return;
  var now = Date.now();
  if (!force && now - lastUpdCheck < 60000) return;
  lastUpdCheck = now;
  var url;
  try { url = new URL("version.json", location.href).href.split("#")[0]; } catch (e) { return; }
  fetch(url + "?_=" + now, { cache: "no-store" })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j) return;
      var latest = String(j.build || "");
      if (!latest || latest === BUILD) return;
      var tried; try { tried = sessionStorage.getItem("aapp:reloadedFor"); } catch (e) {}
      if (tried === latest) return;
      doReload(latest);
    })
    .catch(function () {});
}
function handleReloadSignal(env) {
  if (env && env.force) {
    var t = 0; try { t = +(sessionStorage.getItem("aapp:lastForceReload") || 0); } catch (e) {}
    if (Date.now() - t < 20000) return;
    try { sessionStorage.setItem("aapp:lastForceReload", String(Date.now())); } catch (e) {}
    location.reload();
  } else { checkForUpdate(true); }
}

// ---------- image downscale for attachments (ported) ----------
function downscaleImage(file, maxDim, quality) {
  return new Promise(function (resolve) {
    var img = new Image();
    img.onload = function () {
      var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      var scale = Math.min(1, maxDim / Math.max(w, h || 1));
      var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
      try {
        var c = document.createElement("canvas"); c.width = cw; c.height = ch;
        c.getContext("2d").drawImage(img, 0, 0, cw, ch);
        c.toBlob(function (b) { resolve({ blob: b || file, w: cw, h: ch }); }, "image/jpeg", quality);
      } catch (e) { resolve({ blob: file, w: w, h: h }); }
    };
    img.onerror = function () { resolve({ blob: file, w: 0, h: 0 }); };
    img.src = URL.createObjectURL(file);
  });
}

// ============================================================================
//  Presentational components
// ============================================================================
function ToolChip({ m }) {
  const txt = (m.text || "").trim();
  const sp = txt.search(/[\s:]/);
  const verb = sp > 0 ? txt.slice(0, sp) : txt;
  const rest = sp > 0 ? txt.slice(sp).replace(/^[\s:]+/, "") : "";
  return (
    <div className="toolchip">
      <span className="tv">{verb || "tool"}</span>
      {rest ? <span className="tt">{rest}</span> : null}
    </div>
  );
}
function ActivityLine({ m }) {
  const kind = m.kind || "tool";
  if (kind === "tool") return <ToolChip m={m} />;
  return (
    <div className={"act " + kind}>
      <div className="ai">{kind === "assistant" ? "◈" : ""}</div>
      {kind === "assistant"
        ? <div className="ax" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text || "") }} />
        : <div className="ax">{m.text}</div>}
    </div>
  );
}
// Consecutive activity collapses into one "Working · N steps" trace that stays
// expanded while live and auto-collapses when the reply lands.
function Trace({ items, live }) {
  const [open, setOpen] = useState(live);
  const prev = useRef(live);
  useEffect(() => { if (prev.current !== live) { prev.current = live; setOpen(live); } }, [live]);
  const n = items.length;
  return (
    <div className={"trace" + (open ? " open" : "")}>
      <div className="trace-h" onClick={() => setOpen((o) => !o)}>
        <span className="spark">✦</span>
        <span className="tlbl">Working</span>
        <span className="tn">{n + (n === 1 ? " step" : " steps")}</span>
        <span className="chev">⌄</span>
      </div>
      <div className="trace-b">{items.map((m) => <ActivityLine key={m.mid} m={m} />)}</div>
    </div>
  );
}
function MessageRow({ m }) {
  const mine = m.role === "user";
  return (
    <div className={"row " + (mine ? "me" : "them")} data-mid={m.mid}>
      <div className={bubbleClass(m)} dangerouslySetInnerHTML={{ __html: bubbleHTML(m) }} />
    </div>
  );
}
function AskCard({ m, onChoose }) {
  const foot = m.answered
    ? "✓ Answered — " + (m.chosen || "")
    : m.options && m.options.length
    ? (m.freeText ? "Tap an option, or reply below" : "Tap an option")
    : "Reply below to answer";
  return (
    <div className="askwrap" data-mid={m.mid}>
      <div className={"askcard" + (m.answered ? " answered" : "")}>
        <div className="q"><span className="qi"><span className="spark">✦</span><span>{m.text || ""}</span></span></div>
        <div className="askopts">
          {(m.options || []).map((o, i) => (
            <button key={i} type="button"
              className={"askopt" + (m.answered && m.chosen === o.value ? " chosen" : "")}
              onClick={() => { if (!m.answered) onChoose(m, o.value); }}>
              <span className="ring" /><span className="ol">{o.label}</span>
            </button>
          ))}
        </div>
        <div className="askfoot"><span className="ft">{foot}</span></div>
      </div>
    </div>
  );
}
function ThinkingPill({ startTs, label }) {
  const [el, setEl] = useState("0.0s");
  useEffect(() => {
    const t = setInterval(() => {
      const ms = Date.now() - startTs, s = ms / 1000;
      setEl((s < 10 ? s.toFixed(1) : Math.round(s)) + "s");
    }, 100);
    return () => clearInterval(t);
  }, [startTs]);
  const cells = [];
  for (let i = 0; i < 9; i++) cells.push(<i key={i} />);
  return (
    <div className="row them">
      <div className="bubble" style={{ padding: 0 }}>
        <div className="think">
          <div className="pixgrid" aria-hidden="true">{cells}</div>
          <span className="lbl">{label || "Thinking"}</span>
          <span className="elapsed">{el}</span>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
//  App
// ============================================================================
const initial = loadInitial();

function App() {
  // refs (protocol/mutable model — mirrors app.html's plain vars)
  const messagesRef = useRef(initial.messages);
  const byIdRef = useRef(initial.byId);
  const seenActRef = useRef(initial.seenAct);
  const clientRef = useRef(null);
  const listRef = useRef(null);
  const scrollRef = useRef(null);
  const inputRef = useRef(null);
  const avatarRef = useRef(null);
  const nameRef = useRef(name0);
  const curGlyphRef = useRef("◈");
  const atBottomRef = useRef(true);
  const needScrollRef = useRef(true);
  const userGesturedRef = useRef(false);
  const warnedOfflineRef = useRef(false);
  const typingActiveRef = useRef(false);
  const thinkTimerRef = useRef(null);
  const statusTimerRef = useRef(null);
  const saveTRef = useRef(null);
  const toastTRef = useRef(null);

  // react state (drives rendering)
  const [, forceRender] = useReducer((x) => x + 1, 0);
  const [connState, setConnState] = useState(topic ? "connecting" : "offline");
  const [statusOverride, setStatusOverride] = useState("");
  const [, setTick] = useState(0);
  const [typing, setTypingState] = useState(false);
  const [thinkStart, setThinkStart] = useState(0);
  const [thinkLabel, setThinkLabel] = useState("Thinking");
  const [name, setName] = useState(name0 || "");
  const [showActivity, setShowActivity] = useState(() => { try { return localStorage.getItem("aapp:showActivity") !== "0"; } catch (e) { return true; } });
  const [unread, setUnread] = useState(0);
  const [showFab, setShowFab] = useState(false);
  const [canSend, setCanSend] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [toastMsg, setToastMsg] = useState("");
  const [toastShow, setToastShow] = useState(false);

  // ---------- small utilities ----------
  function save() {
    if (saveTRef.current) return;
    saveTRef.current = setTimeout(function () {
      saveTRef.current = null;
      try { localStorage.setItem(STORE, JSON.stringify({ messages: messagesRef.current.slice(-400), cursor: clientRef.current ? clientRef.current.cursor : initial.cursor })); } catch (e) {}
    }, 250);
  }
  function buzz(ms) { if (!userGesturedRef.current) return; try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).catch(function () { fallbackCopy(t); });
    else fallbackCopy(t);
  }
  function fallbackCopy(t) {
    var ta = document.createElement("textarea"); ta.value = t; ta.style.position = "fixed"; ta.style.opacity = "0";
    document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove();
  }
  function toast(msg) {
    setToastMsg(msg); setToastShow(true);
    if (toastTRef.current) clearTimeout(toastTRef.current);
    toastTRef.current = setTimeout(function () { setToastShow(false); }, 1600);
  }

  // ---------- scroll ----------
  function scrollToBottom(instant) {
    const el = scrollRef.current; if (!el) return;
    const doit = function () { el.scrollTop = el.scrollHeight; };
    if (instant) {
      const b = el.style.scrollBehavior; el.style.scrollBehavior = "auto";
      doit(); requestAnimationFrame(function () { doit(); el.style.scrollBehavior = b; });
    } else { doit(); requestAnimationFrame(doit); }
    setUnread(0); atBottomRef.current = true; setShowFab(false);
  }
  function afterAppend(m) {
    const chatOrAsk = m && (m.type === "msg" || m.type === "attach" || m.type === "ask");
    if (atBottomRef.current) needScrollRef.current = true;
    else if (chatOrAsk) { setUnread((u) => u + 1); setShowFab(true); }
    forceRender(); save();
  }
  function pruneMemory() {
    const messages = messagesRef.current;
    if (messages.length > 600) {
      const drop = messages.length - 400;
      for (let i = 0; i < drop; i++) { const old = messages[i]; if (old) { delete byIdRef.current[old.mid]; delete seenActRef.current[old.mid]; } }
      messages.splice(0, drop);
    }
  }

  // ---------- thinking indicator ----------
  function armThink() {
    if (thinkTimerRef.current) clearTimeout(thinkTimerRef.current);
    thinkTimerRef.current = setTimeout(function () { setTyping(false); }, 150000);
  }
  function keepThinking() { if (typingActiveRef.current) armThink(); }
  function setTyping(on) {
    if (on) {
      armThink();
      if (typingActiveRef.current) return; // already showing — keep the same start
      typingActiveRef.current = true;
      setThinkStart(Date.now()); setThinkLabel("Thinking"); setTypingState(true);
      if (atBottomRef.current) needScrollRef.current = true;
    } else {
      if (thinkTimerRef.current) { clearTimeout(thinkTimerRef.current); thinkTimerRef.current = null; }
      typingActiveRef.current = false; setTypingState(false);
    }
  }

  // ---------- header status / name / icon ----------
  function computeStatus() {
    if (statusOverride) return { cls: "dot live", text: statusOverride };
    if (connState === "offline") return { cls: "dot err", text: "offline" };
    if (connState === "connecting" || connState === "idle") return { cls: "dot warn", text: "connecting…" };
    if (connState === "reconnecting") return { cls: "dot warn", text: "reconnecting…" };
    const a = clientRef.current ? clientRef.current.agentState() : "unknown";
    if (a === "online") return { cls: "dot live", text: "online" };
    if (a === "unknown") return { cls: "dot warn", text: "connecting…" };
    return { cls: "dot warn", text: "not listening" };
  }
  function showStatus(text) {
    if (!text) return;
    keepThinking();
    if (typingActiveRef.current) setThinkLabel(text);
    setStatusOverride(text);
    if (statusTimerRef.current) clearTimeout(statusTimerRef.current);
    statusTimerRef.current = setTimeout(function () { setStatusOverride(""); }, 4000);
  }
  function setAppName(nm) {
    nm = (nm || "").trim(); if (!nm || nm === nameRef.current) return;
    nameRef.current = nm; setName(nm);
    try { document.title = nm; } catch (e) {}
    const meta = document.querySelector('meta[name="apple-mobile-web-app-title"]'); if (meta) meta.setAttribute("content", nm);
    try { localStorage.setItem("aapp:name:" + topic, nm); } catch (e) {}
    try { const last = JSON.parse(localStorage.getItem(LS_LAST) || "null"); if (last) { last.name = nm; localStorage.setItem(LS_LAST, JSON.stringify(last)); } } catch (e) {}
  }
  function setAppIcon(env) {
    var url = null, emoji = null;
    if (env.emoji) { emoji = env.emoji; curGlyphRef.current = env.emoji; url = renderGlyphIcon(env.emoji); }
    else if (env.url) { url = env.url; }
    if (!url) return;
    applyIcon(url, emoji, avatarRef.current, nameRef.current);
    try { localStorage.setItem("aapp:icon:" + topic, JSON.stringify(env)); } catch (e) {}
  }

  // ---------- inbound handlers (fold client events into the model) ----------
  function addSystem(text, ts) {
    const m = { mid: "sys-" + Math.random().toString(36).slice(2), role: "system", type: "system", text: text, ts: ts || Date.now(), done: true };
    messagesRef.current.push(m); byIdRef.current[m.mid] = m; afterAppend(m);
  }
  function onMsg(p) {
    let m = byIdRef.current[p.mid];
    if (!m) { m = { mid: p.mid, role: p.role, type: "msg", text: p.text, ts: p.ts, done: p.done, cid: p.cid }; byIdRef.current[p.mid] = m; messagesRef.current.push(m); }
    else { m.text = p.text; m.done = p.done; }
    if (p.role === "agent") setTyping(false);
    afterAppend(m); pruneMemory();
  }
  function onSystem(p) {
    let m = byIdRef.current[p.mid];
    if (!m) { m = { mid: p.mid, role: "system", type: "system", text: p.text, ts: p.ts, done: true }; byIdRef.current[p.mid] = m; messagesRef.current.push(m); }
    else { m.text = p.text; }
    afterAppend(m); pruneMemory();
  }
  function addAttach(p) {
    if (!p.mid || byIdRef.current[p.mid]) return;
    const m = { mid: p.mid, role: p.role, type: "attach", mime: p.mime || "", url: p.url, name: p.name, size: p.size, w: p.w, h: p.h, text: p.text || "", ts: p.ts, done: true };
    byIdRef.current[p.mid] = m; messagesRef.current.push(m); afterAppend(m); pruneMemory();
  }
  function addActivity(p) {
    if (!p.mid || seenActRef.current[p.mid]) return; seenActRef.current[p.mid] = true;
    const m = { mid: p.mid, role: "activity", type: "activity", kind: p.kind || "tool", text: p.text || "", ts: p.ts, done: true };
    byIdRef.current[p.mid] = m; messagesRef.current.push(m); afterAppend(m); pruneMemory();
    keepThinking();
  }
  function onAsk(p) {
    if (byIdRef.current[p.mid]) return;
    const m = { mid: p.mid, role: "agent", type: "ask", text: p.text || "", options: p.options || [], freeText: p.freeText !== false, answered: false, chosen: null, ts: p.ts, done: true };
    byIdRef.current[p.mid] = m; messagesRef.current.push(m);
    setTyping(false);
    afterAppend(m); pruneMemory();
    if (!p.replay) buzz(14);
  }
  function onAskChoose(m, val) {
    if (m.answered) return;
    m.answered = true; m.chosen = val; forceRender(); save(); buzz(8);
    submitText(val);
  }

  // ---------- sending ----------
  async function submitText(text) {
    text = (text || "").trim(); if (!text || !topic || !clientRef.current) return;
    const mid = "u" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const m = { mid: mid, role: "user", type: "msg", text: text, ts: Date.now(), done: true, mine: true };
    byIdRef.current[mid] = m; messagesRef.current.push(m);
    afterAppend(m); buzz(10);
    if (clientRef.current.agentState() === "offline") {
      if (!warnedOfflineRef.current) {
        warnedOfflineRef.current = true;
        addSystem("⚠︎ No agent is listening right now — your message is queued and will arrive once the listener runs. Start it in your Claude Code session (run bridge.py wait), or ask the agent to resume.");
      }
    } else { setTyping(true); }
    try { await clientRef.current.sendText(text, { mid: mid }); }
    catch (e) { m.failed = true; forceRender(); addSystem("⚠︎ Message failed to send — check your connection and try again."); }
  }
  async function sendMessage() {
    const text = inputRef.current.value.trim(); if (!text) return;
    inputRef.current.value = ""; autoGrow(); setCanSend(false);
    await submitText(text);
    inputRef.current.focus();
  }
  function autoGrow() {
    const el = inputRef.current; if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, window.innerHeight * 0.38) + "px";
  }
  async function handleFile(file) {
    if (!file || !topic || !clientRef.current) return;
    const isImg = /^image\//.test(file.type || "");
    const mid = "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const m = { mid: mid, role: "user", type: "attach", mime: file.type || "application/octet-stream", url: URL.createObjectURL(file), name: file.name, size: file.size, mine: true, ts: Date.now(), done: true, uploading: true };
    byIdRef.current[mid] = m; messagesRef.current.push(m); afterAppend(m);
    setTyping(true);
    try {
      let blob = file, w = 0, h = 0;
      if (isImg) { const d = await downscaleImage(file, 1600, 0.85); blob = d.blob; w = d.w; h = d.h; m.mime = "image/jpeg"; }
      const env = await clientRef.current.sendAttachment(blob, { mid: mid, name: file.name, mime: blob.type || file.type || m.mime, w: w, h: h });
      m.url = env.url; if (env.size != null) m.size = env.size; m.uploading = false; forceRender(); save();
    } catch (e) {
      m.uploading = false; m.failed = true; forceRender();
      addSystem("⚠︎ Upload failed — check your connection and try again.");
    }
  }

  // ---------- list click delegation (markdown code Copy buttons) ----------
  function onListClick(e) {
    const btn = e.target.closest && e.target.closest(".copy");
    if (btn) {
      const code = btn.parentElement.querySelector("code");
      copyText(code ? code.textContent : "");
      btn.textContent = "Copied!";
      setTimeout(function () { btn.textContent = "Copy"; }, 1200);
    }
  }

  // ---------- settings sheet actions ----------
  function toggleActivity() {
    setShowActivity(function (v) { const nv = !v; try { localStorage.setItem("aapp:showActivity", nv ? "1" : "0"); } catch (e) {} return nv; });
  }
  async function doShare() {
    if (navigator.share) { try { await navigator.share({ title: nameRef.current || "Agent chat", url: location.href }); } catch (e) {} }
    else { copyText(location.href); toast("Link copied"); }
  }
  function clearHistory() {
    if (!confirm("Clear this conversation on this device? (The session itself is unaffected.)")) return;
    messagesRef.current = []; byIdRef.current = {}; seenActRef.current = {};
    try { localStorage.removeItem(STORE); } catch (e) {}
    forceRender(); setSheetOpen(false); toast("History cleared");
  }

  // ================= effects =================
  // body class for the activity toggle
  useEffect(() => { document.body.classList.toggle("hide-activity", !showActivity); }, [showActivity]);

  // initial icon
  useEffect(() => {
    let stored = null;
    try { stored = JSON.parse(localStorage.getItem("aapp:icon:" + topic) || "null"); } catch (e) {}
    if (stored && (stored.emoji || stored.url)) setAppIcon(stored);
    else { try { applyIcon(renderGlyphIcon(curGlyphRef.current), curGlyphRef.current, avatarRef.current, nameRef.current); } catch (e) {} }
    // eslint-disable-next-line
  }, []);

  // client lifecycle + presence/auto-update timers
  useEffect(() => {
    if (!topic) return;
    const client = new AappClient({ server: server, topic: topic, name: nameRef.current, cursor: initial.cursor });
    clientRef.current = client;
    client.on("connection", function (s) { setConnState(s.state); });
    client.on("presence", function () { setTick((t) => t + 1); });
    client.on("msg", onMsg);
    client.on("system", onSystem);
    client.on("attach", addAttach);
    client.on("activity", addActivity);
    client.on("ask", onAsk);
    client.on("typing", function (t) { setTyping(t.state === "on"); });
    client.on("status", function (s) { showStatus(s.text); });
    client.on("title", function (t) { setAppName(t.text); });
    client.on("icon", function (i) { setAppIcon({ emoji: i.emoji, url: i.url }); });
    client.on("reload", function (r) { handleReloadSignal(r); });
    client.start();
    const s1 = setTimeout(function () { try { client.requestSync(); } catch (e) {} }, 900);
    const s2 = setTimeout(function () { try { client.requestSync(); } catch (e) {} }, 5000);
    const u1 = setTimeout(function () { checkForUpdate(false); }, 2500);
    const u2 = setInterval(function () { checkForUpdate(false); }, 15 * 60 * 1000);
    const pres = setInterval(function () {
      setTick((t) => t + 1);
      if (clientRef.current && clientRef.current.agentState() === "offline" && typingActiveRef.current) setTyping(false);
    }, 8000);
    return function () { client.stop(); clearTimeout(s1); clearTimeout(s2); clearTimeout(u1); clearInterval(u2); clearInterval(pres); };
    // eslint-disable-next-line
  }, []);

  // scroll listener + keep-latest-pinned on viewport/keyboard resize
  useEffect(() => {
    const scrollEl = scrollRef.current; if (!scrollEl) return;
    function onScroll() {
      const near = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 60;
      atBottomRef.current = near;
      if (near) { setUnread(0); setShowFab(false); } else setShowFab(true);
    }
    function stick() { if (atBottomRef.current) scrollToBottom(true); }
    function oc() { setTimeout(function () { scrollToBottom(true); }, 300); }
    scrollEl.addEventListener("scroll", onScroll);
    window.addEventListener("resize", stick);
    window.addEventListener("orientationchange", oc);
    if (window.visualViewport) window.visualViewport.addEventListener("resize", stick);
    return function () {
      scrollEl.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", stick);
      window.removeEventListener("orientationchange", oc);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", stick);
    };
    // eslint-disable-next-line
  }, []);

  // haptics: unlock only after a real user gesture
  useEffect(() => {
    const set = function () { userGesturedRef.current = true; };
    const evs = ["pointerdown", "touchstart", "keydown"];
    evs.forEach(function (ev) { document.addEventListener(ev, set, { passive: true }); });
    return function () { evs.forEach(function (ev) { document.removeEventListener(ev, set); }); };
  }, []);

  // long-press (and right-click) a message -> action menu (ported)
  useEffect(() => {
    const listEl = listRef.current, scrollEl = scrollRef.current;
    if (!listEl) return;
    const menu = document.createElement("div");
    menu.className = "actmenu"; menu.setAttribute("role", "menu");
    menu.innerHTML =
      '<button data-a="copy"><span class="mi">⧉</span>Copy</button>' +
      '<button data-a="quote"><span class="mi">❝</span>Quote reply</button>' +
      '<button data-a="select"><span class="mi">⌲</span>Select text</button>';
    document.body.appendChild(menu);
    let curMid = null, lpTimer = null, startX = 0, startY = 0, moved = false;
    function bubbleFrom(t) { return t && t.closest ? t.closest(".row .bubble") : null; }
    function openMenu(bubble, x, y) {
      const row = bubble.closest(".row"); curMid = row ? row.dataset.mid : null; if (!curMid) return;
      bubble.classList.add("flash"); setTimeout(function () { bubble.classList.remove("flash"); }, 600);
      menu.style.visibility = "hidden"; menu.classList.add("show");
      const mw = menu.offsetWidth || 180, mh = menu.offsetHeight || 150;
      const px = Math.max(8, Math.min(x - mw / 2, window.innerWidth - mw - 8));
      let py = y + 10; if (py + mh > window.innerHeight - 8) py = Math.max(8, y - mh - 10);
      menu.style.left = px + "px"; menu.style.top = py + "px"; menu.style.visibility = "";
      buzz(12);
    }
    function closeMenu() { menu.classList.remove("show"); curMid = null; }
    function onTouchStart(e) {
      const b = bubbleFrom(e.target); if (!b) return;
      moved = false; const t = e.touches[0]; startX = t.clientX; startY = t.clientY;
      lpTimer = setTimeout(function () { if (!moved) openMenu(b, startX, startY); }, 480);
    }
    function onTouchMove(e) {
      if (!lpTimer) return; const t = e.touches[0];
      if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) { moved = true; clearTimeout(lpTimer); lpTimer = null; }
    }
    function onTouchEnd() { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } }
    function onContext(e) { const b = bubbleFrom(e.target); if (!b) return; e.preventDefault(); openMenu(b, e.clientX, e.clientY); }
    function onDocClick(e) { if (menu.classList.contains("show") && !menu.contains(e.target)) closeMenu(); }
    function onMenuClick(e) {
      const btn = e.target.closest && e.target.closest("button"); if (!btn || !curMid) return;
      const m = byIdRef.current[curMid], a = btn.dataset.a, mid = curMid; closeMenu();
      if (!m) return;
      const text = m.type === "attach" ? (m.text || m.name || m.url || "") : (m.text || "");
      if (a === "copy") { copyText(text); toast("Copied"); }
      else if (a === "quote") {
        const q = text.split("\n").map(function (l) { return "> " + l; }).join("\n");
        inputRef.current.value = (inputRef.current.value ? inputRef.current.value + "\n" : "") + q + "\n\n";
        autoGrow(); setCanSend(inputRef.current.value.trim() !== ""); inputRef.current.focus();
      } else if (a === "select") {
        const bub = listEl.querySelector('.row[data-mid="' + cssEsc(mid) + '"] .bubble');
        if (bub) { try { const r = document.createRange(); r.selectNodeContents(bub); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (_e) {} }
      }
    }
    listEl.addEventListener("touchstart", onTouchStart, { passive: true });
    listEl.addEventListener("touchmove", onTouchMove, { passive: true });
    listEl.addEventListener("touchend", onTouchEnd, { passive: true });
    listEl.addEventListener("contextmenu", onContext);
    document.addEventListener("click", onDocClick, true);
    if (scrollEl) scrollEl.addEventListener("scroll", closeMenu, { passive: true });
    menu.addEventListener("click", onMenuClick);
    return function () {
      listEl.removeEventListener("touchstart", onTouchStart);
      listEl.removeEventListener("touchmove", onTouchMove);
      listEl.removeEventListener("touchend", onTouchEnd);
      listEl.removeEventListener("contextmenu", onContext);
      document.removeEventListener("click", onDocClick, true);
      if (scrollEl) scrollEl.removeEventListener("scroll", closeMenu);
      menu.remove();
    };
    // eslint-disable-next-line
  }, []);

  // visibility: keep pinned + check for updates on refocus
  useEffect(() => {
    function onVis() { if (!document.hidden) { if (atBottomRef.current) scrollToBottom(true); checkForUpdate(false); } }
    document.addEventListener("visibilitychange", onVis);
    return function () { document.removeEventListener("visibilitychange", onVis); };
    // eslint-disable-next-line
  }, []);

  // post-render: pin to bottom when we appended while at the bottom
  useLayoutEffect(() => { if (needScrollRef.current) { needScrollRef.current = false; scrollToBottom(); } });

  // ================= render =================
  // Build render blocks from the message model (day separators + grouped traces)
  const messages = messagesRef.current;
  const blocks = [];
  let lastDay = null;
  for (let i = 0; i < messages.length; ) {
    const m = messages[i];
    if (m.type === "activity") {
      const group = []; let j = i;
      while (j < messages.length && messages[j].type === "activity") { group.push(messages[j]); j++; }
      blocks.push(<Trace key={"trace-" + group[0].mid} items={group} live={j >= messages.length} />);
      i = j; continue;
    }
    if (m.type === "msg" || m.type === "attach") {
      const dk = dayKey(m.ts);
      if (dk !== lastDay) { lastDay = dk; blocks.push(<div className="daysep" key={"day-" + m.mid}>{fmtDay(m.ts)}</div>); }
    }
    if (m.type === "system") blocks.push(<div className="sys" key={m.mid} data-mid={m.mid}>{m.text}</div>);
    else if (m.type === "ask") blocks.push(<AskCard key={m.mid} m={m} onChoose={onAskChoose} />);
    else blocks.push(<MessageRow key={m.mid} m={m} />);
    i++;
  }

  const status = computeStatus();
  const hasTopic = !!topic;

  return (
    <>
      <header>
        <div className="avatar" ref={avatarRef}>◈</div>
        <div className="htitle">
          <b id="title">{name || "Agent"}</b>
          <span className="status"><span className={status.cls} id="dot" /><span id="statusText">{status.text}</span></span>
        </div>
        <button className="iconbtn" aria-label="Settings" onClick={() => setSheetOpen(true)}>⋯</button>
      </header>

      <div id="scroll" ref={scrollRef} onClick={onListClick}>
        <div id="list" ref={listRef}>
          {blocks}
          {typing ? <ThinkingPill startTs={thinkStart} label={thinkLabel} /> : null}
        </div>
        {messages.length === 0 ? (
          <div className="empty">
            <div className="big">◈</div>
            <h2>{hasTopic ? "Talk to your session" : "No session"}</h2>
            <p>{hasTopic
              ? "Messages you send here go straight to the Claude Code agent running this session. Replies stream back in real time."
              : "This link is missing its session token. Ask the agent to generate a fresh link."}</p>
          </div>
        ) : null}
      </div>

      <Liquid className={"fabgoo" + (showFab ? " show" : "")} fill="hsl(var(--surface))" blur={6} contrast={16}
        shadow="0 4px 12px rgba(0,0,0,.16)" onClick={() => scrollToBottom()} aria-label="Scroll to latest">
        <Liquid.Item effect="morph" style={{ width: 38, height: 38, borderRadius: 19, display: "grid", placeItems: "center" }}>
          <span className="fabarrow">↓</span>
          {unread > 0 ? <span className="badge">{unread > 99 ? "99+" : unread}</span> : null}
        </Liquid.Item>
      </Liquid>

      <div className="composer">
        <textarea id="input" ref={inputRef} rows={1} placeholder="Message the agent…" enterKeyHint="send"
          autoCapitalize="sentences" autoComplete="off" disabled={!hasTopic}
          onInput={() => { autoGrow(); setCanSend(inputRef.current.value.trim() !== ""); }}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } }}
          onFocus={() => setTimeout(() => scrollToBottom(true), 300)}
          onBlur={() => setTimeout(() => { if (atBottomRef.current) scrollToBottom(true); }, 100)} />
        <input type="file" id="fileInput" className="filein" disabled={!hasTopic}
          onChange={(e) => { const files = Array.prototype.slice.call(e.target.files || []); e.target.value = ""; files.forEach(function (f) { handleFile(f); }); }} />
        <Liquid className="goocluster" fill="hsl(var(--primary))" blur={8} contrast={20}
          shadow="0 2px 9px hsl(var(--primary-strong)/0.32)"
          style={{ display: "flex", gap: 5, alignItems: "center", flex: "0 0 auto" }}>
          <Liquid.Item effect="morph" style={{ width: 44, height: 44, borderRadius: 22 }}>
            <label className="glyphbtn gattach" htmlFor="fileInput" aria-label="Attach a photo or file">＋</label>
          </Liquid.Item>
          <Liquid.Item effect="morph" style={{ width: 44, height: 44, borderRadius: 22 }}>
            <button id="send" className={"glyphbtn gsend" + (canSend ? "" : " dim")} aria-label="Send"
              onClick={sendMessage} disabled={!hasTopic}>↑</button>
          </Liquid.Item>
        </Liquid>
      </div>

      <div className={"scrim" + (sheetOpen ? " show" : "")} onClick={() => setSheetOpen(false)} />
      <div className={"sheet" + (sheetOpen ? " show" : "")}>
        <div className="grip" />
        <h3>Session</h3>
        <div className="field"><span className="val">{location.href}</span></div>
        <div className="row-btns" style={{ marginBottom: 14 }}>
          <button className="btn primary" onClick={doShare}>Share link</button>
          <button className="btn" onClick={() => { copyText(location.href); toast("Link copied"); }}>Copy</button>
        </div>
        <div className="toggle" onClick={toggleActivity}>Show session activity<span className={"switch" + (showActivity ? " on" : "")} /></div>
        <div className="hint">The activity feed shows the agent's steps and tool calls from this session. Off hides them on this device only.</div>
        <div className="hint">On iPhone: tap the <b>Share</b> icon in Safari, then <b>Add to Home Screen</b> to install this chat as an app.</div>
        <div className="row-btns">
          <button className="btn danger" onClick={clearHistory}>Clear history</button>
        </div>
      </div>
      <div className={"toast" + (toastShow ? " show" : "")}>{toastMsg}</div>
    </>
  );
}

createRoot(document.getElementById("root")).render(<App />);
