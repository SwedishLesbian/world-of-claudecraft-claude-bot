// The decision brain: one decide(ctx) per tick. Multi-zone, multi-class.
// Robust: quests ACCELERATE leveling but the bot always falls back to grinding
// safe, level-appropriate mobs across all 3 zones — it never stalls.
import {
  NPCS, QUESTS, QUEST_ORDER, CAMPS, CAMP_LIST, DUNGEON_DOORS, GROUND, ITEM_SOURCE, isEliteTid,
  FOOD, DRINK, HEAL_POT, MANA_POT, CLASS_KITS, campsForLevel, foodVendorNear, zoneAt, ZONES,
  maxZoneIdx, zoneIdxAtZ, mobMaxLevel, xpFloorLevel, abilityCost, modeTune, combatCap,
  TALENT_BUILD, talentPointsAtLevel, pointsSpentIn, sameAlloc,
} from './gamedata.mjs';
import { ruMob, ruQuest } from './ru.mjs';
import { ITEMS } from './items.generated.mjs';
import { CLASS_SURVIVAL } from './abilities.generated.mjs';
import { routeTo, nearestRoadNode } from './waypoints.mjs';

const QRANK = { poor: 0, common: 1, uncommon: 2, rare: 3, epic: 4 };
const AP_PER_STR = { warrior: 2, paladin: 2, shaman: 2, druid: 2, rogue: 1, hunter: 1 };
const AP_PER_AGI = { rogue: 1, hunter: 1 }; // melee AP = str+agi (1/agi, entity.ts); the 2/agi is rangedPower only, irrelevant to weapon scoring (hunter weapons score via the caster branch)
// what THIS character actually values, derived from the verified server formulas (NOT just quality):
// int/spi do NOT scale spell damage (spells are flat) — they only grow mana/regen, so they're tiny;
// armor + stamina = survival; str/agi + weapon dps = melee offense. A bear-tanking druid weights armor
// up (×1.65 like its form). This is what makes the bot keep a 100-armor chest over a 45-armor int-robe.
export function gearRole(ctx) {
  const cls = ctx.CLASS, kit = CLASS_KITS[cls];
  return {
    melee: !!kit?.melee,
    caster: !kit?.melee || cls === 'druid' || cls === 'paladin' || cls === 'shaman', // hybrids cast too
    apPerStr: AP_PER_STR[cls] ?? 0,
    apPerAgi: AP_PER_AGI[cls] ?? 0,
    bearTank: cls === 'druid' && ctx.settings?.bearForm !== false,
  };
}
// role-aware item value. ARMOR is scored survival-first (armor+sta dominate) so a flashy low-armor
// uncommon never beats a high-armor chest for a tank/melee; quality is only a small tiebreak. WEAPONS
// are now scored by ROLE: for melee/bear (auto-attack damage IS the weapon's DPS) the DPS term
// dominates and int/spi are dead weight; for pure casters the weapon is a stat-stick so quality +
// int/spi lead. (items.generated.mjs now carries weapon {min,max,speed} — regen via gen_bot_items.mjs.)
export function gearScore(meta, role) {
  if (!meta || (meta.kind !== 'weapon' && meta.kind !== 'armor')) return -1;
  const st = meta.stats ?? {};
  if (meta.kind === 'weapon') {
    const w = meta.weapon, dps = w ? (w.min + w.max) / 2 / Math.max(0.1, w.speed) : 0;
    if (role?.melee || role?.bearTank) {
      // DPS-dominant: a higher-DPS common staff must beat a low-DPS uncommon caster staff for a bear
      // druid. str/agi add attack power; sta is survival; int/spi don't help an auto-attacker.
      let s = dps * 100;
      s += (st.str ?? 0) * (role.apPerStr || 2) + (st.agi ?? 0) * (role.apPerAgi || 0) + (st.sta ?? 0) * 2;
      s += (QRANK[meta.quality] ?? 1) * 8;   // small tiebreak — cannot outweigh a real DPS gap
      return s;
    }
    // pure caster: spell damage isn't from the weapon — lean on quality + int/spi, DPS minor.
    let s = (QRANK[meta.quality] ?? 1) * 1000 + dps * 14;
    for (const k in st) s += (st[k] || 0) * 4;
    return s;
  }
  let s = (st.armor ?? 0) * (role?.bearTank ? 1.65 : 1) + (st.sta ?? 0) * 5;
  if (role?.melee) s += (st.str ?? 0) * (role.apPerStr || 0) + (st.agi ?? 0) * ((role.apPerAgi || 0) + 0.6);
  if (role?.caster) s += (st.int ?? 0) * 0.3 + (st.spi ?? 0) * 0.5;
  s += (QRANK[meta.quality] ?? 1) * 0.5; // small tiebreak — never flips a survival decision
  return s;
}
const dist2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
// nearest dungeon/arena instance EXIT for an out-of-bounds position. Instances sit on a grid:
// instanceOrigin(idx,slot) = (900 + idx*600, -1250 + slot*500) (server src/sim/data.ts). The exit object
// spawns at origin + exitOffset(0,-6) (sim.ts: createGroundObject(origin.x+exitOffset.x, origin.z+
// exitOffset.z)) — the `entry` offset does NOT apply, so the target is origin.z-6, not origin.z-2 (the old
// value was 4yd short of the real portal). Used to walk back toward the exit before it's in view range.
function instanceExitPoint(self) {
  const idx = Math.max(0, Math.round(((self.x ?? 0) - 900) / 600));
  const slot = Math.max(0, Math.round(((self.z ?? 0) + 1250) / 500));
  return { x: 900 + idx * 600, z: -1250 + slot * 500 - 6 };
}
const learned = (self, ab) => (self.lv ?? 1) >= ab.learnLevel;
// offGcd abilities (e.g. paladin Divine Protection) are accepted by the server during the GCD
// (sim.ts: `if (!ability.offGcd && p.gcdRemaining > 0) return;`), so an `offGcd:true` kit entry skips
// only the GCD test here while every other server gate (cooldown, casting, resource) still applies.
const canCast = (self, ab) => !!ab && learned(self, ab) && (ab.offGcd || (self.gcd ?? 0) <= 0) && !self.cast &&
  ((self.cds?.[ab.id]) ?? 0) <= 0 && (self.res ?? 0) >= abilityCost(self, ab.id, ab.cost);
const invHas = (self, set) => (self.inv ?? []).some((it) => set.has(it.itemId ?? it.id));
const invFind = (self, set) => { const it = (self.inv ?? []).find((x) => set.has(x.itemId ?? x.id)); return it ? (it.itemId ?? it.id) : null; };
const nearest = (list, w) => { let best = null, bd = Infinity; for (const e of list) { const d = w.dist(e); if (d < bd) { bd = d; best = e; } } return best; };
const isBear = (self) => (self.auras ?? []).some((a) => a.kind === 'form_bear');
// is an aura of this kind live with at least `minRem` seconds left? (wire aura = {id,name,kind,rem,dur}).
// Used to avoid re-stacking a HoT/buff that's still ticking — applyAura is a refresh, not a stack, so a
// premature re-cast throws away the remaining ticks and pays full mana again.
const hasAura = (self, kind, minRem = 0) => (self.auras ?? []).some((a) => a.kind === kind && (a.rem ?? 0) > minRem);
const act = (ctx, s) => ctx.setAction(s);
const centroid = (list) => { let x = 0, z = 0; for (const e of list) { x += e.x; z += e.z; } const n = Math.max(1, list.length); return { x: x / n, z: z / n }; };
// pull-safety: open from inside this range with a ranged nuke so we don't walk into a
// camp and body-pull the target's neighbours (caster cast range ~30; margin for latency).
const PULL_RANGE = 26;
// entangling_roots: 1.5s cast, then a 12s root (classes.ts:1144-1146). Track the root from when it
// ACTUALLY lands (cast completion), not from the cast command — so an interrupted cast doesn't leave a
// false "rooted" belief, and the gap-step / re-root timing reflects reality.
const ROOT_CAST_MS = 1500, ROOT_DUR_MS = 12000;
const ROOT_UNTIL = (now) => now + ROOT_CAST_MS + ROOT_DUR_MS;     // expiry assuming the cast we just issued lands
const ROOT_REFRESH_MS = ROOT_CAST_MS + 2000;                      // re-cast this long before expiry so the recast lands first
// heals that drain an ENEMY to heal us (can't be cast on self) and HoTs (one cast lasts a
// while — don't re-stack every GCD). Used by trySelfHeal to target/throttle correctly.
const DRAIN_HEALS = new Set(['drain_life']);
const HOT_HEALS = new Set(['rejuvenation', 'renew']);

// ---- self-heal (any class that owns a heal) -----------------------------
// Cast our best learnable heal on ourselves when below `frac` HP. Works in and out of
// combat; drains are aimed at the mob (they heal by damaging). Throttled so HoTs aren't
// re-stacked. Returns true if it issued a heal. Druid bear form is handled in druidRotate.
function trySelfHeal(ctx, frac, mob) {
  const self = ctx.world.self, K = ctx.kit, now = ctx.now();
  if (!self || self.hp / self.mhp >= frac) return false;
  if (ctx.CLASS === 'druid' && isBear(self)) return false;
  const sh = (K.selfHeal && !learned(self, K.selfHeal) && K.selfHealEarly) ? K.selfHealEarly : K.selfHeal;
  if (!sh || !canCast(self, sh)) return false;
  // a HoT (rejuv/renew) still ticking? don't re-stack it (refresh wastes its remaining ticks + mana) —
  // gate on the live aura, not a blind timer. Direct heals only need the in-flight-cast guard below.
  if (HOT_HEALS.has(sh.id) && hasAura(self, 'hot', 3)) return false;
  if (now < (ctx.selfHealUntil ?? 0)) return false;          // in-flight-cast guard (also covers the 1-tick aura lag)
  if (DRAIN_HEALS.has(sh.id)) {
    if (!mob) return false;                                   // nothing to drain -> can't self-heal
    if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id });
  } else ctx.cmd({ cmd: 'target', id: self.id });
  ctx.cmd({ cmd: 'cast', ability: sh.id });
  ctx.selfHealUntil = now + 1500;
  return true;
}

// ---- navigation ---------------------------------------------------------
// NOTE: tried porting the codex bot's `dungeonDoorBypass` (a perpendicular travel-segment detour) to
// arc around the gravecaller_cultist swarm on the zone2->zone3 crossing — REVERTED after a live test.
// It's travel-only, but our weaker druid gets dragged into COMBAT (fen_troll packs + cultists at the
// z~420-490 boundary) and flees, so it's rarely in clean travelTo where the detour applies; worse, for
// the west ridge camp goal the side-pick can steer it further west. Codex never hits this because it's
// a PALADIN that just kills the boundary mobs. The real fix is combat power (level), not travel geometry.
function goTo(ctx, goal) {
  const w = ctx.world, nav = ctx.nav, p = w.pos();
  // Anti-stuck by NET progress, not per-tick movement: sliding/oscillating
  // against a wall keeps per-tick movement above any small threshold, so a
  // wiggling bot looks "moving" forever and never escapes. Instead anchor a
  // position and only reset the stuck counter once we've actually gained
  // ground (>2yd) from it — thrashing in place now reliably escalates.
  if (nav.anchorX === undefined) { nav.anchorX = p.x; nav.anchorZ = p.z; }
  if (Math.hypot(p.x - nav.anchorX, p.z - nav.anchorZ) > 2) {
    nav.anchorX = p.x; nav.anchorZ = p.z; nav.stuck = 0;
  } else nav.stuck++;
  nav.lastX = p.x; nav.lastZ = p.z;

  let facing = w.faceTo(goal);
  const mi = { f: 1 };
  if (nav.stuck > 8) {
    if (nav.stuck > 50) {                       // long snag: stop pushing in, back out + hop
      facing += Math.PI; mi.j = 1;
    } else if (nav.stuck > 22) {                // sustained strafe to slide past the obstacle, jump ledges
      mi.f = 0; mi.j = 1;
      if (Math.floor(nav.stuck / 12) % 2) mi.sl = 1; else mi.sr = 1;
    } else {                                    // shallow snag: small wiggle off the wall
      facing += Math.sin(nav.stuck) * 1.3;
    }
  }
  ctx.input(mi, facing);
}
const fleeFrom = (ctx, mob) => ctx.input({ f: 1 }, ctx.world.faceTo(mob) + Math.PI);

