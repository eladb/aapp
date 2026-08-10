# aapp tests

Tests for the phone app (`app.html`), the extracted client (`aapp-client.js`),
and the agent bridge (`bridge.py`). Nothing here ships to installs — `install.sh`
copies only `.claude/skills/aapp`, not this directory.

Run everything:

```bash
test/run.sh
```

| File | What it checks | Needs |
|------|----------------|-------|
| `client.test.js` | `aapp-client.js` in isolation: link parsing, byte-aware chunking + reassembly (incl. multibyte), inbound de-dupe/dispatch, presence, bounded pruning, send/publish/sync. | `node` |
| `app.test.js` | `app.html`'s script wired to the client, run in a Node `vm` against a DOM/fetch shim: load, boot, an inbound agent message (render + presence), optimistic send, boot sync. | `node` |
| `e2e.test.js` | The real `app.html` in headless Chromium and the real `bridge.py`, exchanging messages both ways, plus markdown rendering and history-replay on reload. | `node`, `playwright` + a Chromium |
| `mini-ntfy.js` | Not a test — a tiny in-memory ntfy-compatible relay used by `e2e.test.js` (and runnable standalone: `MINI_PORT=8799 node test/mini-ntfy.js`). | `node` |

## Why a local relay?

`e2e.test.js` points both the app and `bridge.py` at `mini-ntfy.js` on localhost
instead of the public `ntfy.sh`. That keeps the test hermetic and immune to the
public relay's daily message quota — the wire protocol is identical, so the app,
the client, and the bridge all run their real code paths. (It also sidesteps a
sandbox quirk where a MITM egress proxy resets headless-Chromium connections;
the browser only ever talks to localhost.)

## Individual runs

```bash
node test/client.test.js
node test/app.test.js
node test/e2e.test.js          # writes a screenshot to $E2E_SHOT or the temp dir
```

`e2e.test.js` prints `SKIP` and exits 0 when Playwright isn't available, so
`run.sh` stays green on machines without a browser. To install Playwright +
Chromium: `npm i -g playwright && npx playwright install chromium`.
