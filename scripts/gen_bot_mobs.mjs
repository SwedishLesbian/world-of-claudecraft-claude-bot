// Regenerates lib/mobs.generated.mjs — the REAL per-template aggro data the bot's pull model needs.
//
//   node scripts/gen_bot_mobs.mjs
//
// The bot can't import the game's TypeScript, so we esbuild-bundle src/sim/data.ts, read its MOBS table,
// and project exactly the fields target-selection uses: aggroRadius + family (drive the server's real
// proximity- and social-aggro radii — see sim.ts aggroMob/detect) and the elite/boss/rare flags + level
// band (so "don't solo an elite/boss" and "is this in my level band" become DATA, not hardcoded lists).
import { build } from 'esbuild';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { affixesFromTemplate } from '../lib/affixes.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The game source lives separately. Point at it via GAME_SRC, otherwise use the sibling
// ~/Documents/world-of-claudecraft. Generation is build-time only — the bot RUNS without it.
const GAME = process.env.GAME_SRC || resolve(root, '..', 'world-of-claudecraft');
if (!existsSync(resolve(GAME, 'src/sim'))) { console.error(`[gen] game source not found at ${GAME} — set GAME_SRC=/path/to/world-of-claudecraft`); process.exit(1); }
const tmp = resolve(root, 'lib/_mobs_bundle.mjs');
const outFile = resolve(root, 'lib/mobs.generated.mjs');

await build({ entryPoints: [resolve(GAME, 'src/sim/data.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'warning' });
const { MOBS } = await import(pathToFileURL(tmp).href);
rmSync(tmp, { force: true });

const out = {};
for (const [id, d] of Object.entries(MOBS)) {
  const o = { aggroRadius: d.aggroRadius ?? 12, family: d.family ?? 'beast', minLevel: d.minLevel, maxLevel: d.maxLevel };
  if (d.elite) o.elite = true;
  if (d.boss) o.boss = true;
  if (d.rare) o.rare = true;
  const affixes = affixesFromTemplate(d);   // v0.10.0 on-template combat affixes the winnability model weighs
  if (affixes) o.affixes = affixes;
  out[id] = o;
}
const body = `// AUTO-GENERATED from src/sim/data.ts by scripts/gen_bot_mobs.mjs — per-template aggro data for the\n`
  + `// bot's universal pull model (proximity radius = clamp(4,20, aggroRadius + (mobLv-myLv)*1.5); social\n`
  + `// pull = same-template within the family radius) PLUS the v0.10.0 combat affixes {kind:procChance} the\n`
  + `// winnability model weighs (severity/gating in lib/affixes.mjs). Do not hand-edit.\nexport const MOB_TEMPLATES = ${JSON.stringify(out)};\n`;
writeFileSync(outFile, body);
const n = Object.keys(out).length;
const elites = Object.values(out).filter((d) => d.elite || d.boss).length;
const affixed = Object.values(out).filter((d) => d.affixes).length;
console.log(`[gen] wrote ${n} mob templates to lib/mobs.generated.mjs (${elites} elite/boss, ${affixed} affixed)`);
