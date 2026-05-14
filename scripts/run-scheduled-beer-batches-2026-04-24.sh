#!/bin/zsh

set -u

ROOT="/Users/zac/Desktop/Beer"
LOG="$ROOT/data/runs/scheduled-beer-batches-2026-04-24.log"
NPM_BIN="/Users/zac/.nvm/versions/node/v24.14.1/bin/npm"
NODE_BIN="/Users/zac/.nvm/versions/node/v24.14.1/bin/node"
PLIST="$HOME/Library/LaunchAgents/com.blackmagic30.beer.apr24-2026.plist"
AREAS="CBD,Brighton,Collingwood,Sandringham,Richmond,Fitzroy,Saint Kilda,South Yarra,Windsor,Brunswick,Saint Kilda East,Prahran,Carlton,Beghntligh"
API_BASE_URL="${BEER_API_BASE_URL:-https://beer-production-aad4.up.railway.app}"

mkdir -p "$ROOT/data/runs"
export PATH="/Users/zac/.nvm/versions/node/v24.14.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

{
  echo "=== Scheduled beer batches started at $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  cd "$ROOT" || exit 1
  echo "Using API base URL: $API_BASE_URL"

  echo "--- Starting Carlton Draft batch ---"
  "$NODE_BIN" "$ROOT/dist/scripts/batch-call-venues.js" --beer=carlton_draft --suburb="$AREAS" --limit=0 --delay-ms=45000 --state-file=./data/runs/priority-areas-carlton-draft-batch.json --base-url="$API_BASE_URL"
  carlton_status=$?
  echo "--- Carlton Draft batch exited with status $carlton_status ---"

  echo "--- Starting Stone & Wood batch ---"
  "$NODE_BIN" "$ROOT/dist/scripts/batch-call-venues.js" --beer=stone_and_wood --suburb="$AREAS" --limit=0 --delay-ms=45000 --state-file=./data/runs/priority-areas-stone-and-wood-batch.json --base-url="$API_BASE_URL"
  stone_status=$?
  echo "--- Stone & Wood batch exited with status $stone_status ---"

  echo "--- Starting Guinness batch ---"
  "$NODE_BIN" "$ROOT/dist/scripts/batch-call-venues.js" --beer=guinness --suburb="$AREAS" --limit=0 --delay-ms=45000 --state-file=./data/runs/priority-areas-guinness-batch.json --base-url="$API_BASE_URL"
  guinness_status=$?
  echo "--- Guinness batch exited with status $guinness_status ---"

  echo "=== Scheduled beer batches finished at $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
} >> "$LOG" 2>&1

launchctl bootout "gui/501" "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
