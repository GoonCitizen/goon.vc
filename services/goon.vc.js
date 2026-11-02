'use strict';

const fs = require('fs');
const path = require('path');
const HTTPServer = require('@fabric/http/types/server');
const { resolveHttpListenHost } = require('@fabric/http/functions/httpSharedMode');
const { assertAllowedFabricHub } = require('@fabric/http/functions/fabricHubAllowlist');
const {
  createHubApiMiddleware,
  createHubList,
  normalizeHubOrigin,
  shouldProxyHubApi
} = require('../functions/hubApiProxy');
const Members = require('./members');
const Events = require('./events');
const Operations = require('./operations');
const Presence = require('./presence');
const Community = require('./community');
const Tournaments = require('./tournaments');
const Leagues = require('./leagues');
const Leaderboard = require('./leaderboard');
const Activity = require('./activity');
const Clips = require('./clips');
const Commands = require('./commands');
const Checkins = require('./checkins');
const Welcome = require('./welcome');
const Reviews = require('./reviews');
const FabricRelay = require('./fabricRelay');
const Alliance = require('./alliance');
const Market = require('./market');
const Hangar = require('./hangar');
const Schedule = require('./schedule');
const GoonSite = require('../types/GoonSite');
const pageMeta = require('../functions/pageMeta');
const { assertStoreOpen } = require('../functions/startStore');
const { resolveDiscordClientSecret } = require('../functions/resolveDiscordToken');
const createDiscordDirectory = require('../functions/discordDirectory');

const DEFAULT_HUB_ORIGIN = 'https://hub.fabric.pub';
const DEFAULT_HUB_SEEDS = ['https://hub.goon.vc'];
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

