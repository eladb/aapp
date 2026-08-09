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
# Scope state to THIS session so separate sessions never share a topic.
_sid="${CLAUDE_CODE_SESSION_ID:-${CLAUDE_CODE_REMOTE_SESSION_ID:-default}}"
export AAPP_STATE="${AAPP_STATE:-${TMPDIR:-/tmp}/aapp/session-${_sid}.json}"
python3 "$DEST/scripts/bridge.py" new >/dev/null
LINK="$(python3 "$DEST/scripts/bridge.py" link --name-from-session)"
python3 "$DEST/scripts/bridge.py" send \
  --text "👋 Connected to your Claude Code session. Send me anything." >/dev/null 2>&1 || true

# Start the session activity feed (summaries only) in the background so the app
# shows what the agent is doing by default. Transcript is auto-detected.
# Guard with a per-session pidfile so re-running install doesn't double-start,
# but a different session (different AAPP_STATE) still starts its own.
PIDF="${AAPP_STATE}.tail.pid"
if [ -f "$PIDF" ] && kill -0 "$(cat "$PIDF" 2>/dev/null)" 2>/dev/null; then
  echo "  ✓ session activity feed already running"
else
  nohup python3 "$DEST/scripts/bridge.py" tail --from end --backfill 40 \
    >/dev/null 2>&1 &
  echo $! > "$PIDF"
  disown 2>/dev/null || true
  echo "  ✓ session activity feed streaming"
fi

echo
echo "✅ Your shareable link — open on your phone, then Add to Home Screen:"
echo
echo "   ${LINK}"
echo
echo "State file: ${AAPP_STATE}"
echo "Invoke the aapp skill so the agent starts answering messages from the app."
echo
echo "Heads up: to RECEIVE messages you send from the phone, the agent runs a"
echo "background listener (bridge.py wait). Claude Code may block that until you"
echo "allow it — in the session, run /permissions and allow:"
echo "   Bash(python3 ${DEST}/scripts/bridge.py:*)"
echo "This authorizes the message transport only, not the actions the agent takes"
echo "in response. The outbound activity feed already works without it."
