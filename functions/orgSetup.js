'use strict';

/**
 * Setup status for each PERMAFLEET org: whether its Discord is on record,
 * whether the bot is in that server, the invite it shared, and the officers
 * on the roster. Guild ids stay off this view; the admin page is still the
 * only place it is served.
 */

const INVITE_RE = /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([A-Za-z0-9-]+)/gi;

function inviteUrl (code) {
  return `https://discord.gg/${code}`;
}

function collectInvites (value, found) {
  const text = typeof value === 'string' ? value : '';
  if (!text) return;
  INVITE_RE.lastIndex = 0;
  let match;
  while ((match = INVITE_RE.exec(text))) {
    const url = inviteUrl(match[1]);
    if (!found.includes(url)) found.push(url);
  }
}

/**
 * Discord invites written on a public org record, links first.
 * @param {Object|null} record
 * @returns {string[]}
 */
function recordInvites (record) {
  const found = [];
  for (const link of (record && record.links) || []) collectInvites(link && link.href, found);
  for (const key of ['intro', 'history', 'manifesto', 'charter']) {
    for (const paragraph of (record && record[key]) || []) collectInvites(paragraph, found);
  }
  return found;
}

function officerName (account, records) {
  const id = String(account || '').replace(/^discord:/, '');
  for (const member of records || []) {
    const hit = (member.accounts || []).find((item) => item.platform === 'discord' && String(item.id) === id);
    if (!hit) continue;
    const profile = hit.profile || {};
    return member.displayName || profile.globalName || (profile.username ? `@${profile.username}` : null);
  }
  return null;
}

/**
 * @param {Object} [opts]
 * @param {Object} [opts.alliance] `contracts/alliance.json`
 * @param {Object|Array} [opts.organizations] `contracts/organizations.json` or its `organizations` list
 * @param {Array<{ id: string, name?: string }>|null} [opts.guilds] Servers the bot is in. Null when that list was not checked.
 * @param {Object[]} [opts.members] Member records, used only to name an officer.
 * @returns {Array<Object>}
 */
function setupRows (opts = {}) {
  const alliance = opts.alliance || { organizations: [] };
  const listed = Array.isArray(opts.organizations)
    ? opts.organizations
    : ((opts.organizations && opts.organizations.organizations) || []);
  const bySymbol = new Map(listed.map((org) => [String(org.symbol || '').toUpperCase(), org]));
  const guilds = opts.guilds;
  const byGuild = new Map();
  if (Array.isArray(guilds)) {
    for (const guild of guilds) {
      const id = String((guild && (guild.id || guild.guildId)) || '');
      if (id) byGuild.set(id, guild);
    }
  }
  const roster = alliance.organizations || [];
  const sharers = new Map();
  for (const org of roster) {
    if (!org.guildId) continue;
    const id = String(org.guildId);
    const symbols = sharers.get(id) || [];
    symbols.push(org.symbol);
    sharers.set(id, symbols);
  }
  return roster.map((org) => {
    const record = bySymbol.get(String(org.symbol || '').toUpperCase()) || null;
    const guildId = org.guildId ? String(org.guildId) : null;
    const live = guildId ? byGuild.get(guildId) : null;
    const server = live && live.name ? String(live.name) : null;
    return {
      symbol: org.symbol,
      name: (record && (record.displayName || record.name)) || org.symbol,
      discord: {
        configured: !!guildId,
        server,
        invite: recordInvites(record)[0] || null,
        bot: guilds == null ? null : !!(guildId && live),
        shared: guildId ? (sharers.get(guildId) || []).filter((symbol) => symbol !== org.symbol) : []
      },
      officers: (org.officers || []).map((account) => ({
        account: String(account),
        name: officerName(account, opts.members)
      }))
    };
  });
}

module.exports = { recordInvites, setupRows };
