import fs from 'node:fs';

export const MAX_BOTS = 5;
export const BOT_CLASSES = ['warrior', 'paladin', 'hunter', 'rogue', 'priest', 'shaman', 'mage', 'warlock', 'druid'];
export const DEFAULT_CLASSES = ['warrior', 'priest', 'druid', 'mage', 'warlock'];

const cleanText = (value, max = 80) => String(value ?? '').trim().slice(0, max);
const cleanName = (value, fallback) => (cleanText(value, 16).replace(/[^a-z]/gi, '') || fallback).slice(0, 16);

export function defaultConfig(env = process.env) {
  const prefix = cleanText(env.FLEET_USER || 'bot');
  return {
    serverUrl: cleanText(env.SERVER_URL || 'https://worldofclaudecraft.com', 240).replace(/\/$/, ''),
    botCount: Math.max(0, Math.min(MAX_BOTS, Number(env.BOT_COUNT ?? 0) || 0)),
    sell: env.FLEET_SELL === '1',
    bots: DEFAULT_CLASSES.map((cls, i) => ({
      username: `${prefix}_${i}`,
      password: cleanText(env[`BOT_${i + 1}_PASS`] || env.FLEET_PASS || '', 240),
      characterName: cleanName(env[`BOT_${i + 1}_NAME`], `Claudebot${'ABCDE'[i]}`),
      class: cleanText(env[`BOT_${i + 1}_CLASS`] || cls).toLowerCase(),
    })),
  };
}

export function normalizeConfig(input, previous = defaultConfig({})) {
  const serverUrl = cleanText(input?.serverUrl ?? previous.serverUrl, 240).replace(/\/$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(serverUrl)) throw new Error('Server URL must begin with http:// or https://.');
  const botCount = Math.max(0, Math.min(MAX_BOTS, Math.trunc(Number(input?.botCount) || 0)));
  const source = Array.isArray(input?.bots) ? input.bots : [];
  const bots = Array.from({ length: MAX_BOTS }, (_, i) => {
    const old = previous.bots?.[i] ?? {};
    const next = source[i] ?? {};
    const cls = cleanText(next.class ?? old.class ?? DEFAULT_CLASSES[i]).toLowerCase();
    if (!BOT_CLASSES.includes(cls)) throw new Error(`Bot ${i + 1} has an invalid class.`);
    return {
      username: cleanText(next.username ?? old.username),
      password: cleanText(next.password, 240) || cleanText(old.password, 240),
      characterName: cleanName(next.characterName ?? old.characterName, `Claudebot${'ABCDE'[i]}`),
      class: cls,
    };
  });
  for (let i = 0; i < botCount; i++) {
    if (!bots[i].username) throw new Error(`Username is required for bot ${i + 1}.`);
    if (!bots[i].password) throw new Error(`Password is required for bot ${i + 1}.`);
  }
  return { serverUrl, botCount, sell: !!input?.sell, bots };
}

export function publicConfig(config) {
  return { serverUrl: config.serverUrl, botCount: config.botCount, sell: config.sell,
    bots: config.bots.map(({ username, characterName, class: cls, password }) => ({ username, characterName, class: cls, hasPassword: !!password })) };
}

export function loadConfig(file, env = process.env) {
  const fallback = defaultConfig(env);
  try { return normalizeConfig(JSON.parse(fs.readFileSync(file, 'utf8')), fallback); }
  catch { return fallback; }
}

export function saveConfig(file, config) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
}
