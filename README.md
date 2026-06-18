# World of Claudecraft — autonomous bot + live dashboard

A bot that plays the game by itself: levels via **quests + grinding**, heals and
rests, **heals/buffs other players**, loots, restocks, and survives indefinitely
(auto-reconnect, free graveyard rez, anti-stuck). It speaks the real client wire
protocol (REST auth → WebSocket) and levels legitimately — no dev commands.

Comes with a **web dashboard** (real-time character info + Russian log + on/off
settings) at `http://localhost:8088`.

## Run

```bash
cd ..              # repo root
npm install
node bot/autobot.mjs                 # local server (needs npm run db:up && npm run server)
# live realm:
SERVER_URL=https://worldofclaudecraft.com node bot/autobot.mjs
# then open the dashboard:
open http://localhost:8088
```

24/7 with auto-restart on crash (creds baked into the script):

```bash
nohup bot/run-forever.sh >/dev/null 2>&1 &     # start, survives logout
tail -f bot/live.log                            # watch
pkill -f run-forever.sh; pkill -f bot/autobot.mjs   # stop
```

## Dashboard (http://localhost:8088)

Live, updates ~3×/sec over WebSocket:

- **Персонаж** — HP / мана / опыт bars, золото (g/s/c), позиция, текущая цель.
- **Характеристики** — сила/ловкость/выносл./интеллект/дух/броня, сила атаки, крит.
- **Экипировка** — что надето (оружие/грудь/ноги/ступни) с цветом качества.
- **Инвентарь / лут** — предметы с количеством, цвет по качеству.
- **Квесты** — активные квесты с прогрессом по целям.
- **Сессия** — время, убийств, смертей, квестов, опыт и золото за сессию.
- **Лог (live)** — что бот делает, по-русски.
- **Настройки** (применяются мгновенно):
  - **Режим**: Квесты (квесты+гринд) · Фарм мобов (без квестов) · Пассивный (только защита+помощь).
  - **Подбирать лут** · **Покупать еду/воду** · **Помогать игрокам** · **Надевать апгрейды** · **Медвежья форма** (друид 10+).
  - **Качаться до уровня** (2–20) — бот останавливается на этом уровне.
  - **Пауза** — встать на месте (не выходя из мира).
  - Также показывает: **зону**, **форму** (медведь/кот), **бафы**.

Настройки сохраняются в `bot/settings.json` и переживают перезапуск. `DASH_PORT=9000` меняет порт дашборда (если 8088 занят, бот всё равно играет — просто без дашборда).

## Env

| var | default | meaning |
|---|---|---|
| `SERVER_URL` | `http://localhost:8787` | game server origin |
| `BOT_CLASS` | `druid` | warrior\|paladin\|hunter\|rogue\|priest\|shaman\|mage\|warlock\|druid |
| `BOT_USER`/`BOT_PASS` | auto | account (auto-registers if new) |
| `BOT_NAME` | auto | character name (retries with suffix if taken) |
| `DASH_PORT` | `8088` | dashboard port |

## Layout

```
bot/
  autobot.mjs            # entry: auth, connect, 5Hz loop, dashboard wiring, process guards
  run-forever.sh         # 24/7 crash-restart wrapper
  settings.json          # persisted settings (created/updated from the dashboard)
  lib/
    connection.mjs       # WS+REST transport, reconnect/backoff, snapshot merge
    world.mjs            # perception over the merged snapshot
    brain.mjs            # priority tree (survive→help→loot→quest→grind), all-class combat, bear form, anti-stall
    gamedata.mjs         # merges all zones; derives consumables; per-class kits; zone helpers
    zone1.mjs zone2.mjs zone3.mjs   # per-zone quest/NPC/camp/object data (all 3 zones)
    ru.mjs               # Russian names (mobs/quests/items) + XP table
    items.generated.mjs  # item display metadata, generated from src/sim/data.ts via esbuild
    dashboard.mjs        # local HTTP+WS server + embedded dashboard page
  online_bot.mjs         # v1 simple grinder (kept for reference)
```

