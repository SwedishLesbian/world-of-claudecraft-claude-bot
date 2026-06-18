// Perception: a typed view over the merged delta-compressed snapshot.
import { xpFloorLevel } from './gamedata.mjs';
import { MOB_TEMPLATES } from './mobs.generated.mjs';
import { affixThreatMult } from './affixes.mjs';

// Social-pull reach by family, mirrored from sim.ts SOCIAL_PULL_RADIUS (only murloc is wider); default 5.
const SOCIAL_PULL_RADIUS = { murloc: 8 };
const SOCIAL_DEFAULT = 5;
// a non-elite mob this many levels BELOW the player is "trivial": the server's proximity-aggro detect
// loop skips it entirely (sim.ts isTrivialTo / TRIVIAL_LEVEL_GAP) — so it never wakes by our nearness.
const TRIVIAL_LEVEL_GAP = 10;
// FLEE-HELP wave, mirrored from sim.ts. A cowardly mob (a FLEEING_FAMILIES member, non-elite) that we bring
// to ≤20% HP panics ONCE and shouts for aid (callForHelp), pulling nearby IDLE same-FAMILY mobs within
// FLEE_HELP_RADIUS — and each one called will itself flee at 20% and call again (the cascade chains). This is
// a SECOND wave the social+proximity counting alone misses (same family ⊋ same template, wider radius), and
// it's the usual killer on dense humanoid/murloc camps. (Constants hand-mirrored from sim.ts; the gamedata
// staleness guard re-flags them if sim.ts changes — see scripts/check_gamedata.mjs.)
const FLEE_HELP_RADIUS = 8;
const FLEEING_FAMILIES = new Set(['humanoid', 'kobold', 'murloc', 'troll']);

const DELTA_SELF_KEYS = ['inv', 'equip', 'qlog', 'qdone', 'cds', 'stats', 'weapon', 'party', 'trade', 'duel', 'marks', 'arena', 'market', 'buyback', 'tal'];
const IDENTITY_KEYS = ['k', 'tid', 'nm', 'lv', 'sc', 'c', 'dgn', 'sk'];  // 'sk' (skin) is identity-only on the wire (game.ts identityFields) — inherit it on lite records like the rest

export class World {
  constructor() {
    this.self = null; this.ents = new Map(); this.pid = -1;
    // OUR combat profile — gates which mob affixes can actually bite us in threatWeight. Default = both
    // (the most conservative: count every gated affix); the brain overwrites it once the class is known.
    this.profile = { caster: true, melee: true };
  }
  // Set by the brain from the running class: { caster: spell-reliant (druid root-kite + pure casters),
  // melee: weapon-reliant }. A hybrid (druid/paladin) is both.
  setCombatProfile(p) { this.profile = p; }

  ingest(snap) {
    // self: heavy fields are delta-only — inherit when absent. Guard a self-less snapshot (would
    // throw on `k in undefined`): keep the previous self instead of nulling it.
    const next = snap.self;
    if (next) {
      if (this.self) for (const k of DELTA_SELF_KEYS) if (!(k in next)) next[k] = this.self[k];
      this.self = next;
    }
    // entities: identity rides only on "full" records; keep[] = alive-unchanged
    const map = new Map();
    for (const w of snap.ents ?? []) {
      const prev = this.ents.get(w.id);
      if (prev && w.k === undefined) for (const key of IDENTITY_KEYS) if (key in prev) w[key] = prev[key];
      map.set(w.id, w);
    }
    for (const id of snap.keep ?? []) { const prev = this.ents.get(id); if (prev) map.set(id, prev); }
    this.ents = map;
    if (this.self) { this.pid = this.self.id; this.ents.set(this.self.id, this.self); }
  }

  pos() { return this.self ? { x: this.self.x, z: this.self.z } : { x: 0, z: 0 }; }
  dist(o) { const p = this.pos(); return Math.hypot(o.x - p.x, o.z - p.z); }
  faceTo(o) { const p = this.pos(); return Math.atan2(o.x - p.x, o.z - p.z); }

