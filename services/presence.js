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
 * Global presence statistic, accumulated by IdleRPG running inside the
 * embedded `@fabric/doorman` host (services/community.js's, or our own when
 * there is none). Doorman gets no HTTP server and no gateway of its own: the
 * Operations service hands over its `@fabric/discord` client (`gateway`
 * event) and a Doorman Discord adapter maps voice occupancy into
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
   * @param {Object} [settings.community] services/community.js: plug the game into its shared
   *   Doorman and Discord adapter instead of running our own (`operations` then only reports
   *   gateway status).
   * @param {boolean} [settings.gateway] Attach to the Discord gateway when available (default true).
   * @param {string} [settings.guildId] Home Discord server. Its display name outranks every other name.
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
      gateway: true,
      guildId: null
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.doorman = null;
    this.game = null;
    this.adapter = null;
    this.discord = null;
    this.gateway = { status: 'disabled', error: null };
    this._listeners = {};
    this._onGateway = (discord) => this.attach(discord);
    this._onAttached = (discord, adapter) => this._attached(discord, adapter);
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
    const IdleRPG = this.settings.IdleRPG || require('idlerpg/services/idlerpg');
    const community = this.settings.community;
    const settings = {
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
    };

    if (community) {
      this.doorman = community.doorman;
      this.game = community.plug(IdleRPG, settings);
    } else {
      const Doorman = this.settings.Doorman || require('@fabric/doorman');
      this.doorman = new Doorman({ name: 'GOON.VC:doorman', http: false, local: false });
      this.doorman.on('error', (error) => this.emit('error', 'presence doorman', errorMessage(error)));
      this.doorman.use(IdleRPG, settings);
      this.game = this.doorman.plugins.idlerpg;
    }
    this.game.on('error', (error) => this.emit('error', 'presence game', errorMessage(error)));
    this.game.on('message', (message) => {
      this.announce(message).catch((error) => this.emit('error', 'presence announce', errorMessage(error)));
    });
    // Both resolve once the plugin has started (Store open, prior state restored).
    if (community) await community.ready(this.game);
    else await this.doorman.start();
    await assertStoreOpen(this.game.store);

    if (this.settings.gateway !== false) {
      this.gateway = { status: 'waiting', error: null };
      const operations = this.settings.operations;
      if (community) {
        if (community.adapter) this._attached(community.discord, community.adapter);
        else community.on('attached', this._onAttached);
      } else if (operations) {
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
    const adapter = new DoormanDiscord({ client: discord, replies: false, guildId: this.settings.guildId || null });
    this.doorman.enable('discord', adapter);
    return this._attached(discord, adapter);
  }

  /**
   * Post and name players through a Doorman Discord adapter that is already
   * enabled (ours, or the shared one in services/community.js).
   * @param {Object} discord `@fabric/discord` client
   * @param {Object} adapter Doorman Discord adapter
   * @returns {Presence}
   */
  _attached (discord, adapter) {
    if (!discord || this.adapter) return this;
    this.discord = discord;
    this.adapter = adapter;
    this.gateway = { status: 'attached', error: null };
    this.emit('log', 'GOON.VC', 'presence: attached to the Discord gateway');
    const backfill = () => this.backfillNames(discord).catch((error) => this.emit('error', 'presence names', errorMessage(error)));
    if (discord.botReady) backfill();
    else if (typeof discord.once === 'function') discord.once('ready', backfill);
    return this;
  }

  /** Home Discord server, when one is configured. */
  _homeGuildId () {
    const fromAdapter = this.adapter && this.adapter.settings && this.adapter.settings.guildId;
    return fromAdapter ? String(fromAdapter) : (this.settings.guildId ? String(this.settings.guildId) : null);
  }

  /**
   * A name from the member cache, the home server when we don't have its
   * display name yet, or any guild / the user record for someone still unnamed.
   * @param {Object} discord
   * @param {string} userId
   * @param {Object} player
   * @returns {Promise<{ name: string, rank: number }|null>}
   */
  async _playerName (discord, userId, player) {
    const HOME = 40;
    const stored = Number.isFinite(Number(player.nameRank)) ? Number(player.nameRank) : (player.name ? 0 : -1);
    const adapter = this.adapter;
    let choice = adapter && typeof adapter.bestName === 'function' ? adapter.bestName(userId) : null;
    if (this._homeGuildId() && !(choice && choice.rank >= HOME) && stored < HOME && adapter && typeof adapter.homeName === 'function') {
      const home = await adapter.homeName(userId);
      if (home && (!choice || home.rank > choice.rank)) choice = home;
    }
    if (choice) return choice;
    if (player.name) return null;
    const client = discord.client;
    const guilds = client && client.guilds && client.guilds.cache ? [...client.guilds.cache.values()] : [];
    const homeId = this._homeGuildId();
    guilds.sort((a, b) => (String(a.id) === homeId ? 0 : 1) - (String(b.id) === homeId ? 0 : 1));
    for (const guild of guilds) {
      const cached = adapter && typeof adapter.displayName === 'function' ? adapter.displayName(userId, guild.id) : null;
      if (cached) return { name: cached, rank: String(guild.id) === homeId ? HOME : 0 };
      if (typeof guild.members.fetch !== 'function') continue;
      const member = await guild.members.fetch(userId).catch(() => null);
      if (!member) continue;
      const name = member.nickname || member.displayName || (member.user && (member.user.globalName || member.user.username));
      if (name) return { name: String(name), rank: String(guild.id) === homeId ? HOME : (member.nickname ? 20 : 0) };
    }
    if (client && client.users && typeof client.users.fetch === 'function') {
      const user = await client.users.fetch(userId).catch(() => null);
      if (user) {
        const name = user.globalName || user.username;
        if (name) return { name: String(name), rank: user.globalName ? 10 : 0 };
      }
    }
    return null;
  }

  /**
   * Apply the best cached name to every player, and ask the home server for
   * anyone who does not yet have its display name (otherwise they stay
   * "Unknown pilot", or keep a weaker name, until they next join voice).
   * @param {Object} discord `@fabric/discord` client
   * @returns {Promise<number>} players whose name changed
   */
  async backfillNames (discord) {
    if (!this.game || !discord) return 0;
    let named = 0;
    for (const player of Object.values(this.game.content.players)) {
      const userId = discordUserId(player);
      if (!userId) continue;
      const choice = await this._playerName(discord, userId, player);
      if (!choice || !choice.name) continue;
      const before = player.name;
      const beforeRank = player.nameRank;
      await this.game._registerUser({ id: `discord/users/${userId}`, name: choice.name, rank: choice.rank });
      const after = this.game.playerFor(`discord/users/${userId}`);
      if (after && (after.name !== before || after.nameRank !== beforeRank)) named += 1;
    }
    if (named) await this.game._persist();
    return named;
  }

  async stop () {
    const operations = this.settings.operations;
    const community = this.settings.community;
    if (operations && typeof operations.removeListener === 'function') operations.removeListener('gateway', this._onGateway);
    // A shared Doorman is stopped (with every plugin) by its owner.
    if (community) community.removeListener('attached', this._onAttached);
    else if (this.doorman) await this.doorman.stop();
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
   * When a member was last present in a voice channel, or null when they
   * have never played.
   * @param {string} target Doorman user id (`discord/users/<id>`).
   * @returns {string|null} ISO time
   */
  lastSeen (target) {
    const record = this.game && typeof this.game.playerFor === 'function' ? this.game.playerFor(target) : null;
    return record && record.lastSeen ? record.lastSeen : null;
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
