'use strict';

const { OPEN_LEAGUE_ID } = require('./leagues');
const Community = require('./community');
const allianceChannels = require('../functions/allianceChannels');
const allianceRoles = require('../functions/allianceRoles');
const marketPost = require('../functions/marketPost');
const marketEscrow = require('../functions/marketEscrow');
const schedulePoll = require('../functions/schedulePoll');

const EPHEMERAL = 64;
const CHAT_INPUT = 1;
const OPTION = { subcommand: 1, string: 3, integer: 4, user: 6, channel: 7, role: 8, attachment: 11 };
const GUILD_CONTEXT = 0;
const BOT_DM_CONTEXT = 1;
const PRIVATE_CHANNEL_CONTEXT = 2;
const GUILD_INSTALL = 0;
const USER_INSTALL = 1;
const MAX_WINS = 5;
const NOTE_LENGTH = 140;
const ACTION_ROW = 1;
const BUTTON_COMPONENT = 2;
const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 };
const BUTTON = /^1v1:(confirm|decline):([0-9a-f]{12})$/;
const CAMPAIGN_BUTTON = /^campaign:(send|schedule|cancel):([0-9a-f]{12})(?::(\d{1,12}))?(?::([0-9a-f]{8}))?$/;
const SWITCH_BUTTON = /^(checkins|welcome):(send|stop|cancel)(?::([0-9a-f]{8}))?$/;
const MARKET_BUTTON = new RegExp(`^${marketPost.BUY_PREFIX}([0-9a-f]{12})$`);
const SCHED_VOTE = /^sched:vote:([0-9a-f]{12})$/;
const SCHED_BUTTON = /^sched:(pick|skip):([0-9a-f]{12})(?::([0-9a-f]{2}))?$/;
const MARKET_ROWS = 10;
const REPLY_TEXT = 1900;
const MARKET_STATUSES = ['available', 'reserved', 'sold', 'hidden'];
const OPEN_ORDER_STATES = new Set(marketEscrow.OPEN_STATES);
const EMBED_TEXT = 4096;
const EMBED_TOTAL = 6000;
const RECIPIENT_TEXT = 3500;
const RECIPIENT_FILE = 'recipients.txt';
const DISCORD_MEMBER = 'discord:';
const MANAGE_GUILD = 1n << 5n;
const DM_CLOSED = 50007;
const SETUP_SCRIPT = 'goon-setup';
const HANGAR_SCRIPT = 'hangar-import';
const HANGAR_FILE_BYTES = 5 * 1024 * 1024;
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
        description: `Set up the ${channel.label} channel every PERMAFLEET member org keeps, in your DMs (org officers).`
      })),
      {
        type: OPTION.subcommand,
        name: allianceRoles.SCRIPT.subcommand,
        description: 'Set up the Prospect ranks every PERMAFLEET member org keeps, in your DMs (org officers).'
      },
      {
        type: OPTION.subcommand,
        name: 'campaign',
        description: 'DM a message to this server’s members; you see who it reaches before it goes out.',
        options: [
          { type: OPTION.string, name: 'message', description: 'What to send', required: true, max_length: CAMPAIGN_TEXT },
          { type: OPTION.role, name: 'role', description: 'Only members with this role (default: everyone)' },
          { type: OPTION.role, name: 'exclude_role', description: 'Skip members with this role' },
          { type: OPTION.integer, name: 'active_days', description: 'Only members in voice or posting within this many days', min_value: 1, max_value: 365 },
          { type: OPTION.string, name: 'script', description: 'Offer a guided conversation behind a Start button', autocomplete: true },
          { type: OPTION.string, name: 'send_at', description: 'When to send: "in 2 hours" or 2026-11-01T18:00Z (default: when you press Send)' }
        ]
      },
      { type: OPTION.subcommand, name: 'checkins', description: 'Preview the check-ins with quiet G00N SQUAD members, and turn them on or off.' },
      { type: OPTION.subcommand, name: 'welcome', description: 'Preview the DM inviting new members to join PERMAFLEET, and turn it on or off.' },
      { type: OPTION.subcommand, name: 'review', description: 'Approve or turn away goon.vc sign-ins waiting for review, in your DMs (reviewers only).' }
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
  },
  {
    name: 'schedule',
    description: 'Find a time that works, then put it on this server’s calendar.',
    type: CHAT_INPUT,
    contexts: [GUILD_CONTEXT],
    integration_types: [GUILD_INSTALL],
    options: [
      {
        type: OPTION.subcommand,
        name: 'open',
        description: 'Open a poll: named people or a role mark every time they can make.',
        options: [
          { type: OPTION.string, name: 'title', description: 'What the event is called', required: true, max_length: 100 },
          { type: OPTION.string, name: 'people', description: 'Names or @handles, separated by commas', max_length: 400 },
          { type: OPTION.role, name: 'role', description: 'Everyone with this role' },
          { type: OPTION.role, name: 'also', description: 'And everyone with this role' },
          { type: OPTION.integer, name: 'days', description: 'How many days ahead to offer (default 7)', min_value: 1, max_value: 14 },
          { type: OPTION.string, name: 'times', description: 'Hours each day, like 4pm, 7pm, 10pm (default those three)', max_length: 80 },
          { type: OPTION.integer, name: 'length', description: 'How many hours the event runs (default 2)', min_value: 1, max_value: 8 },
          { type: OPTION.string, name: 'closes', description: 'When voting ends, like "in 2 days" or a date (default 24 hours)', max_length: 60 },
          { type: OPTION.channel, name: 'voice', description: 'Voice or stage channel the event takes place in', channel_types: [2, 13] },
          { type: OPTION.string, name: 'where', description: 'Location, when it isn’t in a voice channel (default: this server)', max_length: 100 },
          { type: OPTION.string, name: 'zone', description: 'Time zone for the hours, like America/Chicago', max_length: 64 },
          { type: OPTION.string, name: 'about', description: 'Notes that go on the Discord event', max_length: 500 }
        ]
      },
      {
        type: OPTION.subcommand,
        name: 'close',
        description: 'Close your poll now and pick from the best overlaps.',
        options: [
          { type: OPTION.string, name: 'poll', description: 'Which poll, if you have more than one open', max_length: 12 }
        ]
      }
    ]
  },
  {
    name: 'market',
    description: 'The G00N SQUAD Market: pledges priced in BTC, with escrow.',
    type: CHAT_INPUT,
    // Installable on a member's own account too, so it runs in any server, DM, or group DM.
    contexts: [GUILD_CONTEXT, BOT_DM_CONTEXT, PRIVATE_CHANNEL_CONTEXT],
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    options: [
      {
        type: OPTION.subcommand,
        name: 'search',
        description: 'Find listings.',
        options: [{ type: OPTION.string, name: 'query', description: 'Ship, pack, paint, seller… (default: newest)', max_length: 100 }]
      },
      {
        type: OPTION.subcommand,
        name: 'sell',
        description: 'List something; it becomes a post in the Market forum.',
        options: [
          { type: OPTION.string, name: 'item', description: 'What you are selling', required: true, max_length: 100 },
          { type: OPTION.string, name: 'price', description: 'In BTC (0.005 BTC), sats (500k sats), or dollars ($40)', required: true, max_length: 40 },
          { type: OPTION.string, name: 'kind', description: 'Ship, paint, pack…', choices: marketPost.KINDS.map((kind) => ({ name: kind, value: kind })) },
          { type: OPTION.integer, name: 'qty', description: 'How many (default 1)', min_value: 1, max_value: 999 },
          { type: OPTION.string, name: 'insurance', description: 'LTI, or months like 120 mo', max_length: 20 },
          { type: OPTION.attachment, name: 'image', description: 'A picture of it' },
          { type: OPTION.string, name: 'notes', description: 'Anything a buyer should know', max_length: 1500 }
        ]
      },
      { type: OPTION.subcommand, name: 'mine', description: 'Your listings and open orders.' },
      {
        type: OPTION.subcommand,
        name: 'edit',
        description: 'Change one of your listings; the forum post follows.',
        options: [
          { type: OPTION.string, name: 'listing', description: 'Which listing', required: true, autocomplete: true },
          { type: OPTION.string, name: 'price', description: 'New price: BTC, sats, or dollars', max_length: 40 },
          { type: OPTION.string, name: 'status', description: 'New status', choices: MARKET_STATUSES.map((status) => ({ name: marketPost.STATUS_LABELS[status] || status, value: status })) },
          { type: OPTION.string, name: 'notes', description: 'New notes', max_length: 1500 }
        ]
      },
      {
        type: OPTION.subcommand,
        name: 'buy',
        description: 'Buy a listing with escrow.',
        options: [{ type: OPTION.string, name: 'listing', description: 'Which listing', required: true, autocomplete: true }]
      }
    ]
  },
  {
    name: 'rsi',
    description: 'Link your RSI profile to your G00N SQUAD profile.',
    type: CHAT_INPUT,
    contexts: [GUILD_CONTEXT, BOT_DM_CONTEXT],
    integration_types: [GUILD_INSTALL],
    options: [
      { type: OPTION.subcommand, name: 'claim', description: 'Get a private link to claim your RSI handle on goon.vc.' }
    ]
  },
  {
    name: 'hangar',
    description: 'Sync the ships in your RSI hangar to the G00N SQUAD fleet.',
    type: CHAT_INPUT,
    contexts: [GUILD_CONTEXT, BOT_DM_CONTEXT],
    integration_types: [GUILD_INSTALL],
    options: [
      { type: OPTION.subcommand, name: 'guide', description: 'Walk through exporting your hangar, in your DMs.' },
      {
        type: OPTION.subcommand,
        name: 'import',
        description: 'Sync your ships from a Hangar Export .json file.',
        options: [{ type: OPTION.attachment, name: 'file', description: 'The .json file Hangar Export saved', required: true }]
      },
      { type: OPTION.subcommand, name: 'status', description: 'When you last synced, and how many ships.' }
    ]
  },
  {
    name: 'clips',
    description: 'Record people talking in a voice channel into the clip library.',
    type: CHAT_INPUT,
    contexts: [GUILD_CONTEXT],
    integration_types: [GUILD_INSTALL],
    options: [
      { type: OPTION.subcommand, name: 'listen', description: 'Join your current voice channel and record talk until you leave, or the channel is empty.' },
      { type: OPTION.subcommand, name: 'leave', description: 'Stop recording and leave the voice channel.' }
    ]
  },
  {
    name: 'help',
    description: 'What each goon.vc command does.',
    type: CHAT_INPUT,
    // Wherever `/market` runs, so members who added it to their own account can ask too.
    contexts: [GUILD_CONTEXT, BOT_DM_CONTEXT, PRIVATE_CHANNEL_CONTEXT],
    integration_types: [GUILD_INSTALL, USER_INSTALL],
    // Choices are the commands running right now (`Commands#definitions`).
    options: [{ type: OPTION.string, name: 'command', description: 'One command in detail (default: all of them)' }]
  }
];
const COMMAND_NAMES = DEFINITIONS.map((definition) => definition.name);

