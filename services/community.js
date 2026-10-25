'use strict';

const path = require('path');
const { assertStoreOpen } = require('../functions/startStore');
const recruiting = require('../functions/recruiting');
const allianceChannels = require('../functions/allianceChannels');

const SCRIPTS_PATH = '/services/doorman/scripts';
const CAMPAIGNS_PATH = '/services/doorman/campaigns';
// What the gateway client needs for DM scripts: typed replies in a DM channel
// the bot has not cached yet only arrive with the Channel partial.
const INTENTS = ['DirectMessages'];
const PARTIALS = ['Channel'];
// Listing a server's members is privileged: Discord refuses the whole gateway
// connection when this is asked for without being enabled in the Developer Portal.
const CAMPAIGN_INTENTS = ['GuildMembers'];

// Discord permission bits (https://discord.com/developers/docs/topics/permissions).
const PERMISSIONS = Object.assign({ ManageGuild: 1n << 5n }, allianceChannels.PERMISSIONS);
const PERMISSION_NAMES = allianceChannels.PERMISSION_NAMES;
// The bot needs these to post announcements and read clips and pins.
const BOT_NEEDS = ['ViewChannel', 'SendMessages', 'ReadMessageHistory'];

const TEXT_CHANNELS = [0, 5]; // GuildText, GuildAnnouncement
const VOICE_CHANNELS = [2, 13]; // GuildVoice, GuildStageVoice
const CATEGORY = 4; // GuildCategory
// The channel-choice option a PERMAFLEET channel script answers with to have the bot make one.
const NEW_CHANNEL = 'new';

const FEATURES = [
  { id: 'calendar', label: 'Schedule calendar', description: 'Show your scheduled events on the goon.vc calendar' },
  { id: 'clips', label: 'Clip library', description: 'Collect clips posted in a channel into goon.vc/clips' },
  { id: 'idlerpg', label: 'IdleRPG announcements', description: 'Post level-ups and battles in a channel' },
  { id: 'permafleet', label: 'PERMAFLEET membership', description: 'Join the Protectorate as a member org' }
];

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

/**
 * Doorman's Scripts plugin, or null when the installed `@fabric/doorman`
 * predates it.
 * @returns {Function|null}
 */
function loadScripts () {
  try {
    return require('@fabric/doorman/services/scripts');
  } catch (_) {
    return null;
  }
}

/**
 * Doorman's Campaigns plugin, or null when the installed `@fabric/doorman`
 * predates it.
 * @returns {Function|null}
 */
function loadCampaigns () {
  try {
    return require('@fabric/doorman/services/campaigns');
  } catch (_) {
    return null;
  }
}

function httpError (status, message) {
  return Object.assign(new Error(message), { status });
}

// A script action failure whose message is shown to the person running it.
function exposed (message) {
  return Object.assign(new Error(message), { expose: true });
}

function has (permissions, bit) {
  if (!permissions || typeof permissions.has !== 'function') return false;
  try { return permissions.has(bit); } catch (_) { return false; }
}

function holdsAny (member, roleIds) {
  const cache = member && member.roles && member.roles.cache;
  if (!cache || typeof cache.has !== 'function') return false;
  return roleIds.some((id) => cache.has(String(id)));
}

/**
 * The one embedded `@fabric/doorman` host. Plugins plug into it (IdleRPG via
 * services/presence.js), and its Scripts plugin runs managed DM
 * conversations such as `/goon setup`, and the `permafleet.channel` action
 * behind `/goon council|embassy|permafleet|voice` creates those channels on
 * the admin's server ({@link Community#createChannel}). The Doorman Discord adapter attaches to
 * the Operations gateway client (`gateway` event): it never answers chat
 * (`replies: false`) and sends private messages only inside a running script.
 * Script definitions are seeded from `contracts/scripts/*.json` into the
 * Fabric Store (`stores/community`) and can be edited at runtime through the
 * token-gated HTTP API under `/services/doorman/scripts`.
 *
 * With `campaigns.enabled` (opt-in: it needs the privileged Server Members
 * intent), the Campaigns plugin DMs one message to every member a filter
 * selects across the servers the bot is in, at a fixed pace, with Start /
 * Stop buttons; its API is under `/services/doorman/campaigns` (token only).
 */
