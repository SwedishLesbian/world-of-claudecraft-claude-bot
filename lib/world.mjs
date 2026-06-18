// Perception: a typed view over the merged delta-compressed snapshot.
import { xpFloorLevel } from './gamedata.mjs';
import { MOB_TEMPLATES } from './mobs.generated.mjs';

// Social-pull reach by family, mirrored from sim.ts SOCIAL_PULL_RADIUS (only murloc is wider); default 5.
const SOCIAL_PULL_RADIUS = { murloc: 8 };
const SOCIAL_DEFAULT = 5;
// a non-elite mob this many levels BELOW the player is "trivial": the server's proximity-aggro detect
// loop skips it entirely (sim.ts isTrivialTo / TRIVIAL_LEVEL_GAP) — so it never wakes by our nearness.
const TRIVIAL_LEVEL_GAP = 10;

const DELTA_SELF_KEYS = ['inv', 'equip', 'qlog', 'qdone', 'cds', 'stats', 'weapon', 'party', 'trade', 'duel', 'marks', 'arena', 'market', 'buyback', 'tal'];
const IDENTITY_KEYS = ['k', 'tid', 'nm', 'lv', 'sc', 'c', 'dgn', 'sk'];  // 'sk' (skin) is identity-only on the wire (game.ts identityFields) — inherit it on lite records like the rest

export class World {
  constructor() { this.self = null; this.ents = new Map(); this.pid = -1; }

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
  // elites/bosses/rares are not soloable by a leveling bot — skip by DATA, not a hand-kept avoid list.
  isElite(m) { const t = MOB_TEMPLATES[m.tid]; return !!(t && (t.elite || t.boss || t.rare)); }

  // The EXTRA mobs that would pile on if I pull `target` right now: its same-template kin inside the
  // social radius (the server pulls them regardless of where I stand) PLUS any idle mob whose own
  // proximity radius already covers the target. Measured from the target's position — conservative,
  // so the bot naturally drifts to genuinely isolated targets instead of body-pulling a pack.
  joiners(target, myLv) {
    const out = [];
    const sr = this.socialRadiusOf(target);
    for (const m of this.mobs()) {
      if (m.id === target.id) continue;
      if (m.aggro != null && m.aggro !== this.pid) continue;        // already busy on someone else
      if (m.own != null) continue;                                  // owned/pet mob: server requires ownerId===null for BOTH social-pull and proximity-aggro (sim.ts) — it never joins
      const d = Math.hypot(m.x - target.x, m.z - target.z);
      // SOCIAL link: same-template kin within the family radius. The server links these regardless of level
      // (aggroMob has no trivial check), so NO trivial gate here — a low-level packmate still gets pulled.
      const social = m.tid === target.tid && d < sr;
      // PROXIMITY: a mob whose own wake radius already covers the target. The server SKIPS trivial mobs
      // (≥10 levels below us, non-elite) from proximity aggro entirely (isTrivialTo), so exclude them here.
      const trivial = !this.isElite(m) && (myLv - (m.lv ?? myLv)) >= TRIVIAL_LEVEL_GAP;
      const proximity = !trivial && d < this.aggroRadiusOf(m, myLv);
      if (social || proximity) out.push(m);
    }
    return out;
  }
  joinCount(target, myLv) { return this.joiners(target, myLv).length; }

  // Cleanest instance among candidates: fewest joiners, then nearest. Returns {m, join} or null.
  cleanestPull(cands, myLv) {
    let best = null, bestKey = Infinity;
    for (const m of cands) {
      const join = this.joinCount(m, myLv);
      const key = join * 1000 + this.dist(m);                        // joiners dominate, then distance
      if (key < bestKey) { bestKey = key; best = { m, join }; }
    }
    return best;
  }
  // Accept a pull within our BRAWL capacity: up to `maxJoin` extra bodies (= combatCap-1), so the pull
  // engages at most `combatCap` mobs — exactly what the flee rule will FIGHT (it flees only when aggro
  // EXCEEDS combatCap). Pulling more than we'll fight would just pull→flee→reset; denser → null (wait/relocate).
  acceptable(best, myLv, maxJoin = 0) {
    if (!best) return null;
    return best.join <= maxJoin ? best.m : null;
  }

  // Best grind target near our level: not grey (0 xp), not above us, not an elite/boss/rare, pullable within
  // our brawl capacity (maxJoin = combatCap-1).
  nearestSafeMob(level, maxJoin = 0) {
    const floor = Math.max(xpFloorLevel(level), level - 4);          // never grey AND never >4 below us
    const cands = this.mobs().filter((m) =>
      !this.isElite(m) && (!m.tap || m.tap === this.pid)
      && (m.lv ?? level) <= level + 1 && (m.lv ?? level) >= floor
      && this.dist(m) < 60);
    return this.acceptable(this.cleanestPull(cands, level), level, maxJoin);
  }
  // Best instance of a quest target tid, cleanly pullable from the edge of its camp (quest-appropriateness
  // — minLevel/group/elite — is handled by the quest engine; here we just pick the cleanest live instance).
  questMob(tid, level, maxJoin = 0) {
    const lv = level ?? (this.self?.lv ?? 1);
    const cands = this.mobs().filter((m) => m.tid === tid && (!m.tap || m.tap === this.pid) && this.dist(m) < 70);
    return this.acceptable(this.cleanestPull(cands, lv), lv, maxJoin);
  }
}
