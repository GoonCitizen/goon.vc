'use strict';

const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const discordEvents = require('../functions/discordScheduledEvents');
const resolveDiscordToken = require('../functions/resolveDiscordToken');

const PATH = '/services/activity';
const USERS_KEY = '/activity/users';
const CHANNELS_KEY = '/activity/channels';
const STATUS_KEY = '/activity/status';
const DISCORD_EPOCH = 1420070400000n;
const PAGE = 100;
const HOUR = 60 * 60 * 1000;
// Messages a person wrote: plain, thread starters, replies, slash and context-menu commands.
const MESSAGE_TYPES = new Set([0, 18, 19, 20, 21, 23]);
// Channels that hold messages: text, voice chat, announcement, stage chat.
const MESSAGE_CHANNELS = new Set([0, 2, 5, 13]);
// Channels whose public threads hold messages too: text, announcement, forum, media.
const THREAD_PARENTS = new Set([0, 5, 15, 16]);
// Announcement and public threads (private threads need Manage Threads to list).
const THREADS = new Set([10, 11]);

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

function responseError (res) {
  return (res.json && res.json.message) || res.error || `HTTP ${res.status}`;
}

/**
 * When a Discord snowflake was made, in ms.
 * @param {string} id
 * @returns {number}
 */
function snowflakeTime (id) {
  return Number((BigInt(id) >> 22n) + DISCORD_EPOCH);
}

function later (a, b) {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) > BigInt(b) ? a : b;
}

function earlier (a, b) {
  if (!a) return b;
  if (!b) return a;
  return BigInt(a) < BigInt(b) ? a : b;
}

function userId (target) {
  const match = /^(?:discord\/users\/)?(\d{5,25})$/.exec(String(target || ''));
  return match ? match[1] : null;
}

/**
 * When each member of the home server last posted, kept in an on-disk
 * `@fabric/core` {@link Store} for check-ins with members who have gone
 * quiet. History comes from Discord REST: every channel and public thread
 * the bot can read is walked back to its first message once (resumable, a
 * cursor per channel), then polled forward every `ttlMs`; the shared gateway
 * client adds messages as they are posted. Only author ids and times are
 * kept — never content, channels a member posted in, or anything served per
 * member: the public status is aggregate counts.
 */
class Activity {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {Object} [settings.discord] settings.discord (token / secretsFile / guildId).
   * @param {boolean} [settings.sync] false: never read history over REST (the gateway still adds posts).
   * @param {number} [settings.ttlMs] Poll interval for new messages (and new channels).
   * @param {boolean} [settings.refreshOnStart] Sync (and backfill) in the background on start.
   * @param {number} [settings.flushMs] How often new messages from the gateway are saved.
   * @param {Object} [settings.operations] Operations service (its gateway client adds live messages).
   * @param {Function} [settings.fetch] Injected for tests; defaults to global fetch.
   * @param {Function} [settings.resolveToken] Injected for tests; defaults to resolveDiscordToken.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/activity',
      discord: {},
      ttlMs: HOUR,
      refreshOnStart: true,
      flushMs: 60 * 1000,
      operations: null
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this._resolveToken = this.settings.resolveToken || resolveDiscordToken;
    this.store = null;
    this.users = {};
    this.channels = {};
    this.discord = null;
    this._dirty = false;
    this._syncing = null;
    this._stopping = false;
    this._timers = [];
    this._listeners = {};
    this._onGateway = (discord) => this.attach(discord);
    this._onMessage = (message) => this._receive(message);
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

  get guildId () {
    return String((this.settings.discord && this.settings.discord.guildId) || discordEvents.DEFAULT_GUILD_ID);
  }

