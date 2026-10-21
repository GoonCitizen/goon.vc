'use strict';

const { DEFAULT_GUILD_ID, discordGet } = require('./discordScheduledEvents');
const resolveDiscordToken = require('./resolveDiscordToken');

const HANDLE = /^[a-z0-9_.]{2,32}$/;
const SEARCH_LIMIT = 25;
const MAX_RESULTS = 10;
const CACHE_MS = 60 * 1000;
const CACHE_SIZE = 200;

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * A Discord handle as typed (`@Kersa`, ` kersa `) in its canonical form
 * (`kersa`), or null when it can't be one.
 * @param {string} value
 * @returns {string|null}
 */
function normalizeHandle (value) {
  const handle = String(value || '').trim().replace(/^@/, '').toLowerCase();
  return HANDLE.test(handle) ? handle : null;
}

/**
 * One server member (raw API member or discord.js GuildMember) as
 * `{ id, handle, name, names }`, where `name` is how the server shows them
 * and `names` every name they can be found by; null for bots.
 * @private
 */
function entry (member) {
  const user = (member && member.user) || {};
  if (!user.id || !user.username || user.bot) return null;
  const nick = member.nick || member.nickname || null;
  const global = user.global_name || user.globalName || null;
  return {
    id: String(user.id),
    handle: String(user.username),
    name: String(nick || global || user.username),
    names: [nick, global, user.username].filter(Boolean).map((name) => String(name).toLowerCase())
  };
}

/**
 * Members of the home Discord server, found by handle, server nickname, or
 * display name. Discord's member search (bot token, REST, no privileged
 * intent) matches the start of a handle or nickname; members the gateway
 * client has already seen (in voice or chat) are also matched by any part of
 * any of their names, display name included. Bots are left out. `search`
 * returns handles and display names only; `resolve` also returns the account
 * id, which callers keep private.
 * @param {Object} [settings]
 * @param {Object} [settings.discord] settings.discord (token / secretsFile / guildId).
 * @param {Function} [settings.gateway] `() => discord.js Client|null`, the gateway client already running.
 * @param {Function} [settings.fetch] Injected for tests; defaults to global fetch.
 * @param {Function} [settings.resolveToken] Injected for tests; defaults to resolveDiscordToken.
 * @returns {{ search: Function, resolve: Function }}
 */
function createDiscordDirectory (settings = {}) {
  const discord = settings.discord || {};
  const guildId = String(discord.guildId || DEFAULT_GUILD_ID);
  const resolveToken = settings.resolveToken || resolveDiscordToken;
  const cache = new Map();

  function seen () {
    try {
      const client = typeof settings.gateway === 'function' ? settings.gateway() : null;
      const guild = client && client.guilds && client.guilds.cache.get(guildId);
      return guild ? [...guild.members.cache.values()].map(entry).filter(Boolean) : [];
    } catch (_) {
      return [];
    }
  }

  async function searched (query) {
    const key = query.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.members;
    const auth = resolveToken(discord);
    if (!auth || !auth.token) throw fail(503, 'Discord lookup is not available right now.');
    const params = new URLSearchParams({ query, limit: String(SEARCH_LIMIT) });
    // One attempt: a rate-limited lookup fails fast instead of holding the request.
    const res = await discordGet(`/guilds/${guildId}/members/search?${params}`, auth.token, { fetch: settings.fetch, retries: 1 });
    if (res.status !== 200 || !Array.isArray(res.json)) throw fail(503, 'Discord lookup is not available right now.');
    const found = res.json.map(entry).filter(Boolean);
    cache.delete(key);
    cache.set(key, { at: Date.now(), members: found });
    if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    return found;
  }

  return {
    /**
     * Server members matching the text, those whose name starts with it first.
     * @param {string} text
     * @returns {Promise<Array<{ handle: string, name: string }>>}
     */
    async search (text) {
      const query = String(text || '').trim().replace(/^@/, '').slice(0, 32);
      if (query.length < 2) return [];
      const wanted = query.toLowerCase();
      let found = [];
      let failure = null;
      try {
        found = await searched(query);
      } catch (error) {
        failure = error;
      }
      const merged = new Map();
      for (const member of found.concat(seen().filter((m) => m.names.some((name) => name.includes(wanted))))) {
        if (!merged.has(member.id)) merged.set(member.id, member);
      }
      if (!merged.size && failure) throw failure;
      const starts = (member) => member.names.some((name) => name.startsWith(wanted)) ? 0 : 1;
      return [...merged.values()]
        .map((member, index) => ({ member, index }))
        .sort((x, y) => starts(x.member) - starts(y.member) || x.index - y.index)
        .slice(0, MAX_RESULTS)
        .map(({ member }) => ({ handle: member.handle, name: member.name }));
    },

    /**
     * The server member with exactly this handle, or null.
     * @param {string} value `@handle` or `handle`
     * @returns {Promise<{ id: string, handle: string, name: string }|null>}
     */
    async resolve (value) {
      const handle = normalizeHandle(value);
      if (!handle) return null;
      const match = (member) => member.handle.toLowerCase() === handle;
      const found = seen().find(match) || (await searched(handle)).find(match);
      return found ? { id: found.id, handle: found.handle, name: found.name } : null;
    }
  };
}

module.exports = createDiscordDirectory;
module.exports.normalizeHandle = normalizeHandle;
