'use strict';

const { OPEN_LEAGUE_ID } = require('./leagues');

const EPHEMERAL = 64;
const CHAT_INPUT = 1;
const OPTION = { subcommand: 1, string: 3, user: 6 };
const GUILD_CONTEXT = 0;
const GUILD_INSTALL = 0;
const MAX_WINS = 5;
const NOTE_LENGTH = 140;
const ACTION_ROW = 1;
const BUTTON_COMPONENT = 2;
const BUTTON_STYLE = { success: 3, danger: 4 };
const BUTTON = /^1v1:(confirm|decline):([0-9a-f]{12})$/;
const DISCORD_MEMBER = 'discord:';

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
  }
];

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

/**
 * Discord application commands for goon.vc: `/idlerpg` (the IdleRPG game's
 * public numbers) and `/1v1` (a player reports a duel; the other confirms it
 * on the card's buttons). They ride the one gateway client {@link Operations}
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
   * @param {Object} [settings.leagues] Leagues service.
   * @param {Object} [settings.members] Members service (goon.vc profiles Discord users are linked to).
   * @param {string} [settings.league] League `/1v1` logs to by default.
   * @param {string} [settings.siteUrl] Absolute site origin for links.
   * @param {string} [settings.idlerpgPath]
   * @param {string} [settings.leaguesPath]
   * @param {boolean} [settings.register] Register the commands with Discord on ready (default true).
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      operations: null,
      presence: null,
      leagues: null,
      members: null,
      league: OPEN_LEAGUE_ID,
      siteUrl: 'https://goon.vc',
      idlerpgPath: '/services/idlerpg',
      leaguesPath: '/leagues',
      register: true
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.discord = null;
    this.client = null;
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

  /** Command definitions, as Discord API JSON. */
  get definitions () {
    return DEFINITIONS;
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
    for (const definition of DEFINITIONS) {
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
      return;
    }
    const button = typeof interaction.isButton === 'function' && interaction.isButton()
      ? BUTTON.exec(String(interaction.customId || ''))
      : null;
    const command = typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand() &&
      ['idlerpg', '1v1'].includes(interaction.commandName) ? interaction.commandName : null;
    if (!button && !command) return;
    let out;
    try {
      if (!interaction.guildId) out = this._private('Use this in a server.');
      else if (button) out = await this.answer(interaction, button[1], button[2]);
      else {
        const member = await this._link(interaction.user, displayName(interaction.member, interaction.user));
        out = command === 'idlerpg' ? await this.idlerpg(interaction) : await this.duel(interaction, member);
      }
    } catch (error) {
      if (!error || !error.status || error.status >= 500) this.emit('error', `commands /${command || '1v1 card'}`, errorMessage(error));
      out = this._private(error && error.status && error.status < 500 ? errorMessage(error) : 'Something went wrong; try again in a moment.');
    }
    if (out.update) await interaction.update(Object.assign({ allowedMentions: { parse: [] } }, out.update));
    else await interaction.reply(Object.assign({ allowedMentions: { parse: [] } }, out));
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
    const member = `${DISCORD_MEMBER}${interaction.user.id}`;
    const proposal = await leagues.getProposal(proposalId);
    if (!proposal) return this._private('That duel is no longer on record.');
    if (action === 'confirm' && proposal.status === 'pending' && proposal[proposal.proposer].member === member) {
      const other = proposal[proposal.proposer === 'winner' ? 'loser' : 'winner'];
      return this._private(`Waiting for ${escapeMarkdown(other.name)} to confirm.`);
    }
    const result = action === 'confirm'
      ? await leagues.confirmDuel(proposalId, member)
      : await leagues.declineDuel(proposalId, member);
    if (result.duel) await this._link(interaction.user, displayName(interaction.member, interaction.user));
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
