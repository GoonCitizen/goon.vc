'use strict';

/**
 * Availability polls for `/schedule`: who was asked (names and roles), the
 * candidate times, and which of those times the most people can make.
 * Discord delivery and the scheduled-event POST live in services/schedule.js.
 */

const DEFAULT_ZONE = 'America/Chicago';
const DEFAULT_HOURS = Object.freeze([{ hour: 16, minute: 0 }, { hour: 19, minute: 0 }, { hour: 22, minute: 0 }]);
const DEFAULT_DAYS = 7;
const DEFAULT_LENGTH_HOURS = 2;
const DEFAULT_CLOSE_MS = 24 * 60 * 60 * 1000;
const MIN_CLOSE_MS = 15 * 60 * 1000;
const MAX_CLOSE_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_DAYS = 14;
const MAX_TIMES = 8;
const MAX_PEOPLE = 25;
const MAX_SLOTS = 25;
const OFFER_LIMIT = 5;
const ACTION_ROW = 1;
const BUTTON = 2;
const STRING_SELECT = 3;
const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3 };
const RELATIVE_TIME = /^in\s+(\d{1,4})\s*(m|mins?|minutes?|h|hrs?|hours?|d|days?)$/i;
const UNIT_MS = { m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
const CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i;
const MENTION = /<@!?(\d{5,25})>|<@&(\d{5,25})>/g;
const HANDLE = /^[a-z0-9_.]{2,32}$/i;

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function escapeMarkdown (value) {
  return String(value == null ? '' : value).replace(/[\\*_~`|>[\]]/g, '\\$&');
}

function clip (text, limit = 1900) {
  const value = String(text);
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function joinList (parts) {
  if (parts.length <= 1) return parts[0] || '';
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(', ')}, and ${parts[parts.length - 1]}`;
}

function lengthPhrase (ms) {
  const hours = Math.round(Number(ms) / (60 * 60 * 1000));
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

function unix (iso) {
  return Math.floor(Date.parse(iso) / 1000);
}

/**
 * A clock time: `16`, `16:30`, `4pm`, `7:30 pm`.
 * @param {string} text
 * @returns {{ hour: number, minute: number }|null}
 */
function parseClock (text) {
  const match = CLOCK.exec(String(text || '').trim());
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = match[2] == null ? 0 : Number(match[2]);
  const suffix = match[3] ? match[3].toLowerCase() : null;
  if (minute > 59) return null;
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'pm' && hour !== 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) return null;
  return { hour, minute };
}

/**
 * Hours offered each day. Empty text uses `fallback` (4pm, 7pm, 10pm).
 * @param {string|null} text
 * @param {Array<{ hour: number, minute: number }>} [fallback]
 * @returns {Array<{ hour: number, minute: number }>}
 */
function parseTimes (text, fallback = DEFAULT_HOURS) {
  const raw = String(text || '').trim();
  if (!raw) return fallback.map((clock) => ({ hour: clock.hour, minute: clock.minute }));
  const chunks = raw.split(/[,/]+/).flatMap((chunk) => {
    const piece = chunk.trim();
    if (!piece) return [];
    return parseClock(piece) ? [piece] : piece.split(/\s+/).filter(Boolean);
  });
  const clocks = [];
  const seen = new Set();
  for (const chunk of chunks) {
    const clock = parseClock(chunk);
    if (!clock) throw fail(400, `I couldn’t read “${chunk}” as a time. Use hours like 16, 19, or 7pm.`);
    const key = `${clock.hour}:${clock.minute}`;
    if (seen.has(key)) continue;
    seen.add(key);
    clocks.push(clock);
  }
  if (!clocks.length) throw fail(400, 'Name at least one time of day.');
  if (clocks.length > MAX_TIMES) throw fail(400, `Offer up to ${MAX_TIMES} times a day.`);
  clocks.sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  return clocks;
}

/**
 * When voting ends: "in 2 days", a date, or the default (24 hours).
 * @param {string|null} text
 * @param {number} now epoch ms
 * @returns {number} epoch ms
 */
function parseCloses (text, now) {
  const value = String(text || '').trim();
  const at = !value ? now + DEFAULT_CLOSE_MS : (() => {
    const relative = RELATIVE_TIME.exec(value);
    return relative ? now + Number(relative[1]) * UNIT_MS[relative[2][0].toLowerCase()] : Date.parse(value);
  })();
  if (!Number.isFinite(at)) throw fail(400, 'I couldn’t read when the poll closes. Use something like “in 2 days” or 2026-11-01T18:00Z.');
  if (at - now < MIN_CLOSE_MS) throw fail(400, 'Leave the poll open at least 15 minutes.');
  if (at - now > MAX_CLOSE_MS) throw fail(400, 'A poll can stay open up to 14 days.');
  return at;
}

/**
 * IANA zone. Empty uses `fallback`. A name Intl doesn’t know is refused,
 * rather than quietly swapped for Central Time.
 * @param {string|null} text
 * @param {string} [fallback]
 * @returns {string}
 */
function resolveZone (text, fallback = DEFAULT_ZONE) {
  const raw = String(text || '').trim();
  const use = raw || fallback || DEFAULT_ZONE;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: use }).resolvedOptions().timeZone;
  } catch (_) {
    throw fail(400, `“${raw || use}” isn’t a time zone I know. Use one like America/Chicago.`);
  }
}

