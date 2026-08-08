# aapp

**Chat with a running Claude Code session from your phone.**

`aapp` is a drop-in [Claude Code](https://claude.com/claude-code) skill. Invoke
it in any session and it produces a single **public link** that hosts a
mobile-first chat web app — installable to the iPhone Home Screen — whose
messages go straight to that session, with the agent's replies streaming back
in real time.

- **Zero infra:** messaging rides on the free public [ntfy.sh](https://ntfy.sh)
  relay over plain HTTPS, so it works even in locked-down sandboxes where
  tunnels and raw TCP are blocked. No server, no account.
- **Installable PWA:** `Add to Home Screen` gives a standalone app icon.
- **Feature-rich chat:** Markdown + code blocks, typing indicator, live
  status, streaming/chunked replies, auto-reconnect, offline catch-up, and
  on-device history.
- **Private by design:** the session token lives in the URL fragment, which
  browsers never send to the host or CDN.

## Use it

The skill lives in [`.claude/skills/aapp/`](.claude/skills/aapp/). In a Claude
Code session:

```
/aapp
```

…or just ask: *"give me a link to chat with this session from my phone."*
Claude follows [`SKILL.md`](.claude/skills/aapp/SKILL.md) to mint a session,
host the app, hand you the link, and then act as the other end of the chat.

## Layout

| File | Role |
|------|------|
| `.claude/skills/aapp/SKILL.md` | Instructions Claude follows |
| `.claude/skills/aapp/app.html` | The phone app (single self-contained file) |
| `.claude/skills/aapp/scripts/bridge.py` | Agent-side relay client (stdlib only) |
| `.claude/skills/aapp/scripts/serve.py` | Optional local server for tunnel hosting |
| `.claude/skills/aapp/reference/protocol.md` | Wire protocol (v1) |
| `.claude/skills/aapp/reference/hosting.md` | Every hosting option |
