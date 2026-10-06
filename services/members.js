'use strict';

const crypto = require('crypto');
const Store = require('@fabric/core/types/store');

const BASE = '/services/members';
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_AUTHORIZE = 'https://discord.com/oauth2/authorize';
const DEFAULT_COOKIE = 'goon.member';
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function sha256 (value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function randomToken () {
  return crypto.randomBytes(32).toString('hex');
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

function publicMember (member) {
  if (!member) return null;
  return {
    id: member.id,
    provider: member.provider,
    displayName: member.displayName || null,
    avatarUrl: member.avatarUrl || null,
    inGuild: member.inGuild === true,
    createdAt: member.createdAt,
    lastLoginAt: member.lastLoginAt
  };
}

/**
 * Member login for goon.vc: Discord OAuth2 and Fabric Passport (via the Hub
 * `/sessions` proxy). Members, login sessions, OAuth states, and claimed Hub
 * sessions all live in one `@fabric/core` {@link Store}.
 */
class Members {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string} [settings.hubOrigin] Hub that signs Passport sessions.
   * @param {string} [settings.loginPath] SPA page to return to after login.
   * @param {Object} [settings.discord] `{ clientId, clientSecret, redirectUri, guildId }`
   * @param {number} [settings.sessionTtlMs]
   * @param {string} [settings.cookieName]
   * @param {Function} [settings.fetch] Injected for tests; defaults to global fetch.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/members',
      hubOrigin: 'https://hub.fabric.pub',
      loginPath: '/sessions',
      discord: {},
      sessionTtlMs: DEFAULT_SESSION_TTL_MS,
      cookieName: DEFAULT_COOKIE
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.discord = Object.assign({}, this.settings.discord);
    this._fetch = this.settings.fetch || ((...args) => fetch(...args));
    this.store = null;
  }

  get discordEnabled () {
    return !!(this.discord.clientId && this.discord.clientSecret);
  }

  async start () {
    this.store = new Store({
      name: 'GOON.VC:members',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await this.store.start();
    return this;
  }

  async stop () {
    if (this.store) await this.store.stop();
    return this;
  }

  async getMember (id) {
    return this.store.get(`/members/${id}`);
  }

  async _upsertMember (id, fields) {
    const now = new Date().toISOString();
    const existing = await this.getMember(id);
    const member = Object.assign({}, existing || { id, createdAt: now }, fields, { lastLoginAt: now });
    await this.store.set(`/members/${id}`, member);
    return member;
  }

  async _createSession (memberId) {
    const token = randomToken();
    const now = Date.now();
    await this.store.set(`/sessions/${sha256(token)}`, {
      memberId,
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

  async _discordStart (req, res) {
    if (!this.discordEnabled) return sendJson(res, 503, { error: 'Discord login is not configured' });
    const state = randomToken();
    const redirectUri = this._discordRedirectUri(req);
    await this.store.set(`/oauth/${state}`, {
      redirectUri,
      expiresAt: Date.now() + OAUTH_STATE_TTL_MS
    });
    const url = new URL(DISCORD_AUTHORIZE);
    url.searchParams.set('client_id', this.discord.clientId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', 'identify guilds');
    url.searchParams.set('state', state);
    return redirect(res, url.toString());
  }

  async _discordCallback (req, res) {
    const query = req.query || Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    if (query.error) return redirect(res, this._loginResult({ error: String(query.error) }));
    const state = typeof query.state === 'string' ? query.state : '';
    const code = typeof query.code === 'string' ? query.code : '';
    if (!/^[0-9a-f]{64}$/.test(state) || !code) {
      return redirect(res, this._loginResult({ error: 'invalid_request' }));
    }
    const pending = await this.store.get(`/oauth/${state}`);
    if (!pending || pending.usedAt || !(pending.expiresAt > Date.now())) {
      return redirect(res, this._loginResult({ error: 'expired_state' }));
    }
    await this.store.set(`/oauth/${state}`, Object.assign({}, pending, { usedAt: Date.now() }));

    try {
      const tokenRes = await this._fetch(`${DISCORD_API}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({
          client_id: this.discord.clientId,
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
      const user = await userRes.json();
      if (!userRes.ok || !user || !user.id) throw new Error('user lookup failed');

      let inGuild = false;
      if (this.discord.guildId) {
        const guildsRes = await this._fetch(`${DISCORD_API}/users/@me/guilds`, { headers: auth });
        const guilds = guildsRes.ok ? await guildsRes.json() : [];
        inGuild = Array.isArray(guilds) && guilds.some((g) => g && g.id === this.discord.guildId);
      }

      const member = await this._upsertMember(`discord:${user.id}`, {
        provider: 'discord',
        discord: { id: user.id, username: user.username, globalName: user.global_name || null },
        displayName: user.global_name || user.username,
        avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png` : null,
        inGuild
      });
      this._setSessionCookie(req, res, await this._createSession(member.id));
      return redirect(res, this._loginResult({ signedIn: 'discord' }));
    } catch (_) {
      return redirect(res, this._loginResult({ error: 'discord_failed' }));
    }
  }

  async _passportClaim (req, res) {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : '';
    const pollSecret = typeof body.pollSecret === 'string' ? body.pollSecret : '';
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(sessionId)) return sendJson(res, 400, { error: 'sessionId required' });
    if (await this.store.get(`/claims/${sha256(sessionId)}`)) {
      return sendJson(res, 409, { error: 'Session already claimed' });
    }

    let signed;
    try {
      const headers = { Accept: 'application/json' };
      if (pollSecret) headers['X-Fabric-Poll-Secret'] = pollSecret;
      const hubRes = await this._fetch(`${this.settings.hubOrigin}/sessions/${encodeURIComponent(sessionId)}`, { headers });
      signed = hubRes.ok ? await hubRes.json() : null;
    } catch (_) {
      return sendJson(res, 502, { error: 'Hub unreachable' });
    }
    if (signed && signed.status === 'pending') return sendJson(res, 202, { status: 'pending' });
    if (!signed || signed.status !== 'signed') return sendJson(res, 401, { error: 'Session not signed' });

    const identity = signed.identity || {};
    const fabricId = identity.id || signed.pubkeyHex || identity.pubkey;
    if (!fabricId) return sendJson(res, 401, { error: 'Signed session has no identity' });

    await this.store.set(`/claims/${sha256(sessionId)}`, { claimedAt: Date.now() });
    const member = await this._upsertMember(`fabric:${fabricId}`, {
      provider: 'passport',
      fabric: { id: identity.id || null, pubkeyHex: signed.pubkeyHex || identity.pubkey || null },
      displayName: identity.name || identity.handle || null
    });
    this._setSessionCookie(req, res, await this._createSession(member.id));
    return sendJson(res, 200, { ok: true, member: publicMember(member) });
  }

  async _currentSession (req, res) {
    const current = await this._sessionFromRequest(req);
    if (!current) return sendJson(res, 401, { error: 'Not signed in' });
    const member = await this.getMember(current.session.memberId);
    if (!member) return sendJson(res, 401, { error: 'Not signed in' });
    return sendJson(res, 200, { ok: true, member: publicMember(member) });
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
      const route = `${method} ${pathname.slice(BASE.length) || '/'}`;
      let handler = null;
      switch (route) {
        case 'GET /':
          return sendJson(res, 200, { discord: this.discordEnabled, passport: true });
        case 'GET /discord': handler = this._discordStart; break;
        case 'GET /discord/callback': handler = this._discordCallback; break;
        case 'POST /passport': handler = this._passportClaim; break;
        case 'GET /session': handler = this._currentSession; break;
        case 'POST /logout': handler = this._logout; break;
        default:
          return sendJson(res, 404, { error: 'Not found' });
      }
      Promise.resolve(handler.call(this, req, res)).catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: error && error.message ? error.message : 'Member login failed' });
      });
    };
  }
}

module.exports = Members;
module.exports.parseCookies = parseCookies;
