// Fleet coordinator: forms a party, levels as a group (leash + each bot's brain),
// then runs dungeons with role-based combat (tank/heal/dps), loots, and sells
// rare/epic on the World Market. Reuses the solo brain for leveling.
import { CLASS_KITS, NPCS, abilityCost } from './gamedata.mjs';
import { decide, nextQuestAction } from './brain.mjs';
import { ITEMS } from './items.generated.mjs';
import { routeTo } from './waypoints.mjs';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const learned = (self, ab) => (self.lv ?? 1) >= ab.learnLevel;
// the server bills the HIGHEST-rank cost known at the level (returning before the GCD on a mana fail),
// so use abilityCost — checking the raw rank-1 ab.cost over-reports mana, the bot issues a rejected cast,
// the GCD never advances, and it re-issues every tick = a do-nothing freeze (the bug brain.mjs fixed).
const canCast = (self, ab) => !!ab && learned(self, ab) && (self.gcd ?? 0) <= 0 && !self.cast && ((self.cds?.[ab.id]) ?? 0) <= 0 && (self.res ?? 0) >= abilityCost(self, ab.id, ab.cost);
const QRANK = { poor: 0, common: 1, uncommon: 2, rare: 3, epic: 4 };

// dungeon plan (door positions from src/sim/content/dungeons.ts)
const PLAN = [
  { id: 'hollow_crypt', minLevel: 10, bossLevel: 10, door: { x: 80, z: 90 }, boss: 'morthen', aoe: 12 },
  { id: 'sunken_bastion', minLevel: 13, bossLevel: 13, door: { x: 45, z: 515 }, boss: 'vael_the_mistcaller', aoe: 12 },
  { id: 'gravewyrm_sanctum', minLevel: 19, bossLevel: 20, door: { x: 0, z: 880 }, boss: 'korzul_the_gravewyrm', aoe: 14 },
];
const MERCHANT = { x: 0, z: 9.5 };
const SELL_PRICE = { rare: 80000, epic: 250000, uncommon: 4000 }; // World Market asking price by quality
const SELL_QUALITIES = new Set(['rare', 'epic']);
const NO_DUNGEON = { boss: null, aoe: 0 }; // open-world combat (no boss AoE)
const WIPE_DEATHS = 6;          // deaths in one dungeon with no boss kill -> abort + cooldown (was: infinite re-entry death-loop)
const DUNGEON_COOLDOWN_MS = 600000; // 10 min before re-attempting a wiped dungeon (out-gear/level first)
// boss AoE pulse intervals (ms). The server gives NO telegraph — only this fixed cadence (dungeons.ts
// aoePulse.every). We track time-in-combat and predict each pulse so melee/dps step OUT just before it.
const BOSS_PULSE = { morthen: 10000, vael_the_mistcaller: 10000, korzul_the_gravewyrm: 8000 };

const roleOf = (cls) => cls === 'warrior' ? 'tank' : (['priest', 'paladin', 'druid', 'shaman'].includes(cls) ? 'healer' : 'dps');

export class Coordinator {
  constructor(bots, log, opts = {}) {
    this.bots = bots; this.log = log;
    this.cleared = new Set(); this.phase = 'forming'; this.target = null;
    this.bossSeen = false; this.bossDeadAt = 0; this.lastInvite = 0; this.sellPending = false;
    this.dungeonDeaths = 0; this.dungeonCooldown = {}; this.abortDungeon = false;   // wipe detector (C4)
    this.sellEnabled = !!opts.sell;   // market-selling is opt-in (FLEET_SELL=1); off = keep the loot
    this.dungeonEnabled = opts.dungeon !== false;   // run dungeons by default; the console can toggle off
    this.pulseStart = {};             // boss tid -> ms when its combat (and pulse cadence) began
    this.action = 'Старт флота…';
  }
  // live controls (driven by the unified console's fleet-scope control messages)
  setSell(on) { this.sellEnabled = !!on; }
  setDungeonEnabled(on) { this.dungeonEnabled = !!on; }
  setTargetDungeon(id) { if (PLAN.some((d) => d.id === id)) this._forceDungeon = id; else this._forceDungeon = null; }
  // dynamic leader = first ready+alive bot (FAILOVER): a drop of the hardcoded bots[0] used to freeze the
  // whole fleet with no recovery. Stable while that bot stays up; promotes the next on a drop.
  get leader() { return this.alive()[0] ?? this.bots[0]; }
  alive() { return this.bots.filter((b) => b.conn.ready && b.world.self); }
  entAlive(b, id) { const e = b.world.ents.get(id); return !!e && !e.dead && e.h; }
  inDungeon(b) { const s = b.world.self; return !!s && (s.x > 400 || s.x < -400 || s.z > 1000); }
  // enough of the party is grouped to operate. Don't require ALL bots (a single drop used to halt the
  // four healthy ones); just the leader + at least 2 total (or the whole party if it's tiny).
  partyFormed() { const L = this.leader; const n = L.world?.self?.party?.members?.length ?? 0; return !!L.world.self && n >= Math.min(2, this.bots.length); }

