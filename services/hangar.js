'use strict';

const crypto = require('crypto');
const EventEmitter = require('events');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const { parseHangarExport, countModels } = require('../functions/hangarExport');

const PATH = '/services/hangar';
const INDEX_KEY = '/index';
const HISTORY = 50;

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function tokenMatches (given, expected) {
  if (!given || !expected) return false;
  const left = Buffer.from(String(given));
  const right = Buffer.from(String(expected));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function rsiHandles (member) {
  return ((member && member.accounts) || []).filter((account) => account.platform === 'rsi').map((account) => account.id);
}

function fail (status, message, extra = {}) {
  return Object.assign(new Error(message), { status }, extra);
}

/**
 * Members' hangars, from Hangar Export (hangar.link) JSON files they import
 * with `/hangar import`. One record per member (`/hangars/<memberId>`), one
 * hangar per RSI handle they hold: the ship list of their latest import
 * (model, manufacturer, custom name, LTI, warbond — never prices, pledge ids,
 * coupons, or buybacks) plus when they imported and how many ships. An
 * import is taken only for an `rsi:` account the member holds, and a hangar
 * counts only while they still hold it. Merged members' hangars move to the
 * surviving member. The public report is fleet totals only; the per-member
 * list is for leadership behind the scripts token.
 */
class Hangar extends EventEmitter {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {Object} settings.members Members service.
   * @param {string} [settings.token] Bearer token for `GET /services/hangar/members`.
   * @param {Function} [settings.now] Clock (tests).
   */
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({
      path: './stores/hangar',
      members: null,
      token: null,
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.store = null;
    this._queue = Promise.resolve();
    this._index = new Set();
    this._onMerged = (event) => {
      this._serial(() => this._merge(event)).catch((error) => {
        this.emit('error', 'HANGAR', `could not move hangars after a member merge: ${error.message}`);
      });
    };
  }

  async start () {
    this.store = new Store({ name: 'GOON.VC:hangar', path: this.settings.path, persistent: true, verbosity: 1 });
    await startStore(this.store);
    const index = await this.store.get(INDEX_KEY);
    this._index = new Set((index && index.members) || []);
    const members = this.settings.members;
    if (members && typeof members.on === 'function') members.on('merged', this._onMerged);
    return this;
  }

  async stop () {
    const members = this.settings.members;
    if (members && typeof members.removeListener === 'function') members.removeListener('merged', this._onMerged);
    await this._queue.catch(() => {});
    if (this.store) await this.store.stop();
    return this;
  }

  _serial (fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  async _read (memberId) {
    const record = await this.store.get(`/hangars/${memberId}`);
    return record && typeof record === 'object' && record.handles ? structuredClone(record) : { handles: {} };
  }

  async _write (memberId, record) {
    if (Object.keys(record.handles).length) {
      await this.store.set(`/hangars/${memberId}`, record);
      this._index.add(memberId);
    } else {
      // The Store's memory keeps a key Level forgot, so leave a tombstone there.
      await this.store.set(`/hangars/${memberId}`, { droppedAt: this.settings.now() });
      await this.store.del(`/hangars/${memberId}`);
      this._index.delete(memberId);
    }
    await this.store.set(INDEX_KEY, { members: [...this._index] });
  }

  async _merge ({ from, into } = {}) {
    if (!from || !into || from === into || !this._index.has(from)) return;
    const source = await this._read(from);
    const target = await this._read(into);
    for (const [key, entry] of Object.entries(source.handles)) {
      const held = target.handles[key];
      if (!held || Date.parse(entry.importedAt) > Date.parse(held.importedAt)) {
        target.handles[key] = Object.assign({}, entry, {
          history: [...((held && held.history) || []), ...(entry.history || [])]
            .sort((a, b) => String(a.at).localeCompare(String(b.at)))
            .slice(-HISTORY)
        });
      }
    }
    await this._write(into, target);
    await this._write(from, { handles: {} });
  }

  async _member (memberId) {
    const members = this.settings.members;
    const member = members ? await members.resolve(memberId) : null;
    if (!member) throw fail(404, 'Member not found');
    return member;
  }

  /**
   * Take a member's Hangar Export, replacing the ships stored for its handle:
   * the RSI account the export names, which the member must have claimed, or
   * their only claimed handle when the export names none.
   * @param {string} memberId
   * @param {*} data Parsed export JSON.
   * @returns {Promise<{ handle: string, ships: number, models: number, importedAt: string }>}
   * @throws an error with `code: 'UNCLAIMED'` and `handle` (the export's, or null) when the member doesn't hold that `rsi:` account,
   *   or `code: 'WHICH_HANDLE'` when the export names no account and the member holds several
   */
  async importExport (memberId, data) {
    const parsed = parseHangarExport(data);
    const member = await this._member(memberId);
    const held = rsiHandles(member);
    const handle = parsed.hangar
      ? held.find((entry) => entry.toLowerCase() === parsed.hangar.toLowerCase())
      : (held.length === 1 ? held[0] : null);
    if (!handle && (parsed.hangar || !held.length)) {
      const message = parsed.hangar
        ? `That export is for ${parsed.hangar}, which you haven’t claimed on goon.vc.`
        : 'Claim your RSI handle on goon.vc before importing your hangar.';
      throw fail(403, message, { code: 'UNCLAIMED', handle: parsed.hangar });
    }
    if (!handle) {
      throw fail(400, `That export doesn’t say which RSI account it came from, and you’ve claimed several (${held.join(', ')}), so I can’t tell whose hangar it is.`, { code: 'WHICH_HANDLE' });
    }
    const importedAt = new Date(this.settings.now()).toISOString();
    await this._serial(async () => {
      const record = await this._read(member.id);
      const key = handle.toLowerCase();
      const prior = record.handles[key];
      record.handles[key] = {
        handle,
        importedAt,
        ships: parsed.ships,
        history: [...((prior && prior.history) || []), { at: importedAt, count: parsed.ships.length }].slice(-HISTORY)
      };
      await this._write(member.id, record);
    });
    this.emit('log', 'HANGAR', `synced ${parsed.ships.length} ships for ${handle}`);
    return { handle, ships: parsed.ships.length, models: parsed.models, importedAt };
  }

  /**
   * A member's latest import, or null.
   * @param {string} memberId
   * @returns {Promise<{ handle: string, importedAt: string, ships: number, models: number, counted: boolean }|null>}
   */
  async status (memberId) {
    const member = await this._member(memberId);
    const record = await this._read(member.id);
    const latest = Object.values(record.handles).sort((a, b) => String(b.importedAt).localeCompare(String(a.importedAt)))[0];
    if (!latest) return null;
    const held = rsiHandles(member).map((handle) => handle.toLowerCase());
    return {
      handle: latest.handle,
      importedAt: latest.importedAt,
      ships: latest.ships.length,
      models: countModels(latest.ships),
      counted: held.includes(latest.handle.toLowerCase())
    };
  }

  // Every counted hangar: [{ member, entry }], only for handles their member still holds.
  async _counted () {
    const out = [];
    for (const memberId of [...this._index]) {
      const member = await this.settings.members.resolve(memberId).catch(() => null);
      if (!member || member.id !== memberId) continue;
      const held = new Set(rsiHandles(member).map((handle) => handle.toLowerCase()));
      const record = await this._read(memberId);
      for (const [key, entry] of Object.entries(record.handles)) {
        if (held.has(key)) out.push({ member, entry });
      }
    }
    return out;
  }

  /**
   * Fleet totals: no names, handles, or ids.
   * @returns {Promise<{ members: number, ships: number, models: Array<{ model: string, manufacturer: string|null, count: number, owners: number }>, updatedAt: string|null }>}
   */
  async report () {
    const models = new Map();
    const members = new Set();
    let ships = 0;
    let updatedAt = null;
    for (const { member, entry } of await this._counted()) {
      members.add(member.id);
      if (!updatedAt || entry.importedAt > updatedAt) updatedAt = entry.importedAt;
      for (const ship of entry.ships) {
        ships += 1;
        const key = ship.model.toLowerCase();
        const row = models.get(key) || { model: ship.model, manufacturer: ship.manufacturer || null, count: 0, owners: new Set() };
        if (!row.manufacturer && ship.manufacturer) row.manufacturer = ship.manufacturer;
        row.count += 1;
        row.owners.add(member.id);
        models.set(key, row);
      }
    }
    return {
      members: members.size,
      ships,
      models: [...models.values()]
        .map((row) => ({ model: row.model, manufacturer: row.manufacturer, count: row.count, owners: row.owners.size }))
        .sort((a, b) => b.count - a.count || b.owners - a.owners || a.model.localeCompare(b.model)),
      updatedAt
    };
  }

  /**
   * Every counted hangar with its member's display name and handle, for leadership.
   * @returns {Promise<Array<{ displayName: string|null, handle: string, importedAt: string, ships: Array<Object> }>>}
   */
  async roster () {
    return (await this._counted())
      .map(({ member, entry }) => ({ displayName: member.displayName || null, handle: entry.handle, importedAt: entry.importedAt, ships: entry.ships }))
      .sort((a, b) => a.handle.localeCompare(b.handle));
  }

  /**
   * `GET /services/hangar` (totals) and `GET /services/hangar/members`
   * (behind `Authorization: Bearer <token>`; 404 without it).
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      if (pathname !== PATH && !pathname.startsWith(`${PATH}/`)) return next();
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
      let work;
      if (pathname === PATH) {
        work = this.report().then((report) => sendJson(res, 200, report));
      } else if (pathname === `${PATH}/members`) {
        const match = /^Bearer\s+(.+)$/i.exec(String((req.headers && req.headers.authorization) || ''));
        if (!tokenMatches(match && match[1].trim(), this.settings.token)) return sendJson(res, 404, { error: 'Not found' });
        work = this.roster().then((hangars) => sendJson(res, 200, { hangars }));
      } else {
        return sendJson(res, 404, { error: 'Not found' });
      }
      work.catch((error) => {
        if (!res.headersSent) sendJson(res, 500, { error: error && error.message ? error.message : 'Hangar failed' });
      });
    };
  }
}

module.exports = Hangar;
