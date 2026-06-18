// v0.10.0 AFFIX-AWARE WINNABILITY (levy-street/world-of-claudecraft#634). The pack bundle hangs combat
// affixes on mob templates; the bot's cost model must weigh a silencer/anti-healer/stunner above its bare
// level gap, gated to the build it bites — without ever making a faceroll grey look scary. These tests pin
// the model (lib/affixes.mjs), the generator's projection, and the live World.threatWeight path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affixThreatMult, affixesFromTemplate, AFFIX_THREAT, AFFIX_KEYS, AFFIX_MULT_CAP } from '../lib/affixes.mjs';
import { World } from '../lib/world.mjs';
import { MOB_TEMPLATES } from '../lib/mobs.generated.mjs';
import { xpFloorLevel } from '../lib/gamedata.mjs';

const CASTER = { caster: true, melee: false };
const MELEE = { caster: false, melee: true };
const BOTH = { caster: true, melee: true };

test('no affixes → multiplier is exactly 1 (no behaviour change for un-affixed mobs)', () => {
  assert.equal(affixThreatMult(undefined, BOTH), 1);
  assert.equal(affixThreatMult({}, BOTH), 1);
});

test('caster-gated affixes only bite a caster profile', () => {
  const aff = { silence: 1 };                          // sev 0.7, gate caster, chance 1
  assert.equal(affixThreatMult(aff, CASTER), 1.7);
  assert.equal(affixThreatMult(aff, MELEE), 1);        // a melee build is untouched by a silence
});

test('melee-gated affixes only bite a melee profile', () => {
  const aff = { disarm: 1 };                            // sev 0.5, gate melee, chance 1
  assert.equal(affixThreatMult(aff, MELEE), 1.5);
  assert.equal(affixThreatMult(aff, CASTER), 1);
});

test('universal affixes bite every profile, scaled by proc chance', () => {
  assert.equal(affixThreatMult({ stunOnHit: 1 }, CASTER), 1.4);   // sev 0.4
  assert.equal(affixThreatMult({ stunOnHit: 1 }, MELEE), 1.4);
  // chance scales the contribution: a 25%-proc stun is worth a quarter of an always-on one.
  assert.ok(Math.abs(affixThreatMult({ stunOnHit: 0.25 }, BOTH) - 1.1) < 1e-9);
});

test('multiple affixes sum, then clamp at the multiplier cap', () => {
  // silence(.7) + spellReflect(.6) + healAbsorb(.5) + stunOnHit(.4) = +2.2 → 3.2, clamped to the cap.
  const kitchen = { silence: 1, spellReflect: 1, healAbsorb: 1, stunOnHit: 1 };
  assert.equal(affixThreatMult(kitchen, CASTER), AFFIX_MULT_CAP);
  // a melee build dodges the two caster-gated ones: healAbsorb(.5) + stunOnHit(.4) = 1.9, under the cap.
  assert.ok(Math.abs(affixThreatMult(kitchen, MELEE) - 1.9) < 1e-9);
});

test('default profile is the most conservative (counts every gated affix)', () => {
  // an unset profile must not silently ignore caster/melee affixes.
  assert.equal(affixThreatMult({ silence: 1 }), 1.7);
  assert.equal(affixThreatMult({ disarm: 1 }), 1.5);
});

test('affixesFromTemplate projects proc chance (1 for always-on), ignores non-affix fields', () => {
  const t = { hpBase: 100, family: 'humanoid', stunOnHit: { chance: 0.12, duration: 1 }, spellReflect: { value: 5 }, notAnAffix: true };
  assert.deepEqual(affixesFromTemplate(t), { stunOnHit: 0.12, spellReflect: 1 });
  assert.equal(affixesFromTemplate({ hpBase: 100 }), undefined);   // none → undefined (omitted from the table)
});

test('model invariants: keys aligned, severities sane', () => {
  // extraction and weighting share one source of truth — every weighed kind is projected, and vice-versa.
  assert.deepEqual([...AFFIX_KEYS].sort(), Object.keys(AFFIX_THREAT).sort());
  for (const [k, e] of Object.entries(AFFIX_THREAT)) {
    assert.ok(e.sev > 0 && e.sev <= 1, `${k}: severity in (0,1]`);
    assert.ok(e.gate === undefined || e.gate === 'caster' || e.gate === 'melee', `${k}: valid gate`);
  }
});

// ── live World.threatWeight path (inject synthetic templates; threatWeight reads tid → MOB_TEMPLATES) ──────
test('World.threatWeight scales by affixes, profile-gated; engageCost/aggroLoad follow', (t) => {
  MOB_TEMPLATES._t_none = { aggroRadius: 8, family: 'humanoid' };
  MOB_TEMPLATES._t_silence = { aggroRadius: 8, family: 'humanoid', affixes: { silence: 1 } };
  t.after(() => { delete MOB_TEMPLATES._t_none; delete MOB_TEMPLATES._t_silence; });   // always clean the shared singleton
  const w = new World();
  const atLv = (tid) => ({ id: 1, k: 'mob', tid, lv: 10 });

  // baseline: an at-level un-affixed mob is weight 1 (unchanged from the pre-affix model).
  assert.equal(w.threatWeight(atLv('_t_none'), 10), 1);

  // caster build: the silence raises the at-level mob's weight; the base (×1) is preserved as the factor.
  w.setCombatProfile(CASTER);
  assert.equal(w.threatWeight(atLv('_t_silence'), 10), 1.7);
  // melee build: the same mob is just a normal fight.
  w.setCombatProfile(MELEE);
  assert.equal(w.threatWeight(atLv('_t_silence'), 10), 1);

  // engageCost for a lone mob = its own affix-scaled weight; aggroLoad sums attackers' weights.
  w.setCombatProfile(CASTER);
  const m = atLv('_t_silence'); m.aggro = w.pid;
  assert.equal(w.engageCost(m, 10), 1.7);
});

test('a grey mob stays free no matter what affixes it carries', (t) => {
  MOB_TEMPLATES._t_greynasty = { aggroRadius: 8, family: 'humanoid', affixes: { silence: 1, spellReflect: 1, stunOnHit: 1 } };
  t.after(() => { delete MOB_TEMPLATES._t_greynasty; });
  const w = new World(); w.setCombatProfile(BOTH);
  const myLv = 20, greyLv = xpFloorLevel(myLv);     // a mob at/under the zero-xp band is grey by definition
  assert.equal(w.threatWeight({ id: 1, k: 'mob', tid: '_t_greynasty', lv: greyLv }, myLv), 0);
});