// UNIVERSAL flee survival, grounded in CLASS_SURVIVAL (generated from each class's real abilities). While
// running from a pack we issue ONLY INSTANT survival — a cast-time spell would be cancelled by the movement
// the caller does right after (sim.ts cancels a cast on move input). This is the fix for the "run⇄cast-heal⇄
// run" stutter that let mobs catch up and kill the bot: heals/shields/potions here are all instant (or
// off-GCD) so they layer ON TOP of the run without ever stopping it. Returns true ONLY when a CAST-TIME
// root/escape is mid-cast and we must HOLD this tick so it lands (caller then returns without moving).
// canCast already gates GCD/cooldown/mana, so on-GCD instants self-serialize across ticks.
export function fleeSurvival(ctx, aggro) {
  const w = ctx.world, self = w.self, now = ctx.now();
  const hp = self.hp / Math.max(1, self.mhp);
  const manaFrac = self.mres ? self.res / self.mres : 1;
  const S = CLASS_SURVIVAL[ctx.CLASS] ?? {};
  // 1. ROOT a chaser to break the chase. AoE root (mage Frost Nova) locks the whole pack instantly → keep
  //    running. Single-target cast root (druid Entangling Roots) must LAND, so HOLD while it casts.
  if (S.root && learned(self, S.root) && manaFrac > 0.15) {
    (ctx.rootUntil ??= new Map());
    if (S.root.cast > 0 && self.cast === S.root.id) return true;                 // mid-cast → hold
    if (canCast(self, S.root)) {
      if (S.root.aoe) { ctx.cmd({ cmd: 'cast', ability: S.root.id }); for (const m of aggro) ctx.rootUntil.set('root:' + m.id, ROOT_UNTIL(now)); act(ctx, '🌀 Сдерживаю стаю'); return false; }
      const chaser = aggro.filter((m) => ((ctx.rootUntil.get('root:' + m.id) ?? 0) - now) < ROOT_REFRESH_MS && w.dist(m) <= 28).sort((a, b) => w.dist(a) - w.dist(b))[0];
      if (chaser) {
        if (self.target !== chaser.id) ctx.cmd({ cmd: 'target', id: chaser.id });
        if (S.root.cast > 0) ctx.input({}, w.faceTo(chaser));                    // face for the cast (server gates on facing)
        ctx.cmd({ cmd: 'cast', ability: S.root.id }); ctx.rootUntil.set('root:' + chaser.id, ROOT_UNTIL(now)); act(ctx, '🌿 Корни в бегстве');
        return S.root.cast > 0;                                                  // cast root → hold; instant root → keep fleeing
      }
    }
  }
  // 2. ESCAPE speed buff — actually outrun the pack (base RUN_SPEED loses to a 7.5-8.5 mob). Instant
  //    (sprint/cheetah) fires and we run faster; cast-time (ghost_wolf 2s) holds while it lands.
  if (S.escape && learned(self, S.escape) && !hasAura(self, 'buff_speed')) {
    if (S.escape.cast > 0 && self.cast === S.escape.id) return true;
    if (canCast(self, S.escape)) { ctx.cmd({ cmd: 'cast', ability: S.escape.id }); act(ctx, '💨 Ускоряюсь — отрываюсь'); return S.escape.cast > 0; }
  }
  // 3. Instant SHIELD / DEFENSIVE (all off-GCD or instant) — damage reduction on the run, never interrupts it.
  if (S.shield && hp < 0.7 && learned(self, S.shield) && canCast(self, S.shield) && !hasAura(self, 'absorb')) ctx.cmd({ cmd: 'cast', ability: S.shield.id });
  if (S.defensive && hp < 0.7 && learned(self, S.defensive) && canCast(self, S.defensive) && !(self.auras ?? []).some((a) => String(a.id).includes(S.defensive.id))) ctx.cmd({ cmd: 'cast', ability: S.defensive.id });
  // 4. Instant HEAL (HoT / Lay on Hands) — heals WHILE running, no cast to cancel. Don't re-stack a live HoT.
  if (S.heal && hp < 0.6 && learned(self, S.heal) && canCast(self, S.heal) && !(S.heal.hot && hasAura(self, 'hot', 3))) {
    ctx.cmd({ cmd: 'target', id: self.id }); ctx.cmd({ cmd: 'cast', ability: S.heal.id });
  }
  // 5. HEAL_POT — instant item, off the shared 60s potion CD. Last resort for classes with no instant heal.
  if (hp < 0.5 && invHas(self, HEAL_POT) && now > ctx.potionCdUntil) { ctx.cmd({ cmd: 'use', item: invFind(self, HEAL_POT) }); ctx.potionCdUntil = now + 60000; }
  return false;   // nothing held → caller flees (moves)
}
// long-haul travel: follow the road graph (threads the zone passes at z=180/540, skirts the
// lakes) instead of dead-reckoning. When badly wedged, peel to the nearest lane node first to
// break off the obstacle, then resume routing. Local goTo still does the per-step moving.
function travelTo(ctx, goal) {
  const p = ctx.world.pos();
  if ((ctx.nav.stuck ?? 0) > 180) { const r = nearestRoadNode(p); if (r && Math.hypot(r.x - p.x, r.z - p.z) > 4) { goTo(ctx, r); return; } }
  goTo(ctx, routeTo(p, goal));
}

// ---- combat -------------------------------------------------------------
function engage(ctx, mob, label) {
  const w = ctx.world, self = w.self, nm = ruMob(mob.tid, mob.nm), K = ctx.kit, d = w.dist(mob);
  if (d > ctx.range) {
    // ranged single-pull: if we have a learnable ranged nuke and the target sits in a pack,
    // do NOT walk in — that body-pulls the neighbours via the server's proximity aggro
    // (sim.ts: any idle mob within ~10-20yd wakes up). Instead nuke from distance and HOLD
    // our ground so the tagged mob peels out to us alone. Bear form has no ranged poke.
    // prefer an INSTANT opener (a learnable DoT, e.g. druid moonfire): it lands its hit + starts the
    // DoT in one GCD before the mob closes, whereas a cast-time nuke (wrath 2s) gets cancelled the
    // instant we reposition (server cancels casts on movement) — wasting the pull GCD.
    // DRUID root-kite: the pull opener is ENTANGLING ROOTS, not a DoT. Rooting at range freezes the mob
    // ~14yd out (it runs in during the 1.5s cast, then stops), so the bot fights from distance instead of
    // walking into melee/the camp (a moonfire opener ate the GCD and delayed the root until the mob had
    // closed to ~5yd = inside the pack → proximity-aggro swarm). Other classes keep the DoT/nuke opener.
    const opener = (ctx.CLASS === 'druid' && K.roots && learned(self, K.roots)) ? K.roots
      : ((K.dots ?? []).find((n) => learned(self, n)) ?? (K.nukes ?? []).find((n) => learned(self, n)));
    // DRUID: bear form has no ranged poke, so it BODY-PULLS the whole camp (this is what got the
    // bot swarmed by 4 murlocs → dead). If the target is in a crowd and we have a learnable nuke,
    // DROP bear here so next tick we can wrath-pull it out alone; druidRotate re-shifts to bear once
    // it reaches melee. Only when not yet tagged + a real crowd exists (a lone mob we just body-pull).
    if (ctx.CLASS === 'druid' && isBear(self) && opener && mob.aggro !== self.id && d <= PULL_RANGE && w.joinCount(mob, self.lv) > 0) {
      ctx.cmd({ cmd: 'cast', ability: 'bear_form' });            // toggle OFF — free-cast form for the pull
      ctx.input({}, w.faceTo(mob));
      act(ctx, (label || 'Бой') + ': готовлюсь тянуть « ' + nm + ' » из стаи');
      return;
    }
    // only treat the opener as RANGED if the class actually has a ranged kit: pure casters (melee:false)
    // and the druid hybrid (wrath@30) do; warrior/rogue/paladin "openers" are melee abilities that the
    // server rejects from range, so those classes must close in (their pull-safety is edge-target choice).
    const hasRangedKit = !ctx.kit.melee || ctx.CLASS === 'druid';
    const canRanged = !!opener && hasRangedKit && d <= PULL_RANGE && !(ctx.CLASS === 'druid' && isBear(self));
    const crowd = canRanged ? w.joinCount(mob, self.lv) : 0;
    // ranged-engage when EITHER the target sits in a pack (single-pull it out — all classes with a ranged
    // kit) OR we're a pure caster (ctx.range>5): a caster opens/kites from distance even on an isolated
    // mob (free nukes while it closes, fewer melee hits). Druid (range 4) keeps closing on lone mobs.
    if (canRanged && (crowd > 0 || ctx.range > 5)) {
      if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id });
      ctx.input({}, w.faceTo(mob)); // stand, face the target — let it come to us, not us into the camp
      if (mob.aggro === self.id) rotate(ctx, mob); // tagged: full rotation from range
      else if (canCast(self, opener)) { ctx.cmd({ cmd: 'cast', ability: opener.id }); if (opener.id === 'entangling_roots') (ctx.rootUntil ??= new Map()).set('root:' + mob.id, ROOT_UNTIL(ctx.now())); } // not tagged: ranged opener pull (track root expiry so druidRotate doesn't immediately re-root)
      act(ctx, (label || 'Бой') + (crowd > 0 ? ': тяну с дистанции « ' + nm + ' » (рядом ' + crowd + ')' : ': бью с дистанции « ' + nm + ' »'));
      return;
    }
    // isolated target (or melee class): close in normally — no pack to body-pull. PALADIN pre-seals
    // while walking in (Seal is a range-0 instant self-buff, no target, no aggro) so its first swing
    // already carries the Holy bonus and Judgement is armed the moment it reaches melee.
    if (ctx.CLASS === 'paladin' && K.seal && !(self.auras ?? []).some((a) => a.kind === 'imbue') && canCast(self, { id: K.seal, learnLevel: 1, cost: 25 })) ctx.cmd({ cmd: 'cast', ability: K.seal });
    act(ctx, (label || 'Бой') + ': подхожу к « ' + nm + ' »'); goTo(ctx, mob); return;
  }
  act(ctx, (label || 'Бой') + ': « ' + nm + ' » (' + Math.round((mob.hp / Math.max(1, mob.mhp)) * 100) + '%)');
  ctx.input({}, w.faceTo(mob));
  if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id });
  // 'attack' is idempotent server-side (startAutoAttack sets autoAttack=true), so only (re)send it when
  // we're not already auto-attacking THIS target — re-sending every tick spammed the server with
  // 'Invalid attack target' the moment our local target lagged a tick behind a kill.
  if (!self.auto || self.target !== mob.id) ctx.cmd({ cmd: 'attack' });
  rotate(ctx, mob);
}
// CASTER ROOT-KITE is the druid's primary solo style. Entangling Roots LOCKS the target (12s; verified
// in sim.ts: NO diminishing-returns vs mobs, and damage does NOT break the root), so we keep our distance
// and Wrath/Moonfire it for ~0 damage taken while doing ~2x bear DPS (nature ignores armor). Bear form is
// now ONLY the emergency tank shell for when 2+ mobs reach melee — a single root can't hold a whole pack.
// (Re-root expiry is tracked locally in ctx.rootUntil because mob auras aren't in the snapshot.)
export function druidRotate(ctx, mob) {
  const w = ctx.world, self = w.self, now = ctx.now(), K = ctx.kit;
  const hp = self.hp / self.mhp, bear = isBear(self), d = w.dist(mob);
  const wantBear = ctx.settings.bearForm !== false && (self.lv ?? 1) >= 10;
  const manaFrac = self.res / Math.max(1, self.mres);
  const bigHeal = { id: 'healing_touch', learnLevel: 1, cost: 25 };
  const attackers = w.mobsAggroOnMe();
  const meleeOnMe = attackers.filter((m) => w.dist(m) < 6).length;   // mobs that can actually swing at us
  const canRoot = !!K.roots && learned(self, K.roots);

  // hard emergency at very low HP: barkskin (off-GCD, any form) + instant heal / potion
  if (hp < 0.3) {
    if (K.defensive && learned(self, K.defensive) && canCast(self, K.defensive) && !(self.auras ?? []).some((a) => String(a.id).includes('barkskin'))) ctx.cmd({ cmd: 'cast', ability: K.defensive.id });
    if (bear) { if (invHas(self, HEAL_POT) && now > ctx.potionCdUntil) { ctx.cmd({ cmd: 'use', item: invFind(self, HEAL_POT) }); ctx.potionCdUntil = now + 60000; } return; }
    if (canCast(self, K.selfHeal)) { ctx.cmd({ cmd: 'target', id: self.id }); ctx.cmd({ cmd: 'cast', ability: K.selfHeal.id }); return; }
    if (canCast(self, bigHeal)) { ctx.cmd({ cmd: 'target', id: self.id }); ctx.cmd({ cmd: 'cast', ability: 'healing_touch' }); return; }
  }

  // BEAR EMERGENCY SHELL: 2+ mobs in melee (one root can't hold the whole pack) → tank in bear armor +
  // Swipe AoE. This is the ONLY job bear keeps now; single targets are root-kited as a caster.
  if (wantBear && meleeOnMe >= 2) {
    if (!bear) { ctx.cmd({ cmd: 'cast', ability: 'bear_form' }); return; }
    if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id });
    if (K.bear.swipe && learned(self, K.bear.swipe) && (self.gcd ?? 0) <= 0 && (self.res ?? 0) >= K.bear.swipe.cost) ctx.cmd({ cmd: 'cast', ability: 'swipe' });
    else if (learned(self, K.bear.maul) && self.queued !== 'maul' && (self.res ?? 0) >= K.bear.maul.cost) ctx.cmd({ cmd: 'cast', ability: 'maul' });
    return;
  }
  // emergency over but still in bear: drop back to caster to resume root-kite once it's safe-solo and we
  // can afford the shift; while 2+ still cling (and bear is off), keep Mauling.
  if (bear) {
    if (meleeOnMe <= 1) { ctx.cmd({ cmd: 'cast', ability: 'bear_form' }); return; } // shifting OUT of a form is FREE (sim.ts togglingOff bypasses the cost) — no rage gate
    if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id });
    if (learned(self, K.bear.maul) && self.queued !== 'maul' && (self.res ?? 0) >= K.bear.maul.cost) ctx.cmd({ cmd: 'cast', ability: 'maul' });
    return;
  }

  // --- CASTER ROOT-KITE (primary) ---
  // 1. ROOT every threat FIRST (before healing): lock the current target AND any OTHER attacker not yet
  //    rooted, so even a 2-3 pull ends fully frozen at range. Root is single-target but re-appliable per mob
  //    with NO diminishing-returns vs mobs, and damage never breaks it (sim.ts). Healing BEFORE rooting was
  //    the bug — a hurt druid spam-healed while STILL being meleed (mana→0, mobs never locked, never killed).
  (ctx.rootUntil ??= new Map());
  if (canRoot && manaFrac > 0.15 && canCast(self, K.roots)) {
    for (const t of [mob, ...attackers]) {                 // current target first, then any extra attacker
      if (!t || t.id === undefined) continue;
      const tk = 'root:' + t.id, tu = ctx.rootUntil.get(tk) ?? 0;
      if (w.dist(t) <= 28 && (tu - now) < ROOT_REFRESH_MS) {  // not rooted (or about to lapse) and in range
        if (self.target !== t.id) ctx.cmd({ cmd: 'target', id: t.id });
        ctx.input({}, w.faceTo(t));                           // FACE the target first — the server gates the root cast on facing (sim.ts:1943); without this a re-root right after a fleeFrom (faced away) is rejected while rootUntil is already set optimistically → a stale "rooted" belief
        ctx.cmd({ cmd: 'cast', ability: K.roots.id }); ctx.rootUntil.set(tk, ROOT_UNTIL(now)); return;
      }
    }
  }
  const rootUntil = ctx.rootUntil.get('root:' + mob.id) ?? 0;
  // 2. maintain the gap: a rooted mob can't move, but if it reached melee before we re-rooted, step away
  //    so it can't swing — then the standoff holds while we nuke from range. Only step once the root has
  //    actually LANDED (rem <= ROOT_DUR_MS) — during the 1.5s cast window the mob is still closing and
  //    moving would cancel our own root cast.
  if (rootUntil - now > 0 && rootUntil - now <= ROOT_DUR_MS && d < 8) { fleeFrom(ctx, mob); return; }
  // 3. mid-HP top-up with the instant HoT (rejuvenation). Don't re-stack while it's still ticking — gate on
  //    the LIVE aura (a HoT already ticks 12s; applyAura refreshes, not stacks, so a premature re-cast burns
  //    its remaining ticks + full mana). The short throttle only covers the 1-tick lag before the aura shows.
  //    Only AFTER the threats are rooted (step 1), so we heal while taking ~0 damage, not into incoming melee.
  if (hp < 0.45 && canCast(self, K.selfHeal) && !hasAura(self, 'hot', 3) && now - ((ctx.healThrottle ??= new Map()).get('self') ?? 0) > 1500) {
    ctx.cmd({ cmd: 'target', id: self.id }); ctx.cmd({ cmd: 'cast', ability: K.selfHeal.id }); ctx.healThrottle.set('self', now); return;
  }
  // OOM rescue: an instant mana potion keeps us rooting+nuking instead of standing helpless.
  if (self.rtype === 'mana' && manaFrac < 0.12 && now > ctx.potionCdUntil && invHas(self, MANA_POT)) {
    ctx.cmd({ cmd: 'use', item: invFind(self, MANA_POT) }); ctx.potionCdUntil = now + 60000; return;
  }

  // 3. nuke from range (stationary cast is safe — the mob is rooted): refresh Moonfire DoT, then Wrath.
  const dotHold = (self.lv ?? 1) >= 10 ? 11000 : 8000;
  for (const dd of K.dots) { if (canCast(self, dd) && (ctx.dotUntil.get(mob.id + ':' + dd.id) ?? 0) < now) { if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id }); ctx.cmd({ cmd: 'cast', ability: dd.id }); ctx.dotUntil.set(mob.id + ':' + dd.id, now + dotHold); return; } }
  for (const n of K.nukes) { if (canCast(self, n)) { if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id }); ctx.cmd({ cmd: 'cast', ability: n.id }); return; } }
  // nothing castable (OOM): the mob is rooted & harmless — hold while Moonfire's DoT + the staff auto-
  // attack chip it down; decide() rests mana once we disengage.
}