  // ---- helpers ----------------------------------------------------------
  goTo(b, goal) {
    const s = b.world.self, nav = b.ctx.nav;
    const moved = Math.hypot(s.x - nav.lastX, s.z - nav.lastZ);
    if (moved < 0.4) nav.stuck++; else nav.stuck = 0;
    nav.lastX = s.x; nav.lastZ = s.z;
    let f = Math.atan2(goal.x - s.x, goal.z - s.z);
    if (nav.stuck > 8) f += nav.stuck > 40 ? Math.PI : (nav.stuck > 20 ? Math.PI / 2 : Math.sin(nav.stuck) * 1.2);
    b.conn.input({ f: 1 }, f);
  }
  follow(b, target) { if (target.world.self) this.goTo(b, target.world.self); }
  nearestHostile(b, r = 40) {
    const s = b.world.self; let best = null, bd = r;
    for (const e of b.world.ents.values()) { if (e.k !== 'mob' || e.dead || !e.h) continue; const d = dist(s, e); if (d < bd) { bd = d; best = e; } }
    return best;
  }
  lowestHurt(b, thresh) {
    const self = b.world.self; let best = null;
    const cands = [];
    for (const m of (self.party?.members ?? [])) { if (m.dead) continue; cands.push({ id: m.pid, frac: m.hp / Math.max(1, m.mhp), x: m.x, z: m.z }); }
    cands.push({ id: self.id, frac: self.hp / Math.max(1, self.mhp), x: self.x, z: self.z });
    for (const c of cands) { if (c.frac < thresh && (!best || c.frac < best.frac)) best = c; }
    if (best) best.e = { x: best.x, z: best.z };
    return best;
  }
  sellable(b) { return (b.world.self?.inv ?? []).filter((it) => SELL_QUALITIES.has(ITEMS[it.itemId ?? it.id]?.quality)); }

  nextDungeon(partyMin) {
    const now = Date.now(), ok = (d) => (this.dungeonCooldown[d.id] ?? 0) <= now;  // skip a dungeon we just wiped in
    for (const d of PLAN) if (!this.cleared.has(d.id) && partyMin >= d.minLevel && ok(d)) return d;
    return [...PLAN].reverse().find((d) => partyMin >= d.minLevel && ok(d)) ?? null; // all cleared/cooling -> farm top
  }

  // ---- main tick --------------------------------------------------------
  tick() {
    this.ensureParty();
    const r = this.alive();
    // operate as long as the leader is up and enough of the party is grouped — a single dropped bot
    // rejoins on its own (ensureParty re-invites) without halting the others (was: require ALL alive).
    if (!this.partyFormed()) { this.phase = 'forming'; this.action = `Сбор группы (${(this.leader.world.self?.party?.members?.length ?? 0)}/${this.bots.length})`; for (const b of r) if (!this.inDungeon(b)) b.conn.input({}); return; }

    const partyMin = Math.min(...r.map((b) => b.world.self.lv || 1));
    const anyIn = r.some((b) => this.inDungeon(b));
    const nd = this.nextDungeon(partyMin);
    const doDungeon = this.dungeonEnabled && nd && partyMin <= nd.bossLevel + 3;   // console can disable dungeon runs (stay leveling)

    if (anyIn) this.phase = 'dungeon';
    else if (this.sellEnabled && this.sellPending && r.some((b) => this.sellable(b).length)) this.phase = 'selling';
    else if (doDungeon) { this.phase = 'travel'; this.target = nd; }
    else { this.phase = 'leveling'; }   // don't clear sellPending here (was `&& false`, always-false) — driveSell clears it once the loot is actually listed
    this.action = { leveling: `Качаемся группой (ур. ${partyMin})`, travel: `Идём в ${this.target?.id ?? ''}`, dungeon: `Чистим ${this.target?.id ?? ''}`, selling: 'Продаём лут на рынке' }[this.phase] ?? this.action;

    for (const b of r) {
      try { this.driveBot(b); } catch (e) { /* never let one bot break the fleet */ }
    }
  }