/** What `/help` adds to each command's own description, with a link where there is a page. */
const HELP = {
  idlerpg: (commands) => `Everyone in a voice channel the bot can see earns XP; battles, gear, and finds happen on their own. Players and statistics: <${commands._url(commands.settings.idlerpgPath)}>`,
  '1v1': (commands) => `Run it as one of the two players. Your opponent gets Confirm and Decline buttons, and the duel counts once they confirm. Ratings: <${commands._url(`${commands.settings.leaguesPath}/${OPEN_LEAGUE_ID}`)}>`,
  vote: (commands) => `Any member’s vote is advisory. If you’re on record as an officer of a member org, your vote also counts toward your org’s vote, and the orgs’ votes decide. Proposals: <${commands._url(commands.settings.votesPath)}>`,
  schedule: (commands) => `Name the people, a role, or both. They mark every time they can make on the message in that channel. When it closes you get the fullest times, and the one you pick becomes an event on that server. The week board: <${commands._url('/events')}>`,
  market: (commands) => {
    const market = commands._market();
    const browse = market && market.base ? ` Browse: <${commands._url(market.base)}>` : '';
    return `Every listing is a thread in the G00N SQUAD Market forum. Pledges change hands by RSI gifting, and escrow holds the payment until the buyer confirms the gift. Add it to your own account to use it in any DM: <${commands._url('/services/discord/install')}>.${browse}`;
  },
  rsi: (commands) => `You prove the handle is yours by putting a short code in your RSI bio for a minute. <${commands._url(commands.settings.rsiPath)}>`,
  hangar: (commands) => `Export your pledges with the Hangar Export add-on for Firefox, then import the .json file. Only fleet totals are public, never who owns what: <${commands._url(commands.settings.rsiPath)}>`,
  clips: (commands) => `The bot joins only when asked, and only records people talking — not Go Live video or game audio. Clips: <${commands._url(commands.settings.clipsPath)}>`,
  goon: () => 'For members who can manage the server. The PERMAFLEET channel and rank commands are for the org’s officers on record, and campaigns, check-ins, and welcome DMs show every recipient before anything is sent.'
};

const WHERE = {
  guild: 'In servers with the goon.vc bot.',
  dm: 'In servers with the goon.vc bot, or in its DMs.',
  anywhere: 'In servers, DMs, and group DMs once you add it to your account.'
};

/** `/name required [optional]` for a command or subcommand. */
function usage (name, options = []) {
  const args = options.filter((option) => option.type !== OPTION.subcommand).map((option) => (option.required ? option.name : `[${option.name}]`));
  return `\`/${[name, ...args].join(' ')}\``;
}

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

/** The questions a DM script asks, as an embed draft `{ title, text }`. */
function scriptEmbed (script) {
  const questions = script.questions.map((question, index) => {
    const options = question.options.length ? `\n   ${question.options.map(escapeMarkdown).join(' · ')}` : '';
    return `${index + 1}. ${question.say}${question.optional ? ' *(optional)*' : ''}${options}`;
  });
  return { title: `Start opens: ${script.title}`, text: questions };
}

/**
 * Recipients by name, as many as fit in `limit` characters, then how many
 * more (every name is in the attached recipients.txt).
 * @param {Array<string>} names
 * @param {number} [limit]
 * @returns {string}
 */
function nameList (names, limit = RECIPIENT_TEXT) {
  if (!names.length) return 'Nobody.';
  let text = '';
  let shown = 0;
  for (const name of names) {
    const next = shown ? `${text}, ${escapeMarkdown(name)}` : escapeMarkdown(name);
    if (next.length > limit - 60) break;
    text = next;
    shown += 1;
  }
  const rest = names.length - shown;
  return rest ? `${text}, and ${number(rest)} more (every name is in ${RECIPIENT_FILE}).` : `${text}.`;
}

/**
 * Every recipient of a preview, numbered in sending order, as an attachment.
 * @param {Array<{ title: string, names: Array<string> }>} sections
 * @returns {Array<Object>} discord.js `files` (empty when nobody is reached)
 */
function recipientFiles (sections) {
  const filled = sections.filter((section) => section.names.length);
  if (!filled.length) return [];
  const text = filled.map((section) => [
    `${section.title} (${section.names.length})`,
    ...section.names.map((name, index) => `${index + 1}. ${name}`)
  ].join('\n')).join('\n\n');
  return [{ attachment: Buffer.from(`${text}\n`, 'utf8'), name: RECIPIENT_FILE }];
}