// PALADIN — plate melee bruiser. The damage backbone is the FREE auto-attack carrying the Seal's bonus
// Holy damage on every swing, so the bot fights hard even near-empty on mana; mana only funds the Seal,
// Judgement/Exorcism burst, and heals. Priority: stay alive (Lay on Hands → Divine Protection → fast
// heal) → keep the Seal up (it arms Judgement + buffs every swing) → AoE/stun a pack → Judgement →
// Exorcism → auto-attack. canCast gates each spell's own cooldown (self.cds) + the resolved rank cost,
// so we never spam a rejected cast. Retribution talents amplify Seal, Judgement and melee throughput.
export function paladinRotate(ctx, mob) {
  const w = ctx.world, self = w.self, now = ctx.now(), K = ctx.kit;
  const hp = self.hp / Math.max(1, self.mhp);
  const auras = self.auras ?? [];
  // The server's Judgement gate is `kind==='imbue' && value2!==undefined`, but the WIRE aura
  // (server/game.ts: {id,name,kind,rem,dur}) drops value2 — the bot can only see `kind`. A paladin's
  // ONLY imbue source is Seal of Righteousness (Blessing of Might is kind 'buff_ap'), so kind==='imbue'
  // uniquely identifies the Seal on the client. Do NOT add a value2 check here — it's never on the wire,
  // so it would be permanently false and the bot would never Judgement.
  const hasSeal = auras.some((a) => a.kind === 'imbue');
  const attackers = w.mobsAggroOnMe();
  const meleeOnMe = attackers.filter((m) => w.dist(m) < 6).length;   // mobs that can actually swing at us

  // 1. EMERGENCY heal: Lay on Hands — a big FLAT heal (250, or 600 at lv18; free, 10-min cd) at critical HP.
  if (hp < 0.18 && K.bigHeal && canCast(self, K.bigHeal)) {
    ctx.cmd({ cmd: 'target', id: self.id }); ctx.cmd({ cmd: 'cast', ability: K.bigHeal.id }); return;
  }
  // 2. Divine Protection: the absorb shield, when low AND actually being hit (off-GCD, 3-min cd).
  if (hp < 0.4 && meleeOnMe >= 1 && K.bubble && canCast(self, K.bubble) &&
      !auras.some((a) => a.kind === 'absorb' || String(a.id).includes('divine_protection'))) {
    ctx.cmd({ cmd: 'cast', ability: K.bubble.id }); return;
  }
  // 3. Self-heal: prefer the fast Flash of Light (1.5s) over Holy Light (2.5s) mid-combat; throttled
  //    so we don't re-issue while the cast is still in flight.
  if (hp < 0.5 && now >= (ctx.selfHealUntil ?? 0)) {
    const heal = (K.fastHeal && learned(self, K.fastHeal)) ? K.fastHeal : K.selfHeal;
    if (heal && canCast(self, heal)) { ctx.cmd({ cmd: 'target', id: self.id }); ctx.cmd({ cmd: 'cast', ability: heal.id }); ctx.selfHealUntil = now + 1500; return; }
  }
  // 4. Seal upkeep — REQUIRED before Judgement (sim rejects Judgement with no imbue) and adds Holy
  //    damage to every swing. Re-applied here the tick after a Judgement consumes it.
  if (K.seal && !hasSeal && canCast(self, { id: K.seal, learnLevel: 1, cost: 25 })) { ctx.cmd({ cmd: 'cast', ability: K.seal }); return; }
  if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id });   // ensure auto-attack (started by engage) hits the target
  // 5. Consecration: caster-centered AoE when a pack (2+) is on us (lv18+).
  if (meleeOnMe >= 2 && K.aoe && canCast(self, K.aoe)) { ctx.cmd({ cmd: 'cast', ability: K.aoe.id }); return; }
  // 6. Hammer of Justice: stun a SECOND attacker to cut incoming damage; keep the main target for DPS.
  if (meleeOnMe >= 2 && K.stun && canCast(self, K.stun)) {
    const add = attackers.find((m) => m.id !== mob.id && w.dist(m) < 10);
    // face the add before stunning it — the server gates EVERY requiresTarget cast on facing (MELEE_ARC,
    // sim.ts:1943), so an add in our rear cone would otherwise bounce the Hammer ('must be facing your target').
    if (add) { ctx.cmd({ cmd: 'target', id: add.id }); ctx.input({}, w.faceTo(add)); ctx.cmd({ cmd: 'cast', ability: K.stun.id }); ctx.cmd({ cmd: 'target', id: mob.id }); return; }
  }
  // 7. Judgement: instant Holy burst on cd (consumes the Seal → step 4 re-applies it next tick).
  const judge = (K.nukes ?? []).find((n) => n.id === 'judgement');
  if (judge && hasSeal && canCast(self, judge)) { ctx.cmd({ cmd: 'cast', ability: judge.id }); return; }
  // 8. Exorcism: free Holy nuke on cd (no undead restriction in this sim — works on everything).
  const exo = (K.nukes ?? []).find((n) => n.id === 'exorcism');
  if (exo && canCast(self, exo)) { ctx.cmd({ cmd: 'cast', ability: exo.id }); return; }
  // else: keep auto-attacking with the Seal bonus (free) — decide() tops HP/mana once we disengage.
}
// CONDITIONAL-ability gates for the GENERIC (non-druid) rotation: some abilities are only valid in a
// specific state, and firing them otherwise wastes a GCD on a server-rejected cast (sim.ts: execute
// `requiresTargetHpBelow` 0.2; finishers `spendsCombo` so need comboPoints>0). Gate each by id so the loop
// SKIPS it until its condition holds and falls through to the next ability — e.g. a rogue builds combo
// with sinister_strike until it can land eviscerate, instead of spamming a rejected finisher. (Druid uses
// druidRotate, not this — so this is zero-risk to the live bot; it improves warrior/rogue/etc. play.)
export const COND_ABILITY_GATE = {
  execute:        (self, mob) => (mob.hp / Math.max(1, mob.mhp ?? mob.hp)) < 0.2,   // save it for the kill window
  eviscerate:     (self) => (self.combo ?? 0) >= 4,                            // dump the finisher near-max value
  ferocious_bite: (self) => (self.combo ?? 0) >= 4,                            // (cat-form combo finisher, if used)
};
function combatRotate(ctx, mob) {
  const self = ctx.world.self, now = ctx.now(), K = ctx.kit;
  if (trySelfHeal(ctx, 0.5, mob)) return; // self-heal at <=50% (drains hit the mob, heals throttled)
  if (K.seal && !(self.auras ?? []).some((a) => a.kind === 'imbue') && canCast(self, { id: K.seal, learnLevel: 1, cost: 25 })) { ctx.cmd({ cmd: 'cast', ability: K.seal }); return; }
  for (const d of (K.dots ?? [])) { if (canCast(self, d) && (ctx.dotUntil.get(mob.id + ':' + d.id) ?? 0) < now) { if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id }); ctx.cmd({ cmd: 'cast', ability: d.id }); ctx.dotUntil.set(mob.id + ':' + d.id, now + 12000); return; } }
  for (const n of (K.nukes ?? [])) {
    if (!canCast(self, n)) continue;
    const gate = COND_ABILITY_GATE[n.id]; if (gate && !gate(self, mob)) continue;   // hold a conditional ability until its state is met
    if (self.target !== mob.id) ctx.cmd({ cmd: 'target', id: mob.id });
    ctx.cmd({ cmd: 'cast', ability: n.id }); return;
  }
}
// per-class combat rotation dispatch. Druid root-kites (druidRotate), paladin runs the Seal/Judgement
// bruiser loop (paladinRotate); every other class uses the generic combatRotate. Keeping each special
// class on its own function means changes here are zero-risk to the others.
function rotate(ctx, mob) {
  if (ctx.CLASS === 'druid') druidRotate(ctx, mob);
  else if (ctx.CLASS === 'paladin') paladinRotate(ctx, mob);
  else combatRotate(ctx, mob);
}

