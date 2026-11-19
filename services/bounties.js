'use strict';

/**
 * Player bounties. A bounty is a price, in aUEC, on another citizen: kill
 * them and the poster pays you in game. Posting and claiming both require a
 * linked RSI handle. The site keeps the record. It does not move aUEC.
 * Public JSON is handles, the reward, and the status. Never member ids.
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const { sanitizeHandle, citizenUrl } = require('../functions/rsiCitizen');
const Members = require('./members');

const BASE = '/services/bounties';
const UNIT = 'aUEC';
const VISIBLE = new Set(['open', 'claimed', 'paid']);

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function randomId () {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * A positive whole number of aUEC. `150000`, `150,000`, `150k`, and `1.5m`
 * are accepted. BTC, sats, and dollars are not.
 * @param {*} value
 * @returns {number|null}
 */
function parseAuec (value) {
  const text = String(value == null ? '' : value).trim().toLowerCase().replace(/[, ]/g, '').replace(/(auec|uec)$/, '');
  const match = /^(\d+(?:\.\d+)?)([km])?$/.exec(text);
  if (!match) return null;
  const scale = match[2] === 'm' ? 1e6 : (match[2] === 'k' ? 1e3 : 1);
  const amount = Number(match[1]) * scale;
  if (!Number.isSafeInteger(amount) || amount < 1) return null;
  return amount;
}

function formatAuec (amount) {
  return `${Number(amount).toLocaleString('en-US')} ${UNIT}`;
}

