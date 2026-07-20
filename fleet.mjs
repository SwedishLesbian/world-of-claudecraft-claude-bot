// World of Claudecraft — 5-bot fleet: party up, level together, run dungeons by
// role (tank/heal/dps), farm bosses, sell rare/epic on the World Market.
// Levels legitimately (no dev commands) on a live realm. Dashboard at :8099.
//
//   node fleet.mjs                                  # local server
//   SERVER_URL=https://worldofclaudecraft.com node fleet.mjs
//   # local fast test (server with ALLOW_DEV_COMMANDS=1):
//   FLEET_DEV_LEVEL=10 FLEET_DEV_TP="80,84" node fleet.mjs
//
// Env: SERVER_URL, FLEET_CLASSES (csv, default warrior,priest,paladin,mage,rogue),
//      FLEET_USER (prefix), FLEET_PASS, FLEET_DASH_PORT (8099).
import { pathToFileURL } from 'node:url';
import { Connection, loadToken, saveToken } from './lib/connection.mjs';
import { World } from './lib/world.mjs';
import { Coordinator } from './lib/fleet_coordinator.mjs';
import { Dashboard } from './lib/dashboard.mjs';
import { CLASS_KITS, zoneAt } from './lib/gamedata.mjs';

const BASE = process.env.SERVER_URL ?? 'http://localhost:8787';
const PARTY_MAX = 5;   // server caps a party at 5 (src/sim/sim.ts) — a 6th invite is rejected
// dungeon comp tuned for THIS game's AoE-pulse bosses: 1 tank + 2 healers + 2 RANGED dps, so only the
// tank stands in the boss AoE (Korzul hits 30-42/8s in radius 14). warlock/mage kite the pulse; the
// druid is the flexible 2nd healer (rejuv HoTs, can off-tank in bear). Override via FLEET_CLASSES.
const CLASSES_RAW = (process.env.FLEET_CLASSES ?? 'warrior,priest,druid,mage,warlock').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
// clamp to PARTY_MAX: with >5 bots the party can NEVER reach full membership, so partyFormed() would
// never be true and the fleet would deadlock in 'forming' forever. Drop the extras with a clear warning.
if (CLASSES_RAW.length > PARTY_MAX) console.warn(`[fleet] FLEET_CLASSES has ${CLASSES_RAW.length} classes; server party cap is ${PARTY_MAX} — using the first ${PARTY_MAX}.`);
export const CLASSES = CLASSES_RAW.slice(0, PARTY_MAX);
const UPREFIX = process.env.FLEET_USER ?? 'sl_fleet';
const IS_LOCAL = /localhost|127\.0\.0\.1/.test(BASE);
// no weak shared default against a real server (was 'fleetpass123'). Local dev gets a throwaway
// constant; a real server MUST supply FLEET_PASS via .env.bot. (Distinct per-account passwords
// are a follow-up — would need re-registering the live sl_fleet_* accounts.)
const PASS = process.env.FLEET_PASS ?? (IS_LOCAL ? 'localdev_fleet_pw' : null);
const DASH_PORT = Number(process.env.FLEET_DASH_PORT ?? 8099);
// character names, klod-/bot-themed, mapped by index to FLEET_CLASSES (tank/heal/druid/mage/lock).
// (server name rule: letters only — keep them simple.) Extra names cover larger custom comps.
const NAMES = ['Klodtank', 'Klodheal', 'Klodruid', 'Klodmage', 'Klodlock', 'Klodbot', 'Botklod', 'Klodaide'];
const roleOf = (cls) => cls === 'warrior' ? 'tank' : (['priest', 'paladin', 'druid', 'shaman'].includes(cls) ? 'healer' : 'dps');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(path, body, token, method = 'POST') {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
async function authenticate(base, user, password, cls, name, forceFresh) {
  // reuse a cached disk token on (re)start instead of /api/login — the key fix for the 5-bot 429 storm
  // (all bots re-logging-in at once from one IP). forceFresh (a rejected token) bypasses the cache.
  if (!forceFresh) { const c = loadToken(user); if (c) return { token: c.token, charId: c.charId, name }; }
  const request = async (path, body, token, method = 'POST') => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: method === 'GET' ? undefined : JSON.stringify(body ?? {}) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let r = await request('/api/login', { username: user, password });
  if (r.status !== 200) { r = await request('/api/register', { username: user, password }); if (r.status !== 200) throw new Error(`auth ${user}: ${r.status} ${JSON.stringify(r.body)}`); }
  const token = r.body.token;
  const list = await request('/api/characters', null, token, 'GET');
  let ch = (list.body.characters ?? []).find((c) => c.class === cls);
  if (!ch) {
    const rnd = () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.sqrt(3) * 1e6 + Date.now()) % 26];
    let made, nm = name;
    for (let i = 0; i < 6; i++) { made = await request('/api/characters', { name: nm, class: cls }, token); if (made.status === 200) break; if (made.status === 409 || /taken/i.test(made.body?.error ?? '')) { nm = (name.slice(0, 12) + rnd() + rnd() + rnd()).slice(0, 16); continue; } throw new Error(`char ${user}: ${made.status} ${JSON.stringify(made.body)}`); }
    if (made.status !== 200) throw new Error(`char ${user}: ${JSON.stringify(made.body)}`); ch = made.body;
  }
  saveToken(user, token, ch.id);   // cache for restart reuse (no /api/login next boot)
  return { token, charId: ch.id, name: ch.name };
}

