'use strict';

const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const discordEvents = require('../functions/discordScheduledEvents');
const resolveDiscordToken = require('../functions/resolveDiscordToken');
const { parseLeaderboard, findLeaderboardPin, displayName } = require('../functions/duelLeaderboard');

const BASE = '/services/leaderboards';
const LATEST_KEY = '/leaderboard/latest';
const STATUS_KEY = '/leaderboard/status';
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_NAMES_TTL_MS = 24 * 60 * 60 * 1000;
// Minimum gap between request-triggered polls while Discord is failing.
const RETRY_MS = 60 * 1000;

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function nameKey (userId) {
  return `/leaderboard/names/${userId}`;
}

function errorMessage (res) {
  return (res.json && res.json.message) || res.error || `HTTP ${res.status}`;
}

/**
 * The 1v1 ladder officers keep in a pinned message in G00N SQUAD
 * #1v1-challenges, synced into an on-disk `@fabric/core` {@link Store}.
 * Requests are answered from disk; Discord is polled in the background and a
 * failed poll keeps the last saved ladder (served `stale`). The public copy
 * carries display names only — never Discord ids or other message content.
 */
class Leaderboard {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {Object} [settings.discord] settings.discord (token / secretsFile / guildId).
   * @param {string} [settings.id] Route segment under /services/leaderboards.
   * @param {string} [settings.title]
   * @param {string} [settings.channelId] Channel holding the pinned ladder.
   * @param {string} [settings.channelName]
   * @param {string} [settings.messageId] Pin to read; defaults to the pin titled LEADERBOARD.
   * @param {number} [settings.ttlMs] How long a fetch stays fresh (also the poll interval).
   * @param {number} [settings.namesTtlMs] How long a resolved display name is reused.
   * @param {boolean} [settings.refreshOnStart]
   * @param {Function} [settings.fetch] Injected for tests; defaults to global fetch.
   * @param {Function} [settings.resolveToken] Injected for tests; defaults to resolveDiscordToken.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/leaderboard',
      discord: {},
      id: '1v1',
      title: '1v1 Leaderboard',
      channelId: '1229937640116064276',
      channelName: '1v1-challenges',
      messageId: null,
      ttlMs: DEFAULT_TTL_MS,
      namesTtlMs: DEFAULT_NAMES_TTL_MS,
      refreshOnStart: true
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this._resolveToken = this.settings.resolveToken || resolveDiscordToken;
    this.store = null;
    this._refreshing = null;
    this._timer = null;
    this._lastBackgroundAt = 0;
  }

  get path () {
    return `${BASE}/${this.settings.id}`;
  }

  _guildId () {
    return String((this.settings.discord && this.settings.discord.guildId) || discordEvents.DEFAULT_GUILD_ID);
  }

  _channelUrl () {
    return `https://discord.com/channels/${this._guildId()}/${this.settings.channelId}`;
  }

  _discordOpts () {
    return this.settings.fetch ? { fetch: this.settings.fetch } : {};
  }

  async start () {
    this.store = new Store({
      name: 'GOON.VC:leaderboard',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await startStore(this.store);
    if (this.settings.refreshOnStart) this._refreshInBackground();
    if (this.settings.ttlMs > 0) {
      this._timer = setInterval(() => this._refreshInBackground(), this.settings.ttlMs);
      this._timer.unref();
    }
    return this;
  }

  async stop () {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._refreshing) await this._refreshing.catch(() => {});
    if (this.store) await this.store.stop();
    return this;
  }

  /**
   * Single-flight Discord poll; failures are recorded, never thrown.
   * @returns {Promise<object>}
   */
  _refresh () {
    if (!this._refreshing) {
      this._refreshing = this.refresh()
        .catch(async (error) => {
          const message = error && error.message ? error.message : String(error);
          if (this.store) await this.store.set(STATUS_KEY, { attemptedAt: new Date().toISOString(), error: message });
          throw error;
        })
        .finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  _refreshInBackground (opts = {}) {
    const now = Date.now();
    if (opts.throttle && now - this._lastBackgroundAt < RETRY_MS) return;
    this._lastBackgroundAt = now;
    this._refresh().catch(() => {});
  }

  async _pinnedMessage (token) {
    const channel = this.settings.channelId;
    if (this.settings.messageId) {
      const res = await discordEvents.discordGet(`/channels/${channel}/messages/${this.settings.messageId}`, token, this._discordOpts());
      if (res.status !== 200 || !res.json) throw new Error(errorMessage(res));
      return res.json;
    }
    const res = await discordEvents.discordGet(`/channels/${channel}/pins`, token, this._discordOpts());
    const pins = Array.isArray(res.json)
      ? res.json
      : (res.json && Array.isArray(res.json.items) ? res.json.items.map((item) => item.message) : null);
    if (res.status !== 200 || !pins) throw new Error(errorMessage(res));
    const message = findLeaderboardPin(pins);
    if (!message) throw new Error(`No pinned leaderboard in #${this.settings.channelName} (is the Message Content intent on?)`);
    return message;
  }

  /**
   * Display name for one user, cached for namesTtlMs. Falls back to the
   * mention object Discord sent with the message, then to the last saved name.
   * @private
   */
  async _name (userId, mention, token) {
    const saved = await this.store.get(nameKey(userId));
    if (saved && saved.name && Date.now() - Date.parse(saved.fetchedAt || 0) < this.settings.namesTtlMs) return saved.name;
    let name = null;
    const member = await discordEvents.discordGet(`/guilds/${this._guildId()}/members/${userId}`, token, this._discordOpts());
    if (member.status === 200 && member.json) name = displayName(member.json);
    if (!name && mention) name = displayName(null, mention);
    if (!name && member.status === 404) {
      const user = await discordEvents.discordGet(`/users/${userId}`, token, this._discordOpts());
      if (user.status === 200 && user.json) name = displayName(null, user.json);
    }
    if (!name) return (saved && saved.name) || null;
    await this.store.set(nameKey(userId), { name, fetchedAt: new Date().toISOString() });
    return name;
  }

  /**
   * Read the pinned ladder from Discord and persist the public copy.
   * @returns {Promise<object>} the stored snapshot
   */
  async refresh () {
    const auth = this._resolveToken(this.settings.discord);
    if (!auth || !auth.token) throw new Error('No Discord bot token configured');
    const message = await this._pinnedMessage(auth.token);
    const parsed = parseLeaderboard(message.content);
    if (!parsed.ladder.length) throw new Error('The pinned leaderboard has no ranked pilots');
    const mentions = new Map((message.mentions || []).map((u) => [String(u.id), u]));
    const ladder = [];
    for (const row of parsed.ladder) {
      const name = row.userId
        ? await this._name(row.userId, mentions.get(row.userId), auth.token)
        : row.handle;
      ladder.push({ rank: row.rank, name: name || 'Unknown pilot' });
    }
    const fetchedAt = new Date().toISOString();
    const snapshot = {
      id: this.settings.id,
      title: this.settings.title,
      fetchedAt,
      updatedAt: message.edited_timestamp || message.timestamp || null,
      channel: { name: this.settings.channelName, url: this._channelUrl() },
      champion: ladder[0].name,
      ladder,
      rules: parsed.rules
    };
    await this.store.set(LATEST_KEY, snapshot);
    await this.store.set(STATUS_KEY, { attemptedAt: fetchedAt, error: null });
    return snapshot;
  }

  /**
   * Latest ladder from disk. A copy older than ttlMs is returned immediately,
   * marked `stale`, while a background poll refreshes it; only an empty cache
   * waits on Discord.
   * @returns {Promise<object>}
   */
  async list () {
    const latest = await this.store.get(LATEST_KEY);
    if (latest) {
      const age = latest.fetchedAt ? Date.now() - Date.parse(latest.fetchedAt) : Infinity;
      const status = await this.store.get(STATUS_KEY);
      const failed = status && status.error && Date.parse(status.attemptedAt) >= Date.parse(latest.fetchedAt || 0);
      if (age < this.settings.ttlMs && !failed) return latest;
      this._refreshInBackground({ throttle: true });
      return Object.assign({}, latest, { stale: true }, failed ? { error: status.error } : {});
    }
    try {
      return await this._refresh();
    } catch (error) {
      return {
        id: this.settings.id,
        title: this.settings.title,
        fetchedAt: null,
        updatedAt: null,
        channel: { name: this.settings.channelName, url: this._channelUrl() },
        champion: null,
        ladder: [],
        rules: [],
        stale: true,
        error: error && error.message ? error.message : String(error)
      };
    }
  }

  /**
   * Express middleware for `GET /services/leaderboards/<id>`.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const url = new URL(req.originalUrl || req.url, 'http://localhost');
      const pathname = (req.path || url.pathname).replace(/\/+$/, '');
      if (pathname !== this.path) return next();
      if (String(req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      this.list().then((body) => sendJson(res, 200, body)).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: error && error.message ? error.message : 'Leaderboard unavailable' });
      });
    };
  }
}

module.exports = Leaderboard;
module.exports.BASE = BASE;
