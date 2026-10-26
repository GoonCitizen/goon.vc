'use strict';

const crypto = require('crypto');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const welcome = require('../functions/welcome');

const PATH = '/services/welcome';
const STATE_KEY = '/welcome/state';
const BY = 'goon.vc welcome';
const OPEN = ['scheduled', 'sending', 'paused'];

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

/**
 * Welcome DMs inviting new members of the G00N SQUAD Discord to join
 * PERMAFLEET and earn their Prospect tags (contracts/welcome.json). Nothing
 * goes out on its own: someone with Manage Server runs `/goon welcome`,
 * which saves the welcome campaign and previews, by name, the members who
 * joined between `windowDays` and `delayHours` ago, hold none of the
 * excluded roles (alliance orgs, Org Stewards, the PERMAFLEET program), and
 * were never welcomed before; Send sends it to exactly those members. Who
 * was welcomed comes from Doorman's own deliveries for welcome campaigns,
 * so it never depends on this Store. Stop cancels welcomes still going out
 * (those members can be welcomed later).
 */
class Welcome {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {Object} [settings.community] Community service (its Campaigns plugin sends).
   * @param {Object} [settings.contract] Welcome contract (default contracts/welcome.json).
   * @param {Function} [settings.now] Clock (tests).
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/welcome',
      community: null,
      contract: null,
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.contract = this.settings.contract || welcome.load();
    this.store = null;
    this.state = { lastRunAt: null, lastRunBy: null, lastRun: null, error: null };
    this._skips = new Map();
    this._preview = null;
    this._sending = null;
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

  get guildId () {
    return this.contract.guildId ? String(this.contract.guildId) : null;
  }

  get campaigns () {
    const community = this.settings.community;
    return (community && community.campaigns) || null;
  }

  /** Whether welcomes can run here at all (campaigns on, contract present). */
  get available () {
    return !!(this.campaigns && this.guildId && this.contract.title && this.contract.script && this.contract.message);
  }

  async start () {
    this.store = new Store({ name: 'GOON.VC:welcome', path: this.settings.path, persistent: true, verbosity: 1 });
    await startStore(this.store);
    const saved = (await this.store.get(STATE_KEY)) || {};
    for (const key of Object.keys(this.state)) if (saved[key] !== undefined) this.state[key] = saved[key];
    const community = this.settings.community;
    if (community && typeof community.narrow === 'function') community.narrow((people, campaign) => this.narrow(people, campaign));
    return this;
  }

  async stop () {
    if (this._sending) await this._sending.catch(() => {});
    if (this.store) await this.store.stop();
    return this;
  }

  _welcomed () {
    const campaigns = this.campaigns;
    if (!campaigns) return new Set();
    return welcome.reached(this.contract, campaigns.list(), campaigns.content && campaigns.content.deliveries);
  }

  /**
   * Keep, for welcome campaigns, the members who joined inside the window
   * and were never welcomed; other campaigns pass through untouched. Skips
   * are counted for the preview.
   * @param {Array<Object>} people `{ target, joinedAt?, … }`
   * @param {Object} campaign `{ id, title }`
   * @returns {Array<Object>}
   */
  narrow (people, campaign) {
    if (!campaign || campaign.title !== this.contract.title) return people;
    const { from, to } = welcome.joinedWindow(this.contract, this.settings.now());
    const welcomed = this._welcomed();
    const skips = { welcomed: 0, recent: 0, earlier: 0 };
    const kept = people.filter((person) => {
      if (welcomed.has(person.target)) skips.welcomed += 1;
      else if (!Number.isFinite(person.joinedAt) || person.joinedAt < from) skips.earlier += 1;
      else if (person.joinedAt > to) skips.recent += 1;
      else return true;
      return false;
    });
    if (campaign.id) this._skips.set(campaign.id, skips);
    return kept;
  }

  _open () {
    const campaigns = this.campaigns;
    return campaigns ? campaigns.list().filter((campaign) => campaign.title === this.contract.title && OPEN.includes(campaign.status)) : [];
  }

  /**
   * The public status: the delay and window, when welcomes last went out
   * and to how many, how many were welcomed, and whether any are still
   * going out. No names or ids.
   * @returns {Object}
   */
  status () {
    return {
      available: this.available,
      delayHours: this.contract.delayHours,
      windowDays: this.contract.windowDays,
      lastRunAt: this.state.lastRunAt,
      lastRun: this.state.lastRun ? { reach: this.state.lastRun.reach } : null,
      welcomed: this._welcomed().size,
      sending: this._open().length,
      error: this.state.error
    };
  }

  /**
   * What Send would send right now: the message, the members it would
   * reach by name (the draft is saved with a preview that Send is bound
   * to), who is skipped, and the questions the Start button opens. Nothing
   * is sent.
   * @returns {Promise<Object>} `{ id, status, message, campaign, reach, recipients, found, optedOut, welcomed, recent, earlier, roles, script }`
   */
  async preview () {
    this._assertAvailable();
    if (this._sending) await this._sending.catch(() => {});
    const { preview, ...counts } = await this._draft();
    const id = crypto.randomBytes(4).toString('hex');
    this._preview = { id, campaign: counts.campaign, preview, reach: counts.reach };
    return Object.assign({ id, status: this.status(), message: this.contract.message, script: this.script(), roles: this.excluded() }, counts);
  }