/**
 * Names, @handles, user mentions, and role mentions from the `people` text.
 * Commas separate display names that contain spaces.
 * @param {string|null} text
 * @returns {{ userIds: string[], roleIds: string[], queries: Array<{ handle?: string, name?: string }> }}
 */
function parseAudience (text) {
  const userIds = [];
  const roleIds = [];
  const queries = [];
  const rest = String(text || '').replace(MENTION, (match, user, role) => {
    if (user) userIds.push(user);
    if (role) roleIds.push(role);
    return ' ';
  });
  for (const part of rest.split(/[,;\n]+/)) {
    const piece = part.trim();
    if (!piece) continue;
    const handles = [...piece.matchAll(/(?:^|\s)@([a-z0-9_.]{2,32})/gi)].map((match) => match[1]);
    const onlyHandles = handles.length > 0 && piece.replace(/@([a-z0-9_.]{2,32})/gi, '').trim() === '';
    if (onlyHandles) {
      for (const handle of handles) queries.push({ handle });
      continue;
    }
    const token = piece.replace(/^@/, '');
    if (HANDLE.test(token)) queries.push({ handle: token });
    else queries.push({ name: token });
  }
  return {
    userIds: [...new Set(userIds)],
    roleIds: [...new Set(roleIds)],
    queries
  };
}

/**
 * One guild member as `{ id, handle, name, names }`, or `{ bot: true }` for a bot.
 * @param {Object} member discord.js GuildMember or a raw API member
 * @returns {Object|null}
 */
function memberEntry (member) {
  const user = (member && member.user) || {};
  if (!user.id) return null;
  if (user.bot) return { bot: true, id: String(user.id) };
  const nick = member.nick || member.nickname || null;
  const global = user.global_name || user.globalName || null;
  const username = user.username || null;
  return {
    id: String(user.id),
    handle: username ? String(username) : '',
    name: String(nick || global || username || user.id),
    names: [nick, global, username].filter(Boolean).map((name) => String(name).toLowerCase())
  };
}

function cacheValues (cache) {
  if (!cache || typeof cache.values !== 'function') return [];
  return [...cache.values()];
}

/** Members the gateway has already seen in this guild. Bots left out. */
function membersFromGuild (guild) {
  const cache = guild && guild.members && guild.members.cache;
  return cacheValues(cache).map(memberEntry).filter((member) => member && !member.bot);
}

/** Roles on the guild object (id and name). */
function rolesFromGuild (guild) {
  const cache = guild && guild.roles && guild.roles.cache;
  return cacheValues(cache)
    .filter((role) => role && role.id)
    .map((role) => ({ id: String(role.id), name: String(role.name || 'role') }));
}

