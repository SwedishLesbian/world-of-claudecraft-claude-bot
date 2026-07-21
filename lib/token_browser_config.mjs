import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveBrowserAccount({ env = process.env, configFile }) {
  if (env.BOT_USER || env.BOT_PASS) {
    if (!env.BOT_USER || !env.BOT_PASS) throw new Error('BOT_USER and BOT_PASS must both be set when either is provided.');
    return {
      username: env.BOT_USER, password: env.BOT_PASS,
      className: (env.BOT_CLASS || 'druid').toLowerCase(), characterName: env.BOT_NAME || 'Claudebot',
    };
  }

  let config;
  try { config = JSON.parse(fs.readFileSync(configFile, 'utf8')); }
  catch { throw new Error('No browser-login credentials found. Save an account in the dashboard or set BOT_USER and BOT_PASS.'); }

  const count = Math.min(Number(config.botCount) || 0, 5);
  const index = Number(env.TOKEN_BOT_INDEX ?? 1) - 1;
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new Error(`TOKEN_BOT_INDEX must select a configured bot from 1 through ${count}.`);
  }
  const bot = config.bots?.[index];
  if (!bot?.username || !bot?.password) throw new Error(`Bot ${index + 1} is missing a username or password.`);
  return {
    username: bot.username, password: bot.password,
    className: String(bot.class || 'druid').toLowerCase(), characterName: String(bot.characterName || 'Claudebot'),
  };
}

export function chromiumCandidates(env = process.env, platform = process.platform) {
  const candidates = [];
  if (env.CHROMIUM_PATH) candidates.push(env.CHROMIUM_PATH);
  if (platform === 'linux') candidates.push(
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium',
    '/usr/bin/chromium-browser', '/snap/bin/chromium',
  );
  if (platform === 'darwin') candidates.push(
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  );
  if (platform === 'win32') {
    for (const root of [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)) {
      candidates.push(path.join(root, 'Google/Chrome/Application/chrome.exe'), path.join(root, 'Chromium/Application/chrome.exe'));
    }
  }
  return [...new Set(candidates)];
}

export function findChromium(env = process.env, platform = process.platform) {
  for (const candidate of chromiumCandidates(env, platform)) if (fs.existsSync(candidate)) return candidate;
  if (platform === 'darwin') {
    const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
    let dirs = [];
    try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)); } catch {}
    dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const d of dirs) {
      for (const candidate of [
        path.join(root, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
        path.join(root, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
      ]) if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Chrome/Chromium was not found. Install Google Chrome or set CHROMIUM_PATH to the browser executable.');
}
