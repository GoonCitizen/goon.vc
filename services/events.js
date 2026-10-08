'use strict';

const fs = require('fs');
const Store = require('@fabric/core/types/store');
const discordEvents = require('../functions/discordScheduledEvents');
const scheduleGraphic = require('../functions/scheduleGraphic');
const resolveDiscordToken = require('../functions/resolveDiscordToken');

const BASE = '/services/events';
const BOARD_PATH = `${BASE}/schedule.svg`;
const INVITE_PATH = '/services/discord/invite';
// View Channels: enough to read scheduled events and voice presence; the bot never posts.
const INVITE_PERMISSIONS = '1024';
const LATEST_KEY = '/events/latest';
// Store keys are JSON Pointer paths: the index must not sit above /events/guilds/<id>.
const GUILD_INDEX_KEY = '/events/guildIndex';
const STATUS_KEY = '/events/status';
const DEFAULT_TTL_MS = 5 * 60 * 1000;
// Events without an end time drop off this long after they start.
const OPEN_ENDED_MS = 3 * 60 * 60 * 1000;
// Minimum gap between request-triggered polls while Discord is failing.
const RETRY_MS = 60 * 1000;
const GUILD_PAGE_SIZE = 200;
const HIDDEN_STATUSES = new Set(['completed', 'canceled']);

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function guildIconUrl (guild) {
  return guild && guild.icon
    ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png?size=64`
    : null;
}

/**
 * Public, display-ready row for one scheduled event.
 * @param {object} event serializeScheduledEvent row
 * @param {{ id: string, name: string, iconUrl: string|null }} guild
 * @returns {object}
 */
function publicEvent (event, guild) {
  return {
    id: event.id,
    guildId: guild.id,
    guildName: guild.name,
    guildIconUrl: guild.iconUrl || null,
    name: event.name,
    description: event.description || null,
    start: event.scheduledStartTime,
    end: event.scheduledEndTime || null,
    status: event.statusName,
    type: event.entityTypeName,
    location: (event.entityMetadata && event.entityMetadata.location) || null,
    interested: event.userCount,
    cadence: event.recurrenceRule ? discordEvents.describeCadence(event.recurrenceRule) : null,
    recurrence: event.recurrenceRule || null,
    imageUrl: event.image
      ? `https://cdn.discordapp.com/guild-events/${event.id}/${event.image}.png?size=512`
      : null,
    url: `https://discord.com/events/${guild.id}/${event.id}`
  };
}

/**
 * Back to the serializeScheduledEvent shape the week board categorizes.
 * @param {object} event publicEvent row
 * @returns {object}
 */
function scheduleRow (event) {
  return {
    id: event.id,
    name: event.name,
    description: event.description,
    scheduledStartTime: event.start,
    scheduledEndTime: event.end,
    statusName: event.status,
    entityTypeName: event.type,
    userCount: event.interested,
    recurrenceRule: event.recurrence || null,
    url: event.url
  };
}

function byStart (a, b) {
  const live = (b.status === 'active') - (a.status === 'active');
  if (live) return live;
  return String(a.start || '').localeCompare(String(b.start || ''));
}

function hasEnded (event, now) {
  const end = Date.parse(event.end || '');
  if (Number.isFinite(end)) return end < now;
  const start = Date.parse(event.start || '');
  return Number.isFinite(start) && start + OPEN_ENDED_MS < now;
}

function guildKey (id) {
  return `/events/guilds/${id}`;
}

/**
 * Upcoming Discord Guild Scheduled Events across every server the configured
 * bot belongs to, saved per guild in an on-disk `@fabric/core` {@link Store}.
 * Requests are always answered from disk; Discord is polled in the background
 * so `/events` keeps rendering (marked stale) while Discord is unreachable.
 */