class Community {
  /**
   * @param {Object} [settings]
   * @param {boolean} [settings.enabled] Run DM scripts (default true). The Doorman host runs either way.
   * @param {string} [settings.path] Store directory for scripts, sessions, and results.
   * @param {string|Array<Object>} [settings.scripts] Seed directory (or definitions).
   * @param {string} [settings.token] Bearer token for script edits and results, and for the campaigns API.
   * @param {Object} [settings.campaigns] `{ enabled, path, intervalMs, maxAudience, guildCooldownMs }`.
   * @param {string} [settings.siteUrl] Absolute site origin for links in scripts.
   * @param {Array<Object>} [settings.features] `goon.features` choices.
   * @param {Object<string, Array<string>>} [settings.roles] Script `requires` entries that are Discord roles: name → role ids (any one passes). Defaults to the recruiting contract's qualifying rank.
   * @param {Object} [settings.operations] Operations service (or any emitter with `gateway` / `discord`).
   * @param {boolean} [settings.gateway] Attach to the Discord gateway when available (default true).
   * @param {Function} [settings.Doorman] Injected for tests; defaults to @fabric/doorman.
   * @param {Function} [settings.Scripts] Injected for tests; defaults to @fabric/doorman/services/scripts.
   * @param {Function} [settings.Campaigns] Injected for tests; defaults to @fabric/doorman/services/campaigns.
   * @param {Function} [settings.DoormanDiscord] Injected for tests; defaults to @fabric/doorman/services/discord.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      enabled: true,
      path: './stores/community',
      scripts: path.join(__dirname, '../contracts/scripts'),
      token: null,
      campaigns: { enabled: false },
      siteUrl: 'https://goon.vc',
      features: FEATURES,
      roles: recruiting.requirements(recruiting.load()),
      operations: null,
      gateway: true
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.doorman = null;
    this.scripts = null;
    this.campaigns = null;
    this._activity = null;
    this.adapter = null;
    this.discord = null;
    this.gateway = { status: 'disabled', error: null };
    this._listeners = {};
    this._onGateway = (discord) => this.attach(discord);
  }

  /**
   * Whether these settings run DM scripts (and so need {@link Community.INTENTS}
   * and {@link Community.PARTIALS} on the gateway).
   * @param {Object} [settings]
   * @returns {boolean}
   */
  static enabled (settings = {}) {
    return settings.enabled !== false && !!(settings.Scripts || loadScripts());
  }

  /**
   * Whether these settings run campaigns (and so need
   * {@link Community.CAMPAIGN_INTENTS} on the gateway).
   * @param {Object} [settings]
   * @returns {boolean}
   */
  static campaignsEnabled (settings = {}) {
    return settings.enabled !== false && !!(settings.campaigns && settings.campaigns.enabled === true) &&
      !!(settings.Campaigns || loadCampaigns());
  }

  /**
   * What these settings need from the shared gateway client: DMs for scripts
   * or campaigns, plus the privileged Server Members intent for campaigns.
   * @param {Object} [settings]
   * @returns {{ intents: string[], partials: string[] }}
   */
  static gateway (settings = {}) {
    const campaigns = Community.campaignsEnabled(settings);
    const directMessages = campaigns || Community.enabled(settings);
    return {
      intents: [...(directMessages ? INTENTS : []), ...(campaigns ? CAMPAIGN_INTENTS : [])],
      partials: directMessages ? PARTIALS.slice() : []
    };
  }

