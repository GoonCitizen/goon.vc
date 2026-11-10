'use strict';

/**
 * Whether goon.vc's Discord bot is in a member org's server. Public views
 * carry only `{ linked, name }` — never the guild id.
 */

const SNOWFLAKE = /^\d{17,20}$/;

function parseGuildId (value) {
  const id = String(value == null ? '' : value).trim();
  return SNOWFLAKE.test(id) ? id : null;
}

function guildName (guild) {
  const name = String((guild && guild.name) || '').trim();
  if (!name || SNOWFLAKE.test(name)) return null;
  return name;
}

function indexGuilds (guilds) {
  const byId = new Map();
  for (const guild of Array.isArray(guilds) ? guilds : []) {
    const id = parseGuildId(guild && (guild.id || guild.guildId));
    if (!id) continue;
    byId.set(id, guild);
  }
  return byId;
}

/**
 * Public Discord status for one roster org.
 * @param {Object} org `{ guildId? }`
 * @param {Array<{ id: string, name?: string }>} [guilds] Servers the bot is in.
 * @returns {{ linked: boolean, name?: string }}
 */
function view (org, guilds) {
  const guildId = parseGuildId(org && org.guildId);
  if (!guildId) return { linked: false };
  const found = indexGuilds(guilds).get(guildId);
  if (!found) return { linked: false };
  const name = guildName(found);
  return name ? { linked: true, name } : { linked: true };
}

/**
 * @param {Object} roster `{ organizations: Array<{ symbol, guildId? }> }`
 * @param {Array<{ id: string, name?: string }>} [guilds]
 * @returns {Array<{ symbol: string, discord: { linked: boolean, name?: string } }>}
 */
function report (roster, guilds) {
  return ((roster && roster.organizations) || []).map((org) => ({
    symbol: org.symbol,
    discord: view(org, guilds)
  }));
}

module.exports = { parseGuildId, guildName, view, report };
