#!/usr/bin/env bash
# Run the full aapp test suite: rebuild app.html from web/ and check it matches
# the committed file (drift guard), the two Node unit tests (no deps, no
# browser), and the browser end-to-end (self-orchestrating; skips cleanly if
# Playwright isn't installed).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "== build app.html from web/ and check for drift =="
( cd web && AAPP_OUT="$PWD/../.claude/skills/aapp/app.html" node build.mjs )
git diff --exit-code .claude/skills/aapp/app.html \
  || { echo "app.html is out of date — commit the rebuilt file"; exit 1; }

echo "== client.test.js (library unit) =="
node test/client.test.js

echo "== markdown.test.js (renderer / GFM tables) =="
node test/markdown.test.js

echo "== e2e.test.js (browser <-> bridge over a local relay) =="
node test/e2e.test.js

echo
echo "✅ all aapp tests passed"
