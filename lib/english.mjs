export const XP_TABLE = [400, 900, 1400, 2100, 2800, 3600, 4500, 5400, 6500, 7600, 8800, 10100, 11400, 12900, 14400, 16000, 17700, 19400, 21300, 23200];
export const xpToNext = (level) => XP_TABLE[Math.min(level - 1, XP_TABLE.length - 1)];

export const SLOT_NAMES = { mainhand: 'Main hand', chest: 'Chest', legs: 'Legs', feet: 'Feet' };
export const STAT_NAMES = { str: 'Strength', agi: 'Agility', sta: 'Stamina', int: 'Intellect', spi: 'Spirit', armor: 'Armor' };
export const KIND_NAMES = { weapon: 'Weapon', armor: 'Armor', food: 'Food', drink: 'Drink', potion: 'Potion', quest: 'Quest', junk: 'Junk', tool: 'Tool' };
export const QUALITY_NAMES = { poor: 'Poor', common: 'Common', uncommon: 'Uncommon', rare: 'Rare', epic: 'Epic' };
export const QUALITY_COLOR = { poor: '#9d9d9d', common: '#e8e8e8', uncommon: '#1eff00', rare: '#0070dd', epic: '#a335ee' };
export const MODE_NAMES = { quest: 'Quests', grind: 'Mob grinding', passive: 'Passive' };

const englishId = (id) => String(id ?? '').replace(/^q_/, '').split('_').filter(Boolean).map((part) => part[0]?.toUpperCase() + part.slice(1)).join(' ');
export const mobName = (tid, fallback) => fallback ?? englishId(tid);
export const questName = (qid) => englishId(qid);
export const itemName = (id, fallback) => fallback ?? englishId(id);

export const splitCoin = (copper) => ({ g: Math.floor((copper ?? 0) / 10000), s: Math.floor(((copper ?? 0) % 10000) / 100), c: (copper ?? 0) % 100 });
