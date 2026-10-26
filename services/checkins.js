'use strict';

const crypto = require('crypto');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const checkin = require('../functions/checkin');

const PATH = '/services/checkins';
const STATE_KEY = '/checkins/state';
const TOUCHED_KEY = '/checkins/touched';
const DAY = 24 * 60 * 60 * 1000;
const BY = 'goon.vc check-ins';
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

function userId (target) {
  const match = /^discord\/users\/(\d{5,25})$/.exec(String(target || ''));
  return match ? match[1] : null;
}

/**
 * Check-ins with G00N SQUAD members who have gone quiet
 * (contracts/checkin.json). Nothing goes out on its own: someone with Manage
 * Server runs `/goon checkins`, which saves each tier's campaign (most
 * inactive tier first) and previews who each would reach, by name; Send
 * sends each tier to exactly the people that preview listed. Each member is
 * reached once per tier for good and never twice within the contract's
 * `spacingDays`: every DM that goes out is noted here (Doorman's `delivered`
 * event) and those members are dropped from later check-in audiences,
 * however many campaigns later. Stop cancels check-ins still going out. Who
 * was reached stays in this Store and is never served.
 */
class Checkins {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {Object} [settings.community] Community service (its Campaigns plugin sends).
   * @param {Object} [settings.contract] Check-in contract (default contracts/checkin.json).
   * @param {Function} [settings.now] Clock (tests).
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/checkins',
      community: null,
      contract: null,
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.contract = this.settings.contract || checkin.load();
    this.store = null;
    this.state = { lastRunAt: null, lastRunBy: null, lastRun: [], error: null };
    this.touched = {};
    this._preview = null;
    this._sending = null;
    this._listeners = {};
    this._attached = null;
    this._onDelivered = (event) => this._delivered(event);
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

  /** Whether check-ins can run here at all (campaigns on, contract present). */
  get available () {
    return !!(this.campaigns && this.guildId && (this.contract.tiers || []).length);
  }

  async start () {
    this.store = new Store({ name: 'GOON.VC:checkins', path: this.settings.path, persistent: true, verbosity: 1 });
    await startStore(this.store);
    const saved = (await this.store.get(STATE_KEY)) || {};
    for (const key of Object.keys(this.state)) if (saved[key] !== undefined) this.state[key] = saved[key];
    this.touched = (await this.store.get(TOUCHED_KEY)) || {};

    const community = this.settings.community;
    if (community && typeof community.narrow === 'function') community.narrow((people, campaign) => this.narrow(people, campaign));
    const campaigns = this.campaigns;
    if (campaigns && typeof campaigns.on === 'function') {
      campaigns.on('delivered', this._onDelivered);
      this._attached = campaigns;
    }
    return this;
  }

  async stop () {
    if (this._attached && typeof this._attached.removeListener === 'function') this._attached.removeListener('delivered', this._onDelivered);
    this._attached = null;
    if (this._sending) await this._sending.catch(() => {});
    if (this.store) await this.store.stop();
    return this;
  }

  _tier (title) {
    return (this.contract.tiers || []).find((tier) => checkin.title(tier) === title) || null;
  }

  _delivered (event) {
    const tier = event && this._tier(event.title);
    const id = tier && userId(event.target);
    if (!id) return;
    const at = Date.parse(event.at) || this.settings.now();
    this.touched[id] = Object.assign({}, this.touched[id], { [tier.id]: at });
    this.store.set(TOUCHED_KEY, this.touched).catch((error) => this.emit('error', 'checkins', errorMessage(error)));
  }

  /**
   * Drop members a check-in should leave alone: anyone this tier already
   * reached, and anyone any check-in reached within `spacingDays`. Other
   * campaigns pass through untouched.
   * @param {Array<Object>} people `{ target, … }`
   * @param {Object} campaign `{ title }`
   * @returns {Array<Object>}
   */
  narrow (people, campaign) {
    const tier = campaign && this._tier(campaign.title);
    if (!tier) return people;
    const spacing = (Number(this.contract.spacingDays) || 0) * DAY;
    const now = this.settings.now();
    return people.filter((person) => {
      const touches = this.touched[userId(person.target)];
      if (!touches) return true;
      if (touches[tier.id]) return false;
      return !Object.values(touches).some((at) => now - at < spacing);
    });
  }

  _open () {
    const campaigns = this.campaigns;
    return campaigns ? campaigns.list().filter((campaign) => this._tier(campaign.title) && OPEN.includes(campaign.status)) : [];
  }

  /**
   * The public status: when check-ins last went out, how many each tier
   * reached, and how many are still going out. No names or ids.
   * @returns {Object}
   */
  status () {
    return {
      available: this.available,
      lastRunAt: this.state.lastRunAt,
      lastRun: (this.state.lastRun || []).map((entry) => ({ tier: entry.tier, reach: entry.reach, status: entry.status })),
      sending: this._open().length,
      error: this.state.error
    };
  }

