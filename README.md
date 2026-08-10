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

## One-paste install & publish

Drop this repo's link into any Claude Code session and ask for a link — Claude
runs the one-shot installer, names the app after your session, picks a fitting
icon, and hands you a shareable URL. No hosting, no config, no questions:

```bash
curl -fsSL https://aapp.run/install.sh | bash
```

That installs the skill into `.claude/skills/aapp` and prints a phone-ready link
immediately (the app shell is already hosted publicly; your session travels in
the URL fragment, so there's nothing to deploy). Then invoke the skill and the
agent starts answering messages from the app.

## Use it

The skill lives in [`.claude/skills/aapp/`](.claude/skills/aapp/). In a Claude
Code session:

```
/aapp
```

…or just ask: *"give me a link to chat with this session from my phone."*
Claude follows [`SKILL.md`](.claude/skills/aapp/SKILL.md) to mint a session,
host the app, hand you the link, and then act as the other end of the chat.

## Updating existing sessions

- **Phone apps (already-shared links / Home-Screen installs):** they update
  automatically — the app is served from one stable URL
  (`https://aapp.run/app.html`; the site root is a landing page that
  redirects older `…/#t=…` links to it), so a redeploy reaches every install on
  its next load. Just **reload**, or fully close and reopen the Home-Screen app to
  force a fresh fetch. The link never changes; nothing needs re-sharing. Live
  data (messages, title, icon, activity) flows over the relay regardless of app
  version — only UI *code* changes need a reload.
- **A Claude session that installed the skill:** re-run the installer to refresh
  `.claude/skills/aapp`, then restart any running tailer/listener so agent-side
  changes take effect:
  ```bash
  curl -fsSL https://aapp.run/install.sh | bash
  ```
  (`aapp.run/install.sh` is served from GitHub Pages; give it a minute to
  redeploy after a push. Or point your agent at
  [`aapp.run/install.md`](https://aapp.run/install.md) and it'll follow the steps.)

## Build your own client

The phone app's protocol logic — connect, de-dupe, reassemble streaming
messages, track presence, send chunked messages/attachments — is extracted into
a standalone, dependency-free library,
[`aapp-client.js`](.claude/skills/aapp/aapp-client.js). It has no DOM
dependencies and runs in modern browsers and Node 18+, so you can build a
different UI (or a headless bot) on the same session:

```js
const c = AappClient.fromLink(location.href);
c.on("msg", m => render(m));            // streaming messages
c.on("presence", p => setOnline(p.state === "online"));
c.start();
await c.sendText("hello from my own client");
```

It speaks the exact same wire protocol as `app.html` and `bridge.py`, so every
client on a topic interoperates. Full API in
[`reference/client.md`](.claude/skills/aapp/reference/client.md).

## Layout

| File | Role |
|------|------|
| `.claude/skills/aapp/SKILL.md` | Instructions Claude follows |
| `.claude/skills/aapp/app.html` | The phone app (single self-contained file) |
| `.claude/skills/aapp/aapp-client.js` | Reusable JS protocol client (browser + Node, no deps) |
| `.claude/skills/aapp/scripts/bridge.py` | Agent-side relay client (stdlib only) |
| `.claude/skills/aapp/scripts/serve.py` | Optional local server for tunnel hosting |
| `.claude/skills/aapp/reference/protocol.md` | Wire protocol (v1) |
| `.claude/skills/aapp/reference/client.md` | `aapp-client.js` API + examples |
| `.claude/skills/aapp/reference/hosting.md` | Every hosting option |