function envHubSeeds () {
  const raw = process.env.FABRIC_HUB_SEEDS;
  if (raw === undefined) return null;
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

function isLoopbackOrigin (origin) {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch (_) {
    return false;
  }
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
        origin: envHubOrigin() || DEFAULT_HUB_ORIGIN,
        seeds: envHubSeeds() || DEFAULT_HUB_SEEDS
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
    this.hangar = null;
    this.events = null;
    this.operations = null;
    this.tournaments = null;
    this.leagues = null;
    this.commands = null;
    this.checkins = null;
    this.welcome = null;
    this.reviews = null;
    this.leaderboard = null;
    this.clips = null;
    this.fabric = null;
    this.alliance = null;
    this.market = null;
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
   * The Hub, then `hub.seeds` in order (tried when the ones before can't be
   * reached). Seeds outside the Fabric Hub allowlist are skipped, and none are
   * used with a loopback Hub: falling over from a local Hub to a public one
   * would sign members in somewhere else.
   * @returns {string[]}
   */
  _hubOrigins () {
    const primary = this._assertHubOrigin();
    if (isLoopbackOrigin(primary)) return [primary];
    const origins = [primary];
    const seeds = (this.settings.hub && this.settings.hub.seeds) || [];
    for (const seed of [].concat(seeds)) {
      const allowed = assertAllowedFabricHub(seed);
      if (!allowed.ok) {
        this.emit('error', 'GOON.VC', `skipping Hub seed: ${allowed.error}`);
        continue;
      }
      if (!origins.includes(allowed.hubBase)) origins.push(allowed.hubBase);
    }
    return origins;
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
    const loginPath = String(spa._site('loginPath') || '/sessions').toLowerCase();
    const stores = [
      [() => this.presence, pageMeta.findPage(pages, spa._site('idlerpgPath'))],
      [() => this.tournaments, pageMeta.findPage(pages, spa._site('tournamentsPath'))],
      [() => this.leagues, pageMeta.findPage(pages, spa._site('leaguesPath'))],
      [() => this.clips, pageMeta.findPage(pages, spa._site('clipsPath'))],
      [() => this.alliance, pageMeta.findPage(pages, spa._site('permafleetVotesPath'))],
      [() => this.alliance && { page: (pathname) => this.alliance.federationPage(pathname) }, pageMeta.findPage(pages, spa._site('federationsPath'))],
      [() => this.market, pageMeta.findPage(pages, spa._site('marketPath'))],
      [() => this.members, pageMeta.findPage(pages, spa._site('membersPath'))]
    ];
    const storedPage = async (pathname) => {
      for (const [service, index] of stores) {
        const found = service() && index ? await service().page(pathname) : null;
        if (!found) continue;
        const page = Object.assign({}, index, found, { title: `${found.title} — ${spa._site('title')}` });
        return Object.assign(page, { tags: pageMeta.renderMetaTags(page, site) });
      }
      return null;
    };
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
      const serve = (page) => {
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
        // Another site must not frame the login page and click its buttons.
        if ((req.path.replace(/\/+$/, '') || '/').toLowerCase() === loginPath) {
          res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
        }
        if (req.method === 'HEAD') return res.end();
        res.end(pageMeta.injectMeta(html, page.tags, page.title));
      };
      const page = pageMeta.findPage(pages, req.path);
      if (page) return serve(page);
      storedPage(req.path).then(serve, () => next());
    };
  }

  /**
   * Page paths have no trailing slash. Mounted ahead of express.static, which
   * would otherwise answer a page path that is also a directory under assets
   * (e.g. a leftover assets/drills/) with a redirect to the trailing-slash URL.
   * Such requests reach static with the slash (static then falls through)
   * and get the original URL back from {@link GoonVC#_restorePathMiddleware}.
   * @returns {Function}
   */
  _canonicalPathMiddleware () {
    const spa = new GoonSite(this.settings.site || {}).spa;
    const pages = spa.pages();
    const prefixes = ['tournamentsPath', 'leaguesPath', 'clipsPath', 'permafleetVotesPath', 'federationsPath', 'membersPath'].map((key) => `${spa._site(key).toLowerCase()}/`);
    const isPage = (pathname) => !!pageMeta.findPage(pages, pathname)
      || prefixes.some((prefix) => pathname.toLowerCase().startsWith(prefix));
    return (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      if (shouldProxyHubApi(req) || /^\/(services|identity)(\/|$)/.test(req.path)) return next();
      if (Object.prototype.hasOwnProperty.call(this.settings.redirects || {}, req.path)) return next();
      const query = req.url.slice(req.path.length);
      if (req.path.length > 1 && req.path.endsWith('/')) {
        const target = req.path.replace(/\/+$/, '') || '/';
        if (isPage(target)) return res.redirect(301, target + query);
        return next();
      }
      if (req.path !== '/' && isPage(req.path)) {
        req.goonPageUrl = req.url;
        req.url = `${req.path}/${query}`;
      }
      return next();
    };
  }

  /**
   * A compiled client script asked for at its current `?v=` (the URL the
   * built pages use) never changes, so browsers keep it for a year. Any other
   * request for it (no version, or an older build's) revalidates as usual.
   * @returns {Function}
   */
  _clientScriptCacheMiddleware () {
    const versions = new Map(new GoonSite(this.settings.site || {}).spa.clientScripts().map((client) => [client.src, client.version]));
    return (req, res, next) => {
      if ((req.method === 'GET' || req.method === 'HEAD') && versions.has(req.path) && req.query.v === versions.get(req.path)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
      return next();
    };
  }

  _restorePathMiddleware () {
    return (req, res, next) => {
      if (req.goonPageUrl) {
        req.url = req.goonPageUrl;
        delete req.goonPageUrl;
      }
      return next();
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
    const hubs = createHubList(this._hubOrigins());
    const assets = this.settings.assets
      || path.resolve(__dirname, '..', 'assets');
    const listenHost = (this.settings.http && this.settings.http.interface)
      || resolveHttpListenHost({});
    const port = (this.settings.http && this.settings.http.port) || DEFAULT_HTTP_PORT;
    const hostname = (this.settings.http && this.settings.http.hostname) || 'goon.vc';
    const discord = this.settings.discord || {};
    const memberSettings = this.settings.members || {};
    const reviewSettings = memberSettings.review || {};
    const spa = new GoonSite(this.settings.site || {}).spa;

    this.members = new Members({
      path: memberSettings.path || './stores/members',
      origins: memberSettings.origins,
      loginPath: (this.settings.site && this.settings.site.loginPath) || '/sessions',
      siteUrl: spa._site('siteUrl'),
      claimPath: spa._site('rsiClaimPath'),
      review: reviewSettings.enabled === true,
      waitingPath: spa._site('waitingPath'),
      membersPath: spa._site('membersPath'),
      sessionTtlMs: memberSettings.sessionTtlMs,
      fetch: memberSettings.fetch,
      // Escrow keys are linked for the network the Market's Hub runs on.
      escrowNetwork: () => (this.market ? this.market._network() : null),
      discord: {
        clientId: discord.clientId,
        clientSecret: (memberSettings.resolveClientSecret || resolveDiscordClientSecret)(discord).clientSecret,
        // Without DISCORD_APP_ID, sign in through the application that owns the bot token.
        applicationId: () => (this.events ? this.events.applicationId() : null),
        redirectUri: discord.redirectUri,
        guildId: discord.guildId
      }
    });
    this.members.on('log', (...parts) => this.emit('log', ...parts));
    await this.members.start();

    const hangarSettings = this.settings.hangar || {};
    if (hangarSettings.enabled !== false) {
      this.hangar = new Hangar({
        path: hangarSettings.path || './stores/hangar',
        members: this.members,
        token: (this.settings.community && this.settings.community.token) || null
      });
      this.hangar.on('log', (...parts) => this.emit('log', ...parts));
      this.hangar.on('error', (...parts) => this.emit('error', ...parts));
      await this.hangar.start();
    }

    const eventSettings = this.settings.events || {};
    this.events = new Events({
      path: eventSettings.path || './stores/events',
      discord,
      ttlMs: eventSettings.ttlMs,
      snapshot: discord.schedule && discord.schedule.snapshot
        ? path.resolve(discord.schedule.snapshot)
        : undefined,
      scheduleBrand: discord.schedule && discord.schedule.brand,
      scheduleServers: discord.schedule && discord.schedule.servers,
      fetch: eventSettings.fetch,
      resolveToken: eventSettings.resolveToken
    });
    await this.events.start();

    const fabricSettings = this.settings.fabric || {};
    const communitySettings = this.settings.community || {};
    const operationSettings = this.settings.operations || {};
    const communityGateway = Community.gateway(communitySettings);
    const marketSettings = this.settings.market || {};
    const marketOn = marketSettings.enabled !== false;
    const intents = [...new Set([
      ...(FabricRelay.enabled(fabricSettings) ? FabricRelay.INTENTS : []),
      ...(marketOn && marketSettings.sync !== false ? Market.INTENTS : []),
      ...communityGateway.intents
    ])];
    this.operations = new Operations({
      path: operationSettings.path || './stores/operations',
      file: operationSettings.file ? path.resolve(operationSettings.file) : undefined,
      discord,
      gateway: operationSettings.gateway,
      intents: intents.length ? intents : undefined,
      partials: communityGateway.partials.length ? communityGateway.partials : undefined,
      flushMs: operationSettings.flushMs,
      tickMs: operationSettings.tickMs,
      Discord: operationSettings.Discord,
      resolveToken: operationSettings.resolveToken
    });
    this.operations.on('log', (...parts) => this.emit('log', ...parts));
    this.operations.on('error', (...parts) => this.emit('error', ...parts));
    await this.operations.start();

    this.community = new Community({
      enabled: communitySettings.enabled,
      path: communitySettings.path || './stores/community',
      scripts: communitySettings.scripts ? path.resolve(communitySettings.scripts) : undefined,
      token: communitySettings.token || null,
      campaigns: communitySettings.campaigns,
      siteUrl: spa._site('siteUrl'),
      gateway: operationSettings.gateway,
      operations: this.operations,
      guildId: discord.guildId,
      Doorman: communitySettings.Doorman,
      Scripts: communitySettings.Scripts,
      Campaigns: communitySettings.Campaigns,
      DoormanDiscord: communitySettings.DoormanDiscord
    });
    this.community.on('log', (...parts) => this.emit('log', ...parts));
    this.community.on('error', (...parts) => this.emit('error', ...parts));
    await this.community.start();

    const presenceSettings = this.settings.presence || {};
    this.presence = new Presence({
      path: presenceSettings.path || './stores/presence',
      tickMs: presenceSettings.tickMs,
      luck: presenceSettings.luck,
      sources: presenceSettings.sources,
      channels: presenceSettings.channels,
      announcements: presenceSettings.announcements,
      gateway: presenceSettings.gateway,
      operations: this.operations,
      community: this.community,
      guildId: discord.guildId,
      Doorman: presenceSettings.Doorman,
      IdleRPG: presenceSettings.IdleRPG,
      DoormanDiscord: presenceSettings.DoormanDiscord
    });
    this.presence.on('log', (...parts) => this.emit('log', ...parts));
    this.presence.on('error', (...parts) => this.emit('error', ...parts));
    await this.presence.start();

    const activitySettings = this.settings.activity || {};
    this.activity = new Activity({
      path: activitySettings.path || './stores/activity',
      discord,
      sync: activitySettings.sync,
      ttlMs: activitySettings.ttlMs,
      refreshOnStart: activitySettings.refreshOnStart,
      operations: this.operations,
      fetch: activitySettings.fetch,
      resolveToken: activitySettings.resolveToken
    });
    this.activity.on('error', (...parts) => this.emit('error', ...parts));
    await this.activity.start();
    // Last active = the later of being in voice and posting in the home server.
    this.community.activity(async (target) => {
      const times = [await this.presence.lastSeen(target), this.activity.lastPosted(target)]
        .map((value) => (value ? Date.parse(value) : NaN))
        .filter(Number.isFinite);
      return times.length ? new Date(Math.max(...times)).toISOString() : null;
    });

    const checkinSettings = this.settings.checkins || {};
    this.checkins = new Checkins({
      path: checkinSettings.path || './stores/checkins',
      community: this.community,
      contract: checkinSettings.contract
    });
    this.checkins.on('log', (...parts) => this.emit('log', ...parts));
    this.checkins.on('error', (...parts) => this.emit('error', ...parts));
    await this.checkins.start();

    const welcomeSettings = this.settings.welcome || {};
    this.welcome = new Welcome({
      path: welcomeSettings.path || './stores/welcome',
      community: this.community,
      contract: welcomeSettings.contract
    });
    this.welcome.on('log', (...parts) => this.emit('log', ...parts));
    this.welcome.on('error', (...parts) => this.emit('error', ...parts));
    await this.welcome.start();

    this.reviews = new Reviews({
      members: this.members,
      community: this.community,
      reviewers: reviewSettings.reviewers,
      waitingPath: spa._site('waitingPath')
    });
    this.reviews.on('log', (...parts) => this.emit('log', ...parts));
    this.reviews.on('error', (...parts) => this.emit('error', ...parts));
    await this.reviews.start();

    const tournamentSettings = this.settings.tournaments || {};
    const identify = async (req) => {
      const current = await this.members.currentMember(req);
      return (current && current.member.displayName) || null;
    };
    const postResults = (report, by) => this.leagues.recordTournament(Leagues.OPEN_LEAGUE_ID, report, by).catch((error) => {
      this.emit('error', 'GOON.VC', `could not post tournament ${report.id} to the Open League: ${error.message}`);
    });
    this.tournaments = new Tournaments({
      path: tournamentSettings.path || './stores/tournaments',
      basePath: spa._site('tournamentsPath'),
      password: tournamentSettings.password || null,
      identify,
      onResults: postResults
    });
    await this.tournaments.start();

    const leagueSettings = this.settings.leagues || {};
    this.leagues = new Leagues({
      path: leagueSettings.path || './stores/leagues',
      basePath: spa._site('leaguesPath'),
      identify,
      directory: leagueSettings.directory || createDiscordDirectory({
        discord,
        gateway: () => (this.operations && this.operations.discord ? this.operations.discord.client : null),
        fetch: leagueSettings.fetch,
        resolveToken: leagueSettings.resolveToken
      }),
      members: this.members
    });
    await this.leagues.start();
    this.members.on('merged', () => this.leagues.relinkMembers().catch((error) => {
      this.emit('error', 'GOON.VC', `could not relink league rosters after a member merge: ${error.message}`);
    }));
    for (const report of await this.tournaments.resultReports()) await postResults(report);

    const scheduleSettings = this.settings.schedule || {};
    if (scheduleSettings.enabled !== false) {
      this.schedule = new Schedule({
        path: scheduleSettings.path || './stores/schedule',
        discord,
        timeZone: scheduleSettings.timeZone,
        gateway: () => (this.operations && this.operations.discord ? this.operations.discord.client : null),
        inviteUrl: (purpose) => this.events.inviteUrl(purpose),
        onScheduled: () => {
          this.events.refresh().catch((error) => {
            this.emit('error', 'GOON.VC', `could not refresh events after scheduling: ${error.message}`);
          });
        },
        fetch: scheduleSettings.fetch,
        resolveToken: scheduleSettings.resolveToken,
        tick: scheduleSettings.tick
      });
      this.schedule.on('log', (...parts) => this.emit('log', ...parts));
      this.schedule.on('error', (...parts) => this.emit('error', ...parts));
      await this.schedule.start();
    }

    const commandSettings = this.settings.commands || {};
    this.commands = new Commands({
      operations: commandSettings.enabled === false ? null : this.operations,
      presence: this.presence,
      community: this.community,
      leagues: this.leagues,
      members: this.members,
      alliance: () => this.alliance,
      market: marketOn ? () => this.market : null,
      checkins: this.checkins,
      welcome: this.welcome,
      reviews: this.reviews,
      hangar: this.hangar,
      schedule: this.schedule,
      siteUrl: spa._site('siteUrl'),
      rsiPath: spa._site('rsiClaimPath'),
      votesPath: spa._site('permafleetVotesPath'),
      idlerpgPath: spa._site('idlerpgPath'),
      leaguesPath: spa._site('leaguesPath'),
      register: commandSettings.register
    });
    this.commands.on('log', (...parts) => this.emit('log', ...parts));
    this.commands.on('error', (...parts) => this.emit('error', ...parts));
    await this.commands.start();

    const leaderboardSettings = this.settings.leaderboard || {};
    this.leaderboard = new Leaderboard({
      path: leaderboardSettings.path || './stores/leaderboard',
      discord,
      channelId: leaderboardSettings.channelId,
      channelName: leaderboardSettings.channelName,
      messageId: leaderboardSettings.messageId,
      ttlMs: leaderboardSettings.ttlMs,
      refreshOnStart: leaderboardSettings.refreshOnStart,
      fetch: leaderboardSettings.fetch,
      resolveToken: leaderboardSettings.resolveToken
    });
    await this.leaderboard.start();

    const clipSettings = this.settings.clips || {};
    this.clips = new Clips(Object.assign({}, clipSettings, {
      path: clipSettings.path || './stores/clips',
      discord,
      basePath: spa._site('clipsPath'),
      identify
    }));
    await this.clips.start();

    this.fabric = new FabricRelay(Object.assign({}, fabricSettings, {
      path: fabricSettings.path || './stores/fabric',
      guildId: discord.guildId,
      operations: this.operations
    }));
    this.fabric.on('log', (...parts) => this.emit('log', ...parts));
    this.fabric.on('error', (...parts) => this.emit('error', ...parts));
    await this.fabric.start();

    const allianceSettings = this.settings.alliance || {};
    this.alliance = new Alliance({
      path: allianceSettings.path || './stores/alliance',
      file: allianceSettings.file ? path.resolve(allianceSettings.file) : undefined,
      organizationsPath: spa._site('organizationsPath'),
      basePath: spa._site('permafleetVotesPath'),
      federationsPath: spa._site('federationsPath'),
      xprv: () => this.fabric.xprv,
      members: this.members,
      publish: (frame) => this.fabric.publish(frame),
      bridge: Object.assign({ origin: spa._site('siteUrl') }, allianceSettings.bridge || {})
    });
    this.alliance.on('log', (...parts) => this.emit('log', ...parts));
    this.alliance.on('error', (...parts) => this.emit('error', ...parts));
    await this.alliance.start();
    // PERMAFLEET setup acts for an org only for its officers on record.
    this.community.alliance({
      representing: (accountKey) => this.alliance.representing(accountKey),
      representatives: (symbol) => this.alliance.representatives(symbol)
    });

    if (marketOn) {
      this.market = new Market(Object.assign({}, marketSettings, {
        path: marketSettings.path || './stores/market',
        basePath: spa._site('marketPath'),
        siteUrl: spa._site('siteUrl'),
        discord,
        hubs,
        xprv: () => this.fabric.xprv,
        members: this.members,
        operations: this.operations
      }));
      this.market.on('log', (...parts) => this.emit('log', ...parts));
      this.market.on('error', (...parts) => this.emit('error', ...parts));
      await this.market.start();
      this.members.on('merged', () => this.market.relinkMembers().catch((error) => {
        this.emit('error', 'GOON.VC', `could not relink Market listings after a member merge: ${error.message}`);
      }));
    }

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
        restorePath: this._restorePathMiddleware(),
        pageMeta: this._pageMetaMiddleware(assets),
        hubApi: createHubApiMiddleware(hubs, {
          timeoutMs: this.settings.hub && this.settings.hub.timeoutMs
        }),
        members: this.members.middleware(),
        hangar: this.hangar ? this.hangar.middleware() : (req, res, next) => next(),
        events: this.events.middleware(),
        operations: this.operations.middleware(),
        presence: this.presence.middleware(),
        community: this.community.middleware(),
        tournaments: this.tournaments.middleware(),
        leagues: this.leagues.middleware(),
        leaderboard: this.leaderboard.middleware(),
        activity: this.activity.middleware(),
        checkins: this.checkins.middleware(),
        welcome: this.welcome.middleware(),
        clips: this.clips.middleware(),
        fabric: this.fabric.middleware(),
        alliance: this.alliance.middleware(),
        market: this.market ? this.market.middleware() : (req, res, next) => next()
      }
    });

    // HTTPServer mounts its own middleware (and express.static) in start().
    this.http.express.use(this._canonicalPathMiddleware());
    this.http.express.use(this._clientScriptCacheMiddleware());
    this.http.on('debug', (...parts) => this.emit('debug', ...parts));
    this.http.on('error', (...parts) => this.emit('error', ...parts));
    this.http.on('log', (...parts) => this.emit('log', ...parts));

    await this.http.start();
    await assertStoreOpen(this.http.localStore);
    this.emit('log', 'GOON.VC', `HTML site on ${listenHost}:${port}; Hub APIs → ${hubs.origins.join(', ')}`);
    return this;
  }

  async stop () {
    const errors = [];
    for (const service of [this.http, this.market, this.alliance, this.fabric, this.commands, this.schedule, this.tournaments, this.leagues, this.leaderboard, this.reviews, this.welcome, this.checkins, this.activity, this.clips, this.hangar, this.members, this.events, this.presence, this.community, this.operations]) {
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
module.exports.DEFAULT_HUB_SEEDS = DEFAULT_HUB_SEEDS;
module.exports.DEFAULT_HTTP_PORT = DEFAULT_HTTP_PORT;
