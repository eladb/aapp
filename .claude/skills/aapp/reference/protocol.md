# aapp wire protocol (v1)

The phone app and the agent bridge talk over a single **ntfy topic** that acts
as a shared realtime channel. Every message is a JSON **envelope** carried as
the ntfy message body. Both sides publish and subscribe to the same topic.

## Transport

- **Relay:** any [ntfy](https://ntfy.sh) server. Default `https://ntfy.sh`.
- **Topic:** `aapp-<~40 hex chars>`, random per session. It is the shared
  secret; keep it only in the URL fragment.
- **Publish:** `POST {server}/{topic}` with the JSON envelope as the raw body
  and header `Content-Type: application/json`.
- **Subscribe (stream):** `GET {server}/{topic}/json?since={cursor}` — ntfy
  streams newline-delimited JSON (`{"id","event","message",…}`). Track the
  `id` of the last line as the next `cursor` for resumable reconnects.
- **Subscribe (history / fallback):** `GET {server}/{topic}/json?poll=1&since=all`
  returns cached messages (ntfy caches ~12h) and closes.
- **CORS:** ntfy.sh sends `Access-Control-Allow-Origin: *`, so the browser app
  can read and post cross-origin from any static host.

## Envelope

```jsonc
{
  "v": 1,                     // protocol version
  "cid": "web-ab12cd34",      // sender instance id — receivers ignore their own
  "role": "user" | "agent",   // who sent it (phone = user, session = agent)
  "type": "msg" | "typing" | "status" | "system",
  "mid": "u1a2b3c",           // logical message id (groups multi-part messages)
  "seq": 0,                    // 0-based part index
  "last": true,                // true on the final part of a message
  "text": "hello",            // content for msg/system/status
  "state": "on" | "off",      // for type=typing
  "ts": 1735000000000          // epoch ms
}
```

### Types

- **`msg`** — a chat message. May be split across parts (`seq`/`last`) when the
  text would exceed the relay's ~4 KB body limit. Receivers buffer by `mid`
  and concatenate parts in `seq` order until `last` is seen. Appending parts as
  they arrive yields a streaming effect.
- **`typing`** — ephemeral indicator; `state:"on"|"off"`. Not stored as a
  message.
- **`status`** — a transient one-line status (e.g. "running tests…"), shown
  briefly and not kept in history.
- **`system`** — a persistent centered notice (e.g. an error banner).

### Rules

- A sender sets `cid` to its own instance id and **ignores envelopes with its
  own `cid`** (ntfy echoes published messages back to subscribers).
- The agent only acts on `role:"user"` `msg` envelopes; the phone only renders
  `role:"agent"` content (plus its own optimistic user echoes).
- Dedup on the ntfy line `id` and on `(mid, seq)` so reconnect replays are
  idempotent.
- Unknown `type` or `v` values are ignored — forward-compatible.

## Reference implementations

- Agent side: `scripts/bridge.py` (`send` chunks; `wait` reassembles).
- Phone side: `app.html` (fetch-stream reader with cursor + poll fallback).