  ensureParty() {
    const L = this.leader; if (!L.conn.ready || !L.world.self) return;
    const now = Date.now(); if (now - this.lastInvite < 2500) return; this.lastInvite = now;
    const members = new Set((L.world.self.party?.members ?? []).map((m) => m.pid));
    for (const b of this.bots) { if (b === L || !b.conn.ready || !b.world.self) continue; if (!members.has(b.world.self.id)) L.conn.cmd({ cmd: 'pinvite', id: b.world.self.id }); }
  }

  driveBot(b) {
    const self = b.world.self;
    if (self.dead) {
      // count each death once (edge-triggered) toward the per-dungeon wipe cap (C4)
      if (!b._deadCounted && this.phase === 'dungeon' && !this.bossDeadAt) { b._deadCounted = true; this.dungeonDeaths++; if (this.dungeonDeaths >= WIPE_DEATHS) this.abortDungeon = true; }
      b.conn.cmd({ cmd: 'release' }); b.action = '💀 Воскрешаюсь'; return;
    }
    if (b._deadCounted) b._deadCounted = false;   // respawned — re-arm the edge
    // per-bot pause from the console: the coordinator combat paths don't consult settings, so honor it
    // here in ALL phases (decide() already honors it during leveling for the leader).
    if (b.ctx?.settings?.paused) { b.conn.input({}); b.action = '⏸ Пауза'; return; }
    // human reaction pause (vs server/antibot.ts): hold this bot a tick after its kill/castStop so the
    // stimulus→next-combat-command latency reads human (median ≥150ms → the 'reaction' evidence decays).
    if (Date.now() < (b.ctx.reactionHoldUntil ?? 0)) { b.conn.input({}); return; }
    switch (this.phase) {
      case 'leveling': return this.driveLevel(b);
      case 'travel': return this.driveTravel(b);
      case 'dungeon': return this.driveDungeon(b);
      case 'selling': return this.driveSell(b);
      default: b.conn.input({});
    }
  }

  // group leveling: leader navigates+fights via its brain; followers assist by role,
  // heal the party, accept the same quests at givers, and leash to the leader.
  driveLevel(b) {
    const L = this.leader;
    if (b === L) { b.action = '🧭 Веду группу (кач)'; decide(b.ctx); return; }
    const self = b.world.self;
    // in combat (group fighting) -> role combat
    const groupInCombat = (L.world.self?.target != null && this.entAlive(L, L.world.self.target)) || b.world.mobsAggroOnMe().length > 0 || this.nearestHostile(b, 14);
    if (groupInCombat) { if (b.role === 'healer') return this.healerCombat(b, NO_DUNGEON); return this.dpsCombat(b, NO_DUNGEON); }
    // out of combat: heal hurt, keep buffs, accept/turn-in quests at NPCs, leash
    if (b.role === 'healer') { const hurt = this.lowestHurt(b, 0.7); if (hurt && this.tryHeal(b, hurt)) return; }
    const qa = nextQuestAction(self);
    if (qa && (qa.kind === 'accept' || qa.kind === 'turnin')) { b.conn.cmd({ cmd: qa.kind, quest: qa.quest }); b.action = qa.kind === 'accept' ? '📜 Беру квест' : '✅ Сдаю квест'; return; }
    const d = dist(self, L.world.self);
    if (d > 9) { b.action = '🐾 За лидером'; this.follow(b, L); return; }
    b.conn.input({}); b.action = '⏸ Жду группу';
  }