  /**
   * Names of the roles whose holders are never welcomed, by group.
   * @returns {Object<string, Array<string>>}
   */
  excluded () {
    return Object.fromEntries(Object.entries(this.contract.exclude || {}).map(([group, roles]) => [group, Object.keys(roles || {})]));
  }

  /**
   * The DM script behind Start: its title and the questions it asks.
   * @returns {{ id: string, title: string, questions: Array<{ say: string, options: Array<string>, optional: boolean }> }|null}
   */
  script () {
    const community = this.settings.community;
    const scripts = community && community.scripts;
    const definition = scripts && typeof scripts.definition === 'function' ? scripts.definition(this.contract.script) : null;
    if (!definition) return null;
    const questions = Object.values(definition.steps)
      .filter((step) => step.input && step.input.type !== 'confirm' && step.input.type !== 'none')
      .map((step) => ({
        say: step.say,
        options: (step.input.options || []).map((option) => option.label),
        optional: !!step.input.optional
      }));
    return { id: definition.id, title: definition.title, questions };
  }

  /**
   * Send the last preview to exactly the members it listed who are still
   * due. A preview older than the last `preview()` (or from before a
   * restart) is refused (409).
   * @param {Object} options
   * @param {string} options.preview The preview's `id`.
   * @param {string} [options.by]
   * @returns {Promise<Object>} `{ campaign, reach, status }`
   */
  send ({ preview, by = null } = {}) {
    if (!this._sending) {
      this._sending = this._send(preview, by).finally(() => { this._sending = null; });
    }
    return this._sending;
  }

  async _send (preview, by) {
    this._assertAvailable();
    const shown = this._preview;
    if (!shown || !preview || shown.id !== String(preview)) {
      throw Object.assign(new Error('This preview is out of date. Run `/goon welcome` again to see who it reaches now.'), { status: 409 });
    }
    this._preview = null;
    try {
      const result = { campaign: shown.campaign, reach: shown.reach, status: 'draft' };
      if (shown.reach > 0) {
        const sent = await this.campaigns.schedule(shown.campaign, { preview: shown.preview, by: by || BY });
        result.status = sent.status;
        result.reach = sent.stats ? sent.stats.targeted : shown.reach;
      }
      await this._save({ lastRunAt: new Date(this.settings.now()).toISOString(), lastRunBy: by, lastRun: result, error: null });
      if (result.reach) this.emit('log', 'GOON.VC', `welcome DMs: ${result.reach} going out${by ? `, sent by ${by}` : ''}`);
      return result;
    } catch (error) {
      await this._save({ error: errorMessage(error) });
      this.emit('error', 'welcome', errorMessage(error));
      throw error;
    }
  }

  /**
   * Stop welcomes still scheduled, sending, or paused.
   * @param {Object} [options]
   * @param {string} [options.by]
   * @returns {Promise<{ cancelled: number }>} DMs that won't go out
   */
  async halt ({ by = null } = {}) {
    if (this._sending) await this._sending.catch(() => {});
    let cancelled = 0;
    for (const campaign of this._open()) {
      cancelled += (campaign.stats && campaign.stats.pending) || 0;
      await this.campaigns.cancel(campaign.id, { by: by || BY });
    }
    this._preview = null;
    this.emit('log', 'GOON.VC', `welcome DMs stopped${by ? ` by ${by}` : ''}${cancelled ? `; ${cancelled} not sent` : ''}`);
    return { cancelled };
  }

  async _draft () {
    const campaigns = this.campaigns;
    const next = welcome.draft(this.contract);
    const open = campaigns.list().find((campaign) => campaign.title === next.title && campaign.status === 'draft');
    const saved = open
      ? await campaigns.update(open.id, { content: next.content, filter: next.filter }, { by: BY })
      : await campaigns.create(next, { owner: next.owner, by: BY });
    const counts = await campaigns.preview(saved.id);
    const skips = this._skips.get(saved.id) || { welcomed: 0, recent: 0, earlier: 0 };
    return {
      campaign: saved.id,
      preview: counts.id,
      recipients: (counts.recipients || []).map((recipient) => recipient.name || 'Unnamed member'),
      reach: counts.reach,
      found: counts.found,
      optedOut: counts.optedOut || 0,
      welcomed: skips.welcomed,
      recent: skips.recent,
      earlier: skips.earlier
    };
  }

  _assertAvailable () {
    if (!this.campaigns) throw Object.assign(new Error('Campaigns are not running here, so welcome DMs can’t either.'), { status: 503 });
    if (!this.available) throw Object.assign(new Error('There is no welcome set up (contracts/welcome.json).'), { status: 503 });
  }

  async _save (patch) {
    this.state = Object.assign({}, this.state, patch);
    if (this.store) await this.store.set(STATE_KEY, this.state);
  }

  /**
   * Express middleware for `GET /services/welcome` ({@link Welcome#status}).
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const url = new URL(req.originalUrl || req.url, 'http://localhost');
      const pathname = (req.path || url.pathname).replace(/\/+$/, '');
      if (pathname !== PATH) return next();
      if (String(req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      sendJson(res, 200, this.status());
    };
  }
}

module.exports = Welcome;
module.exports.PATH = PATH;
