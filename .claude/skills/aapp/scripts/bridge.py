#!/usr/bin/env python3
"""
aapp bridge -- the agent side of the phone<->session chat.

Transport is ntfy.sh (or any ntfy-compatible server): a single per-session
"topic" acts as a shared realtime channel. The phone (app.html) and this
script publish JSON "envelopes" to the topic and stream new ones back.

Only stdlib is used, and only outbound HTTPS is required, so this runs in
locked-down sandboxes where raw TCP / tunnels are blocked.

Subcommands
-----------
  new         Create a session (random topic) and write a state file.
  link        Print the shareable phone URL for the current session.
  send        Publish a message from the agent (auto-chunked). Text via
              --text or stdin ("-").
  typing      Publish a typing indicator (on/off).
  status      Publish a transient status/system line (e.g. "running tests").
  wait        Block until the next *complete* user message arrives, print it
              as JSON, and exit. Reassembles multi-part messages. Advances
              the read cursor so messages are processed exactly once.
  history     Print all cached messages for the topic as JSON lines.

Envelope schema (v1), carried as the ntfy message body:
  {
    "v": 1,
    "cid":  "<sender instance id>",   # so a sender can ignore its own echoes
    "role": "user" | "agent",
    "type": "msg" | "typing" | "status" | "system",
    "mid":  "<logical message id>",   # groups multi-part messages
    "seq":  <int>,                    # 0-based part index
    "last": <bool>,                   # true on the final part
    "text": "<string>",
    "state":"on" | "off",             # for typing
    "ts":   <epoch ms>
  }
"""

import argparse
import json
import os
import ssl
import sys
import time
import urllib.request
import urllib.error
import uuid

DEFAULT_SERVER = "https://ntfy.sh"
# The app shell is a generic static file; the session lives in the URL fragment,
# so every session can reuse one public copy. This is the canonical hosted build
# (GitHub Pages) — used as the default so publishing needs no per-user hosting.
CANONICAL_APP_URL = os.environ.get("AAPP_APP_URL", "https://eladb.github.io/aapp/app.html")
# ntfy.sh rejects/attaches bodies >= 4096 bytes. Keep the whole JSON envelope
# comfortably under that.
MAX_ENVELOPE_BYTES = 3000
PROTOCOL_VERSION = 1


# --------------------------------------------------------------------------
# state
# --------------------------------------------------------------------------
def default_state_path():
    env = os.environ.get("AAPP_STATE")
    if env:
        return env
    base = os.environ.get("AAPP_HOME") or os.path.join(
        os.environ.get("TMPDIR", "/tmp"), "aapp"
    )
    # Scope the state file (and therefore the minted topic) to the current
    # session, so two Claude Code sessions on the same machine never reuse each
    # other's session.json and cross-talk on the same relay topic.
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID") or os.environ.get("CLAUDE_CODE_REMOTE_SESSION_ID")
    fname = ("session-%s.json" % sid) if sid else "session.json"
    return os.path.join(base, fname)


def load_state(path):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    # process-unique temp name so concurrent writers don't clobber each other's
    # partial writes before their own atomic rename
    tmp = "%s.tmp.%d" % (path, os.getpid())
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, path)


def require_state(args):
    state = load_state(args.state)
    if not state.get("topic"):
        sys.exit(
            "no session found at %s -- run `bridge.py new` first" % args.state
        )
    state.setdefault("server", DEFAULT_SERVER)
    state.setdefault("cid", "agent-" + uuid.uuid4().hex[:8])
    return state


# --------------------------------------------------------------------------
# http helpers (proxy + CA aware, stdlib only)
# --------------------------------------------------------------------------
def _ssl_context():
    ctx = ssl.create_default_context()
    # Trust an explicitly provided proxy CA bundle if present (common in
    # sandboxes that MITM outbound HTTPS). Harmless when absent.
    for var in ("SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE"):
        p = os.environ.get(var)
        if p and os.path.exists(p):
            try:
                ctx.load_verify_locations(p)
            except Exception:
                pass
    for p in ("/root/.ccr/ca-bundle.crt",):
        if os.path.exists(p):
            try:
                ctx.load_verify_locations(p)
            except Exception:
                pass
    return ctx


