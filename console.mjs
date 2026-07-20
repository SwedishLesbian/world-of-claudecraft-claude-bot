import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeBot } from './fleet.mjs';
import { Coordinator } from './lib/fleet_coordinator.mjs';
import { Dashboard } from './lib/dashboard.mjs';
import { richState, applySetting } from './lib/botstate.mjs';
import { zoneAt } from './lib/gamedata.mjs';
import { BOT_CLASSES, MAX_BOTS, loadConfig, normalizeConfig, publicConfig, saveConfig } from './lib/console_config.mjs';

const PORT = Number(process.env.CONSOLE_PORT ?? 8077);
const CONFIG_FILE = fileURLToPath(new URL('./console-config.json', import.meta.url));

process.on('uncaughtException', (error) => console.error('[uncaught]', error?.message ?? error));
process.on('unhandledRejection', (error) => console.error('[unhandled]', error?.message ?? error));

export class BotConsole {
  constructor({ configFile = CONFIG_FILE, dashboard = new Dashboard(PORT, CONSOLE_HTML) } = {}) {
    this.configFile = configFile;
    this.dashboard = dashboard;
    this.config = loadConfig(configFile);
    this.bots = [];
    this.coordinator = null;
    this.log = [];
    this.error = '';
    this.running = false;
    this.sessions = new Map();
  }

  addLog(message) {
    const t = new Date().toLocaleTimeString('en-US', { hour12: false });
    this.log.push({ t, msg: message });
    if (this.log.length > 150) this.log.shift();
    console.log(`[fleet] ${message}`);
  }

  stopBots() {
    for (const bot of this.bots) bot.conn.close();
    this.bots = [];
    this.coordinator = null;
    this.sessions.clear();
    this.running = false;
  }

  startBots() {
    this.stopBots();
    const selected = this.config.bots.slice(0, this.config.botCount);
    this.bots = selected.map((entry, index) => makeBot(index, entry.class, {
      base: this.config.serverUrl, user: entry.username, password: entry.password, name: entry.characterName,
    }));
    this.coordinator = this.bots.length ? new Coordinator(this.bots, (msg) => this.addLog(msg), { sell: this.config.sell }) : null;
    this.bots.forEach((bot, index) => setTimeout(() => bot.conn.start(), index * 4000));
    this.running = this.bots.length > 0;
    this.error = '';
    this.addLog(this.bots.length ? `Starting ${this.bots.length} bot${this.bots.length === 1 ? '' : 's'}.` : 'No bots selected.');
  }

  handle(message) {
    try {
      if (message?.type === 'configure') {
        this.config = normalizeConfig(message.config, this.config);
        saveConfig(this.configFile, this.config);
        this.error = '';
        if (message.start) this.startBots();
        this.broadcast();
        return;
      }
      if (message?.type === 'stop') { this.stopBots(); this.addLog('All bots stopped.'); this.broadcast(); return; }
      if (message?.type !== 'set') return;
      if (message.scope === 'fleet' && this.coordinator) {
        if (message.key === 'dungeon') this.coordinator.setDungeonEnabled(!!message.value);
        else if (message.key === 'sell') this.coordinator.setSell(!!message.value);
        else if (message.key === 'targetDungeon') this.coordinator.setTargetDungeon(message.value);
        return;
      }
      const bot = this.bots.find((candidate) => candidate.id === message.botId);
      if (bot) applySetting(bot.ctx.settings, message);
    } catch (error) {
      this.error = error?.message ?? String(error);
      this.addLog(`Configuration error: ${this.error}`);
      this.broadcast();
    }
  }

