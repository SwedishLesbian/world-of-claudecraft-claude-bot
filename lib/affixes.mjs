// COMBAT AFFIX THREAT MODEL (v0.10.0 "consolidated pack bundle", levy-street/world-of-claudecraft#634).
//
// v0.10.0 hangs combat-altering AFFIXES right on each MobTemplate (sim.ts reads them in mobSwing / dealDamage
// / tick): on-hit debuffs (stun, silence, disarm, DoTs…), innate traits (spellReflect, thorns, lifeleech), and
// telegraphed periodic mechanics (enrage, mendAlly…). The bot's winnability cost model (lib/world.mjs) was
// BLIND to all of them — it weighed a mob purely by the level gap, so a grey/green mob that silences a druid
// mid-root-kite, reflects its nukes, or devours a paladin's self-heal read as "trivial" and got facerolled
// into a death loop. This module is the ONE place that:
//   (a) AFFIX_KEYS      — which MobTemplate fields are affixes (what the generator projects).
//   (b) AFFIX_THREAT    — how much each one DEGRADES OUR ability to win cleanly (severity), gated to the
//                         build it actually bites.
//   (c) affixThreatMult — folds a mob's affixes into a MULTIPLIER on its base (level-gap) threat weight.
// Data lives in lib/mobs.generated.mjs (proc chances, projected by scripts/gen_bot_mobs.mjs); the model lives
// here; world.mjs just multiplies. Same split as aggroRadius (data) vs the wake-radius formula (world.mjs).
//
// WHY A MULTIPLIER on the level-gap weight, not a flat add: an affix only matters while the mob is alive to
// land it. A grey mob (base weight already 0 — it dies in a hit or two and can't kill an out-levelled bot)
// stays ~free no matter what it carries; the SAME affix on an at-level or above mob, alive long enough to
// silence/stun/anti-heal us, scales its danger up. Self-limiting by construction: it can never make a
// faceroll mob look scary (preserving "do the easy low-level quests"), only sharpen a fight that's already
// real. Tuned conservative — only a stacked pile of nasties or a true build-breaker moves a decision.
//
// KNOWN BLIND SPOT (accepted): because a grey mob's base weight is 0, the multiplier is moot on greys, so a
// grey carrying always-on hard CC (ensnare/stun) is still treated as free. Deliberate — a grey dies in a hit
// or two and can't kill an out-levelled bot — but it means the one thing the model can't see is a grey
// perma-CC lock. The survival layer (heal/potion, and flee once aggroLoad exceeds capacity) is the backstop;
// if a grey-CC death loop ever shows up live, guard it there, not here.
// CAP-1 NOTE: a cap-1 build (hunter/mage) sits at the edge on a lone at-level mob (base 1 == capacity 1), so
// any affix bump can push that ONE mob over budget → out-levelled first rather than fought. For a pure caster
// facing an at-level spell-reflector that is correct caution; the always-on nuisance innates are kept low
// (below) so they don't trigger it spuriously. Primary builds (druid/paladin) are cap 2 — unaffected.
//
// severity (`sev`) = the per-kind contribution to the multiplier, BEFORE its proc chance. `gate` restricts it
// to the build it hurts: 'caster' = spell-reliant (druid root-kite + pure casters) — silences / spell-reflect
// / mana drain; 'melee' = weapon-reliant — disarm / blind / resource sap; undefined = universal.