def _opener():
    # ProxyHandler() with no args reads HTTP(S)_PROXY from the environment.
    return urllib.request.build_opener(
        urllib.request.ProxyHandler(),
        urllib.request.HTTPSHandler(context=_ssl_context()),
    )


def http_post(url, data, headers=None, timeout=30):
    req = urllib.request.Request(url, data=data, headers=headers or {}, method="POST")
    return _opener().open(req, timeout=timeout)


def http_open(url, timeout=None):
    req = urllib.request.Request(url, method="GET")
    return _opener().open(req, timeout=timeout)


# --------------------------------------------------------------------------
# publish
# --------------------------------------------------------------------------
def now_ms():
    return int(time.time() * 1000)


def publish_envelope(server, topic, env):
    body = json.dumps(env, separators=(",", ":")).encode("utf-8")
    if len(body) > 4000:
        raise ValueError("envelope too large: %d bytes" % len(body))
    # Title header keeps ntfy's own UIs readable; content is the JSON body.
    http_post(
        "%s/%s" % (server.rstrip("/"), topic),
        data=body,
        headers={"Title": "aapp", "Content-Type": "application/json"},
    )


def chunk_text(text, overhead):
    """Split text so each JSON envelope stays under MAX_ENVELOPE_BYTES.

    Splitting is byte-aware (UTF-8) so multi-byte characters never blow the
    budget and are never cut mid-character.
    """
    budget = MAX_ENVELOPE_BYTES - overhead
    if budget < 200:
        budget = 200
    parts = []
    cur = []
    cur_bytes = 0
    for ch in text:
        # Measure the char as it will appear on the wire: the envelope is
        # serialized with json.dumps(ensure_ascii=True), so a non-ASCII char
        # becomes \uXXXX (6 bytes) or a surrogate pair (12), and quotes/newlines
        # double. len(json.dumps(ch)) - 2 strips the surrounding quotes.
        b = len(json.dumps(ch)) - 2
        if cur_bytes + b > budget and cur:
            parts.append("".join(cur))
            cur = []
            cur_bytes = 0
        cur.append(ch)
        cur_bytes += b
    parts.append("".join(cur))  # always emit at least one (possibly empty)
    return parts


def send_message(state, role, mtype, text):
    mid = uuid.uuid4().hex[:12]
    # Estimate fixed JSON overhead with an empty text field, then chunk.
    skeleton = {
        "v": PROTOCOL_VERSION,
        "cid": state["cid"],
        "role": role,
        "type": mtype,
        "mid": mid,
        "seq": 0,
        "last": True,
        "text": "",
        "ts": now_ms(),
    }
    overhead = len(json.dumps(skeleton, separators=(",", ":")).encode("utf-8")) + 8
    parts = chunk_text(text, overhead)
    total = len(parts)
    for i, part in enumerate(parts):
        env = dict(skeleton)
        env["seq"] = i
        env["last"] = i == total - 1
        env["text"] = part
        env["ts"] = now_ms()
        publish_envelope(state["server"], state["topic"], env)
    return mid, total


def send_signal(sess, mtype, **fields):
    env = {
        "v": PROTOCOL_VERSION,
        "cid": sess["cid"],
        "role": "agent",
        "type": mtype,
        "mid": uuid.uuid4().hex[:12],
        "seq": 0,
        "last": True,
        "ts": now_ms(),
    }
    env.update(fields)
    publish_envelope(sess["server"], sess["topic"], env)


# --------------------------------------------------------------------------
# receive
# --------------------------------------------------------------------------
def parse_ntfy_line(line):
    """Return (ntfy_id, envelope_or_None) for one ntfy /json stream line."""
    line = line.strip()
    if not line:
        return None, None
    try:
        outer = json.loads(line)
    except ValueError:
        return None, None
    nid = outer.get("id")
    if outer.get("event") != "message":
        return nid, None  # open / keepalive / poll_request
    raw = outer.get("message", "")
    try:
        env = json.loads(raw)
    except ValueError:
        return nid, None
    if not isinstance(env, dict):
        return nid, None
    return nid, env


