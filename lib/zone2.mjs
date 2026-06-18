// Zone 2 — Mirefen Marsh (levels 6-13). Data from src/sim/content/zone2.ts.
// Note: q_fenbridge_muster's giver is brother_aldric (in zone 1) — the bridge
// quest that walks you north into Mirefen.
export const ZONE2 = {
  id: 'mirefen_marsh', name: 'Mirefen Marsh', levelRange: [6, 13], zRange: [180, 540],
  graveyard: { x: -18, z: 286 }, hub: { x: 0, z: 300, name: 'Fenbridge' },
  foodVendor: { tid: 'provisioner_hale', x: -4, z: 308 },
  npcs: {
    warden_fenwick: { x: 3, z: 304 }, brother_aldric_fen: { x: -8, z: 296 }, provisioner_hale: { x: -4, z: 308 },
    herbalist_yara: { x: 10, z: 295 }, scout_maren: { x: 6, z: 312 },
  },
  quests: {
    q_fenbridge_muster: { giver: 'brother_aldric', turnin: 'warden_fenwick', minLevel: 6, objectives: [{ type: 'collect', itemId: 'fen_muster_order', count: 1 }] },
    q_prowlers:       { giver: 'warden_fenwick', turnin: 'warden_fenwick', objectives: [{ type: 'kill', targetMobId: 'mire_prowler', count: 12 }] },
    q_prowler_pelts:  { giver: 'provisioner_hale', turnin: 'provisioner_hale', objectives: [{ type: 'collect', itemId: 'mire_prowler_pelt', count: 8 }] },
    q_fen_supplies:   { giver: 'provisioner_hale', turnin: 'provisioner_hale', minLevel: 7, objectives: [{ type: 'collect', itemId: 'lost_caravan_goods', count: 5 }] },
    q_deepfen:        { giver: 'warden_fenwick', turnin: 'warden_fenwick', minLevel: 7, objectives: [{ type: 'kill', targetMobId: 'deepfen_murloc', count: 12 }] },
    q_idols:          { giver: 'brother_aldric_fen', turnin: 'brother_aldric_fen', requiresQuest: 'q_deepfen', objectives: [{ type: 'collect', itemId: 'waterlogged_idol', count: 5 }] },
    q_deepfen_purge:  { giver: 'warden_fenwick', turnin: 'warden_fenwick', requiresQuest: 'q_idols', objectives: [{ type: 'kill', targetMobId: 'deepfen_murloc', count: 14 }] },
    q_widows:         { giver: 'herbalist_yara', turnin: 'herbalist_yara', minLevel: 8, objectives: [{ type: 'kill', targetMobId: 'mire_widow', count: 10 }, { type: 'collect', itemId: 'widow_venom_sac', count: 6 }] },
    q_drowned:        { giver: 'brother_aldric_fen', turnin: 'brother_aldric_fen', minLevel: 9, objectives: [{ type: 'kill', targetMobId: 'drowned_dead', count: 12 }] },
    q_drowned_censers:{ giver: 'brother_aldric_fen', turnin: 'brother_aldric_fen', requiresQuest: 'q_drowned', objectives: [{ type: 'collect', itemId: 'rusted_censer', count: 4 }] },
    q_no_rest:        { giver: 'brother_aldric_fen', turnin: 'brother_aldric_fen', requiresQuest: 'q_drowned_censers', objectives: [{ type: 'kill', targetMobId: 'drowned_dead', count: 14 }] },
    q_trolls:         { giver: 'warden_fenwick', turnin: 'warden_fenwick', minLevel: 10, objectives: [{ type: 'kill', targetMobId: 'fen_troll', count: 12 }] },
    q_troll_fetishes: { giver: 'scout_maren', turnin: 'scout_maren', requiresQuest: 'q_trolls', objectives: [{ type: 'collect', itemId: 'troll_fetish', count: 8 }] },
    q_cult_camp:      { giver: 'scout_maren', turnin: 'scout_maren', minLevel: 11, objectives: [{ type: 'kill', targetMobId: 'gravecaller_cultist', count: 12 }] },
    // server prereq is q_deacon (not q_cult_camp). q_deacon is auto-skipped (group/rare), so with the
    // correct prereq this quest stays un-pursued instead of looping accept-rejections — it leads into the
    // Sunken Bastion group dungeon a solo bot can't clear anyway. (Was 'q_cult_camp' → tried forever.)
    q_bastion_door:   { giver: 'brother_aldric_fen', turnin: 'brother_aldric_fen', requiresQuest: 'q_deacon', minLevel: 12, objectives: [{ type: 'collect', itemId: 'bastion_ward_stone', count: 1 }] },
    // q_bastion_door stays 'unavailable' on its own: its prereq q_deacon (a group/boss quest) is not authored
    // for the bot, so requiresQuest is never satisfied — no skip-list entry needed. Other group/rare zone2
    // quests (q_broodmother/q_grubjaw/q_summoners/q_deacon/q_olen/q_mistcaller) simply aren't authored here.
  },
  questOrder: ['q_fenbridge_muster', 'q_prowlers', 'q_prowler_pelts', 'q_fen_supplies', 'q_deepfen', 'q_idols', 'q_deepfen_purge', 'q_widows', 'q_drowned', 'q_drowned_censers', 'q_no_rest', 'q_trolls', 'q_troll_fetishes', 'q_cult_camp', 'q_bastion_door'],
  camps: [
    { mobId: 'mire_prowler', x: -40, z: 230, radius: 22, minLevel: 7, maxLevel: 8 },
    { mobId: 'mire_prowler', x: 35, z: 225, radius: 20, minLevel: 7, maxLevel: 8 },
    { mobId: 'deepfen_murloc', x: -82, z: 273, radius: 15, minLevel: 8, maxLevel: 9 },
    { mobId: 'deepfen_murloc', x: -120, z: 350, radius: 13, minLevel: 8, maxLevel: 9 },
    { mobId: 'mire_widow', x: 70, z: 300, radius: 20, minLevel: 8, maxLevel: 10 },
    { mobId: 'mire_widow', x: 95, z: 340, radius: 16, minLevel: 8, maxLevel: 10 },
    { mobId: 'drowned_dead', x: 90, z: 420, radius: 20, minLevel: 9, maxLevel: 11 },
    { mobId: 'drowned_dead', x: 115, z: 450, radius: 16, minLevel: 9, maxLevel: 11 },
    { mobId: 'fen_troll', x: -80, z: 420, radius: 22, minLevel: 10, maxLevel: 12 },
    { mobId: 'fen_troll', x: -105, z: 455, radius: 18, minLevel: 10, maxLevel: 12 },
    // gravecaller_cultist: a dense, fast-roaming swarm (7+ mobs, radius 16-20) sitting right on the
    // only zone2->zone3 bridge (z~470-490, x~0). Even OVER-level it can't be single-pulled (links 4-10,
    // moveSpeed 7 == player run so it can't be out-run) — the recurring death source across the run
    // (live: "3💀/2⚔ за 6мин"). q_cult_camp is DONE, so there's no reason to ever touch it again.
    // Flagged `dangerous` (keeps it off patrol destinations); targeting is handled universally by the
    // joinCount pull model — it engages a LONE cultist and skips the pack. Bot grinds the SAFE fen_troll camp.
    { mobId: 'gravecaller_cultist', x: 15, z: 470, radius: 20, minLevel: 10, maxLevel: 12, dangerous: true },
    { mobId: 'gravecaller_cultist', x: -25, z: 490, radius: 16, minLevel: 10, maxLevel: 12, dangerous: true },
    { mobId: 'mirejaw_the_ravenous', x: -132, z: 333, radius: 5, minLevel: 10, maxLevel: 10, dangerous: true },
    { mobId: 'mirefen_broodmother', x: 98, z: 348, radius: 3, minLevel: 10, maxLevel: 10, dangerous: true },
    { mobId: 'grubjaw', x: -120, z: 480, radius: 8, minLevel: 12, maxLevel: 12, dangerous: true },
    { mobId: 'gravecaller_summoner', x: -5, z: 500, radius: 12, minLevel: 11, maxLevel: 12, dangerous: true },
    { mobId: 'sister_nhalia', x: 24, z: 492, radius: 5, minLevel: 12, maxLevel: 12, dangerous: true },
    { mobId: 'deacon_voss', x: 0, z: 510, radius: 2, minLevel: 12, maxLevel: 12, dangerous: true },
  ],
  ground: {
    fen_muster_order: [{ x: 1, z: 294 }, { x: -2, z: 297 }],
    lost_caravan_goods: [{ x: 1, z: 192 }, { x: -3, z: 206 }, { x: -6, z: 221 }, { x: -8, z: 237 }, { x: -7, z: 252 }, { x: -3, z: 268 }, { x: 2, z: 283 }],
    rusted_censer: [{ x: 96, z: 429 }, { x: 103, z: 430 }, { x: 99, z: 434 }, { x: 106, z: 437 }, { x: 97, z: 440 }, { x: 104, z: 441 }],
    bastion_ward_stone: [{ x: 43, z: 512 }, { x: 48, z: 517 }],
  },
  itemSource: { mire_prowler_pelt: 'mire_prowler', waterlogged_idol: 'deepfen_murloc', widow_venom_sac: 'mire_widow', troll_fetish: 'fen_troll' },
};