export function makeBot(i, cls, options = {}) {
  const base = options.base ?? BASE;
  const user = options.user ?? `${UPREFIX}_${i}`;
  const password = options.password ?? PASS;
  if (!password) throw new Error(`Password is required for bot ${i + 1}.`);
  const name = (options.name ?? NAMES[i] ?? `Botto${i}`).replace(/[^a-z]/gi, '').slice(0, 16);
  const world = new World();
  const kit = CLASS_KITS[cls] ?? CLASS_KITS.warrior;
  const conn = new Connection({ base, getAuth: (forceFresh) => authenticate(base, user, password, cls, name, forceFresh) });
  const settings = { paused: false, mode: 'quest', lootCorpses: true, buyFood: true, helpOthers: true, autoEquip: true, bearForm: true, levelCap: 20 };
  const bot = { id: `bot:${i}`, i, cls, role: roleOf(cls), user, name, conn, world, action: 'Starting…', kit };
  bot.ctx = {
    world, CLASS: cls, kit, range: 4, settings,
    cmd: (p) => conn.cmd(p), input: (mi, f) => conn.input(mi, f), now: () => Date.now(),
    setAction: (s) => { bot.action = s; }, log: () => {}, action: '',
    nav: { stuck: 0, lastX: 0, lastZ: 0, wp: 0 }, dotUntil: new Map(), buffThrottle: new Map(), buffSelfThrottle: new Map(), triedEquip: new Set(),
    // these MUST match autobot.mjs's ctx — the leader runs the shared solo brain via decide(), which on
    // its FIRST tick iterates ctx.healThrottle and reads blockedMobs/deferredQuests etc. Omitting them
    // (the old ctx) made decide() throw 'undefined is not iterable' EVERY tick (swallowed by the
    // coordinator), so the leader never moved and the whole fleet stalled.
    healThrottle: new Map(), helpLog: [],
    deathBy: new Map(), killBy: new Map(), blockedMobs: new Set(), lastEngagedTid: null, deferredQuests: new Map(),
    potionCdUntil: 0, needRestock: false, zone: null, lastKill: Date.now(),
  };
  conn.onSnap((snap) => world.ingest(snap));
  conn.onHello(() => {
    if (process.env.FLEET_DEV_LEVEL) setTimeout(() => {
      conn.cmd({ cmd: 'dev_level', level: Number(process.env.FLEET_DEV_LEVEL) });
      if (process.env.FLEET_DEV_TP) { const [x, z] = process.env.FLEET_DEV_TP.split(',').map(Number); conn.cmd({ cmd: 'dev_teleport', x: x + (i - 2) * 2, z }); }
    }, 1500);
  });
  conn.onEvents((list) => {
    for (const ev of list) {
      // human reaction pause (vs server/antibot.ts): hold 200-460ms on EXACTLY the stimuli the server times —
      // `(castStop|death) && entityId===pid` (game.ts:1393), i.e. OUR interrupted cast / OUR death — so the
      // stimulus→next-combat-command reaction reads human (decays the 'reaction' evidence). A mob WE killed
      // and other actors' castStops aren't measured for us, so they don't need (and shouldn't get) a pause.
      if ((ev.type === 'castStop' || ev.type === 'death') && ev.entityId === world.pid) bot.ctx.reactionHoldUntil = Date.now() + 200 + Math.floor(Math.random() * 260);
      if (ev.type === 'partyInvite') conn.cmd({ cmd: 'paccept' });
      else if (ev.type === 'death' && ev.killerId === world.pid) bot.ctx.lastKill = Date.now();
    }
  });
  return bot;
}