/**
 * The one member `query` names, or `{ ambiguous }` / `{ missing }`.
 * Exact @handle wins, then an exact display name, then a unique prefix.
 * @param {{ handle?: string, name?: string }} query
 * @param {Array<{ id: string, handle: string, name: string, names: string[] }>} members
 * @returns {{ member?: Object, ambiguous?: Object[], missing?: string, text?: string }}
 */
function matchQuery (query, members) {
  const text = String((query && (query.handle || query.name)) || '').trim();
  const wanted = text.toLowerCase();
  if (!wanted) return { missing: 'that name', text };
  const list = members || [];
  const exactHandle = list.filter((member) => member.handle && member.handle.toLowerCase() === wanted);
  if (exactHandle.length === 1) return { member: exactHandle[0] };
  if (exactHandle.length > 1) return { ambiguous: exactHandle, text };
  const exactName = list.filter((member) => member.names.some((name) => name === wanted));
  if (exactName.length === 1) return { member: exactName[0] };
  if (exactName.length > 1) return { ambiguous: exactName, text };
  const starts = list.filter((member) => member.names.some((name) => name.startsWith(wanted)));
  if (starts.length === 1) return { member: starts[0] };
  if (starts.length > 1) return { ambiguous: starts, text };
  return { missing: text, text };
}

/** “Rat” matches Rat (@ratgrot) and Rat (@rat2). Use an @handle. */
function ambiguousMessage (match) {
  const shown = (match.ambiguous || []).slice(0, 3).map((member) => {
    const handle = member.handle ? ` (@${member.handle})` : '';
    return `${escapeMarkdown(member.name)}${handle}`;
  });
  const extra = (match.ambiguous || []).length - shown.length;
  const list = extra > 0 ? `${joinList(shown)}, and ${extra} more` : joinList(shown);
  return `“${escapeMarkdown(match.text)}” matches ${list}. Use an @handle.`;
}

function wallParts (utcMs, timeZone) {
  const format = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
  const map = {};
  for (const part of format.formatToParts(new Date(utcMs))) {
    if (part.type !== 'literal') map[part.type] = part.value;
  }
  let hour = Number(map.hour);
  let year = Number(map.year);
  let month = Number(map.month);
  let day = Number(map.day);
  // Some engines report midnight as 24:00 on the previous civil date.
  if (hour === 24) {
    hour = 0;
    const rolled = new Date(Date.UTC(year, month - 1, day + 1));
    year = rolled.getUTCFullYear();
    month = rolled.getUTCMonth() + 1;
    day = rolled.getUTCDate();
  }
  return { year, month, day, hour, minute: Number(map.minute) };
}

/** UTC epoch ms for a wall-clock time in `timeZone`. */
function zonedToUtc ({ year, month, day, hour, minute }, timeZone) {
  let utc = Date.UTC(year, month - 1, day, hour, minute);
  for (let pass = 0; pass < 4; pass++) {
    const wall = wallParts(utc, timeZone);
    const wanted = Date.UTC(year, month - 1, day, hour, minute);
    const got = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    if (wanted === got) return utc;
    utc += wanted - got;
  }
  return utc;
}

function addDays (date, days) {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
}

function formatWhen (utcMs, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }).format(new Date(utcMs));
  } catch (_) {
    return new Date(utcMs).toISOString();
  }
}

/**
 * Candidate blocks: each of `hours` on each of the next `days` civil dates
 * in `zone`, starting today, that begin after `notBefore`. At most 25,
 * earliest first (a Discord select menu holds 25 options).
 * @param {Object} opts
 * @param {number} opts.now
 * @param {string} opts.zone
 * @param {number} opts.days
 * @param {Array<{ hour: number, minute: number }>} opts.hours
 * @param {number} opts.lengthMs
 * @param {number} opts.notBefore epoch ms; slots at or before this are skipped
 * @returns {{ slots: Array<{ id: string, start: string, end: string, label: string }>, truncated: boolean }}
 */
