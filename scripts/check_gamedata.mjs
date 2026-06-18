// CONTENT-STALENESS GUARD. The committed lib/*.generated.mjs (and the hand-mirrored aggro/flee constants in
// lib/world.mjs) are a snapshot of the game's src/sim at a known commit. The game updates often; without a
// guard a drifted checkout means the bot plays on stale mobs/items/abilities/constants and nobody notices.
//
//   node scripts/check_gamedata.mjs          # CHECK: exit 1 if the live game source no longer matches the stamp
//   node scripts/check_gamedata.mjs --write   # STAMP: record the current game fingerprint (run by `npm run gen`)
//
// CHECK is intentionally lenient about ABSENCE: a standalone runtime (no game source) prints a skip and exits
// 0, so `npm test` stays green on a machine that only has the committed generated data. It only FAILS on a
// present-but-different source — the actual drift we want to catch before it ships.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gameHash, resolveGameRoot } from './gamedata_hash.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stampFile = resolve(root, 'lib/gamedata.version.json');
const write = process.argv.includes('--write');
const gameRoot = resolveGameRoot(root);

const live = gameHash(gameRoot);

if (write) {
  if (!live) { console.error(`[gamedata] cannot stamp — game source not found at ${gameRoot} (set GAME_SRC)`); process.exit(1); }
  const stamp = { hash: live.hash, files: live.files, gameCommit: live.gameCommit, source: 'src/sim/**/*.ts' };
  writeFileSync(stampFile, JSON.stringify(stamp, null, 2) + '\n');
  console.log(`[gamedata] stamped ${live.files} files @ game ${live.gameCommit ?? '(no git)'} → lib/gamedata.version.json`);
  process.exit(0);
}

// CHECK mode
if (!existsSync(stampFile)) { console.error('[gamedata] no lib/gamedata.version.json — run `npm run gen` to stamp'); process.exit(1); }
const stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
if (!live) { console.log(`[gamedata] game source absent (${gameRoot}) — skipping freshness check (runtime uses committed data)`); process.exit(0); }
if (live.hash === stamp.hash) { console.log(`[gamedata] up to date — ${live.files} files @ game ${live.gameCommit ?? '(no git)'}`); process.exit(0); }

console.error('[gamedata] ✗ STALE: the committed bot data no longer matches the live game source.');
console.error(`  stamped: ${stamp.files} files, hash ${stamp.hash.slice(0, 12)}…, game ${stamp.gameCommit ?? '?'}`);
console.error(`  live:    ${live.files} files, hash ${live.hash.slice(0, 12)}…, game ${live.gameCommit ?? '?'}`);
console.error('  → re-audit the aggro/flee constants in lib/world.mjs, then run `npm run gen` to resync + restamp.');
process.exit(1);
