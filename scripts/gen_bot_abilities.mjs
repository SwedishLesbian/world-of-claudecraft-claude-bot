// Regenerates lib/abilities.generated.mjs — per-rank ability mana COSTS (from classes.ts) and
// talent COST modifiers (from talents.ts), so the bot bills the SAME mana the server does.
//
//   node scripts/gen_bot_abilities.mjs
//
// The bot can't import the game's TypeScript, so we esbuild-bundle the content modules, read ABILITIES
// (per-rank cost) and TALENTS (per-node costPct), and project only what canCast/abilityCost need. This
// REPLACES the hand-maintained ABILITY_RANKS table that used to live in gamedata.mjs, which silently fell
// behind on rank-scaling abilities (raptor_strike, mark_of_the_wild, thorns, seal, …) and ignored talent
// cost discounts (e.g. ret_benediction −24% Seal/Judgement) → canCast under/over-billed cost, causing
// freeze-casts and lapsed buffs. Same generate-from-source pattern as gen_bot_mobs/gen_bot_items.
import { build } from 'esbuild';
import { writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Game source lives separately now; point at it via GAME_SRC, else the sibling world-of-claudecraft.
const GAME = process.env.GAME_SRC || resolve(root, '..', 'world-of-claudecraft');
if (!existsSync(resolve(GAME, 'src/sim'))) { console.error(`[gen] game source not found at ${GAME} — set GAME_SRC=/path/to/world-of-claudecraft`); process.exit(1); }
const tmpA = resolve(root, 'lib/_abilities_bundle.mjs');
const tmpT = resolve(root, 'lib/_talents_bundle.mjs');
const outFile = resolve(root, 'lib/abilities.generated.mjs');

await build({ entryPoints: [resolve(GAME, 'src/sim/content/classes.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tmpA, logLevel: 'warning' });
const { ABILITIES, CLASSES } = await import(pathToFileURL(tmpA).href);
rmSync(tmpA, { force: true });

await build({ entryPoints: [resolve(GAME, 'src/sim/content/talents.ts')], bundle: true, format: 'esm', platform: 'node', outfile: tmpT, logLevel: 'warning' });
const { TALENTS } = await import(pathToFileURL(tmpT).href);
rmSync(tmpT, { force: true });

// ABILITY_RANKS: for every ability that gains ranks, emit the ascending [{level, cost}] the bot rank-walks
// (abilitiesKnownAt keeps the highest rank whose level <= playerLevel). Base cost stays in the class kit;
// abilityCost falls back to it below the first rank's level.
const ranks = {};
for (const [id, def] of Object.entries(ABILITIES)) {
  if (!def.ranks || !def.ranks.length) continue;
  const rows = def.ranks
    .filter((r) => typeof r.cost === 'number')
    .map((r) => ({ level: r.level, cost: r.cost }))
    .sort((a, b) => a.level - b.level);
  if (rows.length) ranks[id] = rows;
}

// TALENT_COST_MODS: flat nodeId / choiceOptionId / `spec:<id>` → { abilityId: costPctPerRank }, mirrored
// from the talent trees' AbilityModEffect.costPct. The bot sums these over self.tal.alloc (ranks×perRank +
// choices + spec mastery) and applies cost*(1+Σ) exactly like the server's applyTalentMods (classes.ts).
const costMods = {};
const addEff = (key, eff) => {
  for (const am of eff?.ability ?? []) {
    if (am.costPct == null) continue;
    (costMods[key] ??= {})[am.ability] = (costMods[key][am.ability] ?? 0) + am.costPct;
  }
};
for (const ct of Object.values(TALENTS)) {
  if (!ct) continue;
  for (const spec of ct.specs ?? []) addEff('spec:' + spec.id, spec.mastery?.effect);
  for (const node of ct.nodes ?? []) {
    if (node.kind === 'choice') { for (const opt of node.choices ?? []) addEff(opt.id, opt.effect); }
    else addEff(node.id, node.effect);
  }
}

// CLASS_SURVIVAL: per-class INSTANT survival kit, classified from each ability's effects + castTime, so the
// bot can flee-and-survive without ever issuing a cast-time spell (movement cancels casts). Categories:
//   heal      — an instant (castTime 0) heal/HoT to layer while running (rejuv/renew/lay_on_hands)
//   shield    — an instant absorb shield (divine_protection/power_word_shield/ice_barrier)
//   defensive — an instant OFF-GCD self defensive (barkskin/defensive_stance) — damage reduction on the run
//   escape    — a movement-speed buff to outrun the pack (sprint/cheetah instant; ghost_wolf has a 2s cast)
//   root      — a root/CC to lock a chaser (entangling_roots single-target 1.5s; frost_nova instant AoE)
// Each entry carries {id, lv, cost, cast[, hot|aoe]}. Cast-time entries (root/escape) tell the flee loop to
// HOLD a tick so the cast lands; everything else is instant and layers on top of the run.
const effTypes = (a) => (a.effects ?? []).map((e) => e.type);
const effKind = (a, type) => (a.effects ?? []).find((e) => e.type === type)?.kind;
// shape matches the kit's A(id, learnLevel, cost) so the bot's learned()/canCast() work unchanged, plus
// `cast` (castTime — tells the flee loop whether to HOLD for the cast) and `offGcd` (for canCast's GCD bypass).
const mk = (a, extra = {}) => ({ id: a.id, learnLevel: a.learnLevel, cost: a.cost, cast: a.castTime, offGcd: !!a.offGcd, ...extra });
const survival = {};
for (const cls of Object.keys(CLASSES)) {
  const ids = CLASSES[cls].abilities ?? [];
  const abil = ids.map((id) => ABILITIES[id]).filter(Boolean);
  const s = {};
  // heal: prefer an instant HoT (sustained, cheap to layer), else any instant direct heal (e.g. lay_on_hands)
  const hot = abil.find((a) => a.castTime === 0 && effTypes(a).includes('hot'));
  const instHeal = hot ?? abil.find((a) => a.castTime === 0 && effTypes(a).includes('heal'));
  if (instHeal) s.heal = mk(instHeal, { hot: effTypes(instHeal).includes('hot') });
  // shield: an instant absorb
  const shield = abil.find((a) => a.castTime === 0 && effTypes(a).includes('absorb'));
  if (shield) s.shield = mk(shield);
  // defensive: an instant OFF-GCD self-buff damage-reducer (barkskin / defensive_stance), distinct from upkeep armor buffs
  const defensive = abil.find((a) => a.castTime === 0 && a.offGcd && effTypes(a).includes('selfBuff') && a.id !== s.shield?.id
    && /barkskin|defensive_stance|shield_wall|evasion/.test(a.id));
  if (defensive) s.defensive = mk(defensive);
  // escape: a movement-speed self-buff
  const escape = abil.find((a) => effTypes(a).includes('selfBuff') && effKind(a, 'selfBuff') === 'buff_speed');
  if (escape) s.escape = mk(escape);
  // root: a single/AoE root to lock a chaser
  const root = abil.find((a) => effTypes(a).some((t) => t === 'root' || t === 'aoeRoot'));
  if (root) s.root = mk(root, { aoe: effTypes(root).includes('aoeRoot') });
  if (Object.keys(s).length) survival[cls] = s;
}

const body = `// AUTO-GENERATED from src/sim/content/{classes,talents}.ts by scripts/gen_bot_abilities.mjs.\n`
  + `// Per-rank ability mana costs (ABILITY_RANKS) + talent cost modifiers (TALENT_COST_MODS) + per-class instant\n`
  + `// survival kit (CLASS_SURVIVAL) — so the bot bills the SAME mana the server does and flees with instant-only\n`
  + `// survival (a cast-time spell is cancelled by the run). Do not hand-edit.\n`
  + `export const ABILITY_RANKS = ${JSON.stringify(ranks)};\n`
  + `export const TALENT_COST_MODS = ${JSON.stringify(costMods)};\n`
  + `export const CLASS_SURVIVAL = ${JSON.stringify(survival)};\n`;
writeFileSync(outFile, body);
console.log(`[gen] wrote ${Object.keys(ranks).length} ranked abilities + ${Object.keys(costMods).length} talent cost-mod keys + survival kits for ${Object.keys(survival).length} classes to lib/abilities.generated.mjs`);
