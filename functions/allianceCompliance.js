'use strict';

const allianceChannels = require('./allianceChannels');
const allianceRoles = require('./allianceRoles');

const { PERMISSIONS, PERMISSION_NAMES } = allianceChannels;
const { NUMERALS, rolesOf } = allianceRoles;
const DONE = '✅';
const TODO = '⬜';

// What every PERMAFLEET member org keeps up (components/PermafleetOnboarding.js
// "What we expect"), then what the alliance recommends; keep the two in step.
const CHECKS = [
  { id: 'embassy', kind: 'channel', channel: 'embassy', required: true, label: '#embassy, open to everyone' },
  { id: 'voice', kind: 'channel', channel: 'voice', required: true, label: 'A PERMAFLEET voice channel, open to everyone' },
  { id: 'prospects', kind: 'prospects', required: true, label: 'Prospect ranks, starting at Prospect I' },
  { id: 'council', kind: 'channel', channel: 'council', required: false, label: 'A private #council for your officers' },
  { id: 'permafleet', kind: 'channel', channel: 'permafleet', required: false, label: '#permafleet, open to everyone' }
];

function has (permissions, bit) {
  if (!permissions || typeof permissions.has !== 'function') return false;
  try { return permissions.has(bit); } catch (_) { return false; }
}

function channelName (channel) {
  return channel.type === 2 || channel.type === 13 ? channel.name : `#${channel.name}`;
}

function everyoneOf (guild) {
  return (guild.roles && guild.roles.everyone) || String(guild.id);
}

/**
 * What @everyone may do in a channel, against what the spec needs: a public
 * channel must allow every permission it opens up, a private one must hide
 * itself from @everyone.
 * @returns {{ ok: boolean, problem: string|null }}
 */
function access (guild, spec, channel) {
  let permissions = null;
  try {
    permissions = typeof channel.permissionsFor === 'function' ? channel.permissionsFor(everyoneOf(guild)) : null;
  } catch (_) {
    permissions = null;
  }
  if (!permissions) return { ok: false, problem: 'I can’t read its permissions' };
  if (spec.access === 'roles') {
    return has(permissions, PERMISSIONS.ViewChannel)
      ? { ok: false, problem: 'everyone on the server can see it' }
      : { ok: true, problem: null };
  }
  const missing = spec.allow.filter((name) => !has(permissions, PERMISSIONS[name]));
  return missing.length
    ? { ok: false, problem: `@everyone can’t ${missing.map((name) => PERMISSION_NAMES[name]).join(', ')} there` }
    : { ok: true, problem: null };
}

function channelCheck (guild, check) {
  const spec = allianceChannels.spec(check.channel);
  const fix = `\`/goon ${spec.subcommand}\` sets it up.`;
  const cache = guild.channels && guild.channels.cache;
  const found = cache && typeof cache.values === 'function'
    ? [...cache.values()].filter((channel) => allianceChannels.matches(spec, channel))
    : [];
  if (!found.length) return { ok: false, detail: 'none yet', fix };
  const results = found.map((channel) => Object.assign({ channel }, access(guild, spec, channel)));
  const good = results.find((result) => result.ok);
  if (good) return { ok: true, detail: channelName(good.channel), fix: null };
  const first = results[0];
  return { ok: false, detail: `${channelName(first.channel)} is there, but ${first.problem}`, fix };
}

function prospectCheck (guild) {
  const ranks = new Set();
  const home = String(guild && guild.id) === String(allianceRoles.HOME.guildId);
  for (const role of rolesOf(guild)) {
    const rank = allianceRoles.prospectRank(role.name) || (home && allianceRoles.homeProspectRank(role.id));
    if (rank) ranks.add(rank);
  }
  const found = [...ranks].sort((a, b) => a - b).map((rank) => NUMERALS[rank - 1]);
  if (ranks.has(1)) return { ok: true, detail: `Prospect ${found.join(', ')}`, fix: null };
  return {
    ok: false,
    detail: found.length ? `Prospect ${found.join(', ')}, but no Prospect I` : 'no Prospect roles yet',
    fix: 'New members start at Prospect I and move up the ranks by showing up. `/goon roles` adds them.'
  };
}

/**
 * Where a Discord server stands against what PERMAFLEET expects of member
 * orgs, read from the server as it is (nothing is changed). Names only, never ids.
 * @param {Object} guild discord.js Guild (channels, roles).
 * @returns {{ checks: Array<{ id: string, label: string, required: boolean, ok: boolean, detail: string, fix: string|null }>, required: { passed: number, total: number }, recommended: { passed: number, total: number } }}
 */
function check (guild) {
  const checks = CHECKS.map((entry) => {
    const result = entry.kind === 'channel' ? channelCheck(guild, entry) : prospectCheck(guild);
    return { id: entry.id, label: entry.label, required: entry.required, ok: result.ok, detail: result.detail, fix: result.fix };
  });
  const tally = (required) => {
    const group = checks.filter((entry) => entry.required === required);
    return { passed: group.filter((entry) => entry.ok).length, total: group.length };
  };
  return { checks, required: tally(true), recommended: tally(false) };
}

function line (entry) {
  const fix = entry.ok || !entry.fix ? '' : ` ${entry.fix}`;
  return `${entry.ok ? DONE : TODO} ${entry.label}: ${entry.detail}.${fix}`;
}

/**
 * The checklist as DM text: expected items, then recommended ones.
 * @param {Object} report From {@link check}.
 * @returns {string}
 */
function render (report) {
  const group = (required) => report.checks.filter((entry) => entry.required === required).map(line);
  return [
    `**Expected of every member org** (${report.required.passed} of ${report.required.total})`,
    ...group(true),
    `**Recommended** (${report.recommended.passed} of ${report.recommended.total})`,
    ...group(false)
  ].join('\n');
}

module.exports = {
  CHECKS,
  check,
  render
};
