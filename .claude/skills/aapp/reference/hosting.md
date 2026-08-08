# Hosting `app.html`

`app.html` is one self-contained static file. It needs to live at a public
HTTPS URL whose page is allowed to `fetch()` the ntfy relay — i.e. a normal
static host **without** a restrictive Content-Security-Policy. (Claude
Artifacts, whose CSP blocks external fetch, cannot host it.) The session
identity travels in the URL fragment, so the **same file serves every
session** — you host it once and only the `#…` changes.

Pick the first option that fits the environment.

## 1. Public GitHub repo → githack  (recommended for cloud sessions)

No build, no settings toggles, instant.

1. Commit `app.html` to a **public** repo and push.
2. Get the commit SHA: `git rev-parse HEAD`.
3. URL:
   `https://rawcdn.githack.com/<owner>/<repo>/<sha>/<path/to>/app.html`

Use the **commit SHA**, not a branch name:
- branch names containing `/` (e.g. `claude/foo`) break the `/<ref>/<path>`
  parsing;
- a SHA is immutable, so the CDN can't serve a stale shell.

githack serves repo files with their real `text/html` content-type and adds no
blocking CSP, so the app's `fetch()` to ntfy works. Two hosts: `rawcdn.githack.com`
(production, long cache — use this for a stable link) and `raw.githack.com`
(dev, short cache — handy while iterating).

> **Don't use jsDelivr here.** jsDelivr deliberately serves `.html` as
> `text/plain` with `X-Content-Type-Options: nosniff` (anti-abuse), so the
> browser displays the source instead of running the app. It's great for JS/CSS
> assets, wrong for an HTML page.

## 2. GitHub Pages / Netlify / Vercel / any static host

Drop `app.html` in and use its URL. All fine — the only requirement is HTTPS
and no CSP that blocks `connect-src https://ntfy.sh`.

## 3. Local server + tunnel  (machines with open egress)

When you don't want to publish a file but the machine can open a tunnel:

```bash
python3 scripts/serve.py            # serves app.html on http://127.0.0.1:8787
# in another shell, expose it publicly:
cloudflared tunnel --url http://127.0.0.1:8787   # prints https://<rand>.trycloudflare.com
```

Then the app URL is `https://<rand>.trycloudflare.com/app.html`. Note: quick
tunnels need outbound access to Cloudflare's edge (port 7844) — blocked in some
sandboxes, which is exactly why the default path uses ntfy + a static host.

## 4. Self-hosted relay (optional hardening)

`ntfy.sh` topics are public to anyone who knows the (unguessable) topic. For
more control, run your own ntfy server (Docker: `binwiederhoehr/ntfy` /
`nfpm`), optionally with access tokens, and pass `--server https://your-ntfy`
to `bridge.py new`. The app reads the server from the link fragment (`s=`), so
no rebuild is needed.

## Why the fragment matters

The link looks like `…/app.html#s=<server>&t=<topic>`. Everything after `#` is
the fragment: the browser keeps it client-side and never sends it to the host
or CDN. So the CDN/host serving `app.html` never learns the topic — only the
user's browser and the ntfy relay do.
