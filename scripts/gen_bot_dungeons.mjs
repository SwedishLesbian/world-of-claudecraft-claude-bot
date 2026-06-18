// Regenerates lib/dungeons.generated.mjs — the PARTY-dungeon door keep-out list, from the game's DUNGEONS.
//
//   node scripts/gen_bot_dungeons.mjs
//
// WHY: the solo bot must not wander into a party dungeon (the server warps you in within ~2yd of a door, and
// some doors sit on a quest yard). The doors were hand-listed in gamedata.mjs and had drifted — the list had
// 3 of the 4 party dungeons, MISSING drowned_temple, so the bot had no keep-out there. Project the doorPos of
// every dungeon with suggestedPlayers > 1 (party content) straight from DUNGEONS; the solo nythraxis_crypt is
// excluded by data (the bot may legitimately approach it), and any party dungeon a content patch adds is
// picked up by regenerating.
import { build } from 'esbuild';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = process.env.GAME_SRC || resolve(root, '..', 'world-of-claudecraft');
if (!existsSync(resolve(GAME, 'src/sim'))) { console.error(`[gen] game source not found at ${GAME} — set GAME_SRC=/path/to/world-of-claudecraft`); process.exit(1); }
const tmp = resolve(root, 'lib/_dungeons_bundle.mjs');
const outFile = resolve(root, 'lib/dungeons.generated.mjs');

await build({ entryPoints: [resolve(GAME, 'src/sim/data.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'warning' });
const { DUNGEONS } = await import(pathToFileURL(tmp).href);
rmSync(tmp, { force: true });

// keep-out = every PARTY dungeon's door (suggestedPlayers > 1); solo dungeons are excluded.
const doors = [];
for (const d of Object.values(DUNGEONS)) {
  if ((d.suggestedPlayers ?? 1) > 1 && d.doorPos) doors.push({ x: d.doorPos.x, z: d.doorPos.z });
}
const body = `// AUTO-GENERATED from src/sim/data.ts (DUNGEONS) by scripts/gen_bot_dungeons.mjs — party-dungeon door keep-out.\nexport const PARTY_DUNGEON_DOORS = ${JSON.stringify(doors)};\n`;
writeFileSync(outFile, body);
console.log(`[gen] wrote ${doors.length} party-dungeon doors to lib/dungeons.generated.mjs`);
