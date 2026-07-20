# World of Claudecraft bot console

An autonomous World of Claudecraft bot fleet with a local web dashboard. The bots can quest, grind, heal, loot, restock, equip upgrades, coordinate as a party, run dungeons, and optionally sell valuable loot.

## Start

```bash
./start.sh
```

Then open [http://localhost:8077](http://localhost:8077).

The dashboard starts without requiring credentials. In the web interface:

1. Choose how many bots to run, from zero through five.
2. Enter a username, password, character name, and class for each enabled bot.
3. Select **Save & start**.

That is the primary and only required startup flow. `npm start` also starts the same console.

The first run installs dependencies if `node_modules` is absent. Configuration is saved in the gitignored `console-config.json` with owner-only permissions. Saved passwords are never returned to the browser; leave a password field blank to keep its saved value.

## Configuration

The dashboard supports all nine classes:

`warrior`, `paladin`, `hunter`, `rogue`, `priest`, `shaman`, `mage`, `warlock`, and `druid`.

The game server defaults to `https://worldofclaudecraft.com` and can be changed in the dashboard. A party is limited to five members, so the console enforces a five-bot maximum.

Optional environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `CONSOLE_PORT` | `8077` | Local dashboard port |
| `DASH_HOST` | `127.0.0.1` | Dashboard bind address |
| `DASH_TOKEN` | random per run | Dashboard WebSocket control token |
| `SERVER_URL` | live realm | Initial server URL for a new configuration |
| `BOT_COUNT` | `0` | Initial bot count for a new configuration |

For safety, the dashboard binds only to loopback by default. Setting `DASH_HOST=0.0.0.0` exposes it to the network and should only be done on a trusted, protected host.

## Live-realm authentication

The live realm protects login with Cloudflare Turnstile. Capture a reusable server token in a real browser before starting a bot account:

```bash
cp .env.bot.example .env.bot
# Set BOT_USER, BOT_PASS, and BOT_CLASS in .env.bot.
npm run get-token
```

Complete Turnstile and select **Log In** in the browser window. The script stores the resulting token in the gitignored `.tokens/` directory with owner-only permissions. Tokens typically remain valid for about one week; repeat this step if authentication begins returning HTTP 403. Use `HEADLESS=1` only if necessary because Turnstile often blocks headless browsers.

## Long-running operation

`./start.sh` runs in the foreground and is suitable for a terminal or service manager. It is the repository's only launcher.

## Local development

```bash
npm install
npm test
```

The console starts with the live-realm URL unless changed in the dashboard or through `SERVER_URL` before the first saved configuration.

Generated game data is committed in `lib/*.generated.mjs`. Refresh it only when the game source changes:

```bash
GAME_SRC=/path/to/world-of-claudecraft npm run gen
npm run gen:check
```

## Project layout

- `start.sh` — primary dashboard-first launcher
- `console.mjs` — configurable zero-to-five bot console
- `fleet.mjs` — fleet bot factory used by the console
- `autobot.mjs` — reusable autonomous bot implementation
- `get-token.mjs` — interactive live-realm authentication helper
- `lib/console_config.mjs` — validated credential and fleet configuration
- `lib/dashboard.mjs` — local HTTP/WebSocket dashboard transport
- `lib/fleet_coordinator.mjs` — party, dungeon, healing, and market coordination
- `lib/brain.mjs` — autonomous combat, questing, survival, and navigation decisions

## Live-realm note

The bots level through normal game actions and do not use development commands on the live realm. Running several coordinated accounts has a larger footprint than running one account; verify the realm's current automation policy before operating a fleet.