class Bounties extends EventEmitter {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path]
   * @param {string} [settings.basePath]
   * @param {string} [settings.siteUrl]
   * @param {Object} [settings.members]
   */
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({
      path: './stores/bounties',
      basePath: '/bounties',
      siteUrl: 'https://goon.vc',
      members: null
    }, settings);
    this.bounties = new Map();
    this.store = null;
    this._queue = Promise.resolve();
    this.base = String(this.settings.basePath || '/bounties').replace(/\/+$/, '');
  }

  _exclusive (fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _requireMember (member) {
    if (!member) throw fail(401, 'Sign in first.');
    return member;
  }

  _handle (member) {
    const handles = Members.rsiHandles(member);
    if (!handles.length) throw fail(409, `Link an RSI handle first. A bounty is between citizens: ${String(this.settings.siteUrl || '').replace(/\/$/, '')}/services/rsi`);
    return handles[0];
  }

  _target (value) {
    const handle = sanitizeHandle(value);
    if (!handle) throw fail(400, 'Name the target by their RSI handle.');
    return handle;
  }

  async _save (bounty) {
    this.bounties.set(bounty.id, bounty);
    await this.store.set(`/bounties/${bounty.id}`, bounty);
    await this.store.set('/index/bounties', [...this.bounties.keys()]);
    return bounty;
  }

  async start () {
    this.store = new Store({ name: 'GOON.VC:bounties', path: this.settings.path, persistent: true, verbosity: 1 });
    await startStore(this.store);
    for (const id of (await this.store.get('/index/bounties')) || []) {
      const bounty = await this.store.get(`/bounties/${id}`);
      if (bounty && bounty.target) this.bounties.set(id, bounty);
    }
    this.emit('log', 'BOUNTIES', `${this.bounties.size} bounties`);
    return this;
  }

  async stop () {
    if (this.store) await this.store.stop();
    return this;
  }

  _get (id) {
    const bounty = this.bounties.get(String(id || '').toLowerCase());
    if (!bounty || bounty.status === 'cancelled') throw fail(404, 'No such bounty.');
    return bounty;
  }

  _role (bounty, member) {
    if (!member) return null;
    if (bounty.poster === member.id) return 'poster';
    if (bounty.claimant === member.id) return 'claimant';
    return null;
  }

  view (bounty, member) {
    return {
      id: bounty.id,
      path: `${this.base}/${bounty.id}`,
      target: bounty.target,
      targetUrl: citizenUrl(bounty.target),
      rewardAuec: bounty.rewardAuec,
      reward: formatAuec(bounty.rewardAuec),
      unit: UNIT,
      note: bounty.note || '',
      status: bounty.status,
      posterName: bounty.posterName,
      posterHandle: bounty.posterHandle,
      claimantName: bounty.claimantName || null,
      claimantHandle: bounty.claimantHandle || null,
      createdAt: bounty.createdAt,
      updatedAt: bounty.updatedAt,
      you: this._role(bounty, member)
    };
  }

  list ({ status = null, q = '', sort = null, mine = null } = {}) {
    const query = String(q || '').trim().toLowerCase();
    return [...this.bounties.values()]
      .filter((bounty) => bounty.status !== 'cancelled')
      .filter((bounty) => {
        if (status === 'all') return true;
        if (status) return bounty.status === status;
        return VISIBLE.has(bounty.status);
      })
      .filter((bounty) => !query || `${bounty.target} ${bounty.note || ''} ${bounty.posterHandle || ''} ${bounty.claimantHandle || ''}`.toLowerCase().includes(query))
      .filter((bounty) => !mine || bounty.poster === mine.id || bounty.claimant === mine.id)
      .sort((a, b) => sort === 'reward' ? b.rewardAuec - a.rewardAuec : String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((bounty) => this.view(bounty, mine));
  }

  async create (input, member) {
    this._requireMember(member);
    const posterHandle = this._handle(member);
    const target = this._target(input && input.target);
    if (target.toLowerCase() === posterHandle.toLowerCase()) throw fail(400, 'You can’t put a bounty on your own handle.');
    const rewardAuec = parseAuec(input && input.reward);
    if (!rewardAuec) throw fail(400, 'Reward must be a whole number of aUEC, like 150000 or 150k.');
    const note = String((input && input.note) || '').trim().slice(0, 500);
    const now = new Date().toISOString();
    const bounty = await this._exclusive(async () => {
      let id;
      do id = randomId(); while (this.bounties.has(id));
      const record = {
        id,
        target,
        rewardAuec,
        note,
        status: 'open',
        poster: member.id,
        posterName: member.displayName || posterHandle,
        posterHandle,
        claimant: null,
        claimantName: null,
        claimantHandle: null,
        createdAt: now,
        updatedAt: now
      };
      await this._save(record);
      return record;
    });
    return this.view(bounty, member);
  }

  async claim (id, member) {
    this._requireMember(member);
    const claimantHandle = this._handle(member);
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      if (current.poster === member.id) throw fail(403, 'You posted this bounty.');
      if (current.target.toLowerCase() === claimantHandle.toLowerCase()) throw fail(403, 'That’s your handle.');
      if (current.status !== 'open') throw fail(409, 'Someone has already claimed this bounty.');
      current.status = 'claimed';
      current.claimant = member.id;
      current.claimantName = member.displayName || claimantHandle;
      current.claimantHandle = claimantHandle;
      current.updatedAt = new Date().toISOString();
      await this._save(current);
      return current;
    });
    return this.view(bounty, member);
  }

  async drop (id, member) {
    this._requireMember(member);
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      if (current.claimant !== member.id) throw fail(403, 'Only the hunter can drop a claim.');
      if (current.status !== 'claimed') throw fail(409, 'This bounty is not claimed.');
      current.status = 'open';
      current.claimant = null;
      current.claimantName = null;
      current.claimantHandle = null;
      current.updatedAt = new Date().toISOString();
      await this._save(current);
      return current;
    });
    return this.view(bounty, member);
  }

  async confirm (id, member) {
    this._requireMember(member);
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      if (current.poster !== member.id) throw fail(403, 'Only the poster can confirm the kill.');
      if (current.status !== 'claimed') throw fail(409, 'Nobody has claimed this bounty.');
      current.status = 'paid';
      current.updatedAt = new Date().toISOString();
      await this._save(current);
      return current;
    });
    return this.view(bounty, member);
  }

  async reject (id, member) {
    this._requireMember(member);
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      if (current.poster !== member.id) throw fail(403, 'Only the poster can turn a claim away.');
      if (current.status !== 'claimed') throw fail(409, 'Nobody has claimed this bounty.');
      current.status = 'open';
      current.claimant = null;
      current.claimantName = null;
      current.claimantHandle = null;
      current.updatedAt = new Date().toISOString();
      await this._save(current);
      return current;
    });
    return this.view(bounty, member);
  }

  async cancel (id, member) {
    this._requireMember(member);
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      if (current.poster !== member.id) throw fail(403, 'Only the poster can take a bounty down.');
      if (current.status !== 'open') throw fail(409, 'A claimed bounty has to be confirmed or turned away.');
      current.status = 'cancelled';
      current.updatedAt = new Date().toISOString();
      await this._save(current);
      return current;
    });
    return this.view(bounty, member);
  }

  async page (pathname) {
    const clean = String(pathname || '').replace(/\/+$/, '');
    if (clean === this.base || clean.indexOf(`${this.base}/`) !== 0) return null;
    const id = clean.slice(this.base.length + 1);
    if (!id || id.includes('/')) return null;
    const bounty = this.bounties.get(id.toLowerCase());
    if (!bounty || bounty.status === 'cancelled') return null;
    return {
      path: clean,
      title: `${bounty.target} · Bounties`,
      description: `${formatAuec(bounty.rewardAuec)} on ${bounty.target}, posted by ${bounty.posterHandle}. ${bounty.status}.`
    };
  }

  middleware () {
    const readBody = (req) => (req.body && typeof req.body === 'object' ? req.body : {});
    return (req, res, next) => {
      const pathname = String(req.path || '').replace(/\/+$/, '');
      if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return next();
      const method = String(req.method || 'GET').toUpperCase();
      const parts = pathname.slice(BASE.length).split('/').filter(Boolean);
      const send = (status, body) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(body));
      };
      Promise.resolve(this.settings.members && this.settings.members.currentMember(req)).then(async (current) => {
        const member = current && current.member;
        if (!parts.length && method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          return send(200, {
            ok: true,
            unit: UNIT,
            bounties: this.list({
              status: url.searchParams.get('status'),
              q: url.searchParams.get('q'),
              sort: url.searchParams.get('sort'),
              mine: url.searchParams.get('mine') === '1' ? member : null
            })
          });
        }
        if (!parts.length && method === 'POST') return send(201, { ok: true, bounty: await this.create(readBody(req), member) });
        if (parts.length === 1 && method === 'GET') return send(200, { ok: true, bounty: this.view(this._get(parts[0]), member) });
        if (parts.length === 2 && method === 'POST') {
          const [id, action] = parts;
          if (action === 'claim') return send(200, { ok: true, bounty: await this.claim(id, member) });
          if (action === 'drop') return send(200, { ok: true, bounty: await this.drop(id, member) });
          if (action === 'confirm') return send(200, { ok: true, bounty: await this.confirm(id, member) });
          if (action === 'reject') return send(200, { ok: true, bounty: await this.reject(id, member) });
          if (action === 'cancel') return send(200, { ok: true, bounty: await this.cancel(id, member) });
        }
        return send(404, { error: 'Not found' });
      }).catch((error) => {
        if (res.headersSent) return;
        const status = error && error.status >= 400 && error.status < 500 ? error.status : 500;
        send(status, { error: status === 500 ? 'The bounty board is unavailable.' : error.message });
      });
    };
  }
}

module.exports = Bounties;
module.exports.BASE = BASE;
module.exports.UNIT = UNIT;
module.exports.parseAuec = parseAuec;
module.exports.formatAuec = formatAuec;
