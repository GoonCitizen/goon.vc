'use strict';

const fs = require('fs');
const path = require('path');
const Store = require('@fabric/core/types/store');
const MetricsPipeline = require('@fabric/discord/types/metricsPipeline');
const { voiceActivity, messageActivity, gatewayIntents } = require('@fabric/discord/plugins');
const resolveDiscordToken = require('../functions/resolveDiscordToken');

const BASE = '/services/operations';
const DEFAULT_FILE = path.join(__dirname, '../contracts/operations.json');
const PERMAFLEET_PATH = '/operations/PERMAFLEET';

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Most active first: members in voice now, then 7-day voice hours, then
 * 7-day messages.
 * @param {{ metrics: Object }} a
 * @param {{ metrics: Object }} b
 * @returns {number}
 */
function byActivity (a, b) {
  const key = (op) => {
    const voice = (op.metrics && op.metrics.voice) || {};
    const messages = (op.metrics && op.metrics.messages) || {};
    return [
      voice.live || 0,
      (voice.last7Days && voice.last7Days.hours) || 0,
      (messages.last7Days && messages.last7Days.messages) || 0
    ];
  };
  const ka = key(a);
  const kb = key(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return kb[i] - ka[i];
  }
  return 0;
}

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

/**
 * Cross-org operations and their metrics. A `@fabric/discord` gateway client
 * (non-privileged intents only, no replies) feeds Discord voice and message
 * events through a `MetricsPipeline`; plugin state lives in an on-disk
 * `@fabric/core` Store, so metrics survive restarts and Discord outages.
 * Only aggregate counts leave this process — never member ids or content.
 */
class Operations {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string} [settings.file] Operations contract (contracts/operations.json).
   * @param {Object} [settings.discord] settings.discord (token / secretsFile).
   * @param {boolean} [settings.gateway] Connect to the Discord gateway (default true).
   * @param {Array<Object>} [settings.plugins] Metrics plugins (default voice + messages).
   * @param {number} [settings.flushMs]
   * @param {number} [settings.tickMs]
   * @param {Function} [settings.Discord] Injected for tests; defaults to @fabric/discord.
   * @param {Function} [settings.resolveToken] Injected for tests; defaults to resolveDiscordToken.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/operations',
      file: DEFAULT_FILE,
      discord: {},
      gateway: true
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this._resolveToken = this.settings.resolveToken || resolveDiscordToken;
    this.operations = [];
    this.store = null;
    this.pipeline = null;
    this.discord = null;
    this.gateway = { status: 'disabled', error: null };
    this._gatewayStarting = null;
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

  _load () {
    const raw = JSON.parse(fs.readFileSync(this.settings.file, 'utf8'));
    const guildId = raw.guildId ? String(raw.guildId) : null;
    return (raw.operations || []).filter((op) => op && op.id).map((op) => Object.assign({
      guildId,
      path: `${PERMAFLEET_PATH}#${op.id}`
    }, op));
  }

  async start () {
    this.operations = this._load();
    this.store = new Store({
      name: 'GOON.VC:operations',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await this.store.start();
    this.pipeline = new MetricsPipeline(Object.assign({
      store: this.store,
      operations: this.operations,
      plugins: this.settings.plugins || [voiceActivity(), messageActivity()]
    }, this.settings.flushMs != null ? { flushMs: this.settings.flushMs } : {},
    this.settings.tickMs != null ? { tickMs: this.settings.tickMs } : {}));
    this.pipeline.on('error', (error) => this.emit('error', 'operations metrics', errorMessage(error)));
    await this.pipeline.start();
    if (this.settings.gateway !== false) this._gatewayStarting = this._startGateway();
    return this;
  }

  async _startGateway () {
    const auth = this._resolveToken(this.settings.discord);
    if (!auth || !auth.token) {
      this.gateway = { status: 'no-token', error: 'No Discord bot token configured' };
      return;
    }
    const Discord = this.settings.Discord || require('@fabric/discord');
    const discord = new Discord({
      token: auth.token,
      intents: gatewayIntents(this.pipeline),
      autoCommands: false
    });
    discord.on('error', (error) => this.emit('error', 'operations discord', errorMessage(error)));
    discord.on('ready', () => {
      this.gateway = { status: 'connected', error: null };
      this.emit('log', 'GOON.VC', 'operations metrics: Discord gateway ready');
    });
    this.pipeline.attach(discord);
    this.discord = discord;
    this.gateway = { status: 'connecting', error: null };
    try {
      await discord.start();
    } catch (error) {
      this.gateway = { status: 'error', error: errorMessage(error) };
      this.emit('error', 'operations discord', this.gateway.error);
    }
  }

  async stop () {
    if (this._gatewayStarting) await this._gatewayStarting.catch(() => {});
    if (this.discord) {
      try { await this.discord.stop(); } catch (_) { /* already down */ }
    }
    if (this.pipeline) await this.pipeline.stop();
    if (this.store) await this.store.stop();
    return this;
  }

  /**
   * Public metrics: operation copy plus each plugin's aggregate summary,
   * most active first (ties keep contract order).
   * @returns {Promise<object>}
   */
  async report () {
    const report = await this.pipeline.report();
    const byId = new Map(report.operations.map((op) => [op.id, op.metrics]));
    return {
      generatedAt: report.generatedAt,
      gateway: this.gateway,
      operations: this.operations.map((op) => ({
        id: op.id,
        name: op.name,
        path: op.path,
        metrics: byId.get(op.id) || {}
      })).sort(byActivity)
    };
  }

  /**
   * Express middleware for `GET /services/operations`.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const url = new URL(req.originalUrl || req.url, 'http://localhost');
      const pathname = (req.path || url.pathname).replace(/\/+$/, '');
      if (pathname !== BASE) return next();
      if (String(req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      this.report().then((body) => sendJson(res, 200, body)).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: errorMessage(error) || 'Operations unavailable' });
      });
    };
  }
}

module.exports = Operations;
module.exports.byActivity = byActivity;
