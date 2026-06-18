#!/usr/bin/env bash
# Unified console 24/7: the solo druid + the fleet under ONE dashboard (:8077), restarting on crash.
#   nohup run-console.sh >/dev/null 2>&1 &     # detached
#   open http://localhost:8077                     # one UI for all bots
#   pkill -f run-console.sh; pkill -f console.mjs
# NOTE: this REPLACES run-forever.sh + run-fleet.sh (same accounts) — don't run them alongside it.
set -u
cd "$(dirname "$0")"
# credentials from the untracked file (never hardcode)
set -a; [ -f .env.bot ] && . .env.bot; set +a

export SERVER_URL="${SERVER_URL:-https://worldofclaudecraft.com}"
export CONSOLE_PORT="${CONSOLE_PORT:-8077}"
export FLEET_CLASSES="${FLEET_CLASSES:-warrior,priest,druid,mage,warlock}"
export FLEET_SELL="${FLEET_SELL:-}"     # set =1 to enable market selling
if [ -z "${BOT_PASS:-}" ] || [ -z "${FLEET_PASS:-}" ]; then
  echo "FATAL: BOT_PASS and FLEET_PASS must be set in .env.bot (copy .env.bot.example)." >&2
  exit 1
fi

LOG="console.log"
LOG_MAX_BYTES=20971520   # 20MB cap, rotated at each (re)start
while true; do
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
  fi
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting console ($SERVER_URL) ===" >> "$LOG"
  node console.mjs >> "$LOG" 2>&1
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') console exited (code $?), restart in 10s ===" >> "$LOG"
  sleep 10
done
