'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const clientKey = require('../functions/clientKey');
const { accountKey, parseAccountKey } = require('../functions/accountKey');
const rsiCitizen = require('../functions/rsiCitizen');
const rsiClaim = require('../functions/rsiClaim');

const passportRp = require('@fabric/http/functions/passportRelyingParty');
const passportHttp = require('@fabric/http/functions/passportHttp');

/** `@fabric/http` peer sessions, when the installed version has them. */
let passportPeer = null;
try {
  passportPeer = require('@fabric/http/functions/passportPeer');
} catch (_) {
  passportPeer = null;
}


const BASE = '/services/members';
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DEFAULT_COOKIE = 'goon.member';
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_COOKIE = 'goon.oauth';
const PASSPORT_COOKIE = 'goon.passport';
const PASSPORT_REQUEST_TTL_MS = 2 * 60 * 1000;
const PASSPORT_PURPOSE = 'Sign in to G00N SQUAD';
const PASSPORT_ESCROW_PURPOSE = 'Link your G00N SQUAD Market escrow key';
const PASSPORT_PREFIX = '/passport-requests/';
const OAUTH_PREFIX = '/oauth/';
const SWEEP_EVERY_MS = 10 * 60 * 1000;
// Starting a login writes a record before anyone has signed in.
const LOGIN_STARTS = { limit: 60, windowMs: 60 * 1000 };
const LOGIN_STARTS_TRACKED = 10000;
const MEMBER_ID_RE = /^[0-9a-f]{16}$/;
const MAX_HOPS = 8;
const CLAIM_LINK_PATH = '/rsi/claim';
const CLAIM_LINK_TTL_MS = 30 * 60 * 1000;
// A session a claim link starts is for claiming a handle, not a standing login.
const CLAIM_LINK_SESSION_TTL_MS = 60 * 60 * 1000;
const RSI_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const RSI_VERIFY_LIMIT = 5;
const RSI_VERIFY_WINDOW_MS = 15 * 60 * 1000;
const REVIEW_SINCE_KEY = '/reviews/since';
const REVIEW_PENDING_KEY = '/reviews/pending';
const REVIEW_DECISIONS = ['approved', 'denied'];
// A merge keeps the better of the two members' reviews.
const REVIEW_RANK = { approved: 3, pending: 2, denied: 1 };

function sha256 (value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken () {
  return crypto.randomBytes(32).toString('hex');
}

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseCookies (header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    const name = part.slice(0, i).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(part.slice(i + 1).trim());
    } catch (_) {
      out[name] = part.slice(i + 1).trim();
    }
  }
  return out;
}

function requestProto (req) {
  const xf = req.headers && req.headers['x-forwarded-proto'];
  if (typeof xf === 'string' && xf.trim()) return xf.split(',')[0].trim();
  return req.secure ? 'https' : 'http';
}

function addCookie (res, cookie) {
  const prior = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [].concat(prior || [], cookie));
}

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function redirect (res, location) {
  res.statusCode = 302;
  res.setHeader('Location', location);
  res.setHeader('Cache-Control', 'no-store');
  res.end();
}

function compact (object) {
  return Object.fromEntries(Object.entries(object || {}).filter(([, value]) => value !== undefined && value !== null));
}

/**
 * What a signed-in member sees of themselves: no account ids, only which
 * platforms are linked and which one this session signed in with. With
 * reviews on, `review` is their place in the waiting area (no reviewer).
 * `admin` is set only for an operator (`settings.isAdmin`), and never for a
 * one-time RSI claim-link session.
 */
function publicMember (member, via, review, admin) {
  if (!member) return null;
  return Object.assign({
    id: member.id,
    provider: via || null,
    displayName: member.displayName || null,
    avatarUrl: member.avatarUrl || null,
    inGuild: member.inGuild === true,
    platforms: Array.from(new Set((member.accounts || []).map((account) => account.platform))),
    createdAt: member.createdAt,
    lastLoginAt: member.lastLoginAt || null
  }, review === undefined ? {} : { review }, admin ? { admin: true } : {});
}

function accountView (account) {
  const profile = account.profile || {};
  let label = account.id;
  if (account.platform === 'discord') label = profile.username ? `@${profile.username}` : 'Discord account';
  else if (account.platform === 'fabric') label = `${account.id.slice(0, 8)}…${account.id.slice(-6)}`;
  else if (account.platform === 'rsi') label = account.id;
  return {
    key: account.key,
    platform: account.platform,
    via: account.via,
    linkedAt: account.linkedAt,
    label,
    name: profile.globalName || profile.name || profile.displayName || null,
    escrow: account.cosigner ? account.cosigner.network : null
  };
}

/**
 * A member profile page's linked accounts: what each is, never its key.
 */
function profileAccountView (account, self) {
  const view = accountView(account);
  return compact(Object.assign({
    platform: view.platform,
    label: view.label,
    name: view.name,
    url: account.platform === 'rsi' ? rsiCitizen.citizenUrl(account.id) : null,
    linkedAt: view.linkedAt,
    escrow: view.escrow
  }, self ? { key: view.key, via: view.via } : {}));
}

function discordAccounts (member) {
  return ((member && member.accounts) || []).filter((account) => account.platform === 'discord');
}

/**
 * The names a member may go by, RSI first: each RSI handle and the name its
 * citizen page shows, then each Discord display name and username. Only
 * names a linked account carries, so no one takes a name they can't prove.
 * @param {Object|null} member
 * @returns {Array<{ name: string, platform: string, label: string }>}
 */
function nameChoices (member) {
  const accounts = (member && member.accounts) || [];
  const choices = [];
  const add = (name, platform, label) => {
    const clean = typeof name === 'string' ? name.trim() : '';
    if (clean && !choices.some((choice) => choice.name === clean)) choices.push({ name: clean, platform, label });
  };
  for (const account of accounts.filter((held) => held.platform === 'rsi')) {
    add(account.id, 'rsi', 'RSI handle');
    add(account.profile && account.profile.displayName, 'rsi', 'RSI display name');
  }
  for (const account of discordAccounts(member)) {
    add(account.profile && account.profile.globalName, 'discord', 'Discord display name');
    add(account.profile && account.profile.username, 'discord', 'Discord username');
  }
  return choices;
}

/**
 * Why linking `parsed` to `member` (merging in `owner`, its current holder)
 * would leave the member with a second Discord account, or null. Members
 * that already hold several from before the rule keep them.
 */
function discordConflict (member, owner, parsed) {
  const held = discordAccounts(member);
  if (!held.length) return null;
  const heldKeys = new Set(held.map((account) => account.key));
  const incoming = discordAccounts(owner && owner.id !== member.id ? owner : null).map((account) => account.key);
  if (parsed.platform === 'discord') incoming.push(parsed.key);
  if (incoming.every((key) => heldKeys.has(key))) return null;
  const error = parsed.platform === 'discord' && !heldKeys.has(parsed.key)
    ? fail(409, `Your profile already has a Discord account (${accountView(held[0]).label}). A profile holds one Discord account: unlink it first to link a different one.`)
    : fail(409, 'That account belongs to another profile with its own Discord account, and a profile holds one Discord account. Unlink one of the two Discord accounts first.');
  error.code = 'one_discord';
  return error;
}

function isLoopbackOrigin (origin) {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch (_) {
    return false;
  }
}

/**
 * goon.vc members: one permanent member (16 hex characters) per person,
 * collecting every account they have proven — Discord through OAuth or a
 * command, Fabric identities through a Passport v2 assertion signed for a
 * challenge this site issued to one of its pinned origins (by Passport, the
 * Hub desktop app, or GoonCitizen), other platforms later as `platform:id`.
 * Linking an account another member already holds merges the two (the older
 * member survives; the other id becomes an alias). Members, account and alias
 * indexes, login sessions, OAuth states, and Passport challenges all live in one
 * `@fabric/core` {@link Store}. With `review` on, a member's first Discord
 * sign-in or link since reviews began puts them in the waiting area until a
 * reviewer approves or denies them (services/reviews.js).
 */
