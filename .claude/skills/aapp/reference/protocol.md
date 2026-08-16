# aapp wire protocol (v1)

The phone app and the agent bridge talk over a single **topic** that acts
as a shared realtime channel. Every message is a JSON **envelope** carried as
the relay message body. Both sides publish and subscribe to the same topic.

## Transport

- **Relay:** the **aapp relay** at `https://relay.aapp.run` (a Cloudflare
  Worker + Durable Object) by default. Its HTTP API is a compatible subset of
  [ntfy](https://ntfy.sh), so any ntfy server also works via `--server` / the
  link's `s=` fragment. Versus the public ntfy.sh tier the relay adds: no
  anonymous publish rate limit, durable per-topic history (a 500-message ring
  buffer, not a ~12h cache), and attachments stored on the relay itself.
- **Topic:** `aapp-<~40 hex chars>`, random per session. It is the shared
  secret; keep it only in the URL fragment.
- **Publish:** `POST {server}/{topic}` with the JSON envelope as the raw body
  and header `Content-Type: application/json`.
- **Subscribe (stream):** `GET {server}/{topic}/json?since={cursor}` — the relay
  streams newline-delimited JSON (`{"id","event","message",…}`). Track the
  `id` of the last line as the next `cursor` for resumable reconnects. An absent
  `since` streams only new messages (live-only); `since=all` replays the buffer.
- **Subscribe (history / fallback):** `GET {server}/{topic}/json?poll=1&since=all`
  returns buffered messages (the aapp relay retains the last 500 per topic) and
  closes.
- **CORS:** the relay sends `Access-Control-Allow-Origin: *`, so the browser app
  can read and post cross-origin from any static host.

## Envelope

```jsonc
{
  "v": 1,                     // protocol version
  "cid": "web-ab12cd34",      // sender instance id — receivers ignore their own
  "role": "user" | "agent",   // who sent it (phone = user, session = agent)
  "type": "msg" | "typing" | "status" | "system" | "activity" | "title" | "icon" | "attach" | "ask" | "tasks" | "recommend" | "sources" | "table" | "insight" | "sync" | "sync-done" | "reload",
  "replay": true,             // present on history re-broadcasts (see Durable history)
  "force": true,              // for type=reload (reload unconditionally)
  "kind": "assistant" | "tool" | "user",   // for type=activity only
  "emoji": "🚀",              // for type=icon (emoji rendered to the icon)
  "url": "https://…|data:…",  // for type=icon / type=attach (image or file URL)
  "name": "photo.jpg",        // for type=attach (file name)
  "mime": "image/jpeg",       // for type=attach (decides inline image vs file chip)
  "size": 20345,              // for type=attach (bytes, optional)
  "mid": "u1a2b3c",           // logical message id (groups multi-part messages)
  "seq": 0,                    // 0-based part index
  "last": true,                // true on the final part of a message
  "text": "hello",            // content for msg/system/status
  "state": "on" | "off",      // for type=typing
  "options": ["Yes","No"],    // for type=ask (tappable answer chips) / type=recommend ([{label,value,primary?}])
  "freeText": true,            // for type=ask (allow a typed answer too)
  "items": [ … ],             // for type=tasks ([{id,label,status,meta?}]) / type=sources ([{title,meta?,snippet?,url?}])
  "title": "Restock plan",    // heading for type=tasks/sources/table/insight
  "confidence": "high",       // for type=recommend ("high"|"medium"|"low")
  "columns": [ … ],           // for type=table ([{key,label,align?,kind?}]; kind: text|num|tag|entity)
  "rows": [ … ],              // for type=table (array of row objects keyed by column.key)
  "stats": [ … ],             // for type=insight ([{label,value,delta?,tone?}]; tone: up|down|flat|neutral)
  "followup": "Rebalance?",   // for type=insight (optional follow-up prompt chip)
  "ts": 1735000000000          // epoch ms
}
```

### Types

- **`msg`** — a chat message. May be split across parts (`seq`/`last`) when the
  text would exceed the relay's ~4 KB body limit. Receivers buffer by `mid`
  and concatenate parts in `seq` order until `last` is seen. Appending parts as
  they arrive yields a streaming effect.
- **`presence`** — a tiny liveness beat published every ~25s by the always-on
  `bridge.py tail` daemon (which also owns the activity feed and history replay).
  The app tracks the last time it heard *any* agent signal (presence, msg,
  typing, status, activity…) and shows **online** when fresh, **not listening**
  when stale (relay up but the session's daemon is gone), clearing a stuck typing
  indicator and warning the user on send. Not rendered. (`bridge.py wait` is a
  pure doorbell and does not beat unless run standalone with `--presence`.)
- **`typing`** — ephemeral "thinking" indicator; `state:"on"|"off"`. Not stored
  as a message. `bridge.py wait` auto-publishes `state:"on"` the moment a message
  is received (unless `--no-ack`), and the app also shows it optimistically on
  send, so the user sees activity immediately; the app self-expires it after
  ~150s of silence so a dead session doesn't spin forever.
- **`status`** — a transient one-line status (e.g. "running tests…"), shown
  briefly and not kept in history.
- **`system`** — a persistent centered notice (e.g. an error banner).
- **`title`** — the session's current title (from `bridge.py tail`). The app
  updates its header, document title, and iOS app-title live, so renaming the
  session renames the app. Persisted per-topic and overrides the link's `n=`.
- **`attach`** — an image or file. The file is uploaded to the relay as an ntfy
  attachment (`PUT {server}/{topic}` with a `Filename` header returns a hosted
  `url`); the envelope carries `url`/`name`/`mime`/`size` (+ optional `text`
  caption). The app renders `image/*` inline and other types as a downloadable
  file chip. Send from the agent with `bridge.py attach --file <path>`; the phone
  sends photos (camera/library) and files from the composer. The aapp relay
  stores attachments durably in Durable Object storage (served from
  `relay.aapp.run/file/<id>`); on an ntfy server they are hosted for a few hours.
- **`icon`** — sets the app icon live (`bridge.py icon --emoji 🚀` or
  `--url <img>`). The app renders an emoji onto a rounded gradient tile (or uses
  the image) and updates the favicon, apple-touch-icon, manifest icon, and
  header avatar. Persisted per-topic.
- **`activity`** — one line of session activity (from `bridge.py tail`), with a
  `kind` of `assistant` (a model message), `tool` (a compact tool-call summary),
  or `user` (a terminal-side user turn). Rendered as a distinct muted feed,
  separate from chat bubbles, and hideable per-device. Summaries only — never
  raw tool output or file contents.
- **`ask`** — a human-in-the-loop question the agent poses (`bridge.py ask
  --text "Deploy to prod?" --option Yes --option No`). The app renders an
  **approval card** with the question and tappable option chips (plus a note that
  a typed reply also works, unless `freeText:false`). Tapping an option — or
  typing — sends the answer back as a normal `role:"user"` `msg`, so the agent's
  `wait` loop picks it up like any reply; the card then locks to the chosen
  answer. Logged and replayed (tagged `replay:true`) so it survives reload, and
  the app de-dupes it by `mid`.
- **`tasks`** — a live task list (`bridge.py tasks --title "Restock plan"
  --item "Verify vendors:done:12 suppliers" --item "Draft emails:running"`; item
  format `label:status[:meta]` with status `todo|running|done|failed`, or `--json`
  with `[{id,label,status,meta?}]`). The app renders **capsule task rows** with a
  status token (green check / spinner-ring number / red ✕ / empty ring), a right
  mono `meta`, and a status chip. Unlike the other types this is **not** de-duped
  by `mid`: re-running with the same `--mid` **updates** the list in place (a task
  flips `todo→running→done`) and the app upserts by `mid`. Logged (last write per
  `mid` wins) and replayed so the latest state survives reload.
- **`recommend`** — an agent suggestion with a confidence meter and actions
  (`bridge.py recommend --text "Reorder from \`cone_king\`" --confidence high
  --option "Accept:accept:primary" --option "Alternatives:alt"`; option format
  `label:value[:primary]`). The app renders a card: body markdown (inline-code
  chips), footer = a 3-bar **confidence meter** (`high`→3 green, `medium`→2 amber,
  `low`→1 amber) + label + action chips (one filled-accent `primary`). Tapping an
  option sends its `value` back as a normal `role:"user"` `msg` — exactly like
  `ask` — so `wait` picks it up; the card then locks. De-duped by `mid`, logged,
  replayed.
- **`sources`** — context / citation cards (`bridge.py sources --title "All chunks"
  --item "flavors.ts | 290 chars | …snippet… | https://…"`; item format
  `title | meta | snippet | url` pipe-separated, or `--json`). The app renders an
  **"All chunks · N"** heading then mini cards (glyph, title, right mono `meta`,
  muted `snippet`, optional link chip). De-duped by `mid`, logged, replayed.
- **`table`** — a records / data table (`bridge.py table --json
  '{"columns":[{"key","label","align?","kind?"}],"rows":[…],"tags?":{}}'`, from a
  literal, a file, or `-` stdin). Column `kind` selects the cell renderer:
  `entity` (colored monogram + name), `tag` (colored-dot chips from an array
  value), `num` (tabular mono, tinted green/red by sign), else plain text. The app
  renders a **records table** with a sticky header, hairline rows, horizontal
  scroll, and a footer count. De-duped by `mid`, logged, replayed.
- **`insight`** — an insight / stat card (`bridge.py insight --text "… @Creamery …
  \`-6%\`" --stat "Mint Chip:-4.41%:-$2,377.66:down" --followup "Rebalance?"`; stat
  format `label:value[:delta][:tone]`, or `--json`). The app renders **prose** with
  colored `@mentions` and signed deltas, a **stat panel** (colored dot + name + big
  signed % + small signed $), and an optional follow-up chip that sends its text as
  a reply. De-duped by `mid`, logged, replayed.
- **`sync`** — a client request (`role:"user"`) asking the agent to replay
  durable history. Sent once on app boot. The agent's `serve`/`tail` responder
  answers by re-broadcasting its log; other clients ignore it.
- **`sync-done`** — marks the end of a replay batch (carries a `count`).
  Informational; clients ignore it.
- **`reload`** — asks connected clients to update to the latest deployed app
  build (`bridge.py reload`). Without `force`, the client re-checks the deployed
  version and reloads only if it changed; with `force:true` it reloads
  immediately. See **Auto-update** below.

## Auto-update

The Pages build stamps the app with a **build id** (the commit sha): `app.html`
carries `var BUILD = "<sha>"` and a sibling `version.json` (`{"build":"<sha>"}`)
is published alongside it. The client polls `version.json` (on boot, on regaining
focus, and every ~15 min); when the deployed build differs from its own `BUILD`,
a newer app is live, so it reloads via a cache-busted URL (`…?v=<sha>#…`), with a
`sessionStorage` guard keyed to the target build to prevent reload loops. An
unstamped copy (served outside the Pages build, so `BUILD` is still the literal
placeholder) keeps auto-update off. The agent can also push an update instantly
with `bridge.py reload` (a `reload` envelope).

## Durable history

The relay only caches ~12h, so a late-joining client can't rebuild older
history from it. The agent therefore keeps an authoritative append-only log of
chat envelopes (`<state>.log.jsonl`: agent `msg`/`system`/`attach`/`title`/
`icon`/`activity`/`ask`/`tasks`/`recommend`/`sources`/`table`/`insight` and each
inbound user `msg`/`attach`). When a client boots it
publishes a `sync` request; the always-on responder (`bridge.py serve`, folded
into `tail`) re-broadcasts the log — the last ~400 timeline items (chat messages,
attachments, **and activity lines**, in the order they happened) then the latest
title+icon — each envelope tagged **`replay:true`** and carrying its **original
`mid`**. So a late-joining device rebuilds the whole view, including the activity
feed. Consequences:

- Connected clients **de-dupe by `mid`**, so a replay never double-renders for
  someone who already has the messages.
- The agent's `wait` loop **ignores `replay:true`**, so replayed history is
  never reprocessed as a new inbound message.
- Each requesting client id is served at most once per ~2 min (coalescing).

### Rules

- A sender sets `cid` to its own instance id and **ignores envelopes with its
  own `cid`** (ntfy echoes published messages back to subscribers).
- The agent only acts on `role:"user"` `msg` envelopes.
- **Link-as-identity:** the app treats every `role:"user"` message as "you" and
  renders it identically (right-aligned) on every device, and `role:"agent"` as
  the other side (left). So a phone and a tablet opened on the same link show an
  identical conversation — there is no per-device "mine" and no per-sender
  labeling. `cid` is used only to suppress a device's own echoes.
- Dedup on the ntfy line `id` and on `(mid, seq)` so reconnect replays are
  idempotent.
- Unknown `type` or `v` values are ignored — forward-compatible.

## Reference implementations

- Agent side: `scripts/bridge.py` (`send` chunks; `wait` reassembles).
- Reusable client: `aapp-client.js` — the phone-side protocol logic (transport,
  de-dupe, reassembly, presence, chunked send) with no DOM. Browser or Node. See
  [`client.md`](client.md).
- Phone side: `app.html` is the UI built on `aapp-client.js` (inlined verbatim so
  the file stays self-contained; kept in sync by `scripts/sync-client.py`).
