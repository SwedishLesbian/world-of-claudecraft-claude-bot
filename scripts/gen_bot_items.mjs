// Regenerates lib/items.generated.mjs — item display + decision metadata for the bot.
//
//   node scripts/gen_bot_items.mjs
//
// The bot can't import the game's TypeScript directly, so we esbuild-bundle src/sim/data.ts, read its
// ITEMS table, and project the fields the bot actually uses. The previous generation DROPPED the
// `weapon` {min,max,speed} field, which silently disabled gearScore's weapon-DPS term (weapons were
// ranked by quality only — a bear druid would keep a low-DPS caster staff). This projection keeps it,
// plus buyValue/potion/food fields for vendor + consumable logic.
import { build } from 'esbuild';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Game source lives separately now; point at it via GAME_SRC, else the sibling world-of-claudecraft.
const GAME = process.env.GAME_SRC || resolve(root, '..', 'world-of-claudecraft');
if (!existsSync(resolve(GAME, 'src/sim'))) { console.error(`[gen] game source not found at ${GAME} — set GAME_SRC=/path/to/world-of-claudecraft`); process.exit(1); }
const tmp = resolve(root, 'lib/_items_bundle.mjs');
const outFile = resolve(root, 'lib/items.generated.mjs');

await build({ entryPoints: [resolve(GAME, 'src/sim/data.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tmp, logLevel: 'warning' });
const { ITEMS } = await import(pathToFileURL(tmp).href);
rmSync(tmp, { force: true });

const pick = (d) => {
  const o = { name: d.name, kind: d.kind, quality: d.quality ?? 'common', sellValue: d.sellValue };
  if (d.slot) o.slot = d.slot;
  if (d.weapon) o.weapon = d.weapon;                       // {min,max,speed[,dagger]} — REQUIRED for weapon DPS scoring
  if (d.stats) o.stats = d.stats;
  if (d.requiredClass) o.requiredClass = d.requiredClass;
  if (d.buyValue != null) o.buyValue = d.buyValue;          // vendor sell price (for VENDOR_WEAPON/buyGear)
  if (d.foodHp != null) o.foodHp = d.foodHp;
  if (d.drinkMana != null) o.drinkMana = d.drinkMana;
  if (d.potionHp != null) o.potionHp = d.potionHp;
  if (d.potionMana != null) o.potionMana = d.potionMana;
  return o;
};

const out = {};
for (const [id, d] of Object.entries(ITEMS)) out[id] = pick(d);
const body = `// AUTO-GENERATED from src/sim/data.ts by scripts/gen_bot_items.mjs — item display + decision metadata.\nexport const ITEMS = ${JSON.stringify(out)};\n`;
writeFileSync(outFile, body);
const weaponWithDps = Object.values(out).filter((d) => d.kind === 'weapon' && d.weapon).length;
console.log(`[gen] wrote ${Object.keys(out).length} items to lib/items.generated.mjs (${weaponWithDps} weapons carry DPS)`);
