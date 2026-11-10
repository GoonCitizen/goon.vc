'use strict';

/**
 * Discord → Fabric chat packs, shaped like the GoonCitizen `GroupDataShare`
 * (`chat.catalog` / `chat.messages`, platform `discord`) that
 * star-citizen-live's Chat browses (`functions/groupDataSync.js` there), and
 * the "public channel" rule that decides what may be relayed at all.
 */

const SHARE_TYPE = 'GroupDataShare';
const PLATFORM = 'discord';
const PACK_CATALOG = 'chat.catalog';
const PACK_MESSAGES = 'chat.messages';

// discord.js PermissionFlagsBits.ViewChannel.
const VIEW_CHANNEL = 1n << 10n;
// Text and announcement channels: the ones GoonCitizen's Chat rail lists.
const CHANNEL_TYPES = new Set([0, 5]);

// GoonCitizen keeps the newest 12 channels × 20 messages of one pack and cuts
// bodies at 500 characters; staying inside that means nothing is dropped.
const MAX_CHANNELS_PER_SHARE = 12;
const MAX_MESSAGES_PER_CHANNEL = 20;
const MAX_BODY_CHARS = 500;
const MAX_CATALOG_CHANNELS = 80;
// AMP bodies are capped at 32 KiB; leave room for the share envelope.
const MAX_PACK_BYTES = 24 * 1024;

