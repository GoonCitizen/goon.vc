'use strict';

const assert = require('assert');
const http = require('http');
const CampaignDesk = require('../services/campaignDesk');

const GUILD = '1190527980120850493';
const OPERATOR = '420222636954615808';

describe('campaign desk', function () {
  const admins = [{ name: 'remaeus', discord: OPERATOR }];
  let desk;
  let server;
  let port;
  let scheduled;

  const store = {
    abcdabcdabcd: {
      id: 'abcdabcdabcd',
      title: 'Fleet night',
      owner: { kind: 'guild', guildId: GUILD, guildName: 'G00N SQUAD' },
      status: 'draft',
      content: { type: 'script', script: 'welcome', text: '' },
      filter: { roles: ['777777777777777777'], excludeRoles: [], activeWithinDays: null, inactiveForDays: null, guilds: [GUILD] },
      createdBy: 'Kersa',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      sendAt: null,
      startedAt: null,
      finishedAt: null,
      preview: null,
      stats: { sent: 0, targeted: 0, pending: 0 },
      log: [{ at: '2026-11-01T00:00:00.000Z', type: 'create', by: 'Kersa' }],
      deliveries: { 'discord/users/999999999999999999': { status: 'pending' } }
    }
  };

  const campaigns = {
    list () {
      return Object.values(store).map((campaign) => ({
        id: campaign.id,
        title: campaign.title,
        owner: campaign.owner,
        status: campaign.status,
        stats: campaign.stats,
        createdAt: campaign.createdAt
      }));
    },
    campaign (id) { return store[id] || null; },
    async preview (id) {
      const campaign = store[id];
      campaign.preview = { id: 'preview1', at: '2026-11-02T00:00:00.000Z', reach: 1 };
      return { id: 'preview1', reach: 1, over: false, recipients: [{ name: 'Kersa', sourceName: 'G00N SQUAD' }] };
    },
    async schedule (id, options) {
      scheduled = options;
      store[id].status = 'sending';
      return store[id];
    }
  };

  function request (pathname, opts = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: Object.assign({ Accept: 'application/json' }, opts.headers || {})
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}
          resolve({ status: res.statusCode, json, text });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  before(async function () {
    const sessions = {
      admin: { via: 'discord', member: { displayName: 'remaeus', accounts: [{ platform: 'discord', id: OPERATOR }] } },
      other: { via: 'discord', member: { displayName: 'Pilot', accounts: [{ platform: 'discord', id: '111111111111111111' }] } }
    };
    desk = new CampaignDesk({
      admins,
      members: {
        currentMember (req) {
          const match = /goon\.member=([^;]+)/.exec(String(req.headers.cookie || ''));
          return match ? sessions[match[1]] || null : null;
        }
      },
      community: { campaigns }
    });
    const mw = desk.middleware();
    server = http.createServer((req, res) => mw(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(function () {
    if (server) server.close();
  });

  it('is 401 signed out and 404 for anyone else', async function () {
    assert.strictEqual((await request('/services/campaigns')).status, 401);
    const stranger = await request('/services/campaigns', { headers: { Cookie: 'goon.member=other' } });
    assert.strictEqual(stranger.status, 404);
  });

  it('lists campaigns without the server id or who a message went to', async function () {
    const res = await request('/services/campaigns', { headers: { Cookie: 'goon.member=admin' } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.json.campaigns.length, 1);
    assert.strictEqual(res.json.campaigns[0].title, 'Fleet night');
    assert.deepStrictEqual(res.json.campaigns[0].owner, { kind: 'guild', name: 'G00N SQUAD' });
    assert.ok(!res.text.includes(GUILD));
    assert.ok(!res.text.includes('999999999999999999'));
  });

  it('opens one campaign and sends a draft after previewing it', async function () {
    const opened = await request('/services/campaigns/abcdabcdabcd', { headers: { Cookie: 'goon.member=admin' } });
    assert.strictEqual(opened.status, 200, opened.text);
    assert.strictEqual(opened.json.campaign.content.script, 'welcome');
    assert.strictEqual(opened.json.campaign.content.text, '');
    assert.deepStrictEqual(opened.json.campaign.log, [{ at: '2026-11-01T00:00:00.000Z', type: 'create', by: 'Kersa' }]);
    assert.ok(!opened.text.includes('999999999999999999'));

    const shown = await request('/services/campaigns/abcdabcdabcd/preview', { method: 'POST', headers: { Cookie: 'goon.member=admin' } });
    assert.deepStrictEqual(shown.json.recipients, [{ name: 'Kersa' }]);

    const sent = await request('/services/campaigns/abcdabcdabcd/send', { method: 'POST', headers: { Cookie: 'goon.member=admin' } });
    assert.strictEqual(sent.status, 200, sent.text);
    assert.strictEqual(sent.json.campaign.status, 'sending');
    assert.deepStrictEqual(scheduled, { preview: 'preview1', by: 'remaeus', discord: OPERATOR });
    assert.deepStrictEqual(sent.json.recipients, [{ name: 'Kersa' }]);
    assert.ok(!sent.text.includes(GUILD));
  });

  it('refuses to send a campaign that is already on its way', async function () {
    store.abcdabcdabcd.status = 'sending';
    const sent = await request('/services/campaigns/abcdabcdabcd/send', { method: 'POST', headers: { Cookie: 'goon.member=admin' } });
    assert.strictEqual(sent.status, 409);
    assert.match(sent.json.error, /sending/);
  });
});