// ---- help others (heal/buff nearby allies) ------------------------------
function helpOthers(ctx) {
  const w = ctx.world, self = w.self, now = ctx.now(), K = ctx.kit;
  if (!K.healOthers && (K.buffOthers?.length ?? 0) === 0) return false;
  const cands = [];
  for (const m of (self.party?.members ?? [])) { if (m.pid === self.id || m.dead) continue; cands.push({ id: m.pid, frac: m.hp / Math.max(1, m.mhp), x: m.x, z: m.z, nm: m.name }); }
  for (const e of w.players()) cands.push({ id: e.id, frac: e.hp / Math.max(1, e.mhp), x: e.x, z: e.z, nm: e.nm });
  const inRange = (c) => dist2(w.pos(), c) <= 28;
  // heal lowest hurt ally — throttled per-target (no chain-healing one player) and globally
  // rate-limited (≤6 / 60s) so a crowd of hurt players can't make the bot heal every GCD
  // and never level. This is why help could safely be left ON near hubs.
  if (K.healOthers) {
    ctx.helpLog = (ctx.helpLog ?? []).filter((t) => now - t < 60000);
    const hurt = cands
      .filter((c) => c.frac < 0.55 && inRange(c) && (now - (ctx.healThrottle.get(c.id) ?? 0)) > 5000)
      .sort((a, b) => a.frac - b.frac)[0];
    if (hurt && ctx.helpLog.length < 6) {
      // only break bear form for a GENUINELY critical ally, not a routine top-up (no form thrash)
      if (ctx.CLASS === 'druid' && isBear(self)) {
        if (hurt.frac < 0.35) { ctx.cmd({ cmd: 'cast', ability: 'bear_form' }); act(ctx, '🐻➡ Выхожу из формы для лечения'); return true; }
      } else {
        const ab = (hurt.frac >= 0.4 && K.healOthersHot) ? K.healOthersHot : K.healOthers;
        if (canCast(self, ab)) { ctx.cmd({ cmd: 'target', id: hurt.id }); ctx.cmd({ cmd: 'cast', ability: ab.id }); ctx.healThrottle.set(hurt.id, now); ctx.helpLog.push(now); act(ctx, '💚 Лечу игрока ' + (hurt.nm || '')); ctx.log('Лечу игрока ' + (hurt.nm || '#' + hurt.id)); return true; }
      }
    }
  }
  // buff allies missing the buff (throttled per ally+buff). Never drop bear form just to buff
  // a passer-by — that thrash isn't worth a cosmetic buff.
  if (!(ctx.CLASS === 'druid' && isBear(self))) {
    for (const b of (K.buffOthers ?? [])) {
      if (!learned(self, b)) continue;
      for (const c of cands) {
        if (!inRange(c)) continue;
        const key = c.id + ':' + b.id;
        if ((now - (ctx.buffThrottle.get(key) ?? 0)) < 300000) continue;
        if (!canCast(self, b)) continue;
        ctx.cmd({ cmd: 'target', id: c.id }); ctx.cmd({ cmd: 'cast', ability: b.id }); ctx.buffThrottle.set(key, now); act(ctx, '✨ Баффаю ' + (c.nm || '')); return true;
      }
    }
  }
  return false;
}

// ---- self buffs upkeep (out of combat) ----------------------------------
// Keep every learnable class buff up by AURA STATE, not a timer: if the buff's aura is
// missing from self.auras (lapsed, died, never cast), re-apply it. This covers short ones
// (battle_shout 2min, weapon seals/imbues 30s/5min) that a fixed timer would let fall off,
// and long armor/int buffs after a death. Self-target friendly buffs (mark_of_the_wild),
// weapon imbues (seal/rockbiter -> 'imbue'), and plain selfBuffs are all handled.
// v0.6 talent auto-allocation: out of combat, spend any unspent points into the class build (feral for
// druid). One atomic applyTalents sets spec+ranks; the server validates gates/budget. Idempotent — only
// fires when the desired alloc differs from the snapshot's current alloc (self.tal), so no spam; re-syncs
// automatically on level-up (bigger budget → new desired). Throttled to avoid re-sending while the
// post-apply snapshot is in flight. Returns true if it issued a command (caller bails the tick).
function manageTalents(ctx) {
  const self = ctx.world.self, now = ctx.now();
  // capability gate: only drive talents on a server that actually implements them (the snapshot carries
  // self.tal). On a server without the v0.6 talent system, self.tal is undefined — skip cleanly instead
  // of spamming an 'applyTalents' command the server silently drops every few seconds.
  if (self.tal === undefined) return false;
  const build = TALENT_BUILD[ctx.CLASS];
  if (!build || (self.lv ?? 1) < 10) return false;                 // talents unlock at 10; only our class has a build
  const budget = talentPointsAtLevel(self.lv);
  if (budget < 1) return false;
  const cur = self.tal?.alloc ?? { spec: null, ranks: {}, choices: {} };
  const desired = build(budget);
  if (sameAlloc(cur, desired)) return false;                       // already in sync — nothing to do
  if (now < (ctx.talentThrottle ?? 0)) return false;               // wait for the last apply to land in a snapshot
  ctx.talentThrottle = now + 4000;
  ctx.cmd({ cmd: 'applyTalents', alloc: desired });
  const spent = pointsSpentIn(desired);
  act(ctx, `🌳 Таланты: ${desired.spec} (${spent}/${budget} очк.)`);
  return true;
}

function buffSelfUpkeep(ctx) {
  const self = ctx.world.self, K = ctx.kit, now = ctx.now();
  const auras = self.auras ?? [];
  const list = [...(K.buffSelf ?? [])];
  if (ctx.CLASS === 'druid') {
    list.push({ id: 'mark_of_the_wild', learnLevel: 1, cost: 20, aura: 'buff_armor', friendly: true });
    list.push({ id: 'thorns', learnLevel: 6, cost: 20, aura: 'thorns', friendly: true });  // self-cast: free reflect dmg on EVERY melee attacker in a pack (was ally-only)
  }
  if (ctx.CLASS === 'paladin') {
    list.push({ id: 'blessing_of_might', learnLevel: 4, cost: 25, aura: 'buff_ap', friendly: true });  // self-cast AP blessing (5min); buffOthers shares the same spell with allies
  }
  for (const b of list) {
    if (!learned(self, b)) continue;
    if (auras.some((a) => a.id === b.id)) continue;                      // already active — match by aura ID (the sim sets aura.id = ability id), NOT the shared kind (barkskin & mark_of_the_wild are both 'buff_armor', so kind-matching let barkskin suppress Mark re-casts)
    if ((now - (ctx.buffSelfThrottle.get(b.id) ?? 0)) < 3000) continue;  // brief retry guard, not a duration timer
    if (ctx.CLASS === 'druid' && isBear(self)) { ctx.cmd({ cmd: 'cast', ability: 'bear_form' }); return true; } // drop form to (re)buff
    if (!canCast(self, b)) { ctx.buffSelfThrottle.set(b.id, now - 1500); continue; } // off GCD / low mana: retry ~1.5s
    if (b.friendly) ctx.cmd({ cmd: 'target', id: self.id });             // buffTarget spells need a (self) target
    ctx.cmd({ cmd: 'cast', ability: b.id }); ctx.buffSelfThrottle.set(b.id, now); act(ctx, '✨ Баф: ' + b.id); return true;
  }
  return false;
}

// ---- equip upgrades -----------------------------------------------------
function autoEquip(ctx) {
  const self = ctx.world.self, ROLE = gearRole(ctx);
  for (const it of (self.inv ?? [])) {
    const id = it.itemId ?? it.id, meta = ITEMS[id];
    if (!meta || (meta.kind !== 'weapon' && meta.kind !== 'armor') || !meta.slot || ctx.triedEquip.has(id)) continue;
    if (meta.requiredClass && !meta.requiredClass.includes(ctx.CLASS)) continue;   // can't use it -> leave it for sale
    const curId = self.equip?.[meta.slot];
    if (curId && !ITEMS[curId]) continue;                                          // unknown equipped item -> don't risk a downgrade
    if (gearScore(meta, ROLE) > gearScore(ITEMS[curId], ROLE)) {                   // role-aware: survival-first for armor
      ctx.triedEquip.add(id); ctx.cmd({ cmd: 'equip', item: id }); act(ctx, '🛡 Надеваю ' + (meta.name || id)); ctx.log('Надел: ' + (meta.name || id)); return true;
    }
  }
  return false;
}

// vendor armor the bot should BUY to fill empty / under-quality slots. Vendors sell cheap common
// gear for exactly the slots that don't drop reliably (legs/feet) — filling an EMPTY slot is a big
// survival win for an under-geared bot (the lvl11 bot ran with no legs/feet for ages). The server
// ignores a buy for an item the current vendor doesn't stock, so listing cross-zone candidates is
// safe; autoEquip equips the purchase next tick. One buy per call.
// One cheap common item per under-supplied slot. Kept to the slots that DON'T drop reliably (legs,
// feet) so we fill empties without over-buying duplicates for slots we already have. These are what
// zone2's provisioner_hale stocks; autoEquip (quality-rank based) puts them on an empty slot.
// reedwoven_jerkin (armor 62, 2500c) is an INTERIM chest the bot can afford ~15min sooner than the
// 3000c bogiron_hauberk (armor 100) — buying it early gets +48 armor on a 14-armor chest while the
// bot is dying to murloc packs; bogiron (gearScore 1100 > 1062) auto-replaces it once affordable.
// zone2 (provisioner_hale) then zone3 (Highwatch provisioner) common armor — the bot buys whatever its
// CURRENT vendor stocks AND scores as an upgrade, so listing both zones is safe (server ignores a buy a
// vendor doesn't carry). Zone3 adds the big chest jump: highwatch_breastplate armor160 (vs bogiron 100).
const VENDOR_ARMOR = ['reedwoven_trousers', 'fenwalker_boots', 'reedwoven_jerkin', 'bogiron_hauberk', 'cragwalker_boots', 'windguard_leggings', 'stalkerhide_jerkin', 'highwatch_breastplate'];
// WHICH vendor stocks WHICH armor (server content/zone{2,3}.ts vendorItems). The bot must only attempt to
// buy (and only trigger a gear-trip for) gear the CURRENT vendor actually sells — else it logs a false
// "Купил" + wastes a trip buying a zone3 item at the zone2 vendor (server rejects "not sold here"). Both
// vendors are also the zone's FOOD vendor (foodVendorNear → these tids), so buyGear reaches them.
const VENDOR_STOCK = {
  provisioner_hale: new Set(['reedwoven_trousers', 'fenwalker_boots', 'reedwoven_jerkin', 'bogiron_hauberk', 'fenreed_staff']),
  quartermaster_bree: new Set(['cragwalker_boots', 'windguard_leggings', 'stalkerhide_jerkin', 'highwatch_breastplate']),
};
// vendor WEAPONS the bot should buy: a druid has no requiredClass on these staves and bear-swings them,
// so a higher-DPS vendor staff is a real bear upgrade the bot never bought before (gearScore now scores
// weapon DPS). fenreed_staff {9-16,3.0} (provisioner_hale, zone2) ~+50% over the lvl1 staff. NOTE:
// craghorn_staff {16-27,3.0} sits at armorer_hode (zone3), which is NOT the zone3 FOOD vendor the bot
// trips to (quartermaster_bree) — buying it needs separate routing to armorer_hode (future).
const VENDOR_WEAPON = ['fenreed_staff'];
// price for a buyable item — the regenerated buyValue carried in items.generated.mjs (single source of
// truth; the old hand-listed VENDOR_PRICE table matched buyValue 1:1 for all 8 armors → removed).
const buyPrice = (id) => ITEMS[id]?.buyValue ?? 0;
function buyGear(ctx) {
  const w = ctx.world, self = w.self, vendor = foodVendorNear(w.pos());
  const npc = [...w.ents.values()].find((e) => e.k === 'npc' && e.tid === vendor.tid);
  if (!npc) return false;
  const owned = new Set((self.inv ?? []).map((it) => it.itemId ?? it.id));
  const now = ctx.now(), ROLE = gearRole(ctx), stock = VENDOR_STOCK[vendor.tid];
  for (const id of [...VENDOR_ARMOR, ...VENDOR_WEAPON]) {
    const meta = ITEMS[id];
    if (!meta || !meta.slot) continue;
    if (!stock?.has(id)) continue;                                                   // THIS vendor doesn't sell it (don't send a buy the server rejects)
    if (meta.requiredClass && !meta.requiredClass.includes(ctx.CLASS)) continue;     // can't use it
    if (owned.has(id)) continue;                                                     // already bought, awaiting equip
    if ((ctx.gearBuyAt?.get(id) ?? 0) > now - 8000) continue;                        // just tried (avoid double-buy before it lands in inv)
    if ((self.copper ?? 0) < buyPrice(id)) continue;                                 // can't afford it yet -> skip (buy it once we've saved up)
    if (gearScore(meta, ROLE) > gearScore(ITEMS[self.equip?.[meta.slot]], ROLE)) {   // empty slot or a role-aware upgrade
      (ctx.gearBuyAt ??= new Map()).set(id, now);
      ctx.cmd({ cmd: 'buy', npc: npc.id, item: id });
      act(ctx, '🛒 Покупаю экипировку: ' + (meta.name || id)); ctx.log('Купил экипировку: ' + (meta.name || id));
      return true;
    }
  }
  return false;
}
// true if the NEAREST vendor (vendorTid) sells an affordable armor upgrade for a slot — only then is a
// gear-trip worth making. Gating on the vendor's own stock stops the bot tripping to provisioner_hale
// (zone2) for a highwatch_breastplate it only sells in zone3.
function needsVendorGear(self, role, vendorTid) {
  const stock = VENDOR_STOCK[vendorTid]; if (!stock) return false;
  for (const id of [...VENDOR_ARMOR, ...VENDOR_WEAPON]) {
    if (!stock.has(id)) continue;
    const meta = ITEMS[id]; if (!meta || !meta.slot) continue;
    if ((self.copper ?? 0) < buyPrice(id)) continue;                                 // only count gear we can afford NOW (buyGear filters wrong-class)
    if (gearScore(meta, role) > gearScore(ITEMS[self.equip?.[meta.slot]], role)) return true;
  }
  return false;
}

