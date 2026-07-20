#!/usr/bin/env bash
# Compatibility wrapper. Use ./start.sh for the primary dashboard-first experience.
#   nohup run-console.sh >/dev/null 2>&1 &     # detached
#   open http://localhost:8077                     # one UI for all bots
#   pkill -f run-console.sh; pkill -f console.mjs
# NOTE: this REPLACES run-forever.sh + run-fleet.sh (same accounts) — don't run them alongside it.
set -u
cd "$(dirname "$0")"
# credentials from the untracked file (never hardcode)
set -a; [ -f .env.bot ] && . .env.bot; set +a

export CONSOLE_PORT="${CONSOLE_PORT:-8077}"

LOG="console.log"
LOG_MAX_BYTES=20971520   # 20MB cap, rotated at each (re)start
while true; do
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
  fi
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting console ($SERVER_URL) ===" >> "$LOG"
  ./start.sh >> "$LOG" 2>&1
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') console exited (code $?), restart in 10s ===" >> "$LOG"
  sleep 10
done