function bytes (value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function isoTime (value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

/**
 * A channel of `guildId` that @everyone can view: text or announcement, not
 * age-restricted. Private channels, threads, voice chat, and DMs never pass.
 * @param {Object} channel discord.js channel
 * @param {string} guildId
 * @returns {boolean}
 */
function isPublicChannel (channel, guildId) {
  if (!channel || !guildId || String(channel.guildId) !== String(guildId)) return false;
  if (!CHANNEL_TYPES.has(channel.type) || channel.nsfw) return false;
  const everyone = channel.guild && channel.guild.roles && channel.guild.roles.everyone;
  if (!everyone || typeof channel.permissionsFor !== 'function') return false;
  const permissions = channel.permissionsFor(everyone);
  return !!(permissions && permissions.has(VIEW_CHANNEL));
}

/**
 * Public channels of a guild, in Discord's sidebar order.
 * @param {Object} guild discord.js guild
 * @returns {Object[]}
 */
function publicChannels (guild) {
  if (!guild || !guild.channels || !guild.channels.cache) return [];
  return Array.from(guild.channels.cache.values())
    .filter((channel) => isPublicChannel(channel, guild.id))
    .sort((a, b) => (Number(a.rawPosition ?? a.position) || 0) - (Number(b.rawPosition ?? b.position) || 0));
}

/**
 * `chat.catalog` pack: the guild and its public channels, no member list.
 * @param {Object} guild discord.js guild
 * @param {Object[]} channels public channels of that guild
 * @returns {Object}
 */
function catalogPack (guild, channels) {
  return {
    pack: PACK_CATALOG,
    platform: PLATFORM,
    payload: {
      platform: PLATFORM,
      guilds: [{
        id: String(guild.id),
        name: String(guild.name || guild.id),
        icon: guild.icon != null ? String(guild.icon) : null,
        memberCount: Number(guild.memberCount) || 0,
        channels: channels.slice(0, MAX_CATALOG_CHANNELS).map((channel) => ({
          id: String(channel.id),
          name: String(channel.name || channel.id),
          type: channel.type,
          parentId: channel.parentId != null ? String(channel.parentId) : null,
          position: Number(channel.rawPosition ?? channel.position) || 0
        })),
        members: []
      }]
    }
  };
}

function messageBody (message) {
  const text = String((message.cleanContent != null ? message.cleanContent : message.content) || '').trim();
  const files = message.attachments && typeof message.attachments.values === 'function'
    ? Array.from(message.attachments.values()).map((file) => `[${file.name || 'attachment'}]`)
    : [];
  return [text].concat(files).filter(Boolean).join(' ').slice(0, MAX_BODY_CHARS);
}

/**
 * One relayed message, or null for system messages and empty posts.
 * Mentions are written as names (`cleanContent`), never as `<@id>`.
 * @param {Object} message discord.js message
 * @returns {Object|null}
 */
function messageRecord (message) {
  if (!message || !message.id || !message.channelId || !message.author || message.system) return null;
  const body = messageBody(message);
  if (!body) return null;
  const author = message.author;
  const handle = (message.member && message.member.displayName) || author.globalName || author.username || null;
  return {
    discordMessageId: String(message.id),
    channelId: String(message.channelId),
    guildId: message.guildId != null ? String(message.guildId) : null,
    authorId: String(author.id),
    handle,
    bot: !!(author.bot || message.webhookId),
    body,
    ts: isoTime(message.createdTimestamp || message.createdAt)
  };
}

/**
 * Split messages into `chat.messages` packs GoonCitizen keeps whole: at most
 * 12 channels per pack, 20 messages per channel entry, and `maxBytes` of JSON.
 * @param {Array<{ channelId: string, guildId: string|null, messages: Object[] }>} channels
 * @param {Object} [opts]
 * @param {number} [opts.maxBytes]
 * @returns {Object[]} packs
 */
function messagePacks (channels, opts = {}) {
  const maxBytes = Number(opts.maxBytes) || MAX_PACK_BYTES;
  const packs = [];
  let current = [];
  let size = 0;
  const close = () => {
    if (current.length) packs.push({ pack: PACK_MESSAGES, platform: PLATFORM, payload: { platform: PLATFORM, channels: current } });
    current = [];
    size = 0;
  };
  for (const channel of channels || []) {
    const messages = (channel.messages || []).slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    let entry = null;
    for (const message of messages) {
      const messageBytes = bytes(message) + 1;
      const needsEntry = !entry || entry.messages.length >= MAX_MESSAGES_PER_CHANNEL;
      const shell = { channelId: String(channel.channelId), guildId: channel.guildId || null, lastMessageAt: message.ts, messages: [] };
      const entryBytes = needsEntry ? bytes(shell) + 1 : 0;
      const full = size + entryBytes + messageBytes > maxBytes;
      const crowded = needsEntry && (current.length >= MAX_CHANNELS_PER_SHARE || current.some((row) => row.channelId === shell.channelId));
      if (current.length && (full || crowded)) {
        close();
        entry = null;
      }
      if (!entry || entry.messages.length >= MAX_MESSAGES_PER_CHANNEL) {
        entry = shell;
        current.push(entry);
        size += bytes(shell) + 1;
      }
      entry.messages.push(message);
      entry.lastMessageAt = message.ts;
      size += messageBytes;
    }
  }
  close();
  return packs;
}

/**
 * `CONTRACT_MESSAGE` body carrying one `GroupDataShare`.
 * @param {Object} opts
 * @param {string} opts.contract group contract id (or the GoonCitizen namespace)
 * @param {string} opts.groupId GoonCitizen Federation group id
 * @param {string} opts.pubkey signer
 * @param {Object[]} opts.packs
 * @param {string} [opts.sourceAppId] Discord application id
 * @returns {Object}
 */
function shareBody (opts) {
  return {
    contract: String(opts.contract),
    type: SHARE_TYPE,
    actor: { publicKey: opts.pubkey, id: opts.pubkey },
    object: {
      type: SHARE_TYPE,
      '@type': SHARE_TYPE,
      groupId: String(opts.groupId),
      sourceAppId: opts.sourceAppId ? String(opts.sourceAppId) : null,
      observedAt: isoTime(opts.observedAt || Date.now()),
      truncated: false,
      packs: opts.packs
    }
  };
}

module.exports = {
  SHARE_TYPE,
  PACK_CATALOG,
  PACK_MESSAGES,
  MAX_MESSAGES_PER_CHANNEL,
  MAX_PACK_BYTES,
  isPublicChannel,
  publicChannels,
  catalogPack,
  messageRecord,
  messagePacks,
  shareBody
};
