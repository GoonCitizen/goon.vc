'use strict';

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Key = require('@fabric/core/types/key');
const { fabricIdentityIdFromPubkeyHex } = require('@fabric/core/functions/fabricIdentitySchnorr');
const { accountKey } = require('../functions/accountKey');
const { memberIsAdmin } = require('../functions/siteAdmin');
const Members = require('../services/members');
const Admin = require('../services/admin');

describe('Admin panel', function () {
  this.timeout(20000);

  const key = new Key();
  const identityId = fabricIdentityIdFromPubkeyHex(key.pubkey);
  const admins = [{ name: 'remaeus', discord: '420222636954615808', fabric: identityId }];
  let members;
  let admin;
  let server;
  let port;
  let storePath;
  let adminToken;
  let otherToken;
  let claimToken;
  let otherName;

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
          resolve({ status: res.statusCode, headers: res.headers, json, text });
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  before(async function () {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-admin-'));
    members = new Members({
      path: storePath,
      review: true,
      isAdmin: (member) => memberIsAdmin(member, admins)
    });
    await members.start();
    const operator = await members.memberFor('discord:420222636954615808', {
      create: true,
      via: 'oauth',
      profile: { username: 'remaeus', globalName: 'remaeus' }
    });
    await members.link(operator.id, accountKey('fabric', key.pubkey).key, {
      via: 'passport',
      profile: { pubkeyHex: key.pubkey }
    });
    await members.link(operator.id, 'rsi:ChairmanPoW', { via: 'bio', profile: { displayName: 'Chairman PoW' } });
    const other = await members.memberFor('discord:111111111111111111', {
      create: true,
      via: 'command',
      inGuild: false,
      profile: { username: 'pilot', globalName: 'Pilot' }
    });
    const kept = await members.memberFor('discord:222222222222222222', {
      create: true,
      via: 'command',
      inGuild: true,
      profile: { username: 'kept', globalName: 'Kept' }
    });
    otherName = other.displayName;
    await members.requestReview(other.id);
    await members.requestReview(kept.id);
    adminToken = await members._createSession(operator.id, 'discord');
    otherToken = await members._createSession(other.id, 'discord');
    claimToken = await members._createSession(operator.id, 'rsi-link');

    admin = new Admin({
      members,
      admins,
      reviews: { available: true },
      checkins: { status: () => ({ available: true, lastRunAt: '2026-11-01T00:00:00.000Z', lastRun: [{ tier: 'old', reach: 2, status: 'sent' }], sending: 0, error: null }) },
      welcome: { status: () => ({ available: true, lastRunAt: null, lastRun: null, welcomed: 4, sending: 1, error: null }) },
      community: {
        campaigns: {
          list: () => [{
            id: 'camp',
            title: 'Welcome: join PERMAFLEET',
            status: 'sending',
            owner: { kind: 'guild', guildId: '999999999999999999', guildName: 'G00N SQUAD' },
            stats: { targeted: 4, sent: 1, pending: 3 },
            recipients: ['secret-person'],
            updatedAt: '2026-11-02T00:00:00.000Z'
          }]
        }
      }
    });
    const adminMw = admin.middleware();
    const membersMw = members.middleware();
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        if (chunks.length) {
          try { req.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) { req.body = {}; }
        }
        adminMw(req, res, () => membersMw(req, res, () => {
          res.statusCode = 404;
          res.end();
        }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async function () {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (members) await members.stop();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('is 401 signed out, 404 for anyone else, and closed to a claim-link session', async function () {
    assert.strictEqual((await request('/services/admin')).status, 401);
    const stranger = await request('/services/admin', { headers: { Cookie: `goon.member=${otherToken}` } });
    assert.strictEqual(stranger.status, 404);
    assert.strictEqual(stranger.json.error, 'Not found');
    assert.ok(!stranger.text.includes('ChairmanPoW'));
    assert.ok(!stranger.text.includes(otherName));
    const claim = await request('/services/admin', { headers: { Cookie: `goon.member=${claimToken}` } });
    assert.strictEqual(claim.status, 404);
    assert.strictEqual((await request('/services/admin', { method: 'POST', headers: { Cookie: `goon.member=${adminToken}` } })).status, 405);
  });

  it('lists linked accounts, campaign status, and who is waiting', async function () {
    const res = await request('/services/admin', { headers: { Cookie: `goon.member=${adminToken}` } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.headers['cache-control'], 'no-store');
    assert.ok(!res.json.members.some((member) => member.displayName === 'Pilot'), 'a command does not count as a signed-in profile');
    const operator = res.json.members.find((member) => member.displayName === 'remaeus');
    const accounts = Object.fromEntries(operator.accounts.map((account) => [account.platform, account]));
    assert.strictEqual(accounts.discord.id, '420222636954615808');
    assert.strictEqual(accounts.discord.label, '@remaeus');
    assert.strictEqual(accounts.fabric.identityId, identityId);
    assert.strictEqual(accounts.rsi.id, 'ChairmanPoW');
    assert.ok(accounts.rsi.url.includes('ChairmanPoW'));
    assert.strictEqual(accounts.fabric.escrow, null);
    const waiting = res.json.reviews.pending;
    assert.strictEqual(waiting.length, 2);
    assert.strictEqual(waiting[0].displayName, otherName);
    assert.strictEqual(waiting[0].inGuild, false);
    assert.strictEqual(waiting[0].discord.id, '111111111111111111');
    assert.strictEqual(waiting[0].discord.username, 'pilot');
    const decided = await request(`/services/admin/reviews/${waiting[0].id}`, {
      method: 'POST',
      headers: { Cookie: `goon.member=${adminToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision: 'approved' })
    });
    assert.strictEqual(decided.status, 200, decided.text);
    assert.strictEqual(decided.json.decision, 'approved');
    assert.deepStrictEqual(decided.json.reviews.pending.map((member) => member.displayName), ['Kept']);
    assert.strictEqual(res.json.campaigns.list.length, 1);
    assert.strictEqual(res.json.campaigns.list[0].status, 'sending');
    assert.strictEqual(res.json.campaigns.list[0].owner.name, 'G00N SQUAD');
    assert.strictEqual(res.json.campaigns.list[0].stats.pending, 3);
    assert.ok(!res.text.includes('999999999999999999'));
    assert.ok(!res.text.includes('secret-person'));
    assert.strictEqual(res.json.checkins.lastRun[0].reach, 2);
    assert.strictEqual(res.json.welcome.welcomed, 4);
    assert.strictEqual(res.json.welcome.sending, 1);

    const session = await request('/services/members/session', { headers: { Cookie: `goon.member=${adminToken}` } });
    assert.strictEqual(session.json.member.admin, true);
    assert.ok(!Object.prototype.hasOwnProperty.call(session.json.member, 'accounts'));
    const otherSession = await request('/services/members/session', { headers: { Cookie: `goon.member=${otherToken}` } });
    assert.ok(!otherSession.json.member.admin);
  });
});