  on (event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  removeListener (event, handler) {
    this._listeners[event] = (this._listeners[event] || []).filter((entry) => entry !== handler);
    return this;
  }

  emit (event, ...args) {
    for (const handler of this._listeners[event] || []) {
      try { handler(...args); } catch (_) { /* listener errors stay local */ }
    }
    return this;
  }

  async start () {
    const Doorman = this.settings.Doorman || require('@fabric/doorman');
    this.doorman = new Doorman({ name: 'GOON.VC:doorman', http: false, local: false });
    this.doorman.on('error', (error) => this.emit('error', 'community doorman', errorMessage(error)));

    const Scripts = this.settings.enabled === false ? null : (this.settings.Scripts || loadScripts());
    if (Scripts) {
      this.scripts = this.plug(Scripts, {
        name: 'GOON.VC:scripts',
        path: this.settings.path,
        seed: this.settings.scripts,
        token: this.settings.token,
        basePath: SCRIPTS_PATH,
        persistent: true,
        verbosity: 1
      });
      this.scripts.on('error', (error) => this.emit('error', 'community scripts', errorMessage(error)));
      this.scripts.on('warning', (warning) => this.emit('log', 'GOON.VC', `community: ${errorMessage(warning)}`));
      this.scripts.source('discord.guild.textChannels', (scope) => this.channels(scope.context, TEXT_CHANNELS));
      this.scripts.source('discord.guild.voiceChannels', (scope) => this.channels(scope.context, VOICE_CHANNELS));
      this.scripts.source('discord.guild.categories', (scope) => this.categories(scope.context));
      this.scripts.source('discord.guild.roles', (scope) => this.roles(scope.context));
      for (const entry of allianceChannels.CHANNELS) {
        this.scripts.source(`permafleet.channels.${entry.kind}`, (scope) => this.channelChoices(scope.context, entry));
      }
      this.scripts.source('goon.features', () => this.settings.features);
      this.scripts.action('permafleet.channel', (session, entry) => this.createChannel(session, entry));
      this.scripts.authorize((requirement, session) => this.authorize(requirement, session));
    } else if (this.settings.enabled !== false) {
      this.emit('log', 'GOON.VC', 'community: this @fabric/doorman has no Scripts plugin; DM scripts are off');
    }

    const campaignSettings = this.settings.campaigns || {};
    if (Community.campaignsEnabled(this.settings)) {
      const Campaigns = this.settings.Campaigns || loadCampaigns();
      this.campaigns = this.plug(Campaigns, Object.fromEntries(Object.entries({
        name: 'GOON.VC:campaigns',
        path: campaignSettings.path || './stores/campaigns',
        intervalMs: campaignSettings.intervalMs,
        maxAudience: campaignSettings.maxAudience,
        guildCooldownMs: campaignSettings.guildCooldownMs,
        now: campaignSettings.now,
        via: String(this.settings.siteUrl || '').replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '') || null,
        token: this.settings.token,
        basePath: CAMPAIGNS_PATH,
        persistent: true,
        verbosity: 1
      }).filter(([, value]) => value !== undefined)));
      this.campaigns.on('error', (error) => this.emit('error', 'community campaigns', errorMessage(error)));
      this.campaigns.on('warning', (warning) => this.emit('log', 'GOON.VC', `community: ${errorMessage(warning)}`));
      this.campaigns.audience('discord', (filter, campaign) => this.discordAudience(filter, campaign));
      if (this._activity) this.campaigns.activity(this._activity);
    } else if (campaignSettings.enabled === true && this.settings.enabled !== false) {
      this.emit('log', 'GOON.VC', 'community: this @fabric/doorman has no Campaigns plugin; campaigns are off');
    }

    await this.doorman.start();
    if (this.scripts) {
      await this.ready(this.scripts);
      await assertStoreOpen(this.scripts.store);
    }
    if (this.campaigns) {
      await this.ready(this.campaigns);
      await assertStoreOpen(this.campaigns.store);
    }

    if (this.settings.gateway !== false) {
      this.gateway = { status: 'waiting', error: null };
      const operations = this.settings.operations;
      if (operations) {
        if (operations.discord) this.attach(operations.discord);
        else if (typeof operations.on === 'function') operations.on('gateway', this._onGateway);
      }
    }
    return this;
  }

  /**
   * Add a Doorman plugin to the shared host. It starts right away; await
   * {@link Community#ready} before using its Store.
   * @param {Function} Plugin
   * @param {Object} [settings]
   * @returns {Object} the plugin instance
   */
  plug (Plugin, settings = {}) {
    const name = String(Plugin.pluginName || Plugin.name).toLowerCase();
    this.doorman.use(Plugin, settings);
    return this.doorman.plugins[name];
  }