def stream_messages(state, since, timeout, deadline=None):
    """Yield (ntfy_id, envelope) for real MESSAGE events on the ntfy stream.
    ntfy sends keepalive/open events (~45s) so an idle connection stays open;
    those are skipped and never yielded, so callers only ever advance their
    cursor to real message ids (keepalive ids are not valid `since=` cursors and
    would make ntfy replay the whole cache). `timeout` bounds the wait for the
    next byte; `deadline` (epoch seconds) is re-checked on every line so an
    overall wall-clock bound holds even when only keepalives arrive."""
    url = "%s/%s/json?since=%s" % (state["server"].rstrip("/"), state["topic"], since)
    resp = http_open(url, timeout=timeout)
    try:
        for raw in resp:
            if deadline is not None and time.time() >= deadline:
                return
            nid, env = parse_ntfy_line(
                raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            )
            if env is not None:
                yield nid, env
    finally:
        try:
            resp.close()
        except Exception:
            pass


def wait_for_user_message(state, args):
    """Block until one complete user message arrives; return dict or None."""
    deadline = time.time() + args.timeout
    since = state.get("last_id") or "all"
    if args.since:
        since = args.since
    # Buffers for reassembling multi-part user messages keyed by mid.
    buffers = {}
    seen_seq = {}
    expected_total = {}

    while time.time() < deadline:
        remaining = max(1, int(deadline - time.time()))
        read_timeout = min(remaining, 55)  # < ntfy keepalive gap, bounded
        try:
            for nid, env in stream_messages(state, since, read_timeout, deadline=deadline):
                # advance the cursor ONLY on real message ids (keepalive ids are
                # not valid `since=` cursors)
                if nid:
                    since = nid
                    state["last_id"] = nid
                if env.get("role") != "user":
                    continue
                mtype = env.get("type", "msg")
                if mtype not in ("msg", "system"):
                    # user-side typing/status: surface only if asked
                    if args.follow:
                        return {"type": mtype, "env": env}
                    continue
                mid = env.get("mid") or nid
                # Tolerate malformed/hostile envelopes: a bad seq skips the part
                # rather than crashing the whole wait loop.
                try:
                    seq = int(env.get("seq", 0))
                except (TypeError, ValueError):
                    continue
                seen = seen_seq.setdefault(mid, set())
                if seq in seen:
                    continue
                seen.add(seq)
                buffers.setdefault(mid, {})[seq] = env.get("text", "")
                if env.get("last"):
                    expected_total[mid] = seq + 1
                total = expected_total.get(mid)
                # Only complete once every part 0..total-1 is present, so an
                # out-of-order or partial multi-part message isn't concatenated
                # with gaps.
                if total is not None and all(i in buffers[mid] for i in range(total)):
                    text = "".join(buffers[mid][i] for i in range(total))
                    save_state(args.state, state)
                    return {
                        "type": "msg",
                        "mid": mid,
                        "text": text,
                        "ts": env.get("ts"),
                        "cid": env.get("cid"),
                    }
        except (urllib.error.URLError, ssl.SSLError, TimeoutError, OSError):
            # keepalive gap / transient network hiccup -> reconnect from cursor
            time.sleep(1)
            continue
        save_state(args.state, state)
    save_state(args.state, state)
    return None


def history(state):
    url = "%s/%s/json?poll=1&since=all" % (state["server"].rstrip("/"), state["topic"])
    out = []
    try:
        resp = http_open(url, timeout=30)
        for raw in resp:
            _nid, env = parse_ntfy_line(
                raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            )
            if env is not None:
                out.append(env)
    except urllib.error.URLError as e:
        sys.exit("history failed: %s" % e)
    return out


