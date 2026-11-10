'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../contracts/checkin.json');
const DAY = 24 * 60 * 60 * 1000;
// Campaign filters take at most 50 entries per list.
const MAX_EXCLUDED_CAMPAIGNS = 50;
const TITLE_PREFIX = 'Check-in: ';

/**
 * The check-in contract (`contracts/checkin.json`), or an empty one when the
 * file is missing or unreadable.
 * @param {string} [file]
 * @returns {Object} `{ guildId, spacingDays, requirement: { name, roles }, script, tiers: [] }`
 */
function load (file = FILE) {
  try {
    const checkin = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign({ spacingDays: 30, tiers: [] }, checkin);
  } catch (_) {
    return { guildId: null, spacingDays: 30, requirement: null, script: null, tiers: [] };
  }
}

/**
 * Script `requires` entries that are Discord roles: name → role ids.
 * @param {Object} checkin
 * @returns {Object<string, Array<string>>}
 */
function requirements (checkin) {
  const requirement = checkin && checkin.requirement;
  if (!requirement || !requirement.name) return {};
  return { [requirement.name]: Object.values(requirement.roles || {}).map(String) };
}

/**
 * The campaign title for a tier; re-runs find their earlier campaigns by it.
 * @param {Object} tier
 * @returns {string}
 */
function title (tier) {
  return `${TITLE_PREFIX}${tier.name}`;
}

/**
 * One staff campaign draft per tier, most inactive tier first: the check-in
 * script, offered to members of the home server last active within the
 * tier's window (Doorman sends the most inactive first).
 * @param {Object} checkin
 * @returns {Array<{ tier: string, draft: Object }>}
 */
function drafts (checkin) {
  return (checkin.tiers || [])
    .slice()
    .sort((a, b) => b.inactiveForDays - a.inactiveForDays)
    .map((tier) => ({
      tier: tier.id,
      draft: {
        title: title(tier),
        owner: { kind: 'staff' },
        content: { type: 'script', script: checkin.script, text: tier.message },
        filter: {
          platforms: ['discord'],
          guilds: checkin.guildId ? [String(checkin.guildId)] : [],
          excludeRoles: (tier.excludeRoles || []).map(String),
          inactiveForDays: tier.inactiveForDays,
          activeWithinDays: tier.activeWithinDays || null
        }
      }
    }));
}

function reachedSomeone (campaign) {
  return !!campaign.startedAt && !(campaign.stats && campaign.stats.sent === 0 && ['sent', 'cancelled'].includes(campaign.status));
}

/**
 * What to do with a tier's draft given the campaigns already saved (the
 * campaigns API list): `create` it, `update` the open draft with the same
 * title, `keep` one already scheduled, or leave one that is `busy` sending
 * or paused. A new or updated draft skips everyone an earlier campaign of
 * the same tier reached (one touch per tier) and everyone any check-in
 * reached in the last `spacingDays` (no two check-ins close together).
 * @param {Object} draft
 * @param {Array<Object>} existing `[{ id, title, status, startedAt, stats }]`
 * @param {Object} [options]
 * @param {number} [options.spacingDays] Days between two check-ins to one member.
 * @param {number} [options.now] ms
 * @returns {{ action: string, id: string|null, draft: Object }}
 */
function plan (draft, existing = [], options = {}) {
  const spacing = (Number(options.spacingDays) || 0) * DAY;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const newest = (a, b) => String(b.startedAt).localeCompare(String(a.startedAt));
  const same = existing.filter((campaign) => campaign.title === draft.title);
  const recent = existing.filter((campaign) => campaign.title !== draft.title &&
    String(campaign.title || '').startsWith(TITLE_PREFIX) &&
    campaign.startedAt && now - Date.parse(campaign.startedAt) < spacing);
  const reached = same.filter(reachedSomeone).sort(newest)
    .concat(recent.filter(reachedSomeone).sort(newest))
    .slice(0, MAX_EXCLUDED_CAMPAIGNS)
    .map((campaign) => campaign.id);
  const next = Object.assign({}, draft, {
    filter: Object.assign({}, draft.filter, { excludeCampaigns: reached })
  });
  const busy = same.find((campaign) => campaign.status === 'sending' || campaign.status === 'paused');
  if (busy) return { action: 'busy', id: busy.id, draft: next };
  const scheduled = same.find((campaign) => campaign.status === 'scheduled');
  if (scheduled) return { action: 'keep', id: scheduled.id, draft: next };
  const open = same.find((campaign) => campaign.status === 'draft');
  if (open) return { action: 'update', id: open.id, draft: next };
  return { action: 'create', id: null, draft: next };
}

module.exports = { FILE, TITLE_PREFIX, load, requirements, title, drafts, plan };