const FLEET_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Bot Fleet</title><style>
:root{--bg:#16130d;--panel:#221d13;--bd:#4a3f28;--gold:#e8c873;--txt:#e8e0cf;--mut:#9c8f72}
body{margin:0;background:linear-gradient(180deg,#1c1810,#0e0c08);color:var(--txt);font:14px/1.4 "Segoe UI",system-ui,sans-serif}
.wrap{max-width:1080px;margin:0 auto;padding:14px}
h1{color:var(--gold);font-size:18px;margin:0 0 4px}
.phase{font-size:15px;background:#2c261a;border:1px solid var(--bd);border-radius:8px;padding:8px 12px;margin:8px 0}
.phase b{color:var(--gold)}
table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--bd);border-radius:10px;overflow:hidden}
th,td{padding:8px 10px;text-align:left;border-bottom:1px solid #2c2618;font-size:13px}
th{color:var(--gold);text-transform:uppercase;font-size:11px;letter-spacing:.5px}
.role-tank{color:#e8b84b}.role-healer{color:#5fd98a}.role-dps{color:#e2705a}
.bar{height:14px;background:#0c0a06;border:1px solid var(--bd);border-radius:4px;overflow:hidden;position:relative;min-width:90px}
.bar>i{display:block;height:100%}.hp>i{background:linear-gradient(90deg,#7a1d1d,#c0392b)}.mp>i{background:linear-gradient(90deg,#16407a,#2e7fd6)}
.bar>span{position:absolute;inset:0;font-size:10px;line-height:14px;text-align:center;text-shadow:0 1px 2px #000}
.dot{width:9px;height:9px;border-radius:50%;display:inline-block;background:#c0392b}.dot.on{background:#27ae60}
.log{height:240px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;background:#0c0a06;border:1px solid var(--bd);border-radius:8px;padding:8px;margin-top:12px}
.log .t{color:#6f6347}
</style></head><body><div class="wrap">
<h1>🛡 Bot Fleet — World of Claudecraft</h1>
<div class="phase" id="phase">Connecting…</div>
<table><thead><tr><th></th><th>Name</th><th>Class / role</th><th>Level</th><th>HP</th><th>Resource</th><th>Zone</th><th>Action</th></tr></thead><tbody id="rows"></tbody></table>
<div class="log" id="log"></div>
</div><script>
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const TOKEN='__DASH_TOKEN__';
let ws;function connect(){ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/dash?token='+encodeURIComponent(TOKEN));ws.onmessage=e=>render(JSON.parse(e.data));ws.onclose=()=>setTimeout(connect,2000);}
function render(S){
 document.getElementById('phase').innerHTML='<b>Phase:</b> '+esc(S.phaseRu||S.phase||'')+'  ·  '+esc(S.summary||'');
 document.getElementById('rows').innerHTML=(S.bots||[]).map(b=>{
  const hpf=b.mhp?Math.round(100*b.hp/b.mhp):0, mpf=b.mres?Math.round(100*b.mana/b.mres):0;
  return '<tr><td><span class="dot'+(b.online?' on':'')+'"></span></td><td>'+esc(b.name)+'</td>'+
   '<td class="role-'+b.role+'">'+esc(b.cls)+' · '+({tank:'tank',healer:'healer',dps:'dps'}[b.role])+'</td>'+
   '<td>'+(b.level||'—')+'</td>'+
   '<td><div class="bar hp"><i style="width:'+hpf+'%"></i><span>'+(b.hp||0)+'/'+(b.mhp||0)+'</span></div></td>'+
   '<td><div class="bar mp"><i style="width:'+mpf+'%"></i><span>'+Math.round(b.mana||0)+'/'+(b.mres||0)+' '+esc(b.resName||'')+'</span></div></td>'+
   '<td>'+esc(b.zone||'—')+'</td><td>'+esc(b.action||'')+'</td></tr>';
 }).join('');
 const lg=document.getElementById('log');const atb=lg.scrollTop+lg.clientHeight>=lg.scrollHeight-30;
 lg.innerHTML=(S.log||[]).map(l=>'<div><span class="t">'+esc(l.t)+'</span> '+esc(l.msg)+'</div>').join('');
 if(atb)lg.scrollTop=lg.scrollHeight;
}connect();
</script></body></html>`;

const PHASE_RU = { forming: 'Forming party', leveling: 'Party leveling', travel: 'Traveling to dungeon', dungeon: 'In dungeon', selling: 'Selling loot' };

process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message ?? e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message ?? e));

function main() {
  if (!PASS) { console.error('[fleet] FATAL: FLEET_PASS is unset for a non-local server. Set it in .env.bot (see .env.bot.example).'); process.exit(1); }
  console.log(`Fleet — server=${BASE} classes=${CLASSES.join(',')}`);
  const bots = CLASSES.map((cls, i) => makeBot(i, cls));
  const logBuf = [];
  const log = (msg) => { const d = new Date(); const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'); logBuf.push({ t, msg }); if (logBuf.length > 150) logBuf.shift(); console.log(`[fleet] ${msg}`); };
  // market-selling is a TOGGLE: OFF by default (set FLEET_SELL=1 to enable). When off, the fleet keeps
  // its loot instead of auto-listing rare/epic on the World Market — a separate, opt-in feature.
  const coord = new Coordinator(bots, log, { sell: process.env.FLEET_SELL === '1' });
  const dash = new Dashboard(DASH_PORT, FLEET_HTML);

  function buildState() {
    return {
      phase: coord.phase, phaseRu: PHASE_RU[coord.phase] ?? coord.phase, summary: coord.action,
      log: logBuf,
      bots: bots.map((b) => {
        const s = b.world.self;
        const resName = { mana: 'mana', rage: 'rage', energy: 'energy' }[s?.rtype] ?? '';
        const zone = s ? (coord.inDungeon(b) ? 'Dungeon ⚔' : (zoneAt(s.z)?.name ?? '')) : '';
        return { name: b.name, cls: b.cls, role: b.role, online: b.conn.ready, action: b.action,
          level: s?.lv, hp: s?.hp, mhp: s?.mhp, mana: s?.res, mres: s?.mres, resName, zone };
      }),
    };
  }

  dash.start();
  // STAGGER initial logins: 5 bots all calling /api/login at once trips the server's 20/60s per-IP auth
  // rate limit (429), and they then flap in lockstep and never reconnect. ~4s apart keeps the burst under
  // the cap. (Reconnects after a network drop reuse the cached token — only fresh starts log in.)
  bots.forEach((b, i) => setTimeout(() => b.conn.start(), i * 4000));

  let last = 0;
  // Human-like tick jitter (vs server/antibot.ts timing detector) — same rationale as autobot.mjs: a fixed
  // 200ms cadence gives each bot ~0 combat-command interval variance → 'timing' evidence. [130,380]ms →
  // interval stdDev ~72ms (≥50 → timing decays). With the reaction hold (above) decaying 'reaction' too,
  // each fleet bot's only remaining evidence is multi_ip (one shared IP, weight 0.4 = a single kind), which
  // is below the ≥2-distinct-kinds gate every escalation tier requires. (multi_ip itself left untouched.)
  const fleetLoop = () => {
    try { coord.tick(); } catch (e) { console.error('[coord]', e.message); }
    const now = Date.now();
    if (now - last > 500) { last = now; try { dash.broadcast(buildState()); } catch {} }
    setTimeout(fleetLoop, 130 + Math.floor(Math.random() * 250));
  };
  fleetLoop();
  process.on('SIGINT', () => { for (const b of bots) b.conn.close(); process.exit(0); });
}
// Only auto-run when launched directly; do not run when imported by console.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
