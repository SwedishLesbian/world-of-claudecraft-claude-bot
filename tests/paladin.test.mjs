// Combat + talent invariants for the PALADIN rotation (Retribution plate bruiser). Verifies the
// Seal→Judgement engine, the survival ladder (Lay on Hands → Divine Protection → fast heal), pack
// tools (Consecration / Hammer of Justice), the corrected ability costs, and the talent build's gate
// ordering. Run: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paladinRotate } from '../lib/brain.mjs';
import {
  CLASS_KITS, abilityCost, paladinTalentAlloc, PALADIN_RET_STEPS, TALENT_BUILD,
} from '../lib/gamedata.mjs';

// Fresh mock combat context for the paladin. `aggro` = mobs attacking us (positions decide melee count).
// `auras` lets a test put the Seal up (kind:'imbue') or not. `cds` gates per-ability cooldowns.
function mkCtx({ self = {}, mob, aggro = [], auras = [], cds = {} } = {}) {
  const me = {
    id: 1, lv: 18, hp: 600, mhp: 600, res: 1000, mres: 1000, rtype: 'mana',
    auras, gcd: 0, cast: false, cds, inv: [], x: 0, z: 0, target: undefined, ...self,
  };
  const w = {
    self: me,
    dist: (e) => Math.hypot((e.x ?? 0) - me.x, (e.z ?? 0) - me.z),
    faceTo: () => 0,
    mobsAggroOnMe: () => aggro,
  };
  const cmds = [], inputs = [];
  const ctx = {
    world: w, kit: CLASS_KITS.paladin, settings: {}, CLASS: 'paladin',
    now: () => 1_000_000, selfHealUntil: 0,
    cmd: (p) => cmds.push(p), input: (mi, f) => inputs.push({ mi, f }),
  };
  return { ctx, mob, cmds, inputs };
}
const cast = (cmds, ability) => cmds.some((c) => c.cmd === 'cast' && c.ability === ability);
// Wire aura shape (server/game.ts maps to {id,name,kind,rem,dur}) — NOTE no value2: the client can
// only match the Seal by kind, which is why paladinRotate's hasSeal uses kind==='imbue' alone.
const SEAL = { kind: 'imbue', id: 'seal_of_righteousness' };

test('paladin: with no Seal up, applies the Seal FIRST (and does not Judgement without it)', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'wolf', aggro: 1 };
  const { ctx, cmds } = mkCtx({ mob, aggro: [mob], auras: [] });
  paladinRotate(ctx, mob);
  assert.ok(cast(cmds, 'seal_of_righteousness'), 'casts Seal of Righteousness when the imbue is missing');
  assert.ok(!cast(cmds, 'judgement'), 'never Judgements without an active Seal (sim rejects it)');
});

test('paladin: with the Seal up and Judgement ready, Judgements the target', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'wolf', aggro: 1 };
  const { ctx, cmds } = mkCtx({ mob, aggro: [mob], auras: [SEAL] });
  paladinRotate(ctx, mob);
  assert.ok(cast(cmds, 'judgement'), 'unleashes Judgement while the Seal is up');
  assert.ok(!cast(cmds, 'seal_of_righteousness'), 'does not waste a GCD re-sealing while the Seal is still up');
});

test('paladin: when Judgement is on cooldown, falls through to Exorcism (free Holy nuke)', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'wolf', aggro: 1 };
  const { ctx, cmds } = mkCtx({ mob, aggro: [mob], auras: [SEAL], cds: { judgement: 5 } });
  paladinRotate(ctx, mob);
  assert.ok(!cast(cmds, 'judgement'), 'respects the Judgement cooldown');
  assert.ok(cast(cmds, 'exorcism'), 'casts Exorcism on cooldown as the next holy nuke');
});

test('paladin: 2+ mobs in melee -> Consecration AoE (lv18+)', () => {
  const m1 = { id: 99, hp: 300, mhp: 331, x: 3, z: 0, tid: 'wolf', aggro: 1 };
  const m2 = { id: 98, hp: 300, mhp: 331, x: 3, z: 1, tid: 'wolf', aggro: 1 };
  const { ctx, cmds } = mkCtx({ mob: m1, aggro: [m1, m2], auras: [SEAL] });
  paladinRotate(ctx, m1);
  assert.ok(cast(cmds, 'consecration'), 'drops Consecration when a pack is on us');
});

test('paladin: with Consecration down, stuns a SECOND attacker with Hammer of Justice', () => {
  const m1 = { id: 99, hp: 300, mhp: 331, x: 3, z: 0, tid: 'wolf', aggro: 1 };
  const m2 = { id: 98, hp: 300, mhp: 331, x: 3, z: 1, tid: 'wolf', aggro: 1 };
  const { ctx, cmds } = mkCtx({ mob: m1, aggro: [m1, m2], auras: [SEAL], cds: { consecration: 5 } });
  paladinRotate(ctx, m1);
  assert.ok(cast(cmds, 'hammer_of_justice'), 'stuns an add to cut incoming damage');
  // it targets the ADD for the stun, then re-targets the main mob to keep DPSing it
  const tgs = cmds.filter((c) => c.cmd === 'target').map((c) => c.id);
  assert.ok(tgs.includes(98), 'targets the add to land the stun');
  assert.equal(tgs[tgs.length - 1], 99, 'returns target to the main mob after the stun');
});

