#!/bin/zsh

set -u

ROOT="/Users/zac/Desktop/Beer"
LOG="$ROOT/data/runs/scheduled-beer-batches-2026-04-26.log"
NODE_BIN="/Users/zac/.nvm/versions/node/v24.14.1/bin/node"
PLIST="$HOME/Library/LaunchAgents/com.blackmagic30.beer.apr26-2026.plist"
AREAS="CBD,Brighton,Collingwood,Sandringham,Richmond,Fitzroy,Saint Kilda,South Yarra,Windsor,Brunswick,Saint Kilda East,Prahran,Carlton,Beghntligh"
API_BASE_URL="${BEER_API_BASE_URL:-${PUBLIC_BASE_URL:-https://pintpath.au}}"
RESUME_DELAY_MS="${BEER_RESUME_DELAY_MS:-5000}"
MAX_RESUMES="${BEER_MAX_RESUMES:-1000}"
REPARSE_INTERVAL_SECONDS="${BEER_REPARSE_INTERVAL_SECONDS:-600}"
REPARSE_LIMIT="${BEER_REPARSE_LIMIT:-50}"
AGGRESSIVE_CIRCUIT_BREAKER_THRESHOLD="${BEER_CIRCUIT_BREAKER_THRESHOLD:-12}"
AGGRESSIVE_LOW_SIGNAL_THRESHOLD="${BEER_LOW_SIGNAL_THRESHOLD:-999}"

CARLTON_STATE="./data/runs/priority-areas-carlton-draft-batch.json"
HAPPY_HOUR_CALLBACK_STATE="./data/runs/priority-areas-happy-hour-callbacks.json"

mkdir -p "$ROOT/data/runs"
export PATH="/Users/zac/.nvm/versions/node/v24.14.1/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

WATCHDOG_PID=""

run_hosted_reparse_pass() {
  echo "--- Hosted failed-only reparse pass at $(date '+%Y-%m-%d %H:%M:%S %Z') ---"
  "$NODE_BIN" "$ROOT/dist/scripts/reparse-hosted-call-results.js" \
    --base-url="$API_BASE_URL" \
    --failed-only \
    --limit="$REPARSE_LIMIT"
  local reparse_status=$?
  echo "--- Hosted failed-only reparse exited with status $reparse_status ---"
}

start_watchdog() {
  (
    while true; do
      local now_hm
      now_hm=$(date '+%H%M')

      if [ "$now_hm" -gt 2025 ]; then
        echo "--- Hosted reparse watchdog stopping at $(date '+%Y-%m-%d %H:%M:%S %Z') because call window is closing ---"
        break
      fi

      run_hosted_reparse_pass
      sleep "$REPARSE_INTERVAL_SECONDS"
    done
  ) &
  WATCHDOG_PID=$!
  echo "--- Hosted reparse watchdog started with pid $WATCHDOG_PID ---"
}

cleanup() {
  if [ -n "${WATCHDOG_PID}" ] && kill -0 "${WATCHDOG_PID}" >/dev/null 2>&1; then
    kill "${WATCHDOG_PID}" >/dev/null 2>&1 || true
    wait "${WATCHDOG_PID}" >/dev/null 2>&1 || true
  fi

  launchctl bootout "gui/501" "$PLIST" >/dev/null 2>&1 || true
  rm -f "$PLIST"
}

trap cleanup EXIT

{
  echo "=== Scheduled beer batches started at $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
  echo "Using API base URL: $API_BASE_URL"
  cd "$ROOT" || exit 1
  start_watchdog

  echo "--- Starting Carlton Draft auto-resume batch ---"
  "$NODE_BIN" "$ROOT/dist/scripts/run-batch-until-complete.js" \
    --beer=carlton_draft \
    --suburb="$AREAS" \
    --limit=0 \
    --delay-ms=45000 \
    --circuit-breaker-threshold="$AGGRESSIVE_CIRCUIT_BREAKER_THRESHOLD" \
    --low-signal-threshold="$AGGRESSIVE_LOW_SIGNAL_THRESHOLD" \
    --resume-delay-ms="$RESUME_DELAY_MS" \
    --max-resumes="$MAX_RESUMES" \
    --state-file="$CARLTON_STATE" \
    --base-url="$API_BASE_URL"
  carlton_status=$?
  echo "--- Carlton Draft auto-resume exited with status $carlton_status ---"

  if "$NODE_BIN" --input-type=module -e "import fs from 'fs'; const state = JSON.parse(fs.readFileSync('$CARLTON_STATE','utf8')); process.exit(state.status === 'completed' ? 0 : 1);"; then
    echo "--- Carlton Draft completed; preparing callback-only happy hour batch ---"

    "$NODE_BIN" "$ROOT/dist/scripts/build-callback-batch-from-state.js" \
      --source-state-file="$CARLTON_STATE" \
      --beer=happy_hour \
      --output-state-file="$HAPPY_HOUR_CALLBACK_STATE" \
      --base-url="$API_BASE_URL"

    echo "--- Starting Happy Hour callback auto-resume batch ---"
    "$NODE_BIN" "$ROOT/dist/scripts/run-batch-until-complete.js" \
      --beer=happy_hour \
      --limit=0 \
      --delay-ms=45000 \
      --circuit-breaker-threshold="$AGGRESSIVE_CIRCUIT_BREAKER_THRESHOLD" \
      --low-signal-threshold="$AGGRESSIVE_LOW_SIGNAL_THRESHOLD" \
      --resume-delay-ms="$RESUME_DELAY_MS" \
      --max-resumes="$MAX_RESUMES" \
      --include-called \
      --state-file="$HAPPY_HOUR_CALLBACK_STATE" \
      --base-url="$API_BASE_URL"
    happy_hour_status=$?
    echo "--- Happy Hour callback auto-resume exited with status $happy_hour_status ---"
  else
    echo "--- Carlton Draft did not complete in this run window; skipping happy hour callback batch for now ---"
  fi

  run_hosted_reparse_pass
  echo "=== Scheduled beer batches finished at $(date '+%Y-%m-%d %H:%M:%S %Z') ==="
} >> "$LOG" 2>&1
