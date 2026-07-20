// Smoke suite for the deterministic core logic — run: `npm test`.
// Guards the data + pure-function invariants this bot relies on (modes, ability costs, kit ranges,
// quest soloability/skip, gear-reward path). Idea borrowed from the codex bot's heavy test coverage;
// kept to fast, dependency-free, non-flaky assertions (no live server, no decide() mocking).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modeTune, MODE_NAMES, abilityCost, meleeRangeFor, CLASS_KITS,
  QUESTS, QUEST_ORDER, ITEM_SOURCE, GROUND,
  zeroDiff, xpFloorLevel,
  druidTalentAlloc, talentPointsAtLevel, pointsSpentIn,
  mobMaxLevel, isEliteTid,
} from '../lib/gamedata.mjs';

test('mob table: per-template helpers resolve from the generated aggro data', () => {
  // elites/bosses/rares are skipped by DATA (no hand-kept avoid list). A few known ones:
  for (const m of ['korzul_the_gravewyrm', 'deacon_voss', 'mirefen_broodmother']) assert.ok(isEliteTid(m), `${m} is elite/boss/rare`);
  // ordinary grind/quest mobs are NOT flagged — they're engaged when the pull is clean.
  for (const m of ['fen_troll', 'ridge_stalker', 'deeprock_kobold', 'gravecaller_cultist']) assert.ok(!isEliteTid(m), `${m} is a normal mob`);
  assert.equal(mobMaxLevel('ridge_stalker'), 14, 'template top level');
  assert.equal(mobMaxLevel('unknown_tid'), 0, 'unknown → 0 (ungated)');
});

test('talents: feral build is server-VALID (gates+reqs+budget) at every level 10-20', () => {
  // mirror of v0.6 talents_classic.ts druid feral node metadata (id -> {row, maxRank, gate, requires})
  const NODE = {
    feral_thick_hide:      { row: 0, maxRank: 3 },
    feral_ferocity:        { row: 0, maxRank: 3 },
    feral_brutal_impact:   { row: 1, maxRank: 2, gate: 2, requires: ['feral_thick_hide'] },
    feral_feline_swiftness:{ row: 1, maxRank: 2, gate: 2 },
    feral_choice:          { row: 2, maxRank: 1, gate: 5, choice: true },
    feral_heart_wild:      { row: 3, maxRank: 2, gate: 8, requires: ['feral_choice'] },
  };
  const FERAL_CHOICE_OPTS = new Set(['feral_choice_bear', 'feral_choice_cat', 'feral_choice_survival']);
  for (let lv = 10; lv <= 20; lv++) {
    const budget = talentPointsAtLevel(lv);
    const alloc = druidTalentAlloc(budget);
    assert.equal(alloc.spec, 'feral', `lv${lv} spec`);
    assert.ok(pointsSpentIn(alloc) <= budget, `lv${lv} over budget`);
    const ranks = alloc.ranks;
    const above = (row) => Object.entries(ranks).reduce((n, [id, r]) => n + (NODE[id].row < row ? r : 0), 0);
    for (const [id, r] of Object.entries(ranks)) {
      const nd = NODE[id]; assert.ok(nd, `lv${lv} unknown node ${id}`);
      assert.ok(r >= 1 && r <= nd.maxRank, `lv${lv} ${id} rank ${r} > max ${nd.maxRank}`);
      if (nd.gate) assert.ok(above(nd.row) >= nd.gate, `lv${lv} ${id} gate ${nd.gate} unmet (above=${above(nd.row)})`);
      for (const req of nd.requires ?? []) assert.ok((ranks[req] ?? 0) >= 1, `lv${lv} ${id} requires ${req}`);
      if (nd.choice) assert.ok(FERAL_CHOICE_OPTS.has(alloc.choices[id]), `lv${lv} ${id} valid choice`);
    }
  }
  // lvl14 (5 pts) = the exact alloc the live bot sends right now
  assert.deepEqual(druidTalentAlloc(5).ranks, { feral_thick_hide: 3, feral_brutal_impact: 2 });
});

test('xp floor: grinder never targets a grey (0-xp) mob; floor mirrors sim zeroDiff', () => {
  // mirrors src/sim/types.ts: zeroDiff = 5(≤7), 6(8-9), 7(10-15), 8(16+)
  assert.equal(zeroDiff(14), 7);
  assert.equal(zeroDiff(9), 6);
  assert.equal(zeroDiff(16), 8);
  // a lvl14 player: a mob ≥7 levels below (lvl≤7) is grey → floor is lvl8 (lowest paying mob).
  assert.equal(xpFloorLevel(14), 8);
  assert.equal(xpFloorLevel(10), 4);
  // the floor must be exactly the boundary: floor-1 is grey, floor pays.
  for (const lv of [10, 14, 18]) assert.equal(lv - xpFloorLevel(lv), zeroDiff(lv) - 1);
});