// ---- sell junk / replaced gear ------------------------------------------
const SELL_SKIP_KIND = new Set(['quest', 'food', 'drink', 'potion', 'tool']);
// items safe to vendor: trash, gear we can't use (wrong class), or gear no better
// than what's equipped. Never consumables, quest items, or anything equipped.
function sellableItems(ctx) {
  const self = ctx.world.self, equipped = new Set(Object.values(self.equip ?? {})), ROLE = gearRole(ctx);
  const out = [];
  for (const it of (self.inv ?? [])) {
    const id = it.itemId ?? it.id, meta = ITEMS[id];
    if (!meta || equipped.has(id)) continue;
    // mana classes DRINK these (instant, in-combat OOM rescue — see tryManaPotion); only a NON-mana
    // class can't use them, so only those vendor them. (Was: always sold — threw away the rescue.)
    if (MANA_POT.has(id)) { if (ctx.kit?.resource !== 'mana') out.push({ id, count: it.count ?? 1, meta }); continue; }
    if (SELL_SKIP_KIND.has(meta.kind)) continue;
    let sell = false;
    if (meta.kind === 'junk' || meta.quality === 'poor') sell = true;
    else if (meta.kind === 'weapon' || meta.kind === 'armor') {
      const usable = !meta.requiredClass || meta.requiredClass.includes(ctx.CLASS);
      if (!usable) sell = true;                                   // can never equip it
      else if (meta.slot) {
        const cur = ITEMS[self.equip?.[meta.slot]];
        // SURVIVAL GUARD: never vendor an item that out-armors what's equipped — a higher-armor common
        // chest is worth keeping over a flashy low-armor uncommon (int/spi don't boost flat-damage
        // spells, so the robe is a survival downgrade). This stops the bot selling its Bogiron (100
        // armor) for a 45-armor robe. (Full per-class item valuation comes next from the design pass.)
        const armorBetter = meta.kind === 'armor' && (meta.stats?.armor ?? 0) > (cur?.stats?.armor ?? 0);
        if (!armorBetter && gearScore(meta, ROLE) <= gearScore(cur, ROLE)) sell = true; // not a role-aware upgrade
      }
    }
    if (sell) out.push({ id, count: it.count ?? 1, meta });
  }
  return out;
}
function sellJunk(ctx) {
  const list = sellableItems(ctx);
  if (!list.length) return false;
  // sell the highest-value stack FIRST — a vendor trip can be cut short (combat, bags), so bank the
  // valuable drops before the trash (was inventory order: could vendor a 1c weed before a 600c drop).
  const s = list.slice().sort((a, b) => ((b.meta.sellValue ?? 0) * b.count) - ((a.meta.sellValue ?? 0) * a.count))[0];
  ctx.cmd({ cmd: 'sell', item: s.id, count: s.count });
  const val = (s.meta.sellValue ?? 0) * s.count;
  act(ctx, '💰 Продаю ' + (s.meta.name || s.id));
  ctx.log('Продал: ' + (s.meta.name || s.id) + (val ? ' (+' + val + 'м)' : ''));
  return true;
}

// ---- rest ---------------------------------------------------------------
function rest(ctx) {
  const w = ctx.world, self = w.self;
  const hp = self.hp / self.mhp, mana = self.mres ? self.res / self.mres : 1;
  if (w.hostilesNear(16).length > 0) return false;
  const manaRes = self.rtype === 'mana'; // in bear/cat form rtype is rage/energy — don't "rest mana"
  // CHEAP-DEATH / XP-first: a bear-capable druid does NOT stand idle to recover mana — it goes and fights
  // in BEAR form (rage-powered, zero mana). Mana is FROZEN in savedMana while in form (it does NOT regen —
  // entity.ts/sim.ts), but continuous bear damage still beats nuke-then-rest-30s, and death is near-free so
  // the mana cushion isn't worth the downtime. rest() drops form before topping mana; it only rests mana
  // when nearly OOM (< ~6%, i.e. can't even afford the 30-mana bear shift + a clutch HoT).
  const canBearFight = ctx.CLASS === 'druid' && (self.lv ?? 1) >= 10 && ctx.settings.bearForm !== false;
  // PALADIN is the only melee mana-user: its auto-attack is FREE, so — like a bear druid — it goes and
  // fights at low mana (mana funds Seal/Judgement/heals, but swings continue dry) instead of sitting idle
  // to 70%. Resting mana only near-OOM keeps its downtime as low as a rage/energy melee class.
  const freeMelee = canBearFight || ctx.CLASS === 'paladin';
  const needHp = hp < 0.6, needMana = manaRes && mana < (freeMelee ? 0.06 : 0.45);
  if (!needHp && !needMana) return false;
  if (ctx.CLASS === 'druid' && isBear(self)) { ctx.cmd({ cmd: 'cast', ability: 'bear_form' }); return true; } // drop form to eat/drink
  // healers: spend (usually abundant) out-of-combat mana to HEAL UP instead of standing idle
  // on slow regen / waiting for food — this was pinning the bot at ~55% HP when out of food.
  if (needHp) {
    const K = ctx.kit;
    // druid: prefer the INSTANT kit heal (rejuvenation HoT) so we keep moving to the next pull while
    // it ticks, instead of standing for a 2.5s healing_touch; use the big cast only when really low or
    // the HoT is already running.
    const ht = { id: 'healing_touch', learnLevel: 1, cost: 25 };
    const heal = ctx.CLASS === 'druid'
      ? ((hp < 0.4 || (self.auras ?? []).some((a) => a.kind === 'hot')) ? ht : (K.selfHeal ?? ht))
      : ((K.selfHeal && !learned(self, K.selfHeal) && K.selfHealEarly) ? K.selfHealEarly : K.selfHeal);
    if (heal && !DRAIN_HEALS.has(heal.id) && canCast(self, heal)) {
      ctx.cmd({ cmd: 'target', id: self.id }); ctx.cmd({ cmd: 'cast', ability: heal.id });
      act(ctx, '💚 Лечусь (отдых)'); ctx.input({}); return true;
    }
  }
  // instant mana refill: a mana potion (off the shared 60s potion CD) skips the sit-and-drink, cutting
  // the rest downtime that pins a caster druid when out of water. Cheap to keep (no bag limit) — these
  // are now KEPT for mana classes instead of vendored (the OOM rescue the brain is built around).
  if (needMana && ctx.now() > ctx.potionCdUntil) {
    const mp = invFind(self, MANA_POT);
    if (mp) { ctx.cmd({ cmd: 'use', item: mp }); ctx.potionCdUntil = ctx.now() + 60000; act(ctx, '🧪 Пью зелье маны'); ctx.input({}); return true; }
  }
  if (self.eat || self.drk) { act(ctx, '🍗 Отдыхаю (ем/пью)'); ctx.input({}); return true; }
  let used = false;
  // The server rejects food/drink while inCombat (engaged || combatTimer<5, sim.ts) — so even with no
  // hostile in range, the ~5s tail right after a kill bounces the 'use'. Mirror that combat-lock: only
  // eat/drink once ~5s past our last kill, so we don't spam rejected 'use' commands during the tail.
  const combatGrace = (ctx.now() - (ctx.lastKill ?? 0)) > 5000;
  if (ctx.settings.buyFood !== false && combatGrace) {
    if (hp < 0.85) { const f = invFind(self, FOOD); if (f) { ctx.cmd({ cmd: 'use', item: f }); used = true; } }
    if (manaRes && mana < 0.85) { const d = invFind(self, DRINK); if (d) { ctx.cmd({ cmd: 'use', item: d }); used = true; } }
  }
  act(ctx, used ? '🧘 Отдыхаю — восстанавливаюсь' : '🧘 Стою, восстанавливаюсь');
  ctx.input({});
  // restock when actually OUT of what we need: food for HP, drink for mana, AND heal potions — the latter
  // are the UNIVERSAL survival tool (the only instant heal a low-level class has before it learns one), so
  // make a vendor trip to stock them rather than dying tool-less in a pull. invHas false the whole time at
  // low level (never bought any) → one trip stocks the buffer (restock buys 8), then it's quiet until they run out.
  if (!used && (self.copper ?? 0) >= 200 && ctx.settings.buyFood !== false &&
      ((needHp && !invHas(self, FOOD)) || (manaRes && mana < 0.85 && !invHas(self, DRINK)) || !invHas(self, HEAL_POT))) ctx.needRestock = true;
  return hp < 0.9 || (manaRes && mana < (freeMelee ? 0.2 : 0.7));  // bear druid / paladin only top mana to ~20% (enough for a seal+heal), then go fighting
}