class Events {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {Object} [settings.discord] settings.discord (token / secretsFile / guildId).
   * @param {number} [settings.ttlMs] How long a fetch stays fresh.
   * @param {number} [settings.refreshIntervalMs] Background poll interval (defaults to ttlMs; 0 disables).
   * @param {boolean} [settings.refreshOnStart] Poll Discord as soon as the service starts.
   * @param {string} [settings.snapshot] Single-guild schedule snapshot used before the first fetch.
   * @param {string} [settings.scheduleBrand] Week-board brand for the home guild (settings.discord.guildId).
   * @param {Function} [settings.fetch] Injected for tests; defaults to global fetch.
   * @param {Function} [settings.resolveToken] Injected for tests; defaults to resolveDiscordToken.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/events',
      discord: {},
      ttlMs: DEFAULT_TTL_MS,
      refreshOnStart: true,
      snapshot: null,
      scheduleBrand: 'permafleet'
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    if (this.settings.refreshIntervalMs === undefined) this.settings.refreshIntervalMs = this.settings.ttlMs;
    this._resolveToken = this.settings.resolveToken || resolveDiscordToken;
    this.store = null;
    this._refreshing = null;
    this._timer = null;
    this._lastBackgroundAt = 0;
    this._applicationId = null;
  }

  async start () {
    this.store = new Store({
      name: 'GOON.VC:events',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await this.store.start();
    if (this.settings.refreshOnStart) this._refreshInBackground();
    if (this.settings.refreshIntervalMs > 0) {
      this._timer = setInterval(() => this._refreshInBackground(), this.settings.refreshIntervalMs);
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

  _discordOpts () {
    return this.settings.fetch ? { fetch: this.settings.fetch } : {};
  }

  async _listGuilds (token) {
    const guilds = [];
    let after = null;
    for (;;) {
      const q = `?limit=${GUILD_PAGE_SIZE}` + (after ? `&after=${after}` : '');
      const res = await discordEvents.discordGet(`/users/@me/guilds${q}`, token, this._discordOpts());
      if (res.status !== 200 || !Array.isArray(res.json)) {
        throw new Error((res.json && res.json.message) || res.error || `HTTP ${res.status}`);
      }
      for (const g of res.json) {
        guilds.push({ id: String(g.id), name: String(g.name || g.id), iconUrl: guildIconUrl(g) });
      }
      if (res.json.length < GUILD_PAGE_SIZE) return guilds;
      after = guilds[guilds.length - 1].id;
    }
  }

  /**
   * Fetch every guild's scheduled events from Discord and persist the result.
   * @returns {Promise<object>} the stored snapshot
   */
  async refresh () {
    const auth = this._resolveToken(this.settings.discord);
    if (!auth || !auth.token) throw new Error('No Discord bot token configured');
    const guilds = await this._listGuilds(auth.token);
    const now = Date.now();
    const fetchedAt = new Date(now).toISOString();
    const events = [];
    const guildRows = [];
    for (const guild of guilds) {
      const res = await discordEvents.fetchGuildScheduledEvents(Object.assign({
        token: auth.token,
        guildId: guild.id
      }, this._discordOpts()));
      let record;
      if (res.ok) {
        record = {
          guild,
          fetchedAt,
          events: res.events.filter((e) => !HIDDEN_STATUSES.has(e.statusName)).map((e) => publicEvent(e, guild))
        };
      } else {
        const saved = await this.store.get(guildKey(guild.id));
        record = {
          guild,
          fetchedAt: (saved && saved.fetchedAt) || null,
          events: saved && Array.isArray(saved.events) ? saved.events : [],
          error: res.error
        };
      }
      await this.store.set(guildKey(guild.id), record);
      const visible = record.events.filter((e) => !hasEnded(e, now));
      guildRows.push(Object.assign({}, guild, { count: visible.length, fetchedAt: record.fetchedAt }, record.error ? { error: record.error } : {}));
      events.push(...visible);
    }
    events.sort(byStart);
    await this.store.set(GUILD_INDEX_KEY, guilds.map((g) => g.id));
    const snapshot = { fetchedAt, source: 'discord', guilds: guildRows, events };
    await this.store.set(LATEST_KEY, snapshot);
    await this.store.set(STATUS_KEY, { attemptedAt: fetchedAt, error: null });
    return snapshot;
  }

  _fromScheduleSnapshot () {
    const file = this.settings.snapshot;
    if (!file || !fs.existsSync(file)) return null;
    try {
      const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
      const guildId = String(payload.guildId || (this.settings.discord && this.settings.discord.guildId) || discordEvents.DEFAULT_GUILD_ID);
      const guild = { id: guildId, name: payload.guildName || 'G00N SQUAD', iconUrl: null };
      const events = (payload.events || [])
        .map(discordEvents.serializeScheduledEvent)
        .filter((e) => e && !HIDDEN_STATUSES.has(e.statusName))
        .map((e) => publicEvent(e, guild))
        .sort(byStart);
      return { fetchedAt: payload.fetchedAt || null, source: 'snapshot', guilds: [Object.assign({ count: events.length }, guild)], events };
    } catch (_) {
      return null;
    }
  }

  /**
   * Latest events from disk. A copy older than ttlMs is returned immediately,
   * marked `stale`, while a background poll refreshes it; only an empty cache
   * (or `force`) waits on Discord.
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<object>}
   */
  async list (opts = {}) {
    const latest = await this.store.get(LATEST_KEY);
    if (latest && !opts.force) {
      const age = latest.fetchedAt ? Date.now() - Date.parse(latest.fetchedAt) : Infinity;
      const status = await this.store.get(STATUS_KEY);
      const failed = status && status.error && Date.parse(status.attemptedAt) >= Date.parse(latest.fetchedAt || 0);
      if (age < this.settings.ttlMs && !failed) return this._current(latest);
      this._refreshInBackground({ throttle: true });
      return Object.assign(this._current(latest), { stale: true }, failed ? { error: status.error } : {});
    }

    try {
      return await this._refresh();
    } catch (error) {
      const fallback = latest || this._fromScheduleSnapshot();
      const message = error && error.message ? error.message : String(error);
      if (fallback) return Object.assign(this._current(fallback), { stale: true, error: message });
      return { fetchedAt: null, source: null, guilds: [], events: [], stale: true, error: message };
    }
  }

  _current (snapshot) {
    const now = Date.now();
    return Object.assign({}, snapshot, { events: (snapshot.events || []).filter((e) => !hasEnded(e, now)) });
  }

  /**
   * Week board (same renderer as the PERMAFLEET schedule) for one guild, or
   * every guild when `server` is omitted or `all`.
   * @param {{ server?: string, timeZone?: string }} [opts]
   * @returns {Promise<string>} SVG
   */
  async board (opts = {}) {
    const snapshot = await this.list();
    const server = opts.server && opts.server !== 'all' ? String(opts.server) : null;
    const guild = server ? (snapshot.guilds || []).find((g) => g.id === server) : null;
    const events = (snapshot.events || []).filter((e) => !server || e.guildId === server).map(scheduleRow);
    const homeGuild = String((this.settings.discord && this.settings.discord.guildId) || discordEvents.DEFAULT_GUILD_ID);
    const home = server === homeGuild;
    return scheduleGraphic.renderWeekScheduleSvg({
      events,
      fetchedAt: snapshot.fetchedAt || undefined,
      timeZone: opts.timeZone,
      brand: home ? this.settings.scheduleBrand : 'goon',
      guildName: home ? undefined : (guild ? guild.name : 'ALL SERVERS').toUpperCase(),
      orgs: home ? undefined : [],
      subtitle: home ? undefined : 'Weekly events · day theme + training / ops blocks · Discord scheduled events',
      regenerateCommand: ''
    }).svg;
  }

  /**
   * Discord application that owns the bot token (not settings.discord.clientId,
   * which is the member-login OAuth app and may differ). Looked up once.
   * @returns {Promise<string|null>}
   */
  async applicationId () {
    if (this._applicationId) return this._applicationId;
    const auth = this._resolveToken(this.settings.discord);
    if (!auth || !auth.token) return null;
    const res = await discordEvents.discordGet('/oauth2/applications/@me', auth.token, this._discordOpts());
    if (res.status !== 200 || !res.json || !res.json.id) return null;
    this._applicationId = String(res.json.id);
    return this._applicationId;
  }

  /**
   * "Add to Discord" URL for the bot that feeds /events.
   * @returns {Promise<string|null>}
   */
  async inviteUrl () {
    const id = await this.applicationId();
    if (!id) return null;
    const q = new URLSearchParams({ client_id: id, scope: 'bot', permissions: INVITE_PERMISSIONS });
    return `https://discord.com/oauth2/authorize?${q}`;
  }

  /**
   * Express middleware for `GET /services/events`, `GET /services/events/schedule.svg`,
   * and `GET /services/discord/invite` (redirects to the bot's Discord invite).
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const url = new URL(req.originalUrl || req.url, 'http://localhost');
      const pathname = (req.path || url.pathname).replace(/\/+$/, '');
      if (pathname !== BASE && pathname !== BOARD_PATH && pathname !== INVITE_PATH) return next();
      if (String(req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (pathname === INVITE_PATH) {
        this.inviteUrl().then((location) => {
          if (!location) return sendJson(res, 503, { error: 'Discord bot is not configured' });
          res.statusCode = 302;
          res.setHeader('Location', location);
          res.setHeader('Cache-Control', 'no-store');
          res.end();
        }).catch((error) => {
          if (!res.headersSent) sendJson(res, 502, { error: error && error.message ? error.message : 'Discord unavailable' });
        });
        return;
      }
      if (pathname === BOARD_PATH) {
        this.board({ server: url.searchParams.get('server'), timeZone: url.searchParams.get('tz') }).then((svg) => {
          res.statusCode = 200;
          res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
          res.setHeader('Cache-Control', 'no-store');
          res.end(svg);
        }).catch((error) => {
          if (!res.headersSent) sendJson(res, 500, { error: error && error.message ? error.message : 'Events unavailable' });
        });
        return;
      }
      this.list().then((body) => sendJson(res, 200, body)).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: error && error.message ? error.message : 'Events unavailable' });
      });
    };
  }
}

module.exports = Events;
module.exports.publicEvent = publicEvent;
