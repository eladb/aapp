#!/usr/bin/env bash
# Run the full aapp test suite: the inline-sync check, the two Node tests (no
# deps, no browser), and the browser end-to-end (self-orchestrating; skips
# cleanly if Playwright isn't installed).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== inline client sync check =="
python3 .claude/skills/aapp/scripts/sync-client.py --check

echo "== client.test.js (library unit) =="
node test/client.test.js

echo "== markdown.test.js (renderer / GFM tables) =="
node test/markdown.test.js

echo "== app.test.js (app-script integration, no browser) =="
node test/app.test.js

echo "== e2e.test.js (browser <-> bridge over a local relay) =="
node test/e2e.test.js

echo
echo "✅ all aapp tests passed"
