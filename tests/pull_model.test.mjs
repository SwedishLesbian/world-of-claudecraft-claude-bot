// The universal PULL MODEL — target selection grounded in the game's real aggro math (sim.ts), the core
// of the v4.32 refactor. Verifies proximity/social joiner counting on real per-template radii, cleanest-
// instance selection, the thin accept policy, and elite/boss skipping. Run: node --test bot/tests/*.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../lib/world.mjs';

// Build a World at the origin with a set of live hostile mobs. Each mob: {id,tid,lv,x,z[,aggro,tap]}.
function worldWith(selfLv, mobs, self = {}) {
  const w = new World();
  w.self = { id: 1, lv: selfLv, hp: 100, mhp: 100, x: 0, z: 0, ...self };
  w.pid = 1;
  w.ents = new Map([[1, w.self]]);
  for (const m of mobs) w.ents.set(m.id, { k: 'mob', h: true, dead: false, aggro: null, ...m });
  return w;
}

test('aggroRadiusOf: real per-template radius, clamped, scaled by the level gap', () => {
  const w = worldWith(14, []);
  assert.equal(w.aggroRadiusOf({ tid: 'ridge_stalker', lv: 14 }, 14), 11, 'equal level → base 11');
  assert.equal(w.aggroRadiusOf({ tid: 'ridge_stalker', lv: 18 }, 14), 17, '+4 levels: 11+6');
  assert.equal(w.aggroRadiusOf({ tid: 'ridge_stalker', lv: 2 }, 14), 4, 'grey-low → clamped to 4 floor');
  assert.equal(w.aggroRadiusOf({ tid: 'ridge_stalker', lv: 30 }, 14), 20, 'huge-high → clamped to 20 ceiling');
});

test('joinCount: a genuinely isolated target has zero joiners', () => {
  const w = worldWith(14, [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 20, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 50, z: 0 },   // far away — outside everyone's radius
  ]);
  assert.equal(w.joinCount(w.ents.get(10), 14), 0, 'lone target, distant neighbour → clean');
});

test('joinCount: a different-tid neighbour within ITS proximity radius joins', () => {
  // a 2nd ridge_stalker 8yd from the target: 8 < its 11yd proximity radius → proximity joiner.
  const near = worldWith(14, [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 0, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 8, z: 0 },
  ]);
  assert.equal(near.joinCount(near.ents.get(10), 14), 1, 'neighbour inside proximity radius → joins');
  // push it to 13yd (> 11yd radius, and > 5yd social) → no longer joins.
  const far = worldWith(14, [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 0, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 13, z: 0 },
  ]);
  assert.equal(far.joinCount(far.ents.get(10), 14), 0, 'neighbour beyond proximity + social → clean');
});

test('joinCount: SOCIAL pull links a same-template neighbour even when proximity says no', () => {
  // low-level murlocs vs a lv16 player: proximity clamps to 4yd, but the murloc social radius is 8yd, and
  // a same-template murloc 7yd away IS pulled by the server → must count as a joiner.
  const w = worldWith(16, [
    { id: 10, tid: 'deepfen_murloc', lv: 9, x: 0, z: 0 },
    { id: 11, tid: 'deepfen_murloc', lv: 9, x: 7, z: 0 },   // 7yd: > 4yd proximity, < 8yd murloc-social
  ]);
  assert.equal(w.aggroRadiusOf(w.ents.get(11), 16), 4, 'low murloc proximity clamps to 4');
  assert.equal(w.joinCount(w.ents.get(10), 16), 1, 'same-tid within social radius joins via SOCIAL path');
});

test('joinCount: a mob already busy on someone else is not a joiner', () => {
  const w = worldWith(14, [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 0, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 4, z: 0, aggro: 999 },  // fighting another player
  ]);
  assert.equal(w.joinCount(w.ents.get(10), 14), 0, 'busy neighbour ignored');
});

test('joinCount: a TRIVIAL (≥10 levels below, non-elite) neighbour is skipped from the PROXIMITY branch', () => {
  // self lv16, a non-same-tid forest_wolf lv5 (16-5=11 ≥ TRIVIAL_GAP) 3yd from the target. The server's
  // proximity-aggro skips trivial mobs entirely (isTrivialTo) → it must NOT count as a joiner.
  const trivial = worldWith(16, [
    { id: 10, tid: 'ridge_stalker', lv: 16, x: 0, z: 0 },
    { id: 11, tid: 'forest_wolf', lv: 5, x: 3, z: 0 },     // trivial, different tid → only the proximity path applies
  ]);
  assert.equal(trivial.joinCount(trivial.ents.get(10), 16), 0, 'trivial proximity neighbour excluded');
  // a NON-trivial neighbour (lv14, gap 2) at the same spot DOES join via proximity.
  const real = worldWith(16, [
    { id: 10, tid: 'ridge_stalker', lv: 16, x: 0, z: 0 },
    { id: 11, tid: 'forest_wolf', lv: 14, x: 3, z: 0 },
  ]);
  assert.equal(real.joinCount(real.ents.get(10), 16), 1, 'at-level proximity neighbour still joins');
});

