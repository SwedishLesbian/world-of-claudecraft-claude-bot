#!/usr/bin/env bash
# Primary entry point: starts the dashboard immediately. Configure and launch bots at http://localhost:8077.
set -u
cd "$(dirname "$0")"

set -a
[ -f .env.bot ] && . ./.env.bot
set +a

if [ ! -d node_modules ]; then
  echo "Installing dependencies…"
  npm install || exit 1
fi

export CONSOLE_PORT="${CONSOLE_PORT:-8077}"
echo "Bot console: http://localhost:${CONSOLE_PORT}/"
exec node console.mjs
