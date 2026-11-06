'use strict';

const crypto = require('crypto');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const resolveDiscordToken = require('../functions/resolveDiscordToken');
const discordEvents = require('../functions/discordScheduledEvents');
const poll = require('../functions/schedulePoll');

const INDEX_KEY = '/schedule/index';
const DEFAULT_TICK_MS = 15 * 1000;
const OPEN_CAP = 3;
const DM_CLOSED = 50007;

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

function dmClosed (error) {
  return !!(error && (error.code === DM_CLOSED || error.status === DM_CLOSED));
}

function pollKey (id) {
  return `/polls/${id}`;
}

/**
 * Availability polls that become a Discord scheduled event.
 * `/schedule open` names an event and who it’s for (people by name, a role,
 * or both) and posts a select menu of candidate times in that channel.
 * Named people are resolved on that server; a role is not listed out (holding
 * it is checked when they answer). When the poll closes, the person who
 * opened it is offered the times the most people can make, and the one they
 * pick is created on that same server. Discord user ids stay in this Store
 * and are never put on a message except as names people already show.
 */
class Schedule {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {Object} [settings.discord] settings.discord (token / secretsFile), for member lookup and event creation.
   * @param {string} [settings.timeZone] IANA zone for the default hours.
   * @param {Function} [settings.gateway] `() => discord.js Client|null`.
   * @param {Function} [settings.inviteUrl] `(purpose) => invite URL`, for a bot that cannot post or create events yet.
   * @param {Function} [settings.onScheduled] Called after an event is created (the events cache refresh).
   * @param {Function} [settings.deliver] `(userId, message) =>` DM the opener (tests).
   * @param {Function} [settings.post] `(channelId, message) =>` channel fallback when the DM is closed (tests).
   * @param {Function} [settings.edit] `(channelId, messageId, message) =>` edit the poll message (tests).
   * @param {Function} [settings.fetch] Discord REST (tests).
   * @param {Function} [settings.resolveToken]
   * @param {Function} [settings.now] Clock (tests).
   * @param {boolean} [settings.tick] `false` skips the background sweep (tests).
   * @param {number} [settings.tickMs]
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/schedule',
      discord: null,
      timeZone: poll.DEFAULT_ZONE,
      gateway: null,
      inviteUrl: null,
      onScheduled: null,
      deliver: null,
      post: null,
      edit: null,
      fetch: null,
      resolveToken: null,
      now: () => Date.now(),
      tick: true,
      tickMs: DEFAULT_TICK_MS
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.store = null;
    this._timer = null;
    this._sweeping = null;
    this._locks = new Map();
    this._roleCache = null;
    this._listeners = {};
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

  async start () {
    this.store = new Store({ name: 'GOON.VC:schedule', path: this.settings.path, persistent: true, verbosity: 1 });
    await startStore(this.store);
    await this.sweep();
    if (this.settings.tick !== false) {
      this._timer = setInterval(() => {
        this.sweep().catch((error) => this.emit('error', 'schedule', errorMessage(error)));
      }, this.settings.tickMs || DEFAULT_TICK_MS);
      if (this._timer.unref) this._timer.unref();
    }
    return this;
  }