class Members extends EventEmitter {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string[]} [settings.origins] Origins Passport may sign in to
   *   (e.g. `['https://goon.vc']`). Unset: `siteUrl` in production (or when it
   *   is a loopback origin), otherwise loopback origins only. The `Host`
   *   header never picks one.
   * @param {boolean} [settings.production] Default `NODE_ENV === 'production'`.
   * @param {Function} [settings.escrowNetwork] Async: the network Market
   *   escrow runs on, for "Link your escrow key" challenges.
   * @param {string} [settings.loginPath] SPA page to return to after login.
   * @param {string} [settings.siteUrl] Origin for one-time claim links (e.g. `https://goon.vc`).
   * @param {string} [settings.claimPath] SPA page for RSI claims (default `/rsi`).
   * @param {boolean} [settings.review] Discord sign-ins wait for a reviewer (default false).
   *   Members from before reviews were first turned on count as approved.
   * @param {string} [settings.waitingPath] SPA page for members awaiting review (default `/waiting`).
   * @param {string} [settings.membersPath] SPA member directory; profiles live at `<membersPath>/<id>` (default `/members`).
   * @param {Object} [settings.discord] `{ clientId, clientSecret, redirectUri, guildId, applicationId }`;
   *   `applicationId` is `async () => string|null`, the client id used when `clientId` is unset
   *   (the application that owns the bot token).
   * @param {number} [settings.sessionTtlMs]
   * @param {string} [settings.cookieName]
   * @param {Function} [settings.fetch] Injected for tests; defaults to global fetch.
   * @param {Function} [settings.isAdmin] `(member) => boolean`. When it returns
   *   true, the session view includes `admin: true` (not for an RSI claim-link session).
   * @param {Function} [settings.needsReview] `(member) => boolean`. When it
   *   returns false, Discord sign-in is approved immediately so they can claim
   *   an RSI handle. Unset: every Discord sign-in waits. Officers on record
   *   are the production check (`functions/reviewOfficers.js`).
   */
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({
      path: './stores/members',
      loginPath: '/sessions',
      waitingPath: '/waiting',
      membersPath: '/members',
      review: false,
      discord: {},
      sessionTtlMs: DEFAULT_SESSION_TTL_MS,
      cookieName: DEFAULT_COOKIE,
      loginStarts: LOGIN_STARTS
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.discord = Object.assign({}, this.settings.discord);
    this.passport = this._createPassport();
    this._fetch = this.settings.fetch || ((...args) => fetch(...args));
    this._queue = Promise.resolve();
    this._reviewSince = null;
    this.store = null;
  }

  get reviewsEnabled () {
    return this.settings.review === true;
  }

  get discordEnabled () {
    if (!this.discord.clientSecret) return false;
    return !!this.discord.clientId || typeof this.discord.applicationId === 'function';
  }

  async _discordClientId () {
    if (this.discord.clientId) return this.discord.clientId;
    if (!this.discordEnabled) return null;
    try {
      const id = await this.discord.applicationId();
      if (id) this.discord.clientId = String(id);
    } catch (_) { /* Discord unreachable: try again on the next login */ }
    return this.discord.clientId || null;
  }

  async start () {
    this.store = new Store({
      name: 'GOON.VC:members',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await startStore(this.store);
    await this._sweepExpired();
    this._sweeper = setInterval(() => { this._sweepExpired(); }, SWEEP_EVERY_MS);
    if (this._sweeper.unref) this._sweeper.unref();
    if (this.reviewsEnabled) await this._startReviews();
    return this;
  }

  // Reviews began the first time they were turned on; everyone who was a
  // member by then is approved.
  async _startReviews () {
    const since = await this._read(REVIEW_SINCE_KEY);
    if (since && since.at) {
      this._reviewSince = since.at;
      return;
    }
    this._reviewSince = new Date().toISOString();
    await this.store.set(REVIEW_SINCE_KEY, { at: this._reviewSince });
  }

  async stop () {
    if (this._sweeper) clearInterval(this._sweeper);
    this._sweeper = null;
    if (this.store) await this.store.stop();
    return this;
  }

  // Member writes read, change, and save whole records; one at a time keeps a
  // merge from racing a link or a login.
  _serial (fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async _read (key) {
    const value = await this.store.get(key);
    return value && typeof value === 'object' ? structuredClone(value) : value;
  }

  async _save (member) {
    await this.store.set(`/members/${member.id}`, member);
    return member;
  }

  /**
   * The member behind a member id, a merged-away or legacy id
   * (`discord:<id>`, `fabric:<id>` from before accounts), or an account key.
   * @param {string} idOrKey
   * @returns {Promise<Object|null>}
   */
  resolve (idOrKey) {
    const id = String(idOrKey || '').trim();
    if (!id) return Promise.resolve(null);
    return this._serial(() => this._resolve(id));
  }

  getMember (id) {
    return this.resolve(id);
  }

  async _resolve (id, hops = 0) {
    if (hops > MAX_HOPS) return null;
    if (MEMBER_ID_RE.test(id)) {
      const member = await this._read(`/members/${id}`);
      if (member && member.mergedInto) return this._resolve(member.mergedInto, hops + 1);
      if (member) return member;
    }
    const alias = await this._read(`/aliases/${id}`);
    if (alias && alias.member) return this._resolve(alias.member, hops + 1);
    const owner = await this._owner(parseAccountKey(id), hops);
    if (owner) return owner;
    return this._adoptLegacy(id);
  }

  async _owner (parsed, hops = 0) {
    if (!parsed) return null;
    const index = await this._read(`/accounts/${parsed.key}`);
    return index && index.member ? this._resolve(index.member, hops + 1) : null;
  }

  // A member saved before accounts (`/members/discord:<id>` or
  // `/members/fabric:<id>`) becomes a member with that account on first touch.
  async _adoptLegacy (id) {
    if (MEMBER_ID_RE.test(id) || id.indexOf(':') === -1) return null;
    const legacy = await this._read(`/members/${id}`);
    if (!legacy || typeof legacy !== 'object' || legacy.mergedInto) return null;
    let member = await this._blank({
      createdAt: legacy.createdAt,
      lastLoginAt: legacy.lastLoginAt,
      displayName: legacy.displayName,
      avatarUrl: legacy.avatarUrl,
      inGuild: legacy.inGuild
    });
    await this.store.set(`/aliases/${id}`, { member: member.id, at: new Date().toISOString() });
    const accounts = [];
    if (legacy.discord && legacy.discord.id) {
      accounts.push([accountKey('discord', legacy.discord.id), { username: legacy.discord.username, globalName: legacy.discord.globalName }]);
    }
    if (legacy.fabric) {
      accounts.push([accountKey('fabric', legacy.fabric.pubkeyHex), { pubkeyHex: legacy.fabric.pubkeyHex }]);
    }
    for (const [parsed, profile] of accounts) {
      if (!parsed) continue;
      const owner = await this._owner(parsed);
      if (owner && owner.id !== member.id) member = await this._merge(member, owner);
      member = await this._attach(member, parsed, { via: 'legacy', profile, linkedAt: legacy.createdAt });
    }
    return member;
  }

  async _blank (fields = {}) {
    let id;
    do {
      id = crypto.randomBytes(8).toString('hex');
    } while (await this.store.get(`/members/${id}`));
    const now = new Date().toISOString();
    return this._save({
      id,
      createdAt: fields.createdAt || now,
      lastLoginAt: fields.lastLoginAt || null,
      displayName: fields.displayName || null,
      avatarUrl: fields.avatarUrl || null,
      inGuild: fields.inGuild === true,
      accounts: [],
      log: []
    });
  }

  async _attach (member, parsed, opts = {}) {
    const now = new Date().toISOString();
    const via = opts.via || 'link';
    const profile = compact(opts.profile);
    const existing = member.accounts.find((account) => account.key === parsed.key);
    if (existing) {
      const before = JSON.stringify(existing);
      existing.profile = Object.assign({}, existing.profile || {}, profile);
      if (existing.via === 'cluster' && via !== 'cluster') {
        existing.via = via;
        delete existing.from;
      } else if (existing.via === 'cluster' && opts.from) {
        existing.from = opts.from;
      }
      if (JSON.stringify(existing) === before) return member;
    } else {
      const account = Object.assign({
        key: parsed.key,
        platform: parsed.platform,
        id: parsed.id,
        via,
        linkedAt: opts.linkedAt || now,
        profile
      }, via === 'cluster' && opts.from ? { from: opts.from } : {});
      member.accounts.push(account);
      member.log.push({ type: 'link', account: parsed.key, via, at: now });
      const named = !member.displayName && nameChoices({ accounts: [account] })[0];
      if (named) member.displayName = named.name;
      await this.store.set(`/accounts/${parsed.key}`, { member: member.id });
    }
    return this._save(member);
  }

  async _detach (member, keys, reason) {
    const now = new Date().toISOString();
    const drop = new Set(keys);
    member.accounts = member.accounts.filter((account) => !drop.has(account.key));
    for (const key of drop) {
      member.log.push(Object.assign({ type: 'unlink', account: key, at: now }, reason ? { reason } : {}));
      await this.store.set(`/accounts/${key}`, { member: null, unlinkedAt: now });
    }
    return this._save(member);
  }

  async _merge (a, b) {
    if (a.id === b.id) return a;
    // Callers pass the account's current holder as `b`, so a tie keeps it.
    const [into, from] = Date.parse(b.createdAt) <= Date.parse(a.createdAt) ? [b, a] : [a, b];
    const now = new Date().toISOString();
    for (const account of from.accounts || []) {
      if (!into.accounts.some((held) => held.key === account.key)) into.accounts.push(account);
      await this.store.set(`/accounts/${account.key}`, { member: into.id });
    }
    if (!into.displayName) into.displayName = from.displayName || null;
    if (!into.avatarUrl) into.avatarUrl = from.avatarUrl || null;
    into.inGuild = into.inGuild === true || from.inGuild === true;
    if (from.lastLoginAt && (!into.lastLoginAt || from.lastLoginAt > into.lastLoginAt)) into.lastLoginAt = from.lastLoginAt;
    const reviews = [this._reviewRecord(into), this._reviewRecord(from)].filter(Boolean)
      .sort((x, y) => (REVIEW_RANK[y.status] - REVIEW_RANK[x.status]) || String(x.requestedAt || '').localeCompare(String(y.requestedAt || '')));
    if (reviews.length) {
      into.review = Object.assign({}, reviews[0]);
      if (reviews.some((review) => review.status === 'pending')) {
        await this._indexPending(from.id, null);
        await this._indexPending(into.id, into.review.status === 'pending' ? into.review.requestedAt : null);
      }
    }
    into.log = (into.log || []).concat(from.log || [])
      .sort((x, y) => String(x.at).localeCompare(String(y.at)))
      .concat({ type: 'merge', from: from.id, at: now });
    await this._save(into);
    await this.store.set(`/members/${from.id}`, { id: from.id, mergedInto: into.id, mergedAt: now });
    await this.store.set(`/aliases/${from.id}`, { member: into.id, at: now });
    this.emit('merged', { from: from.id, into: into.id });
    return into;
  }

  /**
   * The member holding one account, or null.
   * @param {string} key Account key (`discord:<id>`, `fabric:<pubkey>`, …).
   * @param {Object} [opts]
   * @param {boolean} [opts.create] Start a member for an account nobody holds.
   * @param {string} [opts.via] How the account was proven, for a new link.
   * @param {Object} [opts.profile] Account profile to store or refresh.
   * @param {string} [opts.displayName] Name to start a new member with.
   * @param {string} [opts.avatarUrl]
   * @param {boolean} [opts.inGuild]
   * @param {string[]} [opts.legacy] Pre-account member ids that may hold it.
   * @returns {Promise<Object|null>}
   */
  memberFor (key, opts = {}) {
    const parsed = parseAccountKey(key);
    if (!parsed) return Promise.reject(new Error('Account key required'));
    return this._serial(async () => {
      let member = await this._resolve(parsed.key);
      for (const legacy of [].concat(opts.legacy || [])) {
        if (member) break;
        if (legacy) member = await this._resolve(legacy);
      }
      if (!member) {
        if (!opts.create) return null;
        member = await this._blank({ displayName: opts.displayName, avatarUrl: opts.avatarUrl, inGuild: opts.inGuild });
      }
      if (opts.create || opts.profile) member = await this._attach(member, parsed, opts);
      return member;
    });
  }

  /**
   * The goon.vc member for a Discord account, created on first sight — by a
   * Discord command, say — as the same member Discord login signs in to.
   * Not a login: sessions and `lastLoginAt` are untouched, and a display name
   * already on the profile is kept.
   * @param {{ id: string, username?: string, globalName?: string }} user Discord user.
   * @param {string} [displayName] Name to start a new profile with.
   * @returns {Promise<Object>} the member
   */
  async linkDiscord (user, displayName) {
    const parsed = accountKey('discord', user && user.id);
    if (!parsed) throw new Error('Discord user id required');
    return this.memberFor(parsed.key, {
      create: true,
      via: 'command',
      profile: { username: user.username || null, globalName: user.globalName || null },
      displayName: displayName || user.globalName || user.username
    });
  }

  /**
   * Add a proven account to a member. An account another member holds
   * merges the two.
   * @param {string} memberId
   * @param {string} key Account key.
   * @param {Object} [opts] `{ via, profile, from, legacy }`
   * @returns {Promise<{ member: Object, merged: boolean }>}
   */
  link (memberId, key, opts = {}) {
    const parsed = parseAccountKey(key);
    if (!parsed) return Promise.reject(new Error('Account key required'));
    return this._serial(() => this._link(memberId, parsed, opts));
  }

  async _link (memberId, parsed, opts = {}) {
    let member = await this._resolve(memberId);
    if (!member) throw fail(404, 'Member not found');
    let owner = await this._resolve(parsed.key);
    for (const legacy of [].concat(opts.legacy || [])) {
      if (owner) break;
      if (legacy) owner = await this._resolve(legacy);
    }
    const conflict = discordConflict(member, owner, parsed);
    if (conflict) throw conflict;
    const merged = !!owner && owner.id !== member.id;
    if (merged) member = await this._merge(member, owner);
    member = await this._attach(member, parsed, opts);
    return { member, merged };
  }

  /**
   * Remove one account (and the cluster keys it brought) from a member. A
   * member always keeps at least one account.
   * @returns {Promise<Object>} the member
   */
  unlink (memberId, key) {
    return this._serial(async () => {
      const member = await this._resolve(memberId);
      if (!member) throw fail(404, 'Member not found');
      const parsed = parseAccountKey(key);
      const account = parsed && member.accounts.find((held) => held.key === parsed.key);
      if (!account) throw fail(404, 'That account is not linked.');
      const keys = member.accounts
        .filter((held) => held.key === account.key || (held.via === 'cluster' && held.from === account.id))
        .map((held) => held.key);
      if (keys.length >= member.accounts.length) throw fail(409, 'You cannot unlink your only account.');
      return this._detach(member, keys);
    });
  }

  /**
   * Rename a member to one of `nameChoices(member)`.
   * @param {string} memberId
   * @param {string} name
   * @returns {Promise<Object>} the member
   */
  setDisplayName (memberId, name) {
    return this._serial(async () => {
      const member = await this._resolve(memberId);
      if (!member) throw fail(404, 'Member not found');
      const clean = typeof name === 'string' ? name.trim() : '';
      const choice = nameChoices(member).find((option) => option.name === clean);
      if (!choice) throw fail(400, 'Pick a name from your linked RSI or Discord accounts.');
      if (member.displayName === choice.name) return member;
      member.log.push({ type: 'rename', from: member.displayName || null, to: choice.name, platform: choice.platform, at: new Date().toISOString() });
      member.displayName = choice.name;
      return this._save(member);
    });
  }

  /**
   * Keep the Market escrow key a Passport assertion disclosed on the
   * `fabric:` account that signed it (core checked its proof).
   * @param {string} memberId
   * @param {string} key the signing identity's account key
   * @param {{ pubkey: string, network: string }} cosigner
   * @returns {Promise<Object>} the member
   */
  setEscrowKey (memberId, key, cosigner) {
    return this._serial(async () => {
      const member = await this._resolve(memberId);
      if (!member) throw fail(404, 'Member not found');
      const account = member.accounts.find((held) => held.key === key);
      if (!account) throw fail(404, 'That Fabric identity is not linked to you');
      const pubkey = String(cosigner.pubkey || '').toLowerCase();
      if (!/^0[23][0-9a-f]{64}$/.test(pubkey) || !cosigner.network) throw fail(400, 'Invalid escrow key');
      if (account.cosigner && account.cosigner.pubkey === pubkey && account.cosigner.network === cosigner.network) return member;
      const at = new Date().toISOString();
      account.cosigner = { pubkey, network: cosigner.network, linkedAt: at };
      member.log.push({ type: 'escrow-key', account: key, network: cosigner.network, at });
      return this._save(member);
    });
  }

  _refresh (memberId, fields = {}) {
    return this._serial(async () => {
      const member = await this._resolve(memberId);
      if (!member) return null;
      if (fields.login) member.lastLoginAt = new Date().toISOString();
      if (typeof fields.inGuild === 'boolean') member.inGuild = fields.inGuild;
      if (!member.avatarUrl && fields.avatarUrl) member.avatarUrl = fields.avatarUrl;
      if (!member.displayName && fields.displayName) member.displayName = fields.displayName;
      return this._save(member);
    });
  }

  // The member's review as stored, or approved for members from before
  // reviews began; null when they have never been queued.
  _reviewRecord (member) {
    if (!member) return null;
    if (member.review && REVIEW_RANK[member.review.status]) return member.review;
    if (this._reviewSince && Date.parse(member.createdAt) < Date.parse(this._reviewSince)) {
      return { status: 'approved', grandfathered: true };
    }
    return null;
  }

  /**
   * Where a member stands in the waiting area: `{ status: 'pending' |
   * 'approved' | 'denied', requestedAt, reviewedAt, … }`, or null when
   * reviews are off or they have not signed in with Discord since reviews
   * began.
   * @param {Object|null} member
   * @returns {Object|null}
   */
  reviewOf (member) {
    return this.reviewsEnabled ? this._reviewRecord(member) : null;
  }

  /**
   * Whether this member's Discord sign-in has to be approved. Unset means
   * every sign-in waits, which is what the tests use.
   * @param {Object|null} member
   * @returns {boolean}
   */
  needsReview (member) {
    if (typeof this.settings.needsReview !== 'function') return true;
    return this.settings.needsReview(member) === true;
  }

  /**
   * Approve someone who is not an officer, including a denial from when every
   * sign-in waited. Officers, and anyone already approved, are left as they are.
   * @param {Object} member
   * @returns {Promise<Object>}
   */
  async _autoApprove (member) {
    if (!member || this.needsReview(member)) return member;
    const review = member.review;
    if (review && review.status === 'approved') return member;
    if (!review && this._reviewSince && Date.parse(member.createdAt) < Date.parse(this._reviewSince)) return member;
    const at = new Date().toISOString();
    member.review = {
      status: 'approved',
      requestedAt: (review && review.requestedAt) || at,
      reviewedAt: at,
      auto: true
    };
    member.log = member.log || [];
    member.log.push({ type: 'review', status: 'approved', auto: true, at });
    await this._save(member);
    await this._indexPending(member.id, null);
    return member;
  }

  _reviewView (member) {
    const review = this.reviewOf(member);
    if (!review) return null;
    return compact({ status: review.status, requestedAt: review.requestedAt, reviewedAt: review.reviewedAt });
  }

  _view (member, via) {
    const admin = via !== 'rsi-link' && typeof this.settings.isAdmin === 'function' && this.settings.isAdmin(member) === true;
    return publicMember(member, via, this.reviewsEnabled ? this._reviewView(member) : undefined, admin);
  }

  async _migratePending () {
    if (this._pendingMigrated) return;
    this._pendingMigrated = true;
    const blob = await this._read(REVIEW_PENDING_KEY);
    if (!blob || typeof blob !== 'object' || Array.isArray(blob)) return;
    const legacy = Object.entries(blob).filter(([id, value]) => MEMBER_ID_RE.test(id) && typeof value === 'string');
    if (!legacy.length) return;
    for (const [id, at] of legacy) await this.store.set(`${REVIEW_PENDING_KEY}/${id}`, { at });
    await this.store.set(REVIEW_PENDING_KEY, { migrated: true });
  }

  async _pendingEntries () {
    await this._migratePending();
    const entries = new Map();
    const take = (id, at) => {
      if (MEMBER_ID_RE.test(id) && typeof at === 'string') entries.set(id, at);
    };
    const memory = this.store._state && this.store._state.content && this.store._state.content.reviews
      && this.store._state.content.reviews.pending;
    if (memory && typeof memory === 'object' && !Array.isArray(memory)) {
      for (const [id, value] of Object.entries(memory)) {
        if (value && typeof value === 'object') take(id, value.at);
        else take(id, value);
      }
    }
    if (this.store.db && typeof this.store.db.keys === 'function') {
      try {
        for await (const key of this.store.db.keys({ gte: `${REVIEW_PENDING_KEY}/`, lt: `${REVIEW_PENDING_KEY}0` })) {
          const id = String(key).slice(REVIEW_PENDING_KEY.length + 1);
          const value = await this.store.get(key);
          if (value && typeof value.at === 'string') take(id, value.at);
        }
      } catch (_) { /* the in-memory copy still answers */ }
    }
    return entries;
  }

  async _indexPending (memberId, requestedAt) {
    const key = `${REVIEW_PENDING_KEY}/${memberId}`;
    if (requestedAt) {
      await this.store.set(key, { at: requestedAt });
      return;
    }
    const current = await this.store.get(key);
    if (current) await this._drop(key);
    const blob = await this._read(REVIEW_PENDING_KEY);
    if (!blob || typeof blob !== 'object' || Array.isArray(blob) || typeof blob[memberId] !== 'string') return;
    const next = {};
    for (const [id, value] of Object.entries(blob)) {
      if (id !== memberId && MEMBER_ID_RE.test(id) && typeof value === 'string') next[id] = value;
    }
    await this.store.set(REVIEW_PENDING_KEY, Object.keys(next).length ? next : { migrated: true });
  }

  /**
   * Put an officer in the waiting area, unless they already have a review
   * (or reviews are off). Anyone else is approved, so they can claim an RSI
   * handle. Emits `review { member }` when an officer joins the queue.
   * @param {string} memberId
   * @returns {Promise<Object|null>} the member
   */
  requestReview (memberId) {
    if (!this.reviewsEnabled) return Promise.resolve(null);
    return this._serial(async () => {
      let member = await this._resolve(memberId);
      if (!member) return null;
      member = await this._autoApprove(member);
      if (!this.needsReview(member) || this.reviewOf(member)) return member;
      const at = new Date().toISOString();
      member.review = { status: 'pending', requestedAt: at };
      member.log.push({ type: 'review', status: 'pending', at });
      await this._save(member);
      await this._indexPending(member.id, at);
      this.emit('review', { member: member.id });
      return member;
    });
  }

  /**
   * Officers in the waiting area, longest waiting first. A pending member
   * who is not an officer is approved here, one record at a time, so deciding
   * one officer cannot rewrite the rest of the queue.
   * @returns {Promise<Object[]>}
   */
  pendingReviews () {
    if (!this.reviewsEnabled) return Promise.resolve([]);
    return this._serial(async () => {
      const entries = await this._pendingEntries();
      const out = [];
      for (const id of entries.keys()) {
        let member = await this._resolve(id);
        if (!member || member.id !== id) {
          await this._indexPending(id, null);
          continue;
        }
        member = await this._autoApprove(member);
        const review = this.reviewOf(member);
        if (review && review.status === 'pending') out.push(member);
        else await this._indexPending(id, null);
      }
      return out.sort((a, b) => String(a.review.requestedAt).localeCompare(String(b.review.requestedAt)));
    });
  }

  /**
   * Approve or deny a member who is waiting. A member someone already
   * reviewed is left as they are (`changed: false`). Emits
   * `reviewed { member, status }`.
   * @param {string} memberId
   * @param {'approved'|'denied'} status
   * @param {Object} [opts]
   * @param {string} [opts.by] Reviewer's account key, kept in the member's log.
   * @returns {Promise<{ member: Object, changed: boolean, status: string|null }>}
   */
  decideReview (memberId, status, opts = {}) {
    if (!REVIEW_DECISIONS.includes(status)) return Promise.reject(new Error('A review is approved or denied'));
    return this._serial(async () => {
      const member = await this._resolve(memberId);
      if (!member) throw fail(404, 'Member not found');
      const review = this.reviewOf(member);
      if (!review || review.status !== 'pending') return { member, changed: false, status: review ? review.status : null };
      const at = new Date().toISOString();
      member.review = compact({ status, requestedAt: review.requestedAt, notifiedAt: review.notifiedAt, reviewedAt: at, reviewedBy: opts.by });
      member.log.push(compact({ type: 'review', status, by: opts.by, at }));
      await this._save(member);
      await this._indexPending(member.id, null);
      this.emit('reviewed', { member: member.id, status });
      return { member, changed: true, status };
    });
  }

  /**
   * Note that reviewers have been sent these waiting members.
   * @param {string[]} memberIds
   * @returns {Promise<void>}
   */
  noteReviewsSent (memberIds) {
    return this._serial(async () => {
      const at = new Date().toISOString();
      for (const id of memberIds) {
        const member = await this._resolve(id);
        if (!member || !member.review || member.review.status !== 'pending' || member.review.notifiedAt) continue;
        member.review.notifiedAt = at;
        await this._save(member);
      }
    });
  }

  _sessionTtl (via) {
    return via === 'rsi-link' ? Math.min(CLAIM_LINK_SESSION_TTL_MS, this.settings.sessionTtlMs) : this.settings.sessionTtlMs;
  }

  async _createSession (memberId, via) {
    const token = randomToken();
    const now = Date.now();
    await this.store.set(`/sessions/${sha256(token)}`, {
      memberId,
      via: via || null,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + this._sessionTtl(via)
    });
    return token;
  }

  /**
   * Passport peer sign-in (v3) by goon.vc's relay key (`settings.peerKey`),
   * as the Hub does it (`@fabric/hub` `mountHubPassportPeer`): the HTTP server
   * attaches this peer (`attachPassportPeer`), serves `/sessions/peer`, and
   * sets `req.passportSession` on requests signed by the session key; here a
   * sign-in becomes a member. Null until the key exists, or with an
   * `@fabric/http` that has no `passportPeer`.
   * @returns {object|null}
   */
  passportPeer () {
    if (!passportPeer || typeof this.settings.peerKey !== 'function') return null;
    const key = this.settings.peerKey();
    if (!key || !key.private) return null;
    if (this._peerSignIn && this._peerSignIn.pubkey === key.pubkey) return this._peerSignIn.peer;
    const homes = [].concat(this.settings.origins || [], this.settings.siteUrl ? [this.settings.siteUrl] : [])
      .map((o) => { try { return new URL(o).origin; } catch (_) { return null; } })
      .filter(Boolean)
      .slice(0, 16);
    const peer = passportPeer.createPassportPeer({
      key,
      purpose: PASSPORT_PURPOSE,
      homes,
      sessionTtlMs: this.settings.sessionTtlMs,
      onSession: async (verified) => {
        // The same member a Passport sign-in on the site makes or finds.
        const parsed = accountKey('fabric', verified.identity.pubkey);
        if (!parsed) throw new Error('Signed sign-in has no identity');
        const legacy = [verified.identity.id, verified.identity.pubkey].map((id) => `fabric:${id}`);
        let member = await this.memberFor(parsed.key, { create: true, via: 'passport', profile: { pubkeyHex: verified.identity.pubkey }, legacy });
        member = await this._refresh(member.id, { login: true });
        this.emit('log', 'MEMBERS', `Passport peer sign-in for ${parsed.id.slice(0, 12)}… signed by ${verified.signer}`);
        return { memberId: member.id };
      }
    });
    this._peerSignIn = { pubkey: key.pubkey, peer };
    return peer;
  }

  async _sessionFromRequest (req) {
    const token = parseCookies(req.headers && req.headers.cookie)[this.settings.cookieName];
    if (!token) return null;
    const key = `/sessions/${sha256(token)}`;
    const session = await this.store.get(key);
    if (!session || session.revokedAt || !(session.expiresAt > Date.now())) return null;
    return { key, session };
  }

  /**
   * The signed-in member for a request, following merges and legacy ids.
   * @returns {Promise<{ member: Object, via: string|null, key: string, session: Object }|null>}
   */
  async currentMember (req) {
    // A peer session (checked by the HTTP server), else the cookie.
    const peerSession = req && req.passportSession;
    if (peerSession) {
    const member = peerSession.memberId ? await this.resolve(peerSession.memberId) : null;
    if (!member) return null;
    const released = await this._serial(async () => this._autoApprove(await this._resolve(member.id) || member));
    return { member: released, via: 'passport', key: null, session: peerSession };
    }
    if (req && req.headers && req.headers['x-fabric-request']) return null;
    const current = await this._sessionFromRequest(req);
    if (!current) return null;
    const member = await this.resolve(current.session.memberId);
    if (!member) return null;
    const released = await this._serial(async () => this._autoApprove(await this._resolve(member.id) || member));
    return { member: released, via: current.session.via || null, key: current.key, session: current.session };
  }

  /**
   * In production an https site always marks its cookies Secure, so a proxy that
   * drops `X-Forwarded-Proto` cannot send them in the clear.
   * @private
   */
  _secureCookies (req) {
    if (requestProto(req) === 'https') return true;
    return process.env.NODE_ENV === 'production' && /^https:\/\//i.test(String(this.settings.siteUrl || ''));
  }

  _setSessionCookie (req, res, token, via) {
    const parts = [
      `${this.settings.cookieName}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this._sessionTtl(via) / 1000)}`
    ];
    if (this._secureCookies(req)) parts.push('Secure');
    addCookie(res, parts.join('; '));
  }

  _clearSessionCookie (res) {
    res.setHeader('Set-Cookie', `${this.settings.cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  _discordRedirectUri (req) {
    if (this.discord.redirectUri) return this.discord.redirectUri;
    return `${requestProto(req)}://${req.headers.host}${BASE}/discord/callback`;
  }

  _loginResult (query) {
    return `${this.settings.loginPath}?${new URLSearchParams(query).toString()}`;
  }

  _query (req) {
    return req.query || Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
  }

  // Where a Discord login or link lands: the profile page for a link started
  // there, otherwise the login page.
  _discordResult (pending, memberId, query) {
    const search = new URLSearchParams(query).toString();
    if (pending && pending.returnTo === 'profile' && memberId) return `${this.profilePath(memberId)}?${search}`;
    return this._loginResult(query);
  }

  async _discordStart (req, res) {
    if (!this.discordEnabled) return sendJson(res, 503, { error: 'Discord login is not configured' });
    const query = this._query(req);
    let linkTo = null;
    const returnTo = query.link && query.next === 'profile' ? 'profile' : null;
    if (query.link) {
      const current = await this.currentMember(req);
      if (!current) return redirect(res, this._loginResult({ error: 'not_signed_in' }));
      if (current.via === 'rsi-link') {
        return redirect(res, this._discordResult({ returnTo }, current.member.id, { error: 'one_time_link' }));
      }
      linkTo = current.member.id;
      if (discordAccounts(current.member).length) {
        return redirect(res, this._discordResult({ returnTo }, linkTo, { error: 'one_discord' }));
      }
    }
    const clientId = await this._discordClientId();
    if (!clientId) return redirect(res, this._discordResult({ returnTo }, linkTo, { error: 'discord_unavailable' }));
    if (!this._loginStartAllowed(req)) return sendJson(res, 429, { error: 'Too many sign-ins started. Wait a minute, then try again.' });
    const state = randomToken();
    const redirectUri = this._discordRedirectUri(req);
    await this.store.set(`/oauth/${state}`, Object.assign({
      redirectUri,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS
    }, linkTo ? { linkTo } : {}, returnTo ? { returnTo } : {}));
    const url = new URL(DISCORD_AUTHORIZE);
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    const cookie = [
      `${OAUTH_STATE_COOKIE}=${state}`,
      `Path=${BASE}/discord`,
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(OAUTH_STATE_TTL_MS / 1000)}`
    ];
    if (this._secureCookies(req)) cookie.push('Secure');
    res.setHeader('Set-Cookie', cookie.join('; '));
    return redirect(res, url.toString());
  }

  async _discordCallback (req, res) {
    const query = this._query(req);
    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    // The state must come back to the browser that started the login.
    const ours = /^[0-9a-f]{64}$/.test(state) && parseCookies(req.headers && req.headers.cookie)[OAUTH_STATE_COOKIE] === state;
    const pending = ours ? await this.store.get(`/oauth/${state}`) : null;
    const done = (result, memberId) => redirect(res, this._discordResult(pending, memberId || (pending && pending.linkTo), result));
    if (query.error) return done({ error: String(query.error) });
    if (!/^[0-9a-f]{64}$/.test(state) || !code) return done({ error: 'invalid_request' });
    if (!ours || !pending || pending.usedAt || !(pending.expiresAt > Date.now())) return done({ error: 'expired_state' });
    await this._drop(`${OAUTH_PREFIX}${state}`);

    let user;
    let inGuild = false;
    try {
      const clientId = await this._discordClientId();
      if (!clientId) throw new Error('no client id');
      const tokenRes = await this._fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: this.discord.clientSecret,
          grant_type: 'authorization_code',
          code,
          redirect_uri: pending.redirectUri
        }).toString()
      });
      const grant = await tokenRes.json();
      if (!tokenRes.ok || !grant.access_token) throw new Error('token exchange failed');

      const auth = { Authorization: `Bearer ${grant.access_token}`, Accept: 'application/json' };
      const userRes = await this._fetch(`${DISCORD_API}/users/@me`, { headers: auth });
      user = await userRes.json();
      if (!userRes.ok || !user || !accountKey('discord', user.id)) throw new Error('user lookup failed');

      if (this.discord.guildId) {
        const guildsRes = await this._fetch(`${DISCORD_API}/users/@me/guilds`, { headers: auth });
        const guilds = guildsRes.ok ? await guildsRes.json() : [];
        inGuild = Array.isArray(guilds) && guilds.some((g) => g && g.id === this.discord.guildId);
      }
    } catch (_) {
      return done({ error: 'discord_failed' });
    }

    const key = accountKey('discord', user.id).key;
    const profile = { username: user.username || null, globalName: user.global_name || null };
    const avatarUrl = user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null;

    if (pending.linkTo) {
      const current = await this.currentMember(req);
      const target = await this.resolve(pending.linkTo);
      if (!current || !target || current.member.id !== target.id) {
        return redirect(res, this._loginResult({ error: 'link_failed' }));
      }
      let linked;
      try {
        linked = await this.link(current.member.id, key, { via: 'oauth', profile });
      } catch (error) {
        if (error.status !== 409) throw error;
        return done({ error: error.code || 'link_failed' }, current.member.id);
      }
      const { member, merged } = linked;
      await this._refresh(member.id, Object.assign({ avatarUrl }, inGuild ? { inGuild } : {}));
      await this.requestReview(member.id);
      return done(Object.assign({ linked: 'discord' }, merged ? { merged: '1' } : {}), member.id);
    }

    const member = await this.memberFor(key, {
      create: true,
      via: 'oauth',
      profile,
      displayName: user.global_name || user.username,
      avatarUrl,
      inGuild
    });
    await this._refresh(member.id, { login: true, inGuild, avatarUrl });
    const review = this.reviewOf(await this.requestReview(member.id));
    this._setSessionCookie(req, res, await this._createSession(member.id, 'discord'));
    if (review && review.status !== 'approved') {
      return redirect(res, `${this.settings.waitingPath}?${new URLSearchParams({ signedIn: 'discord' }).toString()}`);
    }
    return redirect(res, this._loginResult({ signedIn: 'discord' }));
  }

  // Store#del only drops the key on disk; the tombstone keeps the in-memory
  // copy from answering for it until the next restart.
  async _drop (key) {
    await this.store.set(key, { droppedAt: Date.now() });
    await this.store.del(key);
  }

  async _sweepExpired () {
    const now = Date.now();
    for (const prefix of [PASSPORT_PREFIX, OAUTH_PREFIX]) {
      try {
        for await (const key of this.store.db.keys({ gte: prefix, lt: prefix.slice(0, -1) + '0' })) {
          const record = await this.store.get(key);
          if (!record || !(record.expiresAt > now)) await this._drop(key);
        }
      } catch (error) {
        this.emit('log', 'MEMBERS', `could not sweep ${prefix}: ${error.message}`);
      }
    }
    if (this._loginStarts) {
      const windowMs = this.settings.loginStarts.windowMs;
      for (const [address, times] of this._loginStarts) {
        if (!times.length || now - times[times.length - 1] >= windowMs) this._loginStarts.delete(address);
      }
    }
  }

  _loginStartAllowed (req) {
    const { limit, windowMs } = this.settings.loginStarts;
    if (!this._loginStarts) this._loginStarts = new Map();
    const now = Date.now();
    const address = clientKey(req);
    const times = (this._loginStarts.get(address) || []).filter((at) => now - at < windowMs);
    if (times.length >= limit) {
      this._loginStarts.set(address, times);
      return false;
    }
    times.push(now);
    this._loginStarts.delete(address);
    this._loginStarts.set(address, times);
    if (this._loginStarts.size > LOGIN_STARTS_TRACKED) this._loginStarts.delete(this._loginStarts.keys().next().value);
    return true;
  }

  // Challenges are issued only for pinned origins and kept in the Store until
  // redeemed. Taking one runs on the member queue, so two claims racing for
  // the same challenge can't both get it.
  _createPassport (network = null) {
    const production = this.settings.production != null
      ? !!this.settings.production
      : process.env.NODE_ENV === 'production';
    let pinnedOrigins = [].concat(this.settings.origins || []).filter(Boolean);
    if (!pinnedOrigins.length && this.settings.siteUrl) {
      let site = null;
      try { site = new URL(this.settings.siteUrl).origin; } catch (_) {}
      if (site && (production || isLoopbackOrigin(site))) pinnedOrigins = [site];
    }
    const challengeStore = {
      put: (key, record) => this.store.set(`${PASSPORT_PREFIX}${key}`, record),
      take: (key) => this._serial(async () => {
        if (!/^[0-9a-f]{64}$/.test(key)) return null;
        const record = await this._read(`${PASSPORT_PREFIX}${key}`);
        if (!record || !record.nonce) return null;
        await this._drop(`${PASSPORT_PREFIX}${key}`);
        return record.expiresAt > Date.now() ? record : null;
      })
    };
    // Every relying party shares these records: each carries its own network
    // and requested disclosures, so any of them redeems it.
    try {
      return passportRp.createPassportRelyingParty({
        pinnedOrigins,
        production,
        network,
        purpose: network ? PASSPORT_ESCROW_PURPOSE : PASSPORT_PURPOSE,
        challengeTtlMs: PASSPORT_REQUEST_TTL_MS,
        challengeStore
      });
    } catch (error) {
      // Production without a pinned origin: Passport stays off.
      return null;
    }
  }

  // The pinned origin this request came in on, or null. A Passport signs for
  // the origin its browser shows, so a challenge for any other could never be
  // redeemed here.
  _siteOrigin (req) {
    if (!this.passport || !req.headers || !req.headers.host) return null;
    return this.passport.resolveOrigin(`${requestProto(req)}://${req.headers.host}`);
  }

  _setPassportCookie (req, res, value, maxAgeMs) {
    const parts = [
      `${PASSPORT_COOKIE}=${value}`,
      `Path=${BASE}/passport`,
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.floor(maxAgeMs / 1000)}`
    ];
    if (this._secureCookies(req)) parts.push('Secure');
    addCookie(res, parts.join('; '));
  }

  // The cookie holds the challenge's binding secret, never its nonce, so
  // only the browser that asked can redeem the answer.
  // The relying party for escrow key links on one network: asks for the
  // cosigner disclosure.
  _escrowPassport (network) {
    if (!this._escrowPassports || this._escrowBase !== this.passport) {
      this._escrowBase = this.passport;
      this._escrowPassports = new Map();
    }
    if (!this._escrowPassports.has(network)) this._escrowPassports.set(network, this._createPassport(network));
    return this._escrowPassports.get(network);
  }

  async _passportChallenge (req, res) {
    if (!this.passport) return sendJson(res, 503, { error: 'Passport login is not available' });
    const origin = this._siteOrigin(req);
    if (!origin) return sendJson(res, 400, { error: 'Passport sign-in is not offered on this address' });
    if (!this._loginStartAllowed(req)) return sendJson(res, 429, { error: 'Too many sign-ins started. Wait a minute, then try again.' });
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    let rp = this.passport;
    let request = [];
    if (body.escrow === true) {
      const current = await this.currentMember(req);
      if (!current) return sendJson(res, 401, { error: 'Sign in first to link your escrow key' });
      if (current.via === 'rsi-link') return sendJson(res, 403, { error: 'You signed in with a one-time link. Sign in with Discord or Passport first, then link your escrow key.' });
      if (typeof this.settings.escrowNetwork !== 'function') return sendJson(res, 503, { error: 'Escrow is not available' });
      let network;
      try {
        network = String(await this.settings.escrowNetwork() || '').toLowerCase();
      } catch (error) {
        return sendJson(res, error.status || 503, { error: error.message || 'Escrow is not available' });
      }
      rp = network ? this._escrowPassport(network) : null;
      if (!rp) return sendJson(res, 503, { error: 'Escrow is not available' });
      request = ['cosigner'];
    }
    const issued = await rp.issueChallenge({ origin, request });
    this._setPassportCookie(req, res, issued.bindingSecret, PASSPORT_REQUEST_TTL_MS);
    return sendJson(res, 200, { ok: true, challenge: issued.challenge, expiresAt: issued.expiresAt });
  }

  async _passportClaim (req, res) {
    if (!this.passport) return sendJson(res, 503, { error: 'Passport login is not available' });
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    if (passportHttp.passportOutdated(body.assertion || body.fabric, 'PASSPORT_ASSERTION')) {
      return sendJson(res, 426, passportHttp.PASSPORT_OUTDATED);
    }
    const assertion = typeof body.assertion === 'string' ? body.assertion.trim() : '';
    if (!/^fabric:/i.test(assertion) || assertion.length > 48 * 1024) return sendJson(res, 400, { error: 'A signed Passport assertion is required' });
    const secret = parseCookies(req.headers && req.headers.cookie)[PASSPORT_COOKIE] || '';
    this._setPassportCookie(req, res, '', 0);
    if (!/^[0-9a-f]{64}$/.test(secret)) return sendJson(res, 401, { error: 'Start Passport sign-in again' });
    const origin = this._siteOrigin(req);
    const verified = await this.passport.redeem(secret, assertion);
    if (!verified.ok) return sendJson(res, 401, { error: `Passport sign-in rejected: ${verified.error}` });
    if (!origin || origin !== verified.origin) return sendJson(res, 401, { error: 'Sign-in was started on another address' });
    // The page posting the claim must be that origin too, not a sibling host that planted the cookie.
    const pageOrigin = req.headers && typeof req.headers.origin === 'string' ? this.passport.resolveOrigin(req.headers.origin) : null;
    if (pageOrigin !== verified.origin) return sendJson(res, 403, { error: 'Sign-in must be finished on the page that started it' });

    const current = body.link === true ? await this.currentMember(req) : null;
    if (body.link === true && !current) return sendJson(res, 401, { error: 'Sign in first to link a Fabric identity' });
    if (current && current.via === 'rsi-link') {
      return sendJson(res, 403, { error: 'You signed in with a one-time link. Sign in with Discord or Passport first, then link another account.' });
    }
    if (verified.cosigner && !current) return sendJson(res, 401, { error: 'Sign in first to link your escrow key' });
    const identity = verified.identity;
    const parsed = accountKey('fabric', identity.pubkey);
    if (!parsed) return sendJson(res, 401, { error: 'Signed sign-in has no identity' });
    this.emit('log', 'MEMBERS', `Passport sign-in for ${parsed.id.slice(0, 12)}… signed by ${verified.signer}`);
    const legacy = [identity.id, identity.pubkey].map((id) => `fabric:${id}`);
    const profile = { pubkeyHex: identity.pubkey };

    let member;
    let merged = false;
    let via;
    if (current) {
      ({ member, merged } = await this.link(current.member.id, parsed.key, { via: 'passport', profile, legacy }));
      via = current.via;
      if (verified.cosigner) {
        member = await this.setEscrowKey(member.id, parsed.key, { pubkey: verified.cosigner.pubkey, network: verified.network });
      }
    } else {
      member = await this.memberFor(parsed.key, { create: true, via: 'passport', profile, legacy });
      member = await this._refresh(member.id, { login: true });
      via = 'passport';
      this._setSessionCookie(req, res, await this._createSession(member.id, via));
    }
    return sendJson(res, 200, Object.assign({ ok: true, member: this._view(member, via), merged },
      current ? { linked: 'fabric' } : {},
      verified.cosigner ? { escrowKey: { network: verified.network } } : {}));
  }

  async _currentSession (req, res) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { ok: true, member: this._view(current.member, current.via) });
  }

  async _accounts (req, res) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { ok: true, accounts: current.member.accounts.map(accountView) });
  }

  async _unlink (req, res, key) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    if (current.via === 'rsi-link') return sendJson(res, 403, { error: 'You signed in with a one-time link. Sign in with Discord or Passport first, then unlink an account.' });
    try {
      const member = await this.unlink(current.member.id, key);
      return sendJson(res, 200, { ok: true, accounts: member.accounts.map(accountView) });
    } catch (error) {
      if (!error.status) throw error;
      return sendJson(res, error.status, { error: error.message });
    }
  }

  /**
   * A member's profile page path.
   * @param {string} memberId
   * @returns {string}
   */
  profilePath (memberId) {
    return `${String(this.settings.membersPath).replace(/\/+$/, '')}/${memberId}`;
  }

  _directoryEntry (member) {
    return {
      id: member.id,
      path: this.profilePath(member.id),
      displayName: member.displayName || null,
      avatarUrl: member.avatarUrl || null,
      platforms: Array.from(new Set((member.accounts || []).map((account) => account.platform))),
      createdAt: member.createdAt
    };
  }

  _profileView (member, self) {
    return Object.assign(this._directoryEntry(member), {
      self,
      inGuild: member.inGuild === true,
      lastLoginAt: member.lastLoginAt || null,
      accounts: (member.accounts || []).map((account) => profileAccountView(account, self)),
      rsiHandles: Members.rsiHandles(member)
    }, self ? { nameChoices: nameChoices(member) } : {}, self && this.reviewsEnabled ? { review: this._reviewView(member) } : {});
  }

  // The directory is not open yet: it lists only the signed-in member.
  async _directory (req, res) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { ok: true, directory: false, members: [this._directoryEntry(current.member)] });
  }

  // Until the directory opens, members see only their own profile; any other
  // id is a 404, so a profile URL doesn't reveal whether that member exists.
  async _profile (req, res, id) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    const member = MEMBER_ID_RE.test(id) ? await this.resolve(id) : null;
    if (!member || member.id !== current.member.id) return sendJson(res, 404, { error: 'Member profiles are private for now.' });
    return sendJson(res, 200, { ok: true, member: this._profileView(member, true) });
  }

  // Members edit only their own profile; any other id is a 404, as for reads.
  async _editProfile (req, res, id) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    const member = MEMBER_ID_RE.test(id) ? await this.resolve(id) : null;
    if (!member || member.id !== current.member.id) return sendJson(res, 404, { error: 'Member profiles are private for now.' });
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    if (!Object.prototype.hasOwnProperty.call(body, 'displayName')) return sendJson(res, 400, { error: 'Nothing to change.' });
    const renamed = await this.setDisplayName(member.id, body.displayName);
    return sendJson(res, 200, { ok: true, member: this._profileView(renamed, true) });
  }

  /**
   * Link-preview metadata for a profile URL. The same for every id: profiles
   * are private, so a preview names no one.
   * @param {string} pathname
   * @returns {Promise<{ path: string, title: string, description: string }|null>}
   */
  async page (pathname) {
    const base = String(this.settings.membersPath).replace(/\/+$/, '').toLowerCase();
    const clean = String(pathname || '').replace(/\/+$/, '');
    if (clean.toLowerCase().indexOf(base + '/') !== 0) return null;
    if (!MEMBER_ID_RE.test(clean.slice(base.length + 1))) return null;
    return { path: clean, title: 'Member profile', description: 'A G00N SQUAD member profile. Sign in to see your own.' };
  }

  async _logout (req, res) {
    const current = await this._sessionFromRequest(req);
    if (current) {
      await this.store.set(current.key, Object.assign({}, current.session, { revokedAt: Date.now() }));
    }
    this._clearSessionCookie(res);
    return sendJson(res, 200, { ok: true });
  }

  /**
   * RSI handles a member has claimed, as RSI shows them.
   * @param {Object|null} member
   * @returns {string[]}
   */
  static rsiHandles (member) {
    return ((member && member.accounts) || []).filter((account) => account.platform === 'rsi').map((account) => account.id);
  }

  /**
   * A one-time link that signs its holder in as this member and opens the
   * RSI claim page. Only send it privately (an ephemeral Discord reply): it
   * is a login. Single use, `CLAIM_LINK_TTL_MS`.
   * @param {string} memberId
   * @returns {Promise<{ url: string, expiresAt: number }>}
   */
  async claimLink (memberId) {
    const member = await this.resolve(memberId);
    if (!member) throw fail(404, 'Member not found');
    const token = randomToken();
    const expiresAt = Date.now() + CLAIM_LINK_TTL_MS;
    await this.store.set(`/claim-links/${sha256(token)}`, { memberId: member.id, expiresAt, createdAt: new Date().toISOString() });
    const origin = String(this.settings.siteUrl || '').replace(/\/+$/, '');
    return { url: `${origin}${CLAIM_LINK_PATH}?t=${token}`, expiresAt };
  }

  _claimResult (query) {
    const qs = new URLSearchParams(query || {}).toString();
    return `${this.settings.claimPath || '/rsi'}${qs ? `?${qs}` : ''}`;
  }

  async _redeemClaimLink (req, res) {
    const token = String(this._query(req).t || '');
    if (!/^[0-9a-f]{64}$/.test(token)) return redirect(res, this._claimResult({ error: 'link' }));
    const key = `/claim-links/${sha256(token)}`;
    // Read and drop in one turn, so two redemptions of one link cannot both read it.
    const link = await this._serial(async () => {
      const found = await this._read(key);
      if (found) await this._drop(key);
      return found;
    });
    if (!link || !(link.expiresAt > Date.now())) return redirect(res, this._claimResult({ error: 'link' }));
    const member = await this.resolve(link.memberId);
    if (!member) return redirect(res, this._claimResult({ error: 'link' }));
    await this._refresh(member.id, { login: true });
    this._setSessionCookie(req, res, await this._createSession(member.id, 'rsi-link'), 'rsi-link');
    return redirect(res, this._claimResult());
  }

  async _pendingClaim (memberId) {
    const claim = await this.store.get(`/rsi-claims/${memberId}`);
    return claim && claim.expiresAt > Date.now() ? claim : null;
  }

  async _rsiStatus (req, res) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    const pending = await this._pendingClaim(current.member.id);
    return sendJson(res, 200, {
      ok: true,
      member: this._view(current.member, current.via),
      handles: Members.rsiHandles(current.member),
      pending: pending ? { handle: pending.handle, code: pending.code, url: rsiCitizen.citizenUrl(pending.handle), expiresAt: pending.expiresAt } : null
    });
  }

  async _startClaim (req, res) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const handle = rsiCitizen.sanitizeHandle(body.handle);
    if (!handle) return sendJson(res, 400, { error: 'Enter your RSI handle (letters, numbers, - and _).' });
    const prior = await this._pendingClaim(current.member.id);
    const code = prior && prior.handle.toLowerCase() === handle.toLowerCase() ? prior.code : rsiClaim.claimCode();
    const pending = { handle, code, createdAt: new Date().toISOString(), expiresAt: Date.now() + RSI_CLAIM_TTL_MS };
    await this.store.set(`/rsi-claims/${current.member.id}`, pending);
    return sendJson(res, 200, { ok: true, pending: { handle, code, url: rsiCitizen.citizenUrl(handle), expiresAt: pending.expiresAt } });
  }

  _verifyAllowed (memberId) {
    if (!this._verifyTries) this._verifyTries = new Map();
    const now = Date.now();
    const tries = (this._verifyTries.get(memberId) || []).filter((at) => now - at < RSI_VERIFY_WINDOW_MS);
    if (tries.length >= RSI_VERIFY_LIMIT) {
      this._verifyTries.set(memberId, tries);
      return false;
    }
    tries.push(now);
    this._verifyTries.set(memberId, tries);
    return true;
  }

  async _verifyClaim (req, res) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    const memberId = current.member.id;
    const pending = await this._pendingClaim(memberId);
    if (!pending) return sendJson(res, 409, { error: 'Start a claim first: enter your RSI handle to get a code.' });
    if (!this._verifyAllowed(memberId)) return sendJson(res, 429, { error: 'Too many tries. Wait 15 minutes, then verify again.' });
    const found = await rsiCitizen.lookupCitizen(pending.handle, { fetch: this._fetch });
    if (!found.ok) return sendJson(res, found.status === 404 ? 404 : 502, { error: found.error });
    const citizen = found.citizen;
    if (citizen.handle.toLowerCase() !== pending.handle.toLowerCase()) {
      return sendJson(res, 409, { error: 'RSI returned a different citizen. Check the handle and start again.' });
    }
    if (!rsiClaim.bioHasCode(citizen.bio, pending.code)) {
      return sendJson(res, 409, { error: `${pending.code} isn’t in ${citizen.handle}’s RSI bio yet. Save your bio on RSI, then verify again.` });
    }
    const { member, merged } = await this.link(memberId, accountKey('rsi', citizen.handle).key, {
      via: 'bio',
      profile: {
        displayName: citizen.displayName,
        citizenRecord: citizen.citizenRecord,
        mainOrgSid: citizen.mainOrgSid,
        mainOrgName: citizen.mainOrgName
      }
    });
    await this._drop(`/rsi-claims/${memberId}`);
    this.emit('log', 'MEMBERS', `RSI handle ${citizen.handle} claimed by member ${member.id}`);
    this.emit('rsi', { member: member.id, handle: citizen.handle });
    return sendJson(res, 200, { ok: true, handle: citizen.handle, merged, handles: Members.rsiHandles(member) });
  }

  /**
   * Express middleware for `/services/members/*`.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      const method = String(req.method || 'GET').toUpperCase();
      if (pathname === CLAIM_LINK_PATH && method === 'GET') {
        return Promise.resolve(this._redeemClaimLink(req, res)).catch(() => {
          if (!res.headersSent) redirect(res, this._claimResult({ error: 'link' }));
        });
      }
      if (pathname !== BASE && !pathname.startsWith(BASE + '/')) return next();
      const sub = pathname.slice(BASE.length) || '/';
      const route = `${method} ${sub}`;
      let handler = null;
      let args = [];
      if (method === 'DELETE' && sub.startsWith('/accounts/')) {
        handler = this._unlink;
        try {
          args = [decodeURIComponent(sub.slice('/accounts/'.length))];
        } catch (_) {
          return sendJson(res, 400, { error: 'Bad account key' });
        }
      }
      if ((method === 'GET' || method === 'PATCH') && sub.startsWith('/profiles/')) {
        handler = method === 'GET' ? this._profile : this._editProfile;
        args = [sub.slice('/profiles/'.length).toLowerCase()];
      }
      if (!handler) {
        switch (route) {
          case 'GET /':
            return sendJson(res, 200, { discord: this.discordEnabled, passport: !!this.passport, review: this.reviewsEnabled });
          case 'GET /discord': handler = this._discordStart; break;
          case 'GET /discord/callback': handler = this._discordCallback; break;
          case 'POST /passport/challenges': handler = this._passportChallenge; break;
          case 'POST /passport': handler = this._passportClaim; break;
          case 'POST /passport/requests':
            return sendJson(res, 426, passportHttp.PASSPORT_OUTDATED);
          case 'GET /session': handler = this._currentSession; break;
          case 'GET /accounts': handler = this._accounts; break;
          case 'GET /directory': handler = this._directory; break;
          case 'POST /logout': handler = this._logout; break;
          case 'GET /rsi': handler = this._rsiStatus; break;
          case 'POST /rsi/claims': handler = this._startClaim; break;
          case 'POST /rsi/claims/verify': handler = this._verifyClaim; break;
          default:
            return sendJson(res, 404, { error: 'Not found' });
        }
      }
      Promise.resolve(handler.call(this, req, res, ...args)).catch((error) => {
        if (res.headersSent) return;
        const status = error && error.status >= 400 && error.status < 500 ? error.status : 500;
        sendJson(res, status, { error: error && error.message ? error.message : 'Member login failed' });
      });
    };
  }
}

module.exports = Members;
module.exports.parseCookies = parseCookies;
module.exports.publicMember = publicMember;