  mobs() { return [...this.ents.values()].filter((e) => e.k === 'mob' && !e.dead && e.h); }
  mobsAggroOnMe() { return this.mobs().filter((m) => m.aggro === this.pid); }
  hostilesNear(r) { return this.mobs().filter((m) => this.dist(m) < r); }
  myCorpses() { return [...this.ents.values()].filter((e) => e.k === 'mob' && e.dead && e.loot && e.tap === this.pid); }
  // only LOOTABLE objects: a picked-up object stays in the snapshot as kind 'object' with its
  // `loot` flag cleared until it respawns — without this filter the bot re-targets a depleted
  // node forever (server silently rejects the pickup) and never advances the collect quest.
  groundObjects() { return [...this.ents.values()].filter((e) => e.k === 'object' && e.loot); }
  dungeonExit() { return [...this.ents.values()].find((e) => e.k === 'object' && (e.tid === 'dungeon_exit' || /exit/i.test(e.nm ?? ''))) ?? null; }
  players() { return [...this.ents.values()].filter((e) => e.k === 'player' && e.id !== this.pid && !e.dead); }
  target() { return this.self?.target != null ? this.ents.get(this.self.target) : null; }

  // ── Universal pull model, grounded in the SERVER's real aggro math (sim.ts), not guessed radii. ──
  // PROXIMITY aggro: each template has its own aggroRadius; the effective wake range scales with the
  // level gap — clamp(4, 20, aggroRadius + (mobLv - myLv) * 1.5). So a higher mob wakes from farther,
  // and an out-levelled one barely aggros at all. (A few templates have aggroRadius 0, but the clamp floor
  // of 4 still gives them a 4yd wake radius vs an equal/under-levelled player — low-aggro, not zero.)
  aggroRadiusOf(m, myLv) {
    const base = MOB_TEMPLATES[m.tid]?.aggroRadius ?? 12;            // 12 = sane fallback for an unknown tid
    return Math.max(4, Math.min(20, base + ((m.lv ?? myLv) - myLv) * 1.5));
  }
  // SOCIAL pull: aggroing a mob links its same-TEMPLATE idle neighbours within the family radius.
  socialRadiusOf(m) { return SOCIAL_PULL_RADIUS[MOB_TEMPLATES[m.tid]?.family] ?? SOCIAL_DEFAULT; }
  familyOf(m) { return MOB_TEMPLATES[m.tid]?.family; }
  // elites/bosses/rares are not soloable by a leveling bot — skip by DATA, not a hand-kept avoid list.
  isElite(m) { const t = MOB_TEMPLATES[m.tid]; return !!(t && (t.elite || t.boss || t.rare)); }
  // Will this mob panic-flee at ≤20% HP and shout for same-family aid? Only sentient FLEEING_FAMILIES, and
  // never an elite/boss/rare (sim.ts canFlee). Since the bot KILLS its target, every such engaged mob WILL
  // pass through 20% → its flee-help wave is certain, not hypothetical.
  fleesFamily(m) { return !this.isElite(m) && FLEEING_FAMILIES.has(this.familyOf(m)); }