test('joinCount: the SOCIAL branch is NOT trivial-gated — the server pulls low-level kin too', () => {
  // a lv6 deepfen_murloc (trivial vs lv16) 7yd from a same-tid target: proximity clamps to 4 (skipped),
  // but the murloc SOCIAL radius is 8yd and the server links same-template kin regardless of level → joins.
  const w = worldWith(16, [
    { id: 10, tid: 'deepfen_murloc', lv: 9, x: 0, z: 0 },
    { id: 11, tid: 'deepfen_murloc', lv: 6, x: 7, z: 0 },  // trivial, but same-tid within 8yd social
  ]);
  assert.equal(w.joinCount(w.ents.get(10), 16), 1, 'trivial same-tid kin still social-pulled (no gate on social)');
});

test('joinCount: an OWNED mob (pet/summon) never joins — server requires ownerId===null', () => {
  const owned = worldWith(14, [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 0, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 4, z: 0, own: 999 },  // owned → server never social/proximity-pulls it
  ]);
  assert.equal(owned.joinCount(owned.ents.get(10), 14), 0, 'owned neighbour excluded');
  // the same neighbour with no owner DOES join (within social radius).
  const wild = worldWith(14, [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 0, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 4, z: 0 },
  ]);
  assert.equal(wild.joinCount(wild.ents.get(10), 14), 1, 'un-owned neighbour joins');
});

// ── FLEE-HELP CASCADE (sim.ts callForHelp) — the second wave social/proximity counting alone misses. ──
test('flee-help: a DIFFERENT-template same-FAMILY neighbour the social/proximity pass misses still joins', () => {
  // self lv16, target a lv16 humanoid (flees), neighbour a DIFFERENT humanoid tid at lv5 (TRIVIAL) 6yd away.
  //   • social  — different tid → no link.  • proximity — trivial (16-5=11≥10) → server skips it.
  // The OLD flat count → 0. But killing the target drags it to ≤20%, it shouts, and the server's callForHelp
  // pulls idle SAME-FAMILY mobs within 8yd regardless of level → the bandit joins. Count must be 1.
  const w = worldWith(16, [
    { id: 10, tid: 'gravecaller_cultist', lv: 16, x: 0, z: 0 },   // humanoid, flees
    { id: 11, tid: 'vale_bandit', lv: 5, x: 6, z: 0 },            // humanoid, different tid, trivial, 6yd < 8yd flee-help
  ]);
  assert.equal(w.joinCount(w.ents.get(10), 16), 1, 'flee-help pulls the same-family neighbour proximity/social missed');
  // a DIFFERENT-family neighbour at the same spot is NOT called (callForHelp is family-scoped) → 0.
  const otherFam = worldWith(16, [
    { id: 10, tid: 'gravecaller_cultist', lv: 16, x: 0, z: 0 },   // humanoid
    { id: 11, tid: 'forest_wolf', lv: 5, x: 6, z: 0 },            // beast — not the cultist's family
  ]);
  assert.equal(otherFam.joinCount(otherFam.ents.get(10), 16), 0, 'flee-help is family-scoped: a beast is not called');
});

test('flee-help: a non-fleeing family (beast) raises NO wave — identical geometry, humanoid does', () => {
  const geom = (tidT, tidN) => [
    { id: 10, tid: tidT, lv: 16, x: 0, z: 0 },
    { id: 11, tid: tidN, lv: 5, x: 6, z: 0 },   // trivial neighbour (proximity-skipped), same family as its target
  ];
  // beast target + beast neighbour: beasts fight to the death (not in FLEEING_FAMILIES) → no flee wave.
  const beast = worldWith(16, geom('ridge_stalker', 'forest_wolf'));
  assert.equal(beast.joinCount(beast.ents.get(10), 16), 0, 'beast target raises no flee-help wave');
  // humanoid target + humanoid neighbour, same geometry → the wave appears.
  const human = worldWith(16, geom('gravecaller_cultist', 'vale_bandit'));
  assert.equal(human.joinCount(human.ents.get(10), 16), 1, 'humanoid target DOES raise the wave (control)');
});