# --------------------------------------------------------------------------
# activity feed -- follow the session transcript, publish SUMMARIES ONLY
# (assistant messages, compact tool-call lines, real user turns). Raw tool
# outputs and file bodies are deliberately excluded to limit what a public
# link exposes.
# --------------------------------------------------------------------------
ACT_MAX_TEXT = 600  # truncate any activity line to keep envelopes small & terse


def _first_line(s, n):
    s = (s or "").strip().splitlines()
    s = s[0] if s else ""
    return s[:n]


def _basename(p):
    return (p or "").rstrip("/").split("/")[-1] or (p or "")


def tool_summary(name, inp):
    """A short, safe one-liner for a tool call. Never includes file contents,
    edit bodies, or full command output."""
    if not isinstance(inp, dict):
        inp = {}
    if name == "Bash":
        cmd = inp.get("command", "")
        low = cmd.lower()
        # don't echo the chat plumbing back into the feed
        if "bridge.py" in low or "aapp-live" in low or "aapp/session" in low:
            return None
        return "🔧 Bash: " + _first_line(cmd, 140)
    if name in ("Edit", "Write", "NotebookEdit"):
        return "🔧 %s: %s" % (name, _basename(inp.get("file_path") or inp.get("notebook_path")))
    if name == "Read":
        p = inp.get("file_path") or ""
        # don't echo the chat plumbing: reading the phone-message / task files
        if (p.endswith(".output") or p.endswith(".msg") or "/tasks/" in p
                or "session.json" in p or "aapp-live" in p):
            return None
        return "📄 Read: " + _basename(p)
    if name in ("Grep", "Glob"):
        return "🔎 %s: %s" % (name, _first_line(inp.get("pattern") or inp.get("glob") or "", 80))
    if name in ("Task", "Agent"):
        return "🤖 %s: %s" % (name, _first_line(inp.get("description") or "", 80))
    if name == "Workflow":
        return "🧩 Workflow: " + _first_line(inp.get("description") or "", 80)
    if name in ("TaskCreate", "TaskUpdate"):
        return None  # internal bookkeeping -- too noisy for the feed
    return "🔧 " + str(name)


_PLUMBING_MARKERS = (
    "<task-notification>", "[SYSTEM NOTIFICATION", "<system-reminder>",
    "automated background-task event", "<github-webhook-activity>",
    "<command-name>", "<local-command-stdout>",
)


def _is_plumbing_text(t):
    """Harness-injected text (task notifications, system reminders, the chat
    app's own round-trip events) -- not real conversation, don't echo it."""
    return bool(t) and any(m in t for m in _PLUMBING_MARKERS)


def summarize_event(o):
    """Yield (kind, text) activity items for one transcript line."""
    if not isinstance(o, dict):
        return
    if o.get("type") not in ("assistant", "user"):
        return
    msg = o.get("message") if isinstance(o.get("message"), dict) else None
    if not msg:
        return
    role = msg.get("role")
    content = msg.get("content")
    if isinstance(content, str):
        if role == "user" and content.strip() and not _is_plumbing_text(content):
            yield ("user", content.strip()[:ACT_MAX_TEXT])
        return
    if not isinstance(content, list):
        return
    # a user turn that carries any tool_result is a tool response -> skip whole
    if role == "user" and any(isinstance(c, dict) and c.get("type") == "tool_result" for c in content):
        return
    for c in content:
        if not isinstance(c, dict):
            continue
        ct = c.get("type")
        if ct == "text" and c.get("text", "").strip():
            if _is_plumbing_text(c["text"]):
                continue
            yield (role, c["text"].strip()[:ACT_MAX_TEXT])
        elif ct == "tool_use" and role == "assistant":
            line = tool_summary(c.get("name"), c.get("input"))
            if line:
                yield ("tool", line[:ACT_MAX_TEXT])
        # thinking / tool_result intentionally omitted


def publish_title(sess, cid, title):
    env = {
        "v": PROTOCOL_VERSION, "cid": cid, "role": "agent", "type": "title",
        "mid": "title-" + uuid.uuid4().hex[:8], "seq": 0, "last": True,
        "text": title[:120], "ts": now_ms(),
    }
    publish_envelope(sess["server"], sess["topic"], env)