  /**
   * What Send would send right now: each tier's message and the members it
   * would reach, by name, in sending order (saved as drafts with a preview
   * that Send is bound to), and the questions the Start button opens.
   * Nothing is sent.
   * @returns {Promise<Object>} `{ id, status, tiers: [{ id, name, message, campaign, status, reach, found, active, inactive, unseen, optedOut, excluded, recipients }], script }`
   */
  async preview () {
    this._assertAvailable();
    if (this._sending) await this._sending.catch(() => {});
    const tiers = [];
    for (const step of await this._drafts()) tiers.push(await this._previewStep(step));
    const id = crypto.randomBytes(4).toString('hex');
    this._preview = {
      id,
      tiers: tiers.filter((tier) => tier.status === 'draft').map((tier) => ({ tier: tier.id, campaign: tier.campaign, preview: tier.preview, reach: tier.reach }))
    };
    return { id, status: this.status(), tiers: tiers.map(({ preview, ...tier }) => tier), script: this.script() };
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
   * Send the last preview: each tier to exactly the members it listed who
   * still qualify, most inactive tier first. A preview older than the last
   * `preview()` (or from before a restart) is refused (409).
   * @param {Object} options
   * @param {string} options.preview The preview's `id`.
   * @param {string} [options.by] Display name, kept in this Store's state.
   * @returns {Promise<Array<Object>>} per tier `{ tier, campaign, reach, status }`
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
      throw Object.assign(new Error('This preview is out of date. Run `/goon checkins` again to see who it reaches now.'), { status: 409 });
    }
    this._preview = null;
    const results = [];
    try {
      for (const entry of shown.tiers) {
        const result = { tier: entry.tier, campaign: entry.campaign, reach: entry.reach, status: 'draft' };
        if (entry.reach > 0) {
          const sent = await this.campaigns.schedule(entry.campaign, { preview: entry.preview, by: by || BY });
          result.status = sent.status;
          result.reach = sent.stats ? sent.stats.targeted : entry.reach;
        }
        results.push(result);
      }
      await this._save({ lastRunAt: new Date(this.settings.now()).toISOString(), lastRunBy: by, lastRun: results, error: null });
      this.emit('log', 'GOON.VC', `check-ins sent${by ? ` by ${by}` : ''}: ${results.map((entry) => `${entry.tier} ${entry.reach}`).join(', ')}`);
      return results;
    } catch (error) {
      await this._save({ error: errorMessage(error) });
      this.emit('error', 'checkins', errorMessage(error));
      throw error;
    }
  }

  /**
   * Stop check-ins still scheduled, sending, or paused: nothing more of
   * them goes out.
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
    this.emit('log', 'GOON.VC', `check-ins stopped${by ? ` by ${by}` : ''}${cancelled ? `; ${cancelled} not sent` : ''}`);
    return { cancelled };
  }

  async _drafts () {
    const existing = this.campaigns.list();
    return checkin.drafts(this.contract).map(({ tier, draft }) => ({
      tier,
      step: checkin.plan(draft, existing, { spacingDays: this.contract.spacingDays, now: this.settings.now() })
    }));
  }

  async _previewStep ({ tier, step }) {
    const campaigns = this.campaigns;
    const definition = this.contract.tiers.find((entry) => entry.id === tier);
    const base = { id: tier, name: definition.name, message: step.draft.content.text, campaign: step.id };
    if (step.action === 'busy' || step.action === 'keep') {
      const current = campaigns.campaign(step.id);
      return Object.assign(base, { status: current.status, reach: current.stats ? current.stats.targeted || 0 : 0, recipients: [] });
    }
    const saved = step.action === 'create'
      ? await campaigns.create(step.draft, { owner: step.draft.owner, by: BY })
      : await campaigns.update(step.id, { title: step.draft.title, content: step.draft.content, filter: step.draft.filter }, { by: BY });
    const counts = await campaigns.preview(saved.id);
    return Object.assign(base, {
      campaign: saved.id,
      status: 'draft',
      preview: counts.id,
      recipients: (counts.recipients || []).map((recipient) => recipient.name || 'Unnamed member'),
      reach: counts.reach,
      found: counts.found,
      active: counts.active || 0,
      inactive: counts.inactive || 0,
      unseen: counts.unseen || 0,
      optedOut: counts.optedOut || 0,
      excluded: counts.excluded || 0
    });
  }

  _assertAvailable () {
    if (!this.campaigns) throw Object.assign(new Error('Campaigns are not running here, so check-ins can’t either.'), { status: 503 });
    if (!this.available) throw Object.assign(new Error('There are no check-ins set up (contracts/checkin.json).'), { status: 503 });
  }

  async _save (patch) {
    this.state = Object.assign({}, this.state, patch);
    if (this.store) await this.store.set(STATE_KEY, this.state);
  }

  /**
   * Express middleware for `GET /services/checkins` ({@link Checkins#status}).
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

module.exports = Checkins;
module.exports.PATH = PATH;
