// Regression tests for the 2026-06-16 audit fixes — run: `npm test`
// Each test pins a root-cause fix so it can't silently regress.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ITEMS } from '../lib/items.generated.mjs';
import { gearScore, gearRole } from '../lib/brain.mjs';
import { World } from '../lib/world.mjs';
import { Connection } from '../lib/connection.mjs';
import { Coordinator } from '../lib/fleet_coordinator.mjs';

// H2/M10 — gear-gap DATA fix: every weapon now carries {min,max,speed} (was dropped, so weapon DPS
// scoring was dead code and weapons ranked by quality only).
test('items.generated: every weapon carries weapon {min,max,speed} DPS data', () => {
  const weapons = Object.entries(ITEMS).filter(([, d]) => d.kind === 'weapon');
  assert.ok(weapons.length >= 40, `expected the full weapon set, got ${weapons.length}`);
  for (const [id, d] of weapons) {
    assert.ok(d.weapon && typeof d.weapon.min === 'number' && typeof d.weapon.max === 'number' && typeof d.weapon.speed === 'number', `weapon ${id} is missing DPS fields`);
  }
});

// H2/M11 — bear-druid weapon scoring is DPS-dominant: a higher-DPS COMMON staff must beat a low-DPS
// UNCOMMON caster staff (the gnarled/apprentice int-stick the bot used to keep over fenreed).
test('gearScore: a bear druid prefers the higher-DPS staff over a low-DPS uncommon caster staff', () => {
  const bear = gearRole({ CLASS: 'druid', settings: { bearForm: true } });
  assert.equal(bear.bearTank, true);
  const fenreed = ITEMS.fenreed_staff, apprentice = ITEMS.apprentice_staff;
  assert.ok(fenreed && apprentice, 'fixture staves exist');
  assert.ok(gearScore(fenreed, bear) > gearScore(apprentice, bear), 'bear values the higher-DPS staff above the uncommon caster staff');
  // a PURE caster still prefers the uncommon int-stick (weapon is a stat-stick, not its damage source)
  const caster = gearRole({ CLASS: 'mage', settings: {} });
  assert.ok(gearScore(apprentice, caster) > gearScore(fenreed, caster), 'a caster still favors quality+int');
});

// pull model: social reach is by FAMILY (from the real SOCIAL_PULL_RADIUS table — murloc 8, else 5),
// proximity reach is the template aggroRadius scaled by the level gap (sim.ts), not a guessed flat 12.
test('World pull model: social radius by family; proximity radius scales with the level gap', () => {
  const w = new World();
  assert.equal(w.socialRadiusOf({ tid: 'deepfen_murloc' }), 8, 'murloc family = 8yd');
  for (const tid of ['fen_troll', 'restless_bones', 'ridge_stalker']) assert.equal(w.socialRadiusOf({ tid }), 5, `${tid} default = 5yd`);
  // ridge_stalker base aggroRadius = 11; clamp(4,20, 11 + (mobLv-myLv)*1.5)
  assert.equal(w.aggroRadiusOf({ tid: 'ridge_stalker', lv: 14 }, 14), 11, 'equal level = base radius');
  assert.equal(w.aggroRadiusOf({ tid: 'ridge_stalker', lv: 17 }, 14), 15.5, '+3 levels widens the radius');
  assert.equal(w.aggroRadiusOf({ tid: 'ridge_stalker', lv: 6 }, 14), 4, 'far below us → clamped to the 4yd floor');
  assert.equal(w.aggroRadiusOf({ tid: 'no_such_mob', lv: 14 }, 14), 12, 'unknown tid → 12yd fallback');
});

// L55 — a self-less snapshot must not throw; it keeps the previous self.
test('World.ingest: a snapshot with no self keeps the prior self and does not throw', () => {
  const w = new World();
  w.ingest({ self: { id: 1, x: 0, z: 0, lv: 5, inv: [] }, ents: [], keep: [] });
  assert.equal(w.self.lv, 5);
  assert.doesNotThrow(() => w.ingest({ ents: [], keep: [] }));   // no self field
  assert.equal(w.self.lv, 5, 'prior self retained');
});

// H10/C7 — connection classifies an auth-time server error so _onClose picks the right retry: a session
// teardown race ('already in world') is a SHORT fixed retry with the same token; a token error refreshes.
test('Connection: classifies auth-time server errors for the right retry strategy', () => {
  const conn = new Connection({ base: 'http://localhost:1', getAuth: async () => ({ token: 't', charId: 1 }) });
  conn._onMsg({ t: 'error', error: 'Character already in world.' });
  assert.equal(conn._authReject, 'inworld');
  conn._onMsg({ t: 'error', error: 'Not authenticated.' });
  assert.equal(conn._authReject, 'auth');
  conn._onMsg({ t: 'hello', pid: 9 });            // a clean connect clears the flag + resets backoff
  assert.equal(conn._authReject, null);
  assert.equal(conn.backoff, 3000);
  assert.equal(conn.ready, true);
});

// C5 — the fleet healer never commits to a single unlearnable/on-cooldown heal: the chain always carries
// a castable fallback (the bug: priest picked flash_heal <45% — unlearnable until 20 — with no fallback).
test('Coordinator.healChain: emergency heals always include a low-level fallback', () => {
  const c = new Coordinator([], () => {});
  // priest gains the mid `heal`; druid gains `regrowth`; paladin gains `flash_of_light` (all verified to
  // exist in classes.ts). Order is best-first; canCast filters by learned/cooldown/mana at runtime.
  assert.deepEqual(c.healChain('priest', 0.3).map((h) => h.id), ['flash_heal', 'heal', 'lesser_heal']);
  assert.deepEqual(c.healChain('paladin', 0.3).map((h) => h.id), ['lay_on_hands', 'flash_of_light', 'holy_light']);
  assert.deepEqual(c.healChain('paladin', 0.6).map((h) => h.id), ['flash_of_light', 'holy_light']);   // no 10-min CD spell when not critical
  assert.deepEqual(c.healChain('druid', 0.3).map((h) => h.id), ['healing_touch', 'regrowth', 'rejuvenation']);
});