test('modes: slimmed knob set (pull/flee fudge removed — pull safety is now the joinCount model)', () => {
  // the only behaviour knobs left: whether to quest, flee/ready HP thresholds, economy timing.
  const BASE = { quest: true, fleeHp: 0.40, readyHp: 0.55, sellAt: 12, gearTrip: 300000 };
  for (const k of Object.keys(BASE)) assert.equal(modeTune('quest')[k], BASE[k], `quest.${k}`);
  assert.equal(modeTune('grind').quest, false);
  // the old pull/flee knobs must be GONE (so nothing reads a stale tunable)
  for (const k of ['critHp', 'critPack', 'fleePackHp', 'fleeLoneHp', 'losingHp', 'marginDiv', 'pullJoinMax', 'bandLo', 'campGate'])
    assert.equal(modeTune('quest')[k], undefined, `${k} removed`);
});

test('modes: every dashboard mode resolves; unknown falls back to quest; cautious is more careful', () => {
  for (const m of MODE_NAMES) assert.ok(modeTune(m), m);
  assert.deepEqual(modeTune('bogus-mode'), modeTune('quest'));
  assert.ok(modeTune('cautious').fleeHp > modeTune('quest').fleeHp, 'cautious flees earlier');
  assert.ok(modeTune('cautious').readyHp >= modeTune('quest').readyHp, 'cautious tops HP higher');
});

test('abilityCost: resolves to the highest known rank for the level (server bills that)', () => {
  assert.equal(abilityCost({ lv: 12 }, 'wrath', 20), 32);   // rank 1 (lv8)
  assert.equal(abilityCost({ lv: 14 }, 'wrath', 20), 48);   // rank 2 (lv14)
  assert.equal(abilityCost({ lv: 20 }, 'wrath', 20), 70);   // rank 3 (lv20)
  assert.equal(abilityCost({ lv: 99 }, 'unknown_spell', 17), 17); // unknown → base
});

test('abilityCost: ranks now GENERATED from source — buffs that scale by rank are no longer under-billed', () => {
  // mark_of_the_wild + thorns were MISSING from the old hand table → billed flat 20; the generated table
  // carries their real rank costs, so canCast no longer freeze-casts an upkeep buff it can't actually afford.
  assert.equal(abilityCost({ lv: 6 }, 'mark_of_the_wild', 20), 20, 'below first rank → kit base');
  assert.equal(abilityCost({ lv: 16 }, 'mark_of_the_wild', 20), 50, 'lv16 rank cost 50 (was wrongly billed 20)');
  assert.equal(abilityCost({ lv: 20 }, 'thorns', 20), 50, 'thorns lv20 rank cost 50');
});

test('abilityCost: talent costPct mirrors the server applyTalentMods (cost*(1+Σ), rounded, floored)', () => {
  // paladin Retribution: ret_benediction ×3 → -24% on Seal of Righteousness + Judgement.
  const pal = { lv: 16, tal: { alloc: { spec: 'retribution', ranks: { ret_benediction: 3 }, choices: {} } } };
  assert.equal(abilityCost(pal, 'seal_of_righteousness', 25), 38, 'rank 50 × 0.76 = 38');
  assert.equal(abilityCost(pal, 'judgement', 30), 23, 'flat 30 × 0.76 = 22.8 → 23');
  assert.equal(abilityCost({ lv: 16 }, 'seal_of_righteousness', 25), 50, 'no alloc → full rank cost, no discount');
  // druid Feral: feral_ferocity ×1 → -6% Maul.
  const dru = { lv: 20, tal: { alloc: { spec: 'feral', ranks: { feral_ferocity: 1 }, choices: {} } } };
  assert.equal(abilityCost(dru, 'maul', 15), 14, '15 × 0.94 = 14.1 → 14');
});

test('meleeRangeFor: melee classes (incl. druid hybrid) = 4, pure casters = 24', () => {
  for (const c of ['warrior', 'paladin', 'rogue', 'druid']) assert.equal(meleeRangeFor(c), 4, c);
  for (const c of ['hunter', 'priest', 'shaman', 'mage', 'warlock']) assert.equal(meleeRangeFor(c), 24, c);
});

test('druid kit: has bear form, a ranged nuke (wrath), and a self-heal HoT', () => {
  const k = CLASS_KITS.druid;
  assert.ok(k.bear?.form, 'bear form');
  assert.ok((k.nukes ?? []).some((n) => n.id === 'wrath'), 'wrath');
  assert.ok(k.selfHeal, 'selfHeal');
});

test('quests: the soloable wyrmcult chain is enabled AND soloable; raid tail not pursued (data-driven)', () => {
  for (const q of ['q_wyrm_sigils', 'q_breaking_the_seal', 'q_voice_below']) {
    assert.ok(QUESTS[q], `${q} defined`);
    assert.ok(QUEST_ORDER.includes(q), `${q} in order`);
  }
  // every objective mob/node in the chain must be reachable solo (non-elite → questState never returns 'skip')
  assert.ok(GROUND['gravewyrm_sigil'], 'sigil ground node');
  assert.equal(ITEM_SOURCE['blessed_embers'], 'stormcrag_elemental');
  for (const m of ['stormcrag_elemental', 'wyrmcult_zealot', 'wyrmcult_necromancer']) assert.ok(!isEliteTid(m), `${m} soloable (not elite/boss/rare)`);
  // raid-tail quests are simply NOT authored for the bot → questState returns 'skip' via `!q` (no hand list)
  for (const q of ['q_sanctum_gate', 'q_velkhar', 'q_gravewyrm']) assert.ok(!QUESTS[q], `${q} (raid tail) not authored → never pursued`);
});

