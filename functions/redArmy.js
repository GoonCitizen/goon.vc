'use strict';

/**
 * RED ARMY: orgs and Discord servers that have added the goon.vc bot but
 * are not yet PERMAFLEET members. Public views carry names only — never
 * guild ids, account keys, or member ids. This is not a vote and not a
 * Fabric federation.
 */

const orgDiscord = require('./orgDiscord');
const { parseAccountKey } = require('./accountKey');

const SYMBOL_RE = /^[A-Z0-9_]{1,16}$/;

function parseOfficer (symbol, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${symbol}: officer is { account, name }`);
  }
  const parsed = parseAccountKey(value.account || value.key);
  if (!parsed) throw new Error(`${symbol}: invalid officer account`);
  const name = String(value.name || '').trim();
  if (!name) throw new Error(`${symbol}: officer needs a name`);
  return { account: parsed.key, name };
}

function parseIgnore (row) {
  const guildId = orgDiscord.parseGuildId(row && (row.guildId != null ? row.guildId : row));
  if (!guildId) throw new Error('RED ARMY ignore needs a Discord server id');
  return guildId;
}

function parseNamedGuild (label, value, seen) {
  const guildId = orgDiscord.parseGuildId(value);
  if (value != null && String(value).trim() !== '' && !guildId) {
    throw new Error(`${label}: guildId must be a Discord server id`);
  }
  if (guildId && seen.has(guildId)) throw new Error(`RED ARMY Discord listed twice: ${label}`);
  if (guildId) seen.add(guildId);
  return guildId || null;
}

function parseOfficers (label, list) {
  const officers = [];
  for (const officer of Array.isArray(list) ? list : []) {
    const parsed = parseOfficer(label, officer);
    if (officers.some((entry) => entry.account === parsed.account)) {
      throw new Error(`${label}: officer listed twice`);
    }
    officers.push(parsed);
  }
  return officers;
}

/**
 * @param {Object} raw `{ name?, organizations?, servers?, ignore? }`
 * @returns {{ name: string, organizations: Array<Object>, servers: Array<Object>, ignore: string[] }}
 */
function parseRoster (raw = {}) {
  const name = String((raw && raw.name) || 'RED ARMY').trim() || 'RED ARMY';
  const seenGuilds = new Set();
  const organizations = [];
  for (const org of Array.isArray(raw && raw.organizations) ? raw.organizations : []) {
    const symbol = String((org && org.symbol) || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new Error(`invalid RED ARMY symbol: ${org && org.symbol}`);
    if (organizations.some((entry) => entry.symbol === symbol)) throw new Error(`RED ARMY org listed twice: ${symbol}`);
    const entry = {
      symbol,
      name: String(org.name || symbol).trim() || symbol,
      officers: parseOfficers(symbol, org.officers)
    };
    const guildId = parseNamedGuild(symbol, org.guildId, seenGuilds);
    if (guildId) entry.guildId = guildId;
    if (org.rsi) {
      const rsi = String(org.rsi).trim().toUpperCase();
      if (!SYMBOL_RE.test(rsi)) throw new Error(`${symbol}: rsi must be an RSI org symbol`);
      entry.rsi = rsi;
    }
    const note = String(org.note || '').trim();
    if (note) entry.note = note;
    organizations.push(entry);
  }
  const servers = [];
  for (const row of Array.isArray(raw && raw.servers) ? raw.servers : []) {
    const label = String((row && row.name) || '').trim();
    if (!label) throw new Error('RED ARMY server needs a name');
    const entry = { name: label, officers: parseOfficers(label, row.officers) };
    const guildId = parseNamedGuild(label, row.guildId, seenGuilds);
    if (guildId) entry.guildId = guildId;
    const note = String(row.note || '').trim();
    if (note) entry.note = note;
    servers.push(entry);
  }
  const ignore = [];
  for (const row of Array.isArray(raw && raw.ignore) ? raw.ignore : []) {
    const guildId = parseIgnore(row);
    if (!ignore.includes(guildId)) ignore.push(guildId);
  }
  return { name, organizations, servers, ignore };
}

function allianceGuildIds (alliance) {
  const roster = alliance && alliance.organizations ? alliance : alliance && alliance.roster;
  return new Set(orgDiscord.guildIds(roster));
}

function slug (name, used) {
  let base = String(name || 'server').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (!base) base = 'server';
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

function publicOfficers (entry) {
  return (entry.officers || []).map((officer) => ({ name: officer.name }));
}

function publicOrg (org, guilds) {
  const discord = orgDiscord.view(org, guilds);
  const out = {
    id: org.symbol,
    symbol: org.symbol,
    name: org.name,
    kind: 'organization',
    officers: publicOfficers(org),
    discord
  };
  if (org.rsi) {
    out.rsi = { symbol: org.rsi, url: `https://robertsspaceindustries.com/orgs/${org.rsi}` };
  }
  if (org.note) out.note = org.note;
  return out;
}

function publicServer (server, guilds, used) {
  const discord = orgDiscord.view(server, guilds);
  const out = {
    id: slug(server.name, used),
    name: server.name,
    kind: 'server',
    officers: publicOfficers(server),
    discord
  };
  if (server.note) out.note = server.note;
  return out;
}

/**
 * Public RED ARMY roster: named orgs, named Discords that are not an RSI
 * org, plus other Discord servers the bot is in, minus the home server,
 * alliance member guilds, and the ignore list.
 * @param {Object} roster {@link parseRoster} result
 * @param {Array<{ id: string, name?: string }>} [guilds]
 * @param {Object} [opts]
 * @param {string} [opts.homeGuildId]
 * @param {Object} [opts.alliance] Alliance roster (`organizations[].guildId`)
 * @returns {{ name: string, organizations: Array<Object>, servers: Array<Object> }}
 */
function report (roster, guilds, opts = {}) {
  const home = orgDiscord.parseGuildId(opts.homeGuildId);
  const taken = allianceGuildIds(opts.alliance);
  if (home) taken.add(home);
  for (const id of (roster && roster.ignore) || []) taken.add(id);
  const namedGuilds = new Set();
  const organizations = ((roster && roster.organizations) || []).map((org) => {
    if (org.guildId) namedGuilds.add(org.guildId);
    return publicOrg(org, guilds);
  });
  const used = new Set(organizations.map((org) => String(org.id).toLowerCase()));
  const servers = [];
  for (const server of (roster && roster.servers) || []) {
    if (server.guildId) namedGuilds.add(server.guildId);
    if (server.guildId && taken.has(server.guildId)) continue;
    servers.push(publicServer(server, guilds, used));
  }
  for (const guild of Array.isArray(guilds) ? guilds : []) {
    const id = orgDiscord.parseGuildId(guild && (guild.id || guild.guildId));
    if (!id || taken.has(id) || namedGuilds.has(id)) continue;
    const discord = orgDiscord.view({ guildId: id }, [guild]);
    const label = discord.name || 'Discord server';
    servers.push({
      id: slug(label, used),
      name: label,
      kind: 'server',
      officers: [],
      discord: discord.linked ? discord : { linked: true }
    });
  }
  return {
    name: (roster && roster.name) || 'RED ARMY',
    organizations,
    servers
  };
}

module.exports = { parseRoster, report, slug };