  botState(bot, index) {
    if (!this.sessions.has(bot.id)) this.sessions.set(bot.id, { kills: 0, deaths: 0, questsDone: 0, xpGained: 0, start: Date.now(), baseCopper: null });
    const state = richState({ world: bot.world, action: bot.action, zone: zoneAt(bot.world.self?.z ?? 0), session: this.sessions.get(bot.id), settings: bot.ctx.settings, logBuf: this.log, online: bot.conn.ready, host: this.config.serverUrl.replace(/^https?:\/\//, ''), name: bot.name, cls: bot.cls });
    return { id: `bot:${index}`, role: bot.role, ...state };
  }

  state() {
    return {
      config: publicConfig(this.config), classes: BOT_CLASSES, maxBots: MAX_BOTS, running: this.running, error: this.error,
      bots: this.bots.map((bot, index) => this.botState(bot, index)),
      fleet: this.coordinator ? { phase: this.coordinator.phase, action: this.coordinator.action, dungeonEnabled: this.coordinator.dungeonEnabled, sellEnabled: this.coordinator.sellEnabled, target: this.coordinator._forceDungeon ?? '', online: this.coordinator.alive().length, size: this.bots.length } : null,
    };
  }

  broadcast() { this.dashboard.broadcast(this.state()); }

  start() {
    this.dashboard.onControl((message) => this.handle(message));
    this.dashboard.start();
    setInterval(() => {
      try { this.coordinator?.tick(); } catch (error) { console.error('[coordinator]', error.message); }
    }, 200);
    setInterval(() => this.broadcast(), 500);
    process.on('SIGINT', () => { this.stopBots(); process.exit(0); });
    console.log(`[console] Open http://localhost:${PORT}/ to configure and start up to ${MAX_BOTS} bots.`);
  }
}

const CONSOLE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>World of Claudecraft Bot Console</title><style>
:root{--panel:#221d13;--panel2:#2c261a;--bd:#4a3f28;--gold:#e8c873;--txt:#e8e0cf;--mut:#9c8f72;--red:#c0392b;--green:#27ae60}*{box-sizing:border-box}body{margin:0;background:linear-gradient(180deg,#1c1810,#0e0c08);color:var(--txt);font:14px/1.45 system-ui,sans-serif}.wrap{max-width:1180px;margin:auto;padding:16px}h1{color:var(--gold);font-size:20px}.card{background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:14px;margin:12px 0}.grid{display:grid;grid-template-columns:repeat(12,1fr);gap:10px}.c4{grid-column:span 4}.c6{grid-column:span 6}.c12{grid-column:span 12}@media(max-width:800px){.c4,.c6{grid-column:span 12}}label{display:block;color:var(--mut);font-size:12px;margin-bottom:3px}input,select,button{width:100%;background:var(--panel2);color:var(--txt);border:1px solid var(--bd);border-radius:6px;padding:8px}button{cursor:pointer;font-weight:600}.primary{background:#6b5723;border-color:var(--gold)}.danger{background:#66251f}.botcfg{padding:12px;border:1px solid var(--bd);border-radius:8px;margin-top:9px}.actions{display:flex;gap:8px}.actions button{max-width:180px}.status{padding:9px;border-radius:6px;background:var(--panel2)}.error{color:#ff8d80}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--red);margin-right:7px}.dot.on{background:var(--green)}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px;border-bottom:1px solid #382f20}.mut{color:var(--mut)}.hidden{display:none}.log{max-height:180px;overflow:auto;font:12px/1.5 monospace;background:#0d0b07;padding:8px}
</style></head><body><div class="wrap"><h1>World of Claudecraft Bot Console</h1><div id="status" class="status">Connecting…</div>
<section class="card"><h2>Launch configuration</h2><div class="grid"><div class="c6"><label>Game server URL</label><input id="server"></div><div class="c4"><label>Number of bots (0–5)</label><input id="count" type="number" min="0" max="5"></div></div><div id="configs"></div><div class="actions" style="margin-top:12px"><button id="save">Save</button><button id="start" class="primary">Save & start</button><button id="stop" class="danger">Stop all</button></div><p class="mut">Passwords are stored only in the local, gitignored <code>console-config.json</code> file and are never sent back to this page.</p></section>
<section id="fleet" class="card hidden"><h2>Running bots</h2><table><thead><tr><th>Status</th><th>Name</th><th>Class / role</th><th>Level</th><th>HP</th><th>Action</th></tr></thead><tbody id="rows"></tbody></table><div id="log" class="log"></div></section></div>
<script>
const TOKEN='__DASH_TOKEN__',esc=s=>String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));let ws,S,dirty=false;
function connect(){ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/dash?token='+encodeURIComponent(TOKEN));ws.onmessage=e=>{S=JSON.parse(e.data);render()};ws.onclose=()=>{document.getElementById('status').textContent='Disconnected — reconnecting…';setTimeout(connect,2000)}}
function send(v){if(ws?.readyState===1)ws.send(JSON.stringify(v))}
function cfgRows(){const count=Math.max(0,Math.min(5,Number(document.getElementById('count').value)||0)),old=S.config.bots;document.getElementById('configs').innerHTML=old.map((b,i)=>'<div class="botcfg '+(i<count?'':'hidden')+'"><b>Bot '+(i+1)+'</b><div class="grid"><div class="c4"><label>Username</label><input data-i="'+i+'" data-k="username" value="'+esc(b.username)+'"></div><div class="c4"><label>Password '+(b.hasPassword?'(saved)':'')+'</label><input type="password" autocomplete="new-password" data-i="'+i+'" data-k="password" placeholder="'+(b.hasPassword?'Leave blank to keep saved password':'Required')+'"></div><div class="c4"><label>Character name</label><input data-i="'+i+'" data-k="characterName" value="'+esc(b.characterName)+'"></div><div class="c4"><label>Class</label><select data-i="'+i+'" data-k="class">'+S.classes.map(c=>'<option '+(c===b.class?'selected':'')+'>'+c+'</option>').join('')+'</select></div></div></div>').join('');document.querySelectorAll('#configs input,#configs select').forEach(e=>e.oninput=()=>dirty=true)}
function readConfig(){const bots=S.config.bots.map(b=>({username:b.username,password:'',characterName:b.characterName,class:b.class}));document.querySelectorAll('#configs [data-i]').forEach(e=>bots[+e.dataset.i][e.dataset.k]=e.value);return{serverUrl:document.getElementById('server').value,botCount:Number(document.getElementById('count').value),sell:S.config.sell,bots}}
function render(){if(!dirty){document.getElementById('server').value=S.config.serverUrl;document.getElementById('count').value=S.config.botCount;cfgRows()}document.getElementById('status').innerHTML=(S.running?'<span class="dot on"></span>Running '+S.bots.length+' bot(s)':'<span class="dot"></span>Dashboard ready — bots are stopped')+(S.error?'<div class="error">'+esc(S.error)+'</div>':'');document.getElementById('fleet').classList.toggle('hidden',!S.bots.length);document.getElementById('rows').innerHTML=S.bots.map(b=>'<tr><td><span class="dot '+(b.online?'on':'')+'"></span>'+(b.online?'Online':'Connecting')+'</td><td>'+esc(b.name)+'</td><td>'+esc(b.cls)+' / '+esc(b.role)+'</td><td>'+(b.level||'—')+'</td><td>'+(b.mhp?Math.round(100*b.hp/b.mhp)+'%':'—')+'</td><td>'+esc(b.action)+'</td></tr>').join('');const logs=S.bots[0]?.log||[];document.getElementById('log').innerHTML=logs.map(l=>'<div><span class="mut">'+esc(l.t)+'</span> '+esc(l.msg)+'</div>').join('')}
document.getElementById('server').oninput=()=>dirty=true;document.getElementById('count').oninput=()=>{dirty=true;cfgRows()};document.getElementById('save').onclick=()=>{send({type:'configure',config:readConfig(),start:false});dirty=false};document.getElementById('start').onclick=()=>{send({type:'configure',config:readConfig(),start:true});dirty=false};document.getElementById('stop').onclick=()=>send({type:'stop'});connect();
</script></body></html>`;

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) new BotConsole().start();
