// Uses a real browser to complete Cloudflare Turnstile on /api/login, then stores
// the server token in .tokens/<user>.json for the bot to reuse at startup.
//
// The live realm protects /api/login and /api/register with Turnstile. The bot
// cannot complete that challenge directly, but its WebSocket handshake accepts
// the resulting server token. Authenticate once in the browser and reuse the
// captured token until it expires (typically about one week).
//
// Run:  node get-token.mjs             (visible browser; recommended)
//       HEADLESS=1 node get-token.mjs  (Turnstile often blocks headless browsers)
//
// Credentials come from the dashboard configuration, .env.bot, or the process environment.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { findChromium, resolveBrowserAccount } from './lib/token_browser_config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Load .env.bot without overwriting variables already present in the environment.
try {
  const env = fs.readFileSync(path.join(HERE, '.env.bot'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {}

const BASE = (process.env.SERVER_URL ?? 'https://worldofclaudecraft.com').replace(/\/$/, '');
let account;
try { account = resolveBrowserAccount({ env: process.env, configFile: path.join(HERE, 'console-config.json') }); }
catch (error) { console.error('[token] ERROR:', error.message); process.exit(1); }
const { username: USER, password: PASS, className: CLASS, characterName: CHARACTER_NAME } = account;
const HEADLESS = process.env.HEADLESS === '1';
const WAIT_MS = Number(process.env.TURNSTILE_WAIT_MS ?? 240000); // Allow up to four minutes for Turnstile.

// Write the token in the format expected by connection.mjs.
function saveToken(token, charId) {
  const dir = path.join(HERE, '.tokens');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, encodeURIComponent(USER) + '.json');
  fs.writeFileSync(file, JSON.stringify({ token, charId, savedAt: Date.now() }), { mode: 0o600 });
  return file;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const exe = findChromium(process.env, process.platform);
  console.log(`[token] Chromium: ${exe}`);
  console.log(`[token] server: ${BASE}  username: ${USER}  class: ${CLASS}`);
  console.log(`[token] mode: ${HEADLESS ? 'headless (Turnstile may block it)' : 'visible browser (complete the Turnstile checkbox if prompted)'}`);

  const browser = await puppeteer.launch({
    executablePath: exe,
    headless: HEADLESS,
    userDataDir: path.join(HERE, '.cf-profile'), // Reuse the profile to reduce repeat Cloudflare challenges.
    args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--window-size=1280,960'],
    defaultViewport: { width: 1280, height: 900 },
  });

  let serverToken = null;

  try {
    const page = (await browser.pages())[0] ?? (await browser.newPage());

    // A successful login can survive in the persistent browser profile. Reuse
    // the bearer token from its character request instead of forcing another login.
    page.on('request', (request) => {
      try {
        if (/\/api\/characters$/.test(request.url())) {
          const authorization = request.headers().authorization ?? '';
          if (/^Bearer\s+\S+$/i.test(authorization)) serverToken ||= authorization.replace(/^Bearer\s+/i, '');
        }
      } catch {}
    });

    // Capture the server token directly from the login or registration response.
    page.on('response', async (resp) => {
      try {
        const u = resp.url();
        if (/\/api\/(login|register)$/.test(u)) {
          const b = await resp.json().catch(() => ({}));
          console.log(`[token] ← ${resp.status()} ${u.replace(BASE, '')}${b?.error ? ` error=${String(b.error).slice(0, 80)}` : ''}`);
          if (resp.status() === 200 && b && b.token) { serverToken = b.token; console.log('[token] ✓ captured server token'); }
        }
      } catch {}
    });

    await page.goto(BASE + '/', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(1500);

    // Open online mode to reveal the login panel hidden on the initial screen.
    await page.evaluate(() => {
      const click = (id) => { const e = document.getElementById(id); if (e && e.offsetParent !== null) { e.click(); return true; } return false; };
      // Prefer the Online button and fall back to the Login/Register navigation item.
      if (!click('btn-online')) click('nav-btn-login');
    });

    // Wait for the login fields and fill them by element ID.
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
      // Retry opening the panel if it is not visible yet.
      await page.evaluate(() => { const e = document.getElementById('btn-online'); if (e && e.offsetParent !== null) e.click(); });
      await sleep(800);
    }
    console.log(`[token] form fields: username=${filled.user ? 'ready ✓' : 'NOT FOUND'} password=${filled.pass ? 'ready ✓' : 'NOT FOUND'}`);
    if (!filled.user || !filled.pass) console.log('   If either field is empty, open the login panel manually; the credentials will be filled again.');
    console.log('\n👉 In the browser, complete Turnstile if shown and select “Log In”.');
    console.log('   The username and password are already filled in. Waiting for the token…\n');

    // Refill empty credentials while waiting in case navigation clears the form.
    const refill = setInterval(() => {
      page.evaluate((u, p) => {
        const f = (id, val) => { const el = document.getElementById(id); if (el && el.offsetParent !== null && !el.value) { const s = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set; s ? s.call(el, val) : (el.value = val); el.dispatchEvent(new Event('input', { bubbles: true })); } };
        f('login-user', u); f('login-pass', p);
      }, USER, PASS).catch(() => {});
    }, 2000);

    // Wait for the token and periodically report Turnstile state.
    const deadline = Date.now() + WAIT_MS;
    let tick = 0;
    let submittedToken = '';
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
        console.log(`[token] Turnstile: widget=${st.hasWidget ? 'present' : 'NOT FOUND'} token=${st.tokenLen || 0} chars${st.err ? '  form error: ' + st.err : ''}`);
      }
      const turnstileToken = await page.evaluate(() => {
        try { return (window.turnstile && window.turnstile.getResponse && window.turnstile.getResponse()) || ''; } catch { return ''; }
      }).catch(() => '');
      if (turnstileToken && turnstileToken !== submittedToken) {
        submittedToken = turnstileToken;
        await page.focus('#login-pass');
        await page.keyboard.press('Enter');
        console.log('[token] Turnstile completed; submitted the login form once.');
      }
      await sleep(1000);
    }
    clearInterval(refill);

    if (!serverToken) throw new Error('No token was received before the timeout. Complete Turnstile and select Log In.');
    console.log('[token] server token received');

    // Select a character matching BOT_CLASS, or fall back to the first character.
    const chars = await page.evaluate(async (t) => {
      const r = await fetch('/api/characters', { headers: { Authorization: 'Bearer ' + t } });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    }, serverToken);

    const list = chars.body.characters ?? [];
    let ch = list.find((c) => c.class === CLASS) ?? list[0];
    if (!ch) {
      const created = await page.evaluate(async (token, name, className) => {
        const r = await fetch('/api/characters', {
          method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, class: className }),
        });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      }, serverToken, CHARACTER_NAME, CLASS);
      if (created.status !== 200) throw new Error(`Character creation failed: ${created.status} ${JSON.stringify(created.body)}`);
      ch = created.body;
      console.log(`[token] created configured ${CLASS} character`);
    }
    console.log(`[token] character: ${ch.name} (id ${ch.id}, ${ch.class}, level ${ch.level})`);

    const file = saveToken(serverToken, ch.id);
    console.log(`\n✅ Token saved: ${file}`);
    console.log('   Start the dashboard normally; the bot will load this token at startup.');
    console.log('   Tokens typically last about one week. Run this script again if authentication starts returning HTTP 403.');
  } finally {
    await browser.close();
  }
})().catch((e) => { console.error('[token] ERROR:', e.message); process.exit(1); });