  /**
   * Resolves once a plugged-in plugin has started.
   * @param {Object} plugin
   * @returns {Promise<Object>}
   */
  async ready (plugin) {
    const name = Object.keys(this.doorman.plugins).find((key) => this.doorman.plugins[key] === plugin);
    if (name && typeof this.doorman.started === 'function') await this.doorman.started(name);
    else if (name && this.doorman._pluginStarts) await this.doorman._pluginStarts[name];
    return plugin;
  }

  /**
   * Feed Doorman from an `@fabric/discord` client the process already runs.
   * Emits `attached (discord, adapter)` for plugins that post through it.
   * @param {Object} discord
   * @returns {Community}
   */
  attach (discord) {
    if (!discord || this.adapter) return this;
    const DoormanDiscord = this.settings.DoormanDiscord || require('@fabric/doorman/services/discord');
    this.discord = discord;
    this.adapter = new DoormanDiscord({ client: discord, replies: false, whispers: !!(this.scripts || this.campaigns) });
    this.doorman.enable('discord', this.adapter);
    this.gateway = { status: 'attached', error: null };
    this.emit('log', 'GOON.VC', 'community: Doorman attached to the Discord gateway');
    this.emit('attached', discord, this.adapter);
    return this;
  }

  /**
   * Start a script for a Discord member over DM. Errors keep discord.js codes
   * (50007: the member does not accept DMs from server members).
   * @param {string} scriptId
   * @param {Object} options
   * @param {string} options.user `discord/users/<id>`
   * @param {string} [options.name] Display name.
   * @param {Object} [options.context] `{ guildId, guildName, … }`
   * @param {string} [options.subject] What the result is about (the guild id).
   * @returns {Promise<Object>} `{ id, script, status, step }`
   */
  async beginScript (scriptId, options = {}) {
    if (!this.scripts) throw Object.assign(new Error('Setup scripts are off.'), { status: 503 });
    const context = Object.assign({}, options.context || {});
    const channel = allianceChannels.CHANNELS.find((entry) => entry.script === scriptId) || null;
    Object.assign(context, this.guildContext(context.guildId, channel));
    return this.scripts.begin(scriptId, Object.assign({}, options, { context }));
  }

  /**
   * What scripts may show about a guild: the invite link and the guild-wide
   * permissions the bot is missing (names, never ids). For a PERMAFLEET
   * channel script, also what the bot lacks to create that channel and the
   * invite that grants it.
   * @param {string} guildId
   * @param {Object} [channel] Channel spec (functions/allianceChannels.js).
   * @returns {{ siteUrl: string, inviteUrl: string, botMissing: string, channelMissing?: string, channelInviteUrl?: string }}
   */
  guildContext (guildId, channel = null) {
    const siteUrl = String(this.settings.siteUrl || '').replace(/\/+$/, '');
    const guild = this._guild(guildId);
    const me = guild && guild.members ? guild.members.me : null;
    const lacking = (names) => (me ? names.filter((name) => !has(me.permissions, PERMISSIONS[name])) : []);
    const context = {
      siteUrl,
      inviteUrl: `${siteUrl}/services/discord/invite`,
      botMissing: lacking(BOT_NEEDS).map((name) => PERMISSION_NAMES[name]).join(', ')
    };
    if (channel) {
      context.channelMissing = lacking(allianceChannels.needs(channel)).map((name) => PERMISSION_NAMES[name]).join(', ');
      context.channelInviteUrl = `${context.inviteUrl}?for=channels`;
    }
    return context;
  }

  /**
   * Script choices for a PERMAFLEET channel: have the bot create it, or use a
   * channel the server already has (likely matches first).
   * @param {Object} context `{ guildId }`
   * @param {Object} channel Channel spec.
   * @returns {Array<{ id: string, label: string, description: string|null }>}
   */
  channelChoices (context, channel) {
    const existing = this.channels(context, allianceChannels.types(channel));
    const likely = (option) => allianceChannels.normalize(option.label) === allianceChannels.normalize(channel.name);
    return [
      { id: NEW_CHANNEL, label: `Create ${channel.label}`, description: 'goon.vc’s bot makes it' },
      ...existing.filter(likely),
      ...existing.filter((option) => !likely(option))
    ];
  }

