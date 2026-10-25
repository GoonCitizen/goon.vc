'use strict';

const { OPEN_LEAGUE_ID } = require('./leagues');
const allianceChannels = require('../functions/allianceChannels');

const EPHEMERAL = 64;
const CHAT_INPUT = 1;
const OPTION = { subcommand: 1, string: 3, integer: 4, user: 6, role: 8 };
const GUILD_CONTEXT = 0;
const GUILD_INSTALL = 0;
const MAX_WINS = 5;
const NOTE_LENGTH = 140;
const ACTION_ROW = 1;
const BUTTON_COMPONENT = 2;
const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4 };
const BUTTON = /^1v1:(confirm|decline):([0-9a-f]{12})$/;
const CAMPAIGN_BUTTON = /^campaign:(send|schedule|cancel):([0-9a-f]{12})(?::(\d{1,12}))?$/;
const DISCORD_MEMBER = 'discord:';
const MANAGE_GUILD = 1n << 5n;
const DM_CLOSED = 50007;
const SETUP_SCRIPT = 'goon-setup';
const CAMPAIGN_TEXT = 1800;
const MAX_CHOICES = 25;
const RELATIVE_TIME = /^in\s+(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i;
const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const MAX_SCHEDULE_MS = 30 * UNIT_MS.d;

/** Every set score a league accepts (best of 1 to 9), winner first. */
function scoreChoices () {
  const choices = [];
  for (let won = 1; won <= MAX_WINS; won++) {
    for (let lost = 0; lost < won; lost++) {
      choices.push({ name: `${won}–${lost} (best of ${2 * won - 1})`, value: `${won}-${lost}` });
    }
  }
  return choices;
}

const DEFINITIONS = [
  {
    name: 'idlerpg',
    description: 'The alliance idle game: time in voice earns XP.',
    type: CHAT_INPUT,
    contexts: [GUILD_CONTEXT],
    integration_types: [GUILD_INSTALL],
    options: [
      {
        type: OPTION.subcommand,
        name: 'profile',
        description: 'Your standing in IdleRPG, or another pilot’s.',
        options: [{ type: OPTION.user, name: 'pilot', description: 'Whose profile (default: yours)' }]
      },
      { type: OPTION.subcommand, name: 'leaderboard', description: 'The top ten pilots.' },
      { type: OPTION.subcommand, name: 'stats', description: 'Alliance-wide numbers: who is present, hours, battles.' }
    ]
  },
  {
    name: '1v1',
    description: 'Report a 1v1 duel you fought; your opponent confirms it (Open League by default).',
    type: CHAT_INPUT,
    contexts: [GUILD_CONTEXT],
    integration_types: [GUILD_INSTALL],
    options: [
      { type: OPTION.user, name: 'winner', description: 'Who won the set', required: true },
      { type: OPTION.user, name: 'loser', description: 'Who lost the set', required: true },
      { type: OPTION.string, name: 'score', description: 'Set score, winner first', required: true, choices: scoreChoices() },
      { type: OPTION.string, name: 'league', description: 'League (default: Open League)', autocomplete: true },
      { type: OPTION.string, name: 'note', description: 'Ship, location, anything worth keeping', max_length: NOTE_LENGTH }
    ]
  },
  {
    name: 'goon',
    description: 'Connect this server to goon.vc.',
    type: CHAT_INPUT,
    contexts: [GUILD_CONTEXT],
    integration_types: [GUILD_INSTALL],
    default_member_permissions: String(MANAGE_GUILD),
    options: [
      { type: OPTION.subcommand, name: 'setup', description: 'Walk through connecting this server to goon.vc, in your DMs.' },
      ...allianceChannels.CHANNELS.map((channel) => ({
        type: OPTION.subcommand,
        name: channel.subcommand,
        description: `Set up the ${channel.label} channel every PERMAFLEET member org keeps, in your DMs.`
      })),
      {
        type: OPTION.subcommand,
        name: 'campaign',
        description: 'DM a message to this server’s members; you see who it reaches before it goes out.',
        options: [
          { type: OPTION.string, name: 'message', description: 'What to send', required: true, max_length: CAMPAIGN_TEXT },
          { type: OPTION.role, name: 'role', description: 'Only members with this role (default: everyone)' },
          { type: OPTION.role, name: 'exclude_role', description: 'Skip members with this role' },
          { type: OPTION.integer, name: 'active_days', description: 'Only members seen in voice within this many days', min_value: 1, max_value: 365 },
          { type: OPTION.string, name: 'script', description: 'Offer a guided conversation behind a Start button', autocomplete: true },
          { type: OPTION.string, name: 'send_at', description: 'When to send: "in 2 hours" or 2026-11-01T18:00Z (default: when you press Send)' }
        ]
      }
    ]
  },
  {
    name: 'vote',
    description: 'Have your say on a PERMAFLEET alliance proposal (advisory; member orgs decide).',
    type: CHAT_INPUT,
    contexts: [GUILD_CONTEXT],
    integration_types: [GUILD_INSTALL],
    options: [
      { type: OPTION.string, name: 'proposal', description: 'Which proposal', required: true, autocomplete: true },
      {
        type: OPTION.string,
        name: 'choice',
        description: 'Your vote',
        required: true,
        choices: [{ name: 'Yes', value: 'yes' }, { name: 'No', value: 'no' }, { name: 'Abstain', value: 'abstain' }]
      }
    ]
  }
];
const COMMAND_NAMES = DEFINITIONS.map((definition) => definition.name);

/**
 * When a campaign should go out: "in 2 hours", a date, or nothing (now).
 * @param {string|null} text
 * @param {number} now
 * @returns {number|null} epoch ms, or null for now
 */
function parseSendAt (text, now) {
  const value = String(text || '').trim();
  if (!value || /^now$/i.test(value)) return null;
  const relative = RELATIVE_TIME.exec(value);
  const at = relative ? now + Number(relative[1]) * UNIT_MS[relative[2][0].toLowerCase()] : Date.parse(value);
  if (!Number.isFinite(at)) throw Object.assign(new Error('I couldn’t read `send_at`. Use something like "in 2 hours" or 2026-11-01T18:00Z.'), { status: 400 });
  if (at <= now) return null;
  if (at - now > MAX_SCHEDULE_MS) throw Object.assign(new Error('Campaigns can be scheduled up to 30 days ahead.'), { status: 400 });
  return at;
}

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

function escapeMarkdown (value) {
  return String(value).replace(/[\\*_~`|>[\]]/g, '\\$&');
}

function number (value) {
  return Number(value || 0).toLocaleString('en-US');
}

function plural (count, word) {
  return `${number(count)} ${word}${count === 1 ? '' : 's'}`;
}

/**
 * Server display name: nickname, then global display name, then username.
 * @param {Object} [member] GuildMember, or the raw API member when uncached.
 * @param {Object} [user]
 * @returns {string|null}
 */
function displayName (member, user) {
  const name = (member && (member.displayName || member.nick)) ||
    (user && (user.globalName || user.global_name || user.username));
  return name ? String(name).trim() || null : null;
}

function hasPermission (permissions, bit) {
  if (!permissions) return false;
  if (typeof permissions.has === 'function') return permissions.has(bit);
  try { return (BigInt(permissions) & bit) === bit; } catch (_) { return false; }
}

/**
 * Discord application commands for goon.vc: `/idlerpg` (the IdleRPG game's
 * public numbers), `/1v1` (a player reports a duel; the other confirms it
 * on the card's buttons), `/goon setup` (a server admin is walked through
 * connecting their server in DMs by services/community.js), `/goon council`,
 * `embassy`, `permafleet`, and `voice` (the same, setting up that PERMAFLEET
 * channel on their server), and `/goon campaign` (a server admin DMs a message to their members after a private
 * preview, through Community's Campaigns), and `/vote` (any member's advisory
 * vote on an alliance proposal, through {@link Alliance#memberVote}). They ride the one gateway client {@link Operations}
 * runs; interactions need no intents. The application is shared with other
 * services, so only these commands are registered (upserted by name, global,
 * servers only) and nothing else is touched. Players are found by their
 * Discord account (its goon.vc member), not by name. Replies carry display
 * names only and ping no one but the player asked to confirm.
 */
class Commands {
  /**
   * @param {Object} [settings]
   * @param {Object} [settings.operations] Operations service (or any emitter with `gateway` / `discord`).
   * @param {Object} [settings.presence] Presence service (IdleRPG).
   * @param {Object} [settings.community] Community service (DM scripts for `/goon setup`).
   * @param {Object} [settings.leagues] Leagues service.
   * @param {Object} [settings.members] Members service (goon.vc profiles Discord users are linked to).
   * @param {Object|Function} [settings.alliance] Alliance service, or a function returning it (it starts later).
   * @param {string} [settings.league] League `/1v1` logs to by default.
   * @param {string} [settings.siteUrl] Absolute site origin for links.
   * @param {string} [settings.idlerpgPath]
   * @param {string} [settings.leaguesPath]
   * @param {boolean} [settings.register] Register the commands with Discord on ready (default true).
   * @param {Function} [settings.now] Clock (tests).
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      operations: null,
      presence: null,
      community: null,
      leagues: null,
      members: null,
      alliance: null,
      league: OPEN_LEAGUE_ID,
      siteUrl: 'https://goon.vc',
      idlerpgPath: '/services/idlerpg',
      leaguesPath: '/leagues',
      register: true,
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.discord = null;
    this.client = null;
    this._campaignAuthors = new Map();
    this._listeners = {};
    this._onGateway = (discord) => this.attach(discord);
    this._onInteraction = (interaction) => {
      this.handle(interaction).catch((error) => this.emit('error', 'commands', errorMessage(error)));
    };
  }

  on (event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  emit (event, ...args) {
    for (const handler of this._listeners[event] || []) {
      try { handler(...args); } catch (_) { /* listener errors stay local */ }
    }
    return this;
  }

  /**
   * Command definitions, as Discord API JSON: `/goon setup` and the
   * PERMAFLEET channel subcommands only while DM scripts run, `/goon
   * campaign` only while campaigns run, and no `/goon` without either.
   */
  get definitions () {
    const community = this.settings.community;
    const scripts = !!(community && community.scripts);
    const running = { setup: scripts, campaign: !!(community && community.campaigns) };
    for (const channel of allianceChannels.CHANNELS) running[channel.subcommand] = scripts;
    return DEFINITIONS.map((definition) => {
      if (definition.name !== 'goon') return definition;
      const options = definition.options.filter((option) => running[option.name]);
      return options.length ? Object.assign({}, definition, { options }) : null;
    }).filter(Boolean);
  }

  async start () {
    const operations = this.settings.operations;
    if (operations) {
      if (operations.discord) this.attach(operations.discord);
      else if (typeof operations.on === 'function') operations.on('gateway', this._onGateway);
    }
    return this;
  }

  async stop () {
    const operations = this.settings.operations;
    if (operations && typeof operations.removeListener === 'function') operations.removeListener('gateway', this._onGateway);
    if (this.client) this.client.removeListener('interactionCreate', this._onInteraction);
    this.client = null;
    return this;
  }

  /**
   * Answer interactions arriving on an `@fabric/discord` client the process already runs.
   * @param {Object} discord
   * @returns {Commands}
   */
  attach (discord) {
    if (!discord || !discord.client || this.client) return this;
    this.discord = discord;
    this.client = discord.client;
    this.client.on('interactionCreate', this._onInteraction);
    if (this.settings.register !== false) {
      const register = () => this.register().catch((error) => this.emit('error', 'commands register', errorMessage(error)));
      if (discord.botReady) register();
      else if (typeof discord.once === 'function') discord.once('ready', register);
    }
    return this;
  }

  /**
   * Create or update this service's global commands, leaving the
   * application's other commands alone. Unchanged commands are skipped.
   * @returns {Promise<string[]>} names created or updated
   */
  async register () {
    const application = this.client && this.client.application;
    if (!application || !application.commands) return [];
    const existing = [...(await application.commands.fetch()).values()];
    const changed = [];
    for (const definition of this.definitions) {
      const current = existing.find((command) => command.name === definition.name);
      if (current && current.equals(definition)) continue;
      await application.commands.create({ toJSON: () => definition });
      changed.push(definition.name);
    }
    if (changed.length) this.emit('log', 'GOON.VC', `commands: registered /${changed.join(', /')}`);
    return changed;
  }

  /**
   * Route one interaction.
   * @param {Object} interaction discord.js Interaction
   * @returns {Promise<void>}
   */
  async handle (interaction) {
    if (!interaction) return;
    if (typeof interaction.isAutocomplete === 'function' && interaction.isAutocomplete()) {
      if (interaction.commandName === '1v1') await interaction.respond(await this.leagueChoices(interaction.options.getFocused()));
      else if (interaction.commandName === 'goon') await interaction.respond(this.scriptChoices(interaction.options.getFocused()));
      else if (interaction.commandName === 'vote') await interaction.respond(await this.proposalChoices(interaction.options.getFocused()));
      return;
    }
    const isButton = typeof interaction.isButton === 'function' && interaction.isButton();
    const button = isButton ? BUTTON.exec(String(interaction.customId || '')) : null;
    const campaignButton = isButton ? CAMPAIGN_BUTTON.exec(String(interaction.customId || '')) : null;
    const command = typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand() &&
      COMMAND_NAMES.includes(interaction.commandName) ? interaction.commandName : null;
    if (!button && !campaignButton && !command) return;
    let out;
    // Campaign buttons read permissions from Discord and start sending, which can outlast the 3 s reply window.
    let updating = false;
    try {
      if (!interaction.guildId) out = this._private('Use this in a server.');
      else if (button) out = await this.answer(interaction, button[1], button[2]);
      else if (campaignButton) {
        if (typeof interaction.deferUpdate === 'function') {
          await interaction.deferUpdate();
          updating = true;
        }
        out = await this.campaignAnswer(interaction, campaignButton[1], campaignButton[2], campaignButton[3] ? Number(campaignButton[3]) * 1000 : null);
      } else {
        // Setup reads permissions from Discord and sends a DM, and a campaign
        // preview lists the server's members: both can outlast the 3 s reply window.
        if (command === 'goon' && typeof interaction.deferReply === 'function') await interaction.deferReply({ flags: EPHEMERAL });
        const member = await this._link(interaction.user, displayName(interaction.member, interaction.user));
        if (command === 'idlerpg') out = await this.idlerpg(interaction);
        else if (command === 'goon') {
          const subcommand = this._subcommand(interaction);
          out = subcommand === 'campaign' ? await this.campaign(interaction) : await this.setup(interaction, subcommand);
        }
        else if (command === 'vote') out = await this.vote(interaction, member);
        else out = await this.duel(interaction, member);
      }
    } catch (error) {
      if (!error || !error.status || error.status >= 500) this.emit('error', `commands /${command || (campaignButton ? 'goon campaign card' : '1v1 card')}`, errorMessage(error));
      out = this._private(error && error.status && error.status < 500 ? errorMessage(error) : 'Something went wrong; try again in a moment.');
    }
    const allowedMentions = { parse: [] };
    if (out.update) {
      if (updating) await interaction.editReply(Object.assign({ allowedMentions }, out.update));
      else await interaction.update(Object.assign({ allowedMentions }, out.update));
    } else if (updating) await interaction.followUp(Object.assign({ allowedMentions }, out));
    else if (interaction.deferred) {
      const { flags, ...edit } = out;
      await interaction.editReply(Object.assign({ allowedMentions }, edit));
    } else await interaction.reply(Object.assign({ allowedMentions }, out));
  }

  _subcommand (interaction) {
    const options = interaction.options;
    return options && typeof options.getSubcommand === 'function' ? options.getSubcommand(false) : null;
  }

  /**
   * `/goon setup`, or `/goon council|embassy|permafleet|voice`: start that
   * script in the caller's DMs. Server-only and for members who can manage
   * the server (checked here and again by the script, fresh from Discord,
   * before it records or creates anything).
   * @param {Object} interaction
   * @param {string} [subcommand='setup']
   * @returns {Promise<Object>} reply
   */
  async setup (interaction, subcommand = 'setup') {
    const community = this.settings.community;
    const channel = allianceChannels.CHANNELS.find((entry) => entry.subcommand === subcommand) || null;
    const command = `/goon ${channel ? channel.subcommand : 'setup'}`;
    if (!community || !community.scripts) return this._private('Server setup is not running right now.');
    if (!hasPermission(interaction.memberPermissions, MANAGE_GUILD)) {
      return this._private('You need the Manage Server permission to set up goon.vc here.');
    }
    const guildName = (interaction.guild && interaction.guild.name) || 'this server';
    try {
      await community.beginScript(channel ? channel.script : SETUP_SCRIPT, {
        user: `discord/users/${interaction.user.id}`,
        name: displayName(interaction.member, interaction.user) || 'there',
        context: { guildId: interaction.guildId, guildName },
        subject: interaction.guildId
      });
    } catch (error) {
      if (error && error.code === DM_CLOSED) {
        return this._private(`I couldn’t send you a DM. Allow direct messages from server members (server name → Privacy Settings), then run \`${command}\` again.`);
      }
      throw error;
    }
    if (channel) return this._private(`Check your DMs: I’ve sent the first step of setting up ${channel.label} on **${escapeMarkdown(guildName)}**.`);
    return this._private(`Check your DMs: I’ve sent the first step of connecting **${escapeMarkdown(guildName)}** to goon.vc.`);
  }

  /**
   * `/goon campaign`: save a campaign owned by this server and show its
   * author a private preview (who it reaches, who is skipped and why) with
   * Send (or Schedule) and Cancel. Nothing goes out until they press it.
   * @param {Object} interaction
   * @returns {Promise<Object>} reply
   */
  async campaign (interaction) {
    const community = this.settings.community;
    const campaigns = community && community.campaigns;
    if (!campaigns) return this._private('Campaigns are not running right now.');
    if (!hasPermission(interaction.memberPermissions, MANAGE_GUILD)) {
      return this._private('You need the Manage Server permission to send a campaign here.');
    }
    const options = interaction.options;
    const text = String(options.getString('message') || '').trim();
    if (!text) return this._private('Write the message to send.');
    const role = this._role(options, 'role');
    const excludeRole = this._role(options, 'exclude_role');
    const activeDays = typeof options.getInteger === 'function' ? options.getInteger('active_days') : null;
    const script = options.getString('script');
    const offered = script ? community.campaignScripts().find((entry) => entry.id === script) : null;
    if (script && !offered) return this._private(`There is no conversation called \`${script}\`. Pick one from the list.`);
    const now = this.settings.now();
    const sendAt = parseSendAt(options.getString('send_at'), now);
    const guildName = (interaction.guild && interaction.guild.name) || null;
    const owner = { kind: 'guild', guildId: String(interaction.guildId), guildName };
    const until = campaigns.cooldown(owner, sendAt || now);
    if (until) return this._private(this._cooldownMessage(until));

    const by = displayName(interaction.member, interaction.user);
    const draft = await campaigns.create({
      content: offered ? { type: 'script', script: offered.id, text } : { type: 'message', text },
      filter: {
        roles: role ? [String(role.id)] : [],
        excludeRoles: excludeRole ? [String(excludeRole.id)] : [],
        activeWithinDays: activeDays || null
      }
    }, { owner, by });
    let preview;
    try {
      preview = await campaigns.preview(draft.id);
    } catch (error) {
      await campaigns.cancel(draft.id, { by }).catch(() => {});
      throw error;
    }
    this._campaignAuthors.set(draft.id, String(interaction.user.id));
    while (this._campaignAuthors.size > 500) this._campaignAuthors.delete(this._campaignAuthors.keys().next().value);

    const quote = text.length > 1200 ? `${text.slice(0, 1199)}…` : text;
    const audience = role ? `<@&${role.id}>` : `**${escapeMarkdown(guildName || 'this server')}**`;
    const skipped = [
      excludeRole ? `skipping <@&${excludeRole.id}>` : null,
      preview.optedOut ? `${number(preview.optedOut)} opted out` : null,
      preview.inactive ? `${number(preview.inactive)} not in voice in ${plural(activeDays, 'day')}` : null
    ].filter(Boolean);
    const lines = [
      `**Campaign preview** — ${escapeMarkdown(guildName || 'this server')}`,
      quote.split('\n').map((line) => `> ${line}`).join('\n'),
      `Reaches **${number(preview.reach)}** ${preview.reach === 1 ? 'member' : 'members'} of ${audience}${skipped.length ? `; ${skipped.join(', ')}` : ''}.`
    ];
    if (offered) lines.push(`Offers **${escapeMarkdown(offered.title)}** behind a Start button.`);
    const buttons = [];
    if (preview.over) {
      lines.push(`That is more than the **${number(preview.limit)}** a server campaign may reach. Narrow it with a role.`);
    } else if (!preview.reach) {
      lines.push('Nobody to send to.');
    } else if (sendAt) {
      const at = Math.floor(sendAt / 1000);
      lines.push(`Goes out <t:${at}:f> (<t:${at}:R>), one DM every few seconds, once you press Schedule. Every DM says it came from this server and has Stop buttons.`);
      buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.success, label: 'Schedule', custom_id: `campaign:schedule:${draft.id}:${at}` });
    } else {
      lines.push('Goes out one DM every few seconds once you press Send. Every DM says it came from this server and has Stop buttons.');
      buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.success, label: 'Send', custom_id: `campaign:send:${draft.id}` });
    }
    buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.secondary, label: 'Cancel', custom_id: `campaign:cancel:${draft.id}` });
    return {
      content: lines.join('\n\n'),
      flags: EPHEMERAL,
      components: [{ type: ACTION_ROW, components: buttons }]
    };
  }

  /**
   * Send, Schedule, or Cancel on a `/goon campaign` preview. Only its author
   * may press them, and sending checks Manage Server again, fresh from Discord.
   * @param {Object} interaction
   * @param {string} action `send` | `schedule` | `cancel`
   * @param {string} id Campaign id.
   * @param {number|null} sendAt epoch ms (Schedule)
   * @returns {Promise<Object>} reply or `{ update }`
   */
  async campaignAnswer (interaction, action, id, sendAt) {
    const community = this.settings.community;
    const campaigns = community && community.campaigns;
    if (!campaigns) return this._private('Campaigns are not running right now.');
    const campaign = campaigns.campaign(id);
    if (!campaign || campaign.owner.kind !== 'guild' || campaign.owner.guildId !== String(interaction.guildId)) {
      return this._private('This campaign is no longer here.');
    }
    const author = this._campaignAuthors.get(id);
    if (author && author !== String(interaction.user.id)) return this._private('Only whoever ran the command can send this campaign.');
    if (campaign.status !== 'draft') return { update: { content: `This campaign is already ${campaign.status}.`, components: [] } };
    const by = displayName(interaction.member, interaction.user);

    if (action === 'cancel') {
      await campaigns.cancel(id, { by });
      this._campaignAuthors.delete(id);
      return { update: { content: 'Cancelled. Nothing was sent.', components: [] } };
    }
    if (!(await community.can(String(interaction.user.id), String(interaction.guildId)))) {
      return this._private('You need the Manage Server permission to send a campaign here.');
    }
    let result;
    try {
      result = await campaigns.schedule(id, { sendAt: action === 'schedule' ? sendAt : null, by });
    } catch (error) {
      if (error && error.status === 429 && error.retryAt) return this._private(this._cooldownMessage(Date.parse(error.retryAt)));
      throw error;
    }
    this._campaignAuthors.delete(id);
    if (result.status === 'scheduled') {
      const at = Math.floor(Date.parse(result.sendAt) / 1000);
      return { update: { content: `Scheduled: **${number(result.preview.reach)}** DMs go out <t:${at}:f> (<t:${at}:R>).`, components: [] } };
    }
    return { update: { content: `Sending to **${number(result.stats.targeted)}** ${result.stats.targeted === 1 ? 'member' : 'members'} now, one every few seconds.`, components: [] } };
  }

  /**
   * Conversations a campaign may offer, for `/goon campaign script`.
   * @param {string} typed
   * @returns {Array<{ name: string, value: string }>}
   */
  scriptChoices (typed) {
    const community = this.settings.community;
    if (!community || !community.campaigns || typeof community.campaignScripts !== 'function') return [];
    const query = String(typed || '').trim().toLowerCase();
    return community.campaignScripts()
      .filter((entry) => !query || entry.id.includes(query) || String(entry.title).toLowerCase().includes(query))
      .slice(0, MAX_CHOICES)
      .map((entry) => ({ name: String(entry.title).slice(0, 100), value: entry.id }));
  }

  _role (options, name) {
    return options && typeof options.getRole === 'function' ? options.getRole(name) : null;
  }

  _cooldownMessage (until) {
    return `This server sent a campaign recently; the next one can go out <t:${Math.ceil(until / 1000)}:R>.`;
  }

  _private (content) {
    return { content, flags: EPHEMERAL };
  }

  _url (path) {
    return `${String(this.settings.siteUrl).replace(/\/+$/, '')}${path}`;
  }

  /**
   * `/idlerpg profile|leaderboard|stats`.
   * @param {Object} interaction
   * @returns {Promise<Object>} reply
   */
  async idlerpg (interaction) {
    const presence = this.settings.presence;
    if (!presence || !presence.game) return this._private('IdleRPG is not running right now.');
    const subcommand = interaction.options.getSubcommand();
    if (subcommand === 'leaderboard') return this._leaderboard(presence);
    if (subcommand === 'stats') return this._stats(presence);
    const pilot = interaction.options.getUser('pilot');
    const user = pilot || interaction.user;
    const self = !pilot || pilot.id === interaction.user.id;
    if (user.bot) return this._private('Bots don’t play IdleRPG.');
    const profile = await presence.discordPlayer(user.id);
    if (!profile) {
      const who = self ? 'You haven’t' : `${escapeMarkdown(displayName(interaction.options.getMember('pilot'), user) || 'They')} hasn’t`;
      return this._private(`${who} played yet. Time in a voice channel earns XP.`);
    }
    const toNext = Math.max(0, profile.nextLevelExperience - profile.experience);
    const weapon = profile.weapon ? `wielding ${escapeMarkdown(profile.weapon)}` : 'bare-handed';
    const link = this._url(`${this.settings.idlerpgPath}/players/${encodeURIComponent(profile.id)}`);
    return {
      content: [
        `**${escapeMarkdown(profile.name)}** — level ${profile.level}, rank ${profile.rank} of ${profile.players}${profile.online ? ' · online now' : ''}`,
        `${number(profile.experience)} XP (${number(toNext)} to level ${profile.level + 1}) · ${number(profile.hours)} hours present · ${number(profile.wealth)} IDLE`,
        `${weapon[0].toUpperCase()}${weapon.slice(1)} · ${plural(profile.kills, 'kill')} (${profile.battles.won}–${profile.battles.lost} in battle)`,
        `[Full profile](<${link}>)`
      ].join('\n')
    };
  }

  async _leaderboard (presence) {
    const { players } = await presence.players(10);
    if (!players.length) return this._private('Nobody has played yet. Time in a voice channel earns XP.');
    const lines = players.map((row) => `${row.rank}. **${escapeMarkdown(row.name)}** — level ${row.level}, ${number(row.experience)} XP, ${plural(row.kills, 'kill')}${row.online ? ' · online' : ''}`);
    return { content: ['**IdleRPG leaderboard**', ...lines, `[Every pilot](<${this._url(this.settings.idlerpgPath)}>)`].join('\n') };
  }

  async _stats (presence) {
    const report = await presence.report();
    const week = report.last7Days || { hours: 0, players: 0 };
    const battles = report.battles || { won: 0, lost: 0 };
    const slain = (report.slain || []).slice(0, 3).map((entry) => `${escapeMarkdown(entry.name)} (${number(entry.count)})`);
    return {
      content: [
        '**IdleRPG**',
        `${plural(report.presentNow, 'pilot')} present now · ${plural(report.uniquePlayers, 'player')} · ${number(report.totalPresentHours)} hours in all`,
        `Last 7 days: ${number(week.hours)} hours by ${plural(week.players, 'player')}`,
        `Battles: ${number(battles.won)} won, ${number(battles.lost)} lost${slain.length ? ` · most slain: ${slain.join(', ')}` : ''}`,
        `[Statistics](<${this._url(this.settings.idlerpgPath)}>)`
      ].join('\n')
    };
  }

  /**
   * The goon.vc member for a Discord user, linked on the members Store when
   * there is one. Everyone who runs a command gets a profile this way.
   * @returns {Promise<string>} member id
   */
  async _link (user, name) {
    const members = this.settings.members;
    if (members) return (await members.linkDiscord(user, name)).id;
    return `${DISCORD_MEMBER}${user.id}`;
  }

  /** The member id of a Discord user who has one, else their account key; links nothing. */
  async _member (user) {
    const key = `${DISCORD_MEMBER}${user.id}`;
    const members = this.settings.members;
    const member = members ? await members.memberFor(key).catch(() => null) : null;
    return member ? member.id : key;
  }

  async _same (a, b) {
    if (a === b) return true;
    const members = this.settings.members;
    if (!members) return false;
    const [x, y] = await Promise.all([members.resolve(a), members.resolve(b)]);
    return !!x && !!y && x.id === y.id;
  }

  _leagueLink (league) {
    return `[${escapeMarkdown(league.name)}](<${this._url(`${this.settings.leaguesPath}/${encodeURIComponent(league.id)}`)}>)`;
  }

  /**
   * `/1v1 winner loser score [league] [note]`, run by one of the two players:
   * posts a card for the other player to confirm. The duel is logged once
   * they do.
   * @param {Object} interaction
   * @param {string} member The caller's goon.vc member id.
   * @returns {Promise<Object>} reply
   */
  async duel (interaction, member) {
    const leagues = this.settings.leagues;
    if (!leagues) return this._private('Leagues are not running right now.');
    const options = interaction.options;
    const winnerUser = options.getUser('winner');
    const loserUser = options.getUser('loser');
    if (winnerUser.bot || loserUser.bot) return this._private('Bots don’t duel.');
    if (winnerUser.id === loserUser.id) return this._private('A pilot cannot duel themselves.');
    const winnerName = displayName(options.getMember('winner'), winnerUser);
    const loserName = displayName(options.getMember('loser'), loserUser);
    const proposer = interaction.user.id === winnerUser.id ? 'winner' : interaction.user.id === loserUser.id ? 'loser' : null;
    if (!proposer) {
      return this._private(`You can only log a duel you fought. Ask ${escapeMarkdown(winnerName)} or ${escapeMarkdown(loserName)} to run \`/1v1\`; the other one confirms it.`);
    }
    const match = /^(\d+)-(\d+)$/.exec(String(options.getString('score') || ''));
    if (!match) return this._private('Pick the set score from the list.');
    const score = [Number(match[1]), Number(match[2])];
    const id = String(options.getString('league') || this.settings.league).trim().toLowerCase();
    const league = await leagues.getLeague(id);
    if (!league) return this._private(`There is no league \`${escapeMarkdown(id)}\`. Pick one from the list.`);
    const side = (user, name, self) => ({ member: self ? member : `${DISCORD_MEMBER}${user.id}`, name, username: user.username });
    const proposal = await leagues.proposeDuel(id, {
      winner: side(winnerUser, winnerName, proposer === 'winner'),
      loser: side(loserUser, loserName, proposer === 'loser'),
      proposer,
      bestOf: 2 * score[0] - 1,
      score,
      note: options.getString('note') || undefined
    });
    const other = proposer === 'winner' ? loserUser : winnerUser;
    const claim = proposer === 'winner'
      ? `**${escapeMarkdown(winnerName)}** says they beat you`
      : `**${escapeMarkdown(loserName)}** says you beat them`;
    const lines = [
      `<@${other.id}>, ${claim} ${score[0]}–${score[1]} (best of ${proposal.bestOf}) in the ${this._leagueLink(league)}.`
    ];
    if (proposal.note) lines.push(`> ${escapeMarkdown(proposal.note)}`);
    lines.push(`Confirm to log it. This expires <t:${Math.floor(Date.parse(proposal.expiresAt) / 1000)}:R>.`);
    return {
      content: lines.join('\n'),
      components: [{
        type: ACTION_ROW,
        components: [
          { type: BUTTON_COMPONENT, style: BUTTON_STYLE.success, label: 'Confirm', custom_id: `1v1:confirm:${proposal.id}` },
          { type: BUTTON_COMPONENT, style: BUTTON_STYLE.danger, label: 'Decline', custom_id: `1v1:decline:${proposal.id}` }
        ]
      }],
      allowedMentions: { users: [other.id] }
    };
  }

  /**
   * A Confirm or Decline press on a `/1v1` card. The other player confirms
   * (and is linked to their goon.vc member); either player may decline or
   * withdraw. The card is rewritten with the outcome and loses its buttons.
   * @param {Object} interaction ButtonInteraction
   * @param {string} action `confirm` | `decline`
   * @param {string} proposalId
   * @returns {Promise<Object>} `{ update }` for the card, or a private reply
   */
  async answer (interaction, action, proposalId) {
    const leagues = this.settings.leagues;
    if (!leagues) return this._private('Leagues are not running right now.');
    const member = await this._member(interaction.user);
    const proposal = await leagues.getProposal(proposalId);
    if (!proposal) return this._private('That duel is no longer on record.');
    if (action === 'confirm' && proposal.status === 'pending' && await this._same(proposal[proposal.proposer].member, member)) {
      const other = proposal[proposal.proposer === 'winner' ? 'loser' : 'winner'];
      return this._private(`Waiting for ${escapeMarkdown(other.name)} to confirm.`);
    }
    const result = action === 'confirm'
      ? await leagues.confirmDuel(proposalId, member)
      : await leagues.declineDuel(proposalId, member);
    if (result.duel) {
      await this._link(interaction.user, displayName(interaction.member, interaction.user));
      if (typeof leagues.relinkMembers === 'function') await leagues.relinkMembers();
    }
    const league = result.league || await leagues.getLeague(result.proposal.league);
    return { update: { content: this._outcome(result.proposal, league, result.duel), components: [] } };
  }

  /** The card text once a proposal is settled. */
  _outcome (proposal, league, duel) {
    const where = league ? ` in the ${this._leagueLink(league)}` : '';
    const set = `${proposal.score[0]}–${proposal.score[1]} (best of ${proposal.bestOf})`;
    if (proposal.status === 'confirmed') {
      const winner = duel ? duel.winner : proposal.winner.name;
      const loser = duel ? duel.loser : proposal.loser.name;
      const confirmer = duel ? duel.confirmedBy : proposal[proposal.proposer === 'winner' ? 'loser' : 'winner'].name;
      const lines = [`**${escapeMarkdown(winner)}** beat **${escapeMarkdown(loser)}** ${set}${where}. Confirmed by ${escapeMarkdown(confirmer)}.`];
      if (duel && duel.change) {
        lines.push(`${escapeMarkdown(winner)} ${duel.change.winner[0]} → ${duel.change.winner[1]} · ${escapeMarkdown(loser)} ${duel.change.loser[0]} → ${duel.change.loser[1]}`);
      }
      if (proposal.note) lines.push(`> ${escapeMarkdown(proposal.note)}`);
      return lines.join('\n');
    }
    const claim = `~~${escapeMarkdown(proposal.winner.name)} beat ${escapeMarkdown(proposal.loser.name)} ${set}~~${where}`;
    const proposer = proposal[proposal.proposer].name;
    const other = proposal[proposal.proposer === 'winner' ? 'loser' : 'winner'].name;
    if (proposal.status === 'declined') return `${claim}: declined by ${escapeMarkdown(other)}, so it was not logged.`;
    if (proposal.status === 'withdrawn') return `${claim}: withdrawn by ${escapeMarkdown(proposer)}, so it was not logged.`;
    return `${claim}: expired before ${escapeMarkdown(other)} confirmed it, so it was not logged.`;
  }

  _alliance () {
    const alliance = this.settings.alliance;
    return typeof alliance === 'function' ? alliance() : alliance;
  }

  /**
   * `/vote proposal choice`: the caller's advisory vote on an alliance
   * proposal, signed by the key goon.vc holds for their Discord account
   * under this Bridge's attestation. Their latest vote from any linked
   * account counts.
   * @param {Object} interaction
   * @param {string} member The caller's goon.vc member id.
   * @returns {Promise<Object>} reply
   */
  async vote (interaction, member) {
    const alliance = this._alliance();
    if (!alliance || !alliance.current || !alliance.bridge) return this._private('Alliance votes are not set up right now.');
    if (interaction.user.bot) return this._private('Bots don’t vote.');
    const options = interaction.options;
    const id = String(options.getString('proposal') || '').trim().toLowerCase();
    const choice = String(options.getString('choice') || '').toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(id)) return this._private('Pick the proposal from the list.');
    const proposal = await alliance.memberVote(id, { account: `${DISCORD_MEMBER}${interaction.user.id}`, member, choice });
    const members = proposal.members;
    const tally = proposal.tally;
    const lines = [`Recorded your **${choice}** on **${escapeMarkdown(proposal.title)}**.`];
    const replaced = proposal.you && proposal.you.replaced;
    if (replaced && replaced.otherAccount) lines.push(`It replaces your **${replaced.choice}** from another of your linked accounts; one vote per member counts.`);
    lines.push(`Members: ${number(members.yes)} yes, ${number(members.no)} no, ${number(members.abstain)} abstain (advisory).`);
    lines.push(`Orgs: ${number(tally.yes)} of ${number(tally.threshold)} yes needed · ${proposal.status === 'open' ? `open until <t:${Math.floor(Date.parse(proposal.closesAt) / 1000)}:f>` : proposal.status}.`);
    lines.push(`[Proposal](<${this._url(proposal.path)}>)`);
    return this._private(lines.join('\n'));
  }

  /**
   * Autocomplete for `/vote proposal`: open proposals whose title or short id contains the typed text.
   * @param {string} typed
   * @returns {Promise<Array<{ name: string, value: string }>>}
   */
  async proposalChoices (typed) {
    const alliance = this._alliance();
    if (!alliance || !alliance.current) return [];
    const wanted = String(typed || '').trim().toLowerCase();
    return (await alliance.listProposals())
      .filter((row) => row.status === 'open')
      .filter((row) => !wanted || row.title.toLowerCase().includes(wanted) || row.shortId.startsWith(wanted))
      .slice(0, MAX_CHOICES)
      .map((row) => ({ name: row.title.slice(0, 100), value: row.shortId }));
  }

  /**
   * Autocomplete for `/1v1 league`: leagues whose name or id contains the typed text.
   * @param {string} typed
   * @returns {Promise<Array<{ name: string, value: string }>>}
   */
  async leagueChoices (typed) {
    const leagues = this.settings.leagues;
    if (!leagues) return [];
    const wanted = String(typed || '').trim().toLowerCase();
    return (await leagues.listLeagues())
      .filter((league) => !wanted || league.name.toLowerCase().includes(wanted) || league.id.includes(wanted))
      .slice(0, 25)
      .map((league) => ({ name: league.name.slice(0, 100), value: league.id }));
  }
}

module.exports = Commands;
module.exports.DEFINITIONS = DEFINITIONS;
module.exports.displayName = displayName;
module.exports.escapeMarkdown = escapeMarkdown;
module.exports.parseSendAt = parseSendAt;
