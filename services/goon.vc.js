'use strict';

const fs = require('fs');
const path = require('path');
const HTTPServer = require('@fabric/http/types/server');
const { resolveHttpListenHost } = require('@fabric/http/functions/httpSharedMode');
const { assertAllowedFabricHub } = require('@fabric/http/functions/fabricHubAllowlist');
const {
  createHubApiMiddleware,
  normalizeHubOrigin,
  shouldProxyHubApi
} = require('../functions/hubApiProxy');
const Members = require('./members');
const Events = require('./events');
const Operations = require('./operations');
const Presence = require('./presence');
const GoonSite = require('../types/GoonSite');
const pageMeta = require('../functions/pageMeta');
const { assertStoreOpen } = require('../functions/startStore');

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
        '/members/login': '/sessions',
        '/idlerpg': '/services/idlerpg',
        '/idlerpg/': '/services/idlerpg',
        '/drills/melee-rotation-drill.html': '/drills/melee-rotation'
      },
      spaFallback: true
    }, settings);

    this.settings = merged;
    this.http = null;
    this.members = null;
    this.events = null;
    this.operations = null;
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

  /**
   * Serve the built SPA shell with the requested page's Open Graph tags, so
   * link previews (which never run the client router) describe that page.
   * @param {string} assets Static root holding index.html.
   * @returns {Function}
   */
  _pageMetaMiddleware (assets) {
    const spa = new GoonSite(this.settings.site || {}).spa;
    const site = spa.metaSite();
    const pages = spa.pages().map((page) => Object.assign({}, page, { tags: pageMeta.renderMetaTags(page, site) }));
    const file = path.join(assets, 'index.html');
    let cached = { mtimeMs: -1, html: null };
    const shell = () => {
      const stat = fs.statSync(file);
      if (stat.mtimeMs !== cached.mtimeMs) cached = { mtimeMs: stat.mtimeMs, html: fs.readFileSync(file, 'utf8') };
      return cached.html;
    };
    return (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (shouldProxyHubApi(req)) return next();
      // Applications mounted under /services answer browsers with the page
      // and fetch() / API clients with JSON at the same URL.
      if (/^\/services(\/|$)/.test(req.path) && !/text\/html/i.test(String(req.headers.accept || ''))) return next();
      const page = pageMeta.findPage(pages, req.path);
      if (!page) return next();
      let html;
      try {
        html = shell();
      } catch (_) {
        return next();
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      if (req.method === 'HEAD') return res.end();
      res.end(pageMeta.injectMeta(html, page.tags, page.title));
    };
  }

  /**
   * Start every service; if any fails (e.g. a store will not open), stop the
   * ones already running and rethrow so the process exits.
   * @returns {Promise<GoonVC>}
   */
  async start () {
    try {
      return await this._start();
    } catch (error) {
      await this.stop().catch(() => {});
      throw error;
    }
  }

  async _start () {
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
      scheduleBrand: discord.schedule && discord.schedule.brand,
      fetch: eventSettings.fetch,
      resolveToken: eventSettings.resolveToken
    });
    await this.events.start();

    const operationSettings = this.settings.operations || {};
    this.operations = new Operations({
      path: operationSettings.path || './stores/operations',
      file: operationSettings.file ? path.resolve(operationSettings.file) : undefined,
      discord,
      gateway: operationSettings.gateway,
      flushMs: operationSettings.flushMs,
      tickMs: operationSettings.tickMs,
      Discord: operationSettings.Discord,
      resolveToken: operationSettings.resolveToken
    });
    this.operations.on('log', (...parts) => this.emit('log', ...parts));
    this.operations.on('error', (...parts) => this.emit('error', ...parts));
    await this.operations.start();

    const presenceSettings = this.settings.presence || {};
    this.presence = new Presence({
      path: presenceSettings.path || './stores/presence',
      tickMs: presenceSettings.tickMs,
      luck: presenceSettings.luck,
      channels: presenceSettings.channels,
      announcements: presenceSettings.announcements,
      gateway: presenceSettings.gateway,
      operations: this.operations,
      Doorman: presenceSettings.Doorman,
      IdleRPG: presenceSettings.IdleRPG,
      DoormanDiscord: presenceSettings.DoormanDiscord
    });
    this.presence.on('log', (...parts) => this.emit('log', ...parts));
    this.presence.on('error', (...parts) => this.emit('error', ...parts));
    await this.presence.start();

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
      // `/` must reach pageMeta instead of express.static's directory index.
      static: { index: false },
      jsonRpc: { enabled: false },
      cors: true,
      sitemap: { enabled: true },
      middlewares: {
        pageMeta: this._pageMetaMiddleware(assets),
        hubApi: createHubApiMiddleware(hubOrigin, {
          timeoutMs: this.settings.hub && this.settings.hub.timeoutMs
        }),
        members: this.members.middleware(),
        events: this.events.middleware(),
        operations: this.operations.middleware(),
        presence: this.presence.middleware()
      }
    });

    this.http.on('debug', (...parts) => this.emit('debug', ...parts));
    this.http.on('error', (...parts) => this.emit('error', ...parts));
    this.http.on('log', (...parts) => this.emit('log', ...parts));

    await this.http.start();
    await assertStoreOpen(this.http.localStore);
    this.emit('log', 'GOON.VC', `HTML site on ${listenHost}:${port}; Hub APIs → ${hubOrigin}`);
    return this;
  }

  async stop () {
    const errors = [];
    for (const service of [this.http, this.members, this.events, this.presence, this.operations]) {
      if (!service || typeof service.stop !== 'function') continue;
      try {
        await service.stop();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw errors[0];
    return this;
  }
}

module.exports = GoonVC;
module.exports.DEFAULT_HUB_ORIGIN = DEFAULT_HUB_ORIGIN;
module.exports.DEFAULT_HTTP_PORT = DEFAULT_HTTP_PORT;
