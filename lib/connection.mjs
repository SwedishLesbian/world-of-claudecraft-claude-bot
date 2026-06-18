// WebSocket + REST transport with self-healing (re)connect.
//
// Resilience contract (every failure path routes back into the same retry loop — no dead ends):
//  - the FIRST connect is as crash-proof as a reconnect: if getAuth() rejects (server down, DNS,
//    transient 5xx) we schedule a retry instead of throwing into an unhandled rejection (the old
//    `start()` awaited getAuth() then `_open()`, so an auth failure meant no socket was ever created,
//    no 'close' ever fired, and the bot became a permanent zombie).
//  - a plain network drop REUSES the cached token (valid ~7 days) for the new WS auth instead of
//    re-running REST /api/login every time — avoids hammering the 20/60s auth rate limit, esp. for
//    the 5-bot fleet behind one IP.
//  - a server-side 'character already in world' (the new auth landing before the old session tore
//    down) is a SHORT fixed retry with the SAME token, NOT a doubling network backoff — the old code
//    treated it like a hard failure and escalated to 30s offline (38 such loops in live.log).
//  - an auth/token rejection refreshes the token via getAuth() and never opens a socket with a stale one.
import WebSocket from 'ws';
import fs from 'node:fs';

// --- token cache (disk) ----------------------------------------------------
// Server auth tokens last ~7 days. Caching {token,charId} per account lets a process RESTART reuse the
// token for the WS handshake INSTEAD of re-running REST /api/login — which is what 429-storms a 5-bot
// fleet from one shared IP (the 20/60s auth limit). A stale/rejected token falls back to a fresh login.
const TOKEN_DIR = new URL('../.tokens/', import.meta.url);   // bot/.tokens/  (gitignored — holds secrets)
const TOKEN_TTL = 6 * 24 * 3600 * 1000;                      // reuse for up to 6 days (server tokens last 7)
const tokenFile = (user) => new URL(encodeURIComponent(user) + '.json', TOKEN_DIR);
export function loadToken(user) {
  try { const c = JSON.parse(fs.readFileSync(tokenFile(user), 'utf8')); if (c.token && c.charId != null && Date.now() - (c.savedAt ?? 0) < TOKEN_TTL) return c; } catch {}
  return null;
}
export function saveToken(user, token, charId) {
  try { fs.mkdirSync(TOKEN_DIR, { recursive: true }); fs.writeFileSync(tokenFile(user), JSON.stringify({ token, charId, savedAt: Date.now() })); } catch {}
}

const INITIAL_BACKOFF = 3000;
const MAX_BACKOFF = 30000;
const INWORLD_RETRY = 1500;   // fixed short delay while the server frees the old session
const SUSPEND_RETRY = 1800000; // 30min — a SUSPENDED account must NOT be hammered every 30s (wasteful
                               // and looks abusive); back off long, or until the parsed unsuspend time.
const RATE_LIMIT_RETRY = 60000; // base wait after a 429 (shared-IP auth rate limit); JITTERED so the 5
                                // fleet bots desync instead of retrying in lockstep and re-saturating it.

export class Connection {
  constructor({ base, getAuth }) {
    this.base = base;
    this.wsUrl = base.replace(/^http/, 'ws') + '/ws';
    this.getAuth = getAuth;             // async (forceFresh) => {token, charId}; forceFresh skips the token cache
    this.ws = null;
    this.ready = false;
    this.pid = -1;
    this.token = null; this.charId = null;
    this.backoff = INITIAL_BACKOFF;
    this._snap = null; this._events = null; this._hello = null;
    this._closed = false;
    this._reconnectTimer = null;
    this._authReject = null;            // null | 'inworld' | 'auth' | 'suspended' — classified from a server 'error'
    this._needFreshToken = false;       // set when a cached/old token was rejected → next getAuth must re-login
    this.lastReadyAt = 0;               // for the autobot watchdog's connection backstop
  }
  onSnap(cb) { this._snap = cb; }
  onEvents(cb) { this._events = cb; }
  onHello(cb) { this._hello = cb; }

  start() { this._closed = false; this._connect(true); }   // never throws (fire-and-forget safe)