function generateSlots (opts) {
  const zone = opts.zone;
  const startDay = wallParts(opts.now, zone);
  const hours = (opts.hours || []).slice().sort((a, b) => a.hour - b.hour || a.minute - b.minute);
  const slots = [];
  let truncated = false;
  for (let offset = 0; offset < opts.days; offset++) {
    const date = addDays(startDay, offset);
    for (const clock of hours) {
      const start = zonedToUtc({ year: date.year, month: date.month, day: date.day, hour: clock.hour, minute: clock.minute }, zone);
      if (start <= opts.notBefore) continue;
      if (slots.length >= MAX_SLOTS) {
        truncated = true;
        continue;
      }
      const end = start + opts.lengthMs;
      slots.push({
        id: slots.length.toString(16).padStart(2, '0'),
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        label: formatWhen(start, zone)
      });
    }
  }
  return { slots, truncated };
}

/**
 * Times the most people marked, fullest first and earlier first on a tie.
 * A person who marked the same time twice counts once. Times nobody marked
 * are left out. At most `limit` (the offer is a row of buttons).
 * @param {Object} poll
 * @param {number} [limit]
 * @returns {Array<{ id: string, start: string, end: string, label: string, count: number, names: string[] }>}
 */
function rankOverlaps (poll, limit = OFFER_LIMIT) {
  const byId = new Map((poll.slots || []).map((slot) => [slot.id, Object.assign({}, slot, { names: [] })]));
  for (const vote of Object.values(poll.votes || {})) {
    const seen = new Set();
    for (const id of vote.slots || []) {
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      if (vote.name) byId.get(id).names.push(vote.name);
    }
  }
  return [...byId.values()]
    .map((slot) => ({
      id: slot.id,
      start: slot.start,
      end: slot.end,
      label: slot.label,
      count: slot.names.length,
      names: slot.names.slice().sort((a, b) => a.localeCompare(b))
    }))
    .filter((slot) => slot.count > 0)
    .sort((a, b) => b.count - a.count || String(a.start).localeCompare(String(b.start)))
    .slice(0, limit);
}

function audienceParts (poll) {
  return (poll.roles || []).map((role) => `**${escapeMarkdown(role.name)}**`)
    .concat((poll.people || []).map((person) => escapeMarkdown(person.name)));
}

function audiencePhrase (poll) {
  const parts = audienceParts(poll);
  if (!parts.length) return 'the people you named';
  const listed = joinList(parts);
  if (listed.length <= 700) return listed;
  const bits = [];
  if ((poll.roles || []).length) bits.push((poll.roles.length === 1 ? '1 role' : `${poll.roles.length} roles`));
  if ((poll.people || []).length) bits.push((poll.people.length === 1 ? '1 person' : `${poll.people.length} people`));
  return bits.join(' and ');
}

