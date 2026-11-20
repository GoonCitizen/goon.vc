'use strict';

/**
 * Operator campaigns (`/services/campaigns`). Signed out is 401. Anyone who
 * is not an admin is 404. The list and a campaign's own record are names,
 * the message, and counts. Preview adds the display names it would reach.
 * Send previews a draft, then starts it for that preview. Create saves a
 * draft from a script anyone may run; the message is optional.
 */

const home = require('../contracts/goon-squad.json');
const { memberIsAdmin } = require('../functions/siteAdmin');

const PATH = '/services/campaigns';
const ID_RE = /^[0-9a-f]{12}$/;

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function ownerView (owner) {
  const kind = owner && owner.kind === 'guild' ? 'guild' : 'staff';
  return kind === 'guild' ? { kind, name: (owner && owner.guildName) || null } : { kind: 'staff' };
}

function summary (row) {
  return {
    id: row.id,
    title: row.title || null,
    status: row.status || null,
    owner: ownerView(row.owner),
    sendAt: row.sendAt || null,
    startedAt: row.startedAt || null,
    finishedAt: row.finishedAt || null,
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    stats: row.stats || {}
  };
}

/**
 * One campaign an admin can read. No server id, and no one it was sent to.
 * @param {Object|null} campaign
 * @returns {Object|null}
 */
function inspect (campaign) {
  if (!campaign) return null;
  const content = campaign.content || {};
  const filter = campaign.filter || {};
  const preview = campaign.preview || null;
  return Object.assign(summary(campaign), {
    content: {
      type: content.type || 'message',
      text: content.text || '',
      script: content.script || null
    },
    filter: {
      roles: filter.roles || [],
      excludeRoles: filter.excludeRoles || [],
      activeWithinDays: filter.activeWithinDays || null,
      inactiveForDays: filter.inactiveForDays || null
    },
    createdBy: campaign.createdBy || null,
    preview: preview ? {
      id: preview.id || null,
      at: preview.at || null,
      reach: preview.reach || 0,
      over: !!preview.over
    } : null,
    log: (campaign.log || []).map((entry) => ({
      at: entry.at || null,
      type: entry.type || null,
      by: entry.by || null
    }))
  });
}

function discordId (member) {
  const account = (member.accounts || []).find((item) => item.platform === 'discord');
  return account ? String(account.id) : null;
}

class CampaignDesk {
  /**
   * @param {Object} settings
   * @param {Object} settings.members
   * @param {Object} [settings.community]
   * @param {Array} [settings.admins]
   */
  constructor (settings = {}) {
    this.members = settings.members || null;
    this.community = settings.community || null;
    this.admins = settings.admins === undefined ? home.admins : settings.admins;
  }

  allows (current) {
    if (!current || !current.member || current.via === 'rsi-link') return false;
    return memberIsAdmin(current.member, this.admins);
  }

  get campaigns () {
    return this.community && this.community.campaigns;
  }

  list () {
    const campaigns = this.campaigns;
    const scripts = this.scripts();
    if (!campaigns || typeof campaigns.list !== 'function') return { available: false, campaigns: [], scripts };
    const listed = campaigns.list();
    return { available: true, campaigns: (Array.isArray(listed) ? listed : []).map(summary), scripts };
  }

  /**
   * Scripts a campaign may offer: the ones with no `requires`.
   * @returns {Array<{ id: string, title: string }>}
   */
  scripts () {
    const community = this.community;
    if (!community || typeof community.campaignScripts !== 'function') return [];
    const listed = community.campaignScripts();
    return (Array.isArray(listed) ? listed : []).map((script) => ({
      id: String(script.id),
      title: script.title || String(script.id)
    })).filter((script) => /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(script.id));
  }

  /**
   * Save a draft for the home Discord from one of {@link CampaignDesk#scripts}.
   * @param {Object} input `{ script, message? }`
   * @param {{ by?: string }} [actor]
   * @returns {Promise<Object>}
   */
  async create (input, actor) {
    const campaigns = this.campaigns;
    if (!campaigns || typeof campaigns.create !== 'function') throw fail(404, 'Campaigns are not running.');
    const script = String(input && input.script || '').trim();
    const offered = this.scripts().find((entry) => entry.id === script);
    if (!offered) throw fail(400, 'Pick a script from the list.');
    const text = String(input && input.message || '').trim();
    if (text.length > 1800) throw fail(400, 'The message is too long.');
    const draft = await campaigns.create({
      title: text ? undefined : offered.title,
      content: { type: 'script', script: offered.id, text }
    }, {
      owner: { kind: 'guild', guildId: home.guildId, guildName: 'G00N SQUAD' },
      by: actor && actor.by || null
    });
    return inspect(draft);
  }

