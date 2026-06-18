// World of Claudecraft — UNIFIED CONSOLE. Runs the solo druid + the fleet in ONE process under ONE
// rich dashboard with a bot SELECTOR, per-bot controls, and fleet-wide controls. Reuses makeSoloBot
// (autobot.mjs), makeBot/CLASSES (fleet.mjs), the Coordinator, richState/applySetting (botstate.mjs),
// and the Dashboard transport — nothing is rewritten. Run via bot/run-console.sh.
//
// Env: SERVER_URL, BOT_*/FLEET_* creds (bot/.env.bot), CONSOLE_PORT (8077), CONSOLE_SOLO/CONSOLE_FLEET
//      (=0 to omit one), FLEET_SELL (=1 to enable market selling).
import { makeSoloBot } from './autobot.mjs';
import { makeBot, CLASSES } from './fleet.mjs';
import { Coordinator } from './lib/fleet_coordinator.mjs';
import { Dashboard } from './lib/dashboard.mjs';
import { richState, applySetting } from './lib/botstate.mjs';
import { zoneAt } from './lib/gamedata.mjs';

const PORT = Number(process.env.CONSOLE_PORT ?? 8077);
const SELL = process.env.FLEET_SELL === '1';
const RUN_SOLO = process.env.CONSOLE_SOLO !== '0';
const RUN_FLEET = process.env.CONSOLE_FLEET !== '0';
const host = (process.env.SERVER_URL ?? 'http://localhost:8787').replace(/^https?:\/\//, '');

process.on('uncaughtException', (e) => console.error('[uncaught]', e?.message ?? e));
process.on('unhandledRejection', (e) => console.error('[unhandled]', e?.message ?? e));

function main() {
  const dash = new Dashboard(PORT, CONSOLE_HTML);
  const fleetLog = [];
  const log = (msg) => { const d = new Date(); const t = [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'); fleetLog.push({ t, msg }); if (fleetLog.length > 150) fleetLog.shift(); console.log(`[флот] ${msg}`); };

  // SOLO: full rich state + its own watchdog. onWedge SOFT-recovers (does NOT exit) so one wedged bot
  // never kills the fleet sharing this process; run-console.sh still restarts on a hard crash.
  const solo = RUN_SOLO ? makeSoloBot({ onWedge() { try { solo.ctx.nav = { stuck: 0, lastX: 0, lastZ: 0, wp: (solo.ctx.nav?.wp || 0) + 1 }; solo.ctx.qmemo = {}; } catch {} solo.pushLog('⚠ watchdog: мягкий сброс (консоль)'); } }) : null;

  // FLEET: bots + coordinator (staggered start handled below).
  const fleetBots = RUN_FLEET ? CLASSES.map((c, i) => makeBot(i, c)) : [];
  const coord = (RUN_FLEET && fleetBots.length) ? new Coordinator(fleetBots, log, { sell: SELL }) : null;

  // controllable targets keyed by stable id ('solo', 'fleet:0'…). Survives reconnects (the per-bot
  // Connection reconnects in place), so the UI can address a bot by a stable id.
  const targets = {};
  if (solo) targets.solo = solo;
  fleetBots.forEach((b, i) => { targets['fleet:' + i] = b; });

  // fleet bots have no per-bot session counters (the rich panel shows CHARACTER detail, not session) —
  // a stable stub keeps richState's schema uniform across solo + fleet.
  const stub = new Map();
  function botState(id) {
    if (id === 'solo' && solo) return { id, role: 'solo', ...solo.buildState() };
    const b = targets[id]; if (!b) return null;
    if (!stub.has(id)) stub.set(id, { kills: 0, deaths: 0, questsDone: 0, xpGained: 0, start: Date.now(), baseCopper: null });
    const rs = richState({ world: b.world, action: b.action, zone: zoneAt(b.world.self?.z ?? 0), session: stub.get(id), settings: b.ctx.settings, logBuf: fleetLog, online: b.conn.ready, host, name: b.name, cls: b.cls });
    return { id, role: b.role, ...rs };
  }
  function buildState() {
    const bots = Object.keys(targets).map(botState).filter(Boolean);
    const fleet = coord ? { phase: coord.phase, action: coord.action, dungeonEnabled: coord.dungeonEnabled, sellEnabled: coord.sellEnabled, target: coord._forceDungeon ?? null, online: coord.alive().length, size: fleetBots.length } : null;
    return { bots, fleet };
  }

  // routed control: fleet-scope -> coordinator setters; per-bot -> that bot's validated settings write.
  dash.onControl((m) => {
    if (!m || m.type !== 'set') return;
    if (m.scope === 'fleet') {
      if (!coord) return;
      if (m.key === 'dungeon') coord.setDungeonEnabled(!!m.value);
      else if (m.key === 'sell') coord.setSell(!!m.value);
      else if (m.key === 'targetDungeon') coord.setTargetDungeon(m.value);
      return;
    }
    const b = targets[m.botId]; if (!b) return;
    if (b === solo) { solo.applyControl(m); return; }   // solo: full applyControl (allowlist + persist + log)
    applySetting(b.ctx.settings, m);                     // fleet bot: validated allowlist write (in-memory)
  });

  dash.start();
  if (solo) { solo.start(); setInterval(() => solo.tick(), 200); setInterval(() => solo.watchdogTick(), 5000).unref(); }
  if (coord) {
    fleetBots.forEach((b, i) => setTimeout(() => b.conn.start(), i * 4000));   // staggered logins (auth rate limit)
    setInterval(() => { try { coord.tick(); } catch (e) { console.error('[coord]', e.message); } }, 200);
  }
  let last = 0;
  setInterval(() => { const now = Date.now(); if (now - last > 400) { last = now; try { dash.broadcast(buildState()); } catch (e) { console.error('[dash]', e.message); } } }, 200);
  process.on('SIGINT', () => { if (solo) solo.conn.close(); for (const b of fleetBots) b.conn.close(); process.exit(0); });
  console.log(`[console] unified dashboard → http://localhost:${PORT}/  (solo=${!!solo}, fleet=${fleetBots.length}, sell=${SELL})`);
}

const CONSOLE_HTML = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude-боты — консоль</title><style>
:root{--bg:#16130d;--panel:#221d13;--panel2:#2c261a;--bd:#4a3f28;--gold:#e8c873;--txt:#e8e0cf;--mut:#9c8f72}
*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#1c1810,#0e0c08);color:var(--txt);font:14px/1.45 "Segoe UI",system-ui,sans-serif}
.wrap{display:flex;min-height:100vh}
.side{width:220px;flex:0 0 220px;border-right:1px solid var(--bd);padding:10px;background:#1a160e}
.side h1{font-size:14px;color:var(--gold);margin:4px 6px 10px}
.chip{display:flex;align-items:center;gap:8px;padding:8px 9px;border:1px solid var(--bd);border-radius:8px;margin-bottom:6px;cursor:pointer;background:var(--panel)}
.chip.sel{border-color:var(--gold);background:var(--panel2)}
.chip .nm{font-weight:600}.chip .sub{font-size:11px;color:var(--mut)}
.dot{width:9px;height:9px;border-radius:50%;background:#c0392b;flex:0 0 9px}.dot.on{background:#27ae60}
.role-tank{color:#e8b84b}.role-healer{color:#5fd98a}.role-dps{color:#e2705a}.role-solo{color:#9ad}
.main{flex:1;padding:14px;max-width:1100px}
.action{font-size:15px;color:#fff;background:var(--panel2);border:1px solid var(--bd);border-radius:8px;padding:8px 12px;margin-bottom:12px}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:12px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--gold);margin:0 0 9px}
.c4{grid-column:span 4}.c6{grid-column:span 6}.c12{grid-column:span 12}
@media(max-width:900px){.c4,.c6{grid-column:span 12}}
.bar{height:18px;background:#0c0a06;border:1px solid var(--bd);border-radius:5px;overflow:hidden;position:relative;margin:5px 0}
.bar>i{display:block;height:100%;transition:width .25s}.bar>span{position:absolute;inset:0;text-align:center;font-size:11px;line-height:18px;text-shadow:0 1px 2px #000}
.hp i{background:linear-gradient(90deg,#7a1d1d,#c0392b)}.mana i{background:linear-gradient(90deg,#16407a,#2e7fd6)}.xp i{background:linear-gradient(90deg,#5b2a86,#a335ee)}
.row{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px dashed #3a3220}.row:last-child{border:0}.k{color:var(--mut)}
table{width:100%;border-collapse:collapse}td{padding:3px 4px;border-bottom:1px solid #2c2618;font-size:13px}.cnt{color:var(--mut);text-align:right;width:40px}
.q .ttl{font-weight:600;color:#ffe9b0}.obj{font-size:12px;color:var(--mut)}
.set{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #3a3220}
.toggle{position:relative;width:44px;height:24px;background:#3a3220;border-radius:13px;cursor:pointer}.toggle.on{background:#27ae60}
.toggle b{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s}.toggle.on b{left:22px}
select,button,input{background:var(--panel2);color:var(--txt);border:1px solid var(--bd);border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer}
.pause{width:100%;margin-top:8px;font-weight:600}.pause.on{background:#7a1d1d;border-color:#c0392b;color:#fff}
.empty{color:var(--mut);font-style:italic}.log{height:200px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;background:#0c0a06;border:1px solid var(--bd);border-radius:6px;padding:8px}.log .t{color:#6f6347}
</style></head><body><div class="wrap">
<div class="side"><h1>🤖 Боты</h1><div id="chips"></div></div>
<div class="main"><div class="action" id="action">Подключение…</div><div id="panel"></div></div>
</div><script>
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const QC={poor:'#9d9d9d',common:'#e8e8e8',uncommon:'#1eff00',rare:'#0070dd',epic:'#a335ee'};
const TOKEN='__DASH_TOKEN__';
let ws,S={bots:[],fleet:null},sel=null;
function connect(){ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/dash?token='+encodeURIComponent(TOKEN));ws.onmessage=e=>{S=JSON.parse(e.data);render();};ws.onclose=()=>{document.getElementById('action').textContent='нет связи — переподключение…';setTimeout(connect,2000);};}
function send(o){try{ws.send(JSON.stringify(o));}catch(e){}}
function bot(id){return (S.bots||[]).find(b=>b.id===id);}
function render(){
  if(sel===null && S.bots&&S.bots.length) sel=S.bots[0].id;
  // sidebar chips
  document.getElementById('chips').innerHTML=(S.bots||[]).map(b=>{
    const hpf=b.mhp?Math.round(100*b.hp/b.mhp):0;
    return '<div class="chip'+(b.id===sel?' sel':'')+'" data-id="'+b.id+'"><span class="dot'+(b.online?' on':'')+'"></span>'+
      '<div style="flex:1"><div class="nm">'+esc(b.name||b.id)+'</div><div class="sub role-'+(b.role||'solo')+'">'+esc(b.cls||'')+' · ур.'+(b.level||'—')+(b.role&&b.role!=='solo'?' · '+({tank:'танк',healer:'хил',dps:'дпс'}[b.role]||b.role):'')+'</div></div>'+
      '<div class="sub">'+hpf+'%</div></div>';
  }).join('') + (S.fleet?'<div class="chip'+(sel==='__fleet'?' sel':'')+'" data-id="__fleet"><span class="dot'+(S.fleet.online?' on':'')+'"></span><div style="flex:1"><div class="nm">⚔ Флит</div><div class="sub">'+esc(S.fleet.phase||'')+' · '+S.fleet.online+'/'+S.fleet.size+'</div></div></div>':'');
  document.querySelectorAll('.chip').forEach(c=>c.onclick=()=>{sel=c.dataset.id;render();});
  if(sel==='__fleet'){renderFleet();return;}
  const b=bot(sel)||S.bots[0]; if(!b){document.getElementById('panel').innerHTML='<span class="empty">нет ботов</span>';return;}
  document.getElementById('action').innerHTML='<b style="color:var(--gold)">'+esc(b.name||b.id)+':</b> '+esc(b.action||'…');
  renderBot(b);
}
function bar(frac,txt,cls){return '<div class="bar '+cls+'"><i style="width:'+Math.max(0,Math.min(100,(frac||0)*100))+'%"></i><span>'+esc(txt)+'</span></div>';}
function renderBot(b){
  const st=b.settings||{};
  const equip=(b.equip||[]).map(e=>'<tr><td class="k">'+esc(e.slotRu)+'</td><td style="color:'+(QC[e.quality]||'#fff')+'">'+esc(e.name||'—')+'</td></tr>').join('')||'<tr><td class="empty">пусто</td></tr>';
  const inv=(b.inv&&b.inv.length)?b.inv.map(i=>'<tr><td style="color:'+(QC[i.quality]||'#fff')+'">'+esc(i.name)+'</td><td class="cnt">'+(i.count>1?'×'+i.count:'')+'</td></tr>').join(''):'<tr><td class="empty">пусто</td></tr>';
  const stats=(b.stats||[]).map(s=>'<div class="row"><span class="k">'+esc(s.k)+'</span><span>'+esc(s.v)+'</span></div>').join('')||'<span class="empty">—</span>';
  const quests=(b.quests&&b.quests.length)?b.quests.map(q=>'<div class="q"><div class="ttl">'+esc(q.name)+(q.state==='ready'?' ✅':'')+'</div>'+q.objectives.map(o=>'<div class="obj">'+esc(o.label)+': '+o.have+'/'+o.need+'</div>').join('')+'</div>').join(''):'<span class="empty">нет</span>';
  const tog=(k,on,lbl)=>'<div class="set"><span>'+lbl+'</span><div class="toggle'+(on?' on':'')+'" data-k="'+k+'"><b></b></div></div>';
  document.getElementById('panel').innerHTML=
    '<div class="grid">'+
    '<div class="card c6"><h2>Персонаж</h2>'+
      bar(b.mhp?b.hp/b.mhp:0,(b.hp||0)+' / '+(b.mhp||0),'hp')+
      (b.mana_enabled?bar(b.mres?b.mana/b.mres:0,Math.round(b.mana||0)+' / '+(b.mres||0)+' '+(b.resName||''),'mana'):'')+
      (b.xpNext?bar(b.xp/b.xpNext,'опыт '+(b.xp||0)+' / '+b.xpNext,'xp'):'')+
      '<div class="row"><span class="k">Зона</span><span>'+esc(b.zone||'—')+'</span></div>'+
      '<div class="row"><span class="k">Форма</span><span>'+esc(b.form||'—')+'</span></div>'+
      '<div class="row"><span class="k">Цель</span><span>'+(b.target?esc(b.target.name)+' '+Math.round(b.target.hpPct*100)+'%':'нет')+'</span></div>'+
      '<div class="row"><span class="k">Золото</span><span>'+(b.gold?b.gold.g+'з '+b.gold.s+'с':'—')+'</span></div></div>'+
    '<div class="card c6"><h2>Управление</h2>'+
      '<div class="set"><span>Режим</span><select id="mode">'+['quest','grind','level-fast','farm-gold','cautious','passive'].map(m=>'<option'+(st.mode===m?' selected':'')+'>'+m+'</option>').join('')+'</select></div>'+
      tog('lootCorpses',st.lootCorpses,'Лут')+tog('buyFood',st.buyFood,'Еда')+tog('helpOthers',st.helpOthers,'Помощь')+tog('autoEquip',st.autoEquip,'Авто-экип')+tog('bearForm',st.bearForm,'Медведь')+tog('sellJunk',st.sellJunk,'Продажа хлама')+
      '<div class="set"><span>Лимит ур.</span><input id="lvlcap" type="number" min="2" max="20" value="'+(st.levelCap??20)+'" style="width:64px"></div>'+
      '<button class="pause'+(st.paused?' on':'')+'" id="pause">'+(st.paused?'▶ Возобновить':'⏸ Пауза')+'</button></div>'+
    '<div class="card c4"><h2>Характеристики</h2>'+stats+'</div>'+
    '<div class="card c4"><h2>Экипировка</h2><table>'+equip+'</table></div>'+
    '<div class="card c4"><h2>Квесты</h2>'+quests+'</div>'+
    '<div class="card c6"><h2>Инвентарь</h2><table>'+inv+'</table></div>'+
    '<div class="card c6"><h2>Лог</h2><div class="log">'+(b.log||[]).map(l=>'<div><span class="t">'+esc(l.t)+'</span> '+esc(l.msg)+'</div>').join('')+'</div></div>'+
    '</div>';
  const id=b.id;
  document.querySelectorAll('#panel .toggle').forEach(t=>t.onclick=()=>send({type:'set',botId:id,key:t.dataset.k,value:!t.classList.contains('on')}));
  const ms=document.getElementById('mode'); if(ms)ms.onchange=()=>send({type:'set',botId:id,key:'mode',value:ms.value});
  const lc=document.getElementById('lvlcap'); if(lc)lc.onchange=()=>send({type:'set',botId:id,key:'levelCap',value:Number(lc.value)});
  const pb=document.getElementById('pause'); if(pb)pb.onclick=()=>send({type:'set',botId:id,key:'paused',value:!st.paused});
}
function renderFleet(){
  const f=S.fleet||{};
  document.getElementById('action').innerHTML='<b style="color:var(--gold)">⚔ Флит:</b> '+esc(f.phase||'')+' — '+esc(f.action||'');
  const rows=(S.bots||[]).filter(b=>b.role&&b.role!=='solo').map(b=>'<tr><td><span class="dot'+(b.online?' on':'')+'"></span></td><td>'+esc(b.name)+'</td><td class="role-'+b.role+'">'+esc(b.cls)+'</td><td>'+(b.level||'—')+'</td><td>'+(b.mhp?Math.round(100*b.hp/b.mhp):0)+'%</td><td>'+esc(b.action||'')+'</td></tr>').join('');
  const tog=(k,on,lbl)=>'<div class="set"><span>'+lbl+'</span><div class="toggle'+(on?' on':'')+'" data-fk="'+k+'"><b></b></div></div>';
  document.getElementById('panel').innerHTML='<div class="grid">'+
    '<div class="card c12"><h2>Группа</h2><table><tr><th></th><th>Имя</th><th>Класс</th><th>Ур.</th><th>HP</th><th>Действие</th></tr>'+rows+'</table></div>'+
    '<div class="card c6"><h2>Управление флитом</h2>'+tog('dungeon',f.dungeonEnabled,'Ходить в данжи')+tog('sell',f.sellEnabled,'Продавать лут (рынок)')+
      '<div class="set"><span>Целевой данж</span><select id="td"><option value="">авто</option>'+['hollow_crypt','sunken_bastion','gravewyrm_sanctum'].map(d=>'<option'+(f.target===d?' selected':'')+'>'+d+'</option>').join('')+'</select></div></div>'+
    '</div>';
  document.querySelectorAll('#panel .toggle').forEach(t=>t.onclick=()=>send({type:'set',scope:'fleet',key:t.dataset.fk,value:!t.classList.contains('on')}));
  const td=document.getElementById('td'); if(td)td.onchange=()=>send({type:'set',scope:'fleet',key:'targetDungeon',value:td.value});
}
connect();
</script></body></html>`;

main();