  driveTravel(b) {
    const nd = this.target, L = this.leader;
    const door = nd.door;
    // leader follows the ROAD GRAPH on long hauls (the dungeon doors are across ridge passes + lakes that a
    // straight-line goTo walks into); routeTo hands off to a direct line for the final approach. Followers
    // just leash to the leader, so they inherit the safe path.
    if (b === L) { if (dist(b.world.self, door) > 6) { b.action = `🧭 Идём в ${nd.id}`; this.goTo(b, routeTo(b.world.self, door)); } else b.conn.input({}); }
    else { const d = dist(b.world.self, L.world.self); if (d > 10) this.follow(b, L); else if (dist(b.world.self, door) > 6) this.goTo(b, door); else b.conn.input({}); }
    // when everyone is gathered at the door, enter together (only those still outside)
    const notIn = this.alive().filter((x) => !this.inDungeon(x));
    if (notIn.length && this.alive().every((x) => this.inDungeon(x) || dist(x.world.self, door) < 8)) {
      for (const x of notIn) x.conn.cmd({ cmd: 'enter_dungeon', dungeon: nd.id });
      if (Date.now() - (this._enterLog || 0) > 8000) { this._enterLog = Date.now(); this.bossSeen = false; this.bossDeadAt = 0; this.dungeonDeaths = 0; this.abortDungeon = false; this.bots.forEach((x) => { x._deadCounted = false; }); this.log(`Группа входит в ${nd.id}`); }
    }
  }

  driveDungeon(b) {
    const nd = this.target ?? PLAN[0], self = b.world.self;
    // BOSS-DEATH detection across EVERY bot's view (not just the leader's). The leader can die and
    // teleport OUT of the instance, dropping the boss from its snapshot — the old code read that empty
    // view as "boss dead" at full HP and falsely marked the dungeon cleared. Require an actually-VISIBLE
    // dead boss corpse; "boss missing from view" is NOT a kill (that's a leaver/wipe, handled below).
    let bossAlive = false, bossVisibleDead = false;
    for (const x of this.alive()) {
      for (const e of x.world.ents.values()) {
        if (e.k === 'mob' && e.tid === nd.boss) { if (e.dead) bossVisibleDead = true; else bossAlive = true; }
      }
    }
    if (bossAlive) this.bossSeen = true;
    if (this.bossSeen && bossVisibleDead && !this.bossDeadAt) { this.bossDeadAt = Date.now(); this.log(`💥 БОСС ПОВЕРЖЕН: ${nd.boss}!`); }

    // WIPE ABORT (C4): too many deaths with no boss kill -> everyone leaves, cooldown the dungeon, go
    // level/gear up instead of charging back in to die forever.
    if (this.abortDungeon && !this.bossDeadAt) {
      if (this.inDungeon(b)) { b.conn.cmd({ cmd: 'leave_dungeon' }); b.action = '🚪 Отступаем (вайп)'; return; }
      b.conn.input({}); b.action = '⚠ Данж отложен';
      if (this.alive().every((x) => !this.inDungeon(x))) { this.dungeonCooldown[nd.id] = Date.now() + DUNGEON_COOLDOWN_MS; this.abortDungeon = false; this.dungeonDeaths = 0; this.bossSeen = false; this.log(`Вайп в ${nd.id} (${WIPE_DEATHS}💀) — отложен на 10мин, качаемся`); }
      return;
    }

    // POST-BOSS: loot briefly, then leave for good (do NOT re-enter)
    if (this.bossDeadAt) {
      if (this.inDungeon(b)) {
        // EVERY bot loots (not just the leader's nearest) for ~15s — boss + final-trash corpses; epics
        // auto-roll to a party member, so all eligible bots issuing `loot` maximizes pickup.
        if (Date.now() - this.bossDeadAt < 15000 && this.lootNearby(b)) return;
        b.conn.cmd({ cmd: 'leave_dungeon' }); b.action = '🚪 Выхожу'; return;
      }
      b.conn.input({}); b.action = '✅ Данж пройден';
      if (this.alive().every((x) => !this.inDungeon(x))) { this.cleared.add(nd.id); this.sellPending = this.sellEnabled; this.bossSeen = false; this.bossDeadAt = 0; this.log(`Данж ${nd.id} зачищен${this.sellEnabled ? ' — идём продавать' : ' (продажа выкл — лут остаётся)'}`); }
      return;
    }

    // CLEARING: get stragglers inside
    if (!this.inDungeon(b)) { if (dist(self, nd.door) > 6) this.goTo(b, nd.door); else b.conn.cmd({ cmd: 'enter_dungeon', dungeon: nd.id }); b.action = 'Вхожу в данж'; return; }

    // survival + role combat
    const hp = self.hp / Math.max(1, self.mhp);
    if (hp < 0.2 && b.role !== 'tank') { this.follow(b, this.leader); b.action = '🏃 Отхожу (мало HP)'; return; }
    if (b.role === 'tank') return this.tankCombat(b, nd);
    if (b.role === 'healer') return this.healerCombat(b, nd);
    return this.dpsCombat(b, nd);
  }

