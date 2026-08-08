---
name: aapp
description: >-
  Create a public, mobile-first shareable link that hosts a chat web app —
  installable to the iPhone Home Screen — for talking to THIS Claude Code
  session in real time from a phone. Use when the user wants to "chat with
  this session from my phone", get a "shareable link to this agent", a
  "mobile app / PWA for this session", control the agent remotely, or hand
  someone a URL to message the running agent. Works in locked-down sandboxes
  (HTTPS-only egress) via the ntfy.sh relay; no server or account required.
---

# aapp — a phone-ready chat app for this session

This skill turns the current Claude Code session into something you can talk
to from a phone. It gives you one **public URL**. Open it on a phone, tap
**Add to Home Screen**, and you have an app whose messages land in this
session; the agent's replies stream back into the app.

## How it works (30-second model)

```
  phone (app.html)  ──POST envelope──▶   ntfy.sh/<topic>   ◀──stream──  agent (bridge.py)
        ▲                                (public relay)                      │
        └──────────────── stream replies ◀───────────────── POST replies ───┘
```

- **Transport:** a per-session random **topic** on `ntfy.sh` (a free public
  pub/sub relay). Both sides only need outbound **HTTPS**, so this works even
  in sandboxes where tunnels / raw TCP are blocked.
- **The topic is the secret.** It lives in the link's URL **fragment**
  (`#t=…`), which browsers never send to the page's host or CDN — only to
  ntfy. Anyone with the full link can chat with the session, so treat it like
  a password and don't paste secrets into the conversation.
- **Two files do the work:** `scripts/bridge.py` (agent side, stdlib only) and
  `app.html` (the phone app, one self-contained file).

## Steps to run

### 1. Create the session

```bash
export AAPP_STATE="${TMPDIR:-/tmp}/aapp/session.json"   # any writable path
python3 .claude/skills/aapp/scripts/bridge.py new
```

(If you skip the `export`, `bridge.py` falls back to `$TMPDIR/aapp/session.json`
on its own — just keep the same `AAPP_STATE` for every command in the session.)

This mints a random topic and stores it. (Re-running reuses the same session;
pass `--force` to rotate.) Default relay is `https://ntfy.sh`; override with
`--server https://your-ntfy` if you self-host ntfy.

### 2. Publish `app.html` at a public HTTPS URL

The phone app is a single static file. Pick whichever hosting fits — the same
`app.html` works from any host because the session travels in the URL fragment.

- **Public GitHub repo → githack (no build, recommended in cloud sessions).**
  Commit `app.html`, push, then use the commit SHA:
  `https://rawcdn.githack.com/<owner>/<repo>/<sha>/<path>/app.html`
  Get the SHA with `git rev-parse HEAD`. Use a **commit SHA** (not a branch) so
  slashes in branch names don't break the path and the CDN can't serve a stale
  copy. (Don't use jsDelivr for this — it serves `.html` as `text/plain`, so the
  browser shows source instead of rendering the app.) See `reference/hosting.md`.
- **GitHub Pages / Netlify / any static host.** Drop `app.html` there.
- **Local machine with open egress:** serve it yourself and expose with a
  tunnel — `python3 scripts/serve.py` serves the file and prints a ready-to-run
  `cloudflared tunnel` command you then run in another shell. See
  `reference/hosting.md`.

Store the resulting URL so the link builder can use it:

```bash
python3 .claude/skills/aapp/scripts/bridge.py link --app-url "<public app.html url>" --name "My Session"
```

That prints the full shareable link, e.g.
`https://…/app.html#s=https://ntfy.sh&t=aapp-<random>&n=My%20Session`.

### 3. Hand the link to the user

Give them the URL and this one-liner:

> Open on your iPhone in Safari → **Share** → **Add to Home Screen** to install
> it as an app. Messages you send go straight to this session.

Then post a greeting so the app isn't empty:

```bash
python3 .claude/skills/aapp/scripts/bridge.py send --text "👋 Connected. Message me anything and I'll work on it in this session."
```

### 4. Run the chat loop

Now act as the far end of the chat. The loop is **event-driven** — block for a
message, do the work, reply, repeat — so it doesn't burn turns while idle:

1. **Wait for a message** in the background so the turn ends until one arrives:
   ```bash
   python3 .claude/skills/aapp/scripts/bridge.py wait --timeout 600 --out "$AAPP_STATE.msg"
   ```
   Run this with your background-execution tool. It exits when a user message
   arrives (writing it to the `--out` file) or after the timeout (exit 22).
2. **When it returns**, read the message and treat its `text` as a normal user
   request. Optionally show progress:
   ```bash
   python3 .claude/skills/aapp/scripts/bridge.py typing on
   # …do the work in this session (edit files, run commands, answer)…
   python3 .claude/skills/aapp/scripts/bridge.py status --text "running tests…"
   ```
3. **Reply**, clearing the typing indicator:
   ```bash
   python3 .claude/skills/aapp/scripts/bridge.py send --text "Done — here's what I changed …" --typing-off
   # long text and code are auto-chunked to fit the relay; multi-part is fine
   ```
4. **Re-launch the wait** and continue. On a timeout with no message (exit 22),
   just start another wait. Keep going until the user says to stop, then send a
   final message and end the loop.

### Optional: stream the whole session as an activity feed

If the user wants the chat to show **everything happening in the session** (the
model's messages, each tool call, and terminal-side user turns) — not just your
explicit replies — run the transcript tailer in the background:

```bash
python3 .claude/skills/aapp/scripts/bridge.py tail \
  --transcript "<path to this session's .jsonl>" --from end
```

It publishes **summaries only** — assistant messages, compact tool-call lines
(`🔧 Edit app.html`, `🔧 Bash: …`), and real user turns. It deliberately
**omits** raw tool outputs, file contents, and chain-of-thought, and skips the
bridge's own plumbing. The app renders these as a distinct muted **activity**
feed with a per-device on/off toggle (Settings → *Show session activity*).

> ⚠️ **Confirm first.** This exposes the session's commands and steps to
> everyone holding the link. Get the user's explicit OK before enabling it, and
> keep it to the summaries-only default rather than dumping full outputs.

The transcript path is the session JSONL (in Claude Code, typically under
`~/.claude/projects/<project>/<session-id>.jsonl`).

### Etiquette for a good mobile chat

- Keep replies **short and skimmable**; the app renders Markdown (bold, lists,
  links, fenced code blocks with a copy button).
- Use `typing on` before long work and `status --text` for progress; both feel
  responsive on a phone.
- Treat each inbound message as an instruction to act on **in this session** —
  edit code, run commands, answer questions — then report back.
- Reconnects are automatic and the relay caches ~12h, so a phone that sleeps
  and wakes still catches up. Persisted history lives in the phone's
  localStorage.

## Notes & limits

- **Privacy:** anyone holding the link can talk to the session. To end access,
  rotate the topic (`bridge.py new --force`) and stop the loop; the old link
  goes dead.
- **Ephemerality:** cloud sessions are reclaimed when idle — the link keeps
  working only while this session is alive to answer.
- **Size:** the relay caps message bodies (~4 KB); `bridge.py send` chunks
  automatically and the app reassembles.
- See `reference/protocol.md` for the wire format and `reference/hosting.md`
  for every hosting option and the tunnel-mode recipe.