// ---- quest engine -------------------------------------------------------
function unsoloable(q) {
  for (const o of q.objectives) {
    if (o.type === 'kill' && isEliteTid(o.targetMobId)) return true;                                 // elite/boss/rare kill target → not soloable
    if (o.type === 'collect' && !GROUND[o.itemId]) { const src = ITEM_SOURCE[o.itemId]; if (!src || isEliteTid(src)) return true; }  // drop sourced from an elite/boss/rare
  }
  return false;
}
function questState(qid, self, done, qlog) {
  const q = QUESTS[qid]; if (!q) return 'skip';
  if (unsoloable(q)) return 'skip';   // skip is now PURELY data-driven (elite/boss/rare objective) — no hand-kept list
  if (done.has(qid)) return 'done';
  const ql = qlog.get(qid);
  if (ql) return ql.state === 'ready' ? 'ready' : 'active';
  if (q.requiresQuest && !done.has(q.requiresQuest)) return 'unavailable';
  if (q.minLevel && (self.lv ?? 1) < q.minLevel) return 'unavailable';
  return 'available';
}
// Return the first INCOMPLETE objective that is currently pursuable. `accept(action)` (optional) lets the
// caller reject an objective that's level-gated / death-blocked / zone-gated right now — we then try the
// NEXT incomplete objective instead of abandoning the whole quest (a blocked FIRST objective used to hide
// an otherwise-reachable later one). An unmappable objective is skipped, not treated as quest-ending.
function pursueObjective(qid, self, qlog, accept = null) {
  const q = QUESTS[qid], ql = qlog.get(qid); if (!ql) return null;
  for (let i = 0; i < q.objectives.length; i++) {
    const o = q.objectives[i];
    if ((ql.counts[i] ?? 0) >= o.count) continue;
    let a = null;
    if (o.type === 'kill') a = { kind: 'kill', mobId: o.targetMobId, goal: CAMPS[o.targetMobId] };
    else if (GROUND[o.itemId]) { const here = { x: self.x, z: self.z }; const g = GROUND[o.itemId].map((p) => ({ p, d: dist2(here, p) })).sort((x, y) => x.d - y.d)[0].p; a = { kind: 'collect_ground', itemId: o.itemId, goals: GROUND[o.itemId], goal: g }; }
    else { const src = ITEM_SOURCE[o.itemId]; if (src && CAMPS[src]) a = { kind: 'kill', mobId: src, goal: CAMPS[src] }; }
    if (!a) continue;                      // unmappable objective -> try the next, don't abandon the quest
    if (accept && !accept(a)) continue;    // gated/blocked right now -> try the next incomplete objective
    return a;
  }
  return null;
}
export function nextQuestAction(self, memo = {}, deferred = null) {
  const done = new Set(self.qdone ?? []);
  const isDeferred = (qid) => !!(deferred && deferred.has(qid));
  const qlog = new Map((self.qlog ?? []).map((q) => [q.questId, q]));
  const here = { x: self.x, z: self.z };
  // deferred quests (barren collect / server-refused accept) are treated as 'skip' so they're ignored by
  // EVERY step below (accept/sweep/goto/objective), not just objective-pursuit — this is what lets the
  // anti-stuck guard's defer actually stop a frozen accept loop. A 'ready' (completed) quest is never
  // skipped, so a deferred-then-finished quest can still be handed in.
  const st = {}; for (const qid of QUEST_ORDER) { const s = questState(qid, self, done, qlog); st[qid] = (isDeferred(qid) && s !== 'ready') ? 'skip' : s; }
  // zone gate: don't travel to a giver/objective in a zone we're under-levelled for (the bot
  // out-levels its current zone, then crosses). Turn-ins we're standing on stay ungated so a
  // finished quest can always be handed in.
  const maxZ = maxZoneIdx(self.lv);                       // forward zone gate only (no death-block retreat)
  const zOK = (p) => !!p && zoneIdxAtZ(p.z) <= maxZ;
  // 1) standing on an NPC -> hand in / accept its whole offer (one per tick = batched)
  for (const qid of QUEST_ORDER) if (st[qid] === 'ready' && NPCS[QUESTS[qid].turnin] && dist2(here, NPCS[QUESTS[qid].turnin]) <= 6) return { kind: 'turnin', quest: qid };
  for (const qid of QUEST_ORDER) if (st[qid] === 'available' && NPCS[QUESTS[qid].giver] && zOK(NPCS[QUESTS[qid].giver]) && dist2(here, NPCS[QUESTS[qid].giver]) <= 6) return { kind: 'accept', quest: qid };
  // 2) HUB SWEEP (A): before running off to grind, detour to the nearest giver/turn-in
  //    within reach to grab a batch of quests (and hand finished ones in). Capped so a
  //    low-level bot never crosses the zone for one extra quest — it sweeps the cluster
  //    of NPCs around the hub, then leaves with several quests at once.
  const SWEEP = 60;
  let sweep = null, sweepD = SWEEP;
  for (const qid of QUEST_ORDER) {
    if (st[qid] === 'available' && zOK(NPCS[QUESTS[qid].giver])) { const d = dist2(here, NPCS[QUESTS[qid].giver]); if (d < sweepD) { sweep = { kind: 'goto', quest: qid, goal: NPCS[QUESTS[qid].giver] }; sweepD = d; } }
    if (st[qid] === 'ready' && zOK(NPCS[QUESTS[qid].turnin])) { const d = dist2(here, NPCS[QUESTS[qid].turnin]); if (d < sweepD) { sweep = { kind: 'goto', quest: qid, goal: NPCS[QUESTS[qid].turnin] }; sweepD = d; } }
  }
  if (sweep) return sweep;
  // 3) pursue the NEAREST active objective (B), but LOCK onto it until it's done so the
  //    bot doesn't thrash between two similar-distance camps. With several quests in hand
  //    it clears the closest camp fully, then the next closest — co-located objectives
  //    (e.g. supply crates + bandits, both south-east) get done in one trip.
  const actives = [];
  // KILL-quest gate: don't pursue a kill objective whose mob TEMPLATE out-levels us by more than the
  // margin (mobMaxLevel > self.lv + QUEST_LVL_MARGIN) — a way-too-high quest mob hits too hard to solo
  // even cleanly pulled. Pull DENSITY is no longer gated here: questMob() picks the cleanest live instance
  // via the joinCount model, so the bot chips a dense camp from its isolated edge instead of body-pulling.
  //   collectGuarded (below) is the one geometric exception: a ground node you must STAND on can sit inside
  //   a too-high/elite camp's footprint (can't edge-pull a node), so those wait until we out-level the camp.
  const QUEST_LVL_MARGIN = 2;  // quest a mob whose template tops at most +2 above us (death is free — sim-verified zero penalty — so lean into quest XP)
  // a ground node is "guarded" when it sits inside a too-high camp's footprint. NORMAL camps use the +2
  // margin; DANGEROUS/elite camps (e.g. ogre_crusher lv17, radius 18 — its proximity-aggro covers all 7
  // ogre_war_totem nodes) must be FULLY out-levelled first (top < self.lv), or the squishy bot wakes an
  // elite it can't fight while standing on the node. (q_ogre_totems thus waits until ~lv18 — safe.)
  const collectGuarded = (p) => !!p && CAMP_LIST.some((c) => {
    const top = mobMaxLevel(c.mobId);
    const tooHigh = isEliteTid(c.mobId) ? (top >= (self.lv ?? 1)) : (top > (self.lv ?? 1) + QUEST_LVL_MARGIN);
    return tooHigh && Math.hypot((c.x ?? 0) - p.x, (c.z ?? 0) - p.z) <= (c.radius ?? 0) + 6;
  });
  // OUT-LEVELLED quests: skip a kill objective whose mob is BELOW our worth-it band — the SAME band the
  // grinder uses (max(grey-floor, lv-4)). An over-levelled bot (out-grew a zone, or got a big turn-in)
  // shouldn't slog low content for scraps: those mobs pay almost nothing (mobXpValue anti-farm scaling).
  // It moves UP to level-appropriate quests instead of backtracking. (Unknown mob → maxLevel 0 → not
  // gated, so a quest whose target isn't in the table is still pursued.)
  const questFloor = Math.max(xpFloorLevel(self.lv ?? 1), (self.lv ?? 1) - 4);
  // an objective is pursuable NOW if its goal is in an allowed zone, the kill target's TEMPLATE is within
  // our band (not >margin above, not below the worth-it floor), and a ground node isn't inside a too-high camp.
  const pursuable = (a) => !!a.goal && zOK(a.goal)
    && !(a.kind === 'kill' && mobMaxLevel(a.mobId) > (self.lv ?? 1) + QUEST_LVL_MARGIN)
    && !(a.kind === 'kill' && mobMaxLevel(a.mobId) > 0 && mobMaxLevel(a.mobId) < questFloor)
    && !(a.kind === 'collect_ground' && collectGuarded(a.goal));
  for (const qid of QUEST_ORDER) if (st[qid] === 'active' && !isDeferred(qid)) { const a = pursueObjective(qid, self, qlog, pursuable); if (a) actives.push({ ...a, quest: qid, _d: dist2(here, a.goal) }); }
  if (actives.length) {
    const pick = actives.find((a) => a.quest === memo.lock) || actives.sort((x, y) => x._d - y._d)[0];
    memo.lock = pick.quest;
    const { _d, ...action } = pick; return action;
  }
  memo.lock = null;
  // 4) nothing active+reachable -> go to the nearest pending NPC (turn-in first, then giver)
  let go = null, goD = Infinity;
  for (const qid of QUEST_ORDER) if (st[qid] === 'ready' && zOK(NPCS[QUESTS[qid].turnin])) { const d = dist2(here, NPCS[QUESTS[qid].turnin]); if (d < goD) { go = { kind: 'goto', quest: qid, goal: NPCS[QUESTS[qid].turnin] }; goD = d; } }
  if (go) return go;
  for (const qid of QUEST_ORDER) if (st[qid] === 'available' && zOK(NPCS[QUESTS[qid].giver])) { const d = dist2(here, NPCS[QUESTS[qid].giver]); if (d < goD) { go = { kind: 'goto', quest: qid, goal: NPCS[QUESTS[qid].giver] }; goD = d; } }
  return go;
}
function restock(ctx) {
  const w = ctx.world, self = w.self, vendor = foodVendorNear(w.pos());
  const npc = [...w.ents.values()].find((e) => e.k === 'npc' && e.tid === vendor.tid);
  if (!npc) return;
  const countOf = (set) => (self.inv ?? []).reduce((n, it) => n + (set.has(it.itemId ?? it.id) ? (it.count ?? 1) : 0), 0);
  // Buy ONLY what we actually use and are low on. The server ignores items a vendor doesn't stock, so
  // listing several food/drink names is fine — it buys whichever are available. (Mana potions ARE bought
  // below for mana classes — they're the instant in-combat OOM rescue the caster rotation + rest() depend
  // on — but never for rage/energy classes, which don't use them.)
  const want = [];
  if (countOf(FOOD) < 5) want.push('baked_bread', 'roasted_boar', 'fenbridge_rye', 'smoked_eel', 'trail_hardtack', 'roast_mountain_goat');
  if (self.rtype === 'mana' && countOf(DRINK) < 5) want.push('spring_water', 'marsh_mint_tea', 'meltwater_flask');
  // carry a BUFFER of heal pots out of zone1: only trader_wilkes (zone1) stocks minor_healing_potion,
  // NOT zone2's provisioner_hale — so without a buffer the bear/caster emergency-heal (gated on
  // invHas HEAL_POT) is dead code during zone2 murloc fights and the bot has no clutch heal. The
  // server silently ignores buys a vendor doesn't stock, so this is a no-op away from trader_wilkes.
  for (let i = countOf(HEAL_POT); i < 8; i++) want.push('minor_healing_potion');
  // mana potions: the INSTANT in-combat mana refill the caster OOM-rescue (druidRotate) + rest() are built
  // around. Like heal pots only trader_wilkes (zone1) stocks minor_mana_potion, so buffer it out of zone1 —
  // without this the OOM rescue (gated on invHas MANA_POT) goes dead once the looted/quest supply runs out.
  if (self.rtype === 'mana') for (let i = countOf(MANA_POT); i < 8; i++) want.push('minor_mana_potion');
  for (const item of want) ctx.cmd({ cmd: 'buy', npc: npc.id, item });
  ctx.log('Закупаюсь у торговца (' + vendor.tid + ')');
}

