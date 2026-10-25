'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const { createHubList, isHubList } = require('../functions/hubApiProxy');
const { accountKey, parseAccountKey, fabricPubkey } = require('../functions/accountKey');

const BASE = '/services/members';
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DEFAULT_COOKIE = 'goon.member';
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_STATE_COOKIE = 'goon.oauth';
const MEMBER_ID_RE = /^[0-9a-f]{16}$/;
const MAX_HOPS = 8;

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
 * platforms are linked and which one this session signed in with.
 */
function publicMember (member, via) {
  if (!member) return null;
  return {
    id: member.id,
    provider: via || null,
    displayName: member.displayName || null,
    avatarUrl: member.avatarUrl || null,
    inGuild: member.inGuild === true,
    platforms: Array.from(new Set((member.accounts || []).map((account) => account.platform))),
    createdAt: member.createdAt,
    lastLoginAt: member.lastLoginAt || null
  };
}

function accountView (account) {
  const profile = account.profile || {};
  let label = account.id;
  if (account.platform === 'discord') label = profile.username ? `@${profile.username}` : 'Discord account';
  else if (account.platform === 'fabric') label = `${account.id.slice(0, 8)}…${account.id.slice(-6)}`;
  return {
    key: account.key,
    platform: account.platform,
    via: account.via,
    linkedAt: account.linkedAt,
    label,
    name: profile.globalName || profile.name || null
  };
}

/**
 * goon.vc members: one permanent member (16 hex characters) per person,
 * collecting every account they have proven — Discord through OAuth or a
 * command, Fabric pubkeys through a Hub-signed Passport / desktop session
 * plus the Hub's device cluster for that key, other platforms later as
 * `platform:id`. Linking an account another member already holds merges the
 * two (the older member survives; the other id becomes an alias). Members,
 * account and alias indexes, login sessions, OAuth states, and claimed Hub
 * sessions all live in one `@fabric/core` {@link Store}.
 */
