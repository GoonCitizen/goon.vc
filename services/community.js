'use strict';

const path = require('path');
const { assertStoreOpen } = require('../functions/startStore');
const recruiting = require('../functions/recruiting');
const checkin = require('../functions/checkin');
const welcome = require('../functions/welcome');
const allianceChannels = require('../functions/allianceChannels');
const allianceCompliance = require('../functions/allianceCompliance');
const allianceRoles = require('../functions/allianceRoles');

const SCRIPTS_PATH = '/services/doorman/scripts';
const CAMPAIGNS_PATH = '/services/doorman/campaigns';
// What the gateway client needs for DM scripts: typed replies in a DM channel
// the bot has not cached yet only arrive with the Channel partial.
const INTENTS = ['DirectMessages'];
const PARTIALS = ['Channel'];
// Listing a server's members is privileged: Discord refuses the whole gateway
// connection when this is asked for without being enabled in the Developer Portal.
const CAMPAIGN_INTENTS = ['GuildMembers'];
const CAMPAIGN_SEND_REFUSAL = 'Only remaeus can send campaign DMs.';
const CAMPAIGN_SCHEDULE = /(?:^|\/)services\/doorman\/campaigns\/[^/?]+\/schedule\/?(?:\?|$)/;
// After a successful listing (a `/goon campaign` preview), Send reuses it so
// Discord is not asked for the whole roster twice in a few seconds.
const MEMBER_CACHE_MS = 5 * 60 * 1000;

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
// The Prospect-rank choices: have the bot add the missing ranks, or keep the server's own.
const NEW_ROLE = 'new';
const KEEP_ROLES = 'keep';
// The #council access choice for opening it to the org's officers on record themselves (no role).
const OFFICERS_ACCESS = 'officers';
// goon-setup's answer for having the bot set up every PERMAFLEET channel and rank.
const BUILD_ALL = 'create';
// A script `requires` entry: the caller is an officer on record for a member org.
const OFFICER = 'PERMAFLEET org officer';
const ROLE_SCRIPT = allianceRoles.SCRIPT.script;
// Scripts that show the server's PERMAFLEET checklist before anything is chosen or changed.
const COMPLIANCE_SCRIPTS = new Set(['goon-setup', ROLE_SCRIPT, ...allianceChannels.CHANNELS.map((entry) => entry.script)]);
// The order goon-setup builds PERMAFLEET channels in.
const SETUP_CHANNELS = ['embassy', 'voice', 'permafleet', 'council'];
const SETUP_CATEGORY = 'PERMAFLEET';

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

// A requirement that fails with its own explanation instead of Doorman's generic one.
function refusal (message) {
  return Object.assign(new Error(message), { status: 403, refusal: true });
}

function userOf (session) {
  const match = /^discord\/users\/(\d+)$/.exec(String(session && session.user));
  return match ? match[1] : null;
}

// Officers on record, by name; those without a goon.vc profile are counted.
function officerList (people) {
  const named = people.map((person) => person.name).filter(Boolean);
  const unnamed = people.length - named.length;
  if (unnamed) named.push(`${unnamed} not on goon.vc yet`);
  return named.join(', ');
}

