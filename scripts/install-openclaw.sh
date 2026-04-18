#!/usr/bin/env bash
# Aquifer — Install drop-in OpenClaw extension
#
# Usage:
#   bash scripts/install-openclaw.sh [OPENCLAW_HOME]
#
# Default OPENCLAW_HOME: $HOME/.openclaw
#
# What it does:
#   1. Creates / overwrites $OPENCLAW_HOME/extensions/aquifer-memory/
#      as a symlink to <this_package>/consumers/openclaw-ext/
#   2. Prints follow-up instructions: set the .env keys, restart the gateway.
#
# Idempotent; safe to re-run.

set -euo pipefail

OPENCLAW_HOME="${1:-${OPENCLAW_HOME:-$HOME/.openclaw}}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
EXT_SRC="$PKG_ROOT/consumers/openclaw-ext"
EXT_DEST="$OPENCLAW_HOME/extensions/aquifer-memory"

if [[ ! -d "$EXT_SRC" ]]; then
  echo "error: $EXT_SRC not found (expected inside the Aquifer package)" >&2
  exit 1
fi

if [[ ! -d "$OPENCLAW_HOME" ]]; then
  echo "error: OPENCLAW_HOME=$OPENCLAW_HOME not found" >&2
  exit 1
fi

mkdir -p "$OPENCLAW_HOME/extensions"

if [[ -L "$EXT_DEST" || -e "$EXT_DEST" ]]; then
  echo "note: $EXT_DEST already exists — replacing"
  rm -rf "$EXT_DEST"
fi

ln -s "$EXT_SRC" "$EXT_DEST"
echo "ok: linked $EXT_DEST → $EXT_SRC"

cat <<'EOF'

Next steps:
  1. Edit $OPENCLAW_HOME/.env and set:
       DATABASE_URL=postgresql://user:pass@host:5432/db
       EMBED_PROVIDER=ollama           # or openai
       AQUIFER_LLM_PROVIDER=minimax    # or openai / openrouter / opencode
       MINIMAX_API_KEY=...             # (or the key for your chosen provider)
       # Optional:
       AQUIFER_SCHEMA=my_namespace
       AQUIFER_PERSONA=/path/to/host-local/persona-module
  2. Restart OpenClaw:
       systemctl --user restart openclaw-gateway
  3. Verify:
       journalctl --user -u openclaw-gateway -f | grep aquifer-memory
EOF