  async start () {
    this.store = new Store({
      name: 'GOON.VC:activity',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await startStore(this.store);
    this.users = (await this.store.get(USERS_KEY)) || {};
    this.channels = (await this.store.get(CHANNELS_KEY)) || {};

    const operations = this.settings.operations;
    if (operations && operations.discord) this.attach(operations.discord);
    else if (operations && typeof operations.on === 'function') operations.on('gateway', this._onGateway);

    if (this.settings.sync !== false) {
      if (this.settings.refreshOnStart) this._syncInBackground();
      this._every(this.settings.ttlMs, () => this._syncInBackground());
    }
    this._every(this.settings.flushMs, () => this.flush().catch((error) => this.emit('error', 'activity', errorMessage(error))));
    return this;
  }

  async stop () {
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];
    this._detach();
    const operations = this.settings.operations;
    if (operations && typeof operations.removeListener === 'function') operations.removeListener('gateway', this._onGateway);
    this._stopping = true;
    if (this._syncing) await this._syncing.catch(() => {});
    if (this.store) {
      await this.flush();
      await this.store.stop();
    }
    return this;
  }

  _every (ms, task) {
    if (!(Number(ms) > 0)) return;
    const timer = setInterval(task, ms);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.push(timer);
  }

  /**
   * Listen for new messages on the shared gateway client.
   * @param {Object} discord `@fabric/discord` service
   */
  attach (discord) {
    if (!discord || !discord.client || this.discord === discord) return;
    this._detach();
    this.discord = discord;
    discord.client.on('messageCreate', this._onMessage);
  }

  _detach () {
    if (!this.discord) return;
    const client = this.discord.client;
    if (client && typeof client.removeListener === 'function') client.removeListener('messageCreate', this._onMessage);
    this.discord = null;
  }

  _receive (message) {
    if (!message || String(message.guildId) !== this.guildId) return;
    const author = message.author;
    if (!author || author.bot || author.system || message.webhookId) return;
    if (!MESSAGE_TYPES.has(Number(message.type))) return;
    this.record(author.id, message.createdTimestamp || snowflakeTime(message.id));
  }

  /**
   * Note that a member posted at a time (keeps the latest).
   * @param {string} id Discord user id
   * @param {number} at ms
   * @returns {boolean} whether it was newer than what was known
   */
  record (id, at) {
    id = String(id);
    if (!/^\d{5,25}$/.test(id) || !Number.isFinite(at)) return false;
    if ((this.users[id] || 0) >= at) return false;
    this.users[id] = at;
    this._dirty = true;
    return true;
  }

  /**
   * When a member last posted in the home server.
   * @param {string} target `discord/users/<id>` or a Discord user id
   * @returns {string|null} ISO time
   */
  lastPosted (target) {
    const id = userId(target);
    const at = id ? this.users[id] : null;
    return at ? new Date(at).toISOString() : null;
  }

  async flush () {
    if (!this.store || !this._dirty) return;
    this._dirty = false;
    await this.store.set(USERS_KEY, this.users);
    await this.store.set(CHANNELS_KEY, this.channels);
  }

  _syncInBackground () {
    this.sync().catch(() => {});
  }

  /**
   * Single-flight pass over every readable channel and public thread: new
   * messages since the last pass, then older history until each channel is
   * read back to its start. Failures are recorded, never thrown past the
   * returned promise.
   * @param {Object} [options]
   * @param {Function} [options.progress] `(line) => void` for the CLI.
   * @returns {Promise<Object>} {@link Activity#status}
   */
  sync (options = {}) {
    if (!this._syncing) {
      this._syncing = this._sync(options)
        .catch(async (error) => {
          this.emit('error', 'activity', errorMessage(error));
          if (this.store) {
            const saved = (await this.store.get(STATUS_KEY).catch(() => null)) || {};
            await this.flush();
            await this.store.set(STATUS_KEY, { syncedAt: saved.syncedAt || null, attemptedAt: new Date().toISOString(), error: errorMessage(error) });
          }
          throw error;
        })
        .finally(() => { this._syncing = null; });
    }
    return this._syncing;
  }

  async _get (apiPath, token) {
    return discordEvents.discordGet(apiPath, token, this.settings.fetch ? { fetch: this.settings.fetch } : {});
  }

  async _sync (options) {
    const progress = typeof options.progress === 'function' ? options.progress : () => {};
    const auth = this._resolveToken(this.settings.discord);
    if (!auth || !auth.token) throw new Error('No Discord bot token configured');
    const token = auth.token;
    const guild = this.guildId;

    const listed = await this._get(`/guilds/${guild}/channels`, token);
    if (listed.status !== 200 || !Array.isArray(listed.json)) throw new Error(`Could not list channels: ${responseError(listed)}`);
    const sources = listed.json.filter((channel) => MESSAGE_CHANNELS.has(channel.type)).map((channel) => ({ id: String(channel.id), name: channel.name }));
    const active = await this._get(`/guilds/${guild}/threads/active`, token);
    const threads = active.status === 200 && active.json && Array.isArray(active.json.threads) ? active.json.threads : [];
    for (const parent of listed.json.filter((channel) => THREAD_PARENTS.has(channel.type))) {
      threads.push(...await this._archivedThreads(String(parent.id), token));
    }
    for (const thread of threads) {
      if (THREADS.has(thread.type)) sources.push({ id: String(thread.id), name: thread.name, thread: true });
    }

    const seen = new Set();
    for (const source of sources) {
      if (this._stopping) break;
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      const record = this.channels[source.id] || (this.channels[source.id] = { newest: null, oldest: null, complete: false, unreadableAt: null });
      if (record.unreadableAt && Date.now() - Date.parse(record.unreadableAt) < 24 * HOUR) continue;
      const before = Object.keys(this.users).length;
      const read = await this._read(source.id, record, token);
      if (read === null) continue;
      const added = Object.keys(this.users).length - before;
      if (read) progress(`${source.thread ? 'thread' : '#'}${source.name}: ${read} messages${added ? `, ${added} new members` : ''}${record.complete ? '' : ' (more to read)'}`);
      await this.flush();
    }

    const status = Object.assign(this.status(), { syncedAt: new Date().toISOString(), error: null });
    await this.store.set(STATUS_KEY, { syncedAt: status.syncedAt, attemptedAt: status.syncedAt, error: null });
    return status;
  }

  async _archivedThreads (parentId, token) {
    const record = this.channels[parentId] || {};
    const since = record.threadsListedAt ? Date.parse(record.threadsListedAt) : 0;
    const startedAt = new Date().toISOString();
    const threads = [];
    let before = null;
    for (;;) {
      const query = `?limit=${PAGE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
      const res = await this._get(`/channels/${parentId}/threads/archived/public${query}`, token);
      // No Read Message History there: no threads to read, try again next pass.
      if (res.status !== 200 || !res.json || !Array.isArray(res.json.threads)) return threads;
      let older = false;
      for (const thread of res.json.threads) {
        const archivedAt = thread.thread_metadata && thread.thread_metadata.archive_timestamp;
        if (since && archivedAt && Date.parse(archivedAt) < since) { older = true; continue; }
        threads.push(thread);
        before = archivedAt || before;
      }
      if (older || !res.json.has_more || !res.json.threads.length) break;
    }
    if (this.channels[parentId]) this.channels[parentId].threadsListedAt = startedAt;
    else this.channels[parentId] = { newest: null, oldest: null, complete: false, unreadableAt: null, threadsListedAt: startedAt };
    this._dirty = true;
    return threads;
  }

  /**
   * Read one channel: the newest page when it is new, everything since the
   * last pass, then older pages until its first message.
   * @returns {Promise<number|null>} messages read, or null when the bot can't read it
   */
  async _read (channelId, record, token) {
    let read = 0;
    let pages = 0;
    const page = async (query) => {
      pages += 1;
      const res = await this._get(`/channels/${channelId}/messages?limit=${PAGE}${query}`, token);
      if (res.status === 403 || res.status === 404) {
        record.unreadableAt = new Date().toISOString();
        this._dirty = true;
        return null;
      }
      if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`Could not read channel ${channelId}: ${responseError(res)}`);
      record.unreadableAt = null;
      for (const message of res.json) {
        const author = message.author || {};
        if (author.bot || author.system || message.webhook_id || !MESSAGE_TYPES.has(Number(message.type))) continue;
        this.record(author.id, snowflakeTime(message.id));
      }
      read += res.json.length;
      this._dirty = true;
      return res.json.map((message) => String(message.id));
    };

    if (!record.newest) {
      const ids = await page('');
      if (ids === null) return null;
      if (!ids.length) {
        record.complete = true;
        return read;
      }
      record.newest = ids.reduce(later, null);
      record.oldest = ids.reduce(earlier, null);
      if (ids.length < PAGE) record.complete = true;
    } else {
      for (;;) {
        const ids = await page(`&after=${record.newest}`);
        if (ids === null) return null;
        if (!ids.length) break;
        record.newest = ids.reduce(later, record.newest);
        if (ids.length < PAGE || this._stopping) break;
      }
    }
    while (!record.complete && !this._stopping) {
      const ids = await page(`&before=${record.oldest}`);
      if (ids === null) return null;
      if (ids.length) record.oldest = ids.reduce(earlier, record.oldest);
      if (ids.length < PAGE) record.complete = true;
      if (pages % 20 === 0) await this.flush();
    }
    return read;
  }

  /**
   * Aggregate counts only: how many members have a known last post, how far
   * history goes, and how much is still to read. No ids.
   * @returns {Object}
   */
  status () {
    const records = Object.values(this.channels).filter((record) => record.newest || record.complete || record.unreadableAt);
    const times = Object.values(this.users);
    return {
      members: times.length,
      oldestPost: times.length ? new Date(Math.min(...times)).toISOString() : null,
      channels: {
        tracked: records.length,
        complete: records.filter((record) => record.complete).length,
        unreadable: records.filter((record) => record.unreadableAt).length
      },
      backfilled: records.length > 0 && records.every((record) => record.complete || record.unreadableAt),
      syncing: !!this._syncing
    };
  }

  /**
   * Express middleware for `GET /services/activity` (aggregate status).
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const url = new URL(req.originalUrl || req.url, 'http://localhost');
      const pathname = (req.path || url.pathname).replace(/\/+$/, '');
      if (pathname !== PATH) return next();
      if (String(req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      Promise.resolve(this.store ? this.store.get(STATUS_KEY) : null).then((saved) => {
        sendJson(res, 200, Object.assign(this.status(), {
          syncedAt: (saved && saved.syncedAt) || null,
          error: (saved && saved.error) || null
        }));
      }).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) });
      });
    };
  }
}

module.exports = Activity;
module.exports.PATH = PATH;
module.exports.snowflakeTime = snowflakeTime;