// ---- priority tree ------------------------------------------------------
export function decide(ctx) {
  const w = ctx.world, self = w.self, S = ctx.settings;
  if (!self) return;
  // 24/7 hygiene: per-entity throttle maps are keyed by mob/player id and would otherwise grow
  // unbounded over a multi-day run (thousands of distinct ids) until OOM. Prune stale entries every
  // 30s — cheap, keeps them bounded to roughly the currently-active set.
  { const tnow = ctx.now(); if (tnow - (ctx.lastPrune ?? 0) > 30000) {
    // null-safe (??=): a caller that forgets one of these maps (the fleet ctx did) must NOT make decide()
    // throw 'undefined is not iterable' on its first tick and brick the bot every tick thereafter.
    for (const [k, exp] of (ctx.dotUntil ??= new Map())) if (exp < tnow) ctx.dotUntil.delete(k);
    for (const [k, exp] of (ctx.rootUntil ??= new Map())) if (exp < tnow) ctx.rootUntil.delete(k);
    for (const [k, ts] of (ctx.healThrottle ??= new Map())) if (tnow - ts > 10000) ctx.healThrottle.delete(k);
    for (const [k, ts] of (ctx.buffThrottle ??= new Map())) if (tnow - ts > 300000) ctx.buffThrottle.delete(k);
    if (ctx.gearBuyAt) for (const [k, ts] of ctx.gearBuyAt) if (tnow - ts > 300000) ctx.gearBuyAt.delete(k);
    ctx.helpLog = (ctx.helpLog ?? []).filter((ts) => tnow - ts < 60000);
    ctx.lastPrune = tnow;
  } }
  ctx.kit = CLASS_KITS[ctx.CLASS] ?? CLASS_KITS.druid;
  // selectable playstyle: resolve the chosen mode to its flee/economy knobs once per tick (brain-only).
  ctx.tune = modeTune(S.mode);
  const T = ctx.tune;
  const hp = self.hp / self.mhp;
  const aggro = w.mobsAggroOnMe();
  const inCombat = aggro.length > 0;
  const cap = combatCap(ctx.CLASS);           // pack size we'll BRAWL; engage up to cap-1 joiners, flee only when aggro EXCEEDS cap
  // HP safety floors for the in-brawl survival + flee logic below. CRIT_HP: bail from even a brawlable pack when
  // we're this low and the heal can't save us (OOM / on cooldown / class has none) — tanking a 2-pull to death
  // at 15% with an escape available is just throwing the fight. RECOVER_HP: keep fleeing until HP climbs back to
  // here (hysteresis above CRIT_HP so we don't flee⇄fight oscillate), unless we've already fully shaken the pack.
  const CRIT_HP = 0.20, RECOVER_HP = 0.35;
  // DEFEND-target helpers. commit(): hold the CURRENT target until it dies — re-picking nearest(aggro)
  // every tick resets the auto-attack swing, a thrash that whittles a whole pack to half-HP and kills
  // almost nothing. defendTarget(): who to fight back while questing/grinding — skip TRIVIAL out-levelled
  // aggro (below our worth-it grind floor) while healthy, since it leashes in ~45yd and pays nothing, so
  // we keep moving to level-appropriate content (owner: a lv14 shouldn't grind lv8 murlocs). Fight all when hurt.
  const defendFloor = Math.max(xpFloorLevel(self.lv ?? 1), (self.lv ?? 1) - 4);
  const commit = (list) => list.find((m) => m.id === self.target) ?? nearest(list, w);
  const defendTarget = () => { const worth = aggro.filter((m) => hp < 0.5 || mobMaxLevel(m.tid) === 0 || mobMaxLevel(m.tid) >= defendFloor); return worth.length ? commit(worth) : null; };
  // stickCurrent(): keep the CURRENT target if it's still a live mob passing `ok` — the proactive pickers
  // (questMob / nearestSafeMob) re-rank every tick, so as mobs move the bot abandons a half-dead target to
  // chase a freshly-"cleanest" one and perpetually "approaches" without ever finishing a kill. Re-pick only
  // once the current target is dead/gone.
  const stickCurrent = (ok) => (self.target != null ? (w.mobs().find((m) => m.id === self.target && ok(m)) ?? null) : null);
  ctx.zone = zoneAt(self.z);

  if (S.paused) { if (self.dead) ctx.cmd({ cmd: 'release' }); else ctx.input({}); act(ctx, '⏸ Пауза'); return; }
  if (self.dead) { ctx.cmd({ cmd: 'release' }); ctx.nav.stuck = 0; ctx.nav.anchorX = undefined; act(ctx, '💀 Воскрешаюсь на кладбище'); return; }

  // 0. DUNGEON/INSTANCE ESCAPE. The overworld is |x|<=180, z in [-180,900]; dungeon/arena instances
  // sit at far origins (x>=900). The solo bot never enters one on purpose, but the Hollow Crypt door
  // (80,90) sits on the gravecaller quest yard (restless_bones at 80,78), so it can wander in. Once
  // inside, routeTo would path toward an overworld goal and drag us DEEPER — so override everything:
  // head to the dungeon_exit and leave. If the exit isn't in view yet, walk to the instance's exit
  // point (origin + entry + exitOffset), computed from the instance-origin grid.
  if (self.x > 220 || self.x < -220 || self.z < -240 || self.z > 960) {
    const exit = w.dungeonExit();
    const goal = exit ? { x: exit.x, z: exit.z } : instanceExitPoint(self);
    if (exit && w.dist(exit) <= 5) { ctx.cmd({ cmd: 'leave_dungeon' }); ctx.cmd({ cmd: 'leave_crypt' }); act(ctx, '🚪 Покидаю подземелье'); return; }
    if (w.dist(goal) <= 5) { ctx.cmd({ cmd: 'leave_dungeon' }); ctx.cmd({ cmd: 'leave_crypt' }); act(ctx, '🚪 Покидаю подземелье'); return; }
    act(ctx, '🚪 Иду к выходу из подземелья'); goTo(ctx, goal); return;
  }
  // 0b. DUNGEON-DOOR KEEP-OUT (overworld). The server warps you into the instance within 2yd of a
  // door, and the hollow_crypt door sits on the restless_bones quest yard — so chasing a mob drifts
  // us in. If we're within 5yd of a door, step straight away before anything else (well outside the
  // 2yd trigger). Skipped while escaping an instance (handled above, returns first).
  for (const d of DUNGEON_DOORS) {
    // normally hold 5yd off a door (2yd = auto-warp into the instance). BUT a quest collect node can sit
    // ON the door's yard — the hollow_crypt door (80,90) is ~4.5yd from the gravecaller_sigil nodes, so a
    // flat 5yd keep-out made the whole gravecaller chain unreachable. When a lootable node is inside the
    // door zone, shrink the keep-out to 2.5yd (still well clear of the 2yd warp) so the bot can grab it.
    const nodeNearDoor = w.groundObjects().some((o) => dist2(o, d) < 5.5);
    if (dist2(self, d) < (nodeNearDoor ? 2.5 : 5)) { ctx.input({ f: 1 }, w.faceTo(d) + Math.PI); ctx.nav.stuck = 0; act(ctx, '🚪 Держусь подальше от входа в подземелье'); return; }
  }

  // 1. SURVIVE a winnable brawl. While we're STANDING and fighting a pack within our brawl capacity (aggro<=cap,
  //    and not fleeing), a cast-time heal LANDS — we're not moving — so heal/pot before dying. The old gate was
  //    `aggro<2`, which left a LETHAL hole at aggro==cap: a 2-cap class fighting EXACTLY 2 mobs neither healed
  //    (needed <2) nor fled (needed >cap) → it tanked them to death at low HP with its heal unused. Now heal at
  //    <=50% / pot at <=35% for any pull we've committed to. (Fleeing instead layers INSTANT-only survival, step 2.)
  if (inCombat && !ctx.fleeing && aggro.length <= cap && hp < 0.5) {
    if (ctx.CLASS !== 'druid' && trySelfHeal(ctx, 0.5, nearest(aggro, w))) { act(ctx, '🩹 Лечусь'); return; }
    if (hp < 0.35 && invHas(self, HEAL_POT) && ctx.now() > ctx.potionCdUntil) { ctx.cmd({ cmd: 'use', item: invFind(self, HEAL_POT) }); ctx.potionCdUntil = ctx.now() + 60000; act(ctx, '🧪 Пью зелье'); return; }
  }
  // 2. FLEE — OVERWHELMED (more attackers than we can brawl, aggro > cap) while hurt, OR CRITICALLY low even
  //    within capacity (hp < CRIT_HP: the brawl is killing us and the heal can't keep up — OOM / on cooldown /
  //    no heal). We still FIGHT packs up to capacity (death is cheap, a needlessly-fled winnable pull is lost
  //    XP) — but we DON'T tank a 2-pull to death at 15% when peeling past the ~45yd leash lets us heal + return.
  if (inCombat && hp < T.fleeHp && (aggro.length > cap || hp < CRIT_HP)) ctx.fleeing = true;
  if (ctx.fleeing) {
    // Stop fleeing once we've SHAKEN the pack (aggro 0 → rest/heal takes over) or it's back to brawlable size
    // AND we've recovered to RECOVER_HP — a flat "aggro<=cap" release would instantly cancel a low-HP flee (we
    // fled at aggro<=cap) and drop us straight back into the fight that was killing us. fleeSurvival layers
    // INSTANT heals/shields/potions while we run (they don't stop the run), and the 45yd mob leash ends the chase.
    if (aggro.length === 0 || (aggro.length <= cap && hp >= RECOVER_HP)) { ctx.fleeing = false; ctx.nav.stuck = 0; }
    else {
      // COMMIT to the run and layer only INSTANT survival — a cast-time spell would be cancelled by the
      // movement below (sim.ts cancels a cast on move). fleeSurvival roots/escapes/shields/heals/pots from
      // the class's real kit (CLASS_SURVIVAL, generated from source); it returns true ONLY when a cast-time
      // root/escape is mid-cast and we must HOLD this tick so it lands. Otherwise the instants layer on top
      // and we keep running until the pack is shaken (≤1 aggro) — THEN we heal/rest, not mid-flight.
      if (fleeSurvival(ctx, aggro)) return;
      ctx.input({ f: 1 }, w.faceTo(centroid(aggro)) + Math.PI); act(ctx, '🏃 Отрываюсь (' + aggro.length + ')'); return;
    }
  }
  // 2b. step away to rest: if we're low (HP or — for casters — mana) and a hostile is nearby out of
  //     combat, walk off it so rest()/heal can run instead of re-pulling at low HP. Paladin fights on
  //     free auto-attack, so it doesn't fall back to rest mana until nearly OOM.
  const lowMana = self.rtype === 'mana' && (self.res / Math.max(1, self.mres)) < (ctx.CLASS === 'druid' ? 0.30 : ctx.CLASS === 'paladin' ? 0.12 : 0.45);
  if (!inCombat && (hp < 0.6 || lowMana) && w.hostilesNear(18).length > 0) { fleeFrom(ctx, nearest(w.hostilesNear(18), w)); act(ctx, '🚶 Отхожу отдохнуть'); return; }
  // 2c. proactive self-heal out of combat: a healing class tops itself with its spell up to readyHp
  //     (mode-tunable, ~70%) BEFORE pulling the next mob — entering each fight healthier is what stops
  //     the chain-pull bleed-out at a dense roaming camp (we observed a death from re-pulling at 58% HP
  //     then catching a 3-mob link). An instant HoT (druid rejuvenation) makes no threat on idle mobs,
  //     so it's safe to cast even with hostiles nearby, and it keeps ticking into the fight. Throttled
  //     inside trySelfHeal (HoT 7s) so it tops once then proceeds to pull while it heals over time.
  // MANA RESERVE GUARD: don't spend mana topping HP between pulls if it would drop us below the bear-
  // shift / emergency reserve (~0.40) — a mana-starved druid that pre-heals to readyHp then pulls can
  // be left unable to bear-shift or nuke when a 2nd mob links (the exact death the readyHp heal aims to
  // prevent). Below the reserve we'd rather rest mana than burn it on a pre-pull HoT. Non-mana classes
  // (rage/energy) are unaffected.
  const manaResOK = self.rtype !== 'mana' || (self.res / Math.max(1, self.mres)) > 0.40;
  if (!inCombat && hp < T.readyHp && manaResOK && trySelfHeal(ctx, T.readyHp, null)) { act(ctx, '🩹 Подлечиваюсь'); return; }
  // 2d. equip pending upgrades BEFORE resting — otherwise a bot stuck in a rest⇄fight cycle never
  // gets a free tick to put on the armor it just bought (the +86 armor chest sat in the bag).
  if (S.autoEquip && !inCombat && autoEquip(ctx)) return;
  // 3. rest
  if (rest(ctx)) return;
  // 4. help others
  if (S.helpOthers !== false && helpOthers(ctx)) return;
  // 5. loot
  if (S.lootCorpses !== false) {
    const corpse = nearest(w.myCorpses(), w);
    if (corpse) { if (w.dist(corpse) > 4) { act(ctx, '👜 Иду к добыче'); goTo(ctx, corpse); } else { act(ctx, '👜 Собираю добычу'); ctx.cmd({ cmd: 'loot', id: corpse.id }); } return; }
  }
  // 5a. equip upgrades
  if (S.autoEquip && !inCombat && autoEquip(ctx)) return;
  // 5a. talent allocation (out of combat) — spend unspent points into the feral build, before buffs
  //     since talents change armor/HP/stats that everything downstream reads.
  if (!inCombat && manageTalents(ctx)) return;
  // 5b. self-buff upkeep
  if (!inCombat && buffSelfUpkeep(ctx)) return;

  // 5c. vendor: sell junk/replaced gear whenever we're already at a vendor (free during the
  //     hub quest trips), and make a dedicated trip if bags get heavy or we must restock.
  //     Hoisted above quests so a needed trip actually happens (the quest block otherwise
  //     returns first every tick and 8b was effectively unreachable in quest mode).
  if (!inCombat) {
    if (S.sellJunk !== false && sellableItems(ctx).length >= T.sellAt) ctx.needVendor = true;
    // make a dedicated trip to BUY missing armor (empty legs/feet) once we can afford it — filling
    // those slots is the single biggest survival upgrade for the under-geared bot.
    // one gear-trip at a time, then a 5min cooldown so we don't ping-pong to a vendor that doesn't
    // stock the missing slot (zone2's provisioner_hale DOES stock legs+feet; others may not).
    // needsVendorGear already gates on affordability, so we only trip when a buyable upgrade exists.
    const v = foodVendorNear(w.pos()), atVendor = w.dist(v) <= 6;
    // per-vendor gear-trip cooldown: a wasted attempt at a vendor that doesn't STOCK the slot must not
    // lock out a different vendor that DOES — key the cooldown to the vendor we last tried, so the bot
    // can still buy at provisioner_hale (zone2, stocks armor) right after a no-op pass at trader_wilkes
    // (zone1, food only). needsVendorGear already gates on affordability.
    const gearCdOk = ctx.gearTripAt?.tid !== v.tid || (ctx.now() - (ctx.gearTripAt?.at ?? -1e9)) > T.gearTrip;
    if (needsVendorGear(self, gearRole(ctx), v.tid) && gearCdOk) ctx.needGear = true;
    if (atVendor && S.sellJunk !== false && sellJunk(ctx)) return;        // one stack per tick
    if (atVendor && ctx.needGear) {                                       // buy missing armor, one piece per tick
      if (buyGear(ctx)) return;
      ctx.needGear = false; ctx.gearTripAt = { tid: v.tid, at: ctx.now() }; // tried THIS vendor; cooldown blocks only re-trying the SAME one
    }
    if ((ctx.needVendor && S.sellJunk !== false) || (ctx.needRestock && S.buyFood !== false) || ctx.needGear) {
      if (!atVendor) { act(ctx, '🛒 Иду к торговцу'); travelTo(ctx, v); return; }
      ctx.needVendor = false;
      if (ctx.needRestock && S.buyFood !== false) { act(ctx, '🛒 Закупаюсь'); restock(ctx); ctx.needRestock = false; }
      return;
    }
  }

  // level cap reached -> stop questing/grinding (still survives + helps)
  if ((self.lv ?? 1) >= (S.levelCap ?? 20)) { act(ctx, '🏁 Достигнут лимит уровня ' + (S.levelCap ?? 20)); ctx.input({}); return; }

  // passive mode: defend only (fight everything that's on us, but commit to one target — no thrash)
  if (S.mode === 'passive') {
    if (inCombat) { engage(ctx, commit(aggro), 'Защищаюсь'); return; }
    act(ctx, '🛡 Пассивный режим'); ctx.input({}); return;
  }

  // 6/7/8. quests (modes with tune.quest: quest, level-fast, cautious — grind/farm-gold/passive skip)
  if (T.quest) {
    // quests deferred (barren/guarded collect spot) are skipped so the bot rotates to its other
    // quests — e.g. travel north to kill trolls/cultists — instead of idling near a stuck objective.
    const dnow = ctx.now(); let deferSet = null;
    if (ctx.deferredQuests && ctx.deferredQuests.size) {
      for (const [q, until] of ctx.deferredQuests) { if (until <= dnow) ctx.deferredQuests.delete(q); else (deferSet ??= new Set()).add(q); }
    }
    const qa = nextQuestAction(self, ctx.qmemo ?? (ctx.qmemo = {}), deferSet);
    if (qa) {
      // ANTI-STUCK accept/turn-in guard: the server can refuse an accept/turn-in (a quest the bot's
      // hand-authored data thinks is available but the server gates differently, e.g. a dungeon-chain
      // quest) — without this the bot re-issues the same command 5×/s FOREVER, frozen at the NPC (seen
      // looping 'Беру квест: Врата Бастиона'). If the SAME accept/turn-in is still being returned after
      // ~8s (it never transitioned), defer that quest 10min and fall through to grind/other quests, then
      // retry later. Normal accepts take 1 tick, so this never false-fires on a working one.
      if (qa.kind === 'accept' || qa.kind === 'turnin') {
        const key = qa.kind + ':' + qa.quest, g = (ctx.qActGuard ??= { key: null, since: 0 });
        if (g.key !== key) { g.key = key; g.since = dnow; }
        if (dnow - g.since > 8000) {
          ctx.deferredQuests.set(qa.quest, dnow + 600000); g.key = null;
          ctx.log('⏭ Квест «' + ruQuest(qa.quest) + '» не ' + (qa.kind === 'accept' ? 'принимается' : 'сдаётся') + ' — пропускаю (10 мин)');
          // fall through (no return) so the bot does something useful this tick instead of freezing
        } else {
          ctx.cmd({ cmd: qa.kind, quest: qa.quest });
          act(ctx, (qa.kind === 'accept' ? '📜 Беру квест: ' : '✅ Сдаю квест: ') + ruQuest(qa.quest));
          ctx.log((qa.kind === 'accept' ? 'Взял квест: ' : 'Сдаю квест: ') + ruQuest(qa.quest));
          return;
        }
      }
      if (qa.kind === 'goto') { act(ctx, '🧭 Иду к НПС (' + ruQuest(qa.quest) + ')'); travelTo(ctx, qa.goal); return; }
      if (qa.kind === 'kill') {
        // STALL GUARD (mirrors collect_ground): track this quest's KILL credit. If a camp is too dense to
        // pull within our brawl capacity and we land NO kill for ~2min (we keep getting overwhelmed → flee →
        // reset), DEFER the quest 3min and fall through to GRIND cleanly-pullable level-appropriate mobs —
        // out-level the camp, then retry — instead of endlessly travel-aggroing a pack we can't win. Resets
        // the instant a kill registers. Universal: a too-hard/too-dense camp self-defers, no per-camp rules.
        const ql = (self.qlog ?? []).find((q) => q.questId === qa.quest);
        const got = ql ? ql.counts.reduce((a, b) => a + (b || 0), 0) : 0;
        const deaths = ctx.deathCount ?? 0;
        const c = ctx.killq;
        if (!c || c.qid !== qa.quest) ctx.killq = { qid: qa.quest, got, since: ctx.now(), deathsAt: deaths };
        else if (got > c.got) { c.got = got; c.since = ctx.now(); c.deathsAt = deaths; ctx.deferredQuests?.delete(qa.quest); }   // a kill → progress, reset both timers
        // Give up FAST on a death-trap: defer after 2 deaths with NO kill (a camp we just can't do yet), OR
        // after a 2min no-kill stall (too dense to even pull). Either way grind up, then retry when stronger.
        else if ((deaths - c.deathsAt >= 2 || ctx.now() - c.since > 120000) && !(ctx.deferredQuests?.get(qa.quest) > ctx.now())) {
          const trap = deaths - c.deathsAt >= 2;
          // a death-trap waits longer (it clears on the next levelup anyway, when we're actually stronger);
          // a merely-too-dense camp retries sooner. Either falls through to grind meanwhile.
          ctx.deferredQuests?.set(qa.quest, ctx.now() + (trap ? 480000 : 180000));
          // a DEATH-TRAP (not just dense): commit to grinding clean kills for 3min to OUT-LEVEL, instead of
          // bouncing straight into the next equally-hard quest camp (a low-level zone has several dense camps —
          // bandits/murlocs/rats — so without this the bot thrashes between them, dying, and never gains a level).
          if (trap) ctx.grindUntil = ctx.now() + 180000;
          ctx.log('⏭ Откладываю отстрел «' + ruQuest(qa.quest) + '» (' + (trap ? 'смертельная ловушка' : 'слишком плотно') + ') — качаюсь на доступных мобах');
          // fall through (no return) → grind level-appropriate mobs, out-level the camp, retry in 3min
        }
        if (!(ctx.deferredQuests?.get(qa.quest) > ctx.now()) && ctx.now() >= (ctx.grindUntil ?? 0)) {
          // 1) the actual quest mob -> fight the cleanest instance within brawl capacity. Stick to the one
          //    we're already on until it dies, else pick a fresh instance — re-picking every tick finishes none.
          const qm = stickCurrent((m) => m.tid === qa.mobId) ?? w.questMob(qa.mobId, self.lv, combatCap(ctx.CLASS) - 1);
          if (qm) { engage(ctx, qm, '⚔ Квест'); return; }
          // 2) something is already beating on us -> finish that fight before moving on
          { const d = defendTarget(); if (d) { engage(ctx, d, '⚔ Отбиваюсь'); return; } }
          // 3) no clean quest mob nearby -> travel toward the camp, stopping only for a mob in our path (so we
          //    reach the objective instead of grinding wolves next to the wolf camp forever).
          const inPath = w.nearestSafeMob(self.lv, combatCap(ctx.CLASS) - 1);
          if (inPath && w.dist(inPath) <= ctx.range + 1) { engage(ctx, inPath, '⚔ По пути'); return; }
          // 4) LAST RESORT — quest mobs are RIGHT HERE (in range) but all exceed brawl capacity (a dense same-
          //    family camp the cascade model refuses), and there's nothing clean to grind in-path. Standing here
          //    refusing every instance IS the no-kill spiral (zero xp) — worse than a near-free death. So dive the
          //    LEAST-dense instance: only when one is already within range (don't walk a melee INTO the pack and
          //    body-pull it; a ranged class drags it out, which thins the real flee wave). The flee/instant-heal
          //    net peels us out if it snowballs, and the 2-death stall-guard above defers the camp if this keeps
          //    failing. This restores progress-with-bounded-deaths on flee-bomb quest camps that out-leveling
          //    alone never thins (flee-help has no trivial gate), but SMARTER than the old blind body-pull.
          const anyQ = w.questMobAny(qa.mobId, self.lv);
          if (anyQ && w.dist(anyQ) <= ctx.range + 1) { engage(ctx, anyQ, '⚔ Квест (тесно)'); return; }
          act(ctx, '🧭 Иду к лагерю (' + ruQuest(qa.quest) + ')'); travelTo(ctx, qa.goal); return;
        }
        // deferred (camp too dense) -> fall through to grind
      }
      if (qa.kind === 'collect_ground') {
        // STALL GUARD: track quest progress; if no item gathered for 2min, defer this quest for
        // 3min and fall through to grind (objects may be slow to respawn / unreachable) — never
        // loop forever on a barren spot. Resets the moment we collect something.
        const ql = (self.qlog ?? []).find((q) => q.questId === qa.quest);
        const got = ql ? ql.counts.reduce((a, b) => a + (b || 0), 0) : 0;
        const c = ctx.collect;
        if (!c || c.qid !== qa.quest) ctx.collect = { qid: qa.quest, got, since: ctx.now(), pt: 0, deferUntil: 0 };
        else if (got > c.got) { c.got = got; c.since = ctx.now(); c.deferUntil = 0; ctx.deferredQuests?.delete(qa.quest); }
        else if (ctx.now() - c.since > 120000 && !(c.deferUntil > ctx.now())) {
          c.deferUntil = ctx.now() + 180000; ctx.deferredQuests?.set(qa.quest, c.deferUntil);  // barren/guarded -> rotate to other quests for 3min
          ctx.log('⏭ Откладываю сбор «' + ruQuest(qa.quest) + '» (нет прогресса) — берусь за другие квесты');
        }
        if (!(ctx.collect.deferUntil > ctx.now())) {
          // INTERACT_RANGE on the server is 5yd: detect nodes in a wider radius, then WALK UP to
          // one before issuing pickup. Issuing it from >5yd is silently rejected ("Too far away"),
          // and returning here would spam it without ever closing the gap (the old <6 bug).
          // ONLY this quest's nodes (tid = 'ground_'+itemId). Picking up a stray object from a DONE
          // quest (e.g. a respawned fen_muster_order node) is rejected server-side ("nailed shut") but
          // stays lootable, so the bot would retry it forever — the 90s stall we observed at (2,295).
          const tid = 'ground_' + qa.itemId;
          const objo = nearest(w.groundObjects().filter((o) => o.tid === tid && w.dist(o) < 24), w);
          if (objo) {
            if (w.dist(objo) <= 4.5) { ctx.cmd({ cmd: 'pickup', id: objo.id }); act(ctx, '📦 Подбираю предмет (' + ruQuest(qa.quest) + ')'); return; }
            act(ctx, '🧭 Подхожу к предмету (' + ruQuest(qa.quest) + ')'); travelTo(ctx, { x: objo.x, z: objo.z }); return;
          }
          const pts = qa.goals.map((p) => ({ ...p, d: dist2(w.pos(), p) })).sort((a, b) => a.d - b.d);
          let g = pts[0];
          if (g.d < 6) { ctx.collect.pt = (ctx.collect.pt + 1) % pts.length; g = pts[ctx.collect.pt]; }  // barren spot -> next point
          act(ctx, '🧭 Иду за предметом квеста (' + ruQuest(qa.quest) + ')'); travelTo(ctx, g); return;
        }
        // deferred -> fall through to grind (don't return)
      }
    }
  }

  // 10. grind: if a mob already tagged us, finish that fight before pulling a fresh one on top.
  { const d = defendTarget(); if (d) { engage(ctx, d, 'Бой'); return; } }
  const stale = (ctx.now() - (ctx.lastKill ?? ctx.now())) > 70000;
  const mob = stickCurrent((m) => mobMaxLevel(m.tid) === 0 || mobMaxLevel(m.tid) >= defendFloor) ?? w.nearestSafeMob(self.lv, combatCap(ctx.CLASS) - 1);   // finish the current mob, else pick a fresh brawlable instance (cap-1 joiners)
  if (mob) { engage(ctx, mob, 'Фарм'); return; }
  // 11. travel to a level-appropriate camp
  // NOTE: an "XP-upgrade relocate" (seek the highest-level WINNABLE camp instead of greedy-nearest) was
  // tried + REVERTED — in zone2 the high over-level camps are fen_troll (safe, far) AND gravecaller_cultist
  // (deadly dense swarm, near), BOTH lvl10-12 with no density flag in the static camp data, so it can't tell
  // them apart and routed to the swarm; worse, the cultist grind is so rest-heavy it gave no xp/hr gain over
  // safe widows. The clean win is at lvl16 (Swipe makes dense camps winnable) — then high camps are safe to seek.
  patrol(ctx, stale);
}

