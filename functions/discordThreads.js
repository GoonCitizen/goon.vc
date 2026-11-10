'use strict';

/**
 * @fileoverview Walk a guild's threads over Discord REST: the active ones
 * (one call for the whole guild) and every archived public thread under a
 * channel, forum and media posts included. Shared by clips and the Market.
 */

const discordEvents = require('./discordScheduledEvents');

const PAGE_SIZE = 100;

function errorMessage (res) {
  return (res.json && res.json.message) || res.error || `HTTP ${res.status}`;
}

/**
 * Active threads in a guild, by parent channel id.
 * @param {string} token bot token
 * @param {string} guildId
 * @param {Object} [opts] `{ fetch }` for discordGet
 * @returns {Promise<Map<string, Object[]>>}
 */
async function activeThreads (token, guildId, opts = {}) {
  const byParent = new Map();
  const res = await discordEvents.discordGet(`/guilds/${guildId}/threads/active`, token, opts);
  if (res.status !== 200 || !res.json || !Array.isArray(res.json.threads)) return byParent;
  for (const thread of res.json.threads) {
    const parent = String(thread.parent_id || '');
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(thread);
  }
  return byParent;
}

/**
 * Every archived public thread under a channel, newest archive first. A
 * channel without Read Message History gives none.
 * @param {string} token bot token
 * @param {string} channelId
 * @param {Object} [opts] `{ fetch }` for discordGet
 * @returns {Promise<Object[]>}
 */
async function archivedThreads (token, channelId, opts = {}) {
  const threads = [];
  let before = null;
  for (let page = 0; page < 1000; page++) {
    const query = `limit=${PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
    const res = await discordEvents.discordGet(`/channels/${channelId}/threads/archived/public?${query}`, token, opts);
    if (res.status === 403) break;
    if (res.status !== 200 || !res.json || !Array.isArray(res.json.threads)) throw new Error(errorMessage(res));
    threads.push(...res.json.threads);
    const last = res.json.threads[res.json.threads.length - 1];
    if (!res.json.has_more || !last || !last.thread_metadata) break;
    before = last.thread_metadata.archive_timestamp;
  }
  return threads;
}

module.exports = {
  activeThreads,
  archivedThreads,
  errorMessage
};
