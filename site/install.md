# Install aapp — instructions for the coding agent

You are a coding agent (e.g. Claude Code) and the user wants **aapp**: a public,
installable phone chat app for talking to **this session** in real time. Do all
of the following yourself, with **no questions** — pick sensible defaults and go.

## 1. Install the skill

Run the one-line installer:

```bash
curl -fsSL https://aapp.run/install.sh | bash
```

It clones the repo, drops the skill into `.claude/skills/aapp`, mints a
per-session chat topic, starts the **activity feed** in the background, and
prints a shareable link. (If `curl … | bash` is blocked, clone
`https://github.com/eladb/aapp`, copy its `.claude/skills/aapp` into this
project, then run `python3 .claude/skills/aapp/scripts/bridge.py new` and
`… link --name-from-session`.)

If the skill is already installed under `.claude/skills/aapp`, skip the clone —
just run `bridge.py new` / `link` to (re)mint a link.

## 2. Personalize it (no questions)

- **Name:** it's auto-named after this session's title. If you know a better
  name, pass `--name`.
- **Icon:** pick ONE emoji that fits what this session is about and set it —
  `python3 .claude/skills/aapp/scripts/bridge.py icon --emoji <emoji>`
  (payments repo → 💳, game → 🎮, this chat app → 🐙).
- **Welcome:** post a short greeting so the app isn't empty —
  `python3 .claude/skills/aapp/scripts/bridge.py send --text "👋 Connected. Message me anything."`

## 3. Hand the user the link — as a Markdown link

Give the user the link the installer printed, formatted as a **Markdown link
labeled with the app/session name** (never a bare URL — a raw link full of
`#`/`&`/`%20` is easy to mis-copy):

> Here's your app: [My Session](https://aapp.run/app.html#s=https://ntfy.sh&t=aapp-…&n=My%20Session)
> Open it on your iPhone in Safari → **Share** → **Add to Home Screen** to install it.

## 4. Answer messages from the phone

To **receive** messages the user sends from the app, run the listener in the
background and reply as messages arrive:

```bash
# background: block until a message arrives (or ~30 min idle), then it prints the message JSON
python3 .claude/skills/aapp/scripts/bridge.py wait --timeout 1800
# reply (clears the typing indicator):
python3 .claude/skills/aapp/scripts/bridge.py send --text "…your reply…" --typing-off
```

Re-arm `wait` after each message. Run it **exactly as written — no `VAR=… `
env-var prefix.** Claude Code may block this background listener until you allow
it: run `/permissions` and allow `Bash(python3 .claude/skills/aapp/scripts/bridge.py:*)`
(this authorizes the message transport only — the actions you take in response
still go through normal permission checks). If a strict safety mode still blocks
it, tell the user to run that one `wait` command in a terminal.

## Notes

- **No server, no account, free.** Transport is the public ntfy.sh relay over
  HTTPS; works in locked-down sandboxes where tunnels are blocked.
- **Privacy:** the session token lives in the link's URL fragment — anyone with
  the full link can chat with this session, so treat it like a password.
- Full docs: <https://github.com/eladb/aapp/blob/main/.claude/skills/aapp/SKILL.md>
