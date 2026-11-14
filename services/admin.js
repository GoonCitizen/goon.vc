'use strict';

/**
 * Operator panel (`GET /services/admin`). Signed out is 401. Anyone who is
 * not an admin, including a one-time RSI claim-link session, is 404. The
 * body lists members and their linked accounts, campaign status, check-ins,
 * welcome DMs, and officers waiting for review. Approve and turn away act on
 * one officer at a time. It does not send campaigns.
 */

const home = require('../contracts/goon-squad.json');
const rsiCitizen = require('../functions/rsiCitizen');
const { memberIsAdmin, fabricIdentityId } = require('../functions/siteAdmin');
const { linkedAccounts, signedInMember } = require('./members');

const PATH = '/services/admin';
const MEMBER_ID_RE = /^[0-9a-f]{16}$/;
const CAMPAIGN_RANK = { sending: 0, scheduled: 1, paused: 2, draft: 3, sent: 4, cancelled: 5 };

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function accountView (account) {
  const profile = account.profile || {};
  const identityId = fabricIdentityId(account);
  let label = account.id;
  if (account.platform === 'discord') label = profile.username ? `@${profile.username}` : account.id;
  else if (account.platform === 'fabric') label = identityId || `${String(account.id).slice(0, 8)}…${String(account.id).slice(-6)}`;
  else if (account.platform === 'rsi') label = account.id;
  return {
    platform: account.platform,
    id: account.id,
    identityId,
    label,
    name: profile.globalName || profile.name || profile.displayName || null,
    username: profile.username || null,
    via: account.via || null,
    linkedAt: account.linkedAt || null,
    url: account.platform === 'rsi' ? rsiCitizen.citizenUrl(account.id) : null,
    escrow: account.cosigner ? account.cosigner.network : null
  };
}

function memberView (member) {
  const review = member.review && member.review.status
    ? { status: member.review.status, requestedAt: member.review.requestedAt || null, reviewedAt: member.review.reviewedAt || null }
    : null;
  return {
    id: member.id,
    displayName: member.displayName || null,
    inGuild: member.inGuild === true,
    createdAt: member.createdAt || null,
    lastLoginAt: member.lastLoginAt || null,
    review,
    accounts: linkedAccounts(member).map(accountView)
  };
}

function campaignView (campaign) {
  const owner = campaign.owner || {};
  const stats = campaign.stats || {};
  return {
    id: campaign.id,
    title: campaign.title || null,
    status: campaign.status || null,
    sendAt: campaign.sendAt || null,
    startedAt: campaign.startedAt || null,
    finishedAt: campaign.finishedAt || null,
    createdAt: campaign.createdAt || null,
    updatedAt: campaign.updatedAt || null,
    owner: owner.kind === 'guild'
      ? { kind: 'guild', name: owner.guildName || null }
      : { kind: owner.kind === 'staff' || owner.kind == null ? 'staff' : String(owner.kind) },
    stats: {
      targeted: stats.targeted || 0,
      sent: stats.sent || 0,
      failed: stats.failed || 0,
      pending: stats.pending || 0,
      optedOut: stats.optedOut || 0,
      stopped: stats.stopped || 0
    }
  };
}

function waitingView (member, officerOf) {
  const discord = (member.accounts || []).find((account) => account.platform === 'discord');
  const profile = (discord && discord.profile) || {};
  const symbols = typeof officerOf === 'function' ? officerOf(member) : [];
  return {
    id: member.id,
    displayName: member.displayName || null,
    inGuild: member.inGuild === true,
    requestedAt: member.review && member.review.requestedAt || null,
    discord: discord ? {
      id: discord.id,
      username: profile.username || null,
      name: profile.globalName || null
    } : null,
    rsi: (member.accounts || []).filter((account) => account.platform === 'rsi').map((account) => ({
      id: account.id,
      url: rsiCitizen.citizenUrl(account.id)
    })),
    fabric: (member.accounts || []).filter((account) => account.platform === 'fabric').map((account) => ({
      id: account.id,
      identityId: fabricIdentityId(account)
    })),
    officers: Array.isArray(symbols) ? symbols.map(String) : []
  };
}

function safeCall (fn, fallback) {
  try {
    const value = fn();
    return value == null ? fallback : value;
  } catch (_) {
    return fallback;
  }
}

/**
 * @param {Object} store `@fabric/core` Store the members service holds.
 * @returns {Promise<Object[]>}
 */
async function listMemberRecords (store) {
  const seen = new Map();
  const take = (value) => {
    if (!value || typeof value !== 'object' || value.mergedInto) return;
    if (!MEMBER_ID_RE.test(String(value.id || '')) || !Array.isArray(value.accounts)) return;
    seen.set(value.id, value);
  };
  const memory = store && store._state && store._state.content && store._state.content.members;
  if (memory && typeof memory === 'object' && !Array.isArray(memory)) {
    for (const value of Object.values(memory)) take(value);
  }
  if (store && store.db && typeof store.db.keys === 'function') {
    for await (const key of store.db.keys({ gte: '/members/', lt: '/members0' })) {
      if (!/^\/members\/[0-9a-f]{16}$/.test(String(key))) continue;
      take(await store.get(key));
    }
  }
  return [...seen.values()];
}