  // The EXTRA mobs that would EVENTUALLY pile on if I pull `target` — a faithful fixed-point of the SERVER's
  // three pull mechanics (sim.ts), not just the first ring. Starting from the target it expands until stable:
  //   • SOCIAL (one hop): a directly-engaged or proximity-woken mob links its same-TEMPLATE idle kin within
  //     the family radius. Social-pulled kin do NOT re-social (the server's aggroMob social loop is non-
  //     recursive) — but they ARE now engaged, so their own flee-help still fires.
  //   • PROXIMITY: an idle, non-trivial mob whose own wake radius already covers the fight (the target's
  //     position) wakes from the player; it then social-pulls its kin too.
  //   • FLEE-HELP (chains): any engaged fleeing-family mob, on the way to death, calls idle same-FAMILY mobs
  //     within FLEE_HELP_RADIUS — who then flee-call in turn. THIS is the wave the old flat count missed.
  // Measured from each mob's position (the fight roughly happens where the target stands) — conservative, so
  // the bot drifts to genuinely isolated edge targets instead of body-pulling a pack that snowballs as it dies.
  predictPull(target, myLv) {
    const engaged = new Map([[target.id, target]]);
    // candidate pool = only truly IDLE, owner-less mobs (the server's social/proximity/flee loops all gate on
    // aiState==='idle' && ownerId===null). A mob already aggro'd on anyone is busy/already-counted, not a joiner.
    // (We can't see aiState on the wire, so `aggro==null` is the idle proxy. A mob in EVADE also has aggro==null
    // but isn't pullable until it resets home — counting it is a harmless OVER-count, never an under-count.)
    const idle = this.mobs().filter((m) => m.id !== target.id && m.aggro == null && m.own == null);
    // queue items carry `social`: true only for mobs that entered via DIRECT engage or PROXIMITY wake — those
    // (and only those) fire a same-template social pull. Flee-called / social-pulled mobs get social:false.
    const queue = [{ m: target, social: true }];
    const add = (m, social) => { engaged.set(m.id, m); queue.push({ m, social }); };
    // seed: idle non-trivial mobs whose own proximity radius covers the fight position wake from the player
    // (they too social-pull their kin → seeded social:true).
    for (const m of idle) {
      if (engaged.has(m.id)) continue;
      const trivial = !this.isElite(m) && (myLv - (m.lv ?? myLv)) >= TRIVIAL_LEVEL_GAP;
      if (!trivial && Math.hypot(m.x - target.x, m.z - target.z) < this.aggroRadiusOf(m, myLv)) add(m, true);
    }
    while (queue.length) {
      const { m, social } = queue.shift();
      if (social) {
        const sr = this.socialRadiusOf(m);
        for (const n of idle) {
          if (engaged.has(n.id)) continue;
          if (n.tid === m.tid && Math.hypot(n.x - m.x, n.z - m.z) < sr) add(n, false);
        }
      }
      if (this.fleesFamily(m)) {
        const fam = this.familyOf(m);
        for (const n of idle) {
          if (engaged.has(n.id)) continue;
          if (this.familyOf(n) === fam && Math.hypot(n.x - m.x, n.z - m.z) < FLEE_HELP_RADIUS) add(n, false);
        }
      }
    }
    engaged.delete(target.id);
    return [...engaged.values()];
  }
  // back-compat alias: the EXTRA mobs (target excluded). Name kept for callers/tests + engage()'s raw
  // body-pull checks (which want a head-COUNT: "is there any crowd I'd body-pull on the way in?").
  joiners(target, myLv) { return this.predictPull(target, myLv); }
  joinCount(target, myLv) { return this.predictPull(target, myLv).length; }