/** Embed drafts `{ title, text: [] }` as Discord embeds, within the per-embed and per-message limits. */
function fitEmbeds (embeds) {
  const budget = Math.floor(EMBED_TOTAL / Math.max(1, embeds.length)) - 120;
  const limit = Math.min(EMBED_TEXT, budget);
  return embeds.map((embed) => {
    const description = embed.text.join('\n\n');
    return { title: embed.title.slice(0, 100), description: description.length > limit ? `${description.slice(0, limit - 1)}…` : description };
  });
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

/** Role ids on a discord.js member, or the raw interaction's role id list. */
function roleIds (member) {
  const roles = member && member.roles;
  if (!roles) return [];
  if (Array.isArray(roles)) return roles.map(String);
  const cache = roles.cache;
  if (cache && typeof cache.keys === 'function') return [...cache.keys()].map(String);
  return [];
}

function cannotPost (error) {
  const code = error && (error.code != null ? Number(error.code) : Number(error.status));
  return code === 50013 || code === 50001 || code === 403;
}

function rsiHandles (member) {
  return ((member && member.accounts) || []).filter((account) => account.platform === 'rsi').map((account) => account.id);
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
 * preview, through Community's Campaigns), `/goon checkins` (preview the
 * check-ins with quiet members and turn them on or off, through
 * {@link Checkins}), `/goon welcome` (the same for the DM inviting new
 * members to join PERMAFLEET, through {@link Welcome}), `/goon review` (a
 * reviewer gets the sign-ins waiting for review in DMs, through
 * {@link Reviews}), `/vote` (any member's advisory
 * vote on an alliance proposal, through {@link Alliance#memberVote}; an
 * officer on record also signs for their org, through {@link Alliance#vote}),
 * `/schedule` (a poll of named people or a role; when it closes the opener
 * picks an overlap and goon.vc creates the Discord event on that server,
 * through {@link Schedule}), and
 * `/market` (search, sell, edit, and buy on the Market, through {@link Market};
 * also user-installable, so it runs in DMs, plus the Buy with escrow button on
 * Market forum posts), `/rsi claim` (a private one-time link to claim an RSI
 * handle on goon.vc, through {@link Members#claimLink}), and `/hangar`
 * (a DM walkthrough for exporting a hangar, and the import of that export
 * for a claimed handle, through {@link Hangar}). They ride the one gateway client {@link Operations}
 * runs; interactions need no intents. The application is shared with other
 * services, so only these commands are registered (upserted by name, global;
 * all but `/market` servers only) and nothing else is touched. Players are found by their
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
   * @param {Object|Function} [settings.market] Market service (`/market`), or a function returning it (it starts later); unset leaves `/market` unregistered.
   * @param {Object|Function} [settings.checkins] Checkins service (`/goon checkins`), or a function returning it.
   * @param {Object|Function} [settings.welcome] Welcome service (`/goon welcome`), or a function returning it.
   * @param {Object|Function} [settings.reviews] Reviews service (`/goon review`), or a function returning it.
   * @param {Object} [settings.hangar] Hangar service (`/hangar`); unset leaves `/hangar` unregistered.
   * @param {Object} [settings.schedule] Schedule service (`/schedule`); unset leaves `/schedule` unregistered.
   * @param {string} [settings.league] League `/1v1` logs to by default.
   * @param {string} [settings.siteUrl] Absolute site origin for links.
   * @param {string} [settings.idlerpgPath]
   * @param {string} [settings.leaguesPath]
   * @param {string} [settings.rsiPath] RSI claim page.
   * @param {string} [settings.votesPath] Alliance votes page.
   * @param {boolean} [settings.register] Register the commands with Discord on ready (default true).
   * @param {Function} [settings.fetch] Fetches `/hangar import` attachments (tests); defaults to global fetch.
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
      market: null,
      checkins: null,
      welcome: null,
      reviews: null,
      hangar: null,
      schedule: null,
      clips: null,
      league: OPEN_LEAGUE_ID,
      siteUrl: 'https://goon.vc',
      idlerpgPath: '/services/idlerpg',
      leaguesPath: '/leagues',
      rsiPath: '/rsi',
      clipsPath: '/clips',
      votesPath: '/operations/PERMAFLEET/votes',
      register: true,
      fetch: null,
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
   * campaign`, `/goon checkins`, and `/goon welcome` only while campaigns
   * run, `/goon review` only while sign-in reviews run, and no `/goon`
   * without any of them. `/help` offers the others as choices.
   */
  get definitions () {
    const community = this.settings.community;
    const scripts = !!(community && community.scripts);
    const checkins = this._checkins();
    const welcome = this._welcome();
    const reviews = this._reviews();
    const running = {
      setup: scripts,
      campaign: !!(community && community.campaigns),
      checkins: !!(checkins && checkins.available),
      welcome: !!(welcome && welcome.available),
      review: !!(reviews && reviews.available)
    };
    for (const channel of allianceChannels.CHANNELS) running[channel.subcommand] = scripts;
    running[allianceRoles.SCRIPT.subcommand] = scripts;
    const live = DEFINITIONS.map((definition) => {
      if (definition.name === 'market') return this.settings.market ? definition : null;
      if (definition.name === 'schedule') return this._schedule() ? definition : null;
      if (definition.name === 'clips') return this._clips() ? definition : null;
      if (definition.name === 'rsi') return this._members() ? definition : null;
      if (definition.name === 'hangar') {
        if (!this.settings.hangar || !this._members()) return null;
        return Object.assign({}, definition, { options: definition.options.filter((option) => option.name !== 'guide' || scripts) });
      }
      if (definition.name !== 'goon') return definition;
      const options = definition.options.filter((option) => running[option.name]);
      return options.length ? Object.assign({}, definition, { options }) : null;
    }).filter(Boolean);
    const choices = live.filter((definition) => definition.name !== 'help').map((definition) => ({ name: `/${definition.name}`, value: definition.name }));
    return live.map((definition) => (definition.name === 'help'
      ? Object.assign({}, definition, { options: definition.options.map((option) => Object.assign({}, option, { choices })) })
      : definition));
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
      else if (interaction.commandName === 'market') await interaction.respond(await this.listingChoices(interaction));
      return;
    }
    const isButton = typeof interaction.isButton === 'function' && interaction.isButton();
    const isSelect = typeof interaction.isStringSelectMenu === 'function' && interaction.isStringSelectMenu();
    const button = isButton ? BUTTON.exec(String(interaction.customId || '')) : null;
    const campaignButton = isButton ? CAMPAIGN_BUTTON.exec(String(interaction.customId || '')) : null;
    const switchButton = isButton ? SWITCH_BUTTON.exec(String(interaction.customId || '')) : null;
    const marketButton = isButton ? MARKET_BUTTON.exec(String(interaction.customId || '')) : null;
    const schedVote = isSelect ? SCHED_VOTE.exec(String(interaction.customId || '')) : null;
    const schedButton = isButton ? SCHED_BUTTON.exec(String(interaction.customId || '')) : null;
    const command = typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand() &&
      COMMAND_NAMES.includes(interaction.commandName) ? interaction.commandName : null;
    // A select menu this service doesn't own (a DM script) is left for Doorman.
    if (isSelect && !schedVote) return;
    if (!button && !campaignButton && !switchButton && !marketButton && !schedVote && !schedButton && !command) return;
    let out;
    // Campaign, check-in, welcome, and schedule buttons read from Discord or post an event, which can outlast the 3 s reply window.
    let updating = false;
    try {
      // The offer’s buttons arrive in a DM, where there is no guild.
      if (schedVote) out = await this.scheduleVote(interaction, schedVote[1]);
      else if (schedButton) {
        if (typeof interaction.deferUpdate === 'function') {
          await interaction.deferUpdate();
          updating = true;
        }
        out = await this.schedulePick(interaction, schedButton[1], schedButton[2], schedButton[3] || null);
      // `/help` runs anywhere and reads nothing about the caller.
      } else if (command === 'help') out = this.help(interaction);
      else if (command === 'schedule') {
        if (!interaction.guildId) out = this._private('Use this in a server.');
        else {
          if (typeof interaction.deferReply === 'function') await interaction.deferReply({ flags: EPHEMERAL });
          out = await this.scheduleCommand(interaction);
        }
      }
      else if (command === 'clips') {
        if (!interaction.guildId) out = this._private('Use this in a server.');
        else {
          if (typeof interaction.deferReply === 'function') await interaction.deferReply({ flags: EPHEMERAL });
          out = await this.clipsCommand(interaction);
        }
      }
      // `/market` is also installed on members' own accounts, so it runs in DMs and servers without the bot.
      // `/rsi` and `/hangar` also run in the bot's DMs.
      else if (command === 'market' || marketButton || command === 'rsi' || command === 'hangar') {
        if (typeof interaction.deferReply === 'function') await interaction.deferReply({ flags: EPHEMERAL });
        const member = await this._linkMember(interaction.user, displayName(interaction.member, interaction.user));
        if (command === 'rsi') out = await this.rsi(member);
        else if (command === 'hangar') out = await this.hangar(interaction, member);
        else out = marketButton ? await this.marketBuy(marketButton[1], member) : await this.market(interaction, member);
      } else if (!interaction.guildId) out = this._private('Use this in a server.');
      else if (button) out = await this.answer(interaction, button[1], button[2]);
      else if (campaignButton || switchButton) {
        if (typeof interaction.deferUpdate === 'function') {
          await interaction.deferUpdate();
          updating = true;
        }
        if (campaignButton) out = await this.campaignAnswer(interaction, campaignButton[1], campaignButton[2], campaignButton[3] ? Number(campaignButton[3]) * 1000 : null, campaignButton[4] || null);
        else if (switchButton[1] === 'welcome') out = await this.welcomeAnswer(interaction, switchButton[2], switchButton[3] || null);
        else out = await this.checkinsAnswer(interaction, switchButton[2], switchButton[3] || null);
      } else {
        // Setup reads permissions from Discord and sends a DM, and a campaign
        // preview lists the server's members: both can outlast the 3 s reply window.
        if (command === 'goon' && typeof interaction.deferReply === 'function') await interaction.deferReply({ flags: EPHEMERAL });
        const member = await this._link(interaction.user, displayName(interaction.member, interaction.user));
        if (command === 'idlerpg') out = await this.idlerpg(interaction);
        else if (command === 'goon') {
          const subcommand = this._subcommand(interaction);
          if (subcommand === 'campaign') out = await this.campaign(interaction);
          else if (subcommand === 'checkins') out = await this.checkins(interaction);
          else if (subcommand === 'welcome') out = await this.welcome(interaction);
          else if (subcommand === 'review') out = await this.review(interaction);
          else out = await this.setup(interaction, subcommand);
        }
        else if (command === 'vote') out = await this.vote(interaction, member);
        else out = await this.duel(interaction, member);
      }
    } catch (error) {
      const where = command || (schedButton || schedVote ? 'schedule' : campaignButton ? 'goon campaign card' : switchButton ? `goon ${switchButton[1]} card` : marketButton ? 'market buy button' : '1v1 card');
      if (!error || !error.status || error.status >= 500) this.emit('error', `commands /${where}`, errorMessage(error));
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
   * `/goon setup`, `/goon council|embassy|permafleet|voice`, or `/goon roles`:
   * start that script in the caller's DMs. Server-only and for members who
   * can manage the server (checked here and again by the script, fresh from
   * Discord, before it records or creates anything). The PERMAFLEET channel
   * and rank scripts also need the caller on record as an officer of a
   * member org; otherwise the refusal says how to get there.
   * @param {Object} interaction
   * @param {string} [subcommand='setup']
   * @returns {Promise<Object>} reply
   */
  async setup (interaction, subcommand = 'setup') {
    const community = this.settings.community;
    const roles = subcommand === allianceRoles.SCRIPT.subcommand ? allianceRoles.SCRIPT : null;
    const channel = roles || allianceChannels.CHANNELS.find((entry) => entry.subcommand === subcommand) || null;
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
    if (channel) return this._private(`Check your DMs: I’ve sent the first step of setting up ${channel.label} on **${escapeMarkdown(guildName)}**.`);    return this._private(`Check your DMs: I’ve sent the first step of connecting **${escapeMarkdown(guildName)}** to goon.vc.`);
  }

  /**
   * `/goon campaign`: save a campaign owned by this server and show its
   * author a private preview (every member it reaches by name, who is
   * skipped and why) with Send (or Schedule) and Cancel. Nothing goes out
   * until they press it, and then only to the members listed.
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
      preview.inactive ? `${number(preview.inactive)} not active in ${plural(activeDays, 'day')}` : null
    ].filter(Boolean);
    const lines = [
      `**Campaign preview** — ${escapeMarkdown(guildName || 'this server')}`,
      quote.split('\n').map((line) => `> ${line}`).join('\n'),
      `Reaches **${number(preview.reach)}** ${preview.reach === 1 ? 'member' : 'members'} of ${audience}${skipped.length ? `; ${skipped.join(', ')}` : ''}.`
    ];
    if (offered) lines.push(`Offers **${escapeMarkdown(offered.title)}** behind a Start button.`);
    const names = (preview.recipients || []).map((recipient) => recipient.name || 'Unnamed member');
    const buttons = [];
    if (preview.over) {
      lines.push(`That is more than the **${number(preview.limit)}** a server campaign may reach. Narrow it with a role.`);
    } else if (!preview.reach) {
      lines.push('Nobody to send to.');
    } else if (!this._maySendCampaign(community, interaction.user.id)) {
      lines.push(Community.CAMPAIGN_SEND_REFUSAL);
    } else if (sendAt) {
      const at = Math.floor(sendAt / 1000);
      lines.push(`Goes out <t:${at}:f> (<t:${at}:R>) to the members listed below (anyone who joins or opts out before then is left out), one DM every few seconds, once you press Schedule. Every DM says it came from this server and has Stop buttons.`);
      buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.success, label: 'Schedule', custom_id: `campaign:schedule:${draft.id}:${at}:${preview.id}` });
    } else {
      lines.push('Goes out to the members listed below, one DM every few seconds, once you press Send. Every DM says it came from this server and has Stop buttons.');
      buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.success, label: 'Send', custom_id: `campaign:send:${draft.id}:${preview.id}` });
    }
    buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.secondary, label: 'Cancel', custom_id: `campaign:cancel:${draft.id}` });
    const out = {
      content: lines.join('\n\n'),
      flags: EPHEMERAL,
      components: [{ type: ACTION_ROW, components: buttons }]
    };
    if (names.length && !preview.over) {
      out.embeds = [{ title: `Goes to ${plural(names.length, 'member')}`, description: nameList(names) }];
      out.files = recipientFiles([{ title: `Campaign: ${draft.title}`, names }]);
    }
    return out;
  }

  /**
   * Send, Schedule, or Cancel on a `/goon campaign` preview. Only its author
   * may press them, and sending checks Manage Server again, fresh from Discord.
   * @param {Object} interaction
   * @param {string} action `send` | `schedule` | `cancel`
   * @param {string} id Campaign id.
   * @param {number|null} sendAt epoch ms (Schedule)
   * @param {string|null} previewId The preview the button belongs to (Send / Schedule).
   * @returns {Promise<Object>} reply or `{ update }`
   */
  async campaignAnswer (interaction, action, id, sendAt, previewId = null) {
    const community = this.settings.community;
    const campaigns = community && community.campaigns;
    if (!campaigns) return this._private('Campaigns are not running right now.');
    const campaign = campaigns.campaign(id);
    if (!campaign || campaign.owner.kind !== 'guild' || campaign.owner.guildId !== String(interaction.guildId)) {
      return this._private('This campaign is no longer here.');
    }
    const author = this._campaignAuthors.get(id);
    if (author && author !== String(interaction.user.id)) return this._private('Only whoever ran the command can send this campaign.');
    if (campaign.status !== 'draft') return { update: { content: `This campaign is already ${campaign.status}.`, embeds: [], attachments: [], components: [] } };
    const by = displayName(interaction.member, interaction.user);

    if (action === 'cancel') {
      await campaigns.cancel(id, { by });
      this._campaignAuthors.delete(id);
      return { update: { content: 'Cancelled. Nothing was sent.', embeds: [], attachments: [], components: [] } };
    }
    if (!previewId || !campaign.preview || campaign.preview.id !== previewId) {
      return this._private('This preview is out of date, so nothing was sent. Run `/goon campaign` again to see who it reaches now.');
    }
    if (!(await community.can(String(interaction.user.id), String(interaction.guildId)))) {
      return this._private('You need the Manage Server permission to send a campaign here.');
    }
    if (!this._maySendCampaign(community, interaction.user.id)) {
      return this._private(Community.CAMPAIGN_SEND_REFUSAL);
    }
    let result;
    try {
      result = await campaigns.schedule(id, { sendAt: action === 'schedule' ? sendAt : null, preview: previewId, by, discord: String(interaction.user.id) });
    } catch (error) {
      if (error && error.status === 429 && error.retryAt) return this._private(this._cooldownMessage(Date.parse(error.retryAt)));
      throw error;
    }
    this._campaignAuthors.delete(id);
    if (result.status === 'scheduled') {
      const at = Math.floor(Date.parse(result.sendAt) / 1000);
      return { update: { content: `Scheduled: **${number(result.preview.reach)}** DMs go out <t:${at}:f> (<t:${at}:R>), to the members you previewed.`, embeds: [], attachments: [], components: [] } };
    }
    return { update: { content: `Sending to **${number(result.stats.targeted)}** of the members you previewed now, one every few seconds.`, embeds: [], attachments: [], components: [] } };
  }

  _checkins () {
    const checkins = this.settings.checkins;
    return typeof checkins === 'function' ? checkins() : checkins;
  }

  /**
   * `/goon checkins`: in the home server, show someone with Manage Server
   * what the check-ins would send right now: each tier's message and every
   * member it would reach, by name (in the message, and all of them in an
   * attached recipients.txt), and the questions behind Start, with Send
   * and Cancel, plus Stop while earlier check-ins are still going out.
   * Nothing is sent from the preview, and Send sends only to the members
   * it listed.
   * @param {Object} interaction
   * @returns {Promise<Object>} reply
   */
  async checkins (interaction) {
    const checkins = this._checkins();
    if (!checkins || !checkins.available) return this._private('Check-ins are not running right now.');
    if (String(interaction.guildId) !== checkins.guildId) return this._private('Check-ins are run from the G00N SQUAD server.');
    if (!hasPermission(interaction.memberPermissions, MANAGE_GUILD)) {
      return this._private('You need the Manage Server permission to manage check-ins.');
    }
    const preview = await checkins.preview();
    const status = preview.status;
    const total = preview.tiers.reduce((sum, tier) => sum + (tier.status === 'draft' ? tier.reach : 0), 0);
    const lines = ['**Check-ins preview.** Nothing has been sent.'];
    if (total) lines.push(`Send DMs the **${number(total)}** ${total === 1 ? 'member' : 'members'} named below, most inactive first, one every few seconds. Nobody else gets one: members who go quiet later get theirs the next time someone runs \`/goon checkins\` and presses Send.`);
    else lines.push('Nobody is due for a check-in right now.');
    lines.push('Nobody gets more than one message per tier, or two check-ins within a month. Every DM has Stop buttons.');
    if (status.sending) lines.push(`${plural(status.sending, 'earlier check-in')} ${status.sending === 1 ? 'is' : 'are'} still going out; Stop cancels what hasn’t been sent yet.`);

    const embeds = preview.tiers.map((tier) => {
      const skipped = [
        tier.excluded ? `${number(tier.excluded)} already reached` : null,
        tier.optedOut ? `${number(tier.optedOut)} opted out` : null
      ].filter(Boolean);
      const quote = String(tier.message).split('\n').map((line) => `> ${line}`).join('\n');
      if (tier.status !== 'draft') {
        return { title: tier.name, text: [`Still going out from the last round (${tier.status}, ${number(tier.reach)} ${tier.reach === 1 ? 'member' : 'members'}).`, quote] };
      }
      const reach = `Reaches **${number(tier.reach)}** ${tier.reach === 1 ? 'member' : 'members'}${skipped.length ? `; skipping ${skipped.join(', ')}` : ''}.`;
      return { title: tier.name, text: tier.reach ? [reach, `**To:** ${nameList(tier.recipients, 900)}`, quote] : [reach, quote] };
    });
    if (preview.script) embeds.push(scriptEmbed(preview.script));
    const buttons = [];
    if (total && this._maySendCampaign(this.settings.community, interaction.user.id)) {
      buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.success, label: `Send to ${plural(total, 'member')}`, custom_id: `checkins:send:${preview.id}` });
    } else if (total) {
      lines.push(Community.CAMPAIGN_SEND_REFUSAL);
    }
    if (status.sending) buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.danger, label: 'Stop', custom_id: 'checkins:stop' });
    buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.secondary, label: 'Cancel', custom_id: 'checkins:cancel' });
    return {
      content: lines.join('\n\n'),
      embeds: fitEmbeds(embeds),
      files: recipientFiles(preview.tiers.filter((tier) => tier.status === 'draft').map((tier) => ({ title: tier.name, names: tier.recipients || [] }))),
      flags: EPHEMERAL,
      components: [{ type: ACTION_ROW, components: buttons }]
    };
  }

  /**
   * Send, Stop, or Cancel on a `/goon checkins` preview. Manage Server is
   * checked again, fresh from Discord, and Send sends only the preview it
   * was shown on.
   * @param {Object} interaction
   * @param {string} action `send` | `stop` | `cancel`
   * @param {string|null} previewId
   * @returns {Promise<Object>} reply or `{ update }`
   */
  async checkinsAnswer (interaction, action, previewId = null) {
    const done = (content) => ({ update: { content, embeds: [], attachments: [], components: [] } });
    if (action === 'cancel') return done('Cancelled. Nothing was sent.');
    const checkins = this._checkins();
    const community = this.settings.community;
    if (!checkins || !checkins.available) return this._private('Check-ins are not running right now.');
    if (String(interaction.guildId) !== checkins.guildId) return this._private('Check-ins are run from the G00N SQUAD server.');
    if (!community || !(await community.can(String(interaction.user.id), String(interaction.guildId)))) {
      return this._private('You need the Manage Server permission to manage check-ins.');
    }
    const by = displayName(interaction.member, interaction.user);
    if (action === 'stop') {
      const { cancelled } = await checkins.halt({ by });
      return done(cancelled
        ? `Stopped. ${plural(cancelled, 'check-in')} that hadn’t gone out yet won’t be sent.`
        : 'Nothing was still going out.');
    }
    if (!this._maySendCampaign(community, interaction.user.id)) {
      return this._private(Community.CAMPAIGN_SEND_REFUSAL);
    }
    const run = await checkins.send({ preview: previewId, by, discord: String(interaction.user.id) });
    const names = Object.fromEntries((checkins.contract.tiers || []).map((tier) => [tier.id, tier.name]));
    const sent = run.map((entry) => {
      const name = escapeMarkdown(names[entry.tier] || entry.tier);
      if (entry.status === 'sending' || entry.status === 'scheduled') return `${name}: **${number(entry.reach)}**`;
      return `${name}: nobody`;
    });
    return done(`Going out now to the members you previewed, most inactive first, one DM every few seconds:\n${sent.map((line) => `• ${line}`).join('\n')}\n\nNothing more goes out until someone runs \`/goon checkins\` and presses Send again.`);
  }

  _welcome () {
    const welcome = this.settings.welcome;
    return typeof welcome === 'function' ? welcome() : welcome;
  }

  _reviews () {
    const reviews = this.settings.reviews;
    return typeof reviews === 'function' ? reviews() : reviews;
  }

  /**
   * `/goon review`: DM a reviewer everyone waiting for review on goon.vc.
   * Reviewers are goon.vc's own list, not a server permission.
   * @param {Object} interaction
   * @returns {Promise<Object>} reply
   */
  async review (interaction) {
    const reviews = this._reviews();
    if (!reviews || !reviews.available) return this._private('Sign-in reviews are not running right now.');
    if (!reviews.isReviewer(interaction.user.id)) return this._private('Only goon.vc’s sign-in reviewers can review sign-ins.');
    let result;
    try {
      result = await reviews.begin(interaction.user.id, displayName(interaction.member, interaction.user));
    } catch (error) {
      if (error && error.code === DM_CLOSED) {
        return this._private('I couldn’t send you a DM. Allow direct messages from server members (server name → Privacy Settings), then run `/goon review` again.');
      }
      throw error;
    }
    if (!result.pending) return this._private('Nobody is waiting for review right now.');
    return this._private(`Check your DMs: ${result.pending === 1 ? '1 sign-in is' : `${result.pending} sign-ins are`} waiting for review.`);
  }

  /**
   * `/goon welcome`: in the home server, show someone with Manage Server the
   * DM inviting new members to join PERMAFLEET, every member it would reach
   * right now by name (in the message, and all of them in an attached
   * recipients.txt), who is skipped, and the questions behind Start, with
   * Send and Cancel, plus Stop while earlier welcomes are still going out.
   * Nothing is sent from the preview, and Send sends only to the members
   * it listed.
   * @param {Object} interaction
   * @returns {Promise<Object>} reply
   */
  async welcome (interaction) {
    const welcome = this._welcome();
    if (!welcome || !welcome.available) return this._private('Welcome DMs are not running right now.');
    if (String(interaction.guildId) !== welcome.guildId) return this._private('Welcome DMs are run from the G00N SQUAD server.');
    if (!hasPermission(interaction.memberPermissions, MANAGE_GUILD)) {
      return this._private('You need the Manage Server permission to manage welcome DMs.');
    }
    const preview = await welcome.preview();
    const status = preview.status;
    const delay = plural(status.delayHours, 'hour');
    const lines = ['**Welcome DM preview.** Nothing has been sent.'];
    if (preview.reach) lines.push(`Send DMs this to the **${number(preview.reach)}** ${preview.reach === 1 ? 'member' : 'members'} named below, one every few seconds. Nobody else gets it: members who join later get theirs the next time someone runs \`/goon welcome\` and presses Send.`);
    else lines.push('Nobody is due for a welcome right now.');
    const skipped = [
      preview.recent ? `${number(preview.recent)} joined under ${delay} ago (due later)` : null,
      preview.welcomed ? `${number(preview.welcomed)} already welcomed` : null,
      preview.optedOut ? `${number(preview.optedOut)} opted out` : null
    ].filter(Boolean);
    const roles = Object.values(preview.roles).flat().map(escapeMarkdown).join(', ');
    lines.push(`Everyone gets it once, ever. Members with any of these roles never get it: ${roles}. Every DM has Stop buttons.`);
    if (status.sending) lines.push(`${plural(status.sending, 'earlier welcome')} ${status.sending === 1 ? 'is' : 'are'} still going out; Stop cancels what hasn’t been sent yet.`);
    const reach = `Reaches **${number(preview.reach)}** ${preview.reach === 1 ? 'member' : 'members'} who joined in the last ${plural(status.windowDays, 'day')}${skipped.length ? `; skipping ${skipped.join(', ')}` : ''}.`;
    const quote = String(preview.message).split('\n').map((line) => `> ${line}`).join('\n');
    const embeds = [{ title: 'The welcome DM', text: preview.reach ? [reach, `**To:** ${nameList(preview.recipients, 2000)}`, quote] : [reach, quote] }];
    if (preview.script) embeds.push(scriptEmbed(preview.script));
    const buttons = [];
    if (preview.reach && this._maySendCampaign(this.settings.community, interaction.user.id)) {
      buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.success, label: `Send to ${plural(preview.reach, 'member')}`, custom_id: `welcome:send:${preview.id}` });
    } else if (preview.reach) {
      lines.push(Community.CAMPAIGN_SEND_REFUSAL);
    }
    if (status.sending) buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.danger, label: 'Stop', custom_id: 'welcome:stop' });
    buttons.push({ type: BUTTON_COMPONENT, style: BUTTON_STYLE.secondary, label: 'Cancel', custom_id: 'welcome:cancel' });
    return {
      content: lines.join('\n\n'),
      embeds: fitEmbeds(embeds),
      files: recipientFiles([{ title: 'Welcome: join PERMAFLEET', names: preview.recipients || [] }]),
      flags: EPHEMERAL,
      components: [{ type: ACTION_ROW, components: buttons }]
    };
  }

  /**
   * Send, Stop, or Cancel on a `/goon welcome` preview. Manage Server is
   * checked again, fresh from Discord, and Send sends only the preview it
   * was shown on.
   * @param {Object} interaction
   * @param {string} action `send` | `stop` | `cancel`
   * @param {string|null} previewId
   * @returns {Promise<Object>} reply or `{ update }`
   */
  async welcomeAnswer (interaction, action, previewId = null) {
    const done = (content) => ({ update: { content, embeds: [], attachments: [], components: [] } });
    if (action === 'cancel') return done('Cancelled. Nothing was sent.');
    const welcome = this._welcome();
    const community = this.settings.community;
    if (!welcome || !welcome.available) return this._private('Welcome DMs are not running right now.');
    if (String(interaction.guildId) !== welcome.guildId) return this._private('Welcome DMs are run from the G00N SQUAD server.');
    if (!community || !(await community.can(String(interaction.user.id), String(interaction.guildId)))) {
      return this._private('You need the Manage Server permission to manage welcome DMs.');
    }
    const by = displayName(interaction.member, interaction.user);
    if (action === 'stop') {
      const { cancelled } = await welcome.halt({ by });
      return done(cancelled
        ? `Stopped. ${plural(cancelled, 'welcome DM')} that hadn’t gone out yet won’t be sent.`
        : 'Nothing was still going out.');
    }
    if (!this._maySendCampaign(community, interaction.user.id)) {
      return this._private(Community.CAMPAIGN_SEND_REFUSAL);
    }
    const run = await welcome.send({ preview: previewId, by, discord: String(interaction.user.id) });
    return done(run.reach && run.status !== 'draft'
      ? `Sending to **${number(run.reach)}** of the members you previewed now, one DM every few seconds. Nothing more goes out until someone runs \`/goon welcome\` and presses Send again.`
      : 'Nobody you previewed is still due, so nothing was sent.');
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

  _maySendCampaign (community, userId) {
    return !community || typeof community.maySendCampaign !== 'function' || community.maySendCampaign(userId) === true;
  }

  _private (content) {
    return { content, flags: EPHEMERAL };
  }

  _url (path) {
    return `${String(this.settings.siteUrl).replace(/\/+$/, '')}${path}`;
  }

  _members () {
    const members = this.settings.members;
    return members && typeof members.claimLink === 'function' ? members : null;
  }

  /**
   * A private reply with a one-time claim link button. The link signs its
   * holder in, so it only ever goes out ephemerally.
   * @param {Object} member
   * @param {string} text
   * @returns {Promise<Object>} reply
   */
  async _claimReply (member, text) {
    const { url } = await this._members().claimLink(member.id);
    return {
      content: `${text}\nThe link signs you in as you, works once, and expires in 30 minutes. Don’t share it.`,
      flags: EPHEMERAL,
      components: [{
        type: ACTION_ROW,
        components: [{ type: BUTTON_COMPONENT, style: BUTTON_STYLE.link, label: 'Claim on goon.vc', url }]
      }]
    };
  }

  /**
   * `/rsi claim`: a private one-time link to the claim page, signed in as
   * the caller's member.
   * @param {Object} member The caller's member (linked by this command).
   * @returns {Promise<Object>} reply
   */
  async rsi (member) {
    if (!this._members()) return this._private('RSI claims are not running right now.');
    const handles = rsiHandles(member);
    return this._claimReply(member, handles.length
      ? `You’ve claimed **${handles.map(escapeMarkdown).join('**, **')}** on goon.vc. To claim another handle, open this link.`
      : 'Open this link to claim your RSI handle on goon.vc: you’ll put a short code in your RSI bio for a minute, then press Verify.');
  }

  /**
   * `/hangar guide|import|status`.
   * @param {Object} interaction
   * @param {Object} member
   * @returns {Promise<Object>} reply
   */
  async hangar (interaction, member) {
    if (!this.settings.hangar || !this._members()) return this._private('Hangar sync is not running right now.');
    const subcommand = this._subcommand(interaction);
    if (subcommand === 'import') return this.hangarImport(interaction, member);
    if (subcommand === 'status') return this.hangarStatus(member);
    return this.hangarGuide(interaction, member);
  }

  async hangarGuide (interaction, member) {
    const community = this.settings.community;
    if (!community || !community.scripts) {
      return this._private('The walkthrough is not running right now. Export your hangar with the Hangar Export browser extension, then run `/hangar import` with the .json file.');
    }
    const handles = rsiHandles(member);
    try {
      await community.beginScript(HANGAR_SCRIPT, {
        user: `discord/users/${interaction.user.id}`,
        name: displayName(interaction.member, interaction.user) || 'there',
        context: { rsiHandle: handles[0] || null }
      });
    } catch (error) {
      if (error && error.code === DM_CLOSED) {
        return this._private('I couldn’t send you a DM. Allow direct messages from server members (server name → Privacy Settings), then run `/hangar guide` again.');
      }
      throw error;
    }
    const text = 'Check your DMs: I’ve sent the first step of exporting your hangar.';
    if (handles.length) return this._private(text);
    return this._claimReply(member, `${text}\nYou’ll also need to claim your RSI handle before the import: open this link.`);
  }

  async hangarImport (interaction, member) {
    const options = interaction.options;
    const file = options && typeof options.getAttachment === 'function' ? options.getAttachment('file') : null;
    if (!file || !file.url) return this._private('Attach the .json file Hangar Export saved.');
    if (!/\.json$/i.test(String(file.name || '')) && !/json/i.test(String(file.contentType || ''))) {
      return this._private('That isn’t a .json file. Attach the JSON file Hangar Export saved, not the CSV.');
    }
    if (Number(file.size) > HANGAR_FILE_BYTES) {
      return this._private('That file is over 5 MB; a Hangar Export file is much smaller. Check you attached the right one.');
    }
    let text;
    try {
      const res = await (this.settings.fetch || ((...args) => fetch(...args)))(String(file.url));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (_) {
      return this._private('I couldn’t download that file from Discord. Try again in a moment.');
    }
    if (text.length > HANGAR_FILE_BYTES) return this._private('That file is over 5 MB; a Hangar Export file is much smaller.');
    let data;
    try {
      data = JSON.parse(text);
    } catch (_) {
      return this._private('I couldn’t read that file as JSON. Attach the .json file exactly as Hangar Export saved it.');
    }
    try {
      const result = await this.settings.hangar.importExport(member.id, data);
      return this._private([
        `Synced ${plural(result.ships, 'ship')} (${plural(result.models, 'model')}) for **${escapeMarkdown(result.handle)}**.`,
        `Only fleet totals are public: <${this._url(this.settings.rsiPath)}>. Run \`/hangar import\` again with a newer export whenever your hangar changes.`
      ].join('\n'));
    } catch (error) {
      if (error && error.code === 'UNCLAIMED') {
        return this._claimReply(member, error.handle
          ? `That export is for **${escapeMarkdown(error.handle)}**, which you haven’t claimed on goon.vc. Claim it, then run \`/hangar import\` again.`
          : 'Claim your RSI handle on goon.vc first, then run `/hangar import` again.');
      }
      throw error;
    }
  }

  async hangarStatus (member) {
    const status = await this.settings.hangar.status(member.id);
    if (!status) {
      return this._private(rsiHandles(member).length
        ? 'Nothing synced yet. Run `/hangar guide` for the steps, or `/hangar import` with your Hangar Export .json file.'
        : 'Nothing synced yet. Claim your RSI handle with `/rsi claim`, then run `/hangar guide`.');
    }
    const lines = [`**${escapeMarkdown(status.handle)}**: ${plural(status.ships, 'ship')} (${plural(status.models, 'model')}), synced <t:${Math.floor(Date.parse(status.importedAt) / 1000)}:R>.`];
    if (!status.counted) lines.push(`You no longer hold ${escapeMarkdown(status.handle)} on goon.vc, so these ships aren’t in the fleet totals. Claim it again with \`/rsi claim\`.`);
    else lines.push('Run `/hangar import` with a newer export to update it.');
    return this._private(lines.join('\n'));
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
    return (await this._linkMember(user, name)).id;
  }

  /** {@link Commands#_link}, returning the member record. */
  async _linkMember (user, name) {
    const members = this.settings.members;
    if (members) return members.linkDiscord(user, name);
    const key = `${DISCORD_MEMBER}${user.id}`;
    return { id: key, displayName: name, accounts: [{ key, platform: 'discord', id: String(user.id) }] };
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

  _market () {
    const market = this.settings.market;
    return typeof market === 'function' ? market() : market;
  }

  _schedule () {
    const schedule = this.settings.schedule;
    return schedule && typeof schedule.open === 'function' ? schedule : null;
  }

  _clips () {
    const clips = this.settings.clips;
    const service = typeof clips === 'function' ? clips() : clips;
    return service && typeof service.listen === 'function' && service.voiceEnabled !== false ? service : null;
  }

  /**
   * `/clips listen` joins the caller's voice channel and records talk until
   * `/clips leave` or the channel stays empty. Private reply; names only.
   * @param {Object} interaction
   * @returns {Promise<Object>} reply
   */
  async clipsCommand (interaction) {
    const clips = this._clips();
    if (!clips) return this._private('Voice clips are not running right now.');
    if (interaction.user && interaction.user.bot) return this._private('Bots don’t record.');
    const subcommand = this._subcommand(interaction);
    if (subcommand === 'leave') {
      const status = await clips.leaveVoice();
      if (status && status.stopped) return this._private('Left the voice channel. Recordings are in the clip library.');
      return this._private('I was not listening.');
    }
    const voice = interaction.member && interaction.member.voice;
    const channelId = voice && (voice.channelId || (voice.channel && voice.channel.id));
    if (!channelId) return this._private('Join a voice channel first, then run `/clips listen`.');
    const channelName = (voice.channel && voice.channel.name) || null;
    const listening = await clips.listen({
      guildId: interaction.guildId,
      channelId: String(channelId),
      channelName
    });
    const where = listening.channel ? `#${escapeMarkdown(listening.channel)}` : 'that channel';
    const page = this._url(this.settings.clipsPath);
    return this._private(`Listening in ${where} — people talking are recorded into the clip library (not Go Live video). I’m visible in the channel while this runs. [Clips](<${page}>) · \`/clips leave\` to stop.`);
  }

  /**
   * `/schedule open` posts a poll in this channel for the named people and
   * roles. `/schedule close` ends it now. The overlaps, and the event, are
   * the buttons that follow.
   * @param {Object} interaction
   * @returns {Promise<Object>}
   */
  async scheduleCommand (interaction) {
    const schedule = this._schedule();
    if (!schedule) return this._private('Scheduling is not running right now.');
    if (interaction.user && interaction.user.bot) return this._private('Bots don’t schedule.');
    const subcommand = this._subcommand(interaction);
    if (subcommand === 'close') return this.scheduleClose(interaction, schedule);
    if (subcommand === 'open') return this.scheduleOpen(interaction, schedule);
    return this._private('Use `/schedule open` to start a poll.');
  }

  async scheduleOpen (interaction, schedule) {
    const options = interaction.options;
    const channel = interaction.channel;
    if (!channel || typeof channel.send !== 'function') return this._private('Run this in a channel.');
    const role = this._role(options, 'role');
    const also = this._role(options, 'also');
    const voice = typeof options.getChannel === 'function' ? options.getChannel('voice') : null;
    const record = await schedule.open({
      guildId: String(interaction.guildId),
      guildName: (interaction.guild && interaction.guild.name) || 'this server',
      guild: interaction.guild,
      channelId: interaction.channelId || channel.id,
      creatorId: String(interaction.user.id),
      creatorName: displayName(interaction.member, interaction.user) || 'there',
      title: options.getString('title'),
      about: options.getString('about'),
      people: options.getString('people'),
      roles: [role, also].filter(Boolean).map((entry) => ({ id: String(entry.id), name: entry.name })),
      days: typeof options.getInteger === 'function' ? options.getInteger('days') : null,
      times: options.getString('times'),
      length: typeof options.getInteger === 'function' ? options.getInteger('length') : null,
      closes: options.getString('closes'),
      zone: options.getString('zone'),
      where: options.getString('where'),
      voice: voice ? { id: String(voice.id), name: voice.name, type: voice.type } : null
    });
    let sent;
    try {
      sent = await channel.send(Object.assign({ allowedMentions: { parse: [] } }, schedulePoll.pollMessage(record)));
    } catch (error) {
      await schedule.discard(record.id).catch(() => {});
      if (cannotPost(error)) {
        const invite = await schedule.invite('events');
        return this._private(invite
          ? `I can’t post in this channel. A manager can allow it here: ${invite}`
          : 'I can’t post in this channel.');
      }
      throw error;
    }
    try {
      await schedule.attachMessage(record.id, sent.id);
    } catch (error) {
      await schedule.discard(record.id).catch(() => {});
      if (typeof sent.delete === 'function') await sent.delete().catch(() => {});
      throw error;
    }
    return this._private(schedulePoll.openedText(record));
  }

  async scheduleClose (interaction, schedule) {
    const record = await schedule.close(interaction.options.getString('poll'), String(interaction.user.id), String(interaction.guildId));
    const title = escapeMarkdown(record.title);
    if (record.status === 'cancelled') return this._private(`Closed **${title}**. Nobody answered, so there’s no event.`);
    if (!record.offered) return this._private(`Closed **${title}**. I couldn’t message you just now; I’ll try again shortly.`);
    if (record.offerVia === 'channel') return this._private(`**${title}** is closed. I couldn’t DM you, so the best overlaps are in the channel. Only you can pick.`);
    return this._private(`Closed **${title}**. I sent you the best overlaps.`);
  }

  async scheduleVote (interaction, id) {
    const schedule = this._schedule();
    if (!schedule) return this._private('Scheduling is not running right now.');
    const record = await schedule.vote(id, {
      userId: String(interaction.user.id),
      name: displayName(interaction.member, interaction.user) || 'Someone',
      roleIds: roleIds(interaction.member),
      slots: interaction.values || []
    });
    return { update: schedulePoll.pollMessage(record) };
  }

  async schedulePick (interaction, action, id, slotId) {
    const schedule = this._schedule();
    if (!schedule) return this._private('Scheduling is not running right now.');
    if (action === 'pick' && !slotId) return this._private('That time isn’t one of the overlaps.');
    const record = await schedule.pick(id, String(interaction.user.id), action === 'skip' ? null : slotId);
    return { update: schedulePoll.choiceMessage(record, this.settings.siteUrl) };
  }

  /** A listing as one Discord line: linked title, price, status, seller. */
  _listingLine (listing) {
    const status = listing.status === 'available' ? '' : ` · ${listing.statusLabel}`;
    return `**[${escapeMarkdown(listing.title)}](<${this._url(listing.path)}>)** — ${escapeMarkdown(listing.price.label)}${status} · ${escapeMarkdown(listing.seller.name)}`;
  }

  /**
   * `/help [command]`: every command running right now with its subcommands,
   * or one command in detail (what each part takes, where it runs, and its
   * page on goon.vc). Private, and the same for everyone.
   * @param {Object} interaction
   * @returns {Object} reply
   */
  help (interaction) {
    const options = interaction.options;
    const asked = options && typeof options.getString === 'function' ? options.getString('command') : null;
    const live = this.definitions.filter((definition) => definition.name !== 'help');
    if (!asked) {
      const lines = live.map((definition) => {
        const parts = (definition.options || []).filter((option) => option.type === OPTION.subcommand).map((option) => option.name);
        const manage = definition.default_member_permissions ? ' (server managers)' : '';
        return `**/${definition.name}**${parts.length ? ` ${parts.join(' · ')}` : ''}${manage} — ${definition.description}`;
      });
      return this._private(this._fit('**goon.vc commands**', lines, `Run \`/help command\` for one in detail, or visit <${this._url('/')}>.`));
    }
    const name = String(asked).replace(/^\//, '').trim().toLowerCase();
    const definition = live.find((entry) => entry.name === name);
    if (!definition) return this._private(`\`/${name}\` isn’t running right now. Run \`/help\` for the commands that are.`);
    const head = [`**/${definition.name}** — ${definition.description}`];
    if (HELP[definition.name]) head.push(HELP[definition.name](this));
    const subcommands = (definition.options || []).filter((option) => option.type === OPTION.subcommand);
    const lines = subcommands.length
      ? subcommands.map((option) => `${usage(`${definition.name} ${option.name}`, option.options)} — ${option.description}`)
      : [usage(definition.name, definition.options)];
    const contexts = definition.contexts || [];
    const where = contexts.includes(PRIVATE_CHANNEL_CONTEXT) ? WHERE.anywhere : contexts.includes(BOT_DM_CONTEXT) ? WHERE.dm : WHERE.guild;
    const tail = definition.default_member_permissions ? `${where} Needs Manage Server.` : where;
    return this._private(this._fit(head.join('\n'), lines, tail));
  }

  /** Lines joined under Discord's message limit, noting how many were left out. */
  _fit (head, lines, tail) {
    const out = [head];
    let length = head.length + tail.length + 40;
    let shown = 0;
    for (const line of lines) {
      if (length + line.length + 1 > REPLY_TEXT) break;
      out.push(line);
      length += line.length + 1;
      shown++;
    }
    if (shown < lines.length) out.push(`…and ${number(lines.length - shown)} more.`);
    out.push(tail);
    return out.join('\n');
  }

  /**
   * `/market search|sell|mine|edit|buy`. Runs in servers, DMs, and group
   * DMs (user install), so nothing here reads the guild. Replies are private.
   * @param {Object} interaction
   * @param {Object} member The caller's goon.vc member.
   * @returns {Promise<Object>} reply
   */
  async market (interaction, member) {
    const market = this._market();
    if (!market) return this._private('The Market is not running right now.');
    if (interaction.user && interaction.user.bot) return this._private('Bots don’t trade.');
    const options = interaction.options;
    const subcommand = this._subcommand(interaction);
    const base = market.base;
    if (subcommand === 'search') {
      const query = String(options.getString('query') || '').trim();
      const listings = market.search({ q: query, limit: 50 });
      const all = this._url(query ? `${base}?q=${encodeURIComponent(query)}` : base);
      if (!listings.length) return this._private(`Nothing on the Market${query ? ` matches “${escapeMarkdown(query)}”` : ' yet'}. [Browse](<${all}>)`);
      const head = query ? `**Market:** ${plural(listings.length, 'listing')} matching “${escapeMarkdown(query)}”` : '**Market:** newest listings';
      return this._private(this._fit(head, listings.slice(0, MARKET_ROWS).map((listing) => this._listingLine(listing)), `[See them all](<${all}>)`));
    }
    if (subcommand === 'sell') {
      const image = typeof options.getAttachment === 'function' ? options.getAttachment('image') : null;
      if (image && image.contentType && !/^image\//.test(image.contentType)) return this._private('The image has to be a picture.');
      const input = { title: options.getString('item'), price: options.getString('price') };
      const kind = options.getString('kind');
      const qty = options.getInteger('qty');
      const insurance = options.getString('insurance');
      const notes = options.getString('notes');
      if (kind) input.kind = kind;
      if (qty !== null && qty !== undefined) input.qty = qty;
      if (insurance) input.insurance = insurance;
      if (notes) input.notes = notes;
      if (image && image.url) input.imageUrl = image.url;
      const listing = await market.create(input, member);
      const links = [`[On goon.vc](<${this._url(listing.path)}>)`];
      if (listing.discordUrl) links.push(`[Forum post](<${listing.discordUrl}>)`);
      const lines = [`Listed **${escapeMarkdown(listing.title)}** for ${escapeMarkdown(listing.price.label)}. ${links.join(' · ')}`];
      if (!market.canEscrow(member)) lines.push(`To sell with escrow, link your escrow key (Passport) at <${this._url(`${market.base || '/services/market'}/mine`)}>.`);
      return this._private(lines.join('\n'));
    }
    if (subcommand === 'mine') {
      const { listings, orders } = await market.mine(member);
      const open = orders.filter((order) => OPEN_ORDER_STATES.has(order.state));
      const lines = [];
      if (open.length) {
        lines.push('**Open orders**');
        for (const order of open.slice(0, MARKET_ROWS)) {
          lines.push(`[${escapeMarkdown(order.title)}](<${this._url(order.path)}>) — ${escapeMarkdown(order.stateLabel)} · you are the ${order.role} · ${escapeMarkdown(order.price)}`);
        }
      }
      lines.push(listings.length ? '**Your listings**' : 'You have no listings. List something with `/market sell`.');
      for (const listing of listings.slice(0, MARKET_ROWS)) lines.push(`${this._listingLine(listing)} · \`${listing.id}\``);
      return this._private(this._fit('**Your Market**', lines, `[Manage on goon.vc](<${this._url(`${base}/mine`)}>)`));
    }
    if (subcommand === 'edit') {
      const id = String(options.getString('listing') || '').trim().toLowerCase();
      const input = {};
      const price = options.getString('price');
      const status = options.getString('status');
      const notes = options.getString('notes');
      if (price) input.price = price;
      if (status) input.status = status;
      if (notes) input.notes = notes;
      if (!Object.keys(input).length) return this._private('Give a new price, status, or notes.');
      const listing = await market.update(id, input, member);
      return this._private(`Updated **[${escapeMarkdown(listing.title)}](<${this._url(listing.path)}>)**: ${escapeMarkdown(listing.price.label)} · ${escapeMarkdown(listing.statusLabel)}.${listing.discordUrl ? ' The forum post follows.' : ''}`);
    }
    return this.marketBuy(String(options.getString('listing') || '').trim().toLowerCase(), member);
  }

  /**
   * `/market buy`, or Buy with escrow on a forum post: where to open the
   * escrow order (it needs a refund address, so it happens on goon.vc), or
   * the caller's order when one is open.
   * @param {string} id listing id
   * @param {Object} member
   * @returns {Promise<Object>} reply
   */
  async marketBuy (id, member) {
    const market = this._market();
    if (!market) return this._private('The Market is not running right now.');
    const listing = /^[0-9a-f]{12}$/.test(id) ? await market.getListing(id, member) : null;
    if (!listing) return this._private('That listing isn’t on the Market. Pick one from the list.');
    const title = `**[${escapeMarkdown(listing.title)}](<${this._url(listing.path)}>)**`;
    if (listing.you && listing.you.order) return this._private(`Your order for ${title}: <${this._url(listing.you.order.path)}>`);
    if (listing.you && listing.you.seller) return this._private(`${title} is your own listing.`);
    if (!listing.buyable) {
      if (!listing.priceSats) return this._private(`${title} has no BTC price yet; reply to the seller to make an offer.`);
      return this._private(`${title} is ${listing.statusLabel.toLowerCase()}, so it can’t be bought right now.`);
    }
    if (listing.dibs && !listing.you.dibs) return this._private(`${escapeMarkdown(listing.dibs.name)} has dibs on ${title} until <t:${Math.floor(Date.parse(listing.dibs.until) / 1000)}:f>.`);
    const lines = [`${title} — ${escapeMarkdown(listing.price.label)} from ${escapeMarkdown(listing.seller.name)}.`];
    if (!market.canEscrow(member)) {
      lines.push(`Escrow needs your escrow key: press Link your escrow key at <${this._url(`${listing.path}#buy`)}> and approve it in Passport, then open the order there.`);
    } else {
      lines.push(`Open the escrow order at <${this._url(`${listing.path}#buy`)}>: give a refund address and you get the escrow address to pay. Any two of you, the seller, and goon.vc must sign to move the coins.`);
    }
    return this._private(lines.join('\n'));
  }

  /**
   * Autocomplete for `/market edit listing` (the caller's own listings) and
   * `/market buy listing` (listings for sale).
   * @param {Object} interaction
   * @returns {Promise<Array<{ name: string, value: string }>>}
   */
  async listingChoices (interaction) {
    const market = this._market();
    if (!market) return [];
    const typed = String(interaction.options.getFocused() || '').trim();
    const own = this._subcommand(interaction) === 'edit';
    let rows;
    if (own) {
      const member = await this._member(interaction.user);
      const members = this.settings.members;
      const record = members ? await members.resolve(member).catch(() => null) : null;
      rows = market.search({ mine: true, status: 'all', q: typed }, record || { id: member });
    } else {
      rows = market.search({ q: typed }).filter((listing) => listing.buyable);
    }
    return rows.slice(0, MAX_CHOICES).map((listing) => ({
      name: `${listing.title} — ${listing.price.btc || listing.price.label}${own ? ` (${listing.statusLabel})` : ''}`.slice(0, 100),
      value: listing.id
    }));
  }

  _alliance () {
    const alliance = this.settings.alliance;
    return typeof alliance === 'function' ? alliance() : alliance;
  }

  /**
   * `/vote proposal choice`: the caller's advisory vote on an alliance
   * proposal. Their latest vote from any linked account counts. An officer
   * on record for an org in the proposal also signs for that org, which
   * votes once its threshold of officers agree.
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
    const account = `${DISCORD_MEMBER}${interaction.user.id}`;
    const actor = await alliance.actorFor(account);
    const proposal = actor.officers.length
      ? await alliance.vote(id, { account, choice }, actor)
      : await alliance.memberVote(id, { account, member, choice });
    const members = proposal.members;
    const tally = proposal.tally;
    const lines = [`Recorded your **${choice}** on **${escapeMarkdown(proposal.title)}**.`];
    const replaced = proposal.you && proposal.you.replaced;
    if (replaced && replaced.otherAccount) lines.push(`It replaces your **${replaced.choice}** from another of your linked accounts; one vote per member counts.`);
    for (const symbol of (proposal.you && proposal.you.signed) || []) {
      const seat = proposal.organizations.find((org) => org.symbol === symbol);
      if (!seat) continue;
      const officers = seat.officers || {};
      const decided = seat.choice ? ` ${escapeMarkdown(seat.name)} votes **${seat.choice}**.` : '';
      lines.push(`Signed for **${escapeMarkdown(seat.name)}** as an officer: ${number(officers[choice] || 0)} of ${number(officers.threshold || 0)} officers needed agree.${decided}`);
    }
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
