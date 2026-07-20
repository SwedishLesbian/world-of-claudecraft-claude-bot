// Aggregates all zones + derives consumables + class kits + helpers.
import { ZONE1 } from './zone1.mjs';
import { ZONE2 } from './zone2.mjs';
import { ZONE3 } from './zone3.mjs';
import { ITEMS } from './items.generated.mjs';
import { MOB_TEMPLATES } from './mobs.generated.mjs';
import { ABILITY_RANKS, TALENT_COST_MODS } from './abilities.generated.mjs';
import { PARTY_DUNGEON_DOORS } from './dungeons.generated.mjs';

const ZS = [ZONE1, ZONE2, ZONE3];

export const ZONES = ZS.map((z) => ({ id: z.id, name: z.name, levelRange: z.levelRange, zRange: z.zRange, hub: z.hub, graveyard: z.graveyard }));
export const NPCS = Object.assign({}, ...ZS.map((z) => z.npcs));
export const QUESTS = Object.assign({}, ...ZS.map((z) => z.quests));
export const QUEST_ORDER = ZS.flatMap((z) => z.questOrder);
export const GROUND = Object.assign({}, ...ZS.map((z) => z.ground));
export const ITEM_SOURCE = Object.assign({}, ...ZS.map((z) => z.itemSource));

// ---- per-template data (from the universal mob table, src/sim/data.ts) --------------------------
// A leveling bot does not solo elites/bosses/rares — skip them by DATA, not a hand-kept avoid list.
export const isEliteTid = (tid) => { const t = MOB_TEMPLATES[tid]; return !!(t && (t.elite || t.boss || t.rare)); };
// the template's top level — used to gate quests/patrol camps that out-level us (universal, no per-camp table).
export const mobMaxLevel = (tid) => MOB_TEMPLATES[tid]?.maxLevel ?? 0;
export const FOOD_VENDORS = ZS.map((z) => z.foodVendor);

export const CAMP_LIST = ZS.flatMap((z) => z.camps);
export const CAMPS = {}; // mobId -> primary camp center {x,z}
for (const c of CAMP_LIST) if (!CAMPS[c.mobId]) CAMPS[c.mobId] = { x: c.x, z: c.z };

// XP-zero band (mirrors src/sim/types.ts zeroDiff): a mob this many levels (or more) below the
// player yields ZERO xp. We use it so the grinder NEVER farms grey mobs (pure wasted time) and so
// it stays on level-appropriate targets — emergent from the game's own xp curve, no per-mob rules.
export function zeroDiff(level) { return level <= 7 ? 5 : level <= 9 ? 6 : level <= 15 ? 7 : 8; }
// lowest mob level that still yields >0 xp for a player at `level`. (e.g. lvl14 -> 8: a lvl7 mob is grey.)
export function xpFloorLevel(level) { return level - zeroDiff(level) + 1; }

