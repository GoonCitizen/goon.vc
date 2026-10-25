'use strict';

/**
 * Go-live announcements (Streamcord and the like, or a member's own post) →
 * the Twitch channels and past broadcasts (VODs) they point at, and which VOD
 * an announcement belongs to once the host lists them.
 */

// twitch.tv/videos/<id>, twitch.tv/<login>/v[ideo[s]]/<id>, or twitch.tv/<login> (not one of its clips).
const TWITCH_URL = /https?:\/\/(?:(?:www|m|go)\.)?twitch\.tv\/(?:videos\/(\d+)|([A-Za-z0-9_]{3,25})(?:\/(?:v|videos?)\/(\d+))?(?![A-Za-z0-9_]|\/clip\/))/gi;
// First path segments that are Twitch pages, not channels.
const NOT_CHANNELS = new Set([
  'about', 'bits', 'broadcast', 'collections', 'creatorcamp', 'directory', 'downloads', 'drops', 'embed', 'event',
  'friends', 'inventory', 'jobs', 'login', 'messages', 'moderator', 'p', 'popout', 'prime', 'search', 'settings',
  'signup', 'store', 'subscriptions', 'team', 'turbo', 'u', 'videos', 'wallet'
]);
// How far an announcement may come before Twitch's start (clock differences) or after it (a re-announcement).
const BEFORE_START_MS = 10 * 60 * 1000;
const AFTER_START_MS = 15 * 60 * 1000;

function texts (message) {
  const out = [String(message.content || '')];
  for (const embed of message.embeds || []) {
    if (!embed) continue;
    out.push(embed.url, embed.description, embed.author && embed.author.url);
    for (const field of embed.fields || []) out.push(field && field.value);
  }
  for (const row of message.components || []) {
    for (const button of (row && row.components) || []) out.push(button && button.url);
  }
  return out.filter((value) => typeof value === 'string' && value);
}

/**
 * The Twitch channels and VODs a message links.
 * @param {Object} message Discord message
 * @returns {{ channels: Array<string>, vods: Array<{ id: string, channel: string|null }>, streamer: string|null, title: string|null }|null}
 *   `channels` are lowercase logins; `streamer` and `title` come from a rich embed when there is one.
 */
function readAnnouncement (message) {
  if (!message) return null;
  const channels = new Set();
  const vods = new Map();
  for (const value of texts(message)) {
    for (const match of value.matchAll(TWITCH_URL)) {
      const login = match[2] ? match[2].toLowerCase() : null;
      const vod = match[1] || match[3];
      if (vod) {
        if (!vods.has(vod)) vods.set(vod, { id: vod, channel: login && !NOT_CHANNELS.has(login) ? login : null });
        continue;
      }
      if (login && !NOT_CHANNELS.has(login)) channels.add(login);
    }
  }
  for (const vod of vods.values()) if (vod.channel) channels.delete(vod.channel);
  if (!channels.size && !vods.size) return null;
  const embed = (message.embeds || []).find((e) => e && e.type === 'rich' && /twitch\.tv/i.test(String(e.url || (e.author && e.author.url) || ''))) || null;
  return {
    channels: Array.from(channels),
    vods: Array.from(vods.values()),
    streamer: (embed && embed.author && embed.author.name) || null,
    title: (embed && embed.title) || null
  };
}

/**
 * One VOD row as yt-dlp prints it (`id`, `timestamp`, `duration`, `is_live`,
 * `uploader`, `uploader_id`, `title`) → `{ id, startedAt, startMs, durationMs,
 * live, streamer, channel, title }`, or null.
 * @param {Object} row
 */
function readVod (row) {
  if (!row || typeof row !== 'object') return null;
  const id = String(row.id || '').replace(/^v/, '');
  const startMs = Number(row.timestamp) * 1000;
  if (!/^\d+$/.test(id) || !Number.isFinite(startMs) || startMs <= 0) return null;
  return {
    id,
    startedAt: new Date(startMs).toISOString(),
    startMs,
    durationMs: Math.max(0, Math.round((Number(row.duration) || 0) * 1000)),
    live: row.is_live === true,
    streamer: row.uploader ? String(row.uploader) : null,
    channel: row.uploader_id ? String(row.uploader_id).toLowerCase() : null,
    title: row.title ? String(row.title) : null
  };
}

/**
 * The VOD an announcement made at `announcedMs` belongs to: the latest one
 * that started no later than just after the announcement and was still going
 * (or had only just ended) when it was posted.
 * @param {Array<Object>} vods `readVod` results
 * @param {number} announcedMs
 * @returns {Object|null}
 */
function pickVod (vods, announcedMs) {
  const fits = (vods || []).filter((vod) => vod &&
    vod.startMs <= announcedMs + BEFORE_START_MS &&
    vod.startMs + Math.max(vod.durationMs, AFTER_START_MS) >= announcedMs);
  return fits.reduce((best, vod) => (!best || vod.startMs > best.startMs ? vod : best), null);
}

/**
 * Whether a VOD is over: Twitch no longer reports it live and it has not grown
 * for `settleMs` (a live broadcast's VOD runs up to now).
 * @param {Object} vod
 * @param {number} nowMs
 * @param {number} settleMs
 */
function vodFinished (vod, nowMs, settleMs) {
  return Boolean(vod) && !vod.live && vod.startMs + vod.durationMs <= nowMs - settleMs;
}

module.exports = {
  readAnnouncement,
  readVod,
  pickVod,
  vodFinished
};
