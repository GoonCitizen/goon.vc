'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const Store = require('@fabric/core/types/store');
const Federation = require('@fabric/core/types/federation');
const { matchesAnyChannel } = require('@fabric/discord/functions/channelMatcher');
const startStore = require('../functions/startStore');
const discordEvents = require('../functions/discordScheduledEvents');
const discordThreads = require('../functions/discordThreads');
const resolveDiscordToken = require('../functions/resolveDiscordToken');
const { displayName } = require('../functions/duelLeaderboard');
const { isUnreachable } = require('../functions/hubApiProxy');
const { fabricPubkey } = require('../functions/accountKey');
const { frameHex, frameUri, openFrame, signFrame } = require('../functions/fabricFederation');
const post = require('../functions/marketPost');
const escrow = require('../functions/marketEscrow');

const BASE = '/services/market';
const DISCORD_API = 'https://discord.com/api/v10';
const FORUM_TYPES = new Set([15, 16]);
const VIEW_CHANNEL = 1n << 10n;
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PAGE_SIZE = 100;
const MAX_REPLIES = 500;
const REPLY_LIMIT = 2000;
const LATE_WATCH_MS = 30 * DAY;
const WEBHOOK_NAME = 'goon.vc Market';
const CDN_RE = /^https:\/\/(?:cdn\.discordapp\.com|media\.discordapp\.net)\/attachments\//i;
const SORTS = new Set(['recent', 'price-asc', 'price-desc', 'title']);
const ORDER_ACTIONS = new Set(['delivered', 'dispute', 'release', 'refund', 'cancel']);
const ORDER_STATE_LABELS = Object.freeze({
  'awaiting-payment': 'Awaiting payment',
  paid: 'Paid into escrow',
  delivered: 'Delivered',
  disputed: 'Disputed',
  releasing: 'Paying the seller',
  refunding: 'Refunding the buyer',
  released: 'Complete',
  refunded: 'Refunded',
  cancelled: 'Cancelled',
  expired: 'Expired'
});

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

const fail = post.fail;

function text (value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function randomId (bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

function slugify (name) {
  return String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'seller';
}

function laterSnowflake (a, b) {
  if (!a) return String(b);
  if (!b) return String(a);
  return BigInt(a) >= BigInt(b) ? String(a) : String(b);
}

function compareSnowflake (a, b) {
  const x = BigInt(a || 0);
  const y = BigInt(b || 0);
  return x < y ? -1 : (x > y ? 1 : 0);
}

function snowflakeIso (id) {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)).toISOString();
  } catch (_) {
    return null;
  }
}

/**
 * A Discord message's text with mentions shown as names, no snowflakes.
 * @param {string} content
 * @param {Array<Object>} [mentions]
 * @returns {string}
 */
function plainContent (content, mentions) {
  const names = new Map();
  for (const user of mentions || []) {
    if (user && user.id) names.set(String(user.id), displayName(user.member || null, user));
  }
  return String(content === undefined || content === null ? '' : content)
    .replace(/<@!?(\d+)>/g, (match, id) => `@${names.get(id) || 'someone'}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (match, seconds) => {
      const d = new Date(Number(seconds) * 1000);
      return isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    });
}

// Webhook names may not contain "discord" or "clyde" and are at most 80 characters.
function webhookName (name) {
  return String(name || 'G00N SQUAD member').replace(/discord|clyde/gi, (word) => word.replace(/[aeiou]/i, '*')).slice(0, 80);
}

function threadUrl (forum) {
  return forum && forum.guildId && forum.threadId ? `https://discord.com/channels/${forum.guildId}/${forum.threadId}` : null;
}

// qrcode ships with @fabric/hub; without it the order page shows only the address.
async function qrSvg (value) {
  if (!value) return null;
  let qrcode;
  try {
    qrcode = require('qrcode');
  } catch (_) {
    return null;
  }
  return qrcode.toString(value, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }).catch(() => null);
}

/**
 * Whether @everyone can view a forum: the @everyone role's permissions with
 * the channel's @everyone overwrite applied, and not age-restricted.
 * @param {Object} channel Discord REST channel
 * @param {Object} everyone the guild's @everyone role (REST)
 * @returns {boolean}
 */
function isPublicForum (channel, everyone) {
  if (!channel || !FORUM_TYPES.has(Number(channel.type)) || channel.nsfw) return false;
  let permissions;
  try {
    permissions = BigInt((everyone && everyone.permissions) || 0);
  } catch (_) {
    return false;
  }
  const overwrite = (channel.permission_overwrites || []).find((o) => String(o.id) === String(channel.guild_id) && Number(o.type) === 0);
  if (overwrite) {
    permissions &= ~BigInt(overwrite.deny || 0);
    permissions |= BigInt(overwrite.allow || 0);
  }
  return (permissions & VIEW_CHANNEL) === VIEW_CHANNEL;
}

/**
 * The G00N SQUAD Market: a 1:1 web mirror of the Discord Market forum.
 *
 * Each forum thread is a listing. Threads are read over REST (active and
 * archived, then polled with an `after=` cursor per thread) and live from the
 * gateway client Operations runs; listings made on the site or with
 * `/market` become threads, posted as the seller through a webhook (or by the
 * bot, "Listed by <name> via goon.vc"). A hand-written post is never
 * rewritten: site edits to it become tag changes plus an "Updated on goon.vc"
 * reply. Prices are BTC (sats); dollar prices convert at the mempool.space
 * reference rate.
 *
 * Buying is a 2-of-3 escrow ({@link module:functions/marketEscrow}) whose
 * vault the Hub watches; goon.vc holds only its arbiter key, never a party's.
 * Public JSON carries display names, never Discord or member ids.
 */
