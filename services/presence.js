'use strict';

const { assertStoreOpen } = require('../functions/startStore');

const BASE = '/services/idlerpg';
const LEGACY_BASE = '/services/presence';
const DEFAULT_SOURCES = ['voice'];

// IdleRPG's `status` source is never used here: the Doorman Discord adapter
// marks anyone who posts as online, which would pay text under another name.
const GAME_SOURCES = { voice: 'channel', text: 'text' };

/**
 * IdleRPG presence sources for goon.vc's (`voice`, `text`).
 * @param {Array<string>|string} sources List or comma-separated string.
 * @returns {Array<string>}
 */
function gameSources (sources) {
  const list = typeof sources === 'string' ? sources.split(',') : [].concat(sources || []);
  const mapped = list.map((source) => GAME_SOURCES[String(source).trim().toLowerCase()]).filter(Boolean);
  return [...new Set(mapped)];
}

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Discord user id (snowflake) among an IdleRPG player's remote accounts, or
 * null when they have no Discord account.
 * @param {Object} player IdleRPG player record (`accounts: [{ service, id }]`).
 * @returns {string|null}
 */
function discordUserId (player) {
  const account = ((player && player.accounts) || []).find((entry) => entry.service === 'discord');
  return account ? account.id : null;
}

/**
 * IdleRPG player id from a `/services/idlerpg/players/<id>` path.
 * @param {string} pathname
 * @returns {string|null}
 */
function playerId (pathname) {
  const match = /^\/services\/idlerpg\/players\/([^/]+)\/?$/i.exec(String(pathname || ''));
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]).toLowerCase();
  } catch (_) {
    return null;
  }
}

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

/**
 * Global presence statistic, accumulated by IdleRPG running inside an
 * embedded `@fabric/doorman` host. Doorman gets no HTTP server and no gateway
 * of its own: the Operations service hands over its `@fabric/discord` client
 * (`gateway` event) and a Doorman Discord adapter maps voice occupancy into
 * `join` / `part` / `presence` events for the game. Player ids stay in the
 * on-disk Store (`stores/presence`). The IdleRPG application is mounted at
 * `/services/idlerpg`: browsers get the page, JSON clients get aggregates
 * only, and `/services/idlerpg/players` display names + game numbers (no ids,
 * no messages).
 */
