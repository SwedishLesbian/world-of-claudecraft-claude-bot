import assert from 'node:assert/strict';
import test from 'node:test';
import { tacticalView } from '../lib/botstate.mjs';

test('tactical viewport projects only bounded, display-safe nearby entities', () => {
  const self = { id: 1, x: 10, z: 20, hp: 80, mhp: 100, target: 2, token: 'never-project-me' };
  const world = { self, ents: new Map([
    [1, self],
    [2, { id: 2, k: 'mob', tid: 'test_wolf', nm: 'Wolf', x: 13, z: 24, hp: 5, mhp: 10, aggro: 1, privateField: 'hidden' }],
    [3, { id: 3, k: 'player', nm: 'Friend', x: 15, z: 20, hp: 10, mhp: 10 }],
    [4, { id: 4, k: 'mob', nm: 'Too far', x: 100, z: 100, hp: 1, mhp: 1 }],
    [5, { id: 5, k: 'unsupported', nm: 'Ignored', x: 11, z: 20 }],
  ]) };

  const view = tacticalView(world, 20);
  assert.deepEqual(view.self, { x: 10, z: 20, hpPct: 0.8 });
  assert.equal(view.entities.length, 2);
  assert.deepEqual(view.entities.map((entity) => entity.id), [2, 3]);
  assert.equal(view.entities[0].target, true);
  assert.equal(view.entities[0].aggro, true);
  assert.equal('privateField' in view.entities[0], false);
  assert.equal(JSON.stringify(view).includes('never-project-me'), false);
});

test('tactical viewport is absent until the bot has a valid position', () => {
  assert.equal(tacticalView({ self: null, ents: new Map() }), null);
});
