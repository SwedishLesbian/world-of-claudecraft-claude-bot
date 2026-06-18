// Vendor coverage is DATA-DRIVEN from the game's vendorItems (lib/vendors.generated.mjs). These guard the
// two vendors the old hardcoded VENDOR_STOCK silently dropped: zone1 smith_haldren (only L3-7 starter
// armor+weapons) and zone3 armorer_hode (only L15-18 weapons). A future content patch that adds/moves a
// vendor must be picked up by regenerating — not by hand-editing brain.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vendorGear, gearVendorsNear, needsVendorGear, buyGear } from '../lib/brain.mjs';
import { VENDORS } from '../lib/vendors.generated.mjs';

// minimal ctx for a vendor at `tid` with the given self state, plus that vendor's npc entity in range.
function ctxAt(tid, self, cls = 'paladin') {
  const ents = new Map([[1, { id: 1, k: 'npc', tid }]]);
  const cmds = [];
  return {
    CLASS: cls, settings: {},
    world: { self, ents, pos: () => ({ x: VENDORS[tid].pos.x, z: VENDORS[tid].pos.z }) },
    now: () => 1e9, cmd: (c) => cmds.push(c), log: () => {}, setAction: () => {},
    _cmds: cmds,
  };
}

test('vendor data exposes the two previously-dropped gear vendors', () => {
  assert.ok(vendorGear('smith_haldren').length > 0, 'zone1 smith_haldren sells equippable gear');
  assert.ok(vendorGear('armorer_hode').length > 0, 'zone3 armorer_hode sells equippable weapons');
  // and the food-only vendor is NOT treated as a gear vendor
  assert.equal(vendorGear('trader_wilkes').length, 0, 'trader_wilkes is consumables-only');
});

test('a rich character with an empty weapon slot BUYS from armorer_hode (zone3 weapon vendor)', () => {
  const self = { inv: [], copper: 999999, equip: {} };       // empty mainhand -> any weapon is an upgrade
  const ctx = ctxAt('armorer_hode', self);
  assert.ok(needsVendorGear(ctx, 'armorer_hode'), 'recognises an affordable weapon upgrade');
  assert.ok(buyGear(ctx, 'armorer_hode'), 'issues a buy');
  assert.equal(ctx._cmds[0]?.cmd, 'buy', 'sent a buy command');
  assert.ok(vendorGear('armorer_hode').includes(ctx._cmds[0].item), 'bought an item the vendor actually stocks');
});

test('a fresh character buys starter gear from zone1 smith_haldren', () => {
  const self = { inv: [], copper: 999999, equip: {} };
  const ctx = ctxAt('smith_haldren', self);
  assert.ok(needsVendorGear(ctx, 'smith_haldren'), 'zone1 starter armor/weapons register as upgrades');
  assert.ok(buyGear(ctx, 'smith_haldren'), 'issues a buy at smith_haldren');
});

test('cannot afford -> no buy (gates on copper)', () => {
  const self = { inv: [], copper: 0, equip: {} };
  const ctx = ctxAt('armorer_hode', self);
  assert.equal(needsVendorGear(ctx, 'armorer_hode'), false, 'broke char does not trip a gear run');
  assert.equal(buyGear(ctx, 'armorer_hode'), false, 'and buys nothing');
});

test('gearVendorsNear sorts vendors by distance from a position', () => {
  const near = gearVendorsNear({ x: VENDORS.smith_haldren.pos.x, z: VENDORS.smith_haldren.pos.z });
  assert.equal(near[0].tid, 'smith_haldren', 'nearest gear vendor to zone1 hub is smith_haldren');
});