class Presence {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory for the game state.
   * @param {number} [settings.tickMs] IdleRPG tick interval (default 10 minutes).
   * @param {number} [settings.luck] Encounter chance per rewarded tick.
   * @param {Array<string>} [settings.sources] What earns: `voice` (in a voice channel) and/or
   *   `text` (posting, for the game's text window afterwards). Default voice only.
   * @param {Array<string>} [settings.channels] Channel allowlist (empty = every channel counts).
   * @param {Array<string>} [settings.announcements] Discord text channel ids that receive game
   *   announcements. The only thing the game posts; its `!` commands are never answered
   *   (`/idlerpg` is services/commands.js).
   * @param {Object} [settings.operations] Operations service (or any emitter with `gateway` / `discord`).
   * @param {boolean} [settings.gateway] Attach to the Discord gateway when available (default true).
   * @param {Function} [settings.Doorman] Injected for tests; defaults to @fabric/doorman.
   * @param {Function} [settings.IdleRPG] Injected for tests; defaults to idlerpg/services/idlerpg.
   * @param {Function} [settings.DoormanDiscord] Injected for tests; defaults to @fabric/doorman/services/discord.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/presence',
      tickMs: 10 * 60 * 1000,
      luck: 0.05,
      sources: DEFAULT_SOURCES,
      channels: [],
      announcements: [],
      operations: null,
      gateway: true
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.doorman = null;
    this.game = null;
    this.adapter = null;
    this.discord = null;
    this.gateway = { status: 'disabled', error: null };
    this._listeners = {};
    this._onGateway = (discord) => this.attach(discord);
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
    const Doorman = this.settings.Doorman || require('@fabric/doorman');
    const IdleRPG = this.settings.IdleRPG || require('idlerpg/services/idlerpg');

    this.doorman = new Doorman({ name: 'GOON.VC:doorman', http: false, local: false });
    this.doorman.on('error', (error) => this.emit('error', 'presence doorman', errorMessage(error)));
    this.doorman.use(IdleRPG, {
      name: 'GOON.VC:presence',
      path: this.settings.path,
      tickMs: this.settings.tickMs,
      luck: this.settings.luck,
      sources: gameSources(this.settings.sources),
      channels: this.settings.channels,
      announcements: this.announcementTargets(),
      // Silence is kept only in the announcement channel; without one, nothing is penalized.
      penalties: this.announcementTargets().length > 0,
      persistent: true,
      verbosity: 1
    });
    this.game = this.doorman.plugins.idlerpg;
    this.game.on('error', (error) => this.emit('error', 'presence game', errorMessage(error)));
    this.game.on('message', (message) => {
      this.announce(message).catch((error) => this.emit('error', 'presence announce', errorMessage(error)));
    });
    // Doorman#start() resolves once every plugin has started (Store open,
    // prior state restored).
    await this.doorman.start();
    await assertStoreOpen(this.game.store);

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
   * Configured announcement channels as Doorman targets (`discord/channels/<id>`).
   * @returns {Array<string>}
   */
  announcementTargets () {
    return (this.settings.announcements || [])
      .map((entry) => String(entry).trim().replace(/^discord\/channels\//, ''))
      .filter((id) => /^\d+$/.test(id))
      .map((id) => `discord/channels/${id}`);
  }

  /**
   * Post a game announcement when it targets a configured announcement channel.
   * @param {Object} message `{ object, target }` from the game
   * @returns {Promise<Object|null>}
   */
  async announce (message) {
    if (!message || !this.announcementTargets().includes(message.target)) return null;
    const discord = this.discord;
    if (!discord || typeof discord.postToChannel !== 'function') return null;
    if (discord.client && typeof discord.client.isReady === 'function' && !discord.client.isReady()) return null;
    return discord.postToChannel(message.target.split('/').pop(), String(message.object));
  }

  /**
   * Feed Doorman from an `@fabric/discord` client the process already runs.
   * @param {Object} discord
   * @returns {Presence}
   */
  attach (discord) {
    if (!discord || this.adapter) return this;
    const DoormanDiscord = this.settings.DoormanDiscord || require('@fabric/doorman/services/discord');
    this.discord = discord;
    this.adapter = new DoormanDiscord({ client: discord, replies: false });
    this.doorman.enable('discord', this.adapter);
    this.gateway = { status: 'attached', error: null };
    this.emit('log', 'GOON.VC', 'presence: attached to the Discord gateway');
    const backfill = () => this.backfillNames(discord).catch((error) => this.emit('error', 'presence names', errorMessage(error)));
    if (discord.botReady) backfill();
    else if (typeof discord.once === 'function') discord.once('ready', backfill);
    return this;
  }

  /**
   * Name players stored before the adapter announced names (they would
   * otherwise stay "Unknown pilot" until they next join voice).
   * @param {Object} discord `@fabric/discord` client
   * @returns {Promise<number>} players named
   */
  async backfillNames (discord) {
    if (!this.game || !discord) return 0;
    const client = discord.client;
    const guilds = client && client.guilds && client.guilds.cache ? [...client.guilds.cache.values()] : [];
    let named = 0;
    for (const player of Object.values(this.game.content.players)) {
      const userId = discordUserId(player);
      if (player.name || !userId) continue;
      let name = null;
      for (const guild of guilds) {
        name = this.adapter ? this.adapter.displayName(userId, guild.id) : null;
        if (name) break;
        const member = await guild.members.fetch(userId).catch(() => null);
        if (member) {
          name = member.nickname || member.displayName || (member.user && (member.user.globalName || member.user.username));
          break;
        }
      }
      if (!name && client && client.users && typeof client.users.fetch === 'function') {
        const user = await client.users.fetch(userId).catch(() => null);
        if (user) name = user.globalName || user.username;
      }
      if (!name) continue;
      await this.game._registerUser({ id: `discord/users/${userId}`, name: String(name) });
      named += 1;
    }
    if (named) await this.game._persist();
    return named;
  }

  async stop () {
    const operations = this.settings.operations;
    if (operations && typeof operations.removeListener === 'function') operations.removeListener('gateway', this._onGateway);
    if (this.doorman) await this.doorman.stop();
    return this;
  }

  /**
   * Aggregate presence statistics (no member ids).
   * @returns {Promise<Object>}
   */
  async report () {
    const game = this.game ? this.game.report() : {};
    const operations = this.settings.operations;
    const upstream = operations && operations.gateway ? operations.gateway : null;
    return Object.assign({}, game, {
      gateway: Object.assign({}, this.gateway, upstream ? { discord: upstream.status } : {})
    });
  }

  /**
   * Public leaderboard: player ids, display names (already public on the
   * Discord widget), and game numbers — never member ids.
   * @param {number} [limit=50]
   * @returns {Promise<Object>}
   */
  async players (limit = 50) {
    const players = this.game ? this.game.leaderboard(limit) : [];
    return {
      generatedAt: new Date().toISOString(),
      count: this.game ? Object.keys(this.game.content.players).length : 0,
      players
    };
  }

  /**
   * One player's public profile by the player id the leaderboard lists —
   * one id however many chat accounts they link, unchanged by renames
   * (display name, standing, gear, game numbers — never member ids).
   * @param {string} id
   * @returns {Promise<Object|null>}
   */
  async player (id) {
    if (!this.game || typeof this.game.profile !== 'function') return null;
    return this.game.profile(id);
  }

  /**
   * The public profile of the player behind a Discord account, or null when
   * they have not played.
   * @param {string} userId Discord user id (snowflake).
   * @returns {Promise<Object|null>}
   */
  async discordPlayer (userId) {
    const record = this.game ? this.game.playerFor(`discord/users/${userId}`) : null;
    return record ? this.player(record.id) : null;
  }

  /**
   * Link-preview metadata for a player page
   * (`/services/idlerpg/players/<id>`), or null when there is no such player.
   * @param {string} pathname
   * @returns {Promise<{ path: string, title: string, description: string }|null>}
   */
  async page (pathname) {
    const id = playerId(pathname);
    const profile = id ? await this.player(id) : null;
    if (!profile) return null;
    const kills = `${profile.kills} kill${profile.kills === 1 ? '' : 's'}`;
    const weapon = profile.weapon ? `, wielding ${profile.weapon}` : '';
    return {
      path: `${BASE}/players/${encodeURIComponent(profile.id)}`,
      title: `${profile.name} — IDLERPG`,
      description: `Level ${profile.level}, rank ${profile.rank} of ${profile.players} in the alliance idle game: ${kills}${weapon}, ${profile.hours} hours present.`
    };
  }

  /**
   * Express middleware for the IdleRPG application's JSON:
   * `GET /services/idlerpg`, `GET /services/idlerpg/players?limit=`, and
   * `GET /services/idlerpg/players/<id>`.
   * The retired `/services/presence` paths redirect there.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const url = new URL(req.originalUrl || req.url, 'http://localhost');
      const pathname = (req.path || url.pathname).replace(/\/+$/, '');
      if (pathname === LEGACY_BASE || pathname.startsWith(`${LEGACY_BASE}/`)) {
        res.statusCode = 308;
        res.setHeader('Location', BASE + pathname.slice(LEGACY_BASE.length) + url.search);
        return res.end();
      }
      let job = null;
      if (pathname === BASE) job = () => this.report();
      else if (pathname === `${BASE}/players`) job = () => this.players(Math.min(Number(url.searchParams.get('limit')) || 50, 500));
      else if (playerId(pathname)) {
        job = () => this.player(playerId(pathname)).then((profile) => {
          if (!profile) throw Object.assign(new Error('No such player'), { status: 404 });
          return profile;
        });
      }
      if (!job) return next();
      if (String(req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      job().then((body) => sendJson(res, 200, body)).catch((error) => {
        if (!res.headersSent) sendJson(res, error && error.status === 404 ? 404 : 500, { error: errorMessage(error) || 'Presence unavailable' });
      });
    };
  }
}

module.exports = Presence;
module.exports.DEFAULT_SOURCES = DEFAULT_SOURCES;
module.exports.gameSources = gameSources;