test('flee-help CHAINS: B pulled by A then pulls C beyond A’s own reach', () => {
  // A(0) — B(6) — C(12), all humanoid, B & C trivial different tids (proximity + social both silent).
  // A flees → calls B (6<8). B flees → calls C (6<8). A can NOT reach C directly (12>8) — only the CHAIN does.
  const w = worldWith(16, [
    { id: 10, tid: 'gravecaller_cultist',  lv: 16, x: 0,  z: 0 },
    { id: 11, tid: 'gravecaller_summoner', lv: 5,  x: 6,  z: 0 },
    { id: 12, tid: 'nhalia_mourner',       lv: 5,  x: 12, z: 0 },
  ]);
  assert.equal(w.joinCount(w.ents.get(10), 16), 2, 'the flee cascade reaches C through B (recursive call-for-help)');
  // sanity: drop C out of B’s flee radius (x=15, 9yd from B) → the chain stops at B → only 1 joins.
  const broken = worldWith(16, [
    { id: 10, tid: 'gravecaller_cultist',  lv: 16, x: 0,  z: 0 },
    { id: 11, tid: 'gravecaller_summoner', lv: 5,  x: 6,  z: 0 },
    { id: 12, tid: 'nhalia_mourner',       lv: 5,  x: 15, z: 0 },   // 9yd from B → out of the 8yd flee radius
  ]);
  assert.equal(broken.joinCount(broken.ents.get(10), 16), 1, 'chain stops when the next link is out of flee radius');
});

// ── THREAT-WEIGHTED capacity: the pull model counts BODIES, but capacity is gated by DIFFICULTY. ──
test('threat-weight: a lvl16 BRAWLS a low-level (grey) same-family camp — bodies counted, but weak ones are cheap', () => {
  // a lv16 cultist (in-band) ringed by two GREY lv5/6 humanoids. They DO join (flee-help, raw count 2), but
  // they're trivial threat (gap 10/11 → weight 0) → zero brawl LOAD → a plate paladin facerolls them. The old
  // body-count gate wrongly refused this easy pull; difficulty-weighting takes it (this is the "easy quest").
  const w = worldWith(16, [
    { id: 10, tid: 'gravecaller_cultist', lv: 16, x: 20, z: 0 },
    { id: 11, tid: 'vale_bandit',   lv: 5, x: 22, z: 0 },   // grey, within 8yd flee-help
    { id: 12, tid: 'mogger_lackey', lv: 6, x: 18, z: 1 },   // grey, within 8yd flee-help
  ]);
  assert.equal(w.joinCount(w.ents.get(10), 16), 2, 'TWO bodies still join (raw count unchanged)');
  assert.equal(w.brawlLoad(w.ents.get(10), 16), 0, 'but both are grey → zero brawl LOAD');
  assert.equal(w.nearestSafeMob(16, 1)?.id, 10, 'so a paladin BRAWLS the cultist + 2 grey adds (does the easy quest)');
});

test('threat-weight: a melee brawls a GREEN low-level pack (the easy-quest case), but an EQUAL-level pack is still refused', () => {
  // lvl9 vs a tunnel_rat (kobold, flees) cluster at lv5-6 → green/grey (gap 3-4) → light load → TAKEN.
  const green = worldWith(9, [
    { id: 10, tid: 'tunnel_rat', lv: 6, x: 20, z: 0 },   // gap 3 → 0.5
    { id: 11, tid: 'tunnel_rat', lv: 5, x: 22, z: 0 },   // gap 4 → 0.5
  ]);
  assert.ok(green.nearestSafeMob(9, 1), 'a paladin brawls the green rat pack instead of refusing it (easy quest doable)');
  // same geometry but the rats are AT our level (gap 0 → full weight) → load 1 per add → a 2-add cluster refused.
  const equal = worldWith(6, [
    { id: 10, tid: 'tunnel_rat', lv: 6, x: 20, z: 0 },
    { id: 11, tid: 'tunnel_rat', lv: 6, x: 22, z: 0 },
    { id: 12, tid: 'tunnel_rat', lv: 6, x: 21, z: 1 },
  ]);
  assert.equal(equal.nearestSafeMob(6, 1), null, 'an equal-level 3-pack still exceeds capacity → refused (death-reduction intact)');
});

