# `aapp-client.js` — reusable JavaScript client

`aapp-client.js` is the aapp **v1 protocol client**, extracted from the phone
app (`app.html`) with none of the DOM. Point it at an ntfy relay + topic (or a
full aapp link) and it connects, de-dupes, reassembles multi-part messages,
tracks agent presence, and lets you publish messages, attachments, and sync
requests. You bring the UI — or none at all (it runs headless in Node).

It mirrors the reference implementations byte-for-byte: same envelope shape,
same chunking budget (`MAX_ENVELOPE_BYTES = 3000`, per-part overhead `+8`), same
presence timings (`AGENT_TTL 90s`, `BOOT_GRACE 55s`), same de-dupe rules. So it
interoperates with both `app.html` and `scripts/bridge.py` on the same topic.
See [`protocol.md`](protocol.md) for the wire format.

- **Zero dependencies, no build.** One file. UMD: `<script>` global, CommonJS
  `require`, or AMD.
- **Runs anywhere with a streaming `fetch`:** modern browsers and Node 18+
  (Node 22 tested). Falls back to long-poll where streaming bodies are absent.

## Loading

```html
<!-- browser: exposes window.AappClient -->
<script src="aapp-client.js"></script>
```

```js
// Node / bundler
const AappClient = require("./aapp-client.js");
```

## Quick start (browser)

```js
const c = AappClient.fromLink(location.href);   // reads #s=…&t=…&n=… from the link
c.on("connection", s => setDot(s.state));        // relay link: connecting|live|reconnecting|offline
c.on("presence",   p => setOnline(p.state === "online"));  // is a listener answering?
c.on("msg",        m => upsertBubble(m));         // streaming user/agent messages
c.on("attach",     a => renderAttachment(a));
c.on("activity",   a => renderActivityLine(a));   // session steps (summaries)
c.on("typing",     t => showDots(t.state === "on"));
c.on("status",     s => flashStatus(s.text));
c.on("title",      t => setTitle(t.text));
c.on("icon",       i => setIcon(i.emoji || i.url));
c.start();

// on boot, ask the agent to replay durable history (de-duped by mid)
c.requestSync();

await c.sendText("hello from my phone");
```

## Headless (Node)

```js
const AappClient = require("./aapp-client.js");
const c = AappClient.fromLink(process.argv[2]);  // an aapp link
c.on("msg", m => { if (m.done && m.role === "agent") console.log("agent:", m.text); });
c.start();
c.sendText("run the tests and tell me the result");
```

## Constructor

```js
new AappClient({
  server,      // relay base URL (default "https://ntfy.sh")
  topic,       // ntfy topic — REQUIRED to start (the shared secret)
  name,        // optional display name (updated live by `title` envelopes)
  cid,         // this instance's id (default random "js-…"); own echoes ignored
  cursor,      // ntfy read cursor to resume from ("all" replays the ~12h cache)
  mode,        // "auto" | "stream" | "poll"  (default "auto")
  fetch,       // fetch implementation (default global fetch)
  presence,    // run the presence re-evaluation timer (default true)
  maxBackoff,  // cap on reconnect backoff ms (default 15000)
})
```

`AappClient.fromLink(link, overrides?)` builds one from a full link, a bare
`#s=…&t=…` fragment, or an `s=…&t=…` query string.

## Methods

| Method | Description |
|--------|-------------|
| `start()` | Connect and begin streaming (or polling). Idempotent. |
| `stop()` | Disconnect, clear timers, abort the in-flight request. |
| `sendText(text, {role?, mid?})` → `Promise<{mid, parts}>` | Chunk + publish a chat message (default `role:"user"`). |
| `sendAttachment(body, {name, mime, size?, w?, h?, text?, role?})` → `Promise<env>` | Upload a Blob/bytes to the relay, then publish an `attach` envelope. |
| `requestSync()` → `Promise` | Ask the agent to replay durable history. |
| `sendTyping(on, role?)` → `Promise` | Publish a typing indicator. |
| `publish(env)` → `Promise<Response>` | Low-level: publish a raw envelope (fills `v`/`cid`/`ts`). |
| `agentState()` → `"online"\|"unknown"\|"offline"` | Presence from recent agent signals. |
| `isAgentOnline()` → `boolean` | Shorthand for `agentState() === "online"`. |
| `feedLine(line)` | Feed one raw ntfy JSON stream line (for tests / custom transports). |

Static: `AappClient.parseLink(link)`, `AappClient.buildLink({appUrl, server, topic, name})`,
`AappClient.chunkText(text, cid, {role?, mid?})`, `AappClient.byteLen(str)`.

## Events

Register with `c.on(type, handler)` (also `.once`, `.off`).

| Event | Payload | Notes |
|-------|---------|-------|
| `connection` | `{state}` | Relay link: `connecting`, `live`, `reconnecting`, `offline`. |
| `presence` | `{state}` | Agent listener: `online`, `unknown`, `offline`. Fires on change. |
| `msg` | `{mid, role, type, text, ts, done, seq, last, replay}` | Emitted per part; `text` is the assembled-so-far content (append/replace by `mid` for a streaming effect). |
| `system` | `{mid, text, ts, replay}` | Persistent centered notice. |
| `attach` | `{mid, role, mime, url, name, size, w, h, text, ts, replay}` | Image or file; de-duped by `mid`. |
| `activity` | `{mid, kind, text, ts, replay}` | Session step; `kind` is `assistant`\|`tool`\|`user`. De-duped by `mid`. |
| `typing` | `{state, role}` | `on`\|`off`. Only agent-side envelopes are surfaced. |
| `status` | `{text, role}` | Transient one-line agent status. |
| `title` | `{text}` | Session title; also updates `client.name`. |
| `icon` | `{emoji, url, raw}` | Live app icon. |
| `reload` | `{force}` | Agent asks clients to update to the latest build. |
| `sync` | `{role}` | A client requested history replay. |
| `sync-done` | `{count}` | End of a replay batch. |
| `envelope` | `{env, ntfyId}` | Every accepted inbound envelope (escape hatch). |
| `open` | ntfy control frame | ntfy stream opened. |
| `error` | `{error, context}` | A handler threw, or a soft transport error. |

## De-dupe & identity (same rules as `app.html`)

- Envelopes carrying the client's own `cid` are ignored (ntfy echoes publishes
  back to subscribers).
- Inbound is de-duped on the ntfy line `id`, on `(mid, seq)` for `msg`/`system`,
  and on `mid` for `attach`/`activity` — so reconnect/replay is idempotent.
- **Link-as-identity:** every `role:"user"` message is "you"; `role:"agent"` is
  the other side. There is no per-device "mine" — a phone and a tablet on the
  same link see an identical conversation.
- Unknown `type` or `v` values are ignored (forward-compatible).

## Attachments

`sendAttachment(blob, {name, mime})` PUTs the body to the relay (ntfy returns a
hosted URL) and publishes an `attach` envelope. In the browser pass a
`File`/`Blob`; downscale images yourself before upload if you want (see
`app.html`'s `downscaleImage`). ntfy.sh hosts attachments for a few hours only.

## Presence, not just connectivity

Two independent signals: the **relay link** (`connection`) and the **agent
listener** (`presence`). The relay can be `live` while no `bridge.py wait` is
running to receive messages — so a message would sit unanswered. The client
infers the listener from any agent-side signal (presence beat, msg, typing,
status, activity) within `AGENT_TTL`; use `agentState()` before sending to warn
the user when nothing is listening.