// consumables derived from item metadata (covers every zone automatically)
export const FOOD = new Set(), DRINK = new Set(), HEAL_POT = new Set(), MANA_POT = new Set();
for (const [id, d] of Object.entries(ITEMS)) {
  if (d.kind === 'food') FOOD.add(id);
  else if (d.kind === 'drink') DRINK.add(id);
  else if (d.kind === 'potion') { if (/mana/i.test(id) || /mana/i.test(d.name || '')) MANA_POT.add(id); else HEAL_POT.add(id); }
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
export const zoneAt = (z) => ZONES.find((zz) => z >= zz.zRange[0] && z < zz.zRange[1]) ?? ZONES[ZONES.length - 1];
export const foodVendorNear = (pos) => FOOD_VENDORS.slice().sort((a, b) => dist(pos, a) - dist(pos, b))[0];

// ---- zone progression gate ----------------------------------------------
// Now that nav can cross the ridge passes, keep the bot from walking north into a
// zone it's under-levelled for (zone2 entry mobs are lvl7-8, zone3 ~lvl13-15). Only
// enter a higher zone once self.lv >= that zone's minLevel + buffer.
export const ZONE_GATE_BUFFER = 1;
export const zoneIdxAtZ = (z) => { const i = ZONES.findIndex((zz) => z >= zz.zRange[0] && z < zz.zRange[1]); return i < 0 ? ZONES.length - 1 : i; };
export const maxZoneIdx = (lv) => { let m = 0; for (let i = 1; i < ZONES.length; i++) { if ((lv ?? 1) >= ZONES[i].levelRange[0] + ZONE_GATE_BUFFER) m = i; else break; } return m; };
export const zoneAllowed = (lv, z) => zoneIdxAtZ(z) <= maxZoneIdx(lv);

// Dungeon-door auto-teleport keep-out. The server WARPS a player into the instance the moment they
// walk within 2yd of a dungeon door (sim.ts DOOR_TRIGGER_RADIUS=2, no interact needed). Doors sit
// ON quest yards — hollow_crypt's door (80,90) is 12yd from the restless_bones camp (80,78) — so
// chasing a mob can suck the bot in mid-fight. The bot steers clear of every PARTY dungeon's door.
// DATA-DRIVEN from the game's DUNGEONS (suggestedPlayers>1) via gen_bot_dungeons.mjs — the old hand-list
// had drifted and MISSED drowned_temple (-70,792), leaving that party door with no keep-out.
export const DUNGEON_DOORS = PARTY_DUNGEON_DOORS;

// only grind camps we're at least the entry level for (was lvl+1, which let a lvl7 bot
// wander into lvl8 deepfen/widow camps and die); still skip trivially-low camps.
export const campsForLevel = (lvl) => CAMP_LIST.filter((c) => !c.dangerous && c.minLevel <= lvl && c.maxLevel >= lvl - 3 && zoneAllowed(lvl, c.z));

// ---- per-class kits (from src/sim/content/classes.ts) -------------------
// nukes/dots: offensive (cast in priority order). buffSelf: friendly:false buffs.
// selfHeal / healOthers: friendly heals. buffOthers: friendly buffs for allies.
// A(id, learnLevel, cost[, aura]) — `aura` is the aura.kind a buff applies, so the brain can
// detect whether it's still active (self.auras) and re-cast only when it has actually lapsed.
const A = (id, learnLevel, cost, aura) => (aura ? { id, learnLevel, cost, aura } : { id, learnLevel, cost });
export const CLASS_KITS = {
  warrior: { resource: 'rage', melee: true,
    nukes: [A('execute', 14, 15), A('overpower', 10, 5), A('heroic_strike', 1, 15)], dots: [A('rend', 4, 10)],
    buffSelf: [A('battle_shout', 1, 10, 'buff_ap')], selfHeal: null, healOthers: null, buffOthers: [] },
  paladin: { resource: 'mana', melee: true, // plate bruiser: free auto-attack + Seal Holy dmg; mana funds Judgement/Exorcism/heals
    nukes: [A('judgement', 4, 30), A('exorcism', 14, 55)], dots: [],
    buffSelf: [A('devotion_aura', 1, 0, 'buff_armor')], seal: 'seal_of_righteousness', // seal is pulled-on + maintained in combat (paladinRotate), not idle-upkept (no mana drain between pulls)
    selfHeal: A('holy_light', 1, 35), fastHeal: A('flash_of_light', 12, 35), bigHeal: A('lay_on_hands', 10, 0), // big out-of-combat heal / fast in-combat heal / big FLAT emergency heal (250→600, free, 10-min cd)
    bubble: { id: 'divine_protection', learnLevel: 6, cost: 15, offGcd: true }, aoe: A('consecration', 18, 60), stun: A('hammer_of_justice', 8, 30), // absorb shield (off-GCD → can fire mid-GCD) / pack AoE / stun a 2nd attacker
    healOthers: A('holy_light', 1, 35), buffOthers: [A('blessing_of_might', 4, 25, 'buff_ap')] },
  hunter: { resource: 'mana', melee: false, range: 24,
    nukes: [A('arcane_shot', 6, 25), A('raptor_strike', 1, 15)], dots: [A('serpent_sting', 4, 15)],
    buffSelf: [A('aspect_of_the_hawk', 4, 20, 'buff_ap')], selfHeal: null, healOthers: null, buffOthers: [],
    escape: A('aspect_of_the_cheetah', 14, 20) }, // +30% speed to break a chase (the only way a base-speed class outruns a faster mob)
  rogue: { resource: 'energy', melee: true,
    nukes: [A('eviscerate', 1, 35), A('sinister_strike', 1, 45)], dots: [],
    buffSelf: [], selfHeal: null, healOthers: null, buffOthers: [],
    escape: A('sprint', 10, 0) }, // +70% speed, 5-min cd (canCast gates the cd)
  priest: { resource: 'mana', melee: false, range: 24,
    nukes: [A('mind_blast', 10, 50), A('smite', 1, 20)], dots: [A('shadow_word_pain', 4, 25)],
    buffSelf: [], selfHeal: A('flash_heal', 20, 75), selfHealEarly: A('lesser_heal', 1, 30),
    healOthers: A('lesser_heal', 1, 30), buffOthers: [A('power_word_fortitude', 1, 30, 'buff_sta'), A('power_word_shield', 6, 45, 'shield')] },
  shaman: { resource: 'mana', melee: false, range: 24,
    nukes: [A('earth_shock', 4, 30), A('lightning_bolt', 1, 15)], dots: [A('flame_shock', 10, 35)],
    buffSelf: [A('rockbiter_weapon', 1, 20, 'imbue'), A('lightning_shield', 8, 25, 'thorns')], selfHeal: A('healing_wave', 1, 25),
    healOthers: A('healing_wave', 1, 25), buffOthers: [], escape: A('ghost_wolf', 16, 35) }, // +40% speed (2s cast, cancels on move → flee holds for it to land)
  mage: { resource: 'mana', melee: false, range: 24,
    nukes: [A('fire_blast', 6, 40), A('fireball', 1, 30), A('frostbolt', 4, 25)], dots: [],
    buffSelf: [A('frost_armor', 1, 20, 'buff_armor'), A('arcane_intellect', 1, 25, 'buff_int')], selfHeal: null, healOthers: null, buffOthers: [] },
  warlock: { resource: 'mana', melee: false, range: 24,
    nukes: [A('shadow_bolt', 1, 25)], dots: [A('immolate', 1, 25), A('corruption', 4, 35), A('curse_of_agony', 8, 25)],
    buffSelf: [A('demon_skin', 1, 20, 'buff_armor')], selfHeal: A('drain_life', 10, 35), healOthers: null, buffOthers: [] },
  druid: { resource: 'mana', melee: true, // fights in close; uses caster nukes + optional bear
    nukes: [A('wrath', 1, 20), A('starfire', 18, 80)], dots: [A('moonfire', 4, 25)],
    buffSelf: [], selfHeal: A('rejuvenation', 4, 25), healOthers: A('healing_touch', 1, 25), healOthersHot: A('rejuvenation', 4, 25),
    buffOthers: [A('mark_of_the_wild', 1, 20, 'buff_armor'), A('thorns', 6, 20, 'thorns')],
    bear: { form: A('bear_form', 10, 30), maul: A('maul', 10, 15), swipe: A('swipe', 16, 20) },
    roots: A('entangling_roots', 8, 35), defensive: A('barkskin', 16, 30) },
};

export const meleeRangeFor = (cls) => (CLASS_KITS[cls]?.melee ? 4 : (CLASS_KITS[cls]?.range ?? 24));

// COMBAT CAPACITY — how big a pack a class will BRAWL (fight at once) rather than single-pull, derived from
// its kit. Death is near-free, so a fled/refused WINNABLE pull is just lost XP — the bot should kill, not
// over-flee. A melee front-liner (plate/leather, takes hits) brawls a 2-pull; a self-heal sustains a 2-pull
// even at range; a pure ranged squishy single-pulls (it kites, can't tank). Used to gate pull acceptance
// (engage targets with up to cap-1 joiners), the flee trigger (flee only when aggro EXCEEDS cap), and resting.
export function combatCap(cls) {
  const k = CLASS_KITS[cls]; if (!k) return 1;
  let cap = k.melee ? 2 : 1;                                             // melee brawls 2; ranged single-pulls
  if (k.selfHeal || k.bigHeal || k.fastHeal) cap = Math.max(cap, 2);     // a self-heal sustains a 2-pull
  return cap;
}

// ---- v0.6 TALENTS ---------------------------------------------------------
// The game added a talent system (v0.6): 1 point per level from level 10, capped at level 20 → 11 points.
// Wire protocol (server/game.ts): out-of-combat only, ONE command sets spec+ranks atomically —
//   { cmd:'applyTalents', alloc:{ spec, ranks:{nodeId:rank}, choices:{choiceNodeId:optionId} } }
// Server validates against the level budget + tree gates; a `choice` node counts as 1 point and must
// appear in BOTH ranks (rank 1) and choices. Current state rides the snapshot as self.tal.alloc.
// Talent state is read back from self.tal; budget = talentPointsAtLevel(level).

export const talentPointsAtLevel = (lv) => Math.max(0, Math.min(lv ?? 1, 20) - 9);
export const pointsSpentIn = (alloc) => { let n = 0; const r = alloc?.ranks ?? {}; for (const k in r) n += r[k]; return n; };

// DRUID feral (bear) build — the strongest pick for a solo grinder: survivability vs dense packs +
// low downtime. Ordered one nodeId per point (gates respected cumulatively): armor → bear-attack dmg
// (Maul/Swipe) → dodge → +14% max HP → +sta/ap/threat → cheaper Maul. (Ids verified vs talents_classic.ts.)
export const DRUID_FERAL_STEPS = [
  'feral_thick_hide', 'feral_thick_hide', 'feral_thick_hide',     // rows0: +15% armor
  'feral_brutal_impact', 'feral_brutal_impact',                   // row1 (gate2, req thick_hide): +20% Maul & Swipe
  'feral_feline_swiftness', 'feral_feline_swiftness',             // row1 (gate2): +4% dodge, +4 agi
  'feral_choice',                                                 // row2 (gate5): Survival Instincts +14% max HP
  'feral_heart_wild', 'feral_heart_wild',                         // row3 (gate8, req choice): +10% sta/ap/threat
  'feral_ferocity',                                               // row0: -6% Maul/Claw cost (11th point @lv20)
];
export const DRUID_FERAL_CHOICES = { feral_choice: 'feral_choice_survival' };
// Display names for the dashboard talent panel — node id -> {label, max rank}.
export const TALENT_INFO = {
  feral_thick_hide:       { label: 'Thick Hide (+armor)', max: 3 },
  feral_brutal_impact:    { label: 'Brutal Impact (Maul/Swipe)', max: 2 },
  feral_feline_swiftness: { label: 'Feline Swiftness (+dodge)', max: 2 },
  feral_choice:           { label: 'Beast Instinct', max: 1 },
  feral_heart_wild:       { label: 'Heart of the Wild', max: 2 },
  feral_ferocity:         { label: 'Ferocity (cheaper Maul)', max: 3 },
  // paladin (retribution)
  ret_benediction:        { label: 'Benediction (cheaper Seal/Judgement)', max: 3 },
  ret_seal_command:       { label: 'Seal of Command (+seal damage)', max: 2 },
  ret_imp_judgement:      { label: 'Improved Judgement (cooldown/damage)', max: 2 },
  ret_choice:             { label: 'Retribution Path', max: 1 },
  ret_crusader_strikes:   { label: 'Crusader Strikes (+damage)', max: 2 },
  ret_conviction:         { label: 'Conviction (+critical strike)', max: 3 },
};
export const TALENT_CHOICE_NAMES = {
  feral_choice_survival: 'Survival Instinct (+14% HP)', feral_choice_bear: 'Dire Bear (+armor)', feral_choice_cat: 'Predatory Strikes (+damage)',
  ret_choice_pursuit: 'Pursuit of Justice (+attack power, +dodge)', ret_choice_sanctity: 'Sanctity Aura (+spell damage)', ret_choice_vengeance: 'Vengeance (+critical strike)',
};
export const SPEC_NAMES = { feral: 'Feral (bear)', balance: 'Balance', restoration: 'Restoration', retribution: 'Retribution (DPS)', holy: 'Holy (healer)', protection: 'Protection (tank)' };
// Build the alloc object for a given point budget (first `budget` steps of the ordered build).
export function druidTalentAlloc(budget) {
  const ranks = {}, choices = {};
  const n = Math.max(0, Math.min(budget, DRUID_FERAL_STEPS.length));
  for (let i = 0; i < n; i++) {
    const id = DRUID_FERAL_STEPS[i];
    ranks[id] = (ranks[id] ?? 0) + 1;
    if (DRUID_FERAL_CHOICES[id]) choices[id] = DRUID_FERAL_CHOICES[id];
  }
  return { spec: 'feral', ranks, choices };
}
// PALADIN Retribution build — the fastest-leveling pick for a plate bruiser: cheaper Seal/Judgement
// (sustain = low downtime), bigger Seal damage on EVERY swing, harder/faster Judgement, +AP & dodge,
// then +melee/spell dmg. Survival is already covered by plate + self-heal, so points go to kill speed.
// Ordered one nodeId per point; gates respected cumulatively (lead with row0 ret_benediction so the
// gate2 nodes that follow are legal). Ids/gates verified vs talents_classic.ts PALADIN_SPEC_NODES.
export const PALADIN_RET_STEPS = [
  'ret_benediction', 'ret_benediction', 'ret_benediction',   // rows0: −24% Seal/Judgement cost (sustain)
  'ret_seal_command', 'ret_seal_command',                    // row1 gate2: +40% Seal damage (every swing)
  'ret_imp_judgement', 'ret_imp_judgement',                  // row1 gate2 (req ret_benediction): −30% Judge cd, +20% dmg
  'ret_choice',                                              // row2 gate5: Pursuit of Justice (+10% AP, +3% dodge)
  'ret_crusader_strikes', 'ret_crusader_strikes',            // row3 gate8 (req ret_choice): +12% melee/+8% spell dmg, −20% Exorcism cd
  'ret_conviction',                                          // row0: +1% crit (11th point @lv20)
];
export const PALADIN_RET_CHOICES = { ret_choice: 'ret_choice_pursuit' };
export function paladinTalentAlloc(budget) {
  const ranks = {}, choices = {};
  const n = Math.max(0, Math.min(budget, PALADIN_RET_STEPS.length));
  for (let i = 0; i < n; i++) {
    const id = PALADIN_RET_STEPS[i];
    ranks[id] = (ranks[id] ?? 0) + 1;
    if (PALADIN_RET_CHOICES[id]) choices[id] = PALADIN_RET_CHOICES[id];
  }
  return { spec: 'retribution', ranks, choices };
}

// per-class build dispatch (druid feral + paladin retribution; other classes fall back to no auto-talents)
export const TALENT_BUILD = { druid: druidTalentAlloc, paladin: paladinTalentAlloc };
export const sameAlloc = (a, b) => {
  if (!a || !b || (a.spec ?? null) !== (b.spec ?? null)) return false;
  const ra = a.ranks ?? {}, rb = b.ranks ?? {}, ca = a.choices ?? {}, cb = b.choices ?? {};
  const rk = new Set([...Object.keys(ra), ...Object.keys(rb)]);
  for (const k of rk) if ((ra[k] ?? 0) !== (rb[k] ?? 0)) return false;
  const ck = new Set([...Object.keys(ca), ...Object.keys(cb)]);
  for (const k of ck) if ((ca[k] ?? null) !== (cb[k] ?? null)) return false;
  return true;
};

// Per-rank ability COSTS + talent cost discounts — GENERATED from the source (ABILITY_RANKS /
// TALENT_COST_MODS in abilities.generated.mjs via scripts/gen_bot_abilities.mjs), so canCast bills the
// SAME mana the server does and never falls behind by level OR ability. The server resolves each cast to
// the highest rank known at your level and bills THAT rank's (higher) cost (abilitiesKnownAt), THEN
// applies the talent cost modifiers (applyTalentMods, e.g. ret_benediction −24% Seal/Judgement,
// feral_ferocity −6% Maul) — both returning BEFORE the GCD on a mana fail. The kits carry only rank-1
// base costs, so without this the bot mis-billed cost as it levelled → a rejected cast the server never
// advanced the GCD on → a do-nothing FREEZE re-issued every tick (and lapsed upkeep buffs). abilityCost
// mirrors both server steps exactly; an id with no rank rows falls back to the kit base (nothing regresses).
export function abilityCost(self, id, base) {
  let c = base;
  const rs = ABILITY_RANKS[id];
  if (rs) for (const r of rs) if ((self?.lv ?? 1) >= r.level) c = r.cost;
  // talent cost modifiers: cost * (1 + Σ costPct), rounded, floored at 0 — exactly applyTalentMods.
  // We sum costPct over EVERY allocated node without the server's dormant-spec filter (it skips a spec node
  // whose specId != active spec, talents.ts). That's safe because a server-validated alloc — which is what
  // self.tal.alloc always is — can't contain a foreign-spec node (validateAllocation rejects it), and the bot
  // only ever sends its own fixed-spec builds. So for every reachable alloc the unfiltered sum == the server.
  const alloc = self?.tal?.alloc;
  if (alloc) {
    let pct = 0;
    const sp = TALENT_COST_MODS['spec:' + alloc.spec];
    if (sp && sp[id] != null) pct += sp[id];
    const ranks = alloc.ranks ?? {};
    for (const nid in ranks) { const m = TALENT_COST_MODS[nid]; if (m && m[id] != null) pct += m[id] * ranks[nid]; }
    const choices = alloc.choices ?? {};
    for (const cid in choices) { const m = TALENT_COST_MODS[choices[cid]]; if (m && m[id] != null) pct += m[id]; }
    if (pct) c = Math.max(0, Math.round(c * (1 + pct)));
  }
  return c;
}

// ---- selectable behaviour MODES -----------------------------------------
// A small table of behaviour knobs the brain reads (ctx.tune = modeTune(S.mode)). The pull/flee fudge
// knobs are GONE — pull safety is now computed from the game's real aggro radii (world.mjs joinCount),
// not tuned per mode. What remains: whether to quest, the flee/ready HP thresholds, and economy timing.
//   quest      run the quest engine + grind fallback (default)
//   grind      pure grind, no quests
//   level-fast quests ON (biggest XP) + minimal between-pull downtime (low readyHp) for max XP/hour
//   farm-gold  grind + sell/vendor more eagerly to bank coin
//   cautious   higher flee/ready HP — for unattended overnight safety
//   passive    defend only (handled specially in decide)
const BASE = {
  quest: true,        // run the quest engine (else pure grind)
  fleeHp: 0.40,       // flee only when OVERWHELMED (aggro > combatCap) AND HP drops below this — death is cheap, so we'd rather kill than over-flee
  readyHp: 0.55,      // top HP up to this between pulls before engaging the next mob (low → lean into the next kill; death cheap, brawlers self-heal in-fight)
  sellAt: 12,         // sellable stacks before a dedicated vendor trip
  gearTrip: 300000,   // ms cooldown between gear-buy vendor trips
};
const MODES = {
  quest: { ...BASE },
  grind: { ...BASE, quest: false },
  'level-fast': { ...BASE, readyHp: 0.40 },   // quests stay on; engage the next mob with less healing downtime
  'farm-gold': { ...BASE, quest: false, sellAt: 6, gearTrip: 120000 },
  cautious: { ...BASE, fleeHp: 0.60, readyHp: 0.90 },
  passive: { ...BASE, quest: false },
};
export const MODE_NAMES = Object.keys(MODES);
export const modeTune = (m) => MODES[m] ?? MODES.quest;