## 5-bot fleet — dungeons + World Market (`fleet.mjs`)

A coordinated party of 5 (default **warrior tank · priest + paladin heals · mage + rogue DPS**)
that levels together, runs dungeons by role, farms bosses, and sells rare/epic on the market.

```bash
node bot/fleet.mjs                       # local server; dashboard at http://localhost:8099
SERVER_URL=https://worldofclaudecraft.com node bot/fleet.mjs    # live
nohup bot/run-fleet.sh >/dev/null 2>&1 & # 24/7 (defaults to live)
# fast local test (server with ALLOW_DEV_COMMANDS=1):
FLEET_DEV_LEVEL=10 FLEET_DEV_TP="80,84" node bot/fleet.mjs      # jumps the party to lvl 10 at the crypt door
```

How it works (`lib/fleet_coordinator.mjs`):
- **Party + leash:** the leader (tank) navigates/levels via the normal brain; followers
  leash to the leader, heal the party, and accept the same quests — so they level as a unit.
- **Role combat (smart, not suicidal):** tank pulls one pack + holds threat (Thunder Clap);
  DPS **focus-fire the tank's target** and **back off when they pull aggro**; healers keep the
  lowest member up + pre-shield the tank; casters/healers stay out of the boss's AoE radius;
  anyone critically low retreats. Wipe → free graveyard rez → re-enter.
- **Dungeon plan:** Hollow Crypt (10) → Sunken Bastion (13) → Gravewyrm Sanctum / Korzul (19-20).
  Does each when level-appropriate, levels via quests to bridge gaps, then **farms Korzul** at 20.
- **Money:** loots the boss, then lists rare/epic on the **World Market** at The Merchant
  (`market_list`, 5% cut), per the economy (Korzul ≈ 30-70k copper + epics; market sales are the big earners).
- **Dashboard** (`:8099`): every member's role, level, HP, resource, zone, and live action + group log.

Env: `FLEET_CLASSES` (csv), `FLEET_USER` (account prefix), `FLEET_PASS`, `FLEET_DASH_PORT`,
`SERVER_URL`, and (local-only) `FLEET_DEV_LEVEL`/`FLEET_DEV_TP`.

> On a public realm the fleet must level **from 1 legitimately** (no dev commands) — a long
> haul before it can farm the top boss. 5 coordinated accounts are a bigger footprint than one;
> check the project's rules. The dungeon/role/market logic is identical on a local server, where
> `FLEET_DEV_LEVEL` lets you test boss farming instantly.

## Coverage / notes

- **All 3 zones** (Eastbrook 1-7, Mirefen 6-13, Thornpeak 13-20): 42 quests, 51 camps,
  19 NPCs. The bot quests + grinds from level 1 to the **Качаться до уровня** cap (default 20),
  walking north across zones automatically. Group/dungeon/rare quests (5-man bosses, rare
  spawns) are auto-skipped; the bot never stalls on a quest it can't solo.
- **All 9 classes** supported (per-class combat kits); druid additionally uses **bear form** at 10+.
- **Resilience**: free graveyard rez, anti-stuck pathing, "no kill in 70s → seek easier mobs",
  auto-reconnect, and process-level guards so an unexpected error never kills the bot
  (the `run-forever.sh` loop is the last-resort backstop).
- **Good citizen** on the live realm: skips mobs tapped by others, no PvP/duels, pro-social
  healing. Note the optional `fleet.mjs` runs **5 accounts** (party leveling) — only the solo
  `autobot.mjs` is single-account. Check the project Discord for any bot policy before long runs.
- **Credentials** are never hardcoded: put them in `bot/.env.bot` (copy `bot/.env.bot.example`).
  The dashboard binds to `127.0.0.1` and requires a per-run token (set `DASH_HOST=0.0.0.0` to expose it).
- To regenerate `items.generated.mjs`: `npx esbuild` a tiny entry importing `ITEMS` from
  `src/sim/data.ts` and dump JSON (see git history of this folder).
