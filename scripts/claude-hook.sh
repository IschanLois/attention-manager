#!/usr/bin/env bash
# Claude Code hook forwarder: reads the hook payload from stdin and POSTs it to
# the local attention-manager receiver. Always exits 0 so Claude Code is never
# blocked, and never logs the payload.
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECEIVER_URL="${ATTENTION_RECEIVER_URL:-http://127.0.0.1:${RECEIVER_PORT:-4318}}"
TOKEN_FILE="${ATTENTION_TOKEN_FILE:-$SCRIPT_DIR/../data/ingest-token}"
MAX_TIME="${ATTENTION_HOOK_TIMEOUT:-2}"

TOKEN=""
if [ -r "$TOKEN_FILE" ]; then
  TOKEN="$(head -c 256 "$TOKEN_FILE" | tr -d '\r\n')"
fi

if command -v curl >/dev/null 2>&1; then
  curl --silent --show-error --output /dev/null \
    --max-time "$MAX_TIME" --connect-timeout 1 \
    --header "content-type: application/json" \
    --header "x-attention-token: $TOKEN" \
    --data-binary @- \
    "$RECEIVER_URL/api/events" >/dev/null 2>&1 || true
else
  ATTENTION_RECEIVER_URL="$RECEIVER_URL" ATTENTION_TOKEN="$TOKEN" ATTENTION_HOOK_TIMEOUT="$MAX_TIME" \
    node "$SCRIPT_DIR/claude-hook-fallback.mjs" >/dev/null 2>&1 || true
fi

exit 0
