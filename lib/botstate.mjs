// Shared per-bot helpers for solo + fleet + the unified console: atomic file writes, the rich
// dashboard state projection, and the settings-control allowlist. Extracted VERBATIM from autobot.mjs
// so every bot (the solo druid and each fleet member) emits an IDENTICAL dashboard schema and reuses
// the same control validation — no behavior change for the solo bot.
import fs from 'node:fs';
import { QUESTS, MODE_NAMES, TALENT_INFO, TALENT_CHOICE_RU, SPEC_RU, talentPointsAtLevel } from './gamedata.mjs';
import { ITEMS } from './items.generated.mjs';
import { xpToNext, ruMob, ruQuest, ruItem, splitCoin, STAT_RU, KIND_RU } from './ru.mjs';

// atomic write: serialize to a temp file then rename (rename is atomic on the same FS), so a crash
// mid-write can never leave a truncated settings/state/deathblocks file that fails to JSON.parse on boot.
export function atomicWrite(fileUrl, data) {
  const tmp = new URL(fileUrl.href + '.' + process.pid + '.tmp');
  fs.writeFileSync(tmp, data); fs.renameSync(tmp, fileUrl);
}

const itemName = (id) => ruItem(id, ITEMS[id]?.name ?? id);
const itemQ = (id) => ITEMS[id]?.quality ?? 'common';

// Build the rich per-bot dashboard state. Pure projection — identical shape for the solo druid and
// every fleet member. `name` is the fallback display name (snapshot `nm` wins when present).
export function richState({ world, action, zone, session, settings, logBuf, online, host, name, cls }) {
  const s = world.self;
  const base = { online, server: host, settings, log: logBuf, action, zone: zone?.name ?? '',
    session: { kills: session.kills, deaths: session.deaths, questsDone: session.questsDone, xpGained: session.xpGained, runtimeSec: (Date.now() - session.start) / 1000, copperGained: (s && session.baseCopper != null) ? (s.copper - session.baseCopper) : 0 } };
  if (!s) return base;
  const stats = s.stats ?? {};
  const statsArr = [
    { k: STAT_RU.str, v: stats.str }, { k: STAT_RU.agi, v: stats.agi }, { k: STAT_RU.sta, v: stats.sta },
    { k: STAT_RU.int, v: stats.int }, { k: STAT_RU.spi, v: stats.spi }, { k: STAT_RU.armor, v: stats.armor },
    { k: 'Attack power', v: s.ap }, { k: 'Critical strike', v: s.crit != null ? (s.crit * 100).toFixed(1) + '%' : '—' },
  ].filter((x) => x.v != null);
  const SLOT_RU = { mainhand: 'Main hand', chest: 'Chest', legs: 'Legs', feet: 'Feet' };
  const equip = ['mainhand', 'chest', 'legs', 'feet'].map((slot) => { const id = s.equip?.[slot]; return { slot, slotRu: SLOT_RU[slot], name: id ? itemName(id) : null, quality: id ? itemQ(id) : 'common' }; });
  const inv = (s.inv ?? []).map((it) => { const id = it.itemId ?? it.id; return { name: itemName(id), count: it.count ?? 1, quality: itemQ(id), kindRu: KIND_RU[ITEMS[id]?.kind] ?? '' }; });
  const quests = (s.qlog ?? []).filter((q) => q.state === 'active' || q.state === 'ready').map((q) => {
    const def = QUESTS[q.questId];
    const objectives = def ? def.objectives.map((o, i) => ({ label: o.type === 'kill' ? ('Kill ' + ruMob(o.targetMobId)) : ('Collect ' + ruItem(o.itemId)), have: Math.min(q.counts[i] ?? 0, o.count), need: o.count })) : [{ label: 'Progress', have: q.state === 'ready' ? 1 : 0, need: 1 }];
    return { name: ruQuest(q.questId), state: q.state, objectives };
  });
  const t = world.target();
  const target = (t && !t.dead && t.k === 'mob') ? { name: ruMob(t.tid, t.nm), level: t.lv, hpPct: t.hp / Math.max(1, t.mhp) } : null;
  const auras = s.auras ?? [];
  const form = auras.some((a) => a.kind === 'form_bear') ? 'Bear 🐻' : auras.some((a) => a.kind === 'form_cat') ? 'Cat 🐱' : '—';
  const buffs = auras.filter((a) => a.kind !== 'form_bear' && a.kind !== 'form_cat').map((a) => a.name).slice(0, 8);
  const resName = { mana: 'mana', rage: 'rage', energy: 'energy' }[s.rtype] ?? 'resource';
  // talents (v0.6): spec + spent/total + the allocated nodes for the dashboard panel
  const talAlloc = s.tal?.alloc;
  const talents = talAlloc ? {
    spec: SPEC_RU[talAlloc.spec] ?? talAlloc.spec ?? '—',
    spent: Object.values(talAlloc.ranks ?? {}).reduce((a, b) => a + b, 0),
    total: talentPointsAtLevel(s.lv ?? 1),
    nodes: Object.entries(talAlloc.ranks ?? {}).map(([id, r]) => ({
      name: id === 'feral_choice' ? (TALENT_CHOICE_RU[talAlloc.choices?.[id]] ?? TALENT_INFO[id]?.ru ?? id) : (TALENT_INFO[id]?.ru ?? id),
      rank: r, max: TALENT_INFO[id]?.max ?? r,
    })),
  } : null;
  return { ...base, name: s.nm ?? name, cls, level: s.lv, hp: s.hp, mhp: s.mhp, mana: s.res, mres: s.mres, mana_enabled: (s.mres ?? 0) > 0, resName, xp: s.xp, xpNext: xpToNext(s.lv ?? 1), copper: s.copper, gold: splitCoin(s.copper), pos: { x: s.x, z: s.z }, stats: statsArr, equip, inv, quests, target, form, buffs, talents };
}

// allowlist of boolean toggles the control channel may write — anything else is rejected. (Replaces the
// old `settings[m.key] = m.value`, which let any client write ANY key/value onto live settings.)
const BOOL_SETTINGS = new Set(['paused', 'lootCorpses', 'buyFood', 'helpOthers', 'autoEquip', 'bearForm', 'sellJunk']);
// Apply a validated control message to a settings object in place. Returns a Russian log label on success,
// or null if the message was rejected (unknown key / bad type / invalid mode).
export function applySetting(settings, m) {
  if (!m || m.type !== 'set' || typeof m.key !== 'string') return null;
  if (m.key === 'levelCap') settings.levelCap = Math.max(2, Math.min(20, Number(m.value) || 20));
  else if (m.key === 'mode') { if (MODE_NAMES.includes(m.value)) settings.mode = m.value; else return null; } // reject unknown modes
  else if (BOOL_SETTINGS.has(m.key)) settings[m.key] = !!m.value;                                              // coerce to boolean
  else return null;                                                                                            // reject unknown keys
  const onoff = m.value ? 'on' : 'off';
  const lbl = { paused: m.value ? 'Paused' : 'Resumed', mode: `Mode: ${m.value}`, lootCorpses: `Looting: ${onoff}`, buyFood: `Food purchasing: ${onoff}`, helpOthers: `Player assistance: ${onoff}`, autoEquip: `Auto-equip: ${onoff}`, bearForm: `Bear form: ${onoff}`, sellJunk: `Junk selling: ${onoff}`, levelCap: `Level cap: ${settings.levelCap}` };
  return lbl[m.key] ?? (m.key + ' = ' + m.value);
}
