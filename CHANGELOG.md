# Changelog

## v1.0.0 — Beautiful UI app promoted to default

The phone app is now the React + Beautiful UI build. `app.html` — the single
self-contained, installable PWA that a session link points at — is the esbuild
bundle of `web/`, replacing the hand-authored vanilla app it shipped as the
`app-next.html` preview.

### App
- **React + Beautiful UI** chat, promoted from preview to the live default.
  Neutral surfaces, electric-blue accent, hairline borders, JetBrains-mono
  numerals, pixel-grid thinking loader — the standard Beautiful UI theme, no
  decorative extras.
- **Agent-driven components**: approval cards (`ask`), task lists, recommend
  cards, sources, records tables, and insight cards, alongside the standard
  chat panel and prompt bar.
- **Installed-PWA bottom-gap fix**: paint `html` with the page color so the
  home-indicator / `dvh`-excluded strip beneath the app is seamless instead of
  a bare band under the composer.
- **Markdown**: GFM tables render even when glued directly under a paragraph.

### Pipeline
- `app.html` is built from `web/` (`AAPP_OUT=…/app.html node web/build.mjs`) and
  committed; a deterministic esbuild bundle keeps it reproducible.
- Pages deploy stamps `__AAPP_BUILD__` + `version.json` for client auto-update;
  `next.html` is kept as an unstamped alias for older preview links.
- CI rebuilds `app.html` from `web/` and fails on drift, replacing the old
  inline-client sync guard. Removed the obsolete `sync-client.py` and the
  vanilla-only `app.test.js`; `markdown.test.js` now tests `web/src/markdown.js`
  directly.

### Relay
- Real-time transport runs on the `relay.aapp.run` Cloudflare Worker + Durable
  Object (ntfy-API-compatible: publish, ndjson stream/poll, attachments), with
  a 500-message durable ring buffer for history replay.
