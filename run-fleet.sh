#!/usr/bin/env bash
# Run the 5-bot fleet 24/7, restarting on crash. Levels the group, runs dungeons
# by role, farms bosses, sells rare/epic on the World Market. Dashboard at :8099.
#
#   chmod +x run-fleet.sh
#   nohup run-fleet.sh >/dev/null 2>&1 &     # detached
#   open http://localhost:8099                   # watch the fleet
#   pkill -f run-fleet.sh; pkill -f fleet.mjs   # stop
#
# Local fast test (server with ALLOW_DEV_COMMANDS=1):
#   SERVER_URL=http://localhost:8787 FLEET_DEV_LEVEL=10 FLEET_DEV_TP="80,84" run-fleet.sh
set -u
cd "$(dirname "$0")"

# Credentials live in an untracked file — never hardcode them in this tracked script.
set -a; [ -f .env.bot ] && . .env.bot; set +a

export SERVER_URL="${SERVER_URL:-https://worldofclaudecraft.com}"
# dungeon comp: tank + 2 healers + 2 ranged dps (only the tank stands in boss AoE)
export FLEET_CLASSES="${FLEET_CLASSES:-warrior,priest,druid,mage,warlock}"
export FLEET_USER="${FLEET_USER:-sl_fleet}"
export FLEET_DASH_PORT="${FLEET_DASH_PORT:-8099}"
# market-selling is OFF by default (opt-in). Set FLEET_SELL=1 to auto-list rare/epic on the World Market.
export FLEET_SELL="${FLEET_SELL:-}"
if [ -z "${FLEET_PASS:-}" ]; then
  echo "FATAL: FLEET_PASS is unset. Put it in .env.bot (copy .env.bot.example)." >&2
  exit 1
fi

LOG="fleet.log"
LOG_MAX_BYTES=20971520   # 20MB cap, rotated at each (re)start (same scheme as run-forever.sh)
while true; do
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
  fi
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting fleet ($FLEET_CLASSES @ $SERVER_URL) ===" >> "$LOG"
  node fleet.mjs >> "$LOG" 2>&1
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') fleet exited (code $?), restart in 10s ===" >> "$LOG"
  sleep 10
done
