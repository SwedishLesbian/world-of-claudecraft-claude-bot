// IN-BRAWL SURVIVAL — the lethal hole at aggro==combatCap. The old logic healed only with <2 attackers and
// fled only with >cap attackers, so a class fighting EXACTLY `cap` mobs (a paladin on a 2-pull) neither healed
// nor fled and tanked them to death at low HP with its heal unused. These tests pin the fix: heal/pot during
// any pull we've committed to (aggro<=cap), and flee when critically low even within capacity. The survival
// decision happens early in decide() (before any World-class lookups), so we drive decide() with a light mock
// and read the decision off the captured commands / ctx.fleeing — a downstream throw from the partial mock is
// irrelevant and swallowed. Run: node --test "tests/*.test.mjs"
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide } from '../lib/brain.mjs';
import { CLASS_KITS, combatCap } from '../lib/gamedata.mjs';

const HEAL_IDS = /holy_light|flash_of_light|lay_on_hands|rejuvenation|renew|healing_wave/;

// A live AT-LEVEL mob attacking us at (x,0) — weighted threat 1 each, so aggroLoad == attacker count here.
const atk = (id, x) => ({ id, k: 'mob', tid: 'restless_bones', lv: 18, hp: 50, mhp: 80, x, z: 0, dead: false, h: true, aggro: 1 });

function mkCtx({ cls = 'paladin', lv = 18, hpFrac = 1, res = 1000, inv = [], aggro = [] } = {}) {
  const mhp = 600;
  const self = {
    id: 1, lv, hp: Math.round(mhp * hpFrac), mhp, res, mres: 1000, rtype: 'mana',
    x: -69, z: -8, auras: [], cds: {}, gcd: 0, cast: false, inv, dead: false, target: undefined,
  };
  const w = {
    self, pid: 1,
    mobsAggroOnMe: () => aggro, mobs: () => aggro, hostilesNear: () => [], groundObjects: () => [], players: () => [],
    aggroLoad: () => aggro.length,                      // at-level attackers → weighted load == count
    pos: () => ({ x: self.x, z: self.z }), dist: (e) => Math.hypot((e.x ?? 0) - self.x, (e.z ?? 0) - self.z),
    faceTo: () => 0, target: () => null,
    // stubs so a healthy run that falls through to target-selection doesn't throw before we read the decision
    nearestSafeMob: () => null, questMob: () => null, joinCount: () => 0, joiners: () => [],
  };
  const cmds = [], inputs = [];
  const ctx = {
    world: w, CLASS: cls, kit: CLASS_KITS[cls], settings: {}, now: () => 1_000_000, selfHealUntil: 0, potionCdUntil: 0,
    cmd: (p) => cmds.push(p), input: (mi, f) => inputs.push({ mi, f }), setAction: () => {}, log: () => {}, nav: {},
  };
  return { ctx, cmds, inputs };
}
const run = (ctx) => { try { decide(ctx); } catch { /* partial mock throws downstream; the survival decision already ran */ } };

test('survival: paladin fighting EXACTLY cap mobs at <50% HP HEALS (closes the aggro==cap hole)', () => {
  assert.equal(combatCap('paladin'), 2, 'precondition: paladin brawl cap is 2');
  const { ctx, cmds } = mkCtx({ hpFrac: 0.40, aggro: [atk(10, 4), atk(11, 5)] });   // 40% HP, 2 attackers = cap, mana full
  run(ctx);
  assert.ok(cmds.some((c) => c.cmd === 'cast' && HEAL_IDS.test(c.ability)),
    'casts a self-heal during a 2-pull (old code gated heal to aggro<2 → it died with heal unused)');
  assert.notEqual(ctx.fleeing, true, 'a healable brawl does not panic-flee');
});

test('survival: critically low with NO heal available FLEES even within capacity', () => {
  const { ctx } = mkCtx({ hpFrac: 0.15, res: 0, inv: [], aggro: [atk(10, 4), atk(11, 5)] });  // 15% HP, OOM, no potion
  run(ctx);
  assert.equal(ctx.fleeing, true, 'sets fleeing at <CRIT_HP even at aggro==cap (no more tank-to-death at 15%)');
});

test('survival: a LONE mob is NEVER fled even at critical HP (turn and fight/heal it, do not bare our back)', () => {
  const { ctx } = mkCtx({ hpFrac: 0.10, aggro: [atk(10, 4)] });   // 10% HP, ONE attacker
  run(ctx);
  assert.notEqual(ctx.fleeing, true, 'one attacker is always winnable — fleeing only gets us chipped from behind');
});

test('survival: fleeing RELEASES the moment a pack thins to a lone mob (no fleeing the last straggler to death)', () => {
  const { ctx } = mkCtx({ hpFrac: 0.11, aggro: [atk(10, 4)] });   // mid-flee, pack already down to 1, still hurt
  ctx.fleeing = true;
  run(ctx);
  assert.equal(ctx.fleeing, false, 'down to 1 attacker → stop fleeing and turn (was fleeing a single mob to 6%)');
});

test('survival: a HEALTHY brawl within capacity is NOT fled (kills-not-caution preserved)', () => {
  const { ctx } = mkCtx({ hpFrac: 0.90, aggro: [atk(10, 4), atk(11, 5)] });  // 90% HP, 2 attackers
  run(ctx);
  assert.notEqual(ctx.fleeing, true, 'does not flee a brawlable pack while healthy — death is cheap, lean into the kill');
});

test('survival: critically low uses a POTION during the brawl when one is carried', () => {
  const { ctx, cmds } = mkCtx({ hpFrac: 0.18, res: 0, inv: [{ itemId: 'minor_healing_potion', qty: 5 }], aggro: [atk(10, 4), atk(11, 5)] });
  run(ctx);
  assert.ok(cmds.some((c) => c.cmd === 'use'), 'quaffs a healing potion during the 2-pull (instant — never tanks to death OOM)');
});