  get (id) {
    const campaigns = this.campaigns;
    if (!campaigns) throw fail(404, 'Campaigns are not running.');
    if (!ID_RE.test(String(id || ''))) throw fail(404, 'No such campaign');
    const campaign = campaigns.campaign(id);
    if (!campaign) throw fail(404, 'No such campaign');
    return inspect(campaign);
  }

  /**
   * Who a draft or scheduled campaign would reach, by display name.
   * @param {string} id
   * @returns {Promise<Object>}
   */
  async preview (id) {
    const campaigns = this.campaigns;
    if (!campaigns || typeof campaigns.preview !== 'function') throw fail(404, 'Campaigns are not running.');
    const shown = await campaigns.preview(id);
    return {
      id: shown.id,
      reach: shown.reach || 0,
      over: !!shown.over,
      recipients: (shown.recipients || []).map((recipient) => ({
        name: recipient.name || 'Unnamed member'
      }))
    };
  }

  /**
   * Preview a draft, then send that preview now. A campaign already
   * scheduled from a preview is sent with that preview.
   * @param {string} id
   * @param {{ by: string, discord: string }} actor
   * @returns {Promise<Object>}
   */
  async send (id, actor) {
    const campaigns = this.campaigns;
    if (!campaigns || typeof campaigns.schedule !== 'function') throw fail(404, 'Campaigns are not running.');
    if (!actor || !actor.discord) throw fail(403, 'Sign in with Discord to send a campaign.');
    const current = this.get(id);
    if (!['draft', 'scheduled'].includes(current.status)) {
      throw fail(409, `This campaign is ${current.status}.`);
    }
    let previewId = current.preview && current.preview.id;
    let recipients = null;
    if (current.status === 'draft') {
      const shown = await this.preview(id);
      previewId = shown.id;
      recipients = shown.recipients;
    }
    if (!previewId) throw fail(409, 'Preview this campaign before sending it.');
    const sent = await campaigns.schedule(id, { preview: previewId, by: actor.by, discord: actor.discord });
    return { campaign: inspect(sent), recipients };
  }

  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      if (pathname !== PATH && !pathname.startsWith(`${PATH}/`)) return next();
      const rest = pathname.slice(PATH.length).replace(/^\//, '');
      const parts = rest ? rest.split('/') : [];
      const method = String(req.method || 'GET').toUpperCase();
      Promise.resolve(this.members && this.members.currentMember(req)).then(async (current) => {
        if (!current) return sendJson(res, 401, { error: 'Not signed in' });
        if (!this.allows(current)) return sendJson(res, 404, { error: 'Not found' });
        if (parts.length === 0) {
          if (method === 'GET') return sendJson(res, 200, Object.assign({ ok: true }, this.list()));
          if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
          const campaign = await this.create(req.body || {}, { by: current.member.displayName || null });
          return sendJson(res, 200, { ok: true, campaign });
        }
        const id = parts[0];
        if (parts.length === 1) {
          if (method !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
          return sendJson(res, 200, { ok: true, campaign: this.get(id) });
        }
        if (parts.length === 2 && parts[1] === 'preview' && method === 'POST') {
          return sendJson(res, 200, Object.assign({ ok: true }, await this.preview(id)));
        }
        if (parts.length === 2 && parts[1] === 'send' && method === 'POST') {
          const discord = discordId(current.member);
          const sent = await this.send(id, { by: current.member.displayName || null, discord });
          return sendJson(res, 200, Object.assign({ ok: true }, sent));
        }
        return sendJson(res, 404, { error: 'Not found' });
      }).catch((error) => {
        if (res.headersSent) return;
        const status = error && error.status >= 400 && error.status < 500 ? error.status : 500;
        sendJson(res, status, { error: status === 500 ? 'Could not load campaigns' : error.message });
      });
    };
  }
}

module.exports = CampaignDesk;
module.exports.PATH = PATH;
module.exports.inspect = inspect;
module.exports.summary = summary;