function answeredNames (poll) {
  return Object.values(poll.votes || {}).map((vote) => vote.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

function waitingNames (poll) {
  const answered = new Set(Object.keys(poll.votes || {}));
  return (poll.people || []).filter((person) => !answered.has(person.id)).map((person) => person.name).sort((a, b) => a.localeCompare(b));
}

function pollContent (poll) {
  const answered = Object.keys(poll.votes || {}).length;
  const lines = [
    `**When can you make ${escapeMarkdown(poll.title)}?**`,
    `For ${audiencePhrase(poll)}.`,
    `Pick every time you can. Each block is ${lengthPhrase(poll.lengthMs)}, in ${poll.zone}. Your latest answer replaces the one before.`,
    `Closes <t:${unix(poll.closesAt)}:R> (<t:${unix(poll.closesAt)}:f>).`,
    answered ? `**${answered}** ${answered === 1 ? 'person has' : 'people have'} answered.` : 'Nobody has answered yet.'
  ];
  if (poll.truncated) lines.push('Showing the first 25 times.');
  return clip(lines.join('\n'));
}

/** The channel message: one multi-select of the candidate times. */
function pollMessage (poll) {
  const message = { content: pollContent(poll), components: [] };
  if (!poll.slots || !poll.slots.length) return message;
  message.components = [{
    type: ACTION_ROW,
    components: [{
      type: STRING_SELECT,
      custom_id: `sched:vote:${poll.id}`,
      placeholder: 'Every time you can make',
      min_values: 1,
      max_values: Math.min(MAX_SLOTS, poll.slots.length),
      options: poll.slots.map((slot) => ({
        label: slot.label.slice(0, 100),
        value: slot.id,
        description: lengthPhrase(poll.lengthMs).slice(0, 100)
      }))
    }]
  }];
  return message;
}

function rows (buttons) {
  const out = [];
  for (let index = 0; index < buttons.length; index += 5) {
    out.push({ type: ACTION_ROW, components: buttons.slice(index, index + 5) });
  }
  return out;
}

function offerContent (poll, guildName, opts = {}) {
  const answered = answeredNames(poll);
  const named = (poll.people || []).length;
  const roles = (poll.roles || []).length;
  const lines = [`**Best times for ${escapeMarkdown(poll.title)}**`];
  if (!answered.length) {
    lines.push('Nobody answered, so there’s no overlap to schedule.');
  } else if (!roles && named) {
    lines.push(`${answered.length} of ${named} answered: ${joinList(answered.map(escapeMarkdown))}.`);
  } else {
    lines.push(`${answered.length} ${answered.length === 1 ? 'person' : 'people'} answered: ${joinList(answered.map(escapeMarkdown))}.`);
  }
  const ranked = poll.result || [];
  ranked.forEach((slot, index) => {
    lines.push(`**${index + 1}. ${escapeMarkdown(slot.label)}** — ${slot.count} ${slot.count === 1 ? 'person' : 'people'} (${joinList(slot.names.map(escapeMarkdown))})`);
  });
  const waiting = waitingNames(poll);
  if (waiting.length) lines.push(`Haven’t answered: ${joinList(waiting.map(escapeMarkdown))}.`);
  if (ranked.length) lines.push(`Pick one and I’ll create the event on **${escapeMarkdown(guildName || poll.guildName || 'this server')}**.`);
  if (opts.publicOffer) lines.push('I couldn’t DM you, so the choices are here. Only you can pick.');
  return clip(lines.join('\n'));
}

/**
 * What the opener receives when the poll closes: the fullest times as
 * buttons, plus Don’t schedule. No buttons when nobody answered.
 * @param {Object} poll
 * @param {string} [guildName]
 * @param {{ publicOffer?: boolean }} [opts]
 * @returns {{ content: string, components: Array }}
 */
function offerMessage (poll, guildName, opts = {}) {
  const ranked = (poll.result || []).slice(0, OFFER_LIMIT);
  const buttons = ranked.map((slot, index) => ({
    type: BUTTON,
    style: index === 0 ? BUTTON_STYLE.success : BUTTON_STYLE.primary,
    label: `${slot.label} · ${slot.count}`.slice(0, 80),
    custom_id: `sched:pick:${poll.id}:${slot.id}`
  }));
  if (buttons.length) {
    buttons.push({ type: BUTTON, style: BUTTON_STYLE.secondary, label: 'Don’t schedule', custom_id: `sched:skip:${poll.id}` });
  }
  return { content: offerContent(poll, guildName, opts), components: rows(buttons) };
}

/** Channel copy once voting has ended and the opener still has to pick. */
function closedMessage (poll) {
  return {
    content: clip(`**${escapeMarkdown(poll.title)}** — poll closed <t:${unix(poll.closesAt)}:R>. ${escapeMarkdown(poll.creatorName || 'The opener')} has the best overlaps.`),
    components: []
  };
}

/** Channel copy when the poll ended with nothing to schedule. */
function cancelledMessage (poll) {
  return {
    content: clip(`**${escapeMarkdown(poll.title)}** — poll closed. Nobody answered, so there’s no event.`),
    components: []
  };
}

/** Channel copy when the opener declines every overlap. */
function skippedMessage (poll) {
  return {
    content: clip(`**${escapeMarkdown(poll.title)}** — closed with no event.`),
    components: []
  };
}

/** Channel copy once the event exists. */
function scheduledMessage (poll) {
  const when = poll.event && poll.event.label ? escapeMarkdown(poll.event.label) : 'the time you picked';
  const url = poll.event && poll.event.url ? `\n${poll.event.url}` : '';
  return {
    content: clip(`**${escapeMarkdown(poll.title)}** is set for ${when}.${url}`),
    components: []
  };
}

/**
 * What replaces the opener’s buttons after they pick or skip.
 * @param {Object} poll
 * @param {string} [siteUrl]
 * @returns {{ content: string, components: Array }}
 */
function choiceMessage (poll, siteUrl) {
  if (!poll || poll.status !== 'scheduled' || !poll.event) {
    return { content: `Closed **${escapeMarkdown(poll && poll.title)}** with no event.`, components: [] };
  }
  const board = siteUrl ? `\nThe week board: <${String(siteUrl).replace(/\/+$/, '')}/events>` : '';
  return {
    content: clip(`**${escapeMarkdown(poll.title)}** is on the **${escapeMarkdown(poll.guildName || 'server')}** calendar for ${escapeMarkdown(poll.event.label || 'that time')}.\n${poll.event.url}${board}`),
    components: []
  };
}

/** Private reply when the poll message is up. */
function openedText (poll) {
  return clip([
    `The poll for **${escapeMarkdown(poll.title)}** is in this channel.`,
    `Asked ${audiencePhrase(poll)}. It closes <t:${unix(poll.closesAt)}:R>.`,
    `I’ll message you with the best overlaps, and the one you pick goes on **${escapeMarkdown(poll.guildName || 'this server')}**’s calendar.`
  ].join('\n'));
}

/**
 * Fields for the Discord scheduled event the opener picked.
 * Names only: display names and role names, never account ids.
 * @param {Object} poll
 * @param {Object} slot
 * @returns {Object}
 */
function eventDraft (poll, slot) {
  const ranked = (poll.result || []).find((entry) => entry.id === slot.id);
  const lines = [];
  if (poll.about) lines.push(poll.about);
  if (ranked && ranked.names.length) lines.push(`Can make it: ${ranked.names.join(', ')}.`);
  const asked = [];
  if ((poll.roles || []).length) asked.push(poll.roles.map((role) => role.name).join(', '));
  if ((poll.people || []).length) asked.push(poll.people.map((person) => person.name).join(', '));
  if (asked.length) lines.push(`Asked ${asked.join('; ')}.`);
  if (poll.voice && poll.voice.name) lines.push(`Channel: ${poll.voice.name}.`);
  lines.push('Scheduled from a goon.vc poll.');
  const voice = poll.voice || null;
  const type = voice ? Number(voice.type) : null;
  return {
    name: String(poll.title || '').slice(0, 100),
    description: lines.join('\n').slice(0, 1000),
    scheduledStartTime: slot.start,
    scheduledEndTime: slot.end,
    entityType: type === 13 ? 1 : (voice ? 2 : 3),
    channelId: voice ? voice.id : null,
    location: voice ? null : String(poll.location || poll.guildName || 'Discord').slice(0, 100)
  };
}

/** Whether this member was named or holds one of the poll’s roles. */
function canVote (poll, userId, roleIds) {
  const id = String(userId || '');
  if ((poll.people || []).some((person) => person.id === id)) return true;
  const have = new Set((roleIds || []).map(String));
  return (poll.roles || []).some((role) => have.has(role.id));
}

module.exports = {
  DEFAULT_ZONE,
  DEFAULT_HOURS,
  DEFAULT_DAYS,
  DEFAULT_LENGTH_HOURS,
  DEFAULT_CLOSE_MS,
  MIN_CLOSE_MS,
  MAX_CLOSE_MS,
  MAX_DAYS,
  MAX_TIMES,
  MAX_PEOPLE,
  MAX_SLOTS,
  OFFER_LIMIT,
  parseClock,
  parseTimes,
  parseCloses,
  resolveZone,
  parseAudience,
  memberEntry,
  membersFromGuild,
  rolesFromGuild,
  matchQuery,
  ambiguousMessage,
  zonedToUtc,
  generateSlots,
  rankOverlaps,
  canVote,
  pollMessage,
  offerMessage,
  closedMessage,
  cancelledMessage,
  skippedMessage,
  scheduledMessage,
  choiceMessage,
  openedText,
  eventDraft
};
