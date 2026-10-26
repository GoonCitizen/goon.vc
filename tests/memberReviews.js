'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Key = require('@fabric/core/types/key');
const passportCore = require('@fabric/core/functions/passport');
const Members = require('../services/members');

function jsonResponse (status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('Members reviews (waiting area)', function () {
  this.timeout(20000);

  let members;
  let server;
  let port;
  let storePath;
  let discordUser = null;
  let guilds = [{ id: '1190527980120850493' }];
  const events = [];

  function stubFetch (url, opts = {}) {
    if (url === 'https://discord.com/api/v10/oauth2/token') return Promise.resolve(jsonResponse(200, { access_token: 'discord-access' }));
    if (url === 'https://discord.com/api/v10/users/@me') return Promise.resolve(jsonResponse(200, discordUser));
    if (url === 'https://discord.com/api/v10/users/@me/guilds') return Promise.resolve(jsonResponse(200, guilds));
    return Promise.reject(new TypeError(`unexpected fetch ${url}`));
  }

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
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(JSON.stringify(opts.body));
      req.end();
    });
  }

  function cookieFrom (res, name = 'goon.member') {
    return ([].concat(res.headers['set-cookie'] || []).find((raw) => raw.startsWith(`${name}=`)) || '').split(';')[0];
  }

  async function discordLogin (user, cookie) {
    discordUser = user;
    const headers = cookie ? { Cookie: cookie } : {};
    const start = await request(`/services/members/discord${cookie ? '?link=1' : ''}`, { headers });
    const state = new URL(start.headers.location).searchParams.get('state');
    const oauth = `goon.oauth=${state}`;
    return request(`/services/members/discord/callback?code=good-code&state=${state}`, {
      headers: { Cookie: cookie ? `${cookie}; ${oauth}` : oauth }
    });
  }

  async function session (cookie) {
    const res = await request('/services/members/session', { headers: { Cookie: cookie } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    return res.json.member;
  }

  async function serve (review) {
    members = new Members({
      path: storePath,
      fetch: stubFetch,
      review,
      discord: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://goon.vc/services/members/discord/callback',
        guildId: '1190527980120850493'
      }
    });
    members.on('review', (event) => events.push(['review', event]));
    members.on('reviewed', (event) => events.push(['reviewed', event]));
    await members.start();
    const mw = members.middleware();
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        if (chunks.length) req.body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        mw(req, res, () => { res.statusCode = 418; res.end(); });
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  }

  async function shutdown () {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (members) await members.stop();
    server = null;
    members = null;
  }

  const veteran = { id: '100000000000000001', username: 'veteran', global_name: 'Veteran', avatar: null };
  const newcomer = { id: '100000000000000002', username: 'newbie', global_name: 'Newbie', avatar: null };
  const stranger = { id: '100000000000000003', username: 'stranger', global_name: 'Stranger', avatar: null };
  const latecomer = { id: '100000000000000004', username: 'late', global_name: 'Late', avatar: null };
  let newcomerCookie;

  before(async function () {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-reviews-'));
    await serve(false);
    const res = await discordLogin(veteran);
    assert.strictEqual(res.headers.location, '/sessions?signedIn=discord');
    assert.strictEqual((await session(cookieFrom(res))).review, undefined, 'reviews off: no review field');
    await shutdown();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await serve(true);
  });

  after(async function () {
    await shutdown();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('tells the page reviews are on', async function () {
    const res = await request('/services/members');
    assert.strictEqual(res.json.review, true);
  });

  it('counts members from before reviews began as approved', async function () {
    const res = await discordLogin(veteran);
    assert.strictEqual(res.headers.location, '/sessions?signedIn=discord');
    assert.deepStrictEqual((await session(cookieFrom(res))).review, { status: 'approved' });
    assert.strictEqual(events.length, 0, 'nobody joined the waiting area');
    assert.deepStrictEqual(await members.pendingReviews(), []);
  });

  it('puts a new Discord sign-in in the waiting area', async function () {
    const res = await discordLogin(newcomer);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/waiting?signedIn=discord');
    newcomerCookie = cookieFrom(res);
    const member = await session(newcomerCookie);
    assert.strictEqual(member.review.status, 'pending');
    assert.ok(!Number.isNaN(Date.parse(member.review.requestedAt)));
    assert.deepStrictEqual(Object.keys(member.review).sort(), ['requestedAt', 'status']);
    assert.deepStrictEqual(events, [['review', { member: member.id }]]);

    const pending = await members.pendingReviews();
    assert.deepStrictEqual(pending.map((m) => m.id), [member.id]);

    const again = await discordLogin(newcomer);
    assert.strictEqual(again.headers.location, '/waiting?signedIn=discord');
    assert.strictEqual(events.length, 1, 'signing in again does not queue twice');
    assert.strictEqual((await members.pendingReviews()).length, 1);
  });

  it('notes when reviewers were sent a waiting member', async function () {
    const [member] = await members.pendingReviews();
    await members.noteReviewsSent([member.id]);
    const [noted] = await members.pendingReviews();
    assert.ok(noted.review.notifiedAt);
    assert.strictEqual((await session(newcomerCookie)).review.notifiedAt, undefined, 'never served');
  });

  it('approves a waiting member once', async function () {
    const member = await session(newcomerCookie);
    await assert.rejects(members.decideReview(member.id, 'maybe'), /approved or denied/);
    const first = await members.decideReview(member.id, 'approved', { by: `discord:${veteran.id}` });
    assert.strictEqual(first.changed, true);
    assert.strictEqual(first.status, 'approved');
    const second = await members.decideReview(member.id, 'denied', { by: 'discord:1' });
    assert.deepStrictEqual([second.changed, second.status], [false, 'approved'], 'someone else already decided');
    assert.deepStrictEqual(events.slice(-1), [['reviewed', { member: member.id, status: 'approved' }]]);

    const view = await session(newcomerCookie);
    assert.strictEqual(view.review.status, 'approved');
    assert.ok(view.review.reviewedAt);
    assert.ok(!JSON.stringify(view).includes(veteran.id), 'the reviewer is not served');

    const stored = await members.getMember(member.id);
    assert.strictEqual(stored.review.reviewedBy, `discord:${veteran.id}`);
    assert.deepStrictEqual(stored.log.filter((e) => e.type === 'review').map((e) => e.status), ['pending', 'approved']);
    assert.deepStrictEqual(await members.pendingReviews(), []);

    const back = await discordLogin(newcomer);
    assert.strictEqual(back.headers.location, '/sessions?signedIn=discord', 'approved members skip the waiting area');
  });

  it('keeps a denied member waiting outside', async function () {
    guilds = [];
    const res = await discordLogin(stranger);
    guilds = [{ id: '1190527980120850493' }];
    const member = await session(cookieFrom(res));
    assert.strictEqual(member.inGuild, false);
    await members.decideReview(member.id, 'denied', { by: `discord:${veteran.id}` });
    const back = await discordLogin(stranger);
    assert.strictEqual(back.headers.location, '/waiting?signedIn=discord');
    assert.strictEqual((await session(cookieFrom(back))).review.status, 'denied');
  });

  it('queues a Passport member only when they link Discord', async function () {
    const started = await request('/services/members/passport/challenges', { method: 'POST' });
    const read = passportCore.readChallenge(started.json.challenge);
    const signed = passportCore.signAssertion({
      origin: read.challenge.origin,
      challenge: started.json.challenge,
      signer: 'passport',
      network: 'mainnet'
    }, new Key());
    const res = await request('/services/members/passport', {
      method: 'POST',
      headers: { Cookie: cookieFrom(started, 'goon.passport') },
      body: { assertion: signed.uri }
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const cookie = cookieFrom(res);
    assert.strictEqual((await session(cookie)).review, null, 'no Discord, no review');

    const linked = await discordLogin(latecomer, cookie);
    assert.strictEqual(linked.headers.location, '/sessions?linked=discord');
    assert.strictEqual((await session(cookie)).review.status, 'pending');
  });

  it('keeps the better review when two members merge', async function () {
    const waiting = (await members.pendingReviews()).map((m) => m.id);
    assert.strictEqual(waiting.length, 1);
    const latecomerMember = await members.resolve(`discord:${latecomer.id}`);
    const cookie = cookieFrom(await discordLogin(latecomer));
    assert.strictEqual((await session(cookie)).id, latecomerMember.id);

    // A member holds one Discord account, so the latecomer drops theirs (the
    // review stays) and the veteran proves the latecomer's RSI handle.
    await members.link(latecomerMember.id, 'rsi:LatePilot', { via: 'bio' });
    await members.unlink(latecomerMember.id, `discord:${latecomer.id}`);
    const veteranMember = await members.resolve(`discord:${veteran.id}`);
    const merged = await members.link(veteranMember.id, 'rsi:LatePilot', { via: 'bio' });
    assert.strictEqual(merged.merged, true);
    const member = await session(cookie);
    assert.strictEqual(member.review.status, 'approved', 'the approved side wins');
    assert.deepStrictEqual(await members.pendingReviews(), [], 'and leaves the waiting area');
  });
});
