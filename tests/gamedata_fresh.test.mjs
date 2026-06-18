// CONTENT-STALENESS contract as a test: the committed lib/gamedata.version.json must match the live game
// source the generators read. When the game source is PRESENT (dev machine) and has drifted, this fails
// loudly so we re-audit the hand-mirrored aggro/flee constants + `npm run gen`. When it's ABSENT (standalone
// runtime / CI with only committed data) the test skips — the bot still runs on its committed snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { gameHash, resolveGameRoot } from '../scripts/gamedata_hash.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stampFile = resolve(root, 'lib/gamedata.version.json');

test('gamedata stamp exists and is well-formed', () => {
  assert.ok(existsSync(stampFile), 'lib/gamedata.version.json present — run `npm run gen` if missing');
  const stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
  assert.match(stamp.hash ?? '', /^[0-9a-f]{64}$/, 'stamp carries a sha256 hash');
  assert.ok(stamp.files > 0, 'stamp records a non-zero file count');
});

test('committed generated data matches the live game source (skips if source absent)', (t) => {
  const live = gameHash(resolveGameRoot(root));
  if (!live) { t.skip('game source not present — runtime uses committed data, nothing to verify'); return; }
  const stamp = JSON.parse(readFileSync(stampFile, 'utf8'));
  assert.equal(
    live.hash, stamp.hash,
    `game source drifted from the stamp (live ${live.gameCommit ?? '?'} vs stamped ${stamp.gameCommit ?? '?'}) — `
    + 're-audit lib/world.mjs aggro/flee constants, then `npm run gen`',
  );
});
