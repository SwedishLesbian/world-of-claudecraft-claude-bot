import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromiumCandidates, resolveBrowserAccount } from '../lib/token_browser_config.mjs';

test('browser login uses the selected dashboard account', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'woc-token-config-'));
  const file = path.join(dir, 'console-config.json');
  fs.writeFileSync(file, JSON.stringify({ botCount: 2, bots: [
    { username: 'first', password: 'secret-one', class: 'mage' },
    { username: 'second', password: 'secret-two', class: 'rogue' },
  ] }));
  assert.deepEqual(resolveBrowserAccount({ env: { TOKEN_BOT_INDEX: '2' }, configFile: file }), {
    username: 'second', password: 'secret-two', className: 'rogue', characterName: 'Claudebot',
  });
});

test('partial environment credentials are rejected instead of mixed with saved credentials', () => {
  assert.throws(() => resolveBrowserAccount({ env: { BOT_USER: 'only-user' }, configFile: '/missing' }), /must both be set/);
});

test('Linux browser discovery includes common Chrome and Chromium paths', () => {
  const candidates = chromiumCandidates({}, 'linux');
  assert.ok(candidates.includes('/usr/bin/google-chrome'));
  assert.ok(candidates.includes('/usr/bin/chromium'));
});