  /**
   * Script choices for a guild's channel categories, in server order.
   * @param {Object} context `{ guildId }`
   * @returns {Array<{ id: string, label: string }>}
   */
  categories (context) {
    const guild = this._guild(context && context.guildId);
    if (!guild || !guild.channels || !guild.channels.cache) return [];
    return [...guild.channels.cache.values()]
      .filter((channel) => channel.type === CATEGORY)
      .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0))
      .map((channel) => ({ id: String(channel.id), label: channel.name }));
  }

  /**
   * Script choices for a guild's roles, highest first: not @everyone, and not
   * roles an integration manages (bots, boosts).
   * @param {Object} context `{ guildId }`
   * @returns {Array<{ id: string, label: string }>}
   */
  roles (context) {
    const guild = this._guild(context && context.guildId);
    if (!guild || !guild.roles || !guild.roles.cache) return [];
    return [...guild.roles.cache.values()]
      .filter((role) => String(role.id) !== String(guild.id) && !role.managed)
      .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
      .map((role) => ({ id: String(role.id), label: role.name }));
  }

  /**
   * `permafleet.channel` script action (`{ action, kind }`): use the channel
   * the admin picked, or one the server already has by that name, or create
   * it with the spec's permissions (in the picked category; a `roles`
   * channel only for the picked roles and the bot). Existing channels keep
   * their permissions. Refusals are exposed to the admin.
   * @param {Object} session Script session view.
   * @param {Object} entry `onComplete` entry.
   * @returns {Promise<{ answers: { channelId: string, created: boolean }, labels: { result: string } }>}
   */
  async createChannel (session, entry = {}) {
    const channel = allianceChannels.spec(entry.kind);
    if (!channel) throw new Error(`unknown PERMAFLEET channel "${entry.kind}"`);
    const again = `Run \`/goon ${channel.subcommand}\` in your server to try again.`;
    const guild = this._guild(session.context && session.context.guildId);
    if (!guild || !guild.channels || !guild.channels.cache) throw exposed(`I can’t reach that server right now. ${again}`);
    const answers = session.answers || {};

    if (answers.channel && answers.channel !== NEW_CHANNEL) {
      const picked = guild.channels.cache.get(String(answers.channel));
      if (!picked) throw exposed(`That channel is gone. ${again}`);
      return this._channelResult(picked, false);
    }
    const existing = [...guild.channels.cache.values()].find((candidate) => allianceChannels.matches(channel, candidate));
    if (existing) return this._channelResult(existing, false);

    const me = guild.members ? guild.members.me : null;
    const missing = allianceChannels.needs(channel).filter((name) => !has(me && me.permissions, PERMISSIONS[name]));
    if (missing.length) {
      const { channelInviteUrl } = this.guildContext(guild.id, channel);
      throw exposed(`To make ${channel.label}, goon.vc’s bot needs ${missing.map((name) => PERMISSION_NAMES[name]).join(', ')} on **${guild.name}**. Grant them here: ${channelInviteUrl}\nThen ${again.charAt(0).toLowerCase()}${again.slice(1)}`);
    }
    const roleCache = guild.roles && guild.roles.cache;
    const roles = [].concat(answers.roles || []).map(String).filter((id) => roleCache && roleCache.has(id));
    if (channel.access === 'roles' && !roles.length) throw exposed(`None of the roles you picked are on **${guild.name}** any more. ${again}`);
    const category = answers.category ? guild.channels.cache.get(String(answers.category)) : null;
    const client = this.discord && this.discord.client;
    const bot = (me && me.id) || (client && client.user && client.user.id) || null;

    let created;
    try {
      created = await guild.channels.create(Object.assign({
        name: channel.name,
        type: channel.type,
        permissionOverwrites: allianceChannels.overwrites(channel, { everyone: guild.id, bot, roles }),
        reason: `PERMAFLEET ${channel.label}, set up by ${session.name || 'a server admin'} with /goon ${channel.subcommand}`
      }, channel.topic ? { topic: channel.topic } : {}, category && category.type === CATEGORY ? { parent: category.id } : {}));
    } catch (error) {
      throw exposed(`Discord didn’t let me make ${channel.label}: ${errorMessage(error)}. ${again}`);
    }
    this.emit('log', 'GOON.VC', `community: created ${channel.label} on ${guild.name}`);
    return this._channelResult(created, true);
  }

  _channelResult (channel, created) {
    const mention = `<#${channel.id}>`;
    return {
      answers: { channelId: String(channel.id), created },
      labels: { result: created ? `Created ${mention}.` : `Using ${mention}; I left its permissions as they are.` }
    };
  }

  /**
   * Script choices for a guild's channels of the given types, in server order.
   * @param {Object} context `{ guildId }`
   * @param {Array<number>} types discord.js channel types
   * @returns {Array<{ id: string, label: string, description: string|null }>}
   */
  channels (context, types) {
    const guild = this._guild(context && context.guildId);
    if (!guild || !guild.channels || !guild.channels.cache) return [];
    const me = guild.members ? guild.members.me : null;
    const voice = types.some((type) => VOICE_CHANNELS.includes(type));
    return [...guild.channels.cache.values()]
      .filter((channel) => types.includes(channel.type))
      .sort((a, b) => (a.rawPosition ?? a.position ?? 0) - (b.rawPosition ?? b.position ?? 0))
      .map((channel) => {
        const permissions = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
        const lacking = permissions ? BOT_NEEDS.filter((name) => !has(permissions, PERMISSIONS[name])) : [];
        const category = channel.parent && channel.parent.name ? channel.parent.name : null;
        return {
          id: String(channel.id),
          label: voice ? channel.name : `#${channel.name}`,
          description: lacking.length
            ? `Bot needs: ${lacking.map((name) => PERMISSION_NAMES[name]).join(', ')}`
            : category
        };
      });
  }

  /**
   * Say when a member was last active, for campaigns' `activeWithinDays`.
   * @param {Function} fn `(target) => number|string|Date|null` (`target` is `discord/users/<id>`).
   * @returns {Community}
   */
  activity (fn) {
    this._activity = fn;
    if (this.campaigns) this.campaigns.activity(fn);
    return this;
  }

  /**
   * Campaign audience on Discord: members (no bots) of every server the bot
   * is in, narrowed to `filter.guilds` (a server's own campaign only ever
   * reaches that server), holding any of `filter.roles` (everyone when
   * empty) and none of `filter.excludeRoles`, and not in any of
   * `filter.excludeGuilds`. Members are listed fresh from Discord, which
   * needs the Server Members intent.
   * @param {Object} filter Campaign filter.
   * @param {Object} campaign `{ owner }`
   * @returns {Promise<Array<{ target: string, name: string|null, source: string, sourceName: string }>>}
   */
  async discordAudience (filter, campaign) {
    const client = this.discord && this.discord.client;
    if (!client || !client.guilds || !client.guilds.cache) throw httpError(503, 'The Discord bot is not connected right now.');
    const owner = campaign && campaign.owner;
    const wanted = owner && owner.kind === 'guild' ? [owner.guildId] : filter.guilds;
    const guilds = [...client.guilds.cache.values()].filter((guild) => {
      const id = String(guild.id);
      return (!wanted.length || wanted.includes(id)) && !filter.excludeGuilds.includes(id);
    });

    const excluded = new Set();
    for (const id of filter.excludeGuilds) {
      const guild = client.guilds.cache.get(id);
      if (!guild) continue;
      for (const member of await this._members(guild)) excluded.add(String(member.id || (member.user && member.user.id)));
    }

    const people = [];
    for (const guild of guilds) {
      for (const member of await this._members(guild)) {
        const user = member.user || {};
        const id = String(user.id || member.id);
        if (user.bot || excluded.has(id)) continue;
        const roles = member.roles && member.roles.cache ? [...member.roles.cache.keys()].map(String) : [];
        if (filter.roles.length && !filter.roles.some((role) => roles.includes(role))) continue;
        if (filter.excludeRoles.some((role) => roles.includes(role))) continue;
        people.push({
          target: `discord/users/${id}`,
          name: member.displayName || user.globalName || user.username || null,
          source: String(guild.id),
          sourceName: guild.name
        });
      }
    }
    return people;
  }

  async _members (guild) {
    try {
      const members = await guild.members.fetch();
      return [...members.values()];
    } catch (error) {
      this.emit('error', 'community campaigns', `could not list the members of ${guild.name}: ${errorMessage(error)}`);
      throw httpError(503, `Could not list the members of ${guild.name}. Try again in a little while.`);
    }
  }

  /**
   * Scripts a campaign may offer (those anyone may run: no `requires`).
   * @returns {Array<{ id: string, title: string }>}
   */
  campaignScripts () {
    if (!this.scripts) return [];
    return this.scripts.list()
      .filter((entry) => !(this.scripts.definition(entry.id).requires || []).length)
      .map((entry) => ({ id: entry.id, title: entry.title }));
  }

  /**
   * Does this Discord member hold a permission in a server right now?
   * @param {string} userId
   * @param {string} guildId
   * @param {string} [requirement='ManageGuild']
   * @returns {Promise<boolean>}
   */
  async can (userId, guildId, requirement = 'ManageGuild') {
    return this.authorize(requirement, { user: `discord/users/${userId}`, context: { guildId } });
  }

  /**
   * Script `requires` check: the member's current permissions or roles in the
   * guild, read fresh from Discord at start and again before answers are
   * recorded. The owner passes every permission, but holds only their roles.
   * @param {string} requirement Permission name (`ManageGuild`) or a name in `settings.roles` (`[P4] Prospect IV`).
   * @param {Object} session `{ user, context: { guildId } }`
   * @returns {Promise<boolean>}
   */
  async authorize (requirement, session) {
    const roles = Object.prototype.hasOwnProperty.call(this.settings.roles || {}, requirement)
      ? this.settings.roles[requirement]
      : null;
    const bit = roles ? null : PERMISSIONS[requirement];
    const match = /^discord\/users\/(\d+)$/.exec(String(session && session.user));
    const guild = this._guild(session && session.context && session.context.guildId);
    if ((!bit && !roles) || !match || !guild) return false;
    if (bit && guild.ownerId && String(guild.ownerId) === match[1]) return true;
    if (!guild.members || typeof guild.members.fetch !== 'function') return false;
    const member = await guild.members.fetch({ user: match[1], force: true }).catch(() => null);
    if (!member) return false;
    return roles ? holdsAny(member, roles) : has(member.permissions, bit);
  }

  _guild (guildId) {
    const client = this.discord && this.discord.client;
    if (!guildId || !client || !client.guilds || !client.guilds.cache) return null;
    return client.guilds.cache.get(String(guildId)) || null;
  }

  /**
   * Aggregate script statistics (no user ids).
   * @returns {Promise<Object>}
   */
  async report () {
    return {
      scripts: this.scripts ? this.scripts.report() : null,
      campaigns: this.campaigns ? this.campaigns.report() : null,
      gateway: this.gateway
    };
  }

  /**
   * Express middleware for the Scripts HTTP API under `/services/doorman/scripts`
   * and the Campaigns API under `/services/doorman/campaigns`.
   * @returns {Function}
   */
  middleware () {
    let scripts = null;
    let campaigns = null;
    return (req, res, next) => {
      if (this.scripts && !scripts) scripts = this.scripts.middleware({ token: this.settings.token, basePath: SCRIPTS_PATH });
      if (this.campaigns && !campaigns) campaigns = this.campaigns.middleware({ token: this.settings.token, basePath: CAMPAIGNS_PATH });
      const handlers = [campaigns, scripts].filter(Boolean);
      const run = (index) => (index < handlers.length ? handlers[index](req, res, () => run(index + 1)) : next());
      return run(0);
    };
  }

  async stop () {
    const operations = this.settings.operations;
    if (operations && typeof operations.removeListener === 'function') operations.removeListener('gateway', this._onGateway);
    if (this.doorman) await this.doorman.stop();
    return this;
  }
}

module.exports = Community;
module.exports.INTENTS = INTENTS;
module.exports.PARTIALS = PARTIALS;
module.exports.CAMPAIGN_INTENTS = CAMPAIGN_INTENTS;
module.exports.CAMPAIGNS_PATH = CAMPAIGNS_PATH;
module.exports.FEATURES = FEATURES;
module.exports.NEW_CHANNEL = NEW_CHANNEL;
module.exports.PERMISSIONS = PERMISSIONS;
module.exports.SCRIPTS_PATH = SCRIPTS_PATH;
