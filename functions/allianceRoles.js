'use strict';

const HOME = require('../contracts/goon-squad.json');

const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI'];
const PROSPECT = /\bprospect\s*(vi|iv|v|iii|ii|i|[1-6])\b/i;

/**
 * The ranks every PERMAFLEET member org keeps on its own Discord: the Prospect
 * ranks new members climb, with the G00N SQUAD names so `[P4] Prospect IV`
 * reads alike everywhere. Set up with `/goon roles` or `/goon setup`.
 */
const PROSPECTS = NUMERALS.map((numeral, index) => ({ kind: 'prospect', rank: index + 1, name: `[P${index + 1}] Prospect ${numeral}` }));
const SCRIPT = { subcommand: 'roles', script: 'permafleet-roles', label: 'the Prospect ranks' };

/**
 * The Prospect rank a role name stands for (`Prospect IV`, `[P4] Prospect 4`), or null.
 * @param {string} name
 * @returns {number|null}
 */
function prospectRank (name) {
  const match = PROSPECT.exec(String(name || ''));
  if (!match) return null;
  const rank = /^\d$/.test(match[1]) ? Number(match[1]) : NUMERALS.indexOf(match[1].toUpperCase()) + 1;
  return rank >= 1 ? rank : null;
}

function rolesOf (guild) {
  const cache = guild && guild.roles && guild.roles.cache;
  if (!cache || typeof cache.values !== 'function') return [];
  return [...cache.values()].filter((role) => String(role.id) !== String(guild.id));
}

/** The Prospect rank a G00N SQUAD role id stands for, or null. */
function homeProspectRank (id) {
  const roles = HOME.roles || {};
  for (const [name, roleId] of Object.entries(roles)) {
    if (String(roleId) === String(id)) return prospectRank(name);
  }
  return null;
}

/**
 * The Prospect ranks a server has no role for yet, lowest first.
 * On the G00N SQUAD server the known role ids count even if renamed.
 * @param {Object} guild discord.js Guild.
 * @returns {Array<{ rank: number, name: string }>}
 */
function missingProspects (guild) {
  const home = String(guild && guild.id) === String(HOME.guildId);
  const held = new Set();
  for (const role of rolesOf(guild)) {
    const rank = prospectRank(role.name) || (home && homeProspectRank(role.id));
    if (rank) held.add(rank);
  }
  return PROSPECTS.filter((entry) => !held.has(entry.rank));
}

/** `Prospect I to VI`, or `Prospect I, III` for a few. */
function describeProspects (entries) {
  if (entries.length === PROSPECTS.length) return 'Prospect I to VI';
  return `Prospect ${entries.map((entry) => NUMERALS[entry.rank - 1]).join(', ')}`;
}

module.exports = {
  HOME,
  NUMERALS,
  PROSPECTS,
  SCRIPT,
  describeProspects,
  homeProspectRank,
  missingProspects,
  prospectRank,
  rolesOf
};