test('threat-weight: an UNDER-levelled bot vs an OVER-level dense camp stays REFUSED (real death case protected)', () => {
  // lvl7 bot, a lv12 cultist + two lv12 same-family adds (gap -5 → FULL weight each) → load 2 > maxJoin 1.
  const w = worldWith(7, [
    { id: 10, tid: 'gravecaller_cultist',  lv: 12, x: 20, z: 0 },
    { id: 11, tid: 'gravecaller_summoner', lv: 12, x: 22, z: 0 },
    { id: 12, tid: 'gravecaller_mender',   lv: 12, x: 19, z: 1 },
  ]);
  assert.ok(w.brawlLoad(w.ents.get(10), 7) >= 2, 'over-level adds carry full weight');
  assert.equal(w.questMob('gravecaller_cultist', 7, 1), null, 'under-levelled bot refuses the over-level swarm — stays protected');
});

test('flee-help: a PROXIMITY-woken different-family neighbour raises a wave the (non-fleeing) target never would', () => {
  // target is a BEAST (ridge_stalker, never flees). A humanoid cultist proximity-wakes from the fight (9yd <
  // its 11yd radius) → it flees and chains to a trivial humanoid bandit only IT can reach. So a non-fleeing
  // target still incurs a flee wave, via a proximity-woken neighbour of a DIFFERENT, fleeing family.
  const w = worldWith(14, [
    { id: 10, tid: 'ridge_stalker',       lv: 14, x: 0,  z: 0 },   // beast target — no flee of its own
    { id: 11, tid: 'gravecaller_cultist', lv: 14, x: 9,  z: 0 },   // humanoid, proximity-wakes (9 < 11)
    { id: 12, tid: 'vale_bandit',         lv: 5,  x: 15, z: 0 },   // humanoid, trivial; 6yd from #11, 15 from target
  ]);
  assert.equal(w.joinCount(w.ents.get(10), 14), 2, 'proximity-woken humanoid flees and chains to the bandit');
});

// ── engageCost / aggroLoad: the single winnability metric (target difficulty + cascade vs my capacity). ──
test('engageCost: a LONE over-level mob costs >1 (its own difficulty counts), a lone at-level costs 1', () => {
  const w = worldWith(9, [
    { id: 10, tid: 'gravecaller_cultist', lv: 12, x: 20, z: 0 },   // +3 above (orange) — a long, dangerous solo fight
    { id: 11, tid: 'ridge_stalker',       lv: 9,  x: 60, z: 0 },   // at level, far (no joiners)
  ]);
  assert.ok(w.engageCost(w.ents.get(10), 9) >= 1.75, 'a lone +3 mob already costs ~1.75 (orange) even with zero joiners');
  assert.equal(w.engageCost(w.ents.get(11), 9), 1, 'a lone at-level mob costs exactly 1');
  // capacity 1 (single-puller): the at-level lone mob is winnable, the over-level one is NOT.
  assert.equal(w.questMob('gravecaller_cultist', 9, 1), null, 'over-level lone mob refused at capacity 1');
});

test('aggroLoad: the flee metric is weighted — a swarm of greys is ~0, three at-level mobs is 3', () => {
  const greys = worldWith(16, [
    { id: 10, tid: 'vale_bandit', lv: 5, x: 1, z: 0, aggro: 1 },   // grey attackers (gap 11) — trivial pressure
    { id: 11, tid: 'mogger_lackey', lv: 6, x: 1, z: 1, aggro: 1 },
    { id: 12, tid: 'vale_bandit', lv: 5, x: 2, z: 0, aggro: 1 },
  ]);
  // mark them as attacking ME (aggro === pid) so mobsAggroOnMe() sees them
  for (const id of [10, 11, 12]) greys.ents.get(id).aggro = greys.pid;
  assert.equal(greys.aggroLoad(16), 0, 'three grey attackers exert ~0 weighted load (faceroll, do not flee)');
  const real = worldWith(14, [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 1, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 1, z: 1 },
    { id: 12, tid: 'ridge_stalker', lv: 14, x: 2, z: 0 },
  ]);
  for (const id of [10, 11, 12]) real.ents.get(id).aggro = real.pid;
  assert.equal(real.aggroLoad(14), 3, 'three at-level attackers exert load 3 (> a 2-cap class → flee)');
});

