// Zone 3 — Thornpeak Heights (levels 13-20). Data from src/sim/content/zone3.ts.
// q_highwatch_summons's giver is brother_aldric_fen (zone 2) — bridge north.
export const ZONE3 = {
  id: 'thornpeak_heights', name: 'Thornpeak Heights', levelRange: [13, 20], zRange: [540, 900],
  graveyard: { x: 15, z: 645 }, hub: { x: 0, z: 660, name: 'Highwatch' },
  foodVendor: { tid: 'quartermaster_bree', x: -5, z: 668 },
  npcs: {
    captain_thessaly: { x: 4, z: 664 }, brother_aldric_highwatch: { x: -10, z: 656 }, scout_maren_highwatch: { x: 7, z: 670 },
    quartermaster_bree: { x: -5, z: 668 }, armorer_hode: { x: -2, z: 672 }, loremaster_caddis: { x: 12, z: 655 },
  },
  quests: {
    q_highwatch_summons: { giver: 'brother_aldric_fen', turnin: 'captain_thessaly', minLevel: 12, objectives: [{ type: 'collect', itemId: 'highwatch_summons', count: 1 }] },
    q_stalkers:      { giver: 'captain_thessaly', turnin: 'captain_thessaly', objectives: [{ type: 'kill', targetMobId: 'ridge_stalker', count: 12 }] },
    q_stalker_pelts: { giver: 'quartermaster_bree', turnin: 'quartermaster_bree', objectives: [{ type: 'collect', itemId: 'ridge_stalker_pelt', count: 8 }] },
    q_kobold_tunnels:{ giver: 'loremaster_caddis', turnin: 'loremaster_caddis', minLevel: 14, objectives: [{ type: 'kill', targetMobId: 'deeprock_kobold', count: 12 }] },
    q_glowing_wax:   { giver: 'quartermaster_bree', turnin: 'quartermaster_bree', requiresQuest: 'q_kobold_tunnels', objectives: [{ type: 'collect', itemId: 'glowing_wax', count: 6 }] },
    q_ogre_edges:    { giver: 'scout_maren_highwatch', turnin: 'scout_maren_highwatch', minLevel: 15, objectives: [{ type: 'kill', targetMobId: 'thornpeak_ogre', count: 12 }] },
    q_ogre_totems:   { giver: 'scout_maren_highwatch', turnin: 'scout_maren_highwatch', requiresQuest: 'q_ogre_edges', objectives: [{ type: 'collect', itemId: 'ogre_war_totem', count: 6 }] },
    q_ogre_bounty:   { giver: 'captain_thessaly', turnin: 'captain_thessaly', requiresQuest: 'q_ogre_totems', objectives: [{ type: 'kill', targetMobId: 'thornpeak_ogre', count: 14 }] },
    q_elementals:    { giver: 'loremaster_caddis', turnin: 'loremaster_caddis', minLevel: 16, objectives: [{ type: 'kill', targetMobId: 'stormcrag_elemental', count: 12 }] },
    q_shard_cores:   { giver: 'loremaster_caddis', turnin: 'loremaster_caddis', requiresQuest: 'q_elementals', objectives: [{ type: 'collect', itemId: 'storm_core', count: 6 }] },
    q_zealots:       { giver: 'brother_aldric_highwatch', turnin: 'brother_aldric_highwatch', minLevel: 17, objectives: [{ type: 'kill', targetMobId: 'wyrmcult_zealot', count: 12 }] },
    q_cult_orders:   { giver: 'brother_aldric_highwatch', turnin: 'brother_aldric_highwatch', requiresQuest: 'q_zealots', objectives: [{ type: 'kill', targetMobId: 'wyrmcult_zealot', count: 8 }, { type: 'collect', itemId: 'wyrmcult_orders', count: 4 }] },
    q_revenants:     { giver: 'captain_thessaly', turnin: 'captain_thessaly', minLevel: 18, objectives: [{ type: 'kill', targetMobId: 'boneclad_revenant', count: 12 }] },
    q_revenant_vanguard: { giver: 'captain_thessaly', turnin: 'captain_thessaly', requiresQuest: 'q_revenants', objectives: [{ type: 'kill', targetMobId: 'boneclad_revenant', count: 14 }] },
    q_necromancers:  { giver: 'brother_aldric_highwatch', turnin: 'brother_aldric_highwatch', requiresQuest: 'q_cult_orders', minLevel: 18, objectives: [{ type: 'kill', targetMobId: 'wyrmcult_necromancer', count: 8 }, { type: 'collect', itemId: 'ritual_phylactery', count: 3 }] },
    // SOLOABLE wyrmcult chain — all objectives are on mobs/nodes the bot already farms (gravewyrm_sigil
    // ground nodes; blessed_embers off stormcrag_elemental; zealots/necromancers), NO boss. Rewards the
    // druid emberwood_staff (int+8 spi+3). The boss/dungeon TAIL (q_sanctum_gate→q_velkhar→q_gravewyrm)
    // stays skipped. Was blanket-skipped with that tail; reinstated per the quest-reward audit.
    q_wyrm_sigils:       { giver: 'brother_aldric_highwatch', turnin: 'brother_aldric_highwatch', requiresQuest: 'q_necromancers', minLevel: 18, objectives: [{ type: 'collect', itemId: 'gravewyrm_sigil', count: 3 }] },
    q_breaking_the_seal: { giver: 'brother_aldric_highwatch', turnin: 'brother_aldric_highwatch', requiresQuest: 'q_wyrm_sigils', objectives: [{ type: 'collect', itemId: 'blessed_embers', count: 5 }] },          // no minLevel in source — the q_necromancers→q_wyrm_sigils prereq chain already gates level
    q_voice_below:       { giver: 'brother_aldric_highwatch', turnin: 'brother_aldric_highwatch', requiresQuest: 'q_breaking_the_seal', objectives: [{ type: 'kill', targetMobId: 'wyrmcult_zealot', count: 10 }, { type: 'kill', targetMobId: 'wyrmcult_necromancer', count: 6 }] },
    // dungeon/boss quests auto-skipped: q_crushers, q_drogmar, q_kazzix, q_korgath, q_velkhar, q_gravewyrm, q_sanctum_gate
  },
  questOrder: ['q_highwatch_summons', 'q_stalkers', 'q_stalker_pelts', 'q_kobold_tunnels', 'q_glowing_wax', 'q_ogre_edges', 'q_ogre_totems', 'q_ogre_bounty', 'q_elementals', 'q_shard_cores', 'q_zealots', 'q_cult_orders', 'q_revenants', 'q_revenant_vanguard', 'q_necromancers', 'q_wyrm_sigils', 'q_breaking_the_seal', 'q_voice_below'],
  camps: [
    { mobId: 'ridge_stalker', x: -50, z: 590, radius: 22, minLevel: 13, maxLevel: 14 },
    { mobId: 'ridge_stalker', x: 45, z: 600, radius: 20, minLevel: 13, maxLevel: 14 },
    { mobId: 'deeprock_kobold', x: 75, z: 625, radius: 18, minLevel: 14, maxLevel: 15 },
    { mobId: 'deeprock_kobold', x: 105, z: 600, radius: 14, minLevel: 14, maxLevel: 15 },
    { mobId: 'thornpeak_ogre', x: -90, z: 700, radius: 22, minLevel: 15, maxLevel: 16 },
    { mobId: 'thornpeak_ogre', x: -60, z: 730, radius: 18, minLevel: 15, maxLevel: 16 },
    { mobId: 'stormcrag_elemental', x: 110, z: 760, radius: 20, minLevel: 17, maxLevel: 18 },
    { mobId: 'stormcrag_elemental', x: 135, z: 795, radius: 16, minLevel: 17, maxLevel: 18 },
    { mobId: 'wyrmcult_zealot', x: 55, z: 820, radius: 20, minLevel: 17, maxLevel: 19 },
    { mobId: 'wyrmcult_zealot', x: 25, z: 845, radius: 16, minLevel: 17, maxLevel: 19 },
    { mobId: 'wyrmcult_necromancer', x: 40, z: 855, radius: 14, minLevel: 18, maxLevel: 19 },
    { mobId: 'boneclad_revenant', x: -40, z: 830, radius: 20, minLevel: 18, maxLevel: 19 },
    { mobId: 'boneclad_revenant', x: -15, z: 860, radius: 16, minLevel: 18, maxLevel: 19 },
    { mobId: 'ironvein_foreman', x: 100, z: 617, radius: 5, minLevel: 16, maxLevel: 16, dangerous: true },
    { mobId: 'ogre_crusher', x: -125, z: 740, radius: 18, minLevel: 16, maxLevel: 17, dangerous: true },
    { mobId: 'warlord_drogmar', x: -132, z: 748, radius: 2, minLevel: 17, maxLevel: 17, dangerous: true },
    { mobId: 'shardlord_kazzix', x: 145, z: 815, radius: 8, minLevel: 18, maxLevel: 18, dangerous: true },
    { mobId: 'marrowlord_varkas', x: -34, z: 842, radius: 5, minLevel: 19, maxLevel: 19, dangerous: true },
  ],
  ground: {
    highwatch_summons: [{ x: 1, z: 654 }, { x: -2, z: 657 }],
    ogre_war_totem: [{ x: -116, z: 726 }, { x: -122, z: 733 }, { x: -129, z: 727 }, { x: -136, z: 738 }, { x: -140, z: 747 }, { x: -133, z: 753 }, { x: -124, z: 750 }],
    gravewyrm_sigil: [{ x: -8, z: 852 }, { x: -3, z: 857 }, { x: 3, z: 861 }, { x: 8, z: 866 }],
    sanctum_key_shard: [{ x: -6, z: 872 }, { x: -2, z: 876 }, { x: 2, z: 873 }, { x: 6, z: 878 }],
  },
  itemSource: { ridge_stalker_pelt: 'ridge_stalker', glowing_wax: 'deeprock_kobold', storm_core: 'stormcrag_elemental', wyrmcult_orders: 'wyrmcult_zealot', ritual_phylactery: 'wyrmcult_necromancer', blessed_embers: 'stormcrag_elemental' },
  // Bosses/elites/rares are skipped UNIVERSALLY by data (isEliteTid from the mob template) + the joinCount
  // pull model (engage a lone mob, skip the pack) — no hand-kept avoid/skip lists. The soloable wyrmcult
  // chain (→ emberwood_staff) stays enabled; its mobs are non-elite so the quest engine pursues them.
};