export const AFFIX_THREAT = {
  // ── caster / cast-reliant breakers — only bite a build whose damage, control, or kiting is spells ──────
  silence: { sev: 0.7, gate: 'caster' },       // full spell lockout — a root-kite druid can't root/nuke/heal
  lockout: { sev: 0.6, gate: 'caster' },       // school-specific counterspell (nature/arcane = the druid kit)
  spellReflect: { sev: 0.6, gate: 'caster' },  // reflects our non-physical nukes back on every cast (innate)
  tongues: { sev: 0.35, gate: 'caster' },      // stretches cast times — slower roots/heals/nukes
  manaBurn: { sev: 0.35, gate: 'caster' },     // drains the mana the root-kite + self-heal run on
  enfeeble: { sev: 0.3, gate: 'caster' },      // −int → smaller mana pool
  siphonSpirit: { sev: 0.25, gate: 'caster' }, // −spi → slower mana regen
  purgeOnHit: { sev: 0.35, gate: 'caster' },   // strips a HoT / absorb / imbue / stat buff

  // ── melee / weapon breakers — only bite a build whose damage is weapon swings ──────────────────────────
  disarm: { sev: 0.5, gate: 'melee' },         // suppresses auto-attack
  blind: { sev: 0.3, gate: 'melee' },          // +miss on our weapon swings
  sapVigor: { sev: 0.3, gate: 'melee' },       // drains rage/energy — starves the rotation
  slowStrike: { sev: 0.25, gate: 'melee' },    // −attack speed
  demoralize: { sev: 0.2, gate: 'melee' },     // −attack power → weaker swings

  // ── anti-heal (universal — every soloer leans on its self-heal) ────────────────────────────────────────
  healAbsorb: { sev: 0.5 },                     // devours the next chunk of incoming healing
  mortalStrike: { sev: 0.4 },                   // scales all healing received down for its duration
  hex: { sev: 0.4 },                            // scales our outgoing damage AND healing down

  // ── hard crowd control (universal — losing control near other mobs is how a clean fight turns lethal) ──
  polymorphHex: { sev: 0.5 },                   // turned into a harmless critter — can't act
  concuss: { sev: 0.45 },                       // single-target stun
  stunOnHit: { sev: 0.4 },                      // on-hit stun
  dread: { sev: 0.4 },                          // fear — flee into more mobs
  terrify: { sev: 0.4 },                        // AoE fear pulse
  ensnare: { sev: 0.35 },                       // roots us in place (can't reposition/flee)
  knockback: { sev: 0.3 },                      // shoves us — breaks a cast, scatters positioning

  // ── stat / HP drains + damage-taken amplifiers (universal) ─────────────────────────────────────────────
  enervate: { sev: 0.3 },                       // −sta → shrinks max-HP mid-fight
  plague: { sev: 0.3 },                         // −sta disease → shrinks max-HP
  vulnerability: { sev: 0.3 },                  // +all damage we take
  wither: { sev: 0.25 },                        // −agi → less armor/dodge/crit
  expose: { sev: 0.2 },                         // +physical damage we take
  critVuln: { sev: 0.2 },                       // +crit damage we take
  corrode: { sev: 0.2 },                        // sunders our armor (stacking)
  spellVuln: { sev: 0.2 },                      // +magic damage we take
  costTax: { sev: 0.2 },                        // +resource cost on our abilities
  chillOnHit: { sev: 0.15 },                    // movement slow — hurts kiting/fleeing
  staggerHit: { sev: 0.15 },                    // −dodge → more of its hits land

  // ── damage-over-time on-hit (universal — chips HP, lingers between fights) ─────────────────────────────
  stackPoison: { sev: 0.25 },                   // stacking poison — ramps the longer it stays on us
  soulrot: { sev: 0.15 },
  bleed: { sev: 0.15 },
  venom: { sev: 0.15 },
  frostbite: { sev: 0.15 },
  smolder: { sev: 0.15 },
  cinder: { sev: 0.15 },
  arcaneRot: { sev: 0.15 },

  // ── mob self-scaling / support (a longer, harder fight; some imply a pack we shouldn't solo) ───────────
  // NB the ALWAYS-ON innate nuisances (lifeleech/thorns/packFrenzy/cleave) carry procChance 1, so their
  // severity is kept low on purpose: at chance 1 they'd otherwise dominate a cap-1 build's tiny budget over a
  // lone at-level mob, refusing an ordinary winnable fight. They make a fight chip a little more, not lose it.
  mendAlly: { sev: 0.25 },                      // periodically heals its wounded crew
  enrage: { sev: 0.25 },                        // damage burst below an HP threshold
  rampage: { sev: 0.25 },                       // escalating AP the longer the fight drags
  wardAllies: { sev: 0.2 },                     // shields its crew
  rally: { sev: 0.2 },                          // buffs ally attack power
  warcry: { sev: 0.2 },                         // hastes ally swing speed
  frenzyOnHit: { sev: 0.2 },                    // self-haste when wounded
  stoneskin: { sev: 0.2 },                      // periodic self-absorb shield
  desperateHeal: { sev: 0.2 },                  // one-time desperation self-heal
  deathThroes: { sev: 0.2 },                    // corpse detonation on death
  lifeleech: { sev: 0.12 },                     // always-on: heals itself off the damage it deals
  packFrenzy: { sev: 0.1 },                     // always-on: death-rattle haste for same-family survivors
  thorns: { sev: 0.1 },                         // always-on: reflects flat damage to melee attackers
  cleave: { sev: 0.1 },                         // always-on: splash to nearby targets
};

// What the generator projects: exactly the kinds we weigh (single source of truth — extraction and weighting
// can't drift). A future game version's new affix simply isn't weighed until added here; the gamedata
// staleness guard flags the src/sim change so we re-audit.
// DELIBERATELY OMITTED: the pure BOSS-only mechanics `stomp` / `aoePulse` / `summonAdds` — they only ride
// elite/boss/rare templates, which isElite() already excludes from every target picker, so they can never
// reach threatWeight. (Re-audit if a future version puts `stomp`'s AoE stun on a NON-elite mob.)
export const AFFIX_KEYS = Object.keys(AFFIX_THREAT);

// Cap the multiplier so a kitchen-sink mob can't blow the budget into nonsense: at the cap an at-level mob
// (base 1) reads 2.5 — already past a 2-cap class's capacity (so avoided), while a green mob (base 0.5) reads
// at most 1.25 (still fought). Bounds the model to "sharpen a real fight", never "refuse everything".
export const AFFIX_MULT_CAP = 2.5;

// The multiplier a mob's affixes apply to its base (level-gap) threat weight, for OUR combat profile.
// `affixes` = {kind: procChance} as projected onto the template (procChance 1 = always-on). `profile`
// = { caster, melee } (default = both, the most conservative — counts every gated affix).
export function affixThreatMult(affixes, profile = { caster: true, melee: true }, cap = AFFIX_MULT_CAP) {
  if (!affixes) return 1;
  let bump = 0;
  for (const kind in affixes) {
    const e = AFFIX_THREAT[kind];
    if (!e) continue;
    if (e.gate === 'caster' && !profile.caster) continue;   // we're not spell-reliant — this can't bite us
    if (e.gate === 'melee' && !profile.melee) continue;     // we're not weapon-reliant — this can't bite us
    bump += e.sev * affixes[kind];                          // weight by proc chance (1 = innate/always-on)
  }
  return Math.min(cap, 1 + bump);
}

// {kind: procChance} for every affix a MobTemplate carries (undefined if none) — the generator's projection.
// procChance = the affix's own `chance` when it gates per-swing, else 1 (always-on innate / telegraphed
// periodic mechanics like spellReflect / thorns / enrage that have no `chance` field).
export function affixesFromTemplate(d) {
  const a = {};
  for (const k of AFFIX_KEYS) {
    const v = d[k];
    if (v) a[k] = typeof v.chance === 'number' ? v.chance : 1;
  }
  return Object.keys(a).length ? a : undefined;
}