  tankCombat(b, nd) {
    const self = b.world.self;
    // maintain Defensive Stance (selfBuff 'defensive_stance': +threat AND -10% damage taken — the tank
    // has no heals of its own, so this mitigation is its main survival vs the boss AoE pulse).
    if (canCast(self, { id: 'defensive_stance', learnLevel: 10, cost: 0 }) && !(self.auras ?? []).some((a) => a.kind === 'defensive_stance')) { b.conn.cmd({ cmd: 'cast', ability: 'defensive_stance' }); b.action = '🛡 Защитная стойка'; return; }
    let t = self.target != null ? b.world.ents.get(self.target) : null;
    if (!t || t.dead || !t.h) t = this.nearestHostile(b, 30);
    if (!t) { b.action = '🛡 Веду к боссу'; this.goTo(b, { x: self.x, z: self.z + 12 }); return; }
    if (b.world.dist(t) > 4) { b.action = '🛡 Подхожу к ' + (t.nm || t.tid); this.goTo(b, t); return; }
    b.conn.input({}, b.world.faceTo(t));
    if (self.target !== t.id) b.conn.cmd({ cmd: 'target', id: t.id });
    b.conn.cmd({ cmd: 'attack' });
    // BLOODRAGE (off-GCD, 60s cd, free) — top up rage when starved so the threat rotation never stalls.
    if ((self.res ?? 0) < 15 && canCast(self, { id: 'bloodrage', learnLevel: 10, cost: 0 })) { b.conn.cmd({ cmd: 'cast', ability: 'bloodrage' }); }
    // TAUNT (8yd, 10s cd) a mob that slipped onto an ally, to pull threat back to the tank
    const loose = b.world.mobs().find((m) => m.aggro != null && m.aggro !== self.id && b.world.dist(m) <= 8);
    if (loose && canCast(self, { id: 'taunt', learnLevel: 10, cost: 0 })) { b.conn.cmd({ cmd: 'target', id: loose.id }); b.conn.cmd({ cmd: 'cast', ability: 'taunt' }); b.conn.cmd({ cmd: 'target', id: t.id }); b.action = '🗯 Провокация'; return; }
    // threat rotation: on a pack, Thunder Clap (2.5x threat AoE) + Cleave (AoE) to hold MULTIPLE mobs off
    // the dps; else Sunder Armor (flat threat, cheap, no cd), else Heroic Strike filler.
    const near = b.world.hostilesNear(10).length;
    if (near >= 2 && canCast(self, { id: 'thunder_clap', learnLevel: 6, cost: 20 })) b.conn.cmd({ cmd: 'cast', ability: 'thunder_clap' });
    else if (near >= 2 && canCast(self, { id: 'cleave', learnLevel: 18, cost: 20 })) b.conn.cmd({ cmd: 'cast', ability: 'cleave' });
    else if (canCast(self, { id: 'sunder_armor', learnLevel: 10, cost: 15 })) b.conn.cmd({ cmd: 'cast', ability: 'sunder_armor' });
    else if ((self.res ?? 0) >= 15 && (self.gcd ?? 0) <= 0 && !self.cast) b.conn.cmd({ cmd: 'cast', ability: 'heroic_strike' });
    b.action = '🛡 Танкую ' + (t.nm || t.tid);
  }