  // (re)connect. needAuth: fetch a fresh token via getAuth(); otherwise reuse the cached one.
  async _connect(needAuth) {
    if (this._closed) return;
    this.ready = false;
    if (needAuth || !this.token) {
      try { const a = await this.getAuth(this._needFreshToken); this._needFreshToken = false; this.token = a.token; this.charId = a.charId; }
      catch (e) {
        const msg = String(e?.message ?? e);
        // Cloudflare Turnstile (403 "verification failed") gates REST /api/login on the live server: the
        // bot's plain fetch can NEVER pass it, so retrying every 30s is pure noise — only a fresh BROWSER
        // token (get-token.mjs) recovers it. Classify it: back off long and print the one actionable step,
        // instead of silently hammering the login endpoint (38+ such loops were seen in live.log).
        const needsBrowserToken = /verification failed|turnstile|cf[-_ ]?challenge|403/i.test(msg);
        const rateLimited = /\b429\b|too many attempts|rate ?limit/i.test(msg);
        if (needsBrowserToken) {
          console.error('[net] ⛔ вход заблокирован Cloudflare Turnstile (403). REST-логин его не пройдёт.');
          console.error('[net]    Получи свежий токен в браузере (один раз, живёт ~неделю):  node bot/get-token.mjs');
          console.error('[net]    Жду 3мин и пробую снова (как только токен появится в bot/.tokens/ — подхвачу его).');
        } else {
          console.error('[net] auth failed:', msg);
        }
        // a 429 (shared-IP auth rate limit) must back off LONG and JITTERED, or N fleet bots retry in
        // lockstep and keep the per-IP window saturated forever — they never reconnect. Desync them.
        const delay = needsBrowserToken ? 180000
          : (rateLimited ? RATE_LIMIT_RETRY + Math.floor(Math.random() * RATE_LIMIT_RETRY) : undefined);
        this._scheduleReconnect(true, delay);
        return;                                 // do NOT open a stale socket
      }
    }
    this._open();
  }
  _open() {
    if (this._closed) return;
    let ws;
    try { ws = new WebSocket(this.wsUrl); }
    catch (e) { console.error('[net] open failed:', e?.message ?? e); this._scheduleReconnect(true); return; }
    this.ws = ws;
    this._authReject = null;
    ws.on('open', () => { try { ws.send(JSON.stringify({ t: 'auth', token: this.token, character: this.charId })); } catch {} });
    ws.on('message', (d) => { try { this._onMsg(JSON.parse(String(d))); } catch (e) { console.error('[net] bad message:', e.message, String(d).slice(0, 160)); } });
    ws.on('close', () => this._onClose());
    ws.on('error', () => {});            // 'close' always follows — recover there
  }
  _onClose() {
    if (this._closed) return;
    this.ready = false;
    if (this._authReject === 'suspended') {      // account suspended: back off until the unsuspend time (capped), NOT every 30s
      this._authReject = null;
      const now = Date.now();
      const wait = this._suspendedUntil > now ? Math.min(Math.max(this._suspendedUntil - now + 5000, 60000), SUSPEND_RETRY) : SUSPEND_RETRY;
      console.error(`[net] АККАУНТ ЗАБЛОКИРОВАН${this._suspendedUntil ? ' до ' + new Date(this._suspendedUntil).toISOString() : ''} — повтор через ${Math.round(wait / 60000)}мин (не долблю каждые 30с)`);
      this._scheduleReconnect(true, wait);
    } else if (this._authReject === 'inworld') { // old session still tearing down: short fixed retry, same token
      this._authReject = null;
      console.log('[net] сессия ещё закрывается на сервере — повтор через 1.5s (тот же токен)');
      this._scheduleReconnect(false, INWORLD_RETRY);
    } else if (this._authReject === 'auth') {    // token rejected: refresh it, normal backoff
      this._authReject = null;
      this._scheduleReconnect(true);
    } else {                                      // plain network drop: reuse cached token, normal backoff
      this._scheduleReconnect(false);
    }
  }
  _scheduleReconnect(needAuth, fixedDelay) {
    if (this._closed) return;
    if (this._reconnectTimer) return;            // a retry is already pending
    const wait = fixedDelay != null ? fixedDelay : this.backoff;
    if (fixedDelay == null) this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
    console.log(`[net] reconnecting in ${Math.round(wait / 1000)}s${needAuth ? ' (re-auth)' : ''}`);
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._connect(needAuth).catch(() => {}); }, wait);
  }
  _onMsg(m) {
    if (m.t === 'hello') { this.pid = m.pid; this.ready = true; this.lastReadyAt = Date.now(); this.backoff = INITIAL_BACKOFF; this._authReject = null; this._needFreshToken = false; this._hello?.(m); }
    else if (m.t === 'snap') { this._snap?.(m); }
    else if (m.t === 'events') { this._events?.(m.list ?? []); }
    else if (m.t === 'error') {
      console.error('[server]', m.error);
      const e = String(m.error ?? '').toLowerCase();
      if (/suspend|banned|locked/.test(e)) {                                        // account suspended — DON'T hammer
        this._authReject = 'suspended';
        const um = String(m.error ?? '').match(/until (.+?)\.?$/i);                  // "...suspended until <date>."
        const t = um ? Date.parse(um[1]) : NaN;
        this._suspendedUntil = Number.isFinite(t) ? t : 0;
      }
      else if (/already in world/.test(e)) this._authReject = 'inworld';            // short fixed retry, same token
      else if (/auth|token|not authenticated|unauthor|expired/.test(e)) { this._authReject = 'auth'; this._needFreshToken = true; }  // cached token bad → force a fresh login next time
    }
  }
  cmd(p) { if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'cmd', ...p })); }
  input(mi, facing) { if (this.ready && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'input', mi, ...(facing !== undefined ? { facing } : {}) })); }
  close() { this._closed = true; if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null; } try { this.ws?.close(); } catch {} }
}
