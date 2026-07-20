// Regenerates lib/vendors.generated.mjs — which NPC sells what, projected from the game's NpcDef.vendorItems.
//
//   node scripts/gen_bot_vendors.mjs
//
// The bot used to HARDCODE per-vendor stock lists (VENDOR_STOCK in brain.mjs), which silently missed
// whole vendors (zone1 smith_haldren, zone3 armorer_hode) and goes stale on every game content patch.
// This pulls the truth straight from the game's NPCS table so buyGear/needsVendorGear are data-driven:
// regenerate and the bot picks up new vendors / restocked items with no code change.
import { build } from 'esbuild';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAME = process.env.GAME_SRC || resolve(root, '..', 'world-of-claudecraft');
if (!existsSync(resolve(GAME, 'src/sim'))) { console.error(`[gen] game source not found at ${GAME} — set GAME_SRC=/path/to/world-of-claudecraft`); process.exit(1); }
const tmp = resolve(root, 'lib/_vendors_bundle.mjs');
const outFile = resolve(root, 'lib/vendors.generated.mjs');

await build({ entryPoints: [resolve(GAME, 'src/sim/data.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'warning' });
const { NPCS } = await import(pathToFileURL(tmp).href);
rmSync(tmp, { force: true });

// Project every NPC that actually sells something: id -> { name, pos:{x,z}, items:[...] }. Position lets
// the bot ROUTE to a gear vendor that isn't the zone food vendor (smith_haldren, armorer_hode).
const out = {};
for (const [id, d] of Object.entries(NPCS)) {
  if (!d.vendorItems || !d.vendorItems.length) continue;
  out[id] = { name: d.name ?? id, pos: { x: d.pos?.x ?? 0, z: d.pos?.z ?? 0 }, items: [...d.vendorItems] };
}
const body = `// AUTO-GENERATED from src/sim/data.ts (NPCS.vendorItems) by scripts/gen_bot_vendors.mjs — per-vendor stock + position.\nexport const VENDORS = ${JSON.stringify(out)};\n`;
writeFileSync(outFile, body);
console.log(`[gen] wrote ${Object.keys(out).length} vendors to lib/vendors.generated.mjs`);
