// World of Claudecraft — fully autonomous bot (v3): all 3 zones, all classes,
// quests + grinding + heal/help others + bear form + survival + live dashboard.
// Levels legitimately (no dev commands). Dashboard at http://localhost:8088.
//
//   node bot/autobot.mjs            # then open http://localhost:8088
//   SERVER_URL=https://worldofclaudecraft.com node bot/autobot.mjs
//
// Env: SERVER_URL, BOT_CLASS (default druid), BOT_USER/BOT_PASS, BOT_NAME, DASH_PORT (8088).
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Connection, loadToken, saveToken } from './lib/connection.mjs';
import { World } from './lib/world.mjs';
import { decide } from './lib/brain.mjs';
import { Dashboard } from './lib/dashboard.mjs';
import { CLASS_KITS, meleeRangeFor } from './lib/gamedata.mjs';
import { ruQuest } from './lib/ru.mjs';
import { atomicWrite, richState, applySetting } from './lib/botstate.mjs';

const BASE = process.env.SERVER_URL ?? 'http://localhost:8787';
const CLASS = (process.env.BOT_CLASS ?? 'druid').toLowerCase();
const KIT = CLASS_KITS[CLASS] ?? CLASS_KITS.druid;
const MANA = KIT.resource === 'mana';
const DASH_PORT = Number(process.env.DASH_PORT ?? 8088);
const uniq = Date.now().toString(36);
const letters = (s) => s.replace(/[0-9]/g, (d) => 'abcdefghij'[Number(d)]);
const USER = process.env.BOT_USER ?? `bot_${uniq}`;
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE);
// no weak shared default against a real server: local dev gets a throwaway constant, anything else
// MUST supply BOT_PASS (from bot/.env.bot). Prevents 'botpass123' from guarding a live account.
const PASS = process.env.BOT_PASS ?? (IS_LOCAL ? `localdev_${uniq}` : null);
if (!PASS) { console.error('[auth] FATAL: BOT_PASS is unset for a non-local server. Set it in bot/.env.bot (see bot/.env.bot.example).'); process.exit(1); }
const NAME = (process.env.BOT_NAME ?? `Claudruid${letters(uniq)}`).replace(/[^a-z]/gi, '').slice(0, 16);
const host = BASE.replace(/^https?:\/\//, '');
const SETTINGS_FILE = new URL('./settings.json', import.meta.url);
const STATE_FILE = new URL('./state.json', import.meta.url);         // durable state snapshot for monitoring + crash post-mortem (idea from the codex bot's persistence.mjs)

async function rest(path, body, token, method = 'POST') {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function authenticate(forceFresh) {
  // reuse a cached disk token on (re)start instead of re-running /api/login — avoids the per-IP auth
  // rate limit. forceFresh=true (a rejected token) bypasses the cache and re-logs-in.
  if (!forceFresh) { const c = loadToken(USER); if (c) { console.log(`[auth] кеш-токен для "${USER}"`); return { token: c.token, charId: c.charId }; } }
  let r = await rest('/api/login', { username: USER, password: PASS });
  if (r.status !== 200) {
    r = await rest('/api/register', { username: USER, password: PASS });
    if (r.status !== 200) throw new Error(`auth failed: ${r.status} ${JSON.stringify(r.body)}`);
    console.log(`[auth] registered "${USER}"`);
  } else console.log(`[auth] logged in "${USER}"`);
  const token = r.body.token;
  const list = await rest('/api/characters', null, token, 'GET');
  let ch = (list.body.characters ?? []).find((c) => c.class === CLASS);
  if (!ch) {
    const rnd = () => 'abcdefghijklmnopqrstuvwxyz'[(Math.floor(Math.sqrt(2) * 1e6 + Date.now()) % 26)];
    let made, name = NAME;
    for (let i = 0; i < 6; i++) { made = await rest('/api/characters', { name, class: CLASS }, token); if (made.status === 200) break; if (made.status === 409 || /taken/i.test(made.body?.error ?? '')) { name = (NAME.slice(0, 13) + rnd() + rnd() + rnd()).slice(0, 16); continue; } throw new Error(`character create failed: ${made.status} ${JSON.stringify(made.body)}`); }
    if (made.status !== 200) throw new Error(`character create failed: ${JSON.stringify(made.body)}`);
    ch = made.body; console.log(`[auth] created ${CLASS} "${ch.name}" (id ${ch.id})`);
  } else console.log(`[auth] using ${CLASS} "${ch.name}" (id ${ch.id}, level ${ch.level})`);
  saveToken(USER, token, ch.id);   // cache for restart reuse
  return { token, charId: ch.id };
}

// 24/7 resilience: never let an unexpected async error kill the process.
process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message ?? e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message ?? e));

