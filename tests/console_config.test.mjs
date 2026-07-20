import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, normalizeConfig, publicConfig, saveConfig } from '../lib/console_config.mjs';

test('console configuration clamps the fleet to five bots', () => {
  const base = defaultConfig({ SERVER_URL: 'http://localhost:8787', FLEET_PASS: 'secret' });
  const config = normalizeConfig({ ...base, botCount: 99 }, base);
  assert.equal(config.botCount, 5);
  assert.equal(config.bots.length, 5);
});

test('blank submitted passwords preserve saved credentials', () => {
  const base = defaultConfig({ SERVER_URL: 'http://localhost:8787', FLEET_PASS: 'secret' });
  const config = normalizeConfig({ ...publicConfig(base), botCount: 1, bots: [{ ...publicConfig(base).bots[0], password: '' }] }, base);
  assert.equal(config.bots[0].password, 'secret');
});

test('public configuration never exposes passwords', () => {
  const config = defaultConfig({ SERVER_URL: 'http://localhost:8787', FLEET_PASS: 'secret' });
  const visible = publicConfig(config);
  assert.equal(JSON.stringify(visible).includes('secret'), false);
  assert.equal(visible.bots[0].hasPassword, true);
});

test('saved credential configuration is owner-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-config-'));
  const file = path.join(dir, 'console-config.json');
  saveConfig(file, defaultConfig({ SERVER_URL: 'http://localhost:8787', FLEET_PASS: 'secret' }));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});
