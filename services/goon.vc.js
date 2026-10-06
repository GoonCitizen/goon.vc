'use strict';

const path = require('path');
const HTTPServer = require('@fabric/http/types/server');
const { resolveHttpListenHost } = require('@fabric/http/functions/httpSharedMode');
const { assertAllowedFabricHub } = require('@fabric/http/functions/fabricHubAllowlist');
const {
  createHubApiMiddleware,
  normalizeHubOrigin
} = require('../functions/hubApiProxy');
const Members = require('./members');
const Events = require('./events');

const DEFAULT_HUB_ORIGIN = 'https://hub.fabric.pub';
const DEFAULT_HTTP_PORT = 8080;

function isPlainObject (value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function mergeDeep (target, source) {
  if (!isPlainObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    if (Array.isArray(value)) {
      target[key] = value.slice();
      continue;
    }
    if (isPlainObject(value)) {
      const base = isPlainObject(target[key]) ? target[key] : {};
      target[key] = mergeDeep(base, value);
      continue;
    }
    target[key] = value;
  }
  return target;
}

function envHubOrigin () {
  const raw = process.env.FABRIC_HUB_ORIGIN || process.env.HUB_ORIGIN || '';
  return normalizeHubOrigin(raw);
}

function envHttpPort () {
  const raw = process.env.FABRIC_HUB_PORT || process.env.PORT;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 1 && n <= 65535) return n;
  return null;
}

/**
 * Public goon.vc zipper: serve the GoonSPA HTML site and reverse-proxy the
 * Hub API paths Passport / GoonCitizen login need. Not a Fabric Hub, not
 * LiveRelay — those live at hub.fabric.pub and relay.goon.vc.
 */
class GoonVC {
  /**
   * @param {Object} [settings]
   */
  constructor (settings = {}) {
    const defaultSite = {
      title: 'GOON SQUAD',
      monitorUrl: 'https://relay.goon.vc',
      joinUrl: 'https://discord.com/servers/g00n-squad-1190527980120850493',
      loginLabel: '&gt; LOGIN &lt;',
      loginPath: '/sessions',
      discordWidgetId: '1190527980120850493',
      bitcoinAddress: 'bc1qx5ktkj6utjw3vl43htvn434c9kg89m73lympr0',
      copyright: '&copy; big lol'
    };

    const listenHost = resolveHttpListenHost({
      host: settings.host || settings.http && settings.http.interface,
      envHost: process.env.FABRIC_HUB_INTERFACE || process.env.FABRIC_HTTP_INTERFACE || process.env.INTERFACE
    });

    const merged = mergeDeep({
      name: 'GOON.VC',
      site: defaultSite,
      hub: {
        origin: envHubOrigin() || DEFAULT_HUB_ORIGIN
      },
      http: {
        port: envHttpPort() || DEFAULT_HTTP_PORT,
        interface: listenHost,
        hostname: process.env.FABRIC_HUB_HOSTNAME || process.env.HOSTNAME || 'goon.vc'
      },
      peers: [],
      redirects: {
        '/permafleet': '/operations/PERMAFLEET',
        '/permafleet/': '/operations/PERMAFLEET',
        '/permafleet/schedule': '/operations/PERMAFLEET/schedule',
        '/members/login': '/sessions'
      },
      spaFallback: true
    }, settings);

    this.settings = merged;
    this.http = null;
    this.members = null;
    this.events = null;
    this.id = 'goon.vc';
    this.name = merged.name || 'GOON.VC';
    this._listeners = {};
  }

  on (event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  emit (event, ...args) {
    const list = this._listeners[event] || [];
    for (let i = 0; i < list.length; i++) {
      try { list[i](...args); } catch (_) { /* listener errors stay local */ }
    }
    return this;
  }

  _hubOrigin () {
    const fromSettings = this.settings.hub && this.settings.hub.origin;
    return normalizeHubOrigin(fromSettings) || envHubOrigin() || DEFAULT_HUB_ORIGIN;
  }

  _assertHubOrigin () {
    const origin = this._hubOrigin();
    const allowed = assertAllowedFabricHub(origin);
    if (!allowed.ok) {
      throw new Error(allowed.error || `Hub origin not allowed: ${origin}`);
    }
    return allowed.hubBase;
  }

  async start () {
    const hubOrigin = this._assertHubOrigin();
    const assets = this.settings.assets
      || path.resolve(__dirname, '..', 'assets');
    const listenHost = (this.settings.http && this.settings.http.interface)
      || resolveHttpListenHost({});
    const port = (this.settings.http && this.settings.http.port) || DEFAULT_HTTP_PORT;
    const hostname = (this.settings.http && this.settings.http.hostname) || 'goon.vc';
    const discord = this.settings.discord || {};
    const memberSettings = this.settings.members || {};

    this.members = new Members({
      path: memberSettings.path || './stores/members',
      hubOrigin,
      loginPath: (this.settings.site && this.settings.site.loginPath) || '/sessions',
      sessionTtlMs: memberSettings.sessionTtlMs,
      fetch: memberSettings.fetch,
      discord: {
        clientId: discord.clientId,
        clientSecret: discord.clientSecret,
        redirectUri: discord.redirectUri,
        guildId: discord.guildId
      }
    });
    await this.members.start();

    const eventSettings = this.settings.events || {};
    this.events = new Events({
      path: eventSettings.path || './stores/events',
      discord,
      ttlMs: eventSettings.ttlMs,
      snapshot: discord.schedule && discord.schedule.snapshot
        ? path.resolve(discord.schedule.snapshot)
        : undefined,
      fetch: eventSettings.fetch,
      resolveToken: eventSettings.resolveToken
    });
    await this.events.start();

    this.http = new HTTPServer({
      name: this.name,
      assets,
      path: this.settings.storePath || './stores/site',
      host: listenHost,
      interface: listenHost,
      hostname,
      port,
      listen: this.settings.listen !== false,
      peers: [],
      redirects: this.settings.redirects,
      spaFallback: this.settings.spaFallback !== false,
      spaFallbackExclude: /^\/(services|identity)(\/|$)/,
      jsonRpc: { enabled: false },
      cors: true,
      sitemap: { enabled: true },
      middlewares: {
        hubApi: createHubApiMiddleware(hubOrigin, {
          timeoutMs: this.settings.hub && this.settings.hub.timeoutMs
        }),
        members: this.members.middleware(),
        events: this.events.middleware()
      }
    });

    this.http.on('debug', (...parts) => this.emit('debug', ...parts));
    this.http.on('error', (...parts) => this.emit('error', ...parts));
    this.http.on('log', (...parts) => this.emit('log', ...parts));

    await this.http.start();
    this.emit('log', 'GOON.VC', `HTML site on ${listenHost}:${port}; Hub APIs → ${hubOrigin}`);
    return this;
  }

  async stop () {
    if (this.http && typeof this.http.stop === 'function') {
      await this.http.stop();
    }
    if (this.members) await this.members.stop();
    if (this.events) await this.events.stop();
    return this;
  }
}

module.exports = GoonVC;
module.exports.DEFAULT_HUB_ORIGIN = DEFAULT_HUB_ORIGIN;
module.exports.DEFAULT_HTTP_PORT = DEFAULT_HTTP_PORT;
