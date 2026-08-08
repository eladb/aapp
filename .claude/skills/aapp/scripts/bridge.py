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
    return os.path.join(base, "session.json")


def load_state(path):
    try:
        with open(path, "r") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_state(path, state):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
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
        b = len(ch.encode("utf-8"))
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


def stream_messages(state, since, timeout, on_id=None):
    """Yield (ntfy_id, envelope) from the ntfy stream until timeout seconds
    pass with no traffic. ntfy sends keepalives (~45s) so an idle connection
    stays open; `timeout` bounds the wait for the *next byte*, and an overall
    deadline bounds total wall time."""
    url = "%s/%s/json?since=%s" % (state["server"].rstrip("/"), state["topic"], since)
    resp = http_open(url, timeout=timeout)
    try:
        for raw in resp:
            nid, env = parse_ntfy_line(
                raw.decode("utf-8", "replace") if isinstance(raw, bytes) else raw
            )
            if nid and on_id:
                on_id(nid)
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

    def remember(nid):
        state["last_id"] = nid

    while time.time() < deadline:
        remaining = max(1, int(deadline - time.time()))
        read_timeout = min(remaining, 55)  # < ntfy keepalive gap, bounded
        try:
            for nid, env in stream_messages(state, since, read_timeout, on_id=remember):
                since = nid or since
                if env.get("role") != "user":
                    continue
                mtype = env.get("type", "msg")
                if mtype not in ("msg", "system"):
                    # user-side typing/status: surface only if asked
                    if args.follow:
                        return {"type": mtype, "env": env}
                    continue
                mid = env.get("mid") or nid
                seq = int(env.get("seq", 0))
                seen = seen_seq.setdefault(mid, set())
                if seq in seen:
                    continue
                seen.add(seq)
                buffers.setdefault(mid, {})[seq] = env.get("text", "")
                if env.get("last"):
                    ordered = [buffers[mid][k] for k in sorted(buffers[mid])]
                    text = "".join(ordered)
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
# link
# --------------------------------------------------------------------------
def build_link(state, app_url=None, name=None):
    app_url = app_url or state.get("app_url")
    if not app_url:
        sys.exit(
            "no app url known -- pass --app-url <public app.html url> "
            "(it gets stored for later)"
        )
    frag = "s=%s&t=%s" % (state["server"].rstrip("/"), state["topic"])
    if name:
        frag += "&n=" + urllib.request.quote(name)
    sep = "" if "#" in app_url else "#"
    return app_url + sep + frag


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
    print(build_link(state, app_url=args.app_url, name=args.name))


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
    save_state(args.state, state)
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
    l.add_argument("--name", default=None, help="optional session display name")
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
    return p


def main():
    args = build_parser().parse_args()
    try:
        args.func(args)
    except urllib.error.HTTPError as e:
        sys.exit("HTTP error: %s %s" % (e.code, e.reason))
    except urllib.error.URLError as e:
        sys.exit("network error: %s" % e.reason)


if __name__ == "__main__":
    main()
