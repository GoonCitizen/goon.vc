'use strict';

// Why `remaeus` (ChairmanPoW) loses IdleRPG battles: replays the installed
// `@fabric/rpg` + `idlerpg` combat with his live kit.
// Run from anywhere inside goon.vc: `node assets/workspaces/ChairmanPoW/chairman-sim.js`

const Battle = require('@fabric/rpg/types/battle');
const Encounter = require('@fabric/rpg/types/encounter');
const biomes = require('@fabric/rpg/functions/biomes');
const items = require('@fabric/rpg/functions/items');
const { seeded } = require('@fabric/rpg/functions/random');
const Player = require('idlerpg/types/player');
const C = require('idlerpg/constants');

const RUNS = Number(process.env.RUNS) || 400;
const GROWTH = ['strength', 'dexterity', 'constitution'];

// Lowest item level that reproduces an armor number from his public profile.
function matchArmor (id, target) {
  for (let level = 1; level < 60; level++) {
    const stack = items.stack(id, { level });
    if (items.gearStats(stack).armor >= target) return stack;
  }
  return items.stack(id, { level: 1 });
}

const ARMOR = {
  body: matchArmor('iron-armor', 27),
  leggings: matchArmor('leather-leggings', 5),
  helmet: matchArmor('leather-helmet', 5)
};

function attributesAt (level) {
  const out = { strength: 10, dexterity: 10, intelligence: 10, wisdom: 10, constitution: 10, charisma: 10, luck: 10 };
  for (let i = 1; i < level; i++) out[GROWTH[(i - 1) % GROWTH.length]] += 1;
  return out;
}

function actor (level, weapon) {
  const equipment = Object.assign({}, ARMOR);
  if (weapon) equipment['main-hand'] = items.stack(weapon, { level });
  return { name: 'remaeus', level, body: 'humanoid', attributes: attributesAt(level), equipment };
}

function winRate (level, weapon, biome, n) {
  let won = 0;
  for (let i = 0; i < n; i++) {
    const outcome = new Encounter({
      actor: actor(level, weapon),
      biome: biome || biomes.IDS[i % biomes.IDS.length],
      weights: { monster: 1 },
      levelOffset: C.LEVEL_OFFSET,
      levelOffsetMax: C.LEVEL_OFFSET_MAX,
      random: `sim:${biome}:${level}:${weapon}:${i}`
    }).outcome;
    if (outcome.victory) won += 1;
  }
  return `${(won / n * 100).toFixed(0)}%`.padStart(5);
}

// One career to `target`, mirroring `IdleRPG#_rollForEncounter`: one seeded
// generator per tick gates the encounter and then drives it.
function career (startLevel, run, target = 19) {
  const experience = startLevel > 1 ? Math.ceil(C.LEVEL_BASE_EXPERIENCE * Math.pow(startLevel - 1, C.LEVEL_EXPONENT)) : 0;
  const player = new Player({ id: 'x', name: 'x', experience });
  const biome = biomes.IDS[run % biomes.IDS.length];
  for (let tick = 1; player.level < target && tick < 5000; tick++) {
    player.reward(600000);
    const random = seeded(`career:${startLevel}:${run}:${tick}`);
    if (!random.chance(C.ENCOUNTER_CHANCE)) continue;
    player.resolve(new Encounter({
      actor: player.actor,
      biome,
      weights: C.ENCOUNTER_WEIGHTS,
      levelOffset: C.LEVEL_OFFSET,
      levelOffsetMax: C.LEVEL_OFFSET_MAX,
      cacheMax: C.PER_TICK_CAPITAL * 5,
      random
    }).outcome);
  }
  return player;
}

console.log('Win rate by level, all biomes');
for (const level of [5, 10, 15, 19]) {
  const bare = Battle.fighter(actor(level, null));
  const club = Battle.fighter(actor(level, 'club'));
  console.log(`L${String(level).padEnd(2)} bare dmg ${bare.damage} | club dmg ${club.damage} | armor ${bare.armor} hp ${bare.maxHealth}` +
    ` | bare ${winRate(level, null, null, 5000)} club ${winRate(level, 'club', null, 5000)} sword ${winRate(level, 'sword', null, 5000)}`);
}

console.log('\nWin rate by biome');
console.log(`${'biome'.padEnd(18)}  L12   L15   L19  L19+club`);
for (const biome of biomes.IDS) {
  console.log(`${biome.padEnd(18)}${winRate(12, null, biome, 2000)} ${winRate(15, null, biome, 2000)} ${winRate(19, null, biome, 2000)} ${winRate(19, 'club', biome, 2000)}`);
}

console.log(`\nCareers to L19 (${RUNS} runs each)`);
for (const start of [1, 5, 8, 10]) {
  let won = 0;
  let lost = 0;
  let bare = 0;
  let worse = 0;
  for (let run = 0; run < RUNS; run++) {
    const player = career(start, run);
    won += player.battles.won;
    lost += player.battles.lost;
    if (!player.weapon) bare += 1;
    if (player.battles.lost >= 20 && player.battles.won <= 7) worse += 1;
  }
  console.log(`combat from L${String(start).padEnd(2)} avg ${(won / RUNS).toFixed(1)}W-${(lost / RUNS).toFixed(1)}L,` +
    ` no weapon ${(bare / RUNS * 100).toFixed(1)}%, 7-20 or worse ${(worse / RUNS * 100).toFixed(1)}%`);
}