  async stop () {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._sweeping) await this._sweeping.catch(() => {});
    if (this.store) await this.store.stop();
    this.store = null;
    return this;
  }

  /**
   * Open a poll. Throws (status 400 / 503) when the audience, the times, or
   * the close can’t be read; nothing is saved in that case.
   * @param {Object} input
   * @returns {Promise<Object>} the stored poll
   */
  async open (input) {
    const now = this.settings.now();
    const title = String(input.title || '').trim();
    if (!title) throw fail(400, 'Name the event.');
    if (title.length > 100) throw fail(400, 'The name has to be 100 characters or less.');
    const about = String(input.about || '').trim();
    if (about.length > 500) throw fail(400, 'Keep the notes to 500 characters.');
    const zone = poll.resolveZone(input.zone, this.settings.timeZone);
    const hours = poll.parseTimes(input.times);
    const days = input.days == null || input.days === '' ? poll.DEFAULT_DAYS : Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > poll.MAX_DAYS) throw fail(400, `Look ahead between 1 and ${poll.MAX_DAYS} days.`);
    const lengthHours = input.length == null || input.length === '' ? poll.DEFAULT_LENGTH_HOURS : Number(input.length);
    if (!Number.isInteger(lengthHours) || lengthHours < 1 || lengthHours > 8) throw fail(400, 'The event runs between 1 and 8 hours.');
    const closesAt = poll.parseCloses(input.closes, now);
    const voice = this._voice(input.voice);
    const guildName = String(input.guildName || 'this server').slice(0, 100);
    const location = String(input.where || guildName || 'Discord').trim().slice(0, 100) || 'Discord';
    const audience = await this._audience(input);
    const generated = poll.generateSlots({
      now,
      zone,
      days,
      hours,
      lengthMs: lengthHours * 60 * 60 * 1000,
      notBefore: closesAt
    });
    if (!generated.slots.length) {
      throw fail(400, 'No times fall after the poll closes. Shorten how long it stays open, or look further ahead.');
    }
    const record = {
      id: await this._id(),
      guildId: String(input.guildId),
      guildName,
      channelId: input.channelId ? String(input.channelId) : null,
      messageId: null,
      creatorId: String(input.creatorId),
      creatorName: String(input.creatorName || 'there').slice(0, 80),
      title,
      about: about || null,
      zone,
      lengthMs: lengthHours * 60 * 60 * 1000,
      people: audience.people,
      roles: audience.roles,
      voice,
      location,
      slots: generated.slots,
      truncated: generated.truncated,
      votes: {},
      result: null,
      closesAt: new Date(closesAt).toISOString(),
      status: 'open',
      offered: false,
      offerVia: null,
      event: null,
      createdAt: new Date(now).toISOString()
    };
    await this._reserve(record);
    this.emit('log', 'GOON.VC', `schedule: opened ${record.id} for ${record.people.length} ${record.people.length === 1 ? 'person' : 'people'} and ${record.roles.length} ${record.roles.length === 1 ? 'role' : 'roles'}`);
    return record;
  }

  /** Remember the channel message, so a later sweep can close it. */
  async attachMessage (id, messageId) {
    return this._lock(id, async () => {
      const record = await this._get(id);
      if (!record) return null;
      record.messageId = String(messageId);
      await this._save(record);
      return record;
    });
  }

  /** Drop a poll whose channel message never went out. */
  async discard (id) {
    return this._lock(id, async () => {
      await this.store.del(pollKey(id));
      await this._unindex(id);
      return null;
    });
  }

  /**
   * Replace one person’s answer. Only someone who was named, or who holds
   * one of the roles, and only while the poll is open.
   * @param {string} id
   * @param {{ userId: string, name: string, roleIds?: string[], slots: string[] }} voter
   * @returns {Promise<Object>}
   */
  async vote (id, voter) {
    return this._lock(id, async () => {
      const record = await this._require(id);
      if (record.status !== 'open') throw fail(409, 'This poll is closed.');
      const userId = String(voter.userId || '');
      if (!poll.canVote(record, userId, voter.roleIds)) throw fail(403, 'This poll is for the people and roles named on it.');
      const known = new Set(record.slots.map((slot) => slot.id));
      const slots = [...new Set((voter.slots || []).map(String))].filter((slot) => known.has(slot));
      if (!slots.length) throw fail(400, 'Pick a time from the list.');
      record.votes[userId] = {
        name: String(voter.name || 'Someone').slice(0, 80),
        slots,
        at: new Date(this.settings.now()).toISOString()
      };
      await this._save(record);
      return record;
    });
  }

  /**
   * Close the opener’s poll now. With no id, their only open poll on this
   * server; with several, the error names them.
   * @param {string|null} id
   * @param {string} userId
   * @param {string} guildId
   * @returns {Promise<Object>}
   */
  async close (id, userId, guildId) {
    const wanted = id ? String(id).trim().toLowerCase() : null;
    if (wanted && !/^[0-9a-f]{12}$/.test(wanted)) throw fail(400, 'That poll id doesn’t look right.');
    const record = wanted ? await this._get(wanted) : await this._onlyMine(userId, guildId);
    if (!record || record.guildId !== String(guildId)) throw fail(404, 'That poll isn’t on this server.');
    if (record.creatorId !== String(userId)) throw fail(403, 'Only the person who opened this poll can close it.');
    if (record.status === 'scheduled') throw fail(409, 'That poll already became an event.');
    if (record.status === 'cancelled' && record.offered) throw fail(409, 'That poll is already closed.');
    if (record.status === 'choosing' || record.status === 'cancelled') {
      if (record.offered) return record;
      return this._lock(record.id, async () => {
        const current = await this._require(record.id);
        if (!current.offered) await this._offer(current);
        return current;
      });
    }
    return this._lock(record.id, async () => {
      const current = await this._require(record.id);
      if (current.status !== 'open') return current;
      return this._finish(current);
    });
  }

  /**
   * The opener picks one offered time, or skips (`slotId` null). A second
   * pick of an event that already exists returns it unchanged.
   * @param {string} id
   * @param {string} userId
   * @param {string|null} slotId
   * @returns {Promise<Object>}
   */
  async pick (id, userId, slotId) {
    return this._lock(id, async () => {
      const record = await this._require(id);
      if (record.creatorId !== String(userId)) throw fail(403, 'Only the person who opened this poll can pick a time.');
      if (record.status === 'scheduled') return record;
      if (record.status !== 'choosing') throw fail(409, 'That poll isn’t ready to schedule.');
      if (slotId == null) {
        record.status = 'cancelled';
        await this._save(record);
        await this._edit(record.channelId, record.messageId, poll.skippedMessage(record)).catch((error) => {
          this.emit('error', 'schedule', errorMessage(error));
        });
        await this._unindex(record.id);
        return record;
      }
      const slot = record.slots.find((entry) => entry.id === slotId);
      const offered = (record.result || []).some((entry) => entry.id === slotId);
      if (!slot || !offered) throw fail(400, 'That time isn’t one of the overlaps.');
      if (Date.parse(slot.start) <= this.settings.now()) throw fail(409, 'That time has already passed. Pick another, or Don’t schedule.');
      const created = await this._createEvent(record, slot);
      if (!created.ok) {
        if (!created.status) throw fail(503, 'Discord isn’t configured, so I couldn’t create the event.');
        const missing = created.status === 403 || created.code === 50013 || created.code === 50001;
        if (missing) {
          const invite = await this.invite('events');
          throw fail(403, invite
            ? `I can’t create events on that server yet. A manager can allow it here: ${invite} Then pick the time again.`
            : 'I can’t create events on that server yet. Then pick the time again.');
        }
        if (created.status === 400 && created.error) throw fail(400, `Discord refused the event: ${String(created.error).slice(0, 200)}`);
        throw fail(502, 'Discord didn’t accept the event. Try again in a moment.');
      }
      record.status = 'scheduled';
      record.event = {
        id: created.event.id,
        url: `https://discord.com/events/${record.guildId}/${created.event.id}`,
        start: created.event.scheduledStartTime || slot.start,
        label: slot.label
      };
      await this._save(record);
      await this._edit(record.channelId, record.messageId, poll.scheduledMessage(record)).catch((error) => {
        this.emit('error', 'schedule', errorMessage(error));
      });
      await this._unindex(record.id);
      this.emit('log', 'GOON.VC', `schedule: ${record.id} became an event`);
      if (typeof this.settings.onScheduled === 'function') {
        Promise.resolve(this.settings.onScheduled(record)).catch((error) => {
          this.emit('error', 'schedule', errorMessage(error));
        });
      }
      return record;
    });
  }

  /** Close polls whose time has come, and retry an offer that didn’t go out. */
  async sweep () {
    if (this._sweeping) return this._sweeping;
    this._sweeping = this._sweep().finally(() => { this._sweeping = null; });
    return this._sweeping;
  }

  async _sweep () {
    const index = (await this.store.get(INDEX_KEY)) || { ids: [] };
    for (const id of index.ids.slice()) {
      await this._lock(id, async () => {
        const record = await this._get(id);
        if (!record || record.status === 'scheduled' || (record.status === 'cancelled' && record.offered)) {
          await this._unindex(id);
          return;
        }
        if (record.status === 'open' && Date.parse(record.closesAt) <= this.settings.now()) await this._finish(record);
        else if ((record.status === 'choosing' || record.status === 'cancelled') && !record.offered) await this._offer(record);
      });
    }
  }

  /**
   * Invite URL that adds Manage Events (and posting) to the bot.
   * @param {string} [purpose]
   * @returns {Promise<string|null>}
   */
  async invite (purpose) {
    if (typeof this.settings.inviteUrl !== 'function') return null;
    try {
      return await this.settings.inviteUrl(purpose) || null;
    } catch (_) {
      return null;
    }
  }

  async _finish (record) {
    if (record.status !== 'open') return record;
    record.result = poll.rankOverlaps(record);
    record.status = record.result.length ? 'choosing' : 'cancelled';
    record.offered = false;
    await this._save(record);
    const message = record.status === 'choosing' ? poll.closedMessage(record) : poll.cancelledMessage(record);
    await this._edit(record.channelId, record.messageId, message).catch((error) => {
      this.emit('error', 'schedule', errorMessage(error));
    });
    await this._offer(record);
    return record;
  }

  async _offer (record) {
    if (record.offered) return record;
    const message = poll.offerMessage(record, record.guildName);
    let via = null;
    try {
      await this._deliver(record.creatorId, message);
      via = 'dm';
    } catch (error) {
      if (!dmClosed(error)) {
        this.emit('error', 'schedule offer', errorMessage(error));
        await this._save(record);
        return record;
      }
      try {
        await this._send(record.channelId, poll.offerMessage(record, record.guildName, { publicOffer: true }));
        via = 'channel';
      } catch (postError) {
        this.emit('error', 'schedule offer', errorMessage(postError));
        await this._save(record);
        return record;
      }
    }
    record.offered = true;
    record.offerVia = via;
    await this._save(record);
    if (record.status !== 'choosing') await this._unindex(record.id);
    return record;
  }

  async _createEvent (record, slot) {
    const token = this._token();
    if (!token) return { ok: false, status: 0, error: 'missing bot token' };
    const draft = poll.eventDraft(record, slot);
    return discordEvents.createGuildScheduledEvent({
      token,
      guildId: record.guildId,
      event: draft,
      fetch: this.settings.fetch
    });
  }

  async _audience (input) {
    this._roleCache = null;
    const parsed = poll.parseAudience(input.people);
    if (parsed.userIds.length + parsed.queries.length > poll.MAX_PEOPLE) {
      throw fail(400, `Name up to ${poll.MAX_PEOPLE} people. For a bigger group, pick a role.`);
    }
    const guild = this._guild(input.guildId, input.guild);
    const known = poll.membersFromGuild(guild);
    const roles = [];
    const seenRoles = new Set();
    const requested = (input.roles || []).map((role) => ({ id: String(role.id), name: role.name || null }))
      .concat(parsed.roleIds.map((id) => ({ id: String(id), name: null })));
    for (const role of requested) {
      if (seenRoles.has(role.id)) continue;
      seenRoles.add(role.id);
      let name = role.name;
      if (!name) {
        const found = poll.rolesFromGuild(guild).concat(await this._roles(input.guildId)).find((entry) => entry.id === role.id);
        if (!found) throw fail(400, 'I can’t see one of those roles on this server.');
        name = found.name;
      }
      roles.push({ id: role.id, name: String(name).slice(0, 100) });
    }
    const people = [];
    const seen = new Set();
    const add = (member) => {
      if (!member || seen.has(member.id)) return;
      seen.add(member.id);
      people.push({ id: member.id, name: member.name });
    };
    for (const id of parsed.userIds) {
      const cached = known.find((member) => member.id === id);
      if (cached) {
        add(cached);
        continue;
      }
      const fetched = await this._member(input.guildId, id);
      if (!fetched) throw fail(400, 'I can’t add one of those mentions to the poll.');
      if (fetched.bot) throw fail(400, 'Bots aren’t on the poll.');
      add(fetched);
    }
    const problems = [];
    for (const query of parsed.queries) {
      const cached = poll.matchQuery(query, known);
      if (cached.member) {
        add(cached.member);
        continue;
      }
      if (cached.ambiguous) {
        problems.push(poll.ambiguousMessage(cached));
        continue;
      }
      const found = await this._search(input.guildId, query);
      const match = poll.matchQuery(query, known.concat(found));
      if (match.member) add(match.member);
      else if (match.ambiguous) problems.push(poll.ambiguousMessage(match));
      else problems.push(`I couldn’t find “${pollText(match.missing)}” on this server. Use their @handle or a mention.`);
    }
    if (problems.length) throw fail(400, problems.slice(0, 3).join(' '));
    if (!people.length && !roles.length) throw fail(400, 'Name someone or pick a role, so the poll knows who it’s for.');
    return { people, roles };
  }

  _voice (channel) {
    if (!channel) return null;
    const type = Number(channel.type);
    if (type !== 2 && type !== 13) throw fail(400, 'Pick a voice or stage channel.');
    if (!channel.id) throw fail(400, 'Pick a voice or stage channel.');
    return { id: String(channel.id), name: String(channel.name || 'voice').slice(0, 100), type };
  }

  async _reserve (record) {
    await this._lock('index', async () => {
      const index = (await this.store.get(INDEX_KEY)) || { ids: [] };
      let open = 0;
      for (const id of index.ids) {
        const existing = await this.store.get(pollKey(id));
        if (existing && existing.status === 'open' && existing.creatorId === record.creatorId && existing.guildId === record.guildId) open += 1;
      }
      if (open >= OPEN_CAP) throw fail(400, `You already have ${OPEN_CAP} open polls on this server. Close one with \`/schedule close\`.`);
      await this.store.set(pollKey(record.id), record);
      index.ids.push(record.id);
      await this.store.set(INDEX_KEY, index);
    });
  }

  async _onlyMine (userId, guildId) {
    const mine = await this._mine(userId, guildId);
    const open = mine.filter((record) => record.status === 'open' || record.status === 'choosing');
    if (!open.length) throw fail(404, 'You have no open poll on this server.');
    if (open.length === 1) return open[0];
    const lines = open.map((record) => `• ${record.title} — \`/schedule close poll:${record.id}\``);
    throw fail(400, `You have more than one open poll.\n${lines.join('\n')}`);
  }

  async _mine (userId, guildId) {
    const index = (await this.store.get(INDEX_KEY)) || { ids: [] };
    const records = [];
    for (const id of index.ids) {
      const record = await this._get(id);
      if (record && record.creatorId === String(userId) && record.guildId === String(guildId)) records.push(record);
    }
    return records;
  }

  async _id () {
    for (let attempt = 0; attempt < 4; attempt++) {
      const id = crypto.randomBytes(6).toString('hex');
      if (!(await this.store.get(pollKey(id)))) return id;
    }
    throw fail(500, 'Could not start the poll. Try again.');
  }

  async _get (id) {
    if (!/^[0-9a-f]{12}$/.test(String(id || ''))) return null;
    return this.store.get(pollKey(id));
  }

  async _require (id) {
    const record = await this._get(id);
    if (!record) throw fail(404, 'That poll is no longer here.');
    return record;
  }

  async _save (record) {
    await this.store.set(pollKey(record.id), record);
    return record;
  }

  async _unindex (id) {
    await this._lock('index', async () => {
      const index = (await this.store.get(INDEX_KEY)) || { ids: [] };
      const ids = index.ids.filter((entry) => entry !== id);
      if (ids.length !== index.ids.length) await this.store.set(INDEX_KEY, { ids });
    });
  }

  _guild (guildId, fallback) {
    try {
      const client = this._client();
      const live = client && client.guilds && client.guilds.cache && client.guilds.cache.get(String(guildId));
      if (live) return live;
    } catch (_) { /* the interaction’s guild is enough */ }
    return fallback || null;
  }

  _client () {
    return typeof this.settings.gateway === 'function' ? this.settings.gateway() : null;
  }

  _token () {
    const resolve = this.settings.resolveToken || resolveDiscordToken;
    const auth = resolve(this.settings.discord || {});
    return auth && auth.token ? auth.token : null;
  }

  _discordOpts () {
    return this.settings.fetch ? { fetch: this.settings.fetch, retries: 1 } : { retries: 1 };
  }

  async _search (guildId, query) {
    const text = String(query.handle || query.name || '').trim().slice(0, 32);
    if (!text) return [];
    const token = this._token();
    if (!token) throw fail(503, 'Discord lookup is not available right now. Mention them, or try again in a moment.');
    const params = new URLSearchParams({ query: text, limit: '10' });
    const res = await discordEvents.discordGet(`/guilds/${guildId}/members/search?${params}`, token, this._discordOpts());
    if (res.status !== 200 || !Array.isArray(res.json)) throw fail(503, 'Discord lookup is not available right now.');
    return res.json.map(poll.memberEntry).filter((member) => member && !member.bot);
  }

  async _member (guildId, userId) {
    const token = this._token();
    if (!token) return null;
    const res = await discordEvents.discordGet(`/guilds/${guildId}/members/${userId}`, token, this._discordOpts());
    if (res.status !== 200 || !res.json) return null;
    return poll.memberEntry(res.json);
  }

  async _roles (guildId) {
    if (this._roleCache && this._roleCache.guildId === String(guildId)) return this._roleCache.roles;
    const token = this._token();
    if (!token) return [];
    const res = await discordEvents.discordGet(`/guilds/${guildId}/roles`, token, this._discordOpts());
    if (res.status !== 200 || !Array.isArray(res.json)) return [];
    const roles = res.json.map((role) => ({ id: String(role.id), name: String(role.name || 'role') }));
    this._roleCache = { guildId: String(guildId), roles };
    return roles;
  }

  async _deliver (userId, message) {
    if (typeof this.settings.deliver === 'function') return this.settings.deliver(userId, message);
    const client = this._client();
    if (!client || !client.users) throw fail(503, 'Discord is not connected.');
    const cached = client.users.cache && client.users.cache.get(String(userId));
    const user = cached || await client.users.fetch(String(userId));
    return user.send(Object.assign({ allowedMentions: { parse: [] } }, message));
  }

  async _send (channelId, message) {
    if (!channelId) throw fail(503, 'The poll has no channel.');
    if (typeof this.settings.post === 'function') return this.settings.post(channelId, message);
    const channel = await this._channel(channelId);
    return channel.send(Object.assign({ allowedMentions: { parse: [] } }, message));
  }

  async _edit (channelId, messageId, message) {
    if (!messageId) return null;
    if (typeof this.settings.edit === 'function') return this.settings.edit(channelId, messageId, message);
    const channel = await this._channel(channelId);
    const existing = await channel.messages.fetch(String(messageId));
    return existing.edit(Object.assign({ allowedMentions: { parse: [] } }, message));
  }

  async _channel (channelId) {
    const client = this._client();
    if (!client || !client.channels) throw fail(503, 'Discord is not connected.');
    const cached = client.channels.cache && client.channels.cache.get(String(channelId));
    return cached || client.channels.fetch(String(channelId));
  }

  _lock (key, fn) {
    const prev = this._locks.get(key) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    this._locks.set(key, run.then(() => null, () => null));
    return run;
  }
}

function pollText (value) {
  return String(value || '').replace(/[`*_~]/g, '');
}

module.exports = Schedule;
module.exports.OPEN_CAP = OPEN_CAP;
