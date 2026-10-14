'use strict';

const { assertStoreOpen } = require('../functions/startStore');

const BASE = '/services/idlerpg';
const LEGACY_BASE = '/services/presence';

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
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
   * @param {Array<string>} [settings.channels] Channel allowlist (empty = every voice channel counts).
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
      channels: [],
      operations: null,
      gateway: true
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.doorman = null;
    this.game = null;
    this.adapter = null;
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
      channels: this.settings.channels,
      persistent: true,
      verbosity: 1
    });
    this.game = this.doorman.plugins.idlerpg;
    this.game.on('error', (error) => this.emit('error', 'presence game', errorMessage(error)));
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
   * Feed Doorman from an `@fabric/discord` client the process already runs.
   * @param {Object} discord
   * @returns {Presence}
   */
  attach (discord) {
    if (!discord || this.adapter) return this;
    const DoormanDiscord = this.settings.DoormanDiscord || require('@fabric/doorman/services/discord');
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
    const prefix = 'discord/users/';
    let named = 0;
    for (const player of Object.values(this.game.content.players)) {
      if (player.name !== player.id || !player.id.startsWith(prefix)) continue;
      const userId = player.id.slice(prefix.length);
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
      await this.game._registerUser({ id: player.id, name: String(name) });
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
   * Public leaderboard: display names (already public on the Discord widget)
   * and game numbers — never service ids.
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
   * Express middleware for the IdleRPG application's JSON:
   * `GET /services/idlerpg` and `GET /services/idlerpg/players?limit=`.
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
      if (!job) return next();
      if (String(req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      job().then((body) => sendJson(res, 200, body)).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) || 'Presence unavailable' });
      });
    };
  }
}

module.exports = Presence;
