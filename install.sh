#!/usr/bin/env bash
#
# aapp — one-shot installer.
#
# Drops the aapp skill into the current project (.claude/skills/aapp) and mints a
# public, phone-ready chat link for THIS Claude Code session. No questions.
#
#   curl -fsSL https://raw.githubusercontent.com/eladb/aapp/main/install.sh | bash
#
# The app shell itself is already hosted publicly (GitHub Pages), and the session
# lives entirely in the link's URL fragment, so there is nothing to deploy — this
# just installs the bridge and prints your link.
#
set -euo pipefail

REPO="${AAPP_REPO:-https://github.com/eladb/aapp}"
DEST="${AAPP_DEST:-.claude/skills/aapp}"

echo "→ installing aapp skill from ${REPO}"
tmp="$(mktemp -d)"
cleanup(){ rm -rf "$tmp"; }
trap cleanup EXIT

if git clone --depth 1 "$REPO" "$tmp/src" >/dev/null 2>&1; then
  :
else
  echo "  git clone unavailable; fetching tarball…"
  curl -fsSL "${REPO}/archive/refs/heads/main.tar.gz" | tar -xz -C "$tmp"
  mv "$tmp"/*-main "$tmp/src"
fi

if [ ! -d "$tmp/src/.claude/skills/aapp" ]; then
  echo "  ✗ could not find the skill in the repo" >&2; exit 1
fi

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST"
cp -r "$tmp/src/.claude/skills/aapp" "$DEST"
echo "  ✓ installed to ${DEST}"

# --- publish: mint a session + link (canonical hosted app, session name) ---
export AAPP_STATE="${AAPP_STATE:-${TMPDIR:-/tmp}/aapp/session.json}"
python3 "$DEST/scripts/bridge.py" new >/dev/null
LINK="$(python3 "$DEST/scripts/bridge.py" link --name-from-session)"
python3 "$DEST/scripts/bridge.py" send \
  --text "👋 Connected to your Claude Code session. Send me anything." >/dev/null 2>&1 || true

echo
echo "✅ Your shareable link — open on your phone, then Add to Home Screen:"
echo
echo "   ${LINK}"
echo
echo "State file: ${AAPP_STATE}"
echo "Invoke the aapp skill so the agent starts answering messages from the app."
