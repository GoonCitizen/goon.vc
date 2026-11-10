'use strict';

/**
 * @fileoverview Reads the 1v1 ladder officers keep by hand in a pinned
 * Discord message: `N. <@userId>` lines (ties repeat a number, gaps are
 * kept) plus an optional `### Rules` list. Pure; no Discord calls.
 */

const RANKED = /(\d+)\s*[.:)]\s*(?:<@!?(\d+)>|@([A-Za-z0-9_.]{2,32}))\s*$/;
const NUMBERED = /^\s*(\d+)\s*[.)]\s+(.+?)\s*$/;
const HEADING = /^\s*#{1,6}\s+(.*?)\s*$/;

/**
 * Discord markdown and mentions down to plain text.
 * @private
 */
function plain (text) {
  return String(text || '')
    .replace(/<@!?\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} content Pinned message content.
 * @returns {{ title: string|null, ladder: Array<{ rank: number, userId: string|null, handle: string|null }>, rules: string[] }}
 */
function parseLeaderboard (content) {
  const ladder = [];
  const rules = [];
  let title = null;
  let section = '';
  for (const line of String(content || '').split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    const ranked = RANKED.exec(line);
    if (ranked) {
      ladder.push({ rank: Number(ranked[1]), userId: ranked[2] || null, handle: ranked[3] || null });
      continue;
    }
    if (heading) {
      if (!title) title = plain(heading[1]) || null;
      section = plain(heading[1]).toLowerCase();
      continue;
    }
    const numbered = NUMBERED.exec(line);
    if (numbered && /rule/.test(section)) {
      const text = plain(numbered[2]);
      if (text) rules.push(text);
    }
  }
  return { title, ladder, rules };
}

/**
 * The pinned message holding the ladder: one titled LEADERBOARD, otherwise
 * the pin with the most ranked lines.
 * @param {object[]} pins Discord message objects.
 * @returns {object|null}
 */
function findLeaderboardPin (pins) {
  const list = (Array.isArray(pins) ? pins : []).filter((m) => m && typeof m.content === 'string');
  const titled = list.find((m) => /^\s*#{1,6}\s*leaderboard\b/im.test(m.content));
  if (titled) return titled;
  let best = null;
  let most = 0;
  for (const m of list) {
    const count = parseLeaderboard(m.content).ladder.length;
    if (count > most) { best = m; most = count; }
  }
  return best;
}

/**
 * What Discord shows for a member in the guild: server nickname, then
 * display name, then username.
 * @param {object} [member] Guild member object.
 * @param {object} [user] User object.
 * @returns {string|null}
 */
function displayName (member, user) {
  const u = (member && member.user) || user || {};
  return (member && member.nick) || u.global_name || u.username || null;
}

module.exports = {
  parseLeaderboard,
  findLeaderboardPin,
  displayName
};
