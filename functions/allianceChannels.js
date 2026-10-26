'use strict';

// Discord permission bits (https://discord.com/developers/docs/topics/permissions).
const PERMISSIONS = {
  ManageChannels: 1n << 4n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  ReadMessageHistory: 1n << 16n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  ManageRoles: 1n << 28n
};
const PERMISSION_NAMES = {
  ManageChannels: 'Manage Channels',
  ViewChannel: 'View Channels',
  SendMessages: 'Send Messages',
  ReadMessageHistory: 'Read Message History',
  Connect: 'Connect',
  Speak: 'Speak',
  ManageRoles: 'Manage Roles'
};

const TEXT = 0; // GuildText
const VOICE = 2; // GuildVoice
const ROLE = 0; // overwrite on a role
const MEMBER = 1; // overwrite on a member

const TALK = ['ViewChannel', 'SendMessages', 'ReadMessageHistory'];

/**
 * The channels every PERMAFLEET member org keeps on its own Discord. `access`
 * is `public` (@everyone may use it, whatever its category says) or `roles`
 * (hidden from @everyone; only the org's officers on record or the roles the
 * admin picks, and the bot).
 * Each has a DM script started with `/goon <subcommand>`.
 */
const CHANNELS = [
  {
    kind: 'council',
    subcommand: 'council',
    script: 'permafleet-council',
    name: 'council',
    label: '#council',
    type: TEXT,
    access: 'roles',
    allow: TALK,
    topic: 'Where our officers settle PERMAFLEET alliance votes.'
  },
  {
    kind: 'embassy',
    subcommand: 'embassy',
    script: 'permafleet-embassy',
    name: 'embassy',
    label: '#embassy',
    type: TEXT,
    access: 'public',
    allow: TALK,
    topic: 'Other orgs and PERMAFLEET leadership reach us here.'
  },
  {
    kind: 'permafleet',
    subcommand: 'permafleet',
    script: 'permafleet-channel',
    name: 'permafleet',
    label: '#permafleet',
    type: TEXT,
    access: 'public',
    allow: TALK,
    topic: 'PERMAFLEET alliance chat: ops, plans, and news from across the Protectorate.'
  },
  {
    kind: 'voice',
    subcommand: 'voice',
    script: 'permafleet-voice',
    name: 'PERMAFLEET',
    label: 'PERMAFLEET voice',
    type: VOICE,
    access: 'public',
    allow: ['ViewChannel', 'Connect', 'Speak'],
    topic: null
  }
];

/**
 * @param {string} kind `council` | `embassy` | `permafleet` | `voice`
 * @returns {Object|null}
 */
function spec (kind) {
  return CHANNELS.find((entry) => entry.kind === kind) || null;
}

function mask (names) {
  return names.reduce((sum, name) => sum | PERMISSIONS[name], 0n);
}

/**
 * A channel name without case, emoji, or separators: `🏛-embassy` and
 * `PERMAFLEET 🔊` match `embassy` and `PERMAFLEET`.
 * @param {string} name
 * @returns {string}
 */
function normalize (name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Is this existing channel the one a spec describes (same kind of channel,
 * same name once normalized)?
 * @param {Object} entry Channel spec.
 * @param {Object} channel discord.js channel.
 * @returns {boolean}
 */
function matches (entry, channel) {
  return !!channel && types(entry).includes(channel.type) && normalize(channel.name) === normalize(entry.name);
}

/**
 * Channel types an existing channel may have and still serve the spec.
 * @param {Object} entry
 * @returns {Array<number>}
 */
function types (entry) {
  return entry.type === VOICE ? [2, 13] : [0, 5];
}

/**
 * What the bot must hold server-wide to create the channel: Manage Channels,
 * plus every permission it allows (Discord lets a bot grant only what it has).
 * @param {Object} entry
 * @returns {Array<string>} permission names (keys of PERMISSIONS)
 */
function needs (entry) {
  return ['ManageChannels', ...entry.allow];
}

/**
 * Permission overwrites for a new channel.
 * @param {Object} entry Channel spec.
 * @param {Object} ids
 * @param {string} ids.everyone The @everyone role id (the guild id).
 * @param {string} [ids.bot] The bot's user id (kept able to see a private channel).
 * @param {Array<string>} [ids.roles] Roles that may use a `roles` channel.
 * @param {Array<string>} [ids.members] Members (user ids) that may use a `roles` channel.
 * @returns {Array<{ id: string, type: number, allow: bigint, deny: bigint }>}
 */
function overwrites (entry, { everyone, bot = null, roles = [], members = [] }) {
  const allow = mask(entry.allow);
  if (entry.access !== 'roles') return [{ id: String(everyone), type: ROLE, allow, deny: 0n }];
  const people = [...new Set(members.map(String))].filter((id) => !bot || id !== String(bot));
  return [
    { id: String(everyone), type: ROLE, allow: 0n, deny: PERMISSIONS.ViewChannel },
    ...roles.map((id) => ({ id: String(id), type: ROLE, allow, deny: 0n })),
    ...people.map((id) => ({ id, type: MEMBER, allow, deny: 0n })),
    ...(bot ? [{ id: String(bot), type: MEMBER, allow, deny: 0n }] : [])
  ];
}

/**
 * Everything the bot must hold server-wide to set up PERMAFLEET from scratch:
 * every channel here, plus Manage Roles for the Prospect ranks.
 * @returns {Array<string>} permission names (keys of PERMISSIONS)
 */
function setupNeeds () {
  return [...new Set([...CHANNELS.flatMap(needs), 'ManageRoles'])];
}

/**
 * The bot permission integer that covers {@link setupNeeds} (for the
 * `?for=channels` Discord invite).
 * @returns {string}
 */
function invitePermissions () {
  return String(mask(setupNeeds()));
}

module.exports = {
  CHANNELS,
  invitePermissions,
  PERMISSIONS,
  PERMISSION_NAMES,
  matches,
  needs,
  normalize,
  overwrites,
  setupNeeds,
  spec,
  types
};
