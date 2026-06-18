// Combat-rotation invariants for the GENERIC (non-druid) loop. Kept in its own file so it doesn't
// collide with concurrent edits to core.test.mjs. Run: `node --test "bot/tests/*.test.mjs"`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COND_ABILITY_GATE } from '../lib/brain.mjs';

test('combatRotate conditional gates: execute only <20% mob HP; combo finishers only at >=4 points', () => {
  const g = COND_ABILITY_GATE;
  // execute (warrior) — server requiresTargetHpBelow 0.2, so the loop must hold it until the kill window
  assert.equal(g.execute({}, { hp: 19, mhp: 100 }), true, 'execute fires at 19% HP');
  assert.equal(g.execute({}, { hp: 20, mhp: 100 }), false, 'execute held at exactly 20% HP');
  assert.equal(g.execute({}, { hp: 80, mhp: 100 }), false, 'execute held at 80% HP (would be rejected)');
  // eviscerate / ferocious_bite — spendsCombo, so firing at 0 combo wastes a GCD; hold until >=4.
  // The snapshot field is `combo` (server selfWireJson: combo: p.comboPoints) — NOT `comboPoints`,
  // which the gate read by mistake (always undefined → finishers were permanently held).
  for (const fin of ['eviscerate', 'ferocious_bite']) {
    assert.equal(g[fin]({ combo: 5 }), true, `${fin} fires at 5 combo`);
    assert.equal(g[fin]({ combo: 4 }), true, `${fin} fires at 4 combo`);
    assert.equal(g[fin]({ combo: 3 }), false, `${fin} held at 3 combo`);
    assert.equal(g[fin]({ combo: 0 }), false, `${fin} held at 0 combo (no wasted GCD)`);
    assert.equal(g[fin]({}), false, `${fin} held when combo undefined`);
  }
});