  // ORDERED heal candidates, best-first: cast the first one canCast() accepts. Never commit to a single
  // unlearnable/on-cooldown top choice (the old code picked flash_heal at <45% — UNLEARNABLE until lv20 —
  // with NO fallback, so a priest healed NOTHING below 45% for the whole 1-19 journey; same for paladin
  // lay_on_hands with its 10-min cooldown). canCast filters learned/cooldown/mana, so a failing top choice
  // simply falls through to the next.
  healChain(cls, frac) {
    // best castable wins. priest gains the mid-cost `heal` (lvl14) to fill the gap before flash_heal@20
    // (lvl1-13 was lesser_heal-only); druid gains `regrowth` (lvl14) between healing_touch and rejuv.
    if (cls === 'priest') return [{ id: 'flash_heal', learnLevel: 20, cost: 75 }, { id: 'heal', learnLevel: 14, cost: 95 }, { id: 'lesser_heal', learnLevel: 1, cost: 30 }];
    if (cls === 'paladin') return [...(frac < 0.35 ? [{ id: 'lay_on_hands', learnLevel: 10, cost: 0 }] : []), { id: 'flash_of_light', learnLevel: 8, cost: 35 }, { id: 'holy_light', learnLevel: 1, cost: 35 }];
    if (cls === 'druid') return [{ id: 'healing_touch', learnLevel: 1, cost: 25 }, { id: 'regrowth', learnLevel: 14, cost: 55 }, { id: 'rejuvenation', learnLevel: 4, cost: 25 }];
    if (cls === 'shaman') return [{ id: 'healing_wave', learnLevel: 1, cost: 25 }];
    const k = CLASS_KITS[cls];
    return [k.healOthers, k.selfHeal].filter(Boolean);
  }
  tryHeal(b, hurt) {
    const self = b.world.self;
    if (dist(self, hurt) > 28) return false;
    for (const heal of this.healChain(b.cls, hurt.frac)) {
      if (canCast(self, heal)) { b.conn.cmd({ cmd: 'target', id: hurt.id }); b.conn.cmd({ cmd: 'cast', ability: heal.id }); b.action = '💚 Лечу группу'; return true; }
    }
    return false;
  }

  healerCombat(b, nd) {
    const self = b.world.self, cls = b.cls;
    // when the boss is enraged (×1.5 dmg) the tank can't dip — heal more proactively (0.92 vs 0.8).
    const hurt = this.lowestHurt(b, this.bossEnraged(b, nd) ? 0.92 : 0.8);
    if (hurt) {
      if (dist(self, hurt) > 28) { this.goTo(b, hurt); b.action = '💚 К раненому'; return; }
      if (this.tryHeal(b, hurt)) return;
    }
    // priest: keep a shield on the tank
    if (cls === 'priest') { const tk = this.leader.world.self; if (tk && tk.hp / tk.mhp < 0.92 && canCast(self, { id: 'power_word_shield', learnLevel: 6, cost: 45 })) { b.conn.cmd({ cmd: 'target', id: tk.id }); b.conn.cmd({ cmd: 'cast', ability: 'power_word_shield' }); b.action = '🛡 Щит на танка'; return; } }
    // priest: roll Renew (HoT) on the tank — a cheap pre-heal that keeps ticking through the boss pulse.
    if (cls === 'priest') { const tk = this.leader.world.self; if (tk && Date.now() - (b._renewAt || 0) > 12000 && canCast(self, { id: 'renew', learnLevel: 8, cost: 30 })) { b.conn.cmd({ cmd: 'target', id: tk.id }); b.conn.cmd({ cmd: 'cast', ability: 'renew' }); b._renewAt = Date.now(); b.action = '🌿 Реню танка'; return; } }
    // druid: pre-drop a Rejuvenation HoT on the lowest party member (instant, ticks into the fight).
    if (cls === 'druid') { const low = this.lowestHurt(b, 0.85); if (low && Date.now() - (b._hotAt || 0) > 8000 && canCast(self, { id: 'rejuvenation', learnLevel: 4, cost: 25 })) { b.conn.cmd({ cmd: 'target', id: low.id }); b.conn.cmd({ cmd: 'cast', ability: 'rejuvenation' }); b._hotAt = Date.now(); b.action = '🌿 HoT'; return; } }
    // position safely near the tank, out of boss AoE
    const tk = this.leader.world.self;
    if (tk) {
      const d = dist(self, tk);
      const boss = [...b.world.ents.values()].find((e) => e.k === 'mob' && !e.dead && e.tid === nd.boss);
      if (boss && dist(self, boss) < nd.aoe + 3) { this.goTo(b, this.awayFrom(self, boss, nd.aoe + 4)); b.action = '↩ Ухожу из AoE'; return; }
      if (d > 24) { this.goTo(b, tk); b.action = '🐾 Держусь у группы'; return; }
    }
    // light dps if safe (and out of mana-danger)
    b.conn.input({}); b.action = '💚 Готов лечить';
  }

