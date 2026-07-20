// FLEE SURVIVAL — the universal "separate running from healing" fix. While fleeing a pack the bot must
// issue ONLY instant survival (a cast-time spell is cancelled by the run → the old run⇄cast-heal⇄run
// stutter that got it caught and killed). Verifies CLASS_SURVIVAL is instant-by-construction and that
// fleeSurvival never issues a cast-time heal for any class. Run: `npm test`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fleeSurvival } from '../lib/brain.mjs';
import { CLASS_KITS } from '../lib/gamedata.mjs';
import { CLASS_SURVIVAL } from '../lib/abilities.generated.mjs';

// every cast-time heal in the game — none of these may EVER be cast while fleeing.
const CAST_HEALS = new Set(['holy_light', 'flash_of_light', 'healing_touch', 'regrowth', 'healing_wave', 'lesser_heal', 'heal', 'flash_heal', 'drain_life']);

function mkCtx(cls, { self = {}, aggro = [] } = {}) {
  const me = { id: 1, lv: 20, hp: 100, mhp: 300, res: 400, mres: 400, rtype: 'mana', auras: [], gcd: 0, cds: {}, inv: [], target: null, cast: null, x: 0, z: 0, ...self };
  const w = { self: me, dist: (e) => Math.hypot((e.x ?? 0) - me.x, (e.z ?? 0) - me.z), faceTo: () => 0 };
  const cmds = [], inputs = [];
  const ctx = { world: w, kit: CLASS_KITS[cls], CLASS: cls, now: () => 1_000_000, potionCdUntil: 0, rootUntil: new Map(),
    cmd: (p) => cmds.push(p), input: (mi, f) => inputs.push({ mi, f }), setAction: () => {} };
  return { ctx, cmds, inputs };
}
const casts = (cmds) => cmds.filter((c) => c.cmd === 'cast').map((c) => c.ability);

test('CLASS_SURVIVAL: every heal/shield/defensive is INSTANT (cast 0) — instant-by-construction', () => {
  for (const [cls, s] of Object.entries(CLASS_SURVIVAL)) {
    for (const cat of ['heal', 'shield', 'defensive']) {
      if (s[cat]) assert.equal(s[cat].cast, 0, `${cls}.${cat} (${s[cat].id}) must be instant`);
    }
    // a heal entry is NEVER a cast-time heal id
    if (s.heal) assert.ok(!CAST_HEALS.has(s.heal.id), `${cls}.heal must not be a cast-time heal (${s.heal.id})`);
  }
  // spot-check the two developed classes
  assert.equal(CLASS_SURVIVAL.paladin.heal.id, 'lay_on_hands', 'paladin flee-heal = instant Lay on Hands (NOT 2.5s Holy Light)');
  assert.equal(CLASS_SURVIVAL.druid.heal.id, 'rejuvenation', 'druid flee-heal = instant Rejuvenation HoT');
});

test('fleeSurvival: PALADIN low-HP pack flee uses INSTANT lay_on_hands + divine_protection, never holy_light', () => {
  const chaser = { id: 9, x: 5, z: 0 };
  const { ctx, cmds } = mkCtx('paladin', { self: { hp: 90, mhp: 300 }, aggro: [chaser] });
  const held = fleeSurvival(ctx, [chaser]);
  const c = casts(cmds);
  assert.equal(held, false, 'paladin has no cast-time CC/escape → never holds, keeps fleeing');
  assert.ok(c.includes('lay_on_hands'), 'pops the instant emergency heal');
  assert.ok(c.includes('divine_protection'), 'pops the instant off-GCD shield');
  for (const h of CAST_HEALS) assert.ok(!c.includes(h), `must NOT cast the cast-time heal ${h}`);
});

test('fleeSurvival: DRUID roots a chaser (cast → HOLD this tick) and never casts healing_touch', () => {
  const chaser = { id: 9, x: 10, z: 0 };
  const { ctx, cmds } = mkCtx('druid', { self: { hp: 120, mhp: 300 }, aggro: [chaser] });
  const held = fleeSurvival(ctx, [chaser]);
  const c = casts(cmds);
  assert.ok(c.includes('entangling_roots'), 'roots the chaser to break the chase');
  assert.equal(held, true, 'entangling_roots is a 1.5s cast → HOLD so it lands (do not move & cancel it)');
  assert.ok(!c.includes('healing_touch') && !c.includes('regrowth'), 'never a cast-time heal while fleeing');
});

test('fleeSurvival: DRUID with the chaser already rooted layers the INSTANT rejuvenation HoT and keeps fleeing', () => {
  const chaser = { id: 9, x: 10, z: 0 };
  const { ctx, cmds } = mkCtx('druid', { self: { hp: 120, mhp: 300 }, aggro: [chaser] });
  ctx.rootUntil.set('root:9', 1_000_000 + 13_000);   // already rooted → no re-root
  const held = fleeSurvival(ctx, [chaser]);
  const c = casts(cmds);
  assert.equal(held, false, 'nothing to hold for → keep running');
  assert.ok(c.includes('rejuvenation'), 'layers the instant HoT while running');
  assert.ok(!c.includes('healing_touch'), 'still never a cast-time heal');
});

test('fleeSurvival: HUNTER/ROGUE pop their instant escape buff (no cast-time anything)', () => {
  for (const cls of ['hunter', 'rogue']) {
    const chaser = { id: 9, x: 6, z: 0 };
    const { ctx, cmds } = mkCtx(cls, { self: { hp: 90, mhp: 300 }, aggro: [chaser] });
    const held = fleeSurvival(ctx, [chaser]);
    const c = casts(cmds);
    assert.equal(held, false, `${cls} escape is instant → no hold`);
    assert.equal(c.includes(CLASS_SURVIVAL[cls].escape.id), true, `${cls} pops ${CLASS_SURVIVAL[cls].escape.id}`);
  }
});

test('fleeSurvival: never issues a cast-time heal for ANY class at low HP', () => {
  for (const cls of Object.keys(CLASS_KITS)) {
    const chaser = { id: 9, x: 8, z: 0 };
    const { ctx, cmds } = mkCtx(cls, { self: { hp: 60, mhp: 300, inv: [{ id: 'minor_healing_potion', count: 5 }] }, aggro: [chaser] });
    fleeSurvival(ctx, [chaser]);
    for (const h of CAST_HEALS) assert.ok(!casts(cmds).includes(h), `${cls}: must NOT cast ${h} while fleeing`);
  }
});
