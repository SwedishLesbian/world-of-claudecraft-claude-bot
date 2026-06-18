#!/usr/bin/env bash
# Run the autonomous bot 24/7 on the live realm, restarting it if it ever exits.
# The bot itself already auto-reconnects on dropped sockets; this loop only
# covers a full process crash. Logs to bot/live.log.
#
#   chmod +x run-forever.sh
#   nohup ./run-forever.sh >/dev/null 2>&1 &       # detached, survives logout
#   tail -f live.log                               # watch it
#   pkill -f run-forever.sh; pkill -f autobot.mjs  # stop it
set -u
cd "$(dirname "$0")"          # the standalone bot/ folder (run from anywhere)

# Credentials live in an untracked file — never hardcode them in this tracked script.
# Copy .env.bot.example -> .env.bot and fill it in.
set -a; [ -f .env.bot ] && . .env.bot; set +a

export SERVER_URL="${SERVER_URL:-https://worldofclaudecraft.com}"
export BOT_USER="${BOT_USER:-sl_autodruid71}"
export BOT_NAME="${BOT_NAME:-Claudruid}"
export BOT_CLASS="${BOT_CLASS:-druid}"
if [ -z "${BOT_PASS:-}" ]; then
  echo "FATAL: BOT_PASS is unset. Create .env.bot (copy .env.bot.example) with BOT_USER/BOT_PASS." >&2
  exit 1
fi

LOG="live.log"
LOG_MAX_BYTES=20971520   # 20MB — cap the log so a multi-week 24/7 run can't slowly fill the disk.
                         # Rotation is checked at each (re)start (the only safe point: the bot's stdout fd
                         # is O_APPEND-bound to this inode, so renaming mid-run wouldn't take effect until a
                         # fresh process opens a new live.log). Restarts happen periodically (watchdog /
                         # reconnect), so this keeps the log bounded to ~40MB (current + one rotated backup).
while true; do
  if [ -f "$LOG" ] && [ "$(wc -c < "$LOG" 2>/dev/null || echo 0)" -gt "$LOG_MAX_BYTES" ]; then
    mv -f "$LOG" "$LOG.1" 2>/dev/null || true
  fi
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') starting autobot ($BOT_CLASS @ $SERVER_URL) ===" >> "$LOG"
  node autobot.mjs >> "$LOG" 2>&1
  echo "=== $(date '+%Y-%m-%d %H:%M:%S') autobot exited (code $?), restarting in 10s ===" >> "$LOG"
  sleep 10
done