class Market extends EventEmitter {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string} [settings.basePath] Site path of the Market.
   * @param {string} [settings.siteUrl] Absolute site origin for links.
   * @param {Object} [settings.discord] `{ token, secretsFile, guildId }`.
   * @param {string|string[]} [settings.forum] Forum id, name, or `/regex/`.
   * @param {Object} [settings.tags] Extra forum tag names per kind or status label.
   * @param {number} [settings.ttlMs] How often the forum is polled.
   * @param {boolean} [settings.webhook] Post as the seller through a webhook.
   * @param {boolean} [settings.sync] Read and write the forum.
   * @param {string} [settings.network] Bitcoin network escrow must use (default: the Hub's).
   * @param {number} [settings.dibsHours] How long dibs hold a listing.
   * @param {number} [settings.payGraceHours] How long past `payBy` a payment seen in time may take to confirm.
   * @param {string[]} [settings.arbiters] Account keys that rule on disputes.
   * @param {string} [settings.rateUrl] BTC reference rate (mempool.space prices).
   * @param {Object} [settings.hubs] {@link createHubList} result.
   * @param {string|Function} [settings.xprv] goon.vc's key, or a function returning it.
   * @param {Object} [settings.members] Members service.
   * @param {Object} [settings.operations] Operations service (gateway client).
   * @param {Function} [settings.fetch]
   * @param {Function} [settings.now]
   */
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({
      path: './stores/market',
      basePath: BASE,
      siteUrl: 'https://goon.vc',
      discord: {},
      forum: '/market/',
      tags: {},
      ttlMs: 15 * MINUTE,
      archivedEveryMs: DAY,
      webhook: true,
      sync: true,
      network: null,
      dibsHours: 24,
      payHours: escrow.DEFAULTS.payHours,
      payGraceHours: escrow.DEFAULTS.payGraceHours,
      deliveryDays: escrow.DEFAULTS.deliveryDays,
      confirmDays: escrow.DEFAULTS.confirmDays,
      feeSats: escrow.DEFAULTS.feeSats,
      arbiters: [],
      rateUrl: 'https://mempool.space/api/v1/prices',
      rateTtlMs: HOUR,
      tickMs: MINUTE,
      vaultEveryMs: 2 * MINUTE,
      inviteEveryMs: DAY,
      hubs: null,
      xprv: null,
      members: null,
      operations: null,
      fetch: null,
      resolveToken: resolveDiscordToken,
      now: () => Date.now()
    }, settings);
    this.aliases = post.tagAliases(this.settings.tags || {});
    this.store = null;
    this.listings = new Map();
    this.threads = new Map();
    this.orders = new Map();
    this.forum = null;
    this.rate = { usdPerBtc: null, at: null, stale: true, error: null };
    this.status = { syncedAt: null, archivedAt: null, error: null };
    this.discord = null;
    this._queue = Promise.resolve();
    this._syncQueue = Promise.resolve();
    this._timers = [];
    this._pending = new Map();
    this._inflight = new Set();
    this._images = new Map();
    this._hubInfo = null;
    this._webhook = undefined;
    this._botId = null;
    this._onGateway = (discord) => this.attach(discord);
    this._handlers = {
      threadCreate: (thread) => this._gatewayThread(thread),
      threadUpdate: (before, thread) => this._gatewayThread(thread || before),
      threadDelete: (thread) => this._gatewayThreadDelete(thread),
      messageCreate: (message) => this._gatewayMessage(message),
      messageUpdate: (before, message) => this._gatewayMessage(message || before, { edit: true }),
      messageDelete: (message) => this._gatewayMessageDelete(message)
    };
  }

  /** Gateway intents the forum mirror needs on top of Operations' own. */
  static get INTENTS () {
    return ['MessageContent'];
  }

  get guildId () {
    return String((this.settings.discord && this.settings.discord.guildId) || discordEvents.DEFAULT_GUILD_ID);
  }

  get base () {
    return String(this.settings.basePath || BASE).replace(/\/+$/, '');
  }

  _now () {
    return this.settings.now();
  }

  _iso (ms = this._now()) {
    return new Date(ms).toISOString();
  }

  _fetch (...args) {
    return (this.settings.fetch || globalThis.fetch)(...args);
  }

  _discordOpts () {
    return this.settings.fetch ? { fetch: this.settings.fetch } : {};
  }

  _xprv () {
    const xprv = typeof this.settings.xprv === 'function' ? this.settings.xprv() : this.settings.xprv;
    return xprv || null;
  }

  _token () {
    const auth = this.settings.resolveToken(this.settings.discord || {});
    return auth && auth.token ? auth.token : null;
  }

  _escrowSettings () {
    const s = this.settings;
    return { payHours: s.payHours, payGraceHours: s.payGraceHours, deliveryDays: s.deliveryDays, confirmDays: s.confirmDays, feeSats: s.feeSats };
  }

  _exclusive (task) {
    const run = this._queue.then(task, task);
    this._queue = run.catch(() => {});
    return run;
  }

  // Forum write-backs run beside the request; stop() waits for them.
  _background (promise) {
    const run = Promise.resolve(promise).catch((error) => this._warn(error.message));
    this._inflight.add(run);
    run.finally(() => this._inflight.delete(run));
    return run;
  }

  _every (ms, fn) {
    if (!(ms > 0)) return;
    const timer = setInterval(fn, ms);
    if (timer.unref) timer.unref();
    this._timers.push(timer);
  }

  _warn (message) {
    this.emit('error', 'MARKET', message);
  }

  /* ---------- lifecycle ---------- */

  async start () {
    this.store = new Store({ name: 'GOON.VC:market', path: this.settings.path, persistent: true, verbosity: 1 });
    await startStore(this.store);
    for (const id of (await this.store.get('/index/listings')) || []) {
      const listing = await this.store.get(`/listings/${id}`);
      if (!listing) continue;
      this.listings.set(id, listing);
      if (listing.forum && listing.forum.threadId) this.threads.set(listing.forum.threadId, id);
    }
    for (const id of (await this.store.get('/index/orders')) || []) {
      const order = await this.store.get(`/orders/${id}`);
      if (order) this.orders.set(id, order);
    }
    const rate = await this.store.get('/rate');
    if (rate && rate.usdPerBtc) this.rate = Object.assign({}, rate, { stale: true });
    const status = await this.store.get('/status');
    if (status) this.status = Object.assign(this.status, status, { error: null });

    this._background(this._refreshRate());
    this._every(this.settings.rateTtlMs, () => this._background(this._refreshRate()));
    this._every(this.settings.tickMs, () => this.tick().catch((error) => this._warn(`tick: ${error.message}`)));

    const operations = this.settings.operations;
    if (this.settings.sync !== false) {
      if (operations && operations.discord) this.attach(operations.discord);
      else if (operations && typeof operations.on === 'function') operations.on('gateway', this._onGateway);
      this._syncInBackground();
      this._every(this.settings.ttlMs, () => this._syncInBackground());
    }
    this.emit('log', 'MARKET', `${this.listings.size} listings, ${this.orders.size} orders`);
    return this;
  }

  async stop () {
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];
    for (const timer of this._pending.values()) clearTimeout(timer);
    this._pending.clear();
    this._detach();
    const operations = this.settings.operations;
    if (operations && typeof operations.removeListener === 'function') operations.removeListener('gateway', this._onGateway);
    this._stopping = true;
    await this._syncQueue.catch(() => {});
    while (this._inflight.size) await Promise.all(Array.from(this._inflight));
    await this._queue.catch(() => {});
    if (this.store) await this.store.stop();
    return this;
  }

  /* ---------- storage ---------- */

  async _saveListing (listing) {
    const isNew = !this.listings.has(listing.id);
    this.listings.set(listing.id, listing);
    if (listing.forum && listing.forum.threadId) {
      this.threads.set(listing.forum.threadId, listing.id);
    }
    await this.store.set(`/listings/${listing.id}`, listing);
    if (isNew) await this.store.set('/index/listings', Array.from(this.listings.keys()));
    return listing;
  }

  async _saveOrder (order) {
    const isNew = !this.orders.has(order.id);
    this.orders.set(order.id, order);
    await this.store.set(`/orders/${order.id}`, order);
    if (isNew) await this.store.set('/index/orders', Array.from(this.orders.keys()));
    return order;
  }

  async _replies (listingId) {
    return (await this.store.get(`/replies/${listingId}`)) || [];
  }

  async _saveReply (listingId, reply) {
    const replies = await this._replies(listingId);
    const at = replies.findIndex((r) => r.id === reply.id);
    if (at >= 0) replies[at] = Object.assign({}, replies[at], reply);
    else replies.push(reply);
    replies.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const kept = replies.slice(-MAX_REPLIES);
    await this.store.set(`/replies/${listingId}`, kept);
    const listing = this.listings.get(listingId);
    if (listing) {
      listing.replies = kept.filter((r) => !r.deleted).length;
      if (reply.at && (!listing.activityAt || reply.at > listing.activityAt)) listing.activityAt = reply.at;
      await this._saveListing(listing);
    }
    return reply;
  }

  async _saveStatus () {
    await this.store.set('/status', { syncedAt: this.status.syncedAt, archivedAt: this.status.archivedAt });
  }

  /* ---------- people ---------- */

  async _viewer (req) {
    const members = this.settings.members;
    if (!members || !req) return null;
    const current = await members.currentMember(req).catch(() => null);
    return current ? current.member : null;
  }

  _requireViewer (member) {
    if (!member) throw fail(401, 'Sign in to goon.vc first.');
    return member;
  }

  _isArbiter (member) {
    if (!member) return false;
    const keys = new Set((member.accounts || []).map((account) => account.key));
    return (this.settings.arbiters || []).some((key) => keys.has(key));
  }

  async _sameMember (a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const members = this.settings.members;
    if (!members) return false;
    const [x, y] = await Promise.all([members.resolve(a), members.resolve(b)]);
    return !!(x && y && x.id === y.id);
  }

  async _isSeller (listing, member) {
    return !!(member && listing.seller && await this._sameMember(listing.seller, member.id));
  }

  _memberName (member) {
    return (member && member.displayName) || 'G00N SQUAD member';
  }

  /* ---------- reference rate ---------- */

  async _refreshRate () {
    if (!this.settings.rateUrl) return this.rate;
    try {
      const res = await this._fetch(this.settings.rateUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
      const body = res.ok ? await res.json() : null;
      const usd = Number(body && body.USD);
      if (!(usd > 0)) throw new Error(res.ok ? 'no USD price' : `HTTP ${res.status}`);
      this.rate = { usdPerBtc: usd, at: this._iso(), stale: false, error: null };
      if (this.store) await this.store.set('/rate', this.rate);
    } catch (error) {
      this.rate = Object.assign({}, this.rate, { stale: true, error: error.message });
    }
    return this.rate;
  }

  get usdPerBtc () {
    return this.rate && this.rate.usdPerBtc ? this.rate.usdPerBtc : null;
  }

  /* ---------- views ---------- */

  _listingPath (id) {
    return `${this.base}/listings/${id}`;
  }

  _orderPath (id) {
    return `${this.base}/orders/${id}`;
  }

  _url (pathname) {
    return `${String(this.settings.siteUrl || '').replace(/\/+$/, '')}${pathname}`;
  }

  _imageUrl (listing, absolute) {
    if (!listing.imageUrl) return null;
    if (!CDN_RE.test(listing.imageUrl)) return listing.imageUrl;
    const local = `${this._listingPath(listing.id)}/image`;
    return absolute ? this._url(local) : local;
  }

  _visible (listing) {
    return listing.status !== 'hidden' && !(listing.forum && listing.forum.deleted);
  }

  _dibsActive (listing) {
    return !!(listing.dibs && Date.parse(listing.dibs.until) > this._now());
  }

  _view (listing, viewer) {
    const priceSats = Number.isSafeInteger(listing.priceSats) ? listing.priceSats : null;
    const sellerName = listing.sellerName || 'G00N SQUAD member';
    const dibs = this._dibsActive(listing) ? { name: listing.dibs.name, until: listing.dibs.until } : null;
    const view = {
      id: listing.id,
      path: this._listingPath(listing.id),
      title: listing.title,
      kind: listing.kind || 'Other',
      contents: listing.contents || null,
      qty: listing.qty || 1,
      insurance: listing.insurance || null,
      msrpUsd: Number.isFinite(listing.msrpUsd) ? listing.msrpUsd : null,
      priceSats,
      price: {
        label: post.formatPrice(priceSats, this.usdPerBtc),
        btc: priceSats !== null ? post.formatBtc(priceSats) : null,
        sats: priceSats !== null ? post.formatSats(priceSats) : null,
        usd: priceSats !== null ? post.formatUsd(priceSats, this.usdPerBtc) : null
      },
      source: listing.source || null,
      giftable: typeof listing.giftable === 'boolean' ? listing.giftable : null,
      notes: listing.notes || null,
      imageUrl: this._imageUrl(listing),
      status: listing.status,
      statusLabel: post.STATUS_LABELS[listing.status] || listing.status,
      tags: listing.tags || [],
      seller: { name: sellerName, slug: slugify(sellerName), path: `${this.base}/sellers/${slugify(sellerName)}` },
      postedOn: listing.forum && listing.forum.authored === 'member' ? 'discord' : 'goon.vc',
      discordUrl: threadUrl(listing.forum),
      removed: !!(listing.forum && listing.forum.deleted),
      dibs,
      buyable: post.canBuy(listing) && !listing.order,
      replies: listing.replies || 0,
      createdAt: listing.createdAt,
      updatedAt: listing.updatedAt,
      activityAt: listing.activityAt || listing.updatedAt
    };
    if (viewer) {
      const seller = !!(listing.seller && listing.seller === viewer.id);
      view.you = {
        seller,
        canEdit: seller || this._isArbiter(viewer),
        dibs: !!(dibs && listing.dibs.member === viewer.id),
        escrowKey: this.canEscrow(viewer)
      };
      const order = listing.order && this.orders.get(listing.order);
      if (order && (order.buyer === viewer.id || order.seller === viewer.id || this._isArbiter(viewer))) {
        view.you.order = { id: order.id, path: this._orderPath(order.id), state: order.state };
      }
    }
    return view;
  }

  _replyView (reply) {
    return {
      id: reply.id,
      author: reply.author || 'G00N SQUAD member',
      body: reply.deleted ? null : reply.body,
      via: reply.via,
      at: reply.at,
      editedAt: reply.editedAt || null,
      deleted: !!reply.deleted
    };
  }

  _forumView () {
    const forum = this.forum;
    return {
      name: forum ? forum.name : null,
      url: forum ? `https://discord.com/channels/${forum.guildId}/${forum.id}` : null,
      mirrored: !!forum,
      tags: forum ? forum.tags.map((t) => t.name) : [],
      syncedAt: this.status.syncedAt,
      error: this.status.error
    };
  }

  _rateView () {
    return { usdPerBtc: this.usdPerBtc, at: this.rate.at || null, stale: !!this.rate.stale, source: 'mempool.space' };
  }

  /* ---------- catalog ---------- */

  /**
   * Listings matching a query, for the catalog and `/market search`.
   * @param {Object} [query] `{ kind, source, status, tag, q, seller, sort, limit }`
   * @param {Object|null} [viewer]
   * @returns {Object[]} listing views
   */
  search (query = {}, viewer = null) {
    const kind = query.kind ? post.normalizeKind(query.kind) : null;
    const source = query.source ? post.normalizeSource(query.source) : null;
    const status = query.status && query.status !== 'all' ? post.normalizeStatus(query.status) : null;
    const tag = query.tag ? post.nameKey(query.tag) : null;
    const seller = query.seller ? slugify(query.seller) : null;
    const words = String(query.q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const sort = SORTS.has(query.sort) ? query.sort : 'recent';
    let rows = Array.from(this.listings.values()).filter((listing) => {
      if (!this._visible(listing) && !(viewer && listing.seller === viewer.id && query.mine)) return false;
      if (query.mine && !(viewer && listing.seller === viewer.id)) return false;
      if (kind && (listing.kind || 'Other') !== kind) return false;
      if (source && listing.source !== source) return false;
      if (status) {
        if (status === 'reserved' ? !['reserved', 'paid', 'delivered'].includes(listing.status) : listing.status !== status) return false;
      } else if (!query.status && !query.mine && listing.status === 'sold' && !seller) {
        // The catalog opens on what is for sale; sold listings are a filter away.
        return false;
      }
      if (seller && slugify(listing.sellerName) !== seller) return false;
      if (tag) {
        const names = [listing.kind, post.STATUS_TAGS[listing.status]].concat(listing.tags || []).map(post.nameKey);
        if (!names.includes(tag)) return false;
      }
      if (words.length) {
        const hay = [listing.title, listing.contents, listing.notes, listing.kind, listing.sellerName, listing.insurance].join(' ').toLowerCase();
        if (!words.every((w) => hay.includes(w))) return false;
      }
      return true;
    });
    const price = (l) => (Number.isSafeInteger(l.priceSats) ? l.priceSats : null);
    rows.sort((a, b) => {
      if (sort === 'title') return String(a.title).localeCompare(String(b.title));
      if (sort === 'price-asc' || sort === 'price-desc') {
        const x = price(a);
        const y = price(b);
        if (x === null && y === null) return 0;
        if (x === null) return 1;
        if (y === null) return -1;
        return sort === 'price-asc' ? x - y : y - x;
      }
      return String(b.activityAt || b.updatedAt).localeCompare(String(a.activityAt || a.updatedAt));
    });
    const limit = Math.max(1, Math.min(1000, Number(query.limit) || 1000));
    rows = rows.slice(0, limit);
    return rows.map((listing) => this._view(listing, viewer));
  }

  catalog (query = {}, viewer = null) {
    const listings = this.search(query, viewer);
    const counts = { kinds: {}, statuses: {} };
    for (const listing of this.listings.values()) {
      if (!this._visible(listing)) continue;
      const kind = listing.kind || 'Other';
      counts.kinds[kind] = (counts.kinds[kind] || 0) + 1;
      counts.statuses[listing.status] = (counts.statuses[listing.status] || 0) + 1;
    }
    return {
      listings,
      total: listings.length,
      counts,
      kinds: post.KINDS,
      statuses: post.STATUSES.filter((s) => s !== 'hidden'),
      forum: this._forumView(),
      rate: this._rateView(),
      escrow: { network: this._knownNetwork(), feeSats: this.settings.feeSats },
      you: viewer ? { name: this._memberName(viewer), escrowKey: this.canEscrow(viewer), arbiter: this._isArbiter(viewer) } : null
    };
  }

  async getListing (id, viewer = null) {
    const listing = this.listings.get(String(id || '').toLowerCase());
    if (!listing) return null;
    const own = viewer && listing.seller === viewer.id;
    if (!this._visible(listing) && !own && !this._isArbiter(viewer) && !(listing.forum && listing.forum.deleted)) return null;
    const replies = (await this._replies(listing.id)).filter((r) => !r.deleted).map((r) => this._replyView(r));
    return Object.assign(this._view(listing, viewer), { replies, log: (listing.log || []).slice(-50).map((entry) => Object.assign({}, entry, { member: undefined })) });
  }

  seller (slug, viewer = null) {
    const key = slugify(slug);
    const listings = this.search({ seller: key, status: 'all' }, viewer);
    if (!listings.length) return null;
    return { seller: listings[0].seller, listings };
  }

  // The escrow network as last read from the Hub, else the configured one.
  _knownNetwork () {
    return this._hubInfo ? this._hubInfo.network : (this.settings.network ? String(this.settings.network).toLowerCase() : null);
  }

  /** Whether a member has linked an escrow key for the escrow network. */
  canEscrow (member) {
    return !!(member && escrow.memberEscrowKey(member, this._knownNetwork()));
  }

  async mine (viewer) {
    this._requireViewer(viewer);
    const listings = this.search({ mine: true, status: 'all' }, viewer);
    const orders = Array.from(this.orders.values())
      .filter((order) => order.buyer === viewer.id || order.seller === viewer.id)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((order) => this._orderSummary(order, viewer));
    return { listings, orders, escrowKey: this.canEscrow(viewer) };
  }

  /**
   * Point listings and orders at the member that survived a merge.
   * @returns {Promise<number>} records changed
   */
  async relinkMembers () {
    const members = this.settings.members;
    if (!members) return 0;
    const cache = new Map();
    const current = async (id) => {
      if (!id) return id;
      if (!cache.has(id)) cache.set(id, await members.resolve(id).then((m) => (m ? m.id : id), () => id));
      return cache.get(id);
    };
    let changed = 0;
    for (const listing of Array.from(this.listings.values())) {
      const seller = await current(listing.seller);
      const dibs = listing.dibs ? await current(listing.dibs.member) : null;
      if (seller === listing.seller && (!listing.dibs || dibs === listing.dibs.member)) continue;
      await this._exclusive(async () => {
        const record = this.listings.get(listing.id);
        record.seller = seller;
        if (record.dibs) record.dibs.member = dibs;
        await this._saveListing(record);
      });
      changed++;
    }
    for (const order of Array.from(this.orders.values())) {
      const buyer = await current(order.buyer);
      const seller = await current(order.seller);
      if (buyer === order.buyer && seller === order.seller) continue;
      await this._exclusive(async () => {
        const record = this.orders.get(order.id);
        record.buyer = buyer;
        record.seller = seller;
        await this._saveOrder(record);
      });
      changed++;
    }
    return changed;
  }

  /* ---------- listing writes ---------- */

  _newListing (fields, extra = {}) {
    const now = this._iso();
    return Object.assign({
      id: null,
      title: 'Listing',
      kind: 'Other',
      contents: null,
      qty: 1,
      insurance: null,
      msrpUsd: null,
      priceSats: null,
      source: null,
      giftable: null,
      notes: null,
      imageUrl: null,
      status: 'available',
      tags: [],
      seller: null,
      sellerName: null,
      forum: null,
      fieldSources: {},
      dibs: null,
      order: null,
      replies: 0,
      createdAt: now,
      updatedAt: now,
      activityAt: now,
      log: []
    }, fields, extra);
  }

  _uniqueId () {
    let id;
    do id = randomId(6); while (this.listings.has(id));
    return id;
  }

  /**
   * A listing made on the site or with `/market sell`; it becomes a thread.
   * @param {Object} input listing fields
   * @param {Object} member the seller
   * @returns {Promise<Object>} listing view
   */
  async create (input, member) {
    this._requireViewer(member);
    const { fields, conversion } = post.normalizeFields(input, { usdPerBtc: this.usdPerBtc, create: true });
    if (fields.status && !['available', 'hidden'].includes(fields.status)) delete fields.status;
    const listing = await this._exclusive(async () => {
      const now = this._iso();
      const record = this._newListing(fields, {
        id: this._uniqueId(),
        seller: member.id,
        sellerName: this._memberName(member),
        fieldSources: Object.fromEntries(Object.keys(fields).map((k) => [k, 'site'])),
        log: [Object.assign({ type: 'create', by: this._memberName(member), member: member.id, at: now }, conversion ? { conversion } : {})]
      });
      return this._saveListing(record);
    });
    this.emit('log', 'MARKET', `listing ${listing.id} created by ${listing.sellerName}`);
    await this._publish(listing.id, { member });
    return this._view(this.listings.get(listing.id), member);
  }

  /**
   * Change a listing. Sellers edit their own; arbiters may edit any.
   * @param {string} id
   * @param {Object} input changed fields
   * @param {Object} member
   * @returns {Promise<Object>} listing view
   */
  async update (id, input, member) {
    this._requireViewer(member);
    const listing = this.listings.get(String(id || '').toLowerCase());
    if (!listing) throw fail(404, 'No such listing.');
    if (!(await this._isSeller(listing, member)) && !this._isArbiter(member)) throw fail(403, 'Only the seller can change this listing.');
    const { fields, conversion } = post.normalizeFields(input, { usdPerBtc: this.usdPerBtc });
    if (fields.status) {
      if (listing.order) throw fail(409, 'This listing has an escrow order open; its status follows the order.');
      if (['reserved', 'paid', 'delivered'].includes(fields.status)) fields.status = 'reserved';
      if (fields.status === 'dibs') throw fail(400, 'Dibs are called by buyers.');
    }
    const changes = await this._exclusive(async () => {
      const current = this.listings.get(listing.id);
      const changed = {};
      for (const [name, value] of Object.entries(fields)) {
        if (JSON.stringify(current[name]) === JSON.stringify(value)) continue;
        changed[name] = value;
        current[name] = value;
        current.fieldSources = Object.assign({}, current.fieldSources, { [name]: 'site' });
      }
      if (!Object.keys(changed).length) return changed;
      if (changed.status && changed.status !== 'dibs') current.dibs = null;
      current.updatedAt = this._iso();
      current.activityAt = current.updatedAt;
      current.log = (current.log || []).concat(Object.assign({ type: 'edit', by: this._memberName(member), member: member.id, fields: Object.keys(changed), at: current.updatedAt }, conversion ? { conversion } : {}));
      await this._saveListing(current);
      return changed;
    });
    if (Object.keys(changes).length) await this._publish(listing.id, { changes, member });
    return this._view(this.listings.get(listing.id), member);
  }

  /**
   * The same change to several of the seller's listings.
   * @param {string[]} ids
   * @param {Object} input
   * @param {Object} member
   * @returns {Promise<{ listings: Object[], errors: Object[] }>}
   */
  async updateMany (ids, input, member) {
    this._requireViewer(member);
    const list = [...new Set([].concat(ids || []).map((id) => String(id).toLowerCase()))].slice(0, 100);
    if (!list.length) throw fail(400, 'Pick at least one listing.');
    const listings = [];
    const errors = [];
    for (const id of list) {
      try {
        listings.push(await this.update(id, input, member));
      } catch (error) {
        errors.push({ id, error: error.message, status: error.status || 500 });
      }
    }
    return { listings, errors };
  }

  async reply (id, input, member) {
    this._requireViewer(member);
    const listing = this.listings.get(String(id || '').toLowerCase());
    if (!listing || !this._visible(listing)) throw fail(404, 'No such listing.');
    const body = text(input && input.body, REPLY_LIMIT);
    if (!body) throw fail(400, 'Write a reply first.');
    const name = this._memberName(member);
    let messageId = null;
    if (listing.forum && listing.forum.threadId && !listing.forum.deleted) {
      messageId = await this._postReply(listing, body, { name, avatarUrl: member.avatarUrl }).catch((error) => {
        this._warn(`reply to ${listing.id} not posted on Discord: ${error.message}`);
        return null;
      });
    }
    const reply = { id: messageId || `site-${randomId(6)}`, author: name, member: member.id, body, via: 'site', at: this._iso() };
    await this._exclusive(() => this._saveReply(listing.id, reply));
    return this._replyView(reply);
  }

  async dibs (id, input, member) {
    this._requireViewer(member);
    const release = !!(input && (input.release === true || input.release === 'true'));
    const result = await this._exclusive(async () => {
      const listing = this.listings.get(String(id || '').toLowerCase());
      if (!listing || !this._visible(listing)) throw fail(404, 'No such listing.');
      const seller = listing.seller === member.id;
      if (release) {
        if (!this._dibsActive(listing)) throw fail(409, 'Nobody has dibs on this listing.');
        if (listing.dibs.member !== member.id && !seller && !this._isArbiter(member)) throw fail(403, 'Only whoever called dibs, or the seller, can drop them.');
        const name = listing.dibs.name;
        listing.dibs = null;
        if (listing.status === 'dibs') listing.status = 'available';
        listing.updatedAt = this._iso();
        listing.log = (listing.log || []).concat({ type: 'dibs-drop', by: this._memberName(member), member: member.id, at: listing.updatedAt });
        await this._saveListing(listing);
        return { listing, note: `${name}'s dibs were dropped on goon.vc.` };
      }
      if (seller) throw fail(409, 'You can\'t call dibs on your own listing.');
      if (listing.status !== 'available') throw fail(409, `This listing is ${post.STATUS_LABELS[listing.status] || listing.status}.`);
      if (this._dibsActive(listing)) throw fail(409, `${listing.dibs.name} already has dibs.`);
      const name = this._memberName(member);
      const until = this._iso(this._now() + this.settings.dibsHours * HOUR);
      listing.dibs = { member: member.id, name, until };
      listing.status = 'dibs';
      listing.updatedAt = this._iso();
      listing.activityAt = listing.updatedAt;
      listing.log = (listing.log || []).concat({ type: 'dibs', by: name, member: member.id, at: listing.updatedAt });
      await this._saveListing(listing);
      return { listing, note: `Dibs: ${name} called dibs on goon.vc (held for ${this.settings.dibsHours} hours).` };
    });
    await this._publish(result.listing.id, { note: result.note, quiet: true });
    return this._view(this.listings.get(result.listing.id), member);
  }

  /* ---------- forum: reading ---------- */

  _syncInBackground () {
    if (this._syncing || this._stopping) return this._syncing;
    this._syncing = this.syncForum()
      .catch((error) => {
        this.status.error = error.message;
        this._warn(`forum sync failed: ${error.message}`);
      })
      .finally(() => { this._syncing = null; });
    return this._syncing;
  }

  async _botUser (token) {
    if (this._botId) return this._botId;
    const res = await discordEvents.discordGet('/users/@me', token, this._discordOpts());
    if (res.status === 200 && res.json && res.json.id) this._botId = String(res.json.id);
    return this._botId;
  }

  /**
   * Find the Market forum and check it is public.
   * @param {string} token
   * @returns {Promise<Object|null>}
   */
  async _findForum (token) {
    const guildRes = await discordEvents.discordGet(`/guilds/${this.guildId}`, token, this._discordOpts());
    if (guildRes.status !== 200 || !guildRes.json) throw new Error(`could not read the server (${discordThreads.errorMessage(guildRes)})`);
    const everyone = (guildRes.json.roles || []).find((role) => String(role.id) === this.guildId);
    const res = await discordEvents.discordGet(`/guilds/${this.guildId}/channels`, token, this._discordOpts());
    if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(`could not list channels (${discordThreads.errorMessage(res)})`);
    const matchers = [].concat(this.settings.forum || []);
    const channel = res.json.find((c) => FORUM_TYPES.has(Number(c.type)) && matchesAnyChannel(matchers, { id: String(c.id), name: c.name }));
    if (!channel) throw new Error('no Market forum matches the market.forum setting');
    if (!isPublicForum(Object.assign({ guild_id: this.guildId }, channel), everyone)) {
      this.forum = null;
      throw new Error(`#${channel.name} is not public (everyone must be able to view it), so it is not mirrored`);
    }
    this.forum = {
      id: String(channel.id),
      name: channel.name,
      guildId: this.guildId,
      tags: (channel.available_tags || []).map((t) => ({ id: String(t.id), name: t.name, moderated: !!t.moderated }))
    };
    return this.forum;
  }

  /**
   * Read the forum: every active thread, archived ones on the first pass and
   * then daily, and anything new in each since its cursor.
   * @param {Object} [opts] `{ archived }` forces the archived walk
   * @returns {Promise<{ threads: number, listings: number }>}
   */
  syncForum (opts = {}) {
    const run = async () => {
      const token = this._token();
      if (!token) throw new Error('no Discord bot token configured');
      await this._botUser(token);
      const forum = await this._findForum(token);
      const active = (await discordThreads.activeThreads(token, this.guildId, this._discordOpts())).get(forum.id) || [];
      let threads = active;
      const archivedDue = opts.archived || !this.status.archivedAt || Date.parse(this.status.archivedAt) + this.settings.archivedEveryMs <= this._now();
      if (archivedDue) {
        const archived = await discordThreads.archivedThreads(token, forum.id, this._discordOpts());
        const seen = new Set(active.map((t) => String(t.id)));
        threads = active.concat(archived.filter((t) => !seen.has(String(t.id))));
      }
      let changed = 0;
      for (const thread of threads) {
        if (this._stopping) break;
        try {
          changed += await this._syncThread(token, thread);
        } catch (error) {
          this._warn(`thread ${thread.name || thread.id}: ${error.message}`);
        }
      }
      this.status.syncedAt = this._iso();
      if (archivedDue) this.status.archivedAt = this.status.syncedAt;
      this.status.error = null;
      await this._saveStatus();
      return { threads: threads.length, listings: changed };
    };
    const task = this._syncQueue.then(run, run);
    this._syncQueue = task.catch(() => {});
    return task;
  }

  _ours (message) {
    if (!message) return false;
    const hook = this._webhook;
    if (message.webhook_id && hook && String(message.webhook_id) === String(hook.id)) return true;
    return !!(this._botId && message.author && String(message.author.id) === this._botId);
  }

  _tagNames (ids) {
    const tags = (this.forum && this.forum.tags) || [];
    return [].concat(ids || []).map((id) => (tags.find((t) => t.id === String(id)) || {}).name).filter(Boolean);
  }

  async _starter (token, threadId) {
    const res = await discordEvents.discordGet(`/channels/${threadId}/messages/${threadId}`, token, this._discordOpts());
    if (res.status === 200 && res.json) return res.json;
    if (res.status === 404) return null;
    throw new Error(discordThreads.errorMessage(res));
  }

  async _sellerFor (message, thread) {
    const members = this.settings.members;
    const userId = message && message.author && !message.webhook_id ? message.author.id : (thread && thread.owner_id);
    if (!members || !userId) return { member: null, name: message && message.author ? displayName(null, message.author) : null };
    const user = message && message.author && String(message.author.id) === String(userId) ? message.author : { id: userId };
    const name = user.username ? displayName(null, user) : null;
    const member = await members.memberFor(`discord:${userId}`, {
      create: true,
      via: 'directory',
      profile: { username: user.username || null, globalName: user.global_name || null },
      displayName: name
    });
    return { member, name: (member && member.displayName) || name };
  }

  /**
   * Bring one thread up to date. Returns 1 when its listing changed.
   * @param {string} token
   * @param {Object} thread Discord REST thread
   * @returns {Promise<number>}
   */
  async _syncThread (token, thread) {
    const threadId = String(thread.id);
    if (!this.forum || String(thread.parent_id) !== this.forum.id) return 0;
    let listingId = this.threads.get(threadId);
    let changed = 0;
    if (!listingId) {
      const starter = await this._starter(token, threadId);
      listingId = await this._adoptThread(thread, starter);
      changed = 1;
    } else {
      changed = await this._applyThread(listingId, thread);
    }
    const replies = await this._readReplies(token, thread, listingId);
    return changed || (replies ? 1 : 0);
  }

  async _adoptThread (thread, starter) {
    const threadId = String(thread.id);
    const parsed = post.parsePost({
      title: thread.name,
      content: starter ? plainContent(starter.content, starter.mentions) : '',
      attachments: starter ? starter.attachments : [],
      embeds: starter ? starter.embeds : [],
      tags: this._tagNames(thread.applied_tags)
    }, { usdPerBtc: this.usdPerBtc, tags: this.aliases });
    const ours = this._ours(starter);
    const authored = ours ? (starter.webhook_id ? 'webhook' : 'bot') : 'member';
    const seller = ours ? { member: null, name: null } : await this._sellerFor(starter, thread);
    const created = snowflakeIso(threadId) || this._iso();
    return this._exclusive(async () => {
      if (this.threads.has(threadId)) return this.threads.get(threadId);
      const fields = Object.assign({}, parsed.fields);
      if (fields.status && !post.STATUSES.includes(fields.status)) delete fields.status;
      const meta = thread.thread_metadata || {};
      const listing = this._newListing(fields, {
        id: this._uniqueId(),
        tags: parsed.tags,
        seller: seller.member ? seller.member.id : null,
        sellerName: seller.name || (starter && starter.author ? displayName(null, starter.author) : null),
        forum: {
          guildId: this.guildId,
          channelId: this.forum.id,
          threadId,
          starterId: starter ? String(starter.id) : null,
          authored,
          archived: !!meta.archived,
          locked: !!meta.locked,
          deleted: false
        },
        fieldSources: Object.fromEntries(Object.keys(fields).map((k) => [k, 'post'])),
        createdAt: created,
        updatedAt: (starter && starter.edited_timestamp) || created,
        activityAt: created,
        log: [{ type: 'mirror', by: seller.name || null, at: this._iso() }]
      });
      await this._saveListing(listing);
      await this.store.set(`/cursors/${threadId}`, threadId);
      return listing.id;
    });
  }

  /**
   * Fold a post's fields into its listing. Fields set on goon.vc keep their
   * site value (the skip is logged once per post edit).
   */
  _applyFields (listing, fields, tags, at) {
    const changed = [];
    const kept = [];
    for (const [name, value] of Object.entries(fields)) {
      if (name === 'status' && listing.order) continue;
      if (JSON.stringify(listing[name]) === JSON.stringify(value)) continue;
      if ((listing.fieldSources || {})[name] === 'site') {
        kept.push(name);
        continue;
      }
      listing[name] = value;
      listing.fieldSources = Object.assign({}, listing.fieldSources, { [name]: 'post' });
      changed.push(name);
    }
    if (tags && JSON.stringify(listing.tags || []) !== JSON.stringify(tags)) {
      listing.tags = tags;
      changed.push('tags');
    }
    if (changed.includes('status') && listing.status !== 'dibs') listing.dibs = null;
    if (changed.length || kept.length) {
      listing.updatedAt = at || this._iso();
      listing.log = (listing.log || []).concat(Object.assign({ type: 'post', at: listing.updatedAt }, changed.length ? { fields: changed } : {}, kept.length ? { kept } : {}));
    }
    return changed.length > 0;
  }

  async _applyThread (listingId, thread) {
    return this._exclusive(async () => {
      const listing = this.listings.get(listingId);
      if (!listing || !listing.forum) return 0;
      const meta = thread.thread_metadata || {};
      let dirty = listing.forum.archived !== !!meta.archived || listing.forum.locked !== !!meta.locked || listing.forum.deleted;
      listing.forum = Object.assign({}, listing.forum, { archived: !!meta.archived, locked: !!meta.locked, deleted: false });
      if (listing.forum.authored === 'member') {
        const fields = {};
        const title = text(thread.name, post.LIMITS.title);
        if (title) fields.title = title;
        const tagNames = this._tagNames(thread.applied_tags);
        for (const name of tagNames) {
          const mapped = post.mapTag(name, this.aliases);
          if (mapped && mapped.kind && !fields.kind) fields.kind = mapped.kind;
          if (mapped && mapped.status && !fields.status) fields.status = mapped.status;
        }
        const others = tagNames.filter((name) => !post.mapTag(name, this.aliases));
        if (this._applyFields(listing, fields, others)) dirty = true;
      }
      if (dirty) await this._saveListing(listing);
      return dirty ? 1 : 0;
    });
  }

  async _readReplies (token, thread, listingId) {
    const threadId = String(thread.id);
    let cursor = (await this.store.get(`/cursors/${threadId}`)) || threadId;
    if (thread.last_message_id && compareSnowflake(cursor, thread.last_message_id) >= 0) return 0;
    let added = 0;
    for (let page = 0; page < 50; page++) {
      const res = await discordEvents.discordGet(`/channels/${threadId}/messages?after=${cursor}&limit=${PAGE_SIZE}`, token, this._discordOpts());
      if (res.status === 403 || res.status === 404) break;
      if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(discordThreads.errorMessage(res));
      const messages = res.json.slice().sort((a, b) => compareSnowflake(a.id, b.id));
      for (const message of messages) {
        if (await this._ingestReply(listingId, message)) added++;
        cursor = laterSnowflake(cursor, message.id);
      }
      await this.store.set(`/cursors/${threadId}`, cursor);
      if (messages.length < PAGE_SIZE) break;
    }
    return added;
  }

  /**
   * Store one thread message as a reply. goon.vc's own posts are stored when
   * they are made, so they are skipped here.
   */
  async _ingestReply (listingId, message) {
    if (!message || !message.id || String(message.id) === String(message.channel_id)) return false;
    if (this._ours(message) || (message.author && message.author.bot)) return false;
    if (message.type !== undefined && ![0, 19].includes(Number(message.type))) return false;
    const body = text(plainContent(message.content, message.mentions), REPLY_LIMIT) || ((message.attachments || []).length ? '[file]' : '');
    if (!body) return false;
    const reply = {
      id: String(message.id),
      author: message.author ? displayName(message.member || null, message.author) : 'G00N SQUAD member',
      body,
      via: 'discord',
      at: message.timestamp || snowflakeIso(message.id),
      editedAt: message.edited_timestamp || null
    };
    await this._exclusive(() => this._saveReply(listingId, reply));
    return true;
  }

  async _refreshStarter (token, listingId) {
    const listing = this.listings.get(listingId);
    if (!listing || !listing.forum || listing.forum.authored !== 'member') return 0;
    const starter = await this._starter(token, listing.forum.threadId);
    if (!starter) return 0;
    const parsed = post.parsePost({
      title: listing.title,
      content: plainContent(starter.content, starter.mentions),
      attachments: starter.attachments,
      embeds: starter.embeds,
      tags: []
    }, { usdPerBtc: this.usdPerBtc, tags: this.aliases });
    delete parsed.fields.title;
    return this._exclusive(async () => {
      const current = this.listings.get(listingId);
      if (!this._applyFields(current, parsed.fields, null, starter.edited_timestamp || undefined)) return 0;
      await this._saveListing(current);
      return 1;
    });
  }

  /* ---------- forum: gateway ---------- */

  attach (discord) {
    if (!discord || !discord.client || this.discord === discord) return;
    this._detach();
    this.discord = discord;
    for (const [event, handler] of Object.entries(this._handlers)) discord.client.on(event, handler);
  }

  _detach () {
    if (!this.discord) return;
    const client = this.discord.client;
    if (client && typeof client.removeListener === 'function') {
      for (const [event, handler] of Object.entries(this._handlers)) client.removeListener(event, handler);
    }
    this.discord = null;
  }

  _inForum (channel) {
    return !!(this.forum && channel && String(channel.parentId || channel.parent_id || '') === this.forum.id);
  }

  // Coalesce bursts of gateway events into one REST read per thread.
  _later (key, fn, ms = 2000) {
    if (this._pending.has(key)) clearTimeout(this._pending.get(key));
    const timer = setTimeout(() => {
      this._pending.delete(key);
      const run = () => fn().catch((error) => this._warn(`${key}: ${error.message}`));
      this._syncQueue = this._syncQueue.then(run, run);
    }, ms);
    if (timer.unref) timer.unref();
    this._pending.set(key, timer);
  }

  _gatewayThread (thread) {
    if (!thread || !this._inForum(thread)) return;
    this._later(`thread:${thread.id}`, async () => {
      const token = this._token();
      if (!token) return;
      const res = await discordEvents.discordGet(`/channels/${thread.id}`, token, this._discordOpts());
      if (res.status === 200 && res.json) await this._syncThread(token, res.json);
    });
  }

  _gatewayThreadDelete (thread) {
    const listingId = thread && this.threads.get(String(thread.id));
    if (!listingId) return;
    this._exclusive(async () => {
      const listing = this.listings.get(listingId);
      if (!listing || !listing.forum) return;
      listing.forum = Object.assign({}, listing.forum, { deleted: true });
      listing.updatedAt = this._iso();
      listing.log = (listing.log || []).concat({ type: 'removed', at: listing.updatedAt });
      await this._saveListing(listing);
    }).catch((error) => this._warn(`thread delete: ${error.message}`));
  }

  _gatewayMessage (message, opts = {}) {
    if (!message || !message.channelId) return;
    const threadId = String(message.channelId);
    const listingId = this.threads.get(threadId);
    if (!listingId && !this._inForum(message.channel)) return;
    if (opts.edit && String(message.id) === threadId && listingId) {
      this._later(`starter:${threadId}`, async () => {
        const token = this._token();
        if (token) await this._refreshStarter(token, listingId);
      });
      return;
    }
    if (opts.edit && listingId) {
      this._later(`message:${message.id}`, async () => {
        const token = this._token();
        if (!token) return;
        const res = await discordEvents.discordGet(`/channels/${threadId}/messages/${message.id}`, token, this._discordOpts());
        if (res.status === 200 && res.json) await this._ingestReply(listingId, res.json);
      });
      return;
    }
    this._gatewayThread(message.channel && message.channel.id ? message.channel : { id: threadId, parentId: this.forum && this.forum.id });
  }

  _gatewayMessageDelete (message) {
    const listingId = message && this.threads.get(String(message.channelId));
    if (!listingId) return;
    this._exclusive(async () => {
      const replies = await this._replies(listingId);
      const reply = replies.find((r) => r.id === String(message.id));
      if (!reply || reply.deleted) return;
      reply.deleted = true;
      reply.body = null;
      await this._saveReply(listingId, reply);
    }).catch((error) => this._warn(`message delete: ${error.message}`));
  }

  /* ---------- forum: writing ---------- */

  async _discord (method, apiPath, body, opts = {}) {
    const token = opts.webhook ? null : this._token();
    if (!token && !opts.webhook) throw fail(503, 'No Discord bot token configured.');
    for (let attempt = 0; attempt < 3; attempt++) {
      const headers = { Accept: 'application/json', 'User-Agent': 'GoonVCMarket/0.1' };
      if (token) headers.Authorization = 'Bot ' + token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await this._fetch(DISCORD_API + apiPath, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      });
      let json = null;
      const raw = await res.text();
      try { json = raw ? JSON.parse(raw) : null; } catch (_) { json = null; }
      if (res.status === 429 && attempt < 2) {
        const retry = Number((json && json.retry_after) || 1);
        await new Promise((resolve) => setTimeout(resolve, Math.min(15000, Math.max(500, Math.ceil(retry * 1000)))));
        continue;
      }
      return { status: res.status, json };
    }
    return { status: 429, json: null };
  }

  async _hook () {
    if (this.settings.webhook === false || !this.forum) return null;
    if (this._webhook && this._webhook.channelId === this.forum.id) return this._webhook;
    if (this._webhook === null && this._webhookCheckedAt && this._webhookCheckedAt + HOUR > this._now()) return null;
    const saved = await this.store.get('/webhook');
    if (saved && saved.channelId === this.forum.id && saved.token) {
      this._webhook = saved;
      return saved;
    }
    this._webhookCheckedAt = this._now();
    const token = this._token();
    if (!token) return null;
    const botId = await this._botUser(token);
    const list = await this._discord('GET', `/channels/${this.forum.id}/webhooks`);
    if (list.status !== 200 || !Array.isArray(list.json)) {
      this._webhook = null;
      return null;
    }
    let hook = list.json.find((w) => Number(w.type) === 1 && w.token && w.user && String(w.user.id) === botId && w.name === WEBHOOK_NAME);
    if (!hook) {
      const made = await this._discord('POST', `/channels/${this.forum.id}/webhooks`, { name: WEBHOOK_NAME });
      if (made.status !== 200 || !made.json || !made.json.token) {
        this._webhook = null;
        return null;
      }
      hook = made.json;
    }
    this._webhook = { id: String(hook.id), token: hook.token, channelId: this.forum.id };
    await this.store.set('/webhook', this._webhook);
    return this._webhook;
  }

  async _dropHook () {
    this._webhook = null;
    this._webhookCheckedAt = this._now();
    await this.store.set('/webhook', null);
  }

  _renderFor (listing, sellerName) {
    const view = Object.assign({}, listing, { imageUrl: this._imageUrl(listing, true) });
    return post.renderPost(view, { url: this._url(this._listingPath(listing.id)), usdPerBtc: this.usdPerBtc, sellerName });
  }

  async _sellerProfile (listing, member) {
    if (member && member.id === listing.seller) return member;
    const members = this.settings.members;
    return listing.seller && members ? members.resolve(listing.seller).catch(() => null) : null;
  }

  /**
   * Put a listing's change on the forum: a new thread, an edit of goon.vc's
   * own post, or tags plus a reply under a hand-written one. Failures are
   * logged on the listing and never fail the request.
   * @param {string} listingId
   * @param {Object} [opts] `{ changes, member, note, milestone, quiet }`
   */
  async _publish (listingId, opts = {}) {
    if (this.settings.sync === false) return;
    try {
      if (!this.forum) await this._findForum(this._token() || '').catch(() => null);
      if (!this.forum) return;
      const listing = this.listings.get(listingId);
      if (!listing) return;
      if (!listing.forum) {
        if (listing.status === 'hidden') return;
        await this._createThread(listing, opts.member);
        return;
      }
      if (listing.forum.deleted) return;
      await this._updateThread(listing, opts);
    } catch (error) {
      this._warn(`listing ${listingId} not updated on Discord: ${error.message}`);
      await this._exclusive(async () => {
        const listing = this.listings.get(listingId);
        if (!listing) return;
        listing.log = (listing.log || []).concat({ type: 'discord-error', error: error.message, at: this._iso() });
        await this._saveListing(listing);
      }).catch(() => {});
    }
  }

  async _createThread (listing, member) {
    const profile = await this._sellerProfile(listing, member);
    const name = listing.sellerName || this._memberName(profile);
    const appliedTags = post.appliedTags(listing, this.forum.tags, this.aliases);
    const hook = await this._hook();
    let threadId = null;
    let starterId = null;
    let authored = null;
    if (hook) {
      const payload = Object.assign(this._renderFor(listing), {
        thread_name: post.threadName(listing),
        applied_tags: appliedTags,
        username: webhookName(name)
      });
      if (profile && profile.avatarUrl) payload.avatar_url = profile.avatarUrl;
      const res = await this._discord('POST', `/webhooks/${hook.id}/${hook.token}?wait=true&with_components=true`, payload, { webhook: true });
      if (res.status === 200 && res.json && res.json.channel_id) {
        threadId = String(res.json.channel_id);
        starterId = String(res.json.id);
        authored = 'webhook';
      } else if (res.status === 404 || res.status === 401) {
        await this._dropHook();
      } else {
        throw new Error(`webhook post failed (${(res.json && res.json.message) || res.status})`);
      }
    }
    if (!threadId) {
      const res = await this._discord('POST', `/channels/${this.forum.id}/threads`, {
        name: post.threadName(listing),
        applied_tags: appliedTags,
        message: this._renderFor(listing, name)
      });
      if (res.status !== 200 && res.status !== 201) throw new Error((res.json && res.json.message) || `HTTP ${res.status}`);
      threadId = String(res.json.id);
      starterId = String((res.json.message && res.json.message.id) || res.json.id);
      authored = 'bot';
    }
    await this._exclusive(async () => {
      const current = this.listings.get(listing.id);
      current.forum = { guildId: this.guildId, channelId: this.forum.id, threadId, starterId, authored, archived: false, locked: false, deleted: false };
      current.log = (current.log || []).concat({ type: 'thread', authored, at: this._iso() });
      await this._saveListing(current);
      await this.store.set(`/cursors/${threadId}`, starterId);
    });
  }

  async _updateThread (listing, opts = {}) {
    const forum = listing.forum;
    const changes = opts.changes || {};
    const sold = listing.status === 'sold';
    if (forum.authored === 'webhook' || forum.authored === 'bot') {
      const hook = forum.authored === 'webhook' ? await this._hook() : null;
      let edited = false;
      if (hook) {
        const res = await this._discord('PATCH', `/webhooks/${hook.id}/${hook.token}/messages/${forum.starterId}?thread_id=${forum.threadId}&with_components=true`, this._renderFor(listing), { webhook: true });
        edited = res.status === 200;
        if (res.status === 404 && !(res.json && res.json.code === 10008)) await this._dropHook();
        if (res.status === 404 && res.json && res.json.code === 10008) return this._markDeleted(listing.id);
      } else if (forum.authored === 'bot') {
        const res = await this._discord('PATCH', `/channels/${forum.threadId}/messages/${forum.starterId}`, this._renderFor(listing, listing.sellerName));
        edited = res.status === 200;
        if (res.status === 404) return this._markDeleted(listing.id);
      }
      if (!edited && Object.keys(changes).length && !opts.quiet) {
        const note = post.updateText(changes, { usdPerBtc: this.usdPerBtc });
        if (note) await this._botReply(listing, note);
      }
    } else if (Object.keys(changes).length && !opts.quiet) {
      const shown = Object.assign({}, changes);
      if (opts.milestone) delete shown.status;
      const note = post.updateText(shown, { usdPerBtc: this.usdPerBtc });
      if (note) await this._botReply(listing, note);
    }
    if (opts.note) await this._botReply(listing, opts.note);
    if (opts.milestone) {
      const note = post.milestoneText(opts.milestone);
      if (note) await this._botReply(listing, note);
    }
    const patch = { applied_tags: post.appliedTags(listing, this.forum.tags, this.aliases) };
    if (forum.authored !== 'member' && changes.title) patch.name = post.threadName(listing);
    if (sold) Object.assign(patch, { locked: true, archived: true });
    else if (forum.archived || forum.locked) Object.assign(patch, { archived: false, locked: false });
    const res = await this._discord('PATCH', `/channels/${forum.threadId}`, patch);
    if (res.status === 404) return this._markDeleted(listing.id);
    if (res.status === 200) {
      await this._exclusive(async () => {
        const current = this.listings.get(listing.id);
        current.forum = Object.assign({}, current.forum, { archived: !!patch.archived, locked: !!patch.locked });
        await this._saveListing(current);
      });
    }
  }

  async _markDeleted (listingId) {
    return this._exclusive(async () => {
      const listing = this.listings.get(listingId);
      if (!listing || !listing.forum) return;
      listing.forum = Object.assign({}, listing.forum, { deleted: true });
      listing.log = (listing.log || []).concat({ type: 'removed', at: this._iso() });
      await this._saveListing(listing);
    });
  }

  async _unarchive (listing) {
    if (!listing.forum.archived) return;
    await this._discord('PATCH', `/channels/${listing.forum.threadId}`, { archived: false });
    listing.forum.archived = false;
  }

  /** A bot reply in the listing's thread, kept on the site as a Market note. */
  async _botReply (listing, content) {
    await this._unarchive(listing);
    const res = await this._discord('POST', `/channels/${listing.forum.threadId}/messages`, { content: content.slice(0, 2000), allowed_mentions: { parse: [] } });
    if (res.status !== 200) throw new Error((res.json && res.json.message) || `HTTP ${res.status}`);
    await this._exclusive(() => this._saveReply(listing.id, { id: String(res.json.id), author: 'goon.vc Market', body: content, via: 'market', at: this._iso() }));
  }

  /** A site member's reply, posted through the webhook under their name. */
  async _postReply (listing, body, who) {
    await this._unarchive(listing);
    const hook = await this._hook();
    if (hook) {
      const payload = { content: body, username: webhookName(who.name), allowed_mentions: { parse: [] } };
      if (who.avatarUrl) payload.avatar_url = who.avatarUrl;
      const res = await this._discord('POST', `/webhooks/${hook.id}/${hook.token}?wait=true&thread_id=${listing.forum.threadId}`, payload, { webhook: true });
      if (res.status === 200 && res.json) return String(res.json.id);
      if (res.status === 404 || res.status === 401) await this._dropHook();
    }
    const res = await this._discord('POST', `/channels/${listing.forum.threadId}/messages`, {
      content: `**${who.name}** on goon.vc: ${body}`.slice(0, 2000),
      allowed_mentions: { parse: [] }
    });
    if (res.status !== 200) throw new Error((res.json && res.json.message) || `HTTP ${res.status}`);
    return String(res.json.id);
  }

  /** A fresh URL for a listing image hosted on Discord's CDN. */
  async imageFor (id) {
    const listing = this.listings.get(String(id || '').toLowerCase());
    if (!listing || !listing.imageUrl) return null;
    if (!CDN_RE.test(listing.imageUrl)) return listing.imageUrl;
    const cached = this._images.get(listing.id);
    if (cached && cached.until > this._now()) return cached.url;
    let url = listing.imageUrl;
    const token = this._token();
    if (token) {
      const res = await this._discord('POST', '/attachments/refresh-urls', { attachment_urls: [listing.imageUrl] }).catch(() => null);
      const row = res && res.status === 200 && res.json && Array.isArray(res.json.refreshed_urls) ? res.json.refreshed_urls[0] : null;
      if (row && row.refreshed) url = row.refreshed;
    }
    let until = this._now() + HOUR;
    try {
      const ex = parseInt(new URL(url).searchParams.get('ex'), 16);
      if (ex) until = Math.min(ex * 1000 - 5 * MINUTE, this._now() + 12 * HOUR);
    } catch (_) { /* keep an hour */ }
    this._images.set(listing.id, { url, until });
    return url;
  }

  /* ---------- Hub ---------- */

  async _hub (method, apiPath, body) {
    const hubs = this.settings.hubs;
    if (!hubs || typeof hubs.order !== 'function' || !hubs.order().length) throw fail(503, 'No Hub is configured for escrow.');
    let lastError = null;
    for (const origin of hubs.order()) {
      let res;
      try {
        res = await this._fetch(origin + apiPath, {
          method,
          headers: Object.assign({ Accept: 'application/json' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20000)
        });
      } catch (error) {
        if (isUnreachable(error)) {
          lastError = error;
          continue;
        }
        throw fail(502, `The Hub did not answer: ${error.message}`);
      }
      if (typeof hubs.answered === 'function') hubs.answered(origin);
      let json = null;
      try { json = JSON.parse(await res.text()); } catch (_) { json = null; }
      return { status: res.status, json };
    }
    throw fail(503, `No Hub could be reached${lastError ? ` (${lastError.message})` : ''}.`);
  }

  /** The Hub's Bitcoin network, checked against `market.network`. */
  async _network () {
    if (this._hubInfo && this._hubInfo.at + 10 * MINUTE > this._now()) return this._hubInfo.network;
    const res = await this._hub('GET', '/services/federations');
    if (res.status !== 200 || !res.json || !res.json.network) throw fail(503, (res.json && res.json.message) || 'The Hub has no federations service for escrow.');
    const network = String(res.json.network).toLowerCase();
    const wanted = this.settings.network ? String(this.settings.network).toLowerCase() : null;
    if (wanted && wanted !== network) throw fail(503, `Escrow runs on ${wanted}, but the Hub is on ${network}.`);
    if (network === 'mainnet' && !this.settings.allowMainnet) throw fail(503, 'Escrow on mainnet is not turned on yet.');
    this._hubInfo = { network, at: this._now() };
    return network;
  }

  async _postFrame (hex) {
    const res = await this._hub('POST', '/services/federations/messages', { fabric: frameUri(hex) });
    if (res.status !== 200) throw fail(502, `The Hub refused a frame: ${(res.json && res.json.message) || res.status}`);
    return res.json;
  }

  _arbiter (order) {
    return escrow.arbiterKey(this._xprv(), order.id);
  }

  async _postInvite (order) {
    const invite = escrow.inviteFrame(order, this._arbiter(order));
    await this._postFrame(invite.frame);
    order.invitePostedAt = this._iso();
    if (!order.frames.some((f) => f.id === invite.id)) order.frames.push({ id: invite.id, type: 'FederationInvite', at: order.invitePostedAt });
  }

  async _postSigned (order, body) {
    const signed = signFrame(body, this._arbiter(order).key);
    await this._postFrame(signed.frame).catch((error) => this._warn(`order ${order.id}: ${error.message}`));
    order.frames.push({ id: signed.id, type: body.type, at: this._iso() });
    return signed;
  }

  /* ---------- orders ---------- */

  _roleName (order, x) {
    if (x === fabricPubkey(order.buyerPubkey)) return 'buyer';
    if (x === fabricPubkey(order.sellerPubkey)) return 'seller';
    if (x === fabricPubkey(order.arbiterPubkey)) return 'goon.vc';
    return null;
  }

  _withdrawalView (order, w) {
    if (!w) return null;
    const signers = (w.signers || []).map((x) => this._roleName(order, fabricPubkey(x))).filter(Boolean);
    const needs = w.kind === 'release' ? 'seller' : 'buyer';
    return {
      kind: w.kind,
      requestId: w.requestId,
      destinationAddress: w.destinationAddress,
      amountSats: w.amountSats,
      feeSats: w.feeSats,
      psbtBase64: w.psbtBase64,
      signers,
      needs: signers.includes(needs) ? null : needs,
      sign: `npm run market:sign -- sign ${order.id} --network ${order.network} --origin ${String(this.settings.siteUrl || '').replace(/\/+$/, '')}`
    };
  }

  _orderSummary (order, viewer) {
    const role = escrow.roleOf(order, viewer, this.settings.arbiters);
    return {
      id: order.id,
      path: this._orderPath(order.id),
      title: order.title,
      listing: { id: order.listing, path: this._listingPath(order.listing) },
      priceSats: order.priceSats,
      price: post.formatPrice(order.priceSats, this.usdPerBtc),
      state: order.state,
      stateLabel: ORDER_STATE_LABELS[order.state] || order.state,
      role,
      buyerName: order.buyerName,
      sellerName: order.sellerName,
      updatedAt: order.updatedAt
    };
  }

  _orderView (order, viewer) {
    const role = escrow.roleOf(order, viewer, this.settings.arbiters);
    const withdrawals = {};
    for (const [kind, w] of Object.entries(order.withdrawals || {})) withdrawals[kind] = this._withdrawalView(order, w);
    const steps = ['awaiting-payment', 'paid', 'delivered', order.state === 'refunded' || order.state === 'refunding' ? 'refunded' : 'released'];
    return Object.assign(this._orderSummary(order, viewer), {
      network: order.network,
      escrow: {
        federationId: order.escrow.federationId,
        address: order.escrow.address,
        threshold: escrow.THRESHOLD,
        descriptor: order.escrow.descriptor,
        paymentUri: escrow.paymentUri(order),
        path: null
      },
      invoice: escrow.invoice(order),
      payments: (order.payments || []).map((p) => ({
        txid: p.txid,
        verified: !!p.verified,
        confirmations: p.confirmations || 0,
        inMempool: !!p.inMempool,
        matchedSats: p.matchedSats || 0,
        seenAt: p.seenAt || null,
        checkedAt: p.checkedAt || null
      })),
      payGraceUntil: order.payGraceUntil || null,
      hubPayUrl: order.state === 'awaiting-payment' ? this._hubPayUrl(order) : null,
      parties: {
        buyer: { name: order.buyerName, pubkey: order.buyerPubkey },
        seller: { name: order.sellerName, pubkey: order.sellerPubkey },
        arbiter: { name: 'goon.vc', pubkey: order.arbiterPubkey }
      },
      payBy: order.payBy,
      paidAt: order.paidAt || null,
      deliverBy: order.deliverBy || null,
      deliveredAt: order.deliveredAt || null,
      confirmBy: order.confirmBy || null,
      settledAt: order.settledAt || null,
      funding: order.funding ? { txid: order.funding.txid, vout: order.funding.vout, amountSats: order.funding.amountSats } : null,
      refundAddress: order.refundAddress,
      payoutAddress: order.payoutAddress,
      feeSats: this.settings.feeSats,
      withdrawals,
      active: order.active,
      txid: order.txid || null,
      dispute: order.dispute || null,
      late: order.late || null,
      steps,
      log: (order.log || []).slice(-50),
      frames: order.frames || [],
      actions: this._actionsFor(order, role)
    });
  }

  _actionsFor (order, role) {
    const out = [];
    const can = (action, roles, states) => { if (roles.includes(role) && states.includes(order.state)) out.push(action); };
    can('cancel', ['buyer', 'seller', 'arbiter'], ['awaiting-payment']);
    can('delivered', ['seller'], ['paid']);
    can('release', ['buyer'], ['delivered']);
    can('release', ['arbiter'], ['delivered', 'disputed']);
    can('refund', ['seller', 'arbiter'], ['paid', 'delivered', 'disputed']);
    can('dispute', ['buyer', 'seller'], ['paid', 'delivered']);
    return [...new Set(out)];
  }

  getOrder (id, viewer) {
    return this._orderView(this._orderFor(id, viewer), viewer);
  }

  _orderFor (id, viewer) {
    this._requireViewer(viewer);
    const order = this.orders.get(String(id || '').toLowerCase());
    if (!order) throw fail(404, 'No such order.');
    if (!escrow.roleOf(order, viewer, this.settings.arbiters)) throw fail(403, 'Only the buyer, the seller, and Market arbiters can see this order.');
    return order;
  }

  /**
   * The order's payment as a Hub invoice (parties and arbiters only).
   * @param {string} id
   * @param {Object} viewer
   * @returns {Object}
   */
  getInvoice (id, viewer) {
    return escrow.invoice(this._orderFor(id, viewer));
  }

  /** Hub's Payments page with this order's BIP21 link filled in. */
  _hubPayUrl (order) {
    const hubs = this.settings.hubs;
    const origin = hubs && typeof hubs.order === 'function' ? hubs.order()[0] : null;
    if (!origin) return null;
    return `${origin}/payments?${new URLSearchParams({ bitcoinUri: escrow.paymentUri(order) })}#fabric-btc-make-payment-h4`;
  }

  /**
   * Ask the Hub whether a transaction pays the escrow in full: its L1
   * invoice check, `GET /services/bitcoin/transactions/<txid>?address=&amountSats=`.
   * @returns {Promise<Object>} `{ verified, confirmations, inMempool, matchedSats }`
   */
  async _checkPayment (order, txid) {
    const query = new URLSearchParams({ address: order.escrow.address, amountSats: String(order.priceSats) });
    const res = await this._hub('GET', `/services/bitcoin/transactions/${encodeURIComponent(txid)}?${query}`);
    if (res.status !== 200 || !res.json || typeof res.json.verified !== 'boolean') {
      throw fail(502, (res.json && res.json.message) || `The Hub could not check that transaction (HTTP ${res.status}).`);
    }
    return res.json;
  }

  /**
   * A party reports the transaction that paid the escrow. The Hub checks it
   * pays the full price to the escrow address; once it does, the order
   * stays open `payGraceHours` past `payBy` while the payment confirms, and
   * goon.vc looks at the vault again as soon as it has a confirmation.
   * @param {string} id
   * @param {Object} input `{ txid }`
   * @param {Object} member
   * @returns {Promise<Object>} order view
   */
  async reportPayment (id, input, member) {
    const order = this._orderFor(id, member);
    const role = escrow.roleOf(order, member, this.settings.arbiters);
    const txid = String((input && input.txid) || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txid)) throw fail(400, 'A transaction id is 64 hex characters.');
    if (order.state !== 'awaiting-payment') throw fail(409, `This order is ${ORDER_STATE_LABELS[order.state] || order.state}; it isn't waiting for a payment.`);
    const detail = await this._checkPayment(order, txid);
    if (!detail.verified) {
      const matched = Number(detail.matchedSats) || 0;
      throw fail(409, matched
        ? `That transaction pays ${matched.toLocaleString('en-US')} sats to the escrow address; the order needs ${order.priceSats.toLocaleString('en-US')} in one payment.`
        : 'The Hub doesn\'t see that transaction paying the escrow address. Check the txid, or wait a minute for it to reach the Hub.');
    }
    await this._exclusive(async () => {
      const current = this.orders.get(order.id);
      if (current.state !== 'awaiting-payment') return;
      const next = escrow.notePayment(current, txid, detail, { now: this._now(), settings: this._escrowSettings(), by: role });
      if (Number(detail.confirmations) > 0) next.vaultCheckedAt = 0;
      await this._saveOrder(next);
    });
    if (Number(detail.confirmations) > 0) await this._checkVault(order.id).catch((error) => this._warn(`order ${order.id}: ${error.message}`));
    return this._orderView(this.orders.get(order.id), member);
  }

  /** Re-check reported payments still waiting for a confirmation. */
  async _refreshPayments (id) {
    const order = this.orders.get(id);
    if (!order || order.state !== 'awaiting-payment') return;
    const pending = (order.payments || []).filter((p) => p.verified && !(p.confirmations > 0));
    for (const payment of pending) {
      let detail;
      try {
        detail = await this._checkPayment(order, payment.txid);
      } catch (error) {
        this._warn(`order ${id}: payment ${payment.txid.slice(0, 12)}: ${error.message}`);
        continue;
      }
      await this._exclusive(async () => {
        const current = this.orders.get(id);
        if (current.state !== 'awaiting-payment') return;
        await this._saveOrder(escrow.notePayment(current, payment.txid, detail, { now: this._now(), settings: this._escrowSettings() }));
      });
    }
  }

  /**
   * What a party's wallet needs to sign: the escrow descriptor and each
   * withdrawal request. Answered only for the buyer's or seller's key.
   * @param {string} id
   * @param {string} pubkey
   * @returns {Object}
   */
  signingRequest (id, pubkey) {
    const order = this.orders.get(String(id || '').toLowerCase());
    const x = fabricPubkey(String(pubkey || '').replace(/^fabric:/, ''));
    if (!order || !x) throw fail(404, 'No such order.');
    const role = this._roleName(order, x);
    if (role !== 'buyer' && role !== 'seller') throw fail(404, 'No such order.');
    return {
      order: order.id,
      role,
      state: order.state,
      network: order.network,
      federationId: order.escrow.federationId,
      descriptor: order.escrow.descriptor,
      withdrawals: Object.values(order.withdrawals || {}).map((w) => ({
        kind: w.kind,
        request: escrow.withdrawalBody(order, w),
        signers: (w.signers || []).map((s) => this._roleName(order, fabricPubkey(s))).filter(Boolean)
      }))
    };
  }

  /**
   * Open an escrow order on a listing.
   * @param {string} listingId
   * @param {Object} input `{ refundAddress, pubkey? }`
   * @param {Object} member the buyer
   * @returns {Promise<Object>} order view
   */
  async openOrder (listingId, input, member) {
    this._requireViewer(member);
    const listing = this.listings.get(String(listingId || '').toLowerCase());
    if (!listing || !this._visible(listing)) throw fail(404, 'No such listing.');
    if (await this._isSeller(listing, member)) throw fail(409, 'You can\'t buy your own listing.');
    if (!post.canBuy(listing)) throw fail(409, listing.priceSats ? `This listing is ${post.STATUS_LABELS[listing.status] || listing.status}.` : 'This listing has no BTC price yet; ask the seller for one.');
    if (listing.order) throw fail(409, 'Someone already has an escrow order open on this listing.');
    if (this._dibsActive(listing) && listing.dibs.member !== member.id) throw fail(409, `${listing.dibs.name} has dibs until ${listing.dibs.until.slice(0, 16).replace('T', ' ')} UTC.`);
    if (!listing.seller) throw fail(409, 'goon.vc does not know who posted this listing, so it can\'t escrow it.');
    const network = await this._network();
    const buyerPubkey = escrow.memberEscrowKey(member, network, input && input.pubkey);
    if (!buyerPubkey) throw fail(409, `Link your escrow key first: press "Link your escrow key" and approve it in Passport (on ${network}).`);
    const seller = await this.settings.members.resolve(listing.seller);
    const sellerPubkey = escrow.memberEscrowKey(seller, network);
    if (!sellerPubkey) throw fail(409, `${listing.sellerName || 'The seller'} hasn't linked an escrow key to goon.vc yet, so escrow isn't possible. Reply to ask them.`);
    const refundAddress = escrow.checkAddress(input && input.refundAddress, network);
    if (!this._xprv()) throw fail(503, 'goon.vc has no Fabric key to arbitrate with.');
    const order = await this._exclusive(async () => {
      const current = this.listings.get(listing.id);
      if (current.order) throw fail(409, 'Someone already has an escrow order open on this listing.');
      let id;
      do id = randomId(8); while (this.orders.has(id));
      const record = escrow.newOrder({
        id,
        listing: listing.id,
        title: current.title,
        priceSats: current.priceSats,
        buyer: member.id,
        seller: seller.id,
        buyerName: this._memberName(member),
        sellerName: current.sellerName,
        buyerPubkey,
        sellerPubkey,
        refundAddress,
        network
      }, escrow.arbiterKey(this._xprv(), id), { now: this._now(), settings: this._escrowSettings() });
      await this.store.set(`/federations/${record.escrow.federationId}`, { order: id });
      current.order = id;
      current.status = 'reserved';
      current.dibs = null;
      current.updatedAt = this._iso();
      current.activityAt = current.updatedAt;
      current.log = (current.log || []).concat({ type: 'order', at: current.updatedAt });
      await this._saveListing(current);
      return this._saveOrder(record);
    });
    await this._exclusive(async () => {
      const current = this.orders.get(order.id);
      await this._postInvite(current).catch((error) => this._warn(`order ${order.id} invite not posted: ${error.message}`));
      await this._saveOrder(current);
    });
    this.emit('log', 'MARKET', `order ${order.id} opened on listing ${listing.id}`);
    this._background(this._publish(listing.id, { milestone: 'reserved', quiet: true }));
    return this._orderView(this.orders.get(order.id), member);
  }

  /**
   * A party's or arbiter's step on an order.
   * @param {string} id
   * @param {string} step `delivered` | `dispute` | `release` | `refund` | `cancel`
   * @param {Object} input `{ payoutAddress?, pubkey?, reason? }`
   * @param {Object} member
   * @returns {Promise<Object>} order view
   */
  async orderAction (id, step, input, member) {
    this._requireViewer(member);
    if (!ORDER_ACTIONS.has(step)) throw fail(404, 'Not found');
    const order = this.orders.get(String(id || '').toLowerCase());
    if (!order) throw fail(404, 'No such order.');
    const role = escrow.roleOf(order, member, this.settings.arbiters);
    if (!role) throw fail(403, 'Only the buyer, the seller, and Market arbiters can act on this order.');
    let action = step;
    if (step === 'delivered') action = 'deliver';
    if (step === 'release') action = role === 'buyer' ? 'confirm' : 'release';
    const extra = {};
    if (action === 'deliver') {
      extra.payoutAddress = escrow.checkAddress(input && input.payoutAddress, order.network);
    }
    await this._exclusive(async () => {
      const current = this.orders.get(order.id);
      if (extra.payoutAddress) current.payoutAddress = extra.payoutAddress;
      await this._apply(current, action, { by: role, name: this._memberName(member), input: { reason: input && input.reason } });
    });
    return this._orderView(this.orders.get(order.id), member);
  }

  /**
   * Run a transition and its effects: build withdrawals, sign as arbiter,
   * settle when two signatures are in, and mirror the listing. Call inside
   * `_exclusive`.
   */
  async _apply (order, action, ctx) {
    const { order: next, effects } = escrow.transition(order, action, Object.assign({ now: this._now(), settings: this._escrowSettings() }, ctx));
    const fee = escrow.settingsOf(this._escrowSettings()).feeSats;
    if (effects.withdraw && !next.withdrawals[effects.withdraw]) {
      const w = escrow.buildWithdrawal(next, effects.withdraw, fee);
      next.withdrawals[effects.withdraw] = w;
      await this._postSigned(next, escrow.withdrawalBody(next, w));
    }
    if (effects.arbiterSign && next.active) {
      const w = next.withdrawals[next.active];
      const arbiter = this._arbiter(next);
      if (w && !(w.signers || []).includes(fabricPubkey(arbiter.pubkey))) {
        const signatures = escrow.arbiterSignatures(w, arbiter);
        next.withdrawals[next.active] = escrow.addSignatures(next, w, signatures);
        await this._postSigned(next, Federation.signatureMessage(next.escrow.federationId, w.requestId, signatures));
      }
    }
    await this._saveOrder(next);
    await this._orderListing(next, effects);
    await this._settle(next);
    return next;
  }

  /** Broadcast a withdrawal once two parties have signed it. */
  async _settle (order) {
    for (const kind of [order.active, 'release', 'refund']) {
      const w = kind && order.withdrawals[kind];
      if (!w || order.txid) continue;
      const done = escrow.finalize(order, w);
      if (!done) continue;
      let res = await this._hub('POST', `/services/federations/${order.escrow.federationId}/transactions`, { txHex: done.txHex });
      if (res.status === 404) {
        await this._postInvite(order);
        res = await this._hub('POST', `/services/federations/${order.escrow.federationId}/transactions`, { txHex: done.txHex });
      }
      if (res.status !== 200) {
        order.log.push({ type: 'broadcast-error', error: (res.json && res.json.message) || `HTTP ${res.status}`, at: this._iso() });
        await this._saveOrder(order);
        return;
      }
      const txid = (res.json && res.json.txid) || done.txid;
      if (!['releasing', 'refunding'].includes(order.state)) {
        order.state = kind === 'release' ? 'releasing' : 'refunding';
        order.active = kind;
      }
      await this._postSigned(order, Federation.broadcastMessage(order.escrow.federationId, w.requestId, txid));
      await this._apply(order, 'settle', { by: 'system', input: { txid } });
      return;
    }
  }

  async _orderListing (order, effects) {
    const listing = this.listings.get(order.listing);
    if (!listing) return;
    const closed = !escrow.OPEN_STATES.includes(order.state);
    const status = effects.listingStatus;
    let changed = false;
    if (status && listing.status !== status && listing.status !== 'hidden') {
      listing.status = status;
      changed = true;
    }
    if (closed && listing.order === order.id) {
      if (order.state !== 'released') listing.order = null;
      changed = true;
    }
    if (changed) {
      listing.updatedAt = this._iso();
      listing.activityAt = listing.updatedAt;
      listing.log = (listing.log || []).concat({ type: 'order-' + order.state, at: listing.updatedAt });
      await this._saveListing(listing);
    }
    if (effects.milestone || changed) {
      this._background(this._publish(listing.id, { milestone: effects.milestone, changes: changed ? { status } : {}, quiet: true }));
    }
  }

  /**
   * Take a signed `FederationWithdrawalSignature` frame from a party.
   * @param {string} frame hex or `fabric:` URI
   * @param {Object} [opts] `{ relay }` also post it to the Hub mailbox
   * @returns {Promise<Object>}
   */
  async ingest (frame, opts = {}) {
    let opened;
    let hex;
    try {
      hex = frameHex(frame);
      opened = openFrame(hex);
    } catch (error) {
      throw fail(400, error.message);
    }
    const body = opened.body;
    if (body.type !== Federation.MESSAGE_TYPES.signature) throw fail(400, 'Only FederationWithdrawalSignature frames are taken here.');
    const ref = await this.store.get(`/federations/${String(body.federationId || '').toLowerCase()}`);
    const orderId = ref && ref.order;
    if (!orderId || !this.orders.has(orderId)) throw fail(404, 'No Market order uses that federation.');
    return this._exclusive(async () => {
      const order = this.orders.get(orderId);
      if (order.frames.some((f) => f.id === opened.id)) return { order: order.id, duplicate: true };
      let signer;
      try {
        signer = Federation.verifySender(order.escrow.descriptor, body, opened.signer);
      } catch (error) {
        throw fail(403, error.message);
      }
      if (signer === fabricPubkey(order.arbiterPubkey)) throw fail(409, 'goon.vc signs its own part.');
      const w = Object.values(order.withdrawals || {}).find((x) => x.requestId === String(body.requestId));
      if (!w) throw fail(404, 'That withdrawal is not part of this order.');
      const signatures = (Array.isArray(body.signatures) ? body.signatures : []).filter((s) => fabricPubkey(s && s.pubkey) === signer);
      if (!signatures.length) throw fail(400, 'The frame carries no signatures by its signer.');
      try {
        order.withdrawals[w.kind] = escrow.addSignatures(order, w, signatures);
      } catch (error) {
        throw fail(400, `Signature does not verify: ${error.message}`);
      }
      order.frames.push({ id: opened.id, type: body.type, at: this._iso(), by: this._roleName(order, signer) });
      order.log.push({ type: 'signature', by: this._roleName(order, signer), withdrawal: w.kind, at: this._iso() });
      order.updatedAt = this._iso();
      await this._saveOrder(order);
      if (opts.relay) await this._postFrame(hex).catch(() => {});
      await this._settle(order);
      const after = this.orders.get(order.id);
      return { order: after.id, state: after.state, withdrawal: w.kind, signers: (after.withdrawals[w.kind].signers || []).map((x) => this._roleName(after, fabricPubkey(x))) };
    });
  }

  /* ---------- background ---------- */

  /**
   * One pass over the clock: dibs that ran out, order deadlines, escrow
   * funding, party signatures in the Hub mailbox, and invite re-posts.
   */
  async tick () {
    const now = this._now();
    for (const listing of this.listings.values()) {
      if (listing.dibs && !this._dibsActive(listing)) {
        await this._exclusive(async () => {
          const current = this.listings.get(listing.id);
          if (!current.dibs || this._dibsActive(current)) return;
          current.dibs = null;
          if (current.status === 'dibs') current.status = 'available';
          current.updatedAt = this._iso();
          current.log = (current.log || []).concat({ type: 'dibs-expired', at: current.updatedAt });
          await this._saveListing(current);
        });
        this._background(this._publish(listing.id, { quiet: true }));
      }
    }
    if (!this._xprv() || !this.settings.hubs) return;
    for (const order of Array.from(this.orders.values())) {
      try {
        await this._tickOrder(order.id, now);
      } catch (error) {
        this._warn(`order ${order.id}: ${error.message}`);
      }
    }
  }

  async _tickOrder (id, now) {
    const order = this.orders.get(id);
    const open = escrow.OPEN_STATES.includes(order.state);
    const late = ['expired', 'cancelled'].includes(order.state) && !order.late && Date.parse(order.updatedAt) + LATE_WATCH_MS > now;
    if (!open && !late) return;
    if (open && (!order.invitePostedAt || Date.parse(order.invitePostedAt) + this.settings.inviteEveryMs <= now)) {
      await this._exclusive(async () => {
        const current = this.orders.get(id);
        await this._postInvite(current);
        for (const w of Object.values(current.withdrawals || {})) {
          await this._postFrame(signFrame(escrow.withdrawalBody(current, w), this._arbiter(current).key).frame).catch(() => {});
        }
        await this._saveOrder(current);
      });
    }
    if ((order.state === 'awaiting-payment' || late) && (!order.vaultCheckedAt || order.vaultCheckedAt + this.settings.vaultEveryMs <= now)) {
      await this._checkVault(id);
      await this._refreshPayments(id);
    }
    const current = this.orders.get(id);
    if (Object.keys(current.withdrawals || {}).length && escrow.OPEN_STATES.includes(current.state)) await this._readMailbox(id);
    const due = escrow.due(this.orders.get(id), now);
    if (due) {
      await this._exclusive(async () => {
        const fresh = this.orders.get(id);
        if (escrow.due(fresh, this._now()) !== due) return;
        await this._apply(fresh, due, { by: 'system' });
      });
    }
  }

  async _checkVault (id) {
    const order = this.orders.get(id);
    let res = await this._hub('GET', `/services/federations/${order.escrow.federationId}/vault`);
    if (res.status === 404) {
      await this._exclusive(async () => {
        await this._postInvite(this.orders.get(id));
        await this._saveOrder(this.orders.get(id));
      });
      res = await this._hub('GET', `/services/federations/${order.escrow.federationId}/vault`);
    }
    await this._exclusive(async () => {
      const current = this.orders.get(id);
      current.vaultCheckedAt = this._now();
      const coins = res.status === 200 && res.json && Array.isArray(res.json.utxos) ? res.json.utxos : [];
      const coin = coins.filter((u) => Number(u.amountSats) >= current.priceSats && u.txHex).sort((a, b) => a.amountSats - b.amountSats)[0];
      if (!coin) return this._saveOrder(current);
      const funding = { txid: coin.txid, vout: coin.vout, amountSats: Number(coin.amountSats), height: coin.height ?? null, txHex: coin.txHex };
      if (current.state === 'awaiting-payment') {
        await this._apply(current, 'fund', { by: 'system', input: { funding } });
        return null;
      }
      // Paid after the order closed: goon.vc signs a refund for the buyer to co-sign.
      current.funding = funding;
      current.late = { at: this._iso(), from: current.state };
      current.state = 'refunding';
      current.active = 'refund';
      current.log.push({ type: 'late-payment', by: 'system', at: this._iso() });
      const fee = escrow.settingsOf(this._escrowSettings()).feeSats;
      const w = escrow.buildWithdrawal(current, 'refund', fee);
      const arbiter = this._arbiter(current);
      const signatures = escrow.arbiterSignatures(w, arbiter);
      current.withdrawals.refund = escrow.addSignatures(current, w, signatures);
      await this._postSigned(current, escrow.withdrawalBody(current, w));
      await this._postSigned(current, Federation.signatureMessage(current.escrow.federationId, w.requestId, signatures));
      return this._saveOrder(current);
    });
  }

  async _readMailbox (id) {
    const order = this.orders.get(id);
    const since = Number(order.mailboxSeq) || 0;
    const res = await this._hub('GET', `/services/federations/messages?pubkey=${order.arbiterPubkey}&since=${since}&limit=200`);
    if (res.status !== 200 || !res.json || !Array.isArray(res.json.messages)) return;
    for (const message of res.json.messages) {
      if (message.federationId !== order.escrow.federationId || message.type !== Federation.MESSAGE_TYPES.signature) continue;
      if (fabricPubkey(message.signer) === fabricPubkey(order.arbiterPubkey)) continue;
      await this.ingest(message.fabric).catch((error) => {
        if (error.status !== 409) this._warn(`order ${id}: mailbox frame refused: ${error.message}`);
      });
    }
    await this._exclusive(async () => {
      const current = this.orders.get(id);
      current.mailboxSeq = Number(res.json.next) || since;
      await this._saveOrder(current);
    });
  }

  /* ---------- link previews ---------- */

  async page (pathname) {
    const clean = String(pathname || '').replace(/\/+$/, '');
    const base = this.base;
    if (clean === base) return null;
    if (clean.indexOf(base + '/') !== 0) return null;
    const [collection, id, more] = clean.slice(base.length + 1).split('/');
    if (more !== undefined || !id) return null;
    if (collection === 'listings') {
      const listing = this.listings.get(String(id).toLowerCase());
      if (!listing || listing.status === 'hidden') return null;
      const bits = [post.formatPrice(listing.priceSats, this.usdPerBtc), listing.kind, post.STATUS_LABELS[listing.status], listing.insurance].filter(Boolean);
      return Object.assign({
        path: clean,
        title: `${listing.title} · G00N SQUAD Market`,
        description: `${bits.join(' · ')}. Listed by ${listing.sellerName || 'a G00N SQUAD member'}.`
      }, listing.imageUrl ? { image: this._imageUrl(listing, true) } : {});
    }
    if (collection === 'sellers') {
      const found = this.seller(id);
      if (!found) return null;
      return { path: clean, title: `${found.seller.name} · G00N SQUAD Market`, description: `${found.listings.length} listing${found.listings.length === 1 ? '' : 's'} on the G00N SQUAD Market.` };
    }
    if (collection === 'orders') {
      if (!this.orders.has(String(id).toLowerCase())) return null;
      return { path: clean, title: 'Escrow order · G00N SQUAD Market', description: 'A 2-of-3 Bitcoin escrow on the G00N SQUAD Market.' };
    }
    if (collection === 'mine' || collection === 'new') return null;
    return null;
  }

  /* ---------- HTTP ---------- */

  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      const base = this.base;
      if (pathname !== base && !pathname.startsWith(base + '/')) return next();
      const method = String(req.method || 'GET').toUpperCase();
      const parts = pathname.slice(base.length).split('/').filter(Boolean).map((p) => {
        try { return decodeURIComponent(p); } catch (_) { return p; }
      });
      const query = req.query || Object.fromEntries(new URL(req.url || pathname, 'http://localhost').searchParams);
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      Promise.resolve().then(async () => {
        const [collection, id, action] = parts;
        const viewer = await this._viewer(req);
        if (!parts.length && method === 'GET') return [200, this.catalog(query, viewer)];
        if (collection === 'mine' && parts.length === 1 && method === 'GET') return [200, await this.mine(viewer)];
        if (collection === 'listings') {
          if (parts.length === 1) {
            if (method === 'GET') return [200, { listings: this.search(query, viewer) }];
            if (method === 'POST') return [201, await this.create(body, viewer)];
            if (method === 'PATCH') return [200, await this.updateMany(body.ids, body.changes || {}, viewer)];
          }
          if (parts.length === 2) {
            if (method === 'GET') {
              const listing = await this.getListing(id, viewer);
              if (!listing) throw fail(404, 'No such listing.');
              return [200, listing];
            }
            if (method === 'PATCH') return [200, await this.update(id, body, viewer)];
          }
          if (parts.length === 3 && method === 'GET' && action === 'image') {
            const url = await this.imageFor(id);
            if (!url) throw fail(404, 'This listing has no image.');
            res.statusCode = 302;
            res.setHeader('Location', url);
            res.setHeader('Cache-Control', 'public, max-age=300');
            res.end();
            return null;
          }
          if (parts.length === 3 && method === 'POST') {
            if (action === 'replies') return [201, await this.reply(id, body, viewer)];
            if (action === 'dibs') return [200, await this.dibs(id, body, viewer)];
            if (action === 'orders') return [201, await this.openOrder(id, body, viewer)];
          }
        }
        if (collection === 'sellers' && parts.length === 2 && method === 'GET') {
          const found = this.seller(id, viewer);
          if (!found) throw fail(404, 'No listings from that seller.');
          return [200, found];
        }
        if (collection === 'orders') {
          if (parts.length === 2 && method === 'GET') {
            const order = this.getOrder(id, viewer);
            order.escrow.qr = order.state === 'awaiting-payment' ? await qrSvg(order.escrow.paymentUri) : null;
            return [200, order];
          }
          if (parts.length === 3 && method === 'GET' && action === 'request') return [200, this.signingRequest(id, query.pubkey)];
          if (parts.length === 3 && method === 'GET' && action === 'invoice') return [200, this.getInvoice(id, viewer)];
          if (parts.length === 3 && method === 'POST' && action === 'payments') return [200, await this.reportPayment(id, body, viewer)];
          if (parts.length === 3 && method === 'POST') return [200, await this.orderAction(id, action, body, viewer)];
        }
        if (collection === 'messages' && parts.length === 1 && method === 'POST') {
          return [200, await this.ingest(body.frame, { relay: true })];
        }
        throw fail(parts.length > 3 ? 404 : 405, parts.length > 3 ? 'Not found' : 'Method not allowed');
      }).then((result) => {
        if (result) sendJson(res, result[0], result[1]);
      }, (error) => {
        if (res.headersSent) return;
        sendJson(res, error && error.status ? error.status : 500, { error: error && error.message ? error.message : 'Market request failed' });
      });
    };
  }
}

module.exports = Market;
module.exports.BASE = BASE;
module.exports.isPublicForum = isPublicForum;
module.exports.plainContent = plainContent;
