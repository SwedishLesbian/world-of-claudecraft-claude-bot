// Regenerates lib/density.generated.mjs — a per-mob PACK-DENSITY threat multiplier, from the game's CAMPS.
//
//   node scripts/gen_bot_density.mjs
//
// WHY: the bot's live pull model (predictPull → brawlLoad → engageCost) judges a pull from the mobs CURRENTLY
// in aggro range. In a TIGHT pack (deepfen_murloc: 8 mobs in radius 15) more wander in mid-fight than the
// snapshot predicts, so engageCost reads low, the bot commits, and a "winnable" single becomes a lethal
// 5-pull. The game's CampDef carries `count` + `radius`, so pack density (count/radius²) is a static, source-
// derived prior for that under-prediction. We project it to a multiplier (>=1, capped) on the target's
// brawlLoad: a dense camp costs more → the bot waits until it out-levels/out-gears it, exactly like the affix
// multiplier. Caution-only (never <1), and only for real packs (count>=4) so a lone rare in a tiny radius
// isn't mislabelled dense.
import { build } from 'esbuild';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = process.env.GAME_SRC || resolve(root, '..', 'world-of-claudecraft');
if (!existsSync(resolve(GAME, 'src/sim'))) { console.error(`[gen] game source not found at ${GAME} — set GAME_SRC=/path/to/world-of-claudecraft`); process.exit(1); }
const tmp = resolve(root, 'lib/_density_bundle.mjs');
const outFile = resolve(root, 'lib/density.generated.mjs');

await build({ entryPoints: [resolve(GAME, 'src/sim/data.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'warning' });
const { CAMPS } = await import(pathToFileURL(tmp).href);
rmSync(tmp, { force: true });

// max pack density per mob, over its camps that are real packs (count>=4).
const PACK_MIN = 4, CAP = 1.6;
const byMob = {};
for (const c of CAMPS) {
  if (!c.count || !c.radius || c.count < PACK_MIN) continue;
  const d = c.count / (c.radius * c.radius);
  byMob[c.mobId] = Math.max(byMob[c.mobId] ?? 0, d);
}
const densities = Object.values(byMob).sort((a, b) => a - b);
const median = densities[Math.floor(densities.length / 2)] || 1;
// multiplier = clamp(density / median, 1, CAP) — median pack is the baseline (x1), tighter packs cost up to CAP.
const out = {};
for (const [mob, d] of Object.entries(byMob)) {
  const mult = Math.min(CAP, Math.max(1, d / median));
  if (mult > 1.01) out[mob] = Math.round(mult * 100) / 100;   // only store the penalised packs; lookup defaults to 1
}
const body = `// AUTO-GENERATED from src/sim/data.ts (CAMPS count/radius) by scripts/gen_bot_density.mjs — pack-density threat\n// multiplier on brawlLoad. baseline = median pack density (x1); only tight packs (> baseline) are listed.\nexport const MOB_DENSITY = ${JSON.stringify(out)};\n`;
writeFileSync(outFile, body);
console.log(`[gen] wrote ${Object.keys(out).length} dense-pack multipliers to lib/density.generated.mjs (median d=${median.toFixed(5)})`);
