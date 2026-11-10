'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../contracts/welcome.json');
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
// Deliveries that count as welcomed: everything but a cancelled one.
const REACHED = ['pending', 'sent', 'closed', 'failed'];

/**
 * The welcome contract (`contracts/welcome.json`), or an empty one when the
 * file is missing or unreadable.
 * @param {string} [file]
 * @returns {Object} `{ guildId, title, delayHours, windowDays, requirement, script, exclude, message }`
 */
function load (file = FILE) {
  try {
    return Object.assign({ delayHours: 24, windowDays: 30, exclude: {} }, JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (_) {
    return { guildId: null, title: null, delayHours: 24, windowDays: 30, requirement: null, script: null, exclude: {}, message: null };
  }
}

/**
 * Script `requires` entries that are Discord roles: name → role ids.
 * @param {Object} welcome
 * @returns {Object<string, Array<string>>}
 */
function requirements (welcome) {
  const requirement = welcome && welcome.requirement;
  if (!requirement || !requirement.name) return {};
  return { [requirement.name]: Object.values(requirement.roles || {}).map(String) };
}

/**
 * Every role whose holders are never welcomed.
 * @param {Object} welcome
 * @returns {Array<string>}
 */
function excludedRoles (welcome) {
  const ids = Object.values(welcome.exclude || {}).flatMap((group) => Object.values(group || {}));
  return [...new Set(ids.map(String))];
}

/**
 * The staff campaign draft: the welcome script, offered to members of the
 * home server holding none of the excluded roles. Who joined when is
 * narrowed by {@link joinedWindow} on the audience.
 * @param {Object} welcome
 * @returns {Object}
 */
function draft (welcome) {
  return {
    title: welcome.title,
    owner: { kind: 'staff' },
    content: { type: 'script', script: welcome.script, text: welcome.message },
    filter: {
      platforms: ['discord'],
      guilds: welcome.guildId ? [String(welcome.guildId)] : [],
      excludeRoles: excludedRoles(welcome)
    }
  };
}

/**
 * Join times a member must fall between to be welcomed now: at least
 * `delayHours` ago and at most `windowDays` ago.
 * @param {Object} welcome
 * @param {number} now ms
 * @returns {{ from: number, to: number }} ms
 */
function joinedWindow (welcome, now) {
  return { from: now - welcome.windowDays * DAY, to: now - welcome.delayHours * HOUR };
}

/**
 * Discord user targets an earlier welcome campaign already reached (or is
 * reaching), from Doorman's deliveries; a cancelled delivery doesn't count.
 * @param {Object} welcome
 * @param {Array<Object>} campaigns `[{ id, title }]`
 * @param {Object<string, Object<string, { status: string }>>} deliveries by campaign id, then target
 * @returns {Set<string>}
 */
function reached (welcome, campaigns, deliveries) {
  const targets = new Set();
  for (const campaign of campaigns) {
    if (campaign.title !== welcome.title) continue;
    for (const [target, delivery] of Object.entries((deliveries || {})[campaign.id] || {})) {
      if (REACHED.includes(delivery.status)) targets.add(target);
    }
  }
  return targets;
}

module.exports = { FILE, load, requirements, excludedRoles, draft, joinedWindow, reached };