  dpsCombat(b, nd) {
    const self = b.world.self;
    let focus = this.leader.world.self?.target;
    let m = focus != null ? b.world.ents.get(focus) : null;
    if (!m || m.dead || !m.h) m = this.nearestHostile(b, 30);
    if (!m) { this.follow(b, this.leader); b.action = '🐾 За группой'; return; }
    // AGGRO BACK-OFF: shed threat if ANY mob is on us (not just the focus) — a multi-mob pull can leave
    // an add beating on the DPS while the focus is still on the tank. Retreat to the tank so threat resets.
    if (b.world.mobsAggroOnMe().length > 0) { b.conn.cmd({ cmd: 'stopattack' }); this.goTo(b, this.leader.world.self); b.action = '⚠ Сбрасываю аггро на танка'; return; }
    const ranged = ['mage', 'hunter', 'warlock'].includes(b.cls);
    const range = ranged ? 22 : 4;
    // boss AoE pulse hits everyone in radius. Ranged simply kite out. MELEE must be in to hit, so it
    // can't fully dodge — but step out once it's taken enough (hp<0.5) instead of standing in the pulse
    // to death (the old code only dodged for ranged, so rogues/melee died every boss).
    const inBossAoe = m.tid === nd.boss && b.world.dist(m) < nd.aoe + 2;
    // step out of the boss AoE: ranged always kite; MELEE steps out only when a pulse is PREDICTED imminent
    // (timed dodge — no telegraph exists) or it's already low — so it dodges each pulse instead of standing in it.
    if (inBossAoe && (ranged || this.pulseDanger(b, nd) || self.hp / Math.max(1, self.mhp) < 0.5)) { this.goTo(b, this.awayFrom(self, m, nd.aoe + 3)); b.action = '↩ Ухожу из AoE'; return; }
    if (b.world.dist(m) > range) { this.goTo(b, m); b.action = '⚔ Сближаюсь'; return; }
    b.conn.input({}, b.world.faceTo(m));
    if (self.target !== m.id) b.conn.cmd({ cmd: 'target', id: m.id });
    b.conn.cmd({ cmd: 'attack' });
    // class-specific dungeon tools (instant/self abilities — fire before the single-target nuke chain).
    const nearAdds = b.world.hostilesNear(10).length;
    if (b.cls === 'mage' && nearAdds >= 2) {                                  // AoE the trash pack
      if (canCast(self, { id: 'arcane_explosion', learnLevel: 14, cost: 60 })) { b.conn.cmd({ cmd: 'cast', ability: 'arcane_explosion' }); b.action = '💥 Arcane Explosion'; return; }
      if (canCast(self, { id: 'frost_nova', learnLevel: 10, cost: 35 })) { b.conn.cmd({ cmd: 'cast', ability: 'frost_nova' }); b.action = '❄ Frost Nova'; return; }
    }
    if (b.cls === 'warlock') {                                                // mana sustain (HP→mana) when safe
      const mp = self.res / Math.max(1, self.mres);
      if (mp < 0.3 && self.hp / Math.max(1, self.mhp) > 0.55 && !inBossAoe && canCast(self, { id: 'life_tap', learnLevel: 6, cost: 0 })) { b.conn.cmd({ cmd: 'cast', ability: 'life_tap' }); b.action = '🩸 Life Tap'; return; }
    }
    const k = CLASS_KITS[b.cls];
    for (const n of (k.nukes ?? [])) { if (canCast(self, n)) { b.conn.cmd({ cmd: 'cast', ability: n.id }); break; } }
    b.action = '⚔ ДПС: ' + (m.nm || m.tid);
  }