class Members extends EventEmitter {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string|string[]|Object} [settings.hubOrigin] Hub(s) that sign
   *   Passport sessions, in order, or the site's shared Hub list.
   * @param {string} [settings.loginPath] SPA page to return to after login.
   * @param {Object} [settings.discord] `{ clientId, clientSecret, redirectUri, guildId, applicationId }`;
   *   `applicationId` is `async () => string|null`, the client id used when `clientId` is unset
   *   (the application that owns the bot token).
   * @param {number} [settings.sessionTtlMs]
   * @param {string} [settings.cookieName]
   * @param {Function} [settings.fetch] Injected for tests; defaults to global fetch.
   */
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({
      path: './stores/members',
      hubOrigin: 'https://hub.fabric.pub',
      loginPath: '/sessions',
      discord: {},
      sessionTtlMs: DEFAULT_SESSION_TTL_MS,
      cookieName: DEFAULT_COOKIE
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.discord = Object.assign({}, this.settings.discord);
    this.hubs = isHubList(this.settings.hubOrigin) ? this.settings.hubOrigin : createHubList(this.settings.hubOrigin);
    this._fetch = this.settings.fetch || ((...args) => fetch(...args));
    this._queue = Promise.resolve();
    this.store = null;
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
    return this;
  }

  async stop () {
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
      member.accounts.push(Object.assign({
        key: parsed.key,
        platform: parsed.platform,
        id: parsed.id,
        via,
        linkedAt: opts.linkedAt || now,
        profile
      }, via === 'cluster' && opts.from ? { from: opts.from } : {}));
      member.log.push({ type: 'link', account: parsed.key, via, at: now });
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
    const [into, from] = Date.parse(b.createdAt) < Date.parse(a.createdAt) ? [b, a] : [a, b];
    const now = new Date().toISOString();
    for (const account of from.accounts || []) {
      if (!into.accounts.some((held) => held.key === account.key)) into.accounts.push(account);
      await this.store.set(`/accounts/${account.key}`, { member: into.id });
    }
    if (!into.displayName) into.displayName = from.displayName || null;
    if (!into.avatarUrl) into.avatarUrl = from.avatarUrl || null;
    into.inGuild = into.inGuild === true || from.inGuild === true;
    if (from.lastLoginAt && (!into.lastLoginAt || from.lastLoginAt > into.lastLoginAt)) into.lastLoginAt = from.lastLoginAt;
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

  // Fabric keys the Hub has seen cross-sign this one (its IdentityCluster)
  // are the same person: link them, and drop the ones a revoke has split off.
  async _importCluster (memberId, pubkey, origin) {
    let list = null;
    try {
      const res = await this._fetch(`${origin}/identity/cluster?pubkey=${encodeURIComponent(pubkey)}`, { headers: { Accept: 'application/json' } });
      const body = res.ok ? await res.json() : null;
      if (body && body.data && Array.isArray(body.data.members)) list = body.data.members;
    } catch (_) { /* keep the cluster as it was */ }
    if (!list) return null;
    const cluster = new Set(list.map(fabricPubkey).filter(Boolean));
    cluster.add(pubkey);
    return this._serial(async () => {
      let member = await this._resolve(memberId);
      if (!member) return null;
      let merged = false;
      for (const key of cluster) {
        if (key === pubkey) continue;
        const result = await this._link(member.id, accountKey('fabric', key), { via: 'cluster', from: pubkey });
        member = result.member;
        merged = merged || result.merged;
      }
      const split = member.accounts
        .filter((account) => account.via === 'cluster' && cluster.has(account.from) && !cluster.has(account.id))
        .map((account) => account.key);
      if (split.length) member = await this._detach(member, split, 'cluster');
      return { member, merged };
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

  async _createSession (memberId, via) {
    const token = randomToken();
    const now = Date.now();
    await this.store.set(`/sessions/${sha256(token)}`, {
      memberId,
      via: via || null,
      createdAt: new Date(now).toISOString(),
      expiresAt: now + this.settings.sessionTtlMs
    });
    return token;
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
    const current = await this._sessionFromRequest(req);
    if (!current) return null;
    const member = await this.resolve(current.session.memberId);
    if (!member) return null;
    return { member, via: current.session.via || null, key: current.key, session: current.session };
  }

  _setSessionCookie (req, res, token) {
    const parts = [
      `${this.settings.cookieName}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(this.settings.sessionTtlMs / 1000)}`
    ];
    if (requestProto(req) === 'https') parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
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

  async _discordStart (req, res) {
    if (!this.discordEnabled) return sendJson(res, 503, { error: 'Discord login is not configured' });
    let linkTo = null;
    if (this._query(req).link) {
      const current = await this.currentMember(req);
      if (!current) return redirect(res, this._loginResult({ error: 'not_signed_in' }));
      linkTo = current.member.id;
    }
    const clientId = await this._discordClientId();
    if (!clientId) return redirect(res, this._loginResult({ error: 'discord_unavailable' }));
    const state = randomToken();
    const redirectUri = this._discordRedirectUri(req);
    await this.store.set(`/oauth/${state}`, Object.assign({
      redirectUri,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS
    }, linkTo ? { linkTo } : {}));
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
    if (requestProto(req) === 'https') cookie.push('Secure');
    res.setHeader('Set-Cookie', cookie.join('; '));
    return redirect(res, url.toString());
  }

  async _discordCallback (req, res) {
    const query = this._query(req);
    if (query.error) return redirect(res, this._loginResult({ error: String(query.error) }));
    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    if (!/^[0-9a-f]{64}$/.test(state) || !code) {
      return redirect(res, this._loginResult({ error: 'invalid_request' }));
    }
    // The state must come back to the browser that started the login.
    if (parseCookies(req.headers && req.headers.cookie)[OAUTH_STATE_COOKIE] !== state) {
      return redirect(res, this._loginResult({ error: 'expired_state' }));
    }
    const pending = await this.store.get(`/oauth/${state}`);
    if (!pending || pending.usedAt || !(pending.expiresAt > Date.now())) {
      return redirect(res, this._loginResult({ error: 'expired_state' }));
    }
    await this.store.set(`/oauth/${state}`, Object.assign({}, pending, { usedAt: Date.now() }));

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
      return redirect(res, this._loginResult({ error: 'discord_failed' }));
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
      const { member, merged } = await this.link(current.member.id, key, { via: 'oauth', profile });
      await this._refresh(member.id, Object.assign({ avatarUrl }, inGuild ? { inGuild } : {}));
      return redirect(res, this._loginResult(Object.assign({ linked: 'discord' }, merged ? { merged: '1' } : {})));
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
    this._setSessionCookie(req, res, await this._createSession(member.id, 'discord'));
    return redirect(res, this._loginResult({ signedIn: 'discord' }));
  }

  async _passportClaim (req, res) {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const pollSecret = typeof body.pollSecret === 'string' ? body.pollSecret : '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return sendJson(res, 400, { error: 'sessionId required' });
    const current = body.link === true ? await this.currentMember(req) : null;
    if (body.link === true && !current) return sendJson(res, 401, { error: 'Sign in first to link a Fabric identity' });
    if (await this.store.get(`/claims/${sha256(sessionId)}`)) {
      return sendJson(res, 409, { error: 'Session already claimed' });
    }

    const headers = { Accept: 'application/json' };
    if (pollSecret) headers['X-Fabric-Poll-Secret'] = pollSecret;
    let hubRes = null;
    let hub = null;
    for (const origin of this.hubs.order()) {
      try {
        hubRes = await this._fetch(`${origin}/sessions/${encodeURIComponent(sessionId)}`, { headers });
        this.hubs.answered(origin);
        hub = origin;
        break;
      } catch (_) { /* try the next Hub */ }
    }
    if (!hubRes) return sendJson(res, 502, { error: 'Hub unreachable' });
    let signed;
    try {
      signed = hubRes.ok ? await hubRes.json() : null;
    } catch (_) {
      return sendJson(res, 502, { error: 'Hub unreachable' });
    }
    if (signed && signed.status === 'pending') return sendJson(res, 202, { status: 'pending' });
    if (!signed || signed.status !== 'signed') return sendJson(res, 401, { error: 'Session not signed' });

    const identity = signed.identity || {};
    const parsed = accountKey('fabric', signed.pubkeyHex || identity.pubkey);
    if (!parsed) return sendJson(res, 401, { error: 'Signed session has no identity' });
    const legacy = [identity.id, signed.pubkeyHex, identity.pubkey].filter(Boolean).map((id) => `fabric:${id}`);
    const profile = { pubkeyHex: signed.pubkeyHex || identity.pubkey || null, name: identity.name || identity.handle || null };

    await this.store.set(`/claims/${sha256(sessionId)}`, { claimedAt: Date.now() });
    let member;
    let merged = false;
    let via;
    if (current) {
      ({ member, merged } = await this.link(current.member.id, parsed.key, { via: 'passport', profile, legacy }));
      via = current.via;
    } else {
      member = await this.memberFor(parsed.key, { create: true, via: 'passport', profile, legacy, displayName: profile.name });
      member = await this._refresh(member.id, { login: true });
      via = 'passport';
      this._setSessionCookie(req, res, await this._createSession(member.id, via));
    }
    const cluster = await this._importCluster(member.id, parsed.id, hub);
    if (cluster) {
      member = cluster.member;
      merged = merged || cluster.merged;
    }
    return sendJson(res, 200, Object.assign({ ok: true, member: publicMember(member, via), merged }, current ? { linked: 'fabric' } : {}));
  }

  async _currentSession (req, res) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { ok: true, member: publicMember(current.member, current.via) });
  }

  async _accounts (req, res) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { ok: true, accounts: current.member.accounts.map(accountView) });
  }

  async _unlink (req, res, key) {
    const current = await this.currentMember(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    try {
      const member = await this.unlink(current.member.id, key);
      return sendJson(res, 200, { ok: true, accounts: member.accounts.map(accountView) });
    } catch (error) {
      if (!error.status) throw error;
      return sendJson(res, error.status, { error: error.message });
    }
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
   * Express middleware for `/services/members/*`.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      if (pathname !== BASE && !pathname.startsWith(BASE + '/')) return next();
      const method = String(req.method || 'GET').toUpperCase();
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
      if (!handler) {
        switch (route) {
          case 'GET /':
            return sendJson(res, 200, { discord: this.discordEnabled, passport: true });
          case 'GET /discord': handler = this._discordStart; break;
          case 'GET /discord/callback': handler = this._discordCallback; break;
          case 'POST /passport': handler = this._passportClaim; break;
          case 'GET /session': handler = this._currentSession; break;
          case 'GET /accounts': handler = this._accounts; break;
          case 'POST /logout': handler = this._logout; break;
          default:
            return sendJson(res, 404, { error: 'Not found' });
        }
      }
      Promise.resolve(handler.call(this, req, res, ...args)).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: error && error.message ? error.message : 'Member login failed' });
      });
    };
  }
}

module.exports = Members;
module.exports.parseCookies = parseCookies;
module.exports.publicMember = publicMember;