test('nearestSafeMob: picks the ISOLATED instance and skips the dense cluster', () => {
  const w = worldWith(14, [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 15, z: 0 },                 // lone — 0 joiners
    { id: 20, tid: 'ridge_stalker', lv: 14, x: 40, z: 0 },                 // cluster of 3...
    { id: 21, tid: 'ridge_stalker', lv: 14, x: 42, z: 0 },
    { id: 22, tid: 'ridge_stalker', lv: 14, x: 41, z: 1 },
  ]);
  const pick = w.nearestSafeMob(14);
  assert.ok(pick && pick.id === 10, 'engages the isolated ridge_stalker, not the pack');
});

test('nearestSafeMob: when EVERY candidate is a pack, return null (wait/relocate, never body-pull)', () => {
  const w = worldWith(14, [
    { id: 20, tid: 'ridge_stalker', lv: 14, x: 30, z: 0 },
    { id: 21, tid: 'ridge_stalker', lv: 14, x: 32, z: 0 },
    { id: 22, tid: 'ridge_stalker', lv: 14, x: 31, z: 1 },
  ]);
  assert.equal(w.nearestSafeMob(14), null, 'no clean pull → null (the bot moves on instead of diving the pack)');
});

test('accept policy: engageCost ≤ CAPACITY (= combatCap), matching what the weighted flee rule fights', () => {
  const mobs = [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 20, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 23, z: 0 },   // 3yd apart → joiner each; at-level → cost 1+1 = 2
  ];
  // capacity 1 (a single-puller, e.g. mage, combatCap 1): a 2-cost pull (target + 1 at-level joiner) is OVER
  // capacity → refused. It single-pulls so it never engages more than it will fight (flee when load > 1).
  assert.equal(worldWith(16, mobs).nearestSafeMob(16, 1), null, 'capacity 1: cost-2 pull refused');
  // capacity 2 (a brawler, e.g. paladin/druid, combatCap 2): cost 2 ≤ 2 → taken, even hurt (death is cheap; the
  // flee rule fights a weighted-load-2 brawl, so we engage it).
  assert.ok(worldWith(14, mobs, { hp: 50 }).nearestSafeMob(14, 2), 'capacity 2: cost-2 pull taken');
  // a 3-mob at-level cluster → cost 1 + 2 = 3 > capacity 2 → refused; it would pull→flee→reset.
  const cluster = [
    { id: 20, tid: 'ridge_stalker', lv: 14, x: 20, z: 0 },
    { id: 21, tid: 'ridge_stalker', lv: 14, x: 22, z: 0 },
    { id: 22, tid: 'ridge_stalker', lv: 14, x: 21, z: 1 },
  ];
  assert.equal(worldWith(16, cluster).nearestSafeMob(16, 2), null, 'capacity 2: a cost-3 cluster exceeds capacity → refused');
});

test('nearestSafeMob: elites/bosses/rares are skipped by data, and greys (0 xp) are excluded', () => {
  const elite = worldWith(20, [{ id: 10, tid: 'korzul_the_gravewyrm', lv: 20, x: 12, z: 0 }]);
  assert.equal(elite.nearestSafeMob(20), null, 'boss never grind-targeted');
  const grey = worldWith(16, [{ id: 10, tid: 'ridge_stalker', lv: 5, x: 12, z: 0 }]);  // 11 levels below → grey
  assert.equal(grey.nearestSafeMob(16), null, 'grey (0-xp) mob excluded');
});

test('questMob: returns the cleanest live instance of the tid (ignores the level band)', () => {
  const w = worldWith(18, [
    { id: 10, tid: 'wyrmcult_zealot', lv: 18, x: 18, z: 0 },                // lone
    { id: 20, tid: 'wyrmcult_zealot', lv: 18, x: 40, z: 0 },                // pack
    { id: 21, tid: 'wyrmcult_zealot', lv: 18, x: 42, z: 0 },
    { id: 22, tid: 'wyrmcult_zealot', lv: 18, x: 41, z: 1 },
  ]);
  const qm = w.questMob('wyrmcult_zealot', 18);
  assert.ok(qm && qm.id === 10, 'edge-pulls the isolated quest mob');
  // a tid with only a dense pack present → null (chip it from the edge later, don't dive)
  const packed = worldWith(18, [
    { id: 20, tid: 'wyrmcult_zealot', lv: 18, x: 40, z: 0 },
    { id: 21, tid: 'wyrmcult_zealot', lv: 18, x: 42, z: 0 },
    { id: 22, tid: 'wyrmcult_zealot', lv: 18, x: 41, z: 1 },
  ]);
  assert.equal(packed.questMob('wyrmcult_zealot', 18), null, 'all-packed quest tid → wait for an edge');
});
