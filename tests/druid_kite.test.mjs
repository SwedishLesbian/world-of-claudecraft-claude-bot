// Root-kite combat invariants for the DRUID rotation (caster-primary). Verifies the decision logic
// that makes a solo druid take ~0 damage: Entangling Roots locks a single target, we nuke from range,
// and bear form is reserved for the 2+-mob emergency. Run: `node --test "bot/tests/*.test.mjs"`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { druidRotate } from '../lib/brain.mjs';
import { CLASS_KITS } from '../lib/gamedata.mjs';

// Build a fresh mock combat context. `aggro` lists the mobs currently attacking us (with positions so
// the rotation can count how many are in melee). Records every cmd/input the rotation issues.
function mkCtx({ self = {}, mob, aggro = [], rootUntil = new Map() } = {}) {
  const me = { id: 1, lv: 16, hp: 550, mhp: 550, res: 800, mres: 895, rtype: 'mana', auras: [], gcd: 0, cds: {}, inv: [], x: 0, z: 0, ...self };
  const w = {
    self: me,
    dist: (e) => Math.hypot((e.x ?? 0) - me.x, (e.z ?? 0) - me.z),
    faceTo: () => 0,
    mobsAggroOnMe: () => aggro,
  };
  const cmds = [], inputs = [];
  const ctx = {
    world: w, kit: CLASS_KITS.druid, settings: { bearForm: true }, CLASS: 'druid',
    now: () => 1_000_000, potionCdUntil: 0, dotUntil: new Map(), rootUntil,
    cmd: (p) => cmds.push(p), input: (mi, f) => inputs.push({ mi, f }),
  };
  return { ctx, mob, cmds, inputs, rootUntil };
}
const cast = (cmds, ability) => cmds.some((c) => c.cmd === 'cast' && c.ability === ability);

test('druid root-kite: a lone un-rooted target gets ROOTED first', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 22, z: 0, tid: 'ridge_stalker', aggro: 1 };
  const { ctx, cmds, rootUntil } = mkCtx({ mob, aggro: [mob] });
  druidRotate(ctx, mob);
  assert.ok(cast(cmds, 'entangling_roots'), 'casts entangling_roots on an un-rooted lone mob');
  assert.ok((rootUntil.get('root:99') ?? 0) > 1_000_000, 'tracks the root expiry so it can re-root before it lapses');
});

test('druid root-kite: an already-rooted target at range gets NUKED, not re-rooted', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 22, z: 0, tid: 'ridge_stalker', aggro: 1 };
  const rootUntil = new Map([['root:99', 1_000_000 + 11_000]]);   // freshly rooted (10s left)
  const { ctx, cmds } = mkCtx({ mob, aggro: [mob], rootUntil });
  druidRotate(ctx, mob);
  assert.ok(!cast(cmds, 'entangling_roots'), 'does NOT waste a GCD re-rooting a still-rooted mob');
  assert.ok(cast(cmds, 'moonfire') || cast(cmds, 'wrath'), 'nukes the rooted target from range');
});

test('druid root-kite: re-roots when the root is about to expire', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 22, z: 0, tid: 'ridge_stalker', aggro: 1 };
  const rootUntil = new Map([['root:99', 1_000_000 + 1_000]]);    // <2.5s left -> refresh window
  const { ctx, cmds } = mkCtx({ mob, aggro: [mob], rootUntil });
  druidRotate(ctx, mob);
  assert.ok(cast(cmds, 'entangling_roots'), 're-casts the root inside the ~2.5s buffer so it never lapses');
});

test('druid root-kite: steps away when a rooted mob is in melee range (maintain the gap)', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'ridge_stalker', aggro: 1 };  // 4yd = in melee
  const rootUntil = new Map([['root:99', 1_000_000 + 11_000]]);
  const { ctx, cmds, inputs } = mkCtx({ mob, aggro: [mob], rootUntil });
  druidRotate(ctx, mob);
  assert.ok(inputs.some((i) => i.mi && i.mi.f === 1), 'moves to open a gap from the rooted mob');
  assert.ok(!cast(cmds, 'wrath'), 'does not stand and cast while inside the mob\'s melee reach');
});

test('druid emergency: 2+ mobs in melee -> shift to BEAR (a single root can\'t hold a pack)', () => {
  const m1 = { id: 99, hp: 300, mhp: 331, x: 4, z: 0, tid: 'ridge_stalker', aggro: 1 };
  const m2 = { id: 98, hp: 300, mhp: 331, x: 3, z: 1, tid: 'ridge_stalker', aggro: 1 };
  const { ctx, cmds } = mkCtx({ mob: m1, aggro: [m1, m2] });
  druidRotate(ctx, m1);
  assert.ok(cast(cmds, 'bear_form'), 'tanks 2+ melee attackers in bear form, not caster');
});

test('druid emergency: critical HP fires barkskin + an instant heal', () => {
  const mob = { id: 99, hp: 300, mhp: 331, x: 22, z: 0, tid: 'ridge_stalker', aggro: 1 };
  const { ctx, cmds } = mkCtx({ self: { hp: 100, mhp: 550 }, mob, aggro: [mob] }); // ~18% HP
  druidRotate(ctx, mob);
  assert.ok(cast(cmds, 'barkskin'), 'pops barkskin at critical HP');
  assert.ok(cast(cmds, 'rejuvenation') || cast(cmds, 'healing_touch'), 'casts an emergency self-heal');
});
