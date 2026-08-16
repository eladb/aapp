import { useState, useEffect, useRef, useReducer, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
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
// A tool-call chip — Beautiful UI 05: compact inset mono chip with a leading glyph.
function ToolChip({ m }) {
  const txt = (m.text || "").trim();
  return (
    <span className="toolchip" title={txt}>
      <span className="tg" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
      </span>
      <span className="tt">{txt || "tool"}</span>
    </span>
  );
}
// An assistant reasoning step — Beautiful UI 02/07 crisp reasoning text.
function ReasonRow({ m }) {
  return (
    <div className="act assistant">
      <div className="ax" dangerouslySetInnerHTML={{ __html: renderMarkdown(m.text || "") }} />
    </div>
  );
}
// Consecutive activity collapses into one "Thinking · N steps" trace that stays
// expanded while live and auto-collapses when the reply lands. Runs of tool
// calls flow together as chips (05); assistant notes render as reasoning rows.
function Trace({ items, live }) {
  const [open, setOpen] = useState(live);
  const prev = useRef(live);
  useEffect(() => { if (prev.current !== live) { prev.current = live; setOpen(live); } }, [live]);
  const n = items.length;
  const rows = [];
  for (let i = 0; i < items.length; ) {
    const it = items[i];
    if ((it.kind || "tool") === "tool") {
      const chips = []; let j = i;
      while (j < items.length && (items[j].kind || "tool") === "tool") { chips.push(items[j]); j++; }
      rows.push(<div className="toolrow" key={"tr-" + chips[0].mid}>{chips.map((c) => <ToolChip key={c.mid} m={c} />)}</div>);
      i = j;
    } else { rows.push(<ReasonRow key={it.mid} m={it} />); i++; }
  }
  return (
    <div className={"trace" + (open ? " open" : "")}>
      <div className="trace-h" onClick={() => setOpen((o) => !o)}>
        <span className="spark">✦</span>
        <span className="tlbl">{live ? "Thinking" : "Worked"}</span>
        <span className="tn">{n + (n === 1 ? " step" : " steps")}</span>
        <span className="chev">⌄</span>
      </div>
      <div className="trace-b">{rows}</div>
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
function AskCard({ m, onChoose, onCustom, onDismiss }) {
  if (m.dismissed) return null;
  return (
    <div className="askwrap" data-mid={m.mid}>
      <div className={"askcard" + (m.answered ? " answered" : "")}>
        <div className="askhead">
          <span className="qq">{m.text || ""}</span>
          {!m.answered ? (
            <button type="button" className="askx" aria-label="Dismiss" onClick={() => onDismiss(m)}>×</button>
          ) : null}
        </div>
        <div className="askopts">
          {(m.options || []).map((o, i) => (
            <button key={i} type="button"
              className={"askopt" + (m.answered && m.chosen === o.value ? " chosen" : "")}
              onClick={() => { if (!m.answered) onChoose(m, o.value); }}>
              <span className="ring"><span className="dot" /></span><span className="ol">{o.label}</span>
            </button>
          ))}
          {m.freeText !== false ? (
            <button type="button" className="askopt askcustom" onClick={() => { if (!m.answered) onCustom(); }}>
              <span className="ring" /><span className="ol">Type something…</span>
            </button>
          ) : null}
        </div>
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
  function onAskDismiss(m) {
    if (m.answered) return;
    m.dismissed = true; forceRender(); save();
  }
  function focusComposer() {
    const el = inputRef.current; if (!el) return;
    try { el.focus(); scrollToBottom(true); } catch (e) {}
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
      const wrap = btn.closest(".codewrap");
      const code = wrap ? wrap.querySelector("code") : null;
      copyText(code ? code.textContent : "");
      btn.classList.add("copied");
      const lbl = btn.querySelector(".copylbl") || btn;
      lbl.textContent = "Copied!";
      setTimeout(function () { btn.classList.remove("copied"); lbl.textContent = "Copy"; }, 1200);
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

  // Selection actions (Beautiful UI 19): highlight text inside a bubble to get a
  // floating pill toolbar — Explain / Improve / Shorten hand the passage to the
  // agent; Copy keeps a plain copy path. Replaces the old long-press menu.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    const ICON = {
      explain: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 9C9 5.49997 14.5 5.5 14.5 9C14.5 11.5 12 10.9999 12 13.9999"/><path d="M12 18.01L12.01 17.9989"/><path d="M12 22C17.5228 22 22 17.5228 22 12C22 6.47715 17.5228 2 12 2C6.47715 2 2 6.47715 2 12C2 13.8214 2.48697 15.5291 3.33782 17L2.5 21.5L7 20.6622C8.47087 21.513 10.1786 22 12 22Z"/></svg>',
      improve: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true"><path d="M3 12C9.26752 12 12 9.36306 12 3C12 9.36306 14.7134 12 21 12C14.7134 12 12 14.7134 12 21C12 14.7134 9.26752 12 3 12Z"/></svg>',
      shorten: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7.23611 7C7.71115 6.46924 8 5.76835 8 5C8 3.34315 6.65685 2 5 2C3.34315 2 2 3.34315 2 5C2 6.65685 3.34315 8 5 8C5.8885 8 6.68679 7.61375 7.23611 7ZM7.23611 7L20 18"/><path d="M7.23611 17C7.71115 17.5308 8 18.2316 8 19C8 20.6569 6.65685 22 5 22C3.34315 22 2 20.6569 2 19C2 17.3431 3.34315 16 5 16C5.8885 16 6.68679 16.3863 7.23611 17ZM7.23611 17L20 6"/></svg>',
      copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2.5"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    };
    const bar = document.createElement("div");
    bar.className = "seltools"; bar.setAttribute("role", "toolbar"); bar.setAttribute("aria-label", "Selection actions");
    bar.innerHTML =
      '<button type="button" data-a="explain">' + ICON.explain + "Explain</button>" +
      '<button type="button" data-a="improve">' + ICON.improve + "Improve</button>" +
      '<button type="button" data-a="shorten">' + ICON.shorten + "Shorten</button>" +
      '<span class="sdiv"></span>' +
      '<button type="button" class="ico" data-a="copy" aria-label="Copy">' + ICON.copy + "</button>";
    document.body.appendChild(bar);

    let selText = "", t = null;
    function bubbleOf(node) { const el = node && node.nodeType === 3 ? node.parentElement : node; return el && el.closest ? el.closest(".row .bubble") : null; }
    function currentSel() {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
      const txt = sel.toString().replace(/ /g, " ").trim();
      if (!txt) return null;
      const b = bubbleOf(sel.anchorNode);
      if (!b || bubbleOf(sel.focusNode) !== b) return null;
      return { txt: txt, sel: sel };
    }
    function place(sel) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) { hide(); return; }
      bar.style.visibility = "hidden"; bar.classList.add("show");
      const bw = bar.offsetWidth || 220, bh = bar.offsetHeight || 36;
      const cx = rect.left + rect.width / 2;
      const left = Math.max(8, Math.min(cx - bw / 2, window.innerWidth - bw - 8));
      let top = rect.top - bh - 8;
      if (top < 8) top = Math.min(window.innerHeight - bh - 8, rect.bottom + 8);
      bar.style.left = left + "px"; bar.style.top = top + "px"; bar.style.visibility = "";
    }
    function hide() { bar.classList.remove("show"); selText = ""; }
    function schedule() {
      clearTimeout(t);
      t = setTimeout(function () { const c = currentSel(); if (!c) { hide(); return; } selText = c.txt; place(c.sel); }, 30);
    }
    function quoted(s) { return s.split("\n").map(function (l) { return "> " + l; }).join("\n"); }
    function onClick(e) {
      const btn = e.target.closest && e.target.closest("button"); if (!btn) return;
      const a = btn.dataset.a, text = selText; if (!text) return;
      buzz(10);
      if (a === "copy") { copyText(text); toast("Copied"); }
      else { const verb = a === "explain" ? "Explain" : a === "improve" ? "Improve" : "Shorten"; submitText(verb + " this:\n\n" + quoted(text)); }
      try { const s = window.getSelection(); if (s && s.removeAllRanges) s.removeAllRanges(); } catch (_e) {}
      hide();
    }
    function onDown(e) { if (bar.contains(e.target)) return; hide(); }
    function onKey(e) { if (e.key === "Escape") hide(); }

    bar.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep the selection alive when tapping the bar
    bar.addEventListener("click", onClick);
    document.addEventListener("selectionchange", schedule);
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    if (scrollEl) scrollEl.addEventListener("scroll", hide, { passive: true });
    window.addEventListener("resize", hide);
    return function () {
      document.removeEventListener("selectionchange", schedule);
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
      if (scrollEl) scrollEl.removeEventListener("scroll", hide);
      window.removeEventListener("resize", hide);
      clearTimeout(t); bar.remove();
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
    else if (m.type === "ask") blocks.push(<AskCard key={m.mid} m={m} onChoose={onAskChoose} onCustom={focusComposer} onDismiss={onAskDismiss} />);
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

      <button className={"fab" + (showFab ? " show" : "")} onClick={() => scrollToBottom()} aria-label="Scroll to latest">
        <span className="fabarrow" aria-hidden="true">↓</span>
        {unread > 0 ? <span className="badge">{unread > 99 ? "99+" : unread}</span> : null}
      </button>

      <div className="composer">
        <div className="composerbar">
          <label className="attachbtn" htmlFor="fileInput" aria-label="Add attachments and sources">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>
          </label>
          <input type="file" id="fileInput" className="filein" disabled={!hasTopic}
            onChange={(e) => { const files = Array.prototype.slice.call(e.target.files || []); e.target.value = ""; files.forEach(function (f) { handleFile(f); }); }} />
          <textarea id="input" ref={inputRef} rows={1} placeholder="Write a message…" enterKeyHint="send"
            autoCapitalize="sentences" autoComplete="off" disabled={!hasTopic}
            onInput={() => { autoGrow(); setCanSend(inputRef.current.value.trim() !== ""); }}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); } }}
            onFocus={() => setTimeout(() => scrollToBottom(true), 300)}
            onBlur={() => setTimeout(() => { if (atBottomRef.current) scrollToBottom(true); }, 100)} />
          <button id="send" className={"sendbtn" + (canSend ? " ready" : "")} aria-label="Send"
            onClick={sendMessage} disabled={!hasTopic}>
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"/></svg>
          </button>
        </div>
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
        <div className="segrow">Session activity
          <span className="seg" role="tablist">
            <button type="button" role="tab" className={showActivity ? "on" : ""} onClick={() => { if (!showActivity) toggleActivity(); }}>Shown</button>
            <button type="button" role="tab" className={!showActivity ? "on" : ""} onClick={() => { if (showActivity) toggleActivity(); }}>Hidden</button>
          </span>
        </div>
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