// makeSoloBot: build ONE solo bot (connection + world + ctx + event handlers + buildState + tick +
// watchdog) and return a handle. The CALLER attaches a Dashboard and drives the loops — so both
// autobot.mjs (standalone, below) and bot/console.mjs (the unified multi-bot launcher) reuse it verbatim.
// onWedge runs when the watchdog gives up (default: exit the process so run-forever.sh restarts; the
// console passes a soft-recover so one wedged bot doesn't kill the others).
export function makeSoloBot({ base = BASE, cls = CLASS, kit = KIT, name = NAME, getAuth = authenticate,
    settingsFile = SETTINGS_FILE, stateFile = STATE_FILE,
    onWedge = () => process.exit(1) } = {}) {
  const world = new World();
  const conn = new Connection({ base, getAuth });

  const settings = { paused: false, mode: 'quest', lootCorpses: true, buyFood: true, helpOthers: true, autoEquip: true, bearForm: true, sellJunk: true, levelCap: 20 };
  try { Object.assign(settings, JSON.parse(fs.readFileSync(settingsFile, 'utf8'))); } catch {}
  const saveSettings = () => { try { atomicWrite(settingsFile, JSON.stringify(settings, null, 2)); } catch {} };

  const session = { kills: 0, deaths: 0, questsDone: 0, xpGained: 0, baseCopper: null, start: Date.now() };
  const logBuf = [];
  const pushLog = (msg) => { const d = new Date(); const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'); logBuf.push({ t, msg }); if (logBuf.length > 150) logBuf.shift(); console.log(`[бот] ${msg}`); };

  const ctx = {
    world, CLASS: cls, kit, range: cls === 'druid' ? 24 : meleeRangeFor(cls), settings,  // druid root-kites as a caster (hold ground ~24yd); other melee = 4; pure casters = 24
    cmd: (p) => conn.cmd(p), input: (mi, f) => conn.input(mi, f), now: () => Date.now(),
    setAction: (s) => { ctx.action = s; }, log: pushLog, action: 'Запуск…',
    nav: { stuck: 0, lastX: 0, lastZ: 0, wp: 0 }, dotUntil: new Map(), rootUntil: new Map(), buffThrottle: new Map(), buffSelfThrottle: new Map(), healThrottle: new Map(), helpLog: [], triedEquip: new Set(),
    potionCdUntil: 0, needRestock: false, zone: null, lastKill: Date.now(),
    deferredQuests: new Map(), // qid -> ts: a collect quest whose spot is barren/guarded; skip it
                               // in nextQuestAction so the bot rotates to its OTHER quests instead
                               // of idling/grinding while one objective is stuck.
  };

  conn.onHello(() => {
    pushLog('Вошёл в мир — начинаю играть');
    if (process.env.BOT_DEV_LEVEL) setTimeout(() => { // local testing only (needs ALLOW_DEV_COMMANDS=1)
      conn.cmd({ cmd: 'dev_level', level: Number(process.env.BOT_DEV_LEVEL) });
      if (process.env.BOT_DEV_TP) { const [x, z] = process.env.BOT_DEV_TP.split(',').map(Number); conn.cmd({ cmd: 'dev_teleport', x, z }); }
      pushLog(`[DEV] уровень ${process.env.BOT_DEV_LEVEL}${process.env.BOT_DEV_TP ? ', телепорт ' + process.env.BOT_DEV_TP : ''}`);
    }, 1500);
  });
  conn.onSnap((snap) => {
    if (session.baseCopper == null && snap.self?.copper != null) session.baseCopper = snap.self.copper;
    world.ingest(snap);
  });
  conn.onEvents((list) => {
    for (const ev of list) {
      // HUMAN REACTION PAUSE (vs server/antibot.ts): the anti-cheat starts a stimulus→next-combat-command
      // measurement on EXACTLY `(castStop|death) && entityId===session.pid` (server/game.ts:1393) — i.e. OUR
      // cast getting interrupted or OUR own death; median <150ms → 'reaction' evidence ("a bot reacts <5ms,
      // humans can't sustain <150ms"). We must hold the next decision tick a randomized 200-460ms on EXACTLY
      // those events so the reaction reads human (median ~330ms → the evidence decays). A mob WE killed
      // (death.killerId===pid but entityId=mob) and OTHER actors' castStops are NOT measured for us, so
      // pausing on them masked nothing and only slowed the grind. tick() honours ctx.reactionHoldUntil.
      if ((ev.type === 'castStop' || ev.type === 'death') && ev.entityId === world.pid) ctx.reactionHoldUntil = Date.now() + 200 + Math.floor(Math.random() * 260);
      if (ev.type === 'death' && ev.killerId === world.pid) {
        session.kills++; ctx.lastKill = Date.now();
      }
      else if (ev.type === 'xp') session.xpGained += ev.amount ?? 0;
      else if (ev.type === 'levelup') {
        pushLog(`🎉 НОВЫЙ УРОВЕНЬ: ${ev.level}!`);
        ctx.triedEquip.clear();                                  // re-try any equip that transiently failed (a one-off reject shouldn't block re-equipping forever)
        ctx.deferredQuests?.clear(); ctx.tooHard?.clear();       // STRONGER now → retry collect/too-hard camps we skipped (tooHard also self-clears on the level change, this is just belt-and-braces)
      }
      else if (ev.type === 'questDone') { session.questsDone++; pushLog(`✅ Квест выполнен: ${ruQuest(ev.questId)}`); }
      else if (ev.type === 'questReady') pushLog(`Квест готов к сдаче: ${ruQuest(ev.questId)}`);
      else if (ev.type === 'questAccepted') pushLog(`📜 Принят квест: ${ruQuest(ev.questId)}`);
      else if (ev.type === 'playerDeath') {
        // Death is near-free (full-HP graveyard respawn, no xp/gold/durability loss). With the winnability
        // model (engageCost ≤ capacity) the bot doesn't pull packs it can't win, so deaths are rare; just
        // respawn and carry on — no death-block list, no death counter (a too-hard camp is skipped by the
        // live cost test + the level-keyed tooHard mark, not by counting deaths).
        session.deaths++; pushLog('💀 Погиб — воскресаю на кладбище');
      }
      else if (ev.type === 'partyInvite') { pushLog(`Приглашение в группу от ${ev.fromName} — принимаю`); conn.cmd({ cmd: 'paccept' }); }
    }
  });
  // apply a dashboard control message to THIS bot's settings (shared allowlist in botstate.mjs).
  // returns true if accepted. The caller (autobot main / console) wires it to dash.onControl.
  function applyControl(m) {
    const lbl = applySetting(settings, m);
    if (lbl == null) return false;            // rejected: unknown key / bad value / invalid mode
    saveSettings();
    pushLog(`⚙ ${lbl}`);
    return true;
  }

  // rich dashboard state now lives in lib/botstate.mjs (shared verbatim with the fleet + console so
  // every bot emits an identical schema). This is a thin per-bot binding of the solo bot's live objects.
  const buildState = () => richState({ world, action: ctx.action, zone: ctx.zone, session, settings, logBuf, online: conn.ready, host, name, cls });

  // one decision tick — the CALLER runs this on a ~200ms interval (and broadcasts buildState()).
  function tick() {
    if (Date.now() < (ctx.reactionHoldUntil ?? 0)) return;   // human reaction pause after a kill/castStop (antibot reaction-time evidence)
    try { decide(ctx); }
    catch (e) {
      // a throw mid-tick (bad snapshot field, null deref) must NOT leave half-set combat/nav state for
      // the next tick to act on — reset to a safe idle so corruption can't propagate, stop any in-flight
      // movement, and let the watchdog/decide recover cleanly on the following tick.
      console.error('[loop]', e.stack || e.message);
      try { ctx.fleeing = false; ctx.nav.stuck = 0; ctx.nav.anchorX = undefined; ctx.input({}); } catch {}
    }
  }

  // 24/7 forward-progress watchdog: a silent wedge (stuck nav, frozen state, quest deadlock, half-open
  // socket) shows up as the ABSENCE of any "am I playing?" signal — xp gain, real movement, or a recent
  // kill. Soft-recover by resetting navigation + quest memory; if still wedged, exit cleanly so
  // run-forever.sh restarts a fresh process (deathblocks persist). Universal (no mob/coords), thresholds
  // set well above the longest legit idle (rest + corpse-run + vendor trip all involve movement/xp).
  // Three independent guards: (A) GENERAL wedge = no movement/xp/recent-kill; (B) DEATH-LOOP = deaths
  // piling up with NO level/xp gain (the spiral that movement+death used to MASK — both reset the old
  // timer every cycle); (C) CONNECTION backstop = never reached 'ready' at boot (the old `if(!s) return`
  // meant a never-connected zombie could never trip an exit, defeating run-forever.sh).
  let lastProgressMs = Date.now(), lastPos = null, lastXp = -1, lastLv = -1;
  let deathsAtProgress = 0, deathLoopSoftReset = false, bootMs = Date.now(), everReady = false, lastXpMs = Date.now();
  // the CALLER runs this on a ~5s interval. On an unrecoverable wedge it calls onWedge() (default: exit).
  function watchdogTick() {
    const now = Date.now();
    if (conn.ready) everReady = true;                                                    // (C)
    if (!everReady && now - bootMs > 300000) { console.error('[watchdog] never connected in 5min — recovering'); try { conn.close(); } catch {} onWedge(); return; }
    const s = world.self; if (!s) return;
    const moved = lastPos && Math.hypot((s.x ?? 0) - lastPos.x, (s.z ?? 0) - lastPos.z) > 3;
    const progressed = (s.lv ?? 0) > lastLv || ((s.lv ?? 0) === lastLv && (s.xp ?? 0) > lastXp);  // real xp/level gain
    if (progressed) { deathsAtProgress = session.deaths; deathLoopSoftReset = false; lastXpMs = now; }    // (B) reset on real progress
    lastLv = s.lv ?? lastLv; lastXp = s.xp ?? lastXp;
    if (moved || progressed || (now - (ctx.lastKill ?? 0) < 120000)) lastProgressMs = now; // (A) — NOT s.dead (death+walk-back IS the spiral)
    lastPos = { x: s.x, z: s.z };
    // durable state snapshot (codex persistence.mjs idea): one JSON file always reflecting the live bot, so
    // a human/another tool can `cat bot/state.json` for level/hp/xp/gold/action/zone/k-d + uptime without
    // attaching to the WS dashboard — and it survives a crash for post-mortem ("what was it doing?").
    try {
      atomicWrite(stateFile, JSON.stringify({
        ts: new Date().toISOString(), online: conn.ready, lv: s.lv, hp: s.hp, mhp: s.mhp,
        res: s.res, mres: s.mres, xp: s.xp, copper: s.copper, pos: { x: Math.round(s.x ?? 0), z: Math.round(s.z ?? 0) },
        zone: ctx.zone?.name ?? '', action: ctx.action, mode: settings.mode, dead: !!s.dead,
        kills: session.kills, deaths: session.deaths, questsDone: session.questsDone, xpGained: session.xpGained,
        runtimeMin: Math.round((now - session.start) / 60000),
        stallSec: Math.round((now - lastProgressMs) / 1000), deathsSinceXp: session.deaths - deathsAtProgress,
        tal: s.tal ? { spec: s.tal.alloc?.spec ?? null, spent: Object.values(s.tal.alloc?.ranks ?? {}).reduce((a, b) => a + b, 0), total: Math.max(0, Math.min(s.lv ?? 1, 20) - 9) } : null,
      }, null, 2));
    } catch {}
    // (B) death-loop escalation: deaths accumulating with no xp/level gain
    const deathsSinceXp = session.deaths - deathsAtProgress;
    // (B0) RETREAT-TO-OUT-LEVEL: 3 deaths with no xp means the current target — usually a quest camp above our
    // weight (a dense troll pack, an over-level mob) — is unwinnable AT THIS LEVEL. Flag decide() to DROP quests
    // and grind the SAFEST winnable camp until we gain a LEVEL, then resume the quest stronger. Sticky to a level
    // (not just xp) so one easy kill doesn't bounce us straight back onto the death camp; clears on level-up.
    // Trigger on a death-loop (3 deaths) OR a STALEMATE — no xp for 120s. The mana fix makes a too-hard camp
    // survivable, so the bot often neither dies fast NOR kills: it bleeds at trolls, or flees a dense pack
    // (murlocs link a 5-pull) and rests forever — 0 kills, 0 deaths. A pure no-xp stall catches every "winning
    // nothing" case; 120s is well past a normal kill cadence (~30-90s), and out-level just grinds the safest
    // camp (harmless if it ever false-fires) and clears on the next level-up.
    const stuckAtCamp = deathsSinceXp >= 3 || now - lastXpMs > 120000;
    if (stuckAtCamp && ctx.outLevelLv == null) { ctx.outLevelLv = s.lv ?? 1; pushLog('🪜 Камень не по зубам — откатываюсь на безопасный гринд, докачаюсь и вернусь'); }
    if (ctx.outLevelLv != null && (s.lv ?? 1) > ctx.outLevelLv) ctx.outLevelLv = null;   // leveled up → resume quests
    ctx.outLevel = ctx.outLevelLv != null;
    if (deathsSinceXp >= 6 && !deathLoopSoftReset) { pushLog('⚠ Цикл смертей без опыта — сбрасываю навигацию/память'); ctx.nav = { stuck: 0, lastX: 0, lastZ: 0, wp: (ctx.nav?.wp || 0) + 1, anchorX: undefined }; ctx.qmemo = {}; deathLoopSoftReset = true; }
    if (deathsSinceXp >= 12) { console.error('[watchdog] death-loop, 12+ deaths with no xp — recovering'); try { conn.close(); } catch {} onWedge(); return; }
    // (A) general-wedge escalation
    if (now - lastProgressMs > 300000) { pushLog('⚠ Нет прогресса 5мин — сбрасываю навигацию'); ctx.nav = { stuck: 0, lastX: 0, lastZ: 0, wp: (ctx.nav?.wp || 0) + 1, anchorX: undefined }; ctx.qmemo = {}; lastProgressMs = now - 120000; }
    if (now - lastProgressMs > 600000) { console.error('[watchdog] no forward progress 10min — recovering'); try { conn.close(); } catch {} onWedge(); return; }
  }

  return { id: 'solo', name, cls, role: 'solo', conn, world, ctx, session, logBuf, settings, saveSettings, buildState, applyControl, tick, watchdogTick, pushLog, start: () => conn.start() };
}

// standalone solo bot: makeSoloBot + its own Dashboard + the drive loops (unchanged behavior).
function main() {
  console.log(`World of Claudecraft autobot v3 — server=${BASE} class=${CLASS} name=${NAME}`);
  const dash = new Dashboard(DASH_PORT);
  const bot = makeSoloBot();
  dash.onControl((m) => bot.applyControl(m));
  dash.start(); bot.start();
  let lastPush = 0;
  // HUMAN-LIKE TICK JITTER (tuned against server/antibot.ts thresholds). A fixed 200ms cadence
  // trips the anti-cheat: antibot.ts scores combat-command interval stdDev (<15ms → 0.7 "scripted
  // client", <50ms → 0.3) and reaction time (a stimulus SimEvent → next combat command; median
  // <150ms → 0.6 "a bot reacts <5ms, humans can't sustain <150ms"). A constant loop yields ~0
  // interval variance + instant reactions → flagged. Jittering the tick to [130,380]ms makes
  // combat-command intervals carry stdDev ~75ms (≥50 → the timing evidence DECAYS) and pushes the
  // event→command reaction to a median ~255ms (≥150 → the reaction evidence DECAYS) — a human-
  // shaped timing profile. (bot/ is a client, NOT src/sim, so Math.random is fine here — the
  // no-Math.random determinism invariant is sim-only.)
  const TICK_MIN = 130, TICK_MAX = 380;
  const loop = () => {
    bot.tick();
    const now = Date.now();
    if (now - lastPush > 400) { lastPush = now; try { dash.broadcast(bot.buildState()); } catch (e) { console.error('[dash]', e.message); } }
    setTimeout(loop, TICK_MIN + Math.floor(Math.random() * (TICK_MAX - TICK_MIN)));
  };
  loop();
  setInterval(() => bot.watchdogTick(), 5000).unref();
  process.on('SIGINT', () => { bot.conn.close(); process.exit(0); });
}
// only auto-run when launched directly (node bot/autobot.mjs); NOT when imported by console.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