test('quests: dungeon-attunement quest stays unavailable via an unsatisfiable prereq (no freeze loop, no skip list)', () => {
  const bd = QUESTS['q_bastion_door'];
  assert.ok(bd, 'q_bastion_door authored');
  assert.equal(bd.requiresQuest, 'q_deacon');           // gated on a group/boss quest...
  assert.ok(!QUESTS['q_deacon'], 'q_deacon not authored → requiresQuest never satisfied → q_bastion_door stays unavailable');
});

test('quests: the soloable druid-gear quests exist in the pursue order', () => {
  for (const q of ['q_no_rest', 'q_troll_fetishes', 'q_revenant_vanguard']) {
    assert.ok(QUESTS[q], `${q} defined`);
    assert.ok(QUEST_ORDER.includes(q), `${q} in order`);
  }
});

test('kill-gate: pursue a quest mob whose TEMPLATE tops at most +2 above us (mobMaxLevel, no camp table)', () => {
  // brain.mjs pursuable() gate: mobMaxLevel(tid) > self.lv + QUEST_LVL_MARGIN(2) → defer. Sourced from the
  // universal mob table (mobMaxLevel), not the old per-camp MOB_MAXLEVEL. Pull DENSITY is no longer gated
  // here — questMob() picks the cleanest live instance via the joinCount model.
  const MARGIN = 2;
  const killDeferred = (mob, lv) => mobMaxLevel(mob) > lv + MARGIN;
  assert.equal(mobMaxLevel('ridge_stalker'), 14, 'ridge_stalker template top level');
  // lv12+: ridge (top14) pursuable at +2; lv11 still defers
  assert.equal(killDeferred('ridge_stalker', 14), false, 'lv14 ridge pursuable');
  assert.equal(killDeferred('ridge_stalker', 12), false, 'lv12 ridge opens (top14 <= 14)');
  assert.equal(killDeferred('ridge_stalker', 11), true, 'lv11 ridge deferred (top14 > 13)');

  // OUT-LEVELLED low end: skip a kill objective below our worth-it band max(grey-floor, lv-4) — an
  // over-levelled bot moves on to level-appropriate content instead of grinding scraps.
  const outLevelled = (mob, lv) => { const m = mobMaxLevel(mob); return m > 0 && m < Math.max(xpFloorLevel(lv), lv - 4); };
  assert.equal(outLevelled('ridge_stalker', 14), false, 'lv14 ridge in band (top14 >= floor 10)');
  assert.equal(outLevelled('ridge_stalker', 20), true, 'lv20 ridge out-levelled (top14 < floor 16) → skipped');
  // the owner's example: a lv14 char skips the deepfen-murloc quest (murloc top9 < floor 10)
  assert.ok(mobMaxLevel('deepfen_murloc') < 10, 'deepfen_murloc tops below 10');
  assert.equal(outLevelled('deepfen_murloc', 14), true, 'lv14 skips the lv8-9 murloc quest (moves to level-appropriate content)');
  assert.equal(outLevelled('deepfen_murloc', 9), false, 'at lv9 the murloc quest is in band (do it then)');
});

test('pelts quest is kill-gated via ITEM_SOURCE, not a ground node (opens with ridge under the +2 gate)', () => {
  // q_stalker_pelts collects ridge_stalker_pelt. It must NOT be a GROUND node (else collectGuarded path),
  // and its source must be ridge_stalker, so pursueObjective routes it through the SAME kill-gate as
  // q_stalkers — both open together. (Corrects the stale memory note that collectGuarded gates it.)
  assert.equal(GROUND['ridge_stalker_pelt'], undefined, 'pelt has no ground node');
  assert.equal(ITEM_SOURCE['ridge_stalker_pelt'], 'ridge_stalker', 'pelt source is ridge_stalker');
});

test('cultist swarm is handled by the pull model, not a hardcoded avoid-list', () => {
  // gravecaller_cultist is a dense fast-roaming swarm — previously hardcoded into AVOID_MOBS. It is NOT an
  // elite/boss/rare, so it's a normal mob now: the joinCount model engages a genuinely ISOLATED cultist and
  // skips the pack (verified in pull_model.test.mjs). This is the universal fix — no per-mob avoid rule.
  assert.ok(!isEliteTid('gravecaller_cultist'), 'cultist is a normal mob (density handled by joinCount, not a flag)');
  assert.equal(QUESTS['q_cult_camp'].objectives[0].targetMobId, 'gravecaller_cultist', 'cult quest targets cultist');
  // ordinary grind/quest mobs are likewise not flagged
  for (const m of ['fen_troll', 'drowned_dead', 'ridge_stalker', 'deeprock_kobold']) assert.ok(!isEliteTid(m), `${m} huntable`);
});
