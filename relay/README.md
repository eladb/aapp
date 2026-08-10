# aapp-relay

An **ntfy-compatible** realtime relay for [aapp](https://aapp.run), built as a
single Cloudflare **Worker + Durable Object**. It replaces the public `ntfy.sh`
tier (whose anonymous publish rate limit broke the app) while speaking the same
HTTP subset, so the phone app (`app.html`) and the agent (`bridge.py`) only had
to repoint their default server — no protocol rewrite.

Live at **`https://relay.aapp.run`**.

## Why

The public `ntfy.sh` free tier rate-limits publishing per source IP (HTTP 429),
which is fatal for a chatty, long-lived agent session. This relay has no such
limit at aapp's scale, and additionally provides:

- **Durable history** — a persisted per-topic ring buffer (last 500 messages),
  not a ~12h cache. A late-joining device rebuilds the view via `since=all`.
- **Attachments on the relay** — uploaded blobs are stored in Durable Object
  storage and served from `/file/<id>` (ntfy hosts them for only a few hours).
- **Server-tracked liveness** — the streaming connection is the source of truth
  for whether a subscriber is connected; no cross-network heartbeat traffic.

## Wire API (the ntfy subset aapp uses)

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/:topic` | Publish an opaque JSON envelope. Returns `{id,time,event,topic}`. |
| `GET`  | `/:topic/json?since=&poll=` | ndjson stream (or `poll=1` one-shot). Lines: `{event:"open"}`, `{id,time,event:"message",topic,message}`, `{event:"keepalive"}`. |
| `PUT`  | `/:topic` + `Filename:` header | Upload an attachment (≤5MB). Returns `{id,url,name,size,attachment}`. |
| `GET`  | `/file/:id` | Serve a stored attachment. |
| `OPTIONS` | `*` | CORS preflight (`*` origin; echoes requested headers). |

`since` semantics: **absent** → live-only (stream from now, no replay — this is
what `bridge.py`'s sync responder relies on); `all`/`0` → replay the whole
buffer; `<base36 id>` → replay ids greater than the cursor. The cursor is the
last line `id` a client saw, so reconnects resume exactly-once within the buffer
window.

## Design notes

- One Durable Object instance **per topic** (`idFromName(topic)`); one singleton
  `idFromName("$files")` holds attachments (the `/file/<id>` URL carries no
  topic). The reserved topic name `$files` is rejected.
- Each topic DO keeps a **monotonic counter** (base36 → public `id`) and a
  ring buffer in SQLite-backed storage. `publish()` persists `{counter,message}`
  in one atomic transaction **before** fanning out, so a crash can never re-issue
  an id (which would look like a gap to a client holding that id as its cursor).
- Live subscribers are held as open `ReadableStream` controllers in memory;
  fan-out enqueues to each, with a per-connection backpressure cap and a storage
  **alarm** (~30s) driving keepalives and dead-subscriber reaping.
- Exactly-once across the replay/live boundary: the stream's `start()`
  snapshots the buffer and registers the controller **synchronously** (the DO
  input gate is closed), and a per-sub high-water mark (`lastIntId`) skips
  anything already replayed.

Known bounds (fine at personal-relay scale): a reconnect gap larger than the
500-message window is silently unrecoverable from the relay alone (the agent's
durable log + `sync` replay is the real backstop); an open stream keeps its DO
resident; the single `$files` DO is a shared counter for all attachments.

## Deploy

Requires a Cloudflare API token with **Workers Scripts: Edit** on the account,
and (for the custom domain) zone access to `aapp.run`.

With [wrangler](https://developers.cloudflare.com/workers/wrangler/):

```bash
cd relay
npx wrangler deploy          # uploads worker.js + the SQLite DO migration
```

`wrangler.toml` declares the `TOPIC` Durable Object binding and a
`new_sqlite_classes = ["Topic"]` migration (SQLite-backed DOs run on the Workers
**Free** plan; KV-backed DOs are paid-only).

The custom domain `relay.aapp.run` is attached as a Worker
[custom domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
(auto-managed DNS + certificate).

> The account needs a `workers.dev` subdomain to exist before any DO Worker can
> be uploaded (a one-time account init in the Workers dashboard).