def publish_activity(sess, cid, kind, text):
    env = {
        "v": PROTOCOL_VERSION,
        "cid": cid,
        "role": "agent",
        "type": "activity",
        "kind": kind,
        "mid": "act-" + uuid.uuid4().hex[:12],
        "seq": 0,
        "last": True,
        "text": text,
        "ts": now_ms(),
    }
    # keep the whole envelope well under the relay limit
    while len(json.dumps(env, separators=(",", ":")).encode("utf-8")) > 3500 and env["text"]:
        env["text"] = env["text"][: max(1, len(env["text"]) // 2)]
    publish_envelope(sess["server"], sess["topic"], env)


def tail_transcript(state, args):
    path = args.transcript
    cid = "tail-" + uuid.uuid4().hex[:8]
    # Where to start: end (only new activity) or start (replay everything).
    try:
        size = os.path.getsize(path)
    except OSError:
        size = 0
    if args.from_ == "start":
        pos = 0
    else:
        pos = size
    if args.backfill and pos > 0:
        # rewind roughly N lines by scanning back from the end
        try:
            with open(path, "rb") as f:
                f.seek(0)
                data = f.read(pos)
            nl = data.rfind(b"\n")
            count = 0
            i = len(data)
            while count <= args.backfill and i > 0:
                i = data.rfind(b"\n", 0, i)
                if i < 0:
                    i = 0
                    break
                count += 1
            pos = i
        except OSError:
            pass
    buf = ""
    published = 0
    # keep the app's title in sync with the session title, live
    cur_title = read_session_title(path)
    if cur_title:
        try:
            publish_title(state, cid, cur_title)
        except Exception:
            pass
    deadline = time.time() + args.timeout if args.timeout else None
    while True:
        if deadline and time.time() > deadline:
            break
        try:
            cur = os.path.getsize(path)
        except OSError:
            time.sleep(args.interval)
            continue
        if cur < pos:  # file truncated/rotated -> restart
            pos = 0
            buf = ""
        if cur > pos:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                f.seek(pos)
                chunk = f.read()
                pos = f.tell()
            buf += chunk
            while "\n" in buf:
                line, buf = buf.split("\n", 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    o = json.loads(line)
                except ValueError:
                    continue
                if o.get("type") == "custom-title":
                    t = o.get("customTitle") or o.get("title")
                    if isinstance(t, str) and t.strip() and t.strip() != cur_title:
                        cur_title = t.strip()
                        try:
                            publish_title(state, cid, cur_title)
                        except Exception:
                            pass
                    continue
                for kind, text in summarize_event(o):
                    if not text:
                        continue
                    try:
                        publish_activity(state, cid, kind, text)
                        published += 1
                        time.sleep(args.throttle)  # be nice to the relay
                    except Exception:
                        pass
        if args.once:
            break
        time.sleep(args.interval)
    return published


# --------------------------------------------------------------------------
# link
# --------------------------------------------------------------------------
def find_session_transcript():
    """Best-effort locate the current Claude Code session's .jsonl transcript."""
    import glob
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID")
    roots = [
        os.path.join(os.path.expanduser("~"), ".claude", "projects"),
        "/root/.claude/projects",
    ]
    cands = []
    for root in roots:
        if sid:
            cands += glob.glob(os.path.join(root, "*", sid + ".jsonl"))
        cands += glob.glob(os.path.join(root, "*", "*.jsonl"))
    if sid:
        exact = [c for c in cands if os.path.basename(c) == sid + ".jsonl"]
        if exact:
            return exact[0]
    if not cands:
        return None
    return max(cands, key=lambda p: os.path.getmtime(p))


def read_session_title(path):
    """Return the session's latest custom title from its transcript, or None."""
    title = None
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for ln in f:
                ln = ln.strip()
                if '"custom-title"' not in ln:
                    continue
                try:
                    o = json.loads(ln)
                except ValueError:
                    continue
                t = o.get("customTitle") or o.get("title")
                if isinstance(t, str) and t.strip():
                    title = t.strip()
    except OSError:
        return None
    return title
def build_link(state, app_url=None, name=None):
    # Fall back to the canonical hosted app so a link can be built with zero
    # hosting setup.
    app_url = app_url or state.get("app_url") or CANONICAL_APP_URL
    frag = "s=%s&t=%s" % (state["server"].rstrip("/"), state["topic"])
    if name:
        frag += "&n=" + urllib.request.quote(name)
    # drop any pre-existing fragment so we always emit exactly one clean one
    base = app_url.split("#", 1)[0]
    return base + "#" + frag


# --------------------------------------------------------------------------
# cli
# --------------------------------------------------------------------------
def cmd_new(args):
    state = load_state(args.state)
    if state.get("topic") and not args.force:
        # idempotent: reuse existing session unless --force
        print(json.dumps({"reused": True, **state}))
        return
    topic = "aapp-" + uuid.uuid4().hex + uuid.uuid4().hex[:8]  # ~40 hex chars
    state = {
        "topic": topic,
        "server": args.server,
        "cid": "agent-" + uuid.uuid4().hex[:8],
        "created": now_ms(),
        "last_id": "all",
    }
    if args.app_url:
        state["app_url"] = args.app_url
    save_state(args.state, state)
    print(json.dumps({"reused": False, **state}))


def cmd_link(args):
    state = require_state(args)
    if args.app_url:
        state["app_url"] = args.app_url
        save_state(args.state, state)
    name = args.name
    tpath = args.name_from_transcript
    if args.name_from_session and not tpath:
        tpath = find_session_transcript()
    if tpath:
        name = read_session_title(tpath) or name
    print(build_link(state, app_url=args.app_url, name=name))


def cmd_send(args):
    state = require_state(args)
    text = args.text
    if text == "-" or text is None:
        text = sys.stdin.read()
    mid, total = send_message(state, "agent", args.type, text)
    if args.typing_off:
        try:
            send_signal(state, "typing", state="off")
        except Exception:
            pass
    # note: cmd_send intentionally does NOT save_state -- it does not own the
    # read cursor (last_id), and writing here would race a concurrent `wait`.
    print(json.dumps({"mid": mid, "parts": total}))


def cmd_typing(args):
    state = require_state(args)
    send_signal(state, "typing", state=args.state_value)
    print(json.dumps({"typing": args.state_value}))


def cmd_status(args):
    state = require_state(args)
    text = args.text
    if text == "-" or text is None:
        text = sys.stdin.read()
    send_signal(state, "status", text=text)
    print(json.dumps({"status": text[:80]}))


def cmd_title(args):
    state = require_state(args)
    text = args.text
    if text == "-" or text is None:
        text = sys.stdin.read()
    text = text.strip()
    if not text:
        sys.exit("provide --text")
    send_signal(state, "title", text=text)
    print(json.dumps({"title": text[:80]}))


def cmd_icon(args):
    state = require_state(args)
    fields = {}
    if args.emoji:
        fields["emoji"] = args.emoji
    if args.url:
        fields["url"] = args.url
    if not fields:
        sys.exit("provide --emoji or --url")
    send_signal(state, "icon", **fields)
    print(json.dumps({"icon": fields}))


def cmd_wait(args):
    state = require_state(args)
    msg = wait_for_user_message(state, args)
    if msg is None:
        # nothing arrived within the window
        if args.out:
            try:
                os.remove(args.out)
            except OSError:
                pass
        sys.exit(22)  # distinct code: timed out with no message
    line = json.dumps(msg)
    if args.out:
        with open(args.out, "w") as f:
            f.write(line)
    print(line)


def cmd_history(args):
    state = require_state(args)
    for env in history(state):
        print(json.dumps(env))


def cmd_tail(args):
    state = require_state(args)
    if not args.transcript:
        args.transcript = find_session_transcript()
    if not args.transcript or not os.path.exists(args.transcript):
        sys.exit("transcript not found: %s" % args.transcript)
    n = tail_transcript(state, args)
    print(json.dumps({"published": n}))


def build_parser():
    p = argparse.ArgumentParser(description="aapp agent<->phone chat bridge")
    p.add_argument("--state", default=default_state_path(),
                   help="session state file (default: $AAPP_STATE or scratch)")
    sub = p.add_subparsers(dest="cmd", required=True)

    n = sub.add_parser("new", help="create a session")
    n.add_argument("--server", default=DEFAULT_SERVER)
    n.add_argument("--app-url", default=None, help="public URL of app.html")
    n.add_argument("--force", action="store_true", help="overwrite existing session")
    n.set_defaults(func=cmd_new)

    l = sub.add_parser("link", help="print the shareable phone link")
    l.add_argument("--app-url", default=None)
    l.add_argument("--name", default=None, help="optional app display name")
    l.add_argument("--name-from-transcript", default=None,
                   help="derive the app name from a session transcript's title")
    l.add_argument("--name-from-session", action="store_true",
                   help="auto-detect this session's transcript and use its title")
    l.set_defaults(func=cmd_link)

    s = sub.add_parser("send", help="send an agent message (chunked)")
    s.add_argument("--text", default=None, help="message text, or '-' for stdin")
    s.add_argument("--type", default="msg", choices=["msg", "system"])
    s.add_argument("--typing-off", action="store_true",
                   help="also clear the typing indicator afterward")
    s.set_defaults(func=cmd_send)

    t = sub.add_parser("typing", help="send a typing indicator")
    t.add_argument("state_value", choices=["on", "off"])
    t.set_defaults(func=cmd_typing)

    st = sub.add_parser("status", help="send a transient status line")
    st.add_argument("--text", default=None)
    st.set_defaults(func=cmd_status)

    tt = sub.add_parser("title", help="set the app title/name shown in the header")
    tt.add_argument("--text", default=None, help="the display name, or '-' for stdin")
    tt.set_defaults(func=cmd_title)

    ic = sub.add_parser("icon", help="set the app icon/favicon (emoji or image url)")
    ic.add_argument("--emoji", default=None, help="an emoji to use as the icon")
    ic.add_argument("--url", default=None, help="an image URL or data: URI")
    ic.set_defaults(func=cmd_icon)

    w = sub.add_parser("wait", help="block for the next complete user message")
    w.add_argument("--timeout", type=int, default=50,
                   help="max seconds to block (default 50)")
    w.add_argument("--since", default=None,
                   help="override read cursor (ntfy id or 'all')")
    w.add_argument("--out", default=None,
                   help="also write the message JSON to this file")
    w.add_argument("--follow", action="store_true",
                   help="also return user typing/status signals")
    w.set_defaults(func=cmd_wait)

    h = sub.add_parser("history", help="dump cached messages as JSON lines")
    h.set_defaults(func=cmd_history)

    ta = sub.add_parser("tail", help="stream a session transcript as an activity feed (summaries only)")
    ta.add_argument("--transcript", default=None,
                    help="session .jsonl transcript to follow (auto-detected if omitted)")
    ta.add_argument("--from", dest="from_", default="end", choices=["end", "start"],
                    help="start at end (only new activity, default) or start (replay)")
    ta.add_argument("--backfill", type=int, default=0,
                    help="when starting at end, first replay the last N transcript lines")
    ta.add_argument("--interval", type=float, default=1.0, help="poll interval seconds")
    ta.add_argument("--throttle", type=float, default=0.25, help="seconds between publishes")
    ta.add_argument("--timeout", type=int, default=0, help="stop after N seconds (0 = run until killed)")
    ta.add_argument("--once", action="store_true", help="process current backlog then exit")
    ta.set_defaults(func=cmd_tail)
    return p


def main():
    args = build_parser().parse_args()
    try:
        args.func(args)
    except urllib.error.HTTPError as e:
        sys.exit("HTTP error: %s %s" % (e.code, e.reason))
    except urllib.error.URLError as e:
        sys.exit("network error: %s" % e.reason)
    except ValueError as e:
        sys.exit("message error: %s" % e)


if __name__ == "__main__":
    main()