function patrol(ctx, stale) {
  const w = ctx.world, self = w.self, nav = ctx.nav, here = w.pos();
  const maxZ = maxZoneIdx(self.lv);                                                    // forward zone gate only
  // PATROL DESTINATION: walk toward a level-appropriate, non-elite camp in an allowed zone (campsForLevel
  // already bands by level + skips dense camps). Pull SAFETY on arrival is the joinCount model — this only
  // picks WHERE to go, so it stays simple; if a camp turns out crowded, nearestSafeMob just won't engage.
  let camps = campsForLevel(self.lv).filter((c) => !isEliteTid(c.mobId) && zoneIdxAtZ(c.z) <= maxZ);
  if (!camps.length) camps = campsForLevel(self.lv).filter((c) => !isEliteTid(c.mobId));
  if (!camps.length) { act(ctx, '🧭 Иду в нижнюю зону'); travelTo(ctx, ZONES[Math.max(0, maxZ - 1)].hub); return; }
  // COMMIT to one destination until reached (or ~20s pass), so travel doesn't thrash between
  // camps every tick — that jitter left the bot stuck in place, especially when it's
  // permanently "stale" (e.g. gated out of its current zone with no killable mob nearby).
  const reached = nav.patrolGoal && dist2(here, nav.patrolGoal) < 10;
  const timedOut = (ctx.now() - (nav.patrolSince ?? 0)) > 20000;
  if (!nav.patrolGoal || reached || timedOut) {
    if ((reached || timedOut) && stale) nav.wp++;                                 // rotate to the next camp
    // sort by NEAREST; non-stale takes the closest, stale rotates through nearby ones. (Was
    // "easiest by maxLevel", which trekked the bot to a far low-level camp to grind greys.) The bot
    // naturally leaves a too-dangerous camp on its own: if nothing there is safely pullable it makes
    // no kills, goes "stale", and rotates to the next camp — no hard-coded family avoidance needed.
    const byNear = camps.map((c) => ({ c, d: dist2(here, c) })).sort((a, b) => a.d - b.d);
    nav.patrolGoal = byNear[(stale ? nav.wp : 0) % byNear.length].c;
    nav.patrolSince = ctx.now();
  }
  const zn = zoneAt(nav.patrolGoal.z)?.name ?? '';
  act(ctx, '🧭 ' + (stale ? 'Ищу мобов по силам' : 'Иду к мобам') + (zn ? ' → ' + zn : ''));
  travelTo(ctx, nav.patrolGoal);
}
