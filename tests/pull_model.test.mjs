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

test('nearestSafeMob: an at-level mob standing in a LOW-LEVEL same-family camp is refused (the flee swarm)', () => {
  // The classic "looked clean, killed it, got swarmed" death: a lv16 cultist (in-band, pullable) ringed by
  // two TRIVIAL lv5 humanoids. Old model saw 0 joiners (trivial→no proximity, diff tid→no social) and engaged;
  // the kill then called both via flee-help. A paladin (maxJoin = combatCap-1 = 1) must now REFUSE it.
  const w = worldWith(16, [
    { id: 10, tid: 'gravecaller_cultist', lv: 16, x: 20, z: 0 },
    { id: 11, tid: 'vale_bandit',   lv: 5, x: 22, z: 0 },   // trivial, within 8yd flee-help
    { id: 12, tid: 'mogger_lackey', lv: 6, x: 18, z: 1 },   // trivial, within 8yd flee-help
  ]);
  assert.equal(w.joinCount(w.ents.get(10), 16), 2, 'killing the cultist calls both camp humanoids');
  assert.equal(w.nearestSafeMob(16, 1), null, 'paladin (maxJoin 1) refuses the 2-flee-add pull → grind elsewhere, return stronger');
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

test('questMobAny: cleanest instance IGNORING capacity — the no-kill-spiral escape hatch', () => {
  // a quest tid present only as a dense pack: the cap-gated questMob refuses it, but questMobAny still returns
  // the LEAST-dense instance so the brain can dive it as a last resort (progress beats a stall; death is cheap).
  const packed = worldWith(18, [
    { id: 20, tid: 'wyrmcult_zealot', lv: 18, x: 40, z: 0 },
    { id: 21, tid: 'wyrmcult_zealot', lv: 18, x: 42, z: 0 },
    { id: 22, tid: 'wyrmcult_zealot', lv: 18, x: 41, z: 1 },
  ]);
  assert.equal(packed.questMob('wyrmcult_zealot', 18, 1), null, 'cap-gated pick refuses the all-packed tid');
  const any = packed.questMobAny('wyrmcult_zealot', 18);
  assert.ok(any && [20, 21, 22].includes(any.id), 'questMobAny returns a live instance regardless of capacity');
  // no live instance at all → still null (nothing to dive).
  assert.equal(worldWith(18, []).questMobAny('wyrmcult_zealot', 18), null, 'no instance present → null');
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

test('accept policy: pull up to brawl capacity (maxJoin = combatCap-1), matching what the flee rule fights', () => {
  const mobs = [
    { id: 10, tid: 'ridge_stalker', lv: 14, x: 20, z: 0 },
    { id: 11, tid: 'ridge_stalker', lv: 14, x: 23, z: 0 },   // 3yd apart → 1 joiner each
  ];
  // maxJoin 0 (a single-puller, e.g. mage, combatCap 1): a 1-joiner pull is OVER capacity → refused. It
  // single-pulls so it never engages more than it will fight (flee at aggro>1).
  assert.equal(worldWith(16, mobs).nearestSafeMob(16, 0), null, 'maxJoin 0: a 1-joiner pull is refused (would exceed cap)');
  // maxJoin 1 (a brawler, e.g. paladin/druid, combatCap 2): a 1-joiner pull is WITHIN capacity → taken, even
  // hurt and at-level (death is cheap; the flee rule fights a 2-pull, so we engage one).
  assert.ok(worldWith(14, mobs, { hp: 50 }).nearestSafeMob(14, 1), 'maxJoin 1: 1-joiner pull taken (within brawl capacity)');
  // a 3-mob cluster (2 joiners) exceeds a brawler's capacity (cap 2) → refused; it would pull→flee→reset.
  const cluster = [
    { id: 20, tid: 'ridge_stalker', lv: 14, x: 20, z: 0 },
    { id: 21, tid: 'ridge_stalker', lv: 14, x: 22, z: 0 },
    { id: 22, tid: 'ridge_stalker', lv: 14, x: 21, z: 1 },
  ];
  assert.equal(worldWith(16, cluster).nearestSafeMob(16, 1), null, 'maxJoin 1: a 2-joiner cluster exceeds capacity → refused');
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