  // ── UNIFIED WINNABILITY COST MODEL ──────────────────────────────────────────────────────────────────────
  // ONE metric drives every fight/flee/quest decision: the weighted COST of an engagement vs my CAPACITY.
  // A "body count" is the wrong unit — a mob far below my level is facerolled, one above me is a long, deadly
  // fight (and the game's own xp/threat scale with the level gap). So everything weighs mobs by DIFFICULTY:
  //   • threatWeight(m)  — one mob's danger, from the level gap (grey 0 … red 3).
  //   • engageCost(t)    — the whole fight pulling `t` triggers = weight(t) + Σ weight(predicted joiners).
  //   • aggroLoad()      — the difficulty currently pressing on me (Σ weight of my attackers).
  //   • capacity = combatCap(cls) (passed in by the brain) — the weighted budget I can brawl.
  // KILL when a target's engageCost ≤ capacity; FLEE when aggroLoad > capacity; an unwinnable quest camp simply
  // isn't selected (its cost stays > capacity until I out-level it) — no defer timers, recomputed live each tick.
  // The v0.10.0 affix multiplier on a mob's base threat (1 = no affixes / none that bite our build). Looked up
  // by tid from the generated table (affixes are static per template, like aggroRadius/family), gated to our
  // combat profile — see lib/affixes.mjs for the model. Kept separate so threatWeight stays readable.
  affixMult(m) { return affixThreatMult(MOB_TEMPLATES[m.tid]?.affixes, this.profile); }
  threatWeight(m, myLv) {
    const lv = m.lv ?? myLv;
    if (lv <= xpFloorLevel(myLv)) return 0;   // grey — gives 0 xp ⇒ trivial threat, facerolled (the game's own
                                              // level-dependent zero-xp band, not a hardcoded gap, so it's free).
                                              // Affixes don't rescue a grey: it dies before they bite (mult≈moot).
    const gap = myLv - lv;                    // >0 ⇒ the mob is BELOW us (weaker); <0 ⇒ ABOVE us (harder)
    let base;
    if (gap >= 3) base = 0.5;                 // green — easy
    else if (gap >= -2) base = 1;             // yellow / at-level / +1..+2 — a fair fight
    else if (gap >= -4) base = 1.75;          // orange (+3..+4) — slow, dangerous: counts nearly double
    else base = 3;                            // red (+5 and up) — brutal: one alone already blows a 2-cap budget
    // v0.10.0: scale by the mob's affixes — a silencer/anti-healer/stunner is worth more than its level gap
    // alone says (and a swarm of them flees sooner via aggroLoad, which feeds off this same weight).
    return base * this.affixMult(m);
  }
  // Σ threatWeight over the EXTRA mobs a pull drags in (target excluded — that's engageCost's job).
  brawlLoad(target, myLv) { return this.predictPull(target, myLv).reduce((s, m) => s + this.threatWeight(m, myLv), 0); }
  // Full cost of committing to `target`: the target's own difficulty PLUS the cascade it pulls. THE winnability
  // number — a lone over-level mob costs >1 even with zero joiners, a pack of greys costs ~0.
  engageCost(target, myLv) { return this.threatWeight(target, myLv) + this.brawlLoad(target, myLv); }
  // The weighted difficulty currently on me — the flee gate (flee when this exceeds capacity, not on head-count,
  // so the bot brawls a swarm of greys but runs from 3 at-level mobs). Consistent with engageCost by construction.
  aggroLoad(myLv) { return this.mobsAggroOnMe().reduce((s, m) => s + this.threatWeight(m, myLv), 0); }

  // Cheapest WINNABLE instance among candidates: lowest engageCost, then nearest. Returns {m, cost} or null.
  cleanestPull(cands, myLv) {
    let best = null, bestKey = Infinity;
    for (const m of cands) {
      const cost = this.engageCost(m, myLv);
      const key = cost * 1000 + this.dist(m);                        // lowest cost dominates, then distance
      if (key < bestKey) { bestKey = key; best = { m, cost }; }
    }
    return best;
  }
  // Accept a pull whose total cost fits our CAPACITY (= combatCap). Heavier → null (out of our depth right now;
  // the brain grinds winnable mobs / relocates to level up, and the same camp becomes winnable as cost drops).
  acceptable(best, capacity) { return best && best.cost <= capacity ? best.m : null; }

  // Best grind target near our level within capacity: not grey (0 xp), not >1 above, not elite/boss/rare.
  nearestSafeMob(level, capacity = 1) {
    const floor = Math.max(xpFloorLevel(level), level - 4);          // never grey AND never >4 below us
    const cands = this.mobs().filter((m) =>
      !this.isElite(m) && (!m.tap || m.tap === this.pid)
      && (m.lv ?? level) <= level + 1 && (m.lv ?? level) >= floor
      && this.dist(m) < 60);
    return this.acceptable(this.cleanestPull(cands, level), capacity);
  }
  // Cheapest WINNABLE instance of a quest target tid (quest-appropriateness — minLevel/group/elite — is the
  // quest engine's job; here we pick the cheapest live instance and accept it only if its cost fits capacity).
  questMob(tid, level, capacity = 1) {
    const lv = level ?? (this.self?.lv ?? 1);
    const cands = this.mobs().filter((m) => m.tid === tid && (!m.tap || m.tap === this.pid) && this.dist(m) < 70);
    return this.acceptable(this.cleanestPull(cands, lv), capacity);
  }
}
