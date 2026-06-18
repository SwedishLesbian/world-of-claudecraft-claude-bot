// Russian localization: XP table, name maps, helpers.

export const XP_TABLE = [400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600, 8800, 10100, 11400, 12900, 14400, 16000, 17700, 19400, 21300, 23200];
export const xpToNext = (level) => XP_TABLE[Math.min(level - 1, XP_TABLE.length - 1)];

export const MOB_RU = {
  forest_wolf: 'Лесной волк', old_greyjaw: 'Старый Серозуб', wild_boar: 'Дикий вепрь',
  elder_bristleback: 'Старший щетинник', webwood_spider: 'Паук Паутинного леса',
  sableweb_matriarch: 'Матриарх Чёрной паутины', sableweb_hatchling: 'Паучок',
  mudfin_murloc: 'Мурлок Грязеплав', tunnel_rat: 'Туннельная крыса',
  vale_bandit: 'Долинный бандит', restless_bones: 'Беспокойные кости',
  gorrak: 'Горрак Беспощадный', mogger: 'Моггер', mogger_lackey: 'Прихвостень Моггера',
  // zone 2 — Mirefen
  mire_prowler: 'Болотный охотник', deepfen_murloc: 'Глубинный мурлок', mire_widow: 'Болотная вдова',
  drowned_dead: 'Утопленник', fen_troll: 'Болотный тролль', gravecaller_cultist: 'Культист Могильщика',
  gravecaller_summoner: 'Призыватель Могильщика', mirefen_broodmother: 'Болотная матка', grubjaw: 'Грубьяв',
  mirejaw_the_ravenous: 'Болотозев Ненасытный', sister_nhalia: 'Сестра Нхалия', deacon_voss: 'Дьякон Восс',
  knight_commander_olen: 'Рыцарь-командор Олен', vael_the_mistcaller: 'Ваэль Туманный',
  // zone 3 — Thornpeak
  ridge_stalker: 'Горный сталкер', deeprock_kobold: 'Глубинный кобольд', thornpeak_ogre: 'Огр Тернопиков',
  ogre_crusher: 'Огр-крушитель', stormcrag_elemental: 'Штормовой элементаль', wyrmcult_zealot: 'Фанатик культа',
  wyrmcult_necromancer: 'Некромант культа', boneclad_revenant: 'Костяной мститель', ironvein_foreman: 'Десятник Железной жилы',
  warlord_drogmar: 'Вождь Дрогмар', shardlord_kazzix: 'Осколочник Каззикс', marrowlord_varkas: 'Лорд Костей Варкас',
  korgath_the_bound: 'Коргат Связанный', grand_necromancer_velkhar: 'Великий некромант Велькар', korzul_the_gravewyrm: 'Корзул Могильный Змей',
};

export const QUEST_RU = {
  q_wolves: 'Волки у ворот', q_boars: 'Шкуры вепрей', q_spiders: 'Угроза Паутинного леса',
  q_murlocs: 'Беда на озере', q_supplies: 'Украденные припасы', q_mine: 'Крысы в шахте',
  q_bones: 'Беспокойные мёртвые', q_whispers: 'Шёпот снизу', q_names_of_the_dead: 'Имена мёртвых',
  q_silence_the_call: 'Заглушить зов', q_rite: 'Связующий обряд', q_bandits: 'Бандиты Долины',
  q_greyjaw: 'Старый волк', q_ringleader: 'Главарь',
  // zone 2 — Mirefen
  q_fenbridge_muster: 'Призыв в Фенбридж', q_prowlers: 'Болотные охотники', q_prowler_pelts: 'Шкуры охотников',
  q_fen_supplies: 'Потерянный караван', q_deepfen: 'Глубинные мурлоки', q_idols: 'Затопленные идолы',
  q_deepfen_purge: 'Зачистка глубин', q_widows: 'Болотные вдовы', q_drowned: 'Утопленники',
  q_drowned_censers: 'Ржавые кадила', q_no_rest: 'Нет покоя', q_trolls: 'Болотные тролли',
  q_troll_fetishes: 'Тролльи фетиши', q_cult_camp: 'Лагерь культа', q_bastion_door: 'Врата Бастиона',
  // zone 3 — Thornpeak
  q_highwatch_summons: 'Призыв в Стражгорье', q_stalkers: 'Сталкеры на хребте', q_stalker_pelts: 'Зима близко',
  q_kobold_tunnels: 'Беда в Глубокой скале', q_glowing_wax: 'Странный воск', q_ogre_edges: 'Огры у подножия',
  q_ogre_totems: 'Тотемы войны', q_ogre_bounty: 'Награда капитана', q_elementals: 'Гора пробуждается',
  q_shard_cores: 'Ядра бури', q_zealots: 'Песнопения на ветру', q_cult_orders: 'Приказы снизу',
  q_revenants: 'Поля мстителей', q_revenant_vanguard: 'Кости авангарда', q_necromancers: 'Кольцо филактерий',
};

export const ITEM_RU = {
  boar_hide: 'Щетинистая шкура вепря', webwood_silk: 'Паутинный шёлк', wolf_fang: 'Волчий клык',
  greyjaw_fang: 'Клык Серозуба', blessed_wax: 'Священный воск', ghostly_essence: 'Призрачная эссенция',
  supply_crate: 'Украденный ящик', gravecaller_sigil: 'Печать Могильщика', weathered_ledger_page: 'Страница книги',
  baked_bread: 'Свежий хлеб', spring_water: 'Родниковая вода', roasted_boar: 'Жареная вепрятина',
  tough_jerky: 'Вяленое мясо', minor_healing_potion: 'Малое зелье лечения', minor_mana_potion: 'Малое зелье маны',
  spider_leg: 'Паучья лапка', bone_fragments: 'Костяные осколки', linen_scrap: 'Лоскут льна',
  mudfin_scale: 'Чешуя мурлока', tallow_candle: 'Сальная свеча', bandit_bandana: 'Бандитская повязка',
};

export const SLOT_RU = { mainhand: 'Оружие', chest: 'Грудь', legs: 'Ноги', feet: 'Ступни' };
export const STAT_RU = { str: 'Сила', agi: 'Ловкость', sta: 'Выносл.', int: 'Интеллект', spi: 'Дух', armor: 'Броня' };
export const KIND_RU = { weapon: 'Оружие', armor: 'Броня', food: 'Еда', drink: 'Питьё', potion: 'Зелье', quest: 'Квест', junk: 'Хлам', tool: 'Инстр.' };
export const QUALITY_RU = { poor: 'Хлам', common: 'Обычное', uncommon: 'Необычное', rare: 'Редкое', epic: 'Эпическое' };
export const QUALITY_COLOR = { poor: '#9d9d9d', common: '#e8e8e8', uncommon: '#1eff00', rare: '#0070dd', epic: '#a335ee' };
export const MODE_RU = { quest: 'Квесты', grind: 'Фарм мобов', passive: 'Пассивный' };

export const ruMob = (tid, fallback) => MOB_RU[tid] ?? fallback ?? tid;
export const ruQuest = (qid) => QUEST_RU[qid] ?? qid;
export const ruItem = (id, fallback) => ITEM_RU[id] ?? fallback ?? id;

// copper -> {g,s,c}
export const splitCoin = (copper) => ({ g: Math.floor((copper ?? 0) / 10000), s: Math.floor(((copper ?? 0) % 10000) / 100), c: (copper ?? 0) % 100 });