  awayFrom(from, mob, d) { const dx = from.x - mob.x, dz = from.z - mob.z, len = Math.hypot(dx, dz) || 1; return { x: mob.x + dx / len * d, z: mob.z + dz / len * d }; }

  // true if a boss AoE pulse is imminent (~1s out) or just landed — non-tanks should be OUT of radius.
  // No server telegraph exists, so predict from time-in-combat: pulses at combat-start, +every, +2·every…
  pulseDanger(b, nd) {
    const every = BOSS_PULSE[nd?.boss]; if (!every) return false;
    const boss = [...b.world.ents.values()].find((e) => e.k === 'mob' && !e.dead && e.tid === nd.boss && e.aggro != null);
    if (!boss) { delete this.pulseStart[nd.boss]; return false; }
    const now = Date.now();
    if (!this.pulseStart[nd.boss]) this.pulseStart[nd.boss] = now;
    const phase = (now - this.pulseStart[nd.boss]) % every;   // ms into the current pulse cycle
    return phase >= every - 1000 || phase < 400;              // step out 1s before … 0.4s after each pulse
  }
  // boss is enraged at <=30% HP (×1.5 dmg) — visible as an 'Enrage' aura on the snapshot OR by HP%.
  bossEnraged(b, nd) {
    const boss = [...b.world.ents.values()].find((e) => e.k === 'mob' && !e.dead && e.tid === nd?.boss);
    return !!boss && ((boss.auras ?? []).some((a) => a.name === 'Enrage' || a.kind === 'enrage') || (boss.hp / Math.max(1, boss.mhp)) <= 0.30);
  }
  // every alive in-instance bot grabs the nearest lootable corpse (rollGroup epics auto-resolve to a
  // party need/greed roll server-side — issuing `loot` is sufficient). Returns true if it acted.
  lootNearby(b) {
    const self = b.world.self;
    const c = [...b.world.ents.values()].filter((e) => e.k === 'mob' && e.dead && e.loot).map((e) => ({ e, d: dist(self, e) })).sort((a, x) => a.d - x.d)[0];
    if (!c) return false;
    if (c.d > 4.5) { this.goTo(b, c.e); b.action = '👜 К добыче'; return true; }
    b.conn.cmd({ cmd: 'loot', id: c.e.id }); b.action = '👜 Лут'; return true;
  }

  // go to the Merchant, COLLECT prior sale proceeds, then list rare/epic loot, then resume.
  driveSell(b) {
    const self = b.world.self;
    if (dist(self, MERCHANT) > 6) { if (b === this.leader) this.goTo(b, routeTo(self, MERCHANT)); else this.follow(b, this.leader); b.action = '🛒 К Торговцу'; return; }
    // CRITICAL: collect gold from already-SOLD listings — proceeds sit in a per-seller collection until
    // you market_collect. The bot used to list but NEVER collect, stranding all the gold. Throttled;
    // the server no-ops if the collection is empty. (self.market wire fields TBD — verify live.)
    if (Date.now() - (b._collectAt || 0) > 20000) { b.conn.cmd({ cmd: 'market_collect' }); b._collectAt = Date.now(); }
    const items = this.sellable(b);
    if (items.length) {
      const it = items[0], id = it.itemId ?? it.id, q = ITEMS[id]?.quality ?? 'uncommon';
      b.conn.cmd({ cmd: 'market_list', item: id, count: it.count ?? 1, price: SELL_PRICE[q] ?? 4000 });
      b.action = '💰 Выставляю ' + (ITEMS[id]?.name || id); this.log(`${b.cls}: выставил ${ITEMS[id]?.name || id} за ${SELL_PRICE[q]}c`);
      return;
    }
    b.conn.input({});
    if (this.alive().every((x) => this.sellable(x).length === 0)) { this.sellPending = false; this.log('Лут выставлен на рынок — продолжаем'); }
    b.action = '✅ Продано';
  }
}