test('paladin emergency: critical HP fires Lay on Hands (free full heal)', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'wolf', aggro: 1 };
  const { ctx, cmds } = mkCtx({ self: { hp: 90, mhp: 600 }, mob, aggro: [mob], auras: [SEAL] }); // 15%
  paladinRotate(ctx, mob);
  assert.ok(cast(cmds, 'lay_on_hands'), 'pops Lay on Hands at critical HP');
});

test('paladin: low HP while being hit pops Divine Protection (absorb shield)', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'wolf', aggro: 1 };
  const { ctx, cmds } = mkCtx({ self: { hp: 210, mhp: 600 }, mob, aggro: [mob], auras: [SEAL] }); // 35%
  paladinRotate(ctx, mob);
  assert.ok(cast(cmds, 'divine_protection'), 'shields up when low and taking melee');
});

test('paladin: Divine Protection (off-GCD) fires even during a leftover GCD; Seal (on-GCD) does not', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'wolf', aggro: 1 };
  // low HP + being hit + a GCD still rolling from a prior cast
  const { ctx, cmds } = mkCtx({ self: { hp: 210, mhp: 600, gcd: 0.8 }, mob, aggro: [mob], auras: [SEAL] }); // 35%
  paladinRotate(ctx, mob);
  assert.ok(cast(cmds, 'divine_protection'), 'off-GCD absorb shield is not blocked by the GCD');

  // a normal on-GCD ability stays gated while the GCD rolls (proves the bypass is offGcd-specific)
  const m2 = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'wolf', aggro: 1 };
  const r = mkCtx({ self: { gcd: 0.8 }, mob: m2, aggro: [m2], auras: [] }); // full HP, no Seal, GCD rolling
  paladinRotate(r.ctx, m2);
  assert.ok(!cast(r.cmds, 'seal_of_righteousness'), 'on-GCD Seal waits for the GCD to clear');
});

test('paladin: mid-HP self-heal prefers fast Flash of Light over slow Holy Light', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'wolf', aggro: 1 };
  const { ctx, cmds } = mkCtx({ self: { hp: 270, mhp: 600 }, mob, aggro: [mob], auras: [SEAL] }); // 45%
  paladinRotate(ctx, mob);
  assert.ok(cast(cmds, 'flash_of_light'), 'uses the 1.5s Flash of Light in combat');
  assert.ok(!cast(cmds, 'holy_light'), 'does not stand for the 2.5s Holy Light mid-fight');
});

test('paladin ability costs: corrected to the v0.8 source (no bogus rank rows)', () => {
  assert.equal(abilityCost({ lv: 5 }, 'seal_of_righteousness', 25), 25, 'seal rank1 @<10 = 25');
  assert.equal(abilityCost({ lv: 10 }, 'seal_of_righteousness', 25), 35, 'seal rank2 @10 = 35');
  assert.equal(abilityCost({ lv: 16 }, 'seal_of_righteousness', 25), 50, 'seal rank3 @16 = 50');
  assert.equal(abilityCost({ lv: 12 }, 'blessing_of_might', 25), 40, 'blessing rank2 @12 = 40');
  assert.equal(abilityCost({ lv: 20 }, 'judgement', 30), 30, 'Judgement is flat 30 (no ranks)');
  assert.equal(abilityCost({ lv: 20 }, 'exorcism', 55), 55, 'Exorcism is flat 55 (no ranks)');
});

test('paladin talents: Retribution build is gate-legal and monotonic for every level budget', () => {
  assert.equal(TALENT_BUILD.paladin, paladinTalentAlloc, 'registered in the per-class dispatch');
  assert.equal(PALADIN_RET_STEPS.length, 11, '11 points = levels 10..20');
  const MAX = { ret_benediction: 3, ret_seal_command: 2, ret_imp_judgement: 2, ret_choice: 1, ret_crusader_strikes: 2, ret_conviction: 3 };
  for (let budget = 1; budget <= 11; budget++) {
    const a = paladinTalentAlloc(budget);
    assert.equal(a.spec, 'retribution', `budget ${budget}: spec is retribution`);
    const spent = Object.values(a.ranks).reduce((s, n) => s + n, 0);
    assert.equal(spent, budget, `budget ${budget}: spends exactly ${budget} points`);
    for (const [id, r] of Object.entries(a.ranks)) assert.ok(r <= MAX[id], `budget ${budget}: ${id} within max rank`);
  }
  // gate ordering: the gated nodes never appear before enough points precede them
  assert.ok(PALADIN_RET_STEPS.slice(0, 3).every((s) => s === 'ret_benediction'), 'leads with row0 ret_benediction x3');
  assert.equal(PALADIN_RET_STEPS.indexOf('ret_choice'), 7, 'ret_choice (gate5) is the 8th point (7 spent before it)');
  assert.ok(PALADIN_RET_STEPS.indexOf('ret_crusader_strikes') >= 8, 'ret_crusader_strikes (gate8) only after 8 points');
  // a choice node must appear in BOTH ranks (rank 1) and choices
  const full = paladinTalentAlloc(11);
  assert.equal(full.ranks.ret_choice, 1, 'choice node counts as 1 rank');
  assert.equal(full.choices.ret_choice, 'ret_choice_pursuit', 'choice option recorded');
});
