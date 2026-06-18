// get-token.mjs — обходит Cloudflare Turnstile на /api/login через настоящий браузер
// и кладёт серверный токен в bot/.tokens/<user>.json, откуда autobot.mjs его подхватывает
// при старте (loadToken → reuse ~6 дней, без повторного REST-логина).
//
// Зачем: живой сервер v0.6+ добавил Turnstile-гейт на /api/login и /api/register
// (403 {"error":"verification failed, please try again"}). Бот сам токен Turnstile
// не делает, но WS-хэндшейк идёт по серверному токену и Turnstile НЕ требует.
// Значит: один раз залогиниться через браузер (Turnstile проходит сам в headed-режиме,
// либо ты кликаешь чекбокс в видимом окне) → достать токен → бот живёт неделю.
//
// Запуск:  node bot/get-token.mjs            (видимое окно — рекомендуется)
//          HEADLESS=1 node bot/get-token.mjs (без окна — Turnstile часто блокирует)
//
// Креды берутся из bot/.env.bot (BOT_USER/BOT_PASS) либо из env.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// --- .env.bot → process.env (не перетираем уже заданные) ---
try {
  const env = fs.readFileSync(path.join(HERE, '.env.bot'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const BASE = (process.env.SERVER_URL ?? 'https://worldofclaudecraft.com').replace(/\/$/, '');
const USER = process.env.BOT_USER ?? 'sl_autodruid71';
const PASS = process.env.BOT_PASS;
const CLASS = (process.env.BOT_CLASS ?? 'druid').toLowerCase();
const HEADLESS = process.env.HEADLESS === '1';
const WAIT_MS = Number(process.env.TURNSTILE_WAIT_MS ?? 240000); // до 4 мин на прохождение Turnstile

if (!PASS) { console.error('FATAL: BOT_PASS не задан (bot/.env.bot или env)'); process.exit(1); }

// --- найти исполняемый браузер: CHROMIUM_PATH → кэш Playwright → системный Chrome/Chromium ---
function findChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  // 1) кэш Playwright (Google Chrome for Testing / Chromium), если он есть
  const root = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  let dirs = [];
  try { dirs = fs.readdirSync(root).filter((d) => /^chromium-\d+$/.test(d)); } catch {}
  dirs.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));   // самые свежие сначала
  for (const d of dirs) {
    for (const c of [
      path.join(root, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      path.join(root, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'),
    ]) if (fs.existsSync(c)) return c;
  }
  // 2) обычный браузер, установленный в системе (macOS) — puppeteer-core им рулит напрямую.
  //    Системный Chrome с реальной историей Cloudflare-у доверяет ОХОТНЕЕ headless-сборки.
  for (const c of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]) if (fs.existsSync(c)) return c;
  throw new Error('Не нашёл Chrome/Chromium. Установи Google Chrome или задай CHROMIUM_PATH=/путь/к/браузеру');
}

// --- запись токена в формате connection.mjs saveToken() ---
function saveToken(token, charId) {
  const dir = path.join(HERE, '.tokens');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, encodeURIComponent(USER) + '.json');
  fs.writeFileSync(file, JSON.stringify({ token, charId, savedAt: Date.now() }));
  return file;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const exe = findChromium();
  console.log(`[token] Chromium: ${exe}`);
  console.log(`[token] сервер: ${BASE}  пользователь: ${USER}  класс: ${CLASS}`);
  console.log(`[token] режим: ${HEADLESS ? 'headless (Turnstile может заблокировать)' : 'видимое окно — кликни чекбокс Turnstile, если попросит'}`);

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: HEADLESS,
    userDataDir: path.join(HERE, '.cf-profile'), // постоянный профиль → Cloudflare быстрее доверяет
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=520,760'],
    defaultViewport: null,
  });

  let serverToken = null;

  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());

    // ПЕРЕХВАТ: ловим серверный токен прямо из ответа /api/login (основной путь —
    // ты просто проходишь Turnstile и жмёшь «войти», токен прилетает сам)
    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (/\/api\/(login|register)$/.test(u)) {
          const b = await resp.json().catch(() => ({}));
          console.log(`[token] ← ${resp.status()} ${u.replace(BASE, '')} ${JSON.stringify(b).slice(0, 120)}`);
          if (resp.status() === 200 && b && b.token) { serverToken = b.token; console.log('[token] ✓ перехватил серверный токен'); }
        }
      } catch {}
    });

    await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);

    // 1) открыть онлайн-режим → показать панель логина (она скрыта на стартовом экране)
    await page.evaluate(() => {
      const click = (id) => { const e = document.getElementById(id); if (e && e.offsetParent !== null) { e.click(); return true; } return false; };
      // mode-select: «Online»; запасной путь — пункт меню «Login/Register»
      if (!click('btn-online')) click('nav-btn-login');
    });

    // 2) дождаться появления поля логина и вписать креды по id
    let filled = { user: false, pass: false };
    const fillDeadline = Date.now() + 20000;
    while (Date.now() < fillDeadline) {
      filled = await page.evaluate((u, p) => {
        const setVal = (id, val) => {
          const el = document.getElementById(id);
          if (!el || el.offsetParent === null) return false;
          const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
          setter ? setter.call(el, val) : (el.value = val);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        };
        return { user: setVal('login-user', u), pass: setVal('login-pass', p) };
      }, USER, PASS);
      if (filled.user && filled.pass) break;
      // вдруг панель ещё не открыта — ткнём снова
      await page.evaluate(() => { const e = document.getElementById('btn-online'); if (e && e.offsetParent !== null) e.click(); });
      await sleep(800);
    }
    console.log(`[token] поля формы: логин=${filled.user ? 'ок ✓' : 'НЕ НАЙДЕН'} пароль=${filled.pass ? 'ок ✓' : 'НЕ НАЙДЕН'}`);
    if (!filled.user || !filled.pass) console.log('   (если поля пустые — открой панель входа в окне вручную, креды впишутся повторно)');
    console.log('\n👉 В окне: пройди Turnstile (чекбокс) и нажми «Log In».');
    console.log('   Логин/пароль уже вписаны. Жду токен…\n');

    // подстраховка: продолжаем перевписывать креды, пока ждём (на случай если ты перешёл назад/вперёд)
    const refill = setInterval(() => {
      page.evaluate((u, p) => {
        const f = (id, val) => { const el = document.getElementById(id); if (el && el.offsetParent !== null && !el.value) { const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; s ? s.call(el, val) : (el.value = val); el.dispatchEvent(new Event('input', { bubbles: true })); } };
        f('login-user', u); f('login-pass', p);
      }, USER, PASS).catch(() => {});
    }, 2000);

    // ждём перехвата токена (после твоего клика «войти»); попутно раз в 5с печатаем состояние Turnstile
    const deadline = Date.now() + WAIT_MS;
    let tick = 0;
    while (Date.now() < deadline && !serverToken) {
      if (tick++ % 5 === 0) {
        const st = await page.evaluate(() => {
          const cont = document.getElementById('cf-turnstile-container');
          const iframe = cont ? cont.querySelector('iframe') : null;
          let resp = '';
          try { resp = (window.turnstile && window.turnstile.getResponse && window.turnstile.getResponse()) || ''; } catch {}
          const hidden = document.querySelector('input[name="cf-turnstile-response"]');
          return { hasWidget: !!iframe, tokenLen: (resp || (hidden && hidden.value) || '').length, err: (document.getElementById('login-error')?.textContent || '').trim().slice(0, 80) };
        }).catch(() => ({}));
        console.log(`[token] Turnstile: виджет=${st.hasWidget ? 'есть' : 'НЕТ'} токен=${st.tokenLen || 0}симв${st.err ? '  ошибка-формы: ' + st.err : ''}`);
      }
      await sleep(1000);
    }
    clearInterval(refill);

    if (!serverToken) throw new Error('токен не получен за отведённое время (Turnstile не пройден или вход не нажат)');
    console.log('[token] серверный токен получен');

    // находим нужного персонажа (charId)
    const chars = await page.evaluate(async (t) => {
      const r = await fetch('/api/characters', { headers: { Authorization: 'Bearer ' + t } });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, serverToken);

    const list = chars.body.characters ?? [];
    const ch = list.find((c) => c.class === CLASS) ?? list[0];
    if (!ch) throw new Error(`нет персонажей: ${chars.status} ${JSON.stringify(chars.body)}`);
    console.log(`[token] персонаж: ${ch.name} (id ${ch.id}, ${ch.class}, lvl ${ch.level})`);

    const file = saveToken(serverToken, ch.id);
    console.log(`\n✅ Токен сохранён: ${file}`);
    console.log('   Теперь запускай бота как обычно — он подхватит токен (loadToken) на старте.');
    console.log('   Токен живёт ~неделю; когда снова пойдут 403, прогони этот скрипт ещё раз.');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('[token] ОШИБКА:', e.message); process.exit(1); });
