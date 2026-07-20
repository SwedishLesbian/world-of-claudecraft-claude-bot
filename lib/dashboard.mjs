// Local web dashboard: serves a live page and streams bot state over WebSocket,
// and receives settings changes back. No build step, no extra deps (uses ws).
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

export class Dashboard {
  constructor(port, html) {
    this.port = port; this.clients = new Set(); this._control = null; this.last = null;
    // bind loopback by default (was implicitly 0.0.0.0 — exposed the live bot's state + control
    // channel to the whole LAN). Set DASH_HOST=0.0.0.0 to opt into LAN access (then a token matters).
    this.host = process.env.DASH_HOST || '127.0.0.1';
    // token gates the control WebSocket: a random local webpage (DNS-rebind/CSRF) cannot read it from
    // the same-origin dashboard page, so it cannot open an authenticated socket and flip our settings.
    this.token = process.env.DASH_TOKEN || crypto.randomBytes(9).toString('base64url');
    this.html = (html ?? HTML).replace('__DASH_TOKEN__', this.token);
  }
  onControl(cb) { this._control = cb; }
  start() {
    this.server = http.createServer((req, res) => {
      const path = (req.url || '/').split('?')[0];
      if (path === '/' || path.startsWith('/index')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(this.html); }
      else { res.writeHead(404); res.end('not found'); }
    });
    this.server.on('error', (e) => {
      if (e.code === 'EADDRINUSE') console.error(`[dashboard] port ${this.port} is already in use; the dashboard could not start. Stop the old process or set DASH_PORT.`);
      else console.error('[dashboard]', e.message);
    });
    this.wss = new WebSocketServer({
      server: this.server, path: '/dash',
      verifyClient: (info, cb) => {
        try { const u = new URL(info.req.url, 'http://localhost'); cb(u.searchParams.get('token') === this.token, 401, 'unauthorized'); }
        catch { cb(false, 400); }
      },
    });
    this.wss.on('connection', (ws) => {
      this.clients.add(ws);
      if (this.last) ws.send(this.last);
      ws.on('message', (d) => { try { this._control?.(JSON.parse(String(d))); } catch {} });
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
    });
    try { this.server.listen(this.port, this.host, () => console.log(`[dashboard] open http://localhost:${this.port}/  (bind ${this.host}; the token is inserted automatically)`)); } catch (e) { console.error('[dashboard]', e.message); }
  }
  broadcast(state) {
    const s = JSON.stringify(state); this.last = s;
    for (const ws of this.clients) if (ws.readyState === 1) ws.send(s);
  }
}

const HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claude Bot Dashboard</title>
<style>
:root{--bg:#16130d;--panel:#221d13;--panel2:#2c261a;--bd:#4a3f28;--gold:#e8c873;--txt:#e8e0cf;--mut:#9c8f72;}
*{box-sizing:border-box}
body{margin:0;background:linear-gradient(180deg,#1c1810,#0e0c08);color:var(--txt);font:14px/1.45 "Segoe UI",system-ui,sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:14px}
h1{font-size:18px;margin:0;color:var(--gold);letter-spacing:.3px}
.top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--bd);padding-bottom:10px;margin-bottom:12px}
.dot{width:10px;height:10px;border-radius:50%;background:#c0392b;box-shadow:0 0 8px #c0392b}
.dot.on{background:#27ae60;box-shadow:0 0 8px #27ae60}
.sub{color:var(--mut);font-size:12px}
.action{font-size:16px;color:#fff;background:var(--panel2);border:1px solid var(--bd);border-radius:8px;padding:8px 12px;margin-bottom:12px}
.action b{color:var(--gold)}
.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:12px}
.card{background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:12px}
.card h2{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--gold);margin:0 0 9px}
.c4{grid-column:span 4}.c3{grid-column:span 3}.c5{grid-column:span 5}.c6{grid-column:span 6}.c7{grid-column:span 7}.c8{grid-column:span 8}.c12{grid-column:span 12}
@media(max-width:900px){.c3,.c4,.c5,.c6,.c7,.c8{grid-column:span 12}}
.bar{height:18px;background:#0c0a06;border:1px solid var(--bd);border-radius:5px;overflow:hidden;position:relative;margin:5px 0}
.bar > i{display:block;height:100%;transition:width .25s}
.bar > span{position:absolute;inset:0;text-align:center;font-size:11px;line-height:18px;text-shadow:0 1px 2px #000}
.hp i{background:linear-gradient(90deg,#7a1d1d,#c0392b)}
.mana i{background:linear-gradient(90deg,#16407a,#2e7fd6)}
.xp i{background:linear-gradient(90deg,#5b2a86,#a335ee)}
.row{display:flex;justify-content:space-between;padding:2px 0;border-bottom:1px dashed #3a3220}
.row:last-child{border:0}
.k{color:var(--mut)} .v{color:var(--txt)}
.gold{color:#e8c873;font-weight:600}
table{width:100%;border-collapse:collapse}
td{padding:3px 4px;border-bottom:1px solid #2c2618;font-size:13px}
.cnt{color:var(--mut);text-align:right;width:40px}
.q{margin-bottom:8px}
.q .ttl{font-weight:600;color:#ffe9b0}
.obj{font-size:12px;color:var(--mut)}
.objbar{height:6px;background:#0c0a06;border-radius:3px;overflow:hidden;margin:2px 0 4px}
.objbar i{display:block;height:100%;background:#caa84a}
.log{height:280px;overflow:auto;font:12px/1.5 ui-monospace,Menlo,monospace;background:#0c0a06;border:1px solid var(--bd);border-radius:6px;padding:8px}
.log div{white-space:pre-wrap} .log .t{color:#6f6347}
.set{display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px dashed #3a3220}
.toggle{position:relative;width:44px;height:24px;background:#3a3220;border-radius:13px;cursor:pointer;transition:.2s}
.toggle.on{background:#27ae60}
.toggle b{position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:.2s}
.toggle.on b{left:22px}
select,button{background:var(--panel2);color:var(--txt);border:1px solid var(--bd);border-radius:6px;padding:6px 10px;font-size:13px;cursor:pointer}
.pause{width:100%;margin-top:8px;font-weight:600}
.pause.on{background:#7a1d1d;border-color:#c0392b;color:#fff}
.empty{color:var(--mut);font-style:italic}
</style></head><body><div class="wrap">
<div class="top">
  <span class="dot" id="dot"></span>
  <h1 id="name">—</h1>
  <span class="sub" id="who"></span>
  <span class="sub" id="conn" style="margin-left:auto"></span>
</div>
<div class="action" id="action">Connecting…</div>
<div class="grid">
  <div class="card c5">
    <h2>Character</h2>
    <div class="bar hp"><i id="hpb"></i><span id="hpt"></span></div>
    <div class="bar mana" id="manaWrap"><i id="mnb"></i><span id="mnt"></span></div>
    <div class="bar xp"><i id="xpb"></i><span id="xpt"></span></div>
    <div class="row"><span class="k">Total gold</span><span class="v gold" id="gold">—</span></div>
    <div class="row"><span class="k">Zone</span><span class="v" id="zone">—</span></div>
    <div class="row"><span class="k">Form</span><span class="v" id="form">—</span></div>
    <div class="row"><span class="k">Buffs</span><span class="v" id="buffs" style="font-size:11px">—</span></div>
    <div class="row"><span class="k">Position</span><span class="v" id="pos">—</span></div>
    <div class="row"><span class="k">Target</span><span class="v" id="tgt">none</span></div>
  </div>
  <div class="card c3"><h2>Stats</h2><div id="stats"></div></div>
  <div class="card c3"><h2>Talents</h2><div id="talents"><span class="empty">—</span></div></div>
  <div class="card c4"><h2>Session</h2><div id="session"></div></div>

  <div class="card c4"><h2>Equipment</h2><table id="equip"></table></div>
  <div class="card c4"><h2>Settings</h2><div id="settings"></div><button class="pause" id="pauseBtn">⏸ Pause</button></div>
  <div class="card c4"><h2>Quests</h2><div id="quests"><span class="empty">none active</span></div></div>

  <div class="card c5"><h2>Inventory / loot</h2><table id="inv"></table></div>
  <div class="card c7"><h2>Live log</h2><div class="log" id="log"></div></div>
</div></div>
<script>
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const QC={poor:'#9d9d9d',common:'#e8e8e8',uncommon:'#1eff00',rare:'#0070dd',epic:'#a335ee'};
let ws, S={};
const TOKEN='__DASH_TOKEN__';
function connect(){
  ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/dash?token='+encodeURIComponent(TOKEN));
  ws.onmessage=e=>{S=JSON.parse(e.data);render();};
  ws.onclose=()=>{document.getElementById('conn').textContent='connection lost — reconnecting…';setTimeout(connect,2000);};
}
function send(o){try{ws.send(JSON.stringify(o));}catch(e){}}
function bar(id,txt,frac,color){document.getElementById(id).style.width=Math.max(0,Math.min(100,frac*100))+'%';document.getElementById(id.replace('b','t')).textContent=txt;}
function toggle(key,on,label){return '<div class="set"><span>'+label+'</span><div class="toggle'+(on?' on':'')+'" data-k="'+key+'"><b></b></div></div>';}
function render(){
  document.getElementById('dot').className='dot'+(S.online?' on':'');
  document.getElementById('name').textContent=S.name||'—';
  document.getElementById('who').textContent=(S.cls?('· '+S.cls+' · level  '+S.level):'');
  document.getElementById('conn').textContent=S.online?('online · '+(S.server||'')):'offline';
  document.getElementById('action').innerHTML='<b>Current:</b> '+esc(S.action||'…');
  // bars
  if(S.mhp){bar('hpb',S.hp+' / '+S.mhp,S.hp/S.mhp);}
  const mw=document.getElementById('manaWrap');
  if(S.mana_enabled){mw.style.display='';bar('mnb',Math.round(S.mana)+' / '+S.mres+' '+(S.resName||''),S.mres?S.mana/S.mres:0);}else{mw.style.display='none';}
  if(S.xpNext){bar('xpb','XP '+S.xp+' / '+S.xpNext,S.xp/S.xpNext);}
  document.getElementById('zone').textContent=S.zone||'—';
  document.getElementById('form').textContent=S.form||'—';
  document.getElementById('buffs').textContent=(S.buffs&&S.buffs.length)?S.buffs.join(', '):'—';
  document.getElementById('gold').textContent=S.gold?(S.gold.g+'g  '+S.gold.s+'s '+S.gold.c+'c'):'—';
  document.getElementById('pos').textContent=S.pos?(Math.round(S.pos.x)+', '+Math.round(S.pos.z)):'—';
  document.getElementById('tgt').innerHTML=S.target?(esc(S.target.name)+' <span class="sub">level '+S.target.level+' · '+Math.round(S.target.hpPct*100)+'%</span>'):'none';
  // stats
  document.getElementById('stats').innerHTML=(S.stats||[]).map(s=>'<div class="row"><span class="k">'+esc(s.k)+'</span><span class="v">'+esc(s.v)+'</span></div>').join('')||'<span class="empty">—</span>';
  // talents (v0.6)
  var tl=S.talents;
  document.getElementById('talents').innerHTML=tl?('<div class="row"><span class="k">'+esc(tl.spec)+'</span><span class="v gold">'+tl.spent+'/'+tl.total+' points</span></div>'+(tl.nodes||[]).map(function(n){return '<div class="row"><span class="k" style="font-size:11px">'+esc(n.name)+'</span><span class="v">'+n.rank+'/'+n.max+'</span></div>';}).join('')+(tl.spent<tl.total?'<div class="row"><span class="k sub">unspent</span><span class="v gold">'+(tl.total-tl.spent)+'</span></div>':'')):'<span class="empty">none (s 10 level )</span>';
  // session
  const ss=S.session||{};
  const gAll=S.gold?(S.gold.g+'g  '+S.gold.s+'s '+S.gold.c+'c'):'—';
  document.getElementById('session').innerHTML=
    row('Session time',fmtDur(ss.runtimeSec))+row('Kills',ss.kills)+row('Deaths',ss.deaths)+
    row('Quests completed',ss.questsDone)+row('Session XP',ss.xpGained)+
    row('Session gold',coin(ss.copperGained))+row('Total account gold',gAll);
  // equipment
  document.getElementById('equip').innerHTML=(S.equip||[]).map(e=>'<tr><td class="k">'+esc(e.slotRu)+'</td><td style="color:'+(QC[e.quality]||'#fff')+'">'+esc(e.name||'—')+'</td></tr>').join('')||'<tr><td class="empty">empty</td></tr>';
  // quests
  document.getElementById('quests').innerHTML=(S.quests&&S.quests.length)?S.quests.map(q=>'<div class="q"><div class="ttl">'+esc(q.name)+(q.state==='ready'?' ✅':'')+'</div>'+q.objectives.map(o=>'<div class="obj">'+esc(o.label)+': '+o.have+'/'+o.need+'</div><div class="objbar"><i style="width:'+Math.min(100,100*o.have/o.need)+'%"></i></div>').join('')+'</div>').join(''):'<span class="empty">none active</span>';
  // inventory
  document.getElementById('inv').innerHTML=(S.inv&&S.inv.length)?S.inv.map(i=>'<tr><td style="color:'+(QC[i.quality]||'#fff')+'">'+esc(i.name)+' <span class="sub">'+esc(i.kindRu||'')+'</span></td><td class="cnt">'+(i.count>1?('×'+i.count):'')+'</td></tr>').join(''):'<tr><td class="empty">empty</td></tr>';
  // settings — rebuild only when values actually change AND the user isn't
  // interacting with the panel, so an open <select> or focused input isn't
  // destroyed and re-created by the ~2.5/sec refresh (that closed the dropdown).
  const st=S.settings||{};
  const setEl=document.getElementById('settings');
  const sig=JSON.stringify(st);
  if(setEl.dataset.sig!==sig && !setEl.contains(document.activeElement)){
    setEl.dataset.sig=sig;
    setEl.innerHTML=
      '<div class="set"><span>Mode</span><select id="mode">'+['quest','grind','level-fast','farm-gold','cautious','passive'].map(m=>'<option value="'+m+'"'+(st.mode===m?' selected':'')+'>'+({quest:'Quests',grind:'Mob grinding','level-fast':'Fast leveling','farm-gold':'Gold farming',cautious:'Cautious',passive:'Passive'}[m])+'</option>').join('')+'</select></div>'+
      toggle('lootCorpses',st.lootCorpses,'Loot corpses')+
      toggle('buyFood',st.buyFood,'Buy food/water')+
      toggle('helpOthers',st.helpOthers,'Help players')+
      toggle('autoEquip',st.autoEquip,'Equip upgrades')+
      toggle('bearForm',st.bearForm,'Bear form (druid 10+)')+
      toggle('sellJunk',st.sellJunk,'Sell junk/replacements')+
      '<div class="set"><span>Level cap</span><input id="lvlcap" type="number" min="2" max="20" value="'+(st.levelCap??20)+'" style="width:64px;background:var(--panel2);color:var(--txt);border:1px solid var(--bd);border-radius:6px;padding:4px"></div>';
    setEl.querySelectorAll('.toggle').forEach(t=>t.onclick=()=>send({type:'set',key:t.dataset.k,value:!t.classList.contains('on')}));
    const ms=document.getElementById('mode'); if(ms) ms.onchange=()=>send({type:'set',key:'mode',value:ms.value});
    const lc=document.getElementById('lvlcap'); if(lc) lc.onchange=()=>send({type:'set',key:'levelCap',value:Number(lc.value)});
  }
  const pb=document.getElementById('pauseBtn'); pb.className='pause'+(st.paused?' on':''); pb.textContent=st.paused?'▶ Resume':'⏸ Pause'; pb.onclick=()=>send({type:'set',key:'paused',value:!st.paused});
  // log
  const lg=document.getElementById('log'); const atBottom=lg.scrollTop+lg.clientHeight>=lg.scrollHeight-30;
  lg.innerHTML=(S.log||[]).map(l=>'<div><span class="t">'+esc(l.t)+'</span> '+esc(l.msg)+'</div>').join('');
  if(atBottom) lg.scrollTop=lg.scrollHeight;
}
function row(k,v){return '<div class="row"><span class="k">'+k+'</span><span class="v">'+(v==null?'—':v)+'</span></div>';}
function coin(c){c=c||0;return Math.floor(c/10000)+'g  '+Math.floor(c%10000/100)+'s '+c%100+'c';}
function fmtDur(s){s=Math.floor(s||0);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return (h?h+'h ':'')+m+'m '+x+'s';}
connect();
</script></body></html>`;