function lowerFirst (text) {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

function has (permissions, bit) {
  if (!permissions || typeof permissions.has !== 'function') return false;
  try { return permissions.has(bit); } catch (_) { return false; }
}

// How a recipient appears in previews: server display name, with the handle when it differs.
function audienceName (member, user) {
  const name = member.displayName || user.globalName || user.username || null;
  if (!name) return null;
  return user.username && user.username.toLowerCase() !== name.toLowerCase() ? `${name} (@${user.username})` : name;
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
 * the admin's server ({@link Community#createChannel}), `/goon roles` the
 * Prospect ranks ({@link Community#createRoles}). PERMAFLEET setup acts for
 * an org only for its officers on record ({@link Community#alliance}). The
 * Doorman Discord adapter attaches to
 * the Operations gateway client (`gateway` event): it never answers chat
 * (`replies: false`) and sends private messages only inside a running script.
 * Script definitions are seeded from `contracts/scripts/*.json` into the
 * Fabric Store (`stores/community`) and can be edited at runtime through the
 * token-gated HTTP API under `/services/doorman/scripts`.
 *
 * With `campaigns.enabled` (on unless GOON_CAMPAIGNS=0; it needs the privileged
 * Server Members intent), the Campaigns plugin DMs one message to every member
 * a filter selects across the servers the bot is in, at a fixed pace, with
 * Start / Stop buttons; its API is under `/services/doorman/campaigns` (token only).
 */
class Community {
  /**
   * @param {Object} [settings]
   * @param {boolean} [settings.enabled] Run DM scripts (default true). The Doorman host runs either way.
   * @param {string} [settings.path] Store directory for scripts, sessions, and results.
   * @param {string|Array<Object>} [settings.scripts] Seed directory (or definitions).
   * @param {string} [settings.token] Bearer token for script edits and results, and for the campaigns API.
   * @param {Object} [settings.campaigns] `{ enabled, path, intervalMs, maxAudience, guildCooldownMs, senders }`. `senders` is Discord user ids who may send DMs (omit to leave sends unrestricted).
   * @param {string} [settings.siteUrl] Absolute site origin for links in scripts.
   * @param {Array<Object>} [settings.features] `goon.features` choices.
   * @param {Object<string, Array<string>>} [settings.roles] Script `requires` entries that are Discord roles: name → role ids (any one passes). Defaults to the recruiting contract's qualifying rank and the check-in contract's G00N SQUAD membership (its @everyone role).
   * @param {Object} [settings.operations] Operations service (or any emitter with `gateway` / `discord`).
   * @param {boolean} [settings.gateway] Attach to the Discord gateway when available (default true).
   * @param {string} [settings.guildId] Home Discord server, whose display name IdleRPG prefers.
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
      roles: Object.assign(recruiting.requirements(recruiting.load()), checkin.requirements(checkin.load()), welcome.requirements(welcome.load())),
      operations: null,
      gateway: true,
      guildId: null
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.doorman = null;
    this.scripts = null;
    this.campaigns = null;
    this._activity = null;
    this._narrowers = [];
    this._alliance = null;
    this._requirements = { [OFFICER]: (session) => this.represents(session) };
    this.adapter = null;
    this.discord = null;
    this.gateway = { status: 'disabled', error: null };
    this._listeners = {};
    this._memberLists = new Map();
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
    const Campaigns = settings.Campaigns || loadCampaigns();
    return settings.enabled !== false && !!(settings.campaigns && settings.campaigns.enabled === true) &&
      !!(Campaigns && Campaigns.PREVIEW_APPROVALS === true);
  }

  /**
   * Discord user ids who may actually send campaign DMs, or `null` when
   * sends are unrestricted (tests that omit `campaigns.senders`). An empty
   * list sends none.
   * @param {Object} [settings]
   * @returns {Array<string>|null}
   */
  static campaignSenders (settings = {}) {
    const raw = settings.campaigns && settings.campaigns.senders;
    if (raw == null) return null;
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    return list.map((value) => {
      const id = String(value || '').trim();
      return id.startsWith('discord:') ? id.slice('discord:'.length) : id;
    }).filter(Boolean);
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
      }, { whispers: true });
      this.scripts.on('error', (error) => this.emit('error', 'community scripts', errorMessage(error)));
      this.scripts.on('warning', (warning) => this.emit('log', 'GOON.VC', `community: ${errorMessage(warning)}`));
      this.scripts.source('discord.guild.textChannels', (scope) => this.channels(scope.context, TEXT_CHANNELS));
      this.scripts.source('discord.guild.voiceChannels', (scope) => this.channels(scope.context, VOICE_CHANNELS));
      this.scripts.source('discord.guild.categories', (scope) => this.categories(scope.context));
      this.scripts.source('discord.guild.roles', (scope) => this.roles(scope.context));
      for (const entry of allianceChannels.CHANNELS) {
        this.scripts.source(`permafleet.channels.${entry.kind}`, (scope) => this.channelChoices(scope.context, entry));
      }
      this.scripts.source('goon.features', (scope) => this.features(scope.context));
      this.scripts.source('permafleet.orgs', (scope) => this.orgChoices(scope.context));
      this.scripts.source('permafleet.council.access', (scope) => this.councilAccessChoices(scope.context));
      this.scripts.source('permafleet.roles.prospects', (scope) => this.prospectChoices(scope.context));
      this.scripts.action('permafleet.channel', (session, entry) => this.createChannel(session, entry));
      this.scripts.action('permafleet.org', (session) => this.confirmOrg(session));
      this.scripts.action('permafleet.roles', (session) => this.createRoles(session));
      this.scripts.action('permafleet.setup', (session) => this.setupPermafleet(session));
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
        requirePreview: true,
        persistent: true,
        verbosity: 1
      }).filter(([, value]) => value !== undefined)), { whispers: true });
      this.campaigns.on('error', (error) => this.emit('error', 'community campaigns', errorMessage(error)));
      this.campaigns.on('warning', (warning) => this.emit('log', 'GOON.VC', `community: ${errorMessage(warning)}`));
      this.campaigns.audience('discord', (filter, campaign) => this.discordAudience(filter, campaign));
      if (this._activity) this.campaigns.activity(this._activity);
      if (Community.campaignSenders(this.settings)) {
        const schedule = this.campaigns.schedule.bind(this.campaigns);
        this.campaigns.schedule = async (id, options = {}) => {
          this.assertCampaignSender(options.discord);
          return schedule(id, options);
        };
      }
    } else if (campaignSettings.enabled === true && this.settings.enabled !== false) {
      this.emit('log', 'GOON.VC', 'community: this @fabric/doorman has no Campaigns plugin that locks sends to a preview; campaigns are off (`npm run link:doorman` uses ../doorman)');
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
   * {@link Community#ready} before using its Store. Its private messages
   * are dropped unless `whispers` (only the Scripts and Campaigns plugins).
   * @param {Function} Plugin
   * @param {Object} [settings]
   * @param {Object} [options]
   * @param {boolean} [options.whispers=false] Let the plugin send DMs.
   * @returns {Object} the plugin instance
   */
  plug (Plugin, settings = {}, { whispers = false } = {}) {
    const name = String(Plugin.pluginName || Plugin.name).toLowerCase();
    this.doorman.use(Plugin, settings);
    const plugin = this.doorman.plugins[name];
    // DMs go out only from scripts someone started and campaigns someone previewed and sent.
    if (!whispers && plugin && typeof plugin.removeAllListeners === 'function') plugin.removeAllListeners('whisper');
    return plugin;
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
    this.adapter = new DoormanDiscord({ client: discord, replies: false, whispers: !!(this.scripts || this.campaigns), guildId: this.settings.guildId || null });
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
    Object.assign(context, this.guildContext(context.guildId, channel, {
      roles: scriptId === ROLE_SCRIPT,
      setup: scriptId === 'goon-setup'
    }));
    if (COMPLIANCE_SCRIPTS.has(scriptId)) {
      Object.assign(context, this.compliance(context.guildId, channel || (scriptId === ROLE_SCRIPT ? allianceRoles.SCRIPT : null)));
      Object.assign(context, await this.officerContext(userOf(options), context.guildId));
    }
    return this.scripts.begin(scriptId, Object.assign({}, options, { context }));
  }

  /**
   * Who may act for which PERMAFLEET member org. Without these hooks nobody
   * can: PERMAFLEET setup and the channel and rank scripts refuse everyone.
   * @param {Object|null} hooks
   * @param {Function} hooks.representing `(accountKey) => [{ symbol, name, officer }]` (Alliance#representing).
   * @param {Function} hooks.representatives `(symbol) => [{ name, discord, officer }]` (Alliance#representatives).
   * @returns {Community}
   */
  alliance (hooks) {
    this._alliance = hooks || null;
    return this;
  }

  /**
   * The member orgs a Discord user is an officer of on the alliance roster:
   * their Discord account, or another account linked to the same goon.vc
   * member, is in the org's `officers`. Discord roles don't count.
   * @param {string} userId
   * @returns {Promise<Array<{ symbol: string, name: string }>>}
   */
  async representing (userId) {
    const hooks = this._alliance;
    if (!userId || !hooks || typeof hooks.representing !== 'function') return [];
    const orgs = [].concat((await hooks.representing(`discord:${userId}`).catch(() => [])) || []);
    return orgs.filter((org) => org && org.officer === true).map((org) => ({ symbol: org.symbol, name: org.name || org.symbol }));
  }

  /**
   * The `PERMAFLEET org officer` requirement, checked at start and before
   * anything is recorded or changed.
   * @param {Object} session `{ user }`
   * @returns {Promise<true>} throws a refusal that says how to get on record
   */
  async represents (session) {
    if ((await this.representing(userOf(session))).length) return true;
    throw refusal(this._notOfficer());
  }

  _notOfficer () {
    return 'Only the officers PERMAFLEET leadership has on record can act for a member org, and your Discord account isn’t one of them. ' +
      'If you are an officer of a member org, ask in #embassy on the G00N SQUAD Discord to be put on record.';
  }

  /**
   * An org's officers on record (several orgs: everyone, once), named by
   * goon.vc profile or, failing that, as this server shows them.
   * @param {Array<string>} symbols
   * @param {Object|null} guild
   * @returns {Promise<Array<{ name: string|null, discord: string[] }>>}
   */
  async _officers (symbols, guild) {
    const hooks = this._alliance;
    if (!hooks || typeof hooks.representatives !== 'function') return [];
    const people = [];
    const seen = new Set();
    for (const symbol of symbols) {
      for (const person of (await hooks.representatives(symbol).catch(() => [])) || []) {
        if (!person || person.officer !== true) continue;
        const discord = [].concat(person.discord || []).map(String);
        const key = discord.length ? discord.join(',') : `${symbol}:${person.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const cache = guild && guild.members && guild.members.cache;
        const cached = cache && typeof cache.get === 'function' ? discord.map((id) => cache.get(id)).find(Boolean) : null;
        people.push({ name: person.name || (cached && cached.displayName) || null, discord });
      }
    }
    return people;
  }

  /**
   * What PERMAFLEET scripts show about the caller: the orgs they may act for
   * with each org's officers on record, or why PERMAFLEET is not offered to
   * them. Names only, never ids.
   * @param {string} userId
   * @param {string} guildId
   * @returns {Promise<Object>}
   */
  async officerContext (userId, guildId) {
    const orgs = await this.representing(userId);
    if (!orgs.length) return { permafleetOrgs: [], permafleetNote: `\n\nPERMAFLEET membership isn’t offered here. ${this._notOfficer()}` };
    const guild = this._guild(guildId);
    const permafleetOrgs = [];
    for (const org of orgs) {
      permafleetOrgs.push({ symbol: org.symbol, name: org.name, onRecord: officerList(await this._officers([org.symbol], guild)) });
    }
    return {
      permafleetOrgs,
      permafleetOrgNames: permafleetOrgs.map((org) => org.name).join(', '),
      permafleetRecord: permafleetOrgs.map((org) => `- **${org.name}**: ${org.onRecord || 'nobody yet'}`).join('\n'),
      permafleetOfficers: officerList(await this._officers(orgs.map((org) => org.symbol), guild))
    };
  }

  /**
   * The server's PERMAFLEET checklist, read when a script starts so it is
   * shown (and recorded with the answers) before anything changes. For a
   * channel script, also a line on that script's own item.
   * @param {string} guildId
   * @param {Object} [channel] Channel spec (functions/allianceChannels.js), or the roles script (functions/allianceRoles.js SCRIPT).
   * @returns {{ compliance?: string, complianceChecks?: Array<Object>, complianceFocus?: string }}
   */
  compliance (guildId, channel = null) {
    const guild = this._guild(guildId);
    if (!guild) return {};
    const report = allianceCompliance.check(guild);
    const context = {
      compliance: allianceCompliance.render(report),
      complianceChecks: report.checks.map(({ id, required, ok, detail }) => ({ id, required, ok, detail }))
    };
    if (channel === allianceRoles.SCRIPT) {
      context.complianceFocus = `This walkthrough takes care of ${channel.label}.`;
    } else if (channel) {
      const own = report.checks.find((entry) => entry.id === channel.kind);
      context.complianceFocus = own && own.ok
        ? `${channel.label} already checks out (${own.detail}). Continue to point it at a different channel, or Cancel to leave it.`
        : `This walkthrough takes care of ${channel.label}.`;
    }
    return context;
  }

  /**
   * What scripts may show about a guild: the invite link and the guild-wide
   * permissions the bot is missing (names, never ids). For a PERMAFLEET
   * channel script, also what the bot lacks to create that channel and the
   * invite that grants it.
   * For the roles script, what it lacks to make roles; for goon-setup, what
   * it lacks to set up PERMAFLEET from scratch.
   * @param {string} guildId
   * @param {Object} [channel] Channel spec (functions/allianceChannels.js).
   * @param {Object} [options]
   * @param {boolean} [options.roles] Add `rolesMissing` and `prospectsMissing`.
   * @param {boolean} [options.setup] Add `setupMissing`.
   * @returns {{ siteUrl: string, inviteUrl: string, botMissing: string, channelMissing?: string, rolesMissing?: string, setupMissing?: string, channelInviteUrl?: string }}
   */
  guildContext (guildId, channel = null, options = {}) {
    const siteUrl = String(this.settings.siteUrl || '').replace(/\/+$/, '');
    const guild = this._guild(guildId);
    const me = guild && guild.members ? guild.members.me : null;
    const lacking = (names) => (me ? names.filter((name) => !has(me.permissions, PERMISSIONS[name])) : [])
      .map((name) => PERMISSION_NAMES[name]).join(', ');
    const context = {
      siteUrl,
      inviteUrl: `${siteUrl}/services/discord/invite`,
      botMissing: lacking(BOT_NEEDS)
    };
    if (channel) context.channelMissing = lacking(allianceChannels.needs(channel));
    if (options.roles) {
      context.rolesMissing = lacking(['ManageRoles']);
      context.prospectsMissing = guild ? allianceRoles.describeProspects(allianceRoles.missingProspects(guild)) : '';
    }
    if (options.setup) context.setupMissing = lacking(allianceChannels.setupNeeds());
    if (channel || options.roles || options.setup) context.channelInviteUrl = `${context.inviteUrl}?for=channels`;
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
    const home = allianceChannels.homeChannelId(channel.kind, context && context.guildId);
    const likely = (option) => option.id === home ||
      allianceChannels.normalize(option.label) === allianceChannels.normalize(channel.name);
    return [
      { id: NEW_CHANNEL, label: `Create ${channel.label} (recommended)`, description: 'goon.vc’s bot makes it the same way on every member org’s Discord' },
      ...existing.filter(likely),
      ...existing.filter((option) => !likely(option))
    ];
  }

  /**
   * `goon.features` choices: PERMAFLEET membership only for the officers on
   * record ({@link Community#officerContext}).
   * @param {Object} [context]
   * @returns {Array<Object>}
   */
  features (context = {}) {
    const officer = Array.isArray(context && context.permafleetOrgs) && context.permafleetOrgs.length > 0;
    return this.settings.features.filter((feature) => feature.id !== 'permafleet' || officer);
  }

  /**
   * `permafleet.orgs` choices: the member orgs the caller may act for, each
   * with its officers on record.
   * @param {Object} [context]
   * @returns {Array<{ id: string, label: string, description: string }>}
   */
  orgChoices (context = {}) {
    return ((context && context.permafleetOrgs) || []).map((org) => ({
      id: org.symbol,
      label: org.name && org.name !== org.symbol ? `${org.name} [${org.symbol}]` : org.symbol,
      description: org.onRecord ? `Officers on record: ${org.onRecord}` : 'Nobody on record yet'
    }));
  }

  /**
   * Who may see #council: the org's officers on record themselves (no role
   * is made or given), then the server's own roles.
   * @param {Object} context `{ guildId }`
   * @returns {Array<{ id: string, label: string, description: string|null }>}
   */
  councilAccessChoices (context) {
    return [
      { id: OFFICERS_ACCESS, label: 'Our officers on record (recommended)', description: 'Each officer PERMAFLEET leadership has on record who is on this server' },
      ...this.roles(context)
    ];
  }

  /**
   * Choices for the Prospect ranks: add the ones the server lacks, or keep its own.
   * @param {Object} context `{ guildId }`
   * @returns {Array<{ id: string, label: string, description: string|null }>}
   */
  prospectChoices (context) {
    const guild = this._guild(context && context.guildId);
    const missing = guild ? allianceRoles.missingProspects(guild) : allianceRoles.PROSPECTS;
    return [
      {
        id: NEW_ROLE,
        label: 'Create the Prospect ranks (recommended)',
        description: missing.length ? `Adds ${allianceRoles.describeProspects(missing)}; yours stay as they are` : 'You have all six already; nothing to add'
      },
      { id: KEEP_ROLES, label: 'Keep ours as they are', description: null }
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

    this._assertBot(guild, allianceChannels.needs(channel), `make ${channel.label}`, again);
    const picked = [].concat(answers.roles || []).map(String);
    const roleCache = guild.roles && guild.roles.cache;
    const roles = picked.filter((id) => id !== OFFICERS_ACCESS && roleCache && roleCache.has(id));
    const reason = `PERMAFLEET ${channel.label}, set up by ${session.name || 'a server admin'} with /goon ${channel.subcommand}`;
    const notes = [];
    let members = [];
    if (channel.access === 'roles' && picked.includes(OFFICERS_ACCESS)) {
      const orgs = (await this.representing(userOf(session))).map((org) => org.symbol);
      members = await this._officerMembers(guild, orgs, notes);
    }
    if (channel.access === 'roles' && !roles.length && !members.length) {
      throw exposed(`None of the roles or officers you picked are on **${guild.name}** right now. ${again}`);
    }
    const category = answers.category ? guild.channels.cache.get(String(answers.category)) : null;

    let created;
    try {
      created = await this._makeChannel(guild, channel, { roles, members, category, reason });
    } catch (error) {
      throw exposed(`Discord didn’t let me make ${channel.label}: ${errorMessage(error)}. ${again}`);
    }
    const result = this._channelResult(created, true);
    if (notes.length) result.labels.result = `${result.labels.result} ${notes.join(' ')}`;
    return result;
  }

  _channelResult (channel, created) {
    const mention = `<#${channel.id}>`;
    return {
      answers: { channelId: String(channel.id), created },
      labels: { result: created ? `Created ${mention}.` : `Using ${mention}; I left its permissions as they are.` }
    };
  }

  async _makeChannel (guild, channel, { roles = [], members = [], category = null, reason }) {
    const me = guild.members ? guild.members.me : null;
    const client = this.discord && this.discord.client;
    const bot = (me && me.id) || (client && client.user && client.user.id) || null;
    const created = await guild.channels.create(Object.assign({
      name: channel.name,
      type: channel.type,
      permissionOverwrites: allianceChannels.overwrites(channel, { everyone: guild.id, bot, roles, members }),
      reason
    }, channel.topic ? { topic: channel.topic } : {}, category && category.type === CATEGORY ? { parent: category.id } : {}));
    this.emit('log', 'GOON.VC', `community: created ${channel.label} on ${guild.name}`);
    return created;
  }

  // Refuse up front, with the invite that grants them, when the bot lacks permissions for a change.
  _assertBot (guild, names, what, again) {
    const me = guild.members ? guild.members.me : null;
    const missing = [...new Set(names)].filter((name) => !has(me && me.permissions, PERMISSIONS[name]));
    if (!missing.length) return;
    const { channelInviteUrl } = this.guildContext(guild.id, null, { setup: true });
    throw exposed(`To ${what}, goon.vc’s bot needs ${missing.map((name) => PERMISSION_NAMES[name]).join(', ')} on **${guild.name}**. Grant them here: ${channelInviteUrl}\nThen ${lowerFirst(again)}`);
  }

  /**
   * The Discord user ids of the orgs' officers on record who are on this
   * server, found by the Discord accounts linked to them, for opening
   * #council to them by name (no role is made or given). Notes who it opens
   * to and who isn't on the server.
   * @returns {Promise<Array<string>>}
   */
  async _officerMembers (guild, symbols, notes) {
    const people = await this._officers(symbols, guild);
    const ids = [];
    const here = [];
    const away = [];
    for (const person of people) {
      let member = null;
      for (const id of person.discord) {
        member = guild.members && typeof guild.members.fetch === 'function'
          ? await guild.members.fetch({ user: id }).catch(() => null)
          : null;
        if (member) {
          ids.push(String(id));
          break;
        }
      }
      const name = person.name || (member && member.displayName) || 'someone not on goon.vc yet';
      (member ? here : away).push(name);
    }
    if (!people.length) notes.push('Nobody is on record as an officer of your org yet; PERMAFLEET leadership adds them.');
    if (here.length) notes.push(`Opened #council to your officers on record: ${here.join(', ')}.`);
    if (away.length) notes.push(`Not on this server: ${away.join(', ')}; add them to #council once they join.`);
    return ids;
  }

  // Make the Prospect ranks the server lacks; returns the names created.
  async _prospects (guild, reason, notes) {
    const missing = allianceRoles.missingProspects(guild);
    if (!missing.length) {
      notes.push('You have every Prospect rank already.');
      return [];
    }
    const created = [];
    // A new role lands at the bottom of the list, so the highest rank goes first.
    for (const entry of missing.slice().reverse()) {
      try {
        await guild.roles.create({ name: entry.name, permissions: 0n, reason });
        created.unshift(entry.name);
      } catch (error) {
        notes.push(`Discord didn’t let me make ${entry.name}: ${errorMessage(error)}.`);
      }
    }
    if (created.length) {
      notes.push(`Created ${created.join(', ')}.`);
      this.emit('log', 'GOON.VC', `community: created ${created.length} Prospect ranks on ${guild.name}`);
    }
    return created;
  }

  /**
   * `permafleet.org` action (goon-setup): check again that the caller is an
   * officer on record of the org they picked, and note who is on record.
   * @param {Object} session
   * @returns {Promise<Object|null>}
   */
  async confirmOrg (session) {
    const symbol = session.answers && session.answers.org;
    if (!symbol) return null;
    const org = (await this.representing(userOf(session))).find((entry) => entry.symbol === symbol);
    if (!org) throw exposed(`${this._notOfficer()} Nothing was saved.`);
    const people = await this._officers([org.symbol], this._guild(session.context && session.context.guildId));
    return {
      answers: { officers: people.map((person) => person.name).filter(Boolean) },
      labels: { permafleet: `\n\nOfficers on record for ${org.name}: ${officerList(people) || 'nobody yet'}.` }
    };
  }

  /**
   * `permafleet.roles` action (`/goon roles`): the Prospect ranks the server lacks.
   * @param {Object} session
   * @returns {Promise<{ answers: Object, labels: { result: string } }>}
   */
  async createRoles (session) {
    const again = `Run \`/goon ${allianceRoles.SCRIPT.subcommand}\` in your server to try again.`;
    const guild = this._guild(session.context && session.context.guildId);
    if (!guild || !guild.roles || !guild.roles.cache) throw exposed(`I can’t reach that server right now. ${again}`);
    const answers = session.answers || {};
    if (answers.prospects !== NEW_ROLE) {
      return { answers: { prospectsCreated: [] }, labels: { result: 'I left your Prospect ranks as they are.' } };
    }
    this._assertBot(guild, ['ManageRoles'], `set up ${allianceRoles.SCRIPT.label}`, again);
    const reason = `PERMAFLEET Prospect ranks, set up by ${session.name || 'a server admin'} with /goon ${allianceRoles.SCRIPT.subcommand}`;
    const notes = [];
    const prospects = await this._prospects(guild, reason, notes);
    return {
      answers: { prospectsCreated: prospects },
      labels: { result: notes.join('\n') }
    };
  }

  /**
   * `permafleet.setup` action (goon-setup, "Set it all up"): every channel
   * and rank a member org keeps, the same way on every server, with #council
   * open to the org's officers on record. What the server already has by
   * those names is kept as it is.
   * @param {Object} session
   * @returns {Promise<Object|null>}
   */
  async setupPermafleet (session) {
    const answers = session.answers || {};
    if (answers.build !== BUILD_ALL || !answers.org) return null;
    const again = 'Run `/goon setup` in your server to try again.';
    const guild = this._guild(session.context && session.context.guildId);
    if (!guild || !guild.channels || !guild.channels.cache || !guild.roles || !guild.roles.cache) {
      throw exposed(`I can’t reach that server right now. ${again}`);
    }
    this._assertBot(guild, allianceChannels.setupNeeds(), 'set up PERMAFLEET', again);
    const reason = `PERMAFLEET setup by ${session.name || 'a server admin'} with /goon setup`;
    const notes = [];
    await this._prospects(guild, reason, notes);

    const channels = {};
    const created = [];
    const kept = [];
    let category;
    for (const kind of SETUP_CHANNELS) {
      const channel = allianceChannels.spec(kind);
      const existing = [...guild.channels.cache.values()].find((candidate) => allianceChannels.matches(channel, candidate));
      if (existing) {
        channels[kind] = String(existing.id);
        kept.push(`<#${existing.id}>`);
        continue;
      }
      const members = channel.access === 'roles' ? await this._officerMembers(guild, [answers.org], notes) : [];
      if (channel.access === 'roles' && !members.length) {
        notes.push(`Skipped ${channel.label}: none of your officers on record is on this server. \`/goon ${channel.subcommand}\` sets it up.`);
        continue;
      }
      if (category === undefined) category = await this._setupCategory(guild, reason);
      try {
        const made = await this._makeChannel(guild, channel, { members, category, reason });
        channels[kind] = String(made.id);
        created.push(`<#${made.id}>`);
      } catch (error) {
        notes.push(`Discord didn’t let me make ${channel.label}: ${errorMessage(error)}.`);
      }
    }
    if (created.length) notes.push(`Created ${created.join(', ')}${category ? ` under ${category.name}` : ''}.`);
    if (kept.length) notes.push(`Kept ${kept.join(', ')}, which you already had, as they are.`);
    return {
      answers: { setup: { channels } },
      labels: { permafleet: `${(session.labels && session.labels.permafleet) || ''}\n${notes.join('\n')}` }
    };
  }

  // The PERMAFLEET category for new channels: the server's own by that name, else a new one (null when Discord refuses).
  async _setupCategory (guild, reason) {
    const existing = [...guild.channels.cache.values()]
      .find((channel) => channel.type === CATEGORY && allianceChannels.normalize(channel.name) === allianceChannels.normalize(SETUP_CATEGORY));
    if (existing) return existing;
    try {
      return await guild.channels.create({ name: SETUP_CATEGORY, type: CATEGORY, reason });
    } catch (_) {
      return null;
    }
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
   * Narrow every campaign's Discord audience further (check-ins drop members
   * a tier already reached; welcomes keep members who joined in the window).
   * @param {Function} fn `(people, campaign) => people` (may be async); each person is
   * `{ target, name, source, sourceName, joinedAt? }` (`joinedAt` ms, when Discord says);
   * `campaign` is `{ id, title, owner, content, filter }`.
   * @returns {Community}
   */
  narrow (fn) {
    this._narrowers.push(fn);
    return this;
  }

  /**
   * Campaign audience on Discord: members (no bots) of every server the bot
   * is in, narrowed to `filter.guilds` (a server's own campaign only ever
   * reaches that server), holding any of `filter.roles` (everyone when
   * empty) and none of `filter.excludeRoles`, and not in any of
   * `filter.excludeGuilds`. Members are listed from Discord (Server Members
   * intent); a successful listing is reused for a few minutes so Send after
   * preview does not ask Discord again.
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
        const person = {
          target: `discord/users/${id}`,
          name: audienceName(member, user),
          source: String(guild.id),
          sourceName: guild.name
        };
        if (Number.isFinite(member.joinedTimestamp)) person.joinedAt = member.joinedTimestamp;
        people.push(person);
      }
    }
    let narrowed = people;
    for (const fn of this._narrowers) narrowed = await fn(narrowed, campaign);
    return narrowed;
  }

  _cachedMembers (guild) {
    const cache = guild && guild.members && guild.members.cache;
    if (!cache) return [];
    if (typeof cache.values === 'function') return [...cache.values()];
    return [];
  }

  async _members (guild) {
    const id = String(guild.id);
    const now = Date.now();
    const remembered = this._memberLists.get(id);
    if (remembered && now - remembered.at < MEMBER_CACHE_MS) return remembered.members;

    const cached = this._cachedMembers(guild);
    try {
      if (!guild.members || typeof guild.members.fetch !== 'function') {
        if (cached.length) {
          this._memberLists.set(id, { at: now, members: cached });
          return cached;
        }
        throw new Error('no member list');
      }
      const members = await guild.members.fetch();
      const list = [...members.values()];
      this._memberLists.set(id, { at: now, members: list });
      return list;
    } catch (error) {
      const fallback = cached.length ? cached : (remembered && remembered.members.length ? remembered.members : null);
      if (fallback) {
        this.emit('error', 'community campaigns', `could not refresh the members of ${guild.name}, using the list from earlier: ${errorMessage(error)}`);
        this._memberLists.set(id, { at: now, members: fallback });
        return fallback;
      }
      this.emit('error', 'community campaigns', `could not list the members of ${guild.name}: ${errorMessage(error)}`);
      throw httpError(429, `Could not list the members of ${guild.name}. Try again in a little while.`);
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
   * A script `requires` entry that is not a guild permission or role, such
   * as "Member reviewer": `check(session)` must resolve `true` to pass. It
   * runs at start and again before the answers are recorded.
   * @param {string} name
   * @param {Function} check `(session) => boolean | Promise<boolean>`
   * @returns {Community}
   */
  requirement (name, check) {
    if (typeof check !== 'function') throw new TypeError('requirement check must be a function');
    this._requirements[String(name)] = check;
    return this;
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
   * May this Discord user actually send campaign DMs? Preview stays open to
   * server managers. Unrestricted when `campaigns.senders` is omitted.
   * @param {string} userId
   * @returns {boolean}
   */
  maySendCampaign (userId) {
    const senders = Community.campaignSenders(this.settings);
    if (senders == null) return true;
    return senders.includes(String(userId || ''));
  }

  /**
   * @param {string} userId
   * @throws {Error} 403 when this user may not send campaign DMs.
   */
  assertCampaignSender (userId) {
    if (this.maySendCampaign(userId)) return;
    throw Object.assign(new Error(CAMPAIGN_SEND_REFUSAL), { status: 403 });
  }

  /**
   * Script `requires` check: the member's current permissions or roles in the
   * guild, read fresh from Discord at start and again before answers are
   * recorded. The owner passes every permission, but holds only their roles.
   * @param {string} requirement One added with {@link Community#requirement}, a permission name (`ManageGuild`), or a name in `settings.roles` (`[P4] Prospect IV`).
   * @param {Object} session `{ user, context: { guildId } }`
   * @returns {Promise<boolean>}
   */
  async authorize (requirement, session) {
    if (Object.prototype.hasOwnProperty.call(this._requirements, requirement)) {
      try {
        return (await this._requirements[requirement](session)) === true;
      } catch (error) {
        if (error && error.refusal === true) throw error;
        return false;
      }
    }
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
    // The @everyone role's id is the server's: every member holds it.
    if (roles && roles.map(String).includes(String(guild.id))) return true;
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
      if (this.campaigns && Community.campaignSenders(this.settings) && req.method === 'POST' && CAMPAIGN_SCHEDULE.test(String(req.url || ''))) {
        res.statusCode = 403;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: CAMPAIGN_SEND_REFUSAL }));
        return;
      }
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
module.exports.CAMPAIGN_SEND_REFUSAL = CAMPAIGN_SEND_REFUSAL;
module.exports.INTENTS = INTENTS;
module.exports.PARTIALS = PARTIALS;
module.exports.CAMPAIGN_INTENTS = CAMPAIGN_INTENTS;
module.exports.CAMPAIGNS_PATH = CAMPAIGNS_PATH;
module.exports.FEATURES = FEATURES;
module.exports.NEW_CHANNEL = NEW_CHANNEL;
module.exports.NEW_ROLE = NEW_ROLE;
module.exports.OFFICER = OFFICER;
module.exports.PERMISSIONS = PERMISSIONS;
module.exports.SCRIPTS_PATH = SCRIPTS_PATH;
