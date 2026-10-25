'use strict';

const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../contracts/recruiting.json');
// Campaign filters take at most 50 entries per list.
const MAX_EXCLUDED_CAMPAIGNS = 50;

/**
 * The recruiting contract (`contracts/recruiting.json`), or an empty one when
 * the file is missing or unreadable.
 * @param {string} [file]
 * @returns {Object} `{ guildId, activeWithinDays, qualified: { name, roles }, units: [] }`
 */
function load (file = FILE) {
  try {
    const recruiting = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.assign({ units: [] }, recruiting);
  } catch (_) {
    return { guildId: null, activeWithinDays: null, qualified: null, units: [] };
  }
}

function roleIds (roles) {
  return Object.values(roles || {}).map(String);
}

/**
 * Script `requires` entries that are Discord roles: name → role ids (holding
 * any one passes).
 * @param {Object} recruiting
 * @returns {Object<string, Array<string>>}
 */
function requirements (recruiting) {
  const qualified = recruiting && recruiting.qualified;
  if (!qualified || !qualified.name) return {};
  return { [qualified.name]: roleIds(qualified.roles) };
}

/**
 * The campaign title for a unit; re-runs find their earlier campaigns by it.
 * @param {Object} unit
 * @returns {string}
 */
function title (unit) {
  return `Recruiting: ${unit.name}`;
}

/**
 * One staff campaign draft per unit: the unit's script, offered to members of
 * the home server who hold a qualifying role and none of the unit's roles.
 * @param {Object} recruiting
 * @returns {Array<{ unit: string, draft: Object }>}
 */
function drafts (recruiting) {
  const qualified = roleIds(recruiting.qualified && recruiting.qualified.roles);
  return (recruiting.units || []).map((unit) => ({
    unit: unit.id,
    draft: {
      title: title(unit),
      owner: { kind: 'staff' },
      content: { type: 'script', script: unit.script, text: unit.message },
      filter: {
        platforms: ['discord'],
        guilds: recruiting.guildId ? [String(recruiting.guildId)] : [],
        roles: qualified,
        excludeRoles: roleIds(unit.roles),
        activeWithinDays: recruiting.activeWithinDays || null
      }
    }
  }));
}

/**
 * What to do with a draft given the campaigns already saved (the campaigns
 * API list): `create` it, `update` the open draft with the same title,
 * `keep` one already scheduled, or leave one that is `busy` sending or
 * paused. A new or updated draft skips everyone an earlier campaign with the
 * same title already reached (`excludeCampaigns`).
 * @param {Object} draft
 * @param {Array<Object>} existing `[{ id, title, status, startedAt }]`
 * @returns {{ action: string, id: string|null, draft: Object }}
 */
function plan (draft, existing = []) {
  const same = existing.filter((campaign) => campaign.title === draft.title);
  const reached = same
    .filter((campaign) => campaign.startedAt)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
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

module.exports = { FILE, load, requirements, title, drafts, plan };