class Admin {
  /**
   * @param {Object} settings
   * @param {Object} settings.members Members service.
   * @param {Object} [settings.community] Community service (campaigns live on it).
   * @param {Object} [settings.checkins]
   * @param {Object} [settings.welcome]
   * @param {Object} [settings.reviews]
   * @param {Function} [settings.officerOf] `(member) => string[]` org symbols.
   * @param {Array} [settings.admins] Defaults to `contracts/goon-squad.json`.
   */
  constructor (settings = {}) {
    this.members = settings.members || null;
    this.community = settings.community || null;
    this.checkins = settings.checkins || null;
    this.welcome = settings.welcome || null;
    this.reviews = settings.reviews || null;
    this.officerOf = typeof settings.officerOf === 'function' ? settings.officerOf : () => [];
    this.admins = settings.admins === undefined ? home.admins : settings.admins;
  }

  /**
   * @param {Object|null} current `{ member, via }` from `Members#currentMember`.
   * @returns {boolean}
   */
  allows (current) {
    if (!current || !current.member || current.via === 'rsi-link') return false;
    return memberIsAdmin(current.member, this.admins);
  }

  /**
   * @returns {Promise<Object>}
   */
  async snapshot () {
    const records = this.members && this.members.store ? await listMemberRecords(this.members.store) : [];
    const members = records
      .filter((member) => signedInMember(member))
      .map((member) => memberView(member))
      .sort((a, b) => String(a.displayName || '').localeCompare(String(b.displayName || '')) || a.id.localeCompare(b.id));

    const campaignsPlugin = this.community && this.community.campaigns;
    const campaigns = {
      available: !!(campaignsPlugin && typeof campaignsPlugin.list === 'function'),
      list: []
    };
    if (campaigns.available) {
      const listed = safeCall(() => campaignsPlugin.list(), []);
      campaigns.list = (Array.isArray(listed) ? listed : []).map(campaignView).sort((a, b) => {
        const rank = (CAMPAIGN_RANK[a.status] ?? 9) - (CAMPAIGN_RANK[b.status] ?? 9);
        return rank || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
      });
    }

    const checkins = this.checkins && typeof this.checkins.status === 'function'
      ? safeCall(() => this.checkins.status(), { available: false })
      : { available: false };
    const welcome = this.welcome && typeof this.welcome.status === 'function'
      ? safeCall(() => this.welcome.status(), { available: false })
      : { available: false };

    let pending = [];
    if (this.members && this.members.reviewsEnabled && typeof this.members.pendingReviews === 'function') {
      const waiting = await this.members.pendingReviews();
      pending = (waiting || []).map((member) => waitingView(member, this.officerOf));
    }
    const reviews = {
      available: !!(this.reviews && this.reviews.available),
      pending
    };

    return { members, campaigns, checkins, welcome, reviews };
  }

  async decide (memberId, decision, by) {
    if (!MEMBER_ID_RE.test(String(memberId || ''))) {
      const error = new Error('Unknown member');
      error.status = 404;
      throw error;
    }
    if (decision !== 'approved' && decision !== 'denied') {
      const error = new Error('Choose approve or turn away.');
      error.status = 400;
      throw error;
    }
    const result = await this.members.decideReview(memberId, decision, { by });
    if (!result.changed) {
      const error = new Error(result.status ? `Already ${result.status}.` : 'That sign-in is not waiting.');
      error.status = 409;
      throw error;
    }
    const reviews = (await this.snapshot()).reviews;
    return {
      ok: true,
      decision,
      member: { id: result.member.id, displayName: result.member.displayName || null },
      reviews
    };
  }

  _reviewerKey (member) {
    const discord = (member.accounts || []).find((account) => account.platform === 'discord');
    return discord ? `discord:${discord.id}` : `member:${member.id}`;
  }

  /**
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      const method = String(req.method || 'GET').toUpperCase();
      const reviewPath = pathname.startsWith(`${PATH}/reviews/`) ? pathname.slice(`${PATH}/reviews/`.length) : null;
      if (pathname !== PATH && reviewPath == null) return next();
      if (pathname === PATH && method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      if (reviewPath != null && method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
      Promise.resolve(this.members && this.members.currentMember(req)).then(async (current) => {
        if (!current) return sendJson(res, 401, { error: 'Not signed in' });
        if (!this.allows(current)) return sendJson(res, 404, { error: 'Not found' });
        if (reviewPath != null) {
          const body = await this.decide(reviewPath.toLowerCase(), req.body && req.body.decision, this._reviewerKey(current.member));
          return sendJson(res, 200, body);
        }
        const body = await this.snapshot();
        return sendJson(res, 200, Object.assign({ ok: true, you: { id: current.member.id, displayName: current.member.displayName || null } }, body));
      }).catch((error) => {
        if (res.headersSent) return;
        const status = error && error.status >= 400 && error.status < 500 ? error.status : 500;
        sendJson(res, status, { error: status === 500 ? 'Could not load the admin panel' : error.message });
        if (status === 500 && this.members && typeof this.members.emit === 'function') {
          this.members.emit('error', 'admin', error && error.message ? error.message : error);
        }
      });
    };
  }
}

module.exports = Admin;
module.exports.PATH = PATH;
module.exports.listMemberRecords = listMemberRecords;
module.exports.campaignView = campaignView;
