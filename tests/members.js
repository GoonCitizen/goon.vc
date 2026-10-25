'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Members = require('../services/members');

const MEMBER_ID = /^[0-9a-f]{16}$/;
const key = (byte) => byte.repeat(32);

function jsonResponse (status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('Members', function () {
  this.timeout(20000);

  let members;
  let server;
  let port;
  let storePath;
  const calls = [];
  let discordUser = { id: '424242424242', username: 'goon', global_name: 'Goon', avatar: 'abc' };
  const hubSessions = {
    signedsession1: { status: 'signed', identity: { id: 'fabric-id-1' }, pubkeyHex: '02' + key('11') },
    signedsession2: { status: 'signed', identity: { id: 'fabric-id-2' }, pubkeyHex: '03' + key('22') },
    pendingsession: { status: 'pending' }
  };
  const clusters = {};

  function stubFetch (url, opts = {}) {
    calls.push({ url, opts });
    if (url === 'https://discord.com/api/v10/oauth2/token') {
      const body = new URLSearchParams(opts.body);
      if (body.get('code') !== 'good-code') return Promise.resolve(jsonResponse(400, { error: 'invalid_grant' }));
      return Promise.resolve(jsonResponse(200, { access_token: 'discord-access' }));
    }
    if (url === 'https://discord.com/api/v10/users/@me') {
      return Promise.resolve(jsonResponse(200, discordUser));
    }
    if (url === 'https://discord.com/api/v10/users/@me/guilds') {
      return Promise.resolve(jsonResponse(200, [{ id: '1190527980120850493' }]));
    }
    if (url.startsWith('http://down.test/')) {
      return Promise.reject(new TypeError('fetch failed'));
    }
    const cluster = /^http:\/\/hub\.test\/identity\/cluster\?pubkey=([0-9a-f]+)$/.exec(url);
    if (cluster) {
      const list = clusters[cluster[1]];
      return Promise.resolve(list ? jsonResponse(200, { type: 'IdentityCluster', data: { members: list } }) : jsonResponse(404, {}));
    }
    const session = /^http:\/\/hub\.test\/sessions\/(\w+)$/.exec(url);
    if (session && hubSessions[session[1]]) {
      if (session[1] === 'signedsession1' && opts.headers['X-Fabric-Poll-Secret'] !== 'poll-secret') return Promise.resolve(jsonResponse(403, {}));
      return Promise.resolve(jsonResponse(200, hubSessions[session[1]]));
    }
    return Promise.resolve(jsonResponse(404, {}));
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
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch (_) {}
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(JSON.stringify(opts.body));
      req.end();
    });
  }

  function cookieFrom (res) {
    const raw = [].concat(res.headers['set-cookie'] || [])[0] || '';
    return raw.split(';')[0];
  }

  async function passport (sessionId, pubkeyHex, opts = {}) {
    hubSessions[sessionId] = { status: 'signed', identity: { id: opts.identityId, name: opts.name }, pubkeyHex };
    return request('/services/members/passport', {
      method: 'POST',
      headers: opts.cookie ? { Cookie: opts.cookie } : {},
      body: Object.assign({ sessionId }, opts.link ? { link: true } : {})
    });
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

  before(async function () {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-members-'));
    members = new Members({
      path: storePath,
      hubOrigin: 'http://hub.test',
      fetch: stubFetch,
      discord: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        redirectUri: 'https://goon.vc/services/members/discord/callback',
        guildId: '1190527980120850493'
      }
    });
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
  });

  after(async function () {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (members) await members.stop();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('ignores paths outside /services/members', async function () {
    const res = await request('/services/rpc');
    assert.strictEqual(res.status, 418);
  });

  it('signs in with Discord and stores the member', async function () {
    const start = await request('/services/members/discord');
    assert.strictEqual(start.status, 302);
    const authorize = new URL(start.headers.location);
    assert.strictEqual(authorize.origin + authorize.pathname, 'https://discord.com/oauth2/authorize');
    assert.strictEqual(authorize.searchParams.get('client_id'), 'client-id');
    assert.strictEqual(authorize.searchParams.get('redirect_uri'), 'https://goon.vc/services/members/discord/callback');
    const state = authorize.searchParams.get('state');
    assert.ok(new RegExp(`^goon\\.oauth=${state}; Path=/services/members/discord; HttpOnly`).test(start.headers['set-cookie']));

    const elsewhere = await request(`/services/members/discord/callback?code=good-code&state=${state}`);
    assert.strictEqual(elsewhere.headers.location, '/sessions?error=expired_state', 'another browser cannot finish the login');

    const callback = await request(`/services/members/discord/callback?code=good-code&state=${state}`, { headers: { Cookie: `goon.oauth=${state}` } });
    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.location, '/sessions?signedIn=discord');
    const cookie = cookieFrom(callback);
    assert.ok(/^goon\.member=[0-9a-f]{64}$/.test(cookie));
    assert.ok(/HttpOnly/.test(callback.headers['set-cookie'][0]));

    const replay = await request(`/services/members/discord/callback?code=good-code&state=${state}`, { headers: { Cookie: `goon.oauth=${state}` } });
    assert.strictEqual(replay.headers.location, '/sessions?error=expired_state');

    const session = await request('/services/members/session', { headers: { Cookie: cookie } });
    assert.strictEqual(session.status, 200);
    assert.ok(MEMBER_ID.test(session.json.member.id));
    assert.strictEqual(session.json.member.provider, 'discord');
    assert.deepStrictEqual(session.json.member.platforms, ['discord']);
    assert.strictEqual(session.json.member.displayName, 'Goon');
    assert.strictEqual(session.json.member.inGuild, true);

    const stored = await members.getMember('discord:424242424242');
    assert.strictEqual(stored.id, session.json.member.id);
    assert.strictEqual(stored.accounts[0].profile.username, 'goon');
    assert.strictEqual(stored.accounts[0].via, 'oauth');
    assert.ok(!JSON.stringify(stored).includes('discord-access'));

    const again = await discordLogin(discordUser);
    const second = await request('/services/members/session', { headers: { Cookie: cookieFrom(again) } });
    assert.strictEqual(second.json.member.id, stored.id, 'the same account signs in to the same member');
  });

  it('signs in through the bot\'s application when no client id is set', async function () {
    let lookups = 0;
    const borrowed = new Members({
      path: fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-members-app-')),
      fetch: stubFetch,
      discord: { clientSecret: 'client-secret', applicationId: async () => { lookups += 1; return lookups === 1 ? null : 'bot-app-id'; } }
    });
    await borrowed.start();
    const mw = borrowed.middleware();
    const run = (url, cookie) => new Promise((resolve) => {
      const res = { headers: {}, setHeader (k, v) { this.headers[k.toLowerCase()] = v; }, end () { resolve(this); } };
      mw({ method: 'GET', url, headers: Object.assign({ host: 'goon.vc', 'x-forwarded-proto': 'https' }, cookie ? { cookie } : {}) }, res, () => resolve(null));
    });
    try {
      assert.strictEqual(borrowed.discordEnabled, true);
      assert.strictEqual((await run('/services/members/discord')).headers.location, '/sessions?error=discord_unavailable', 'Discord unreachable');
      const start = await run('/services/members/discord');
      const authorize = new URL(start.headers.location);
      assert.strictEqual(authorize.searchParams.get('client_id'), 'bot-app-id');
      assert.strictEqual(authorize.searchParams.get('redirect_uri'), 'https://goon.vc/services/members/discord/callback');
      const state = authorize.searchParams.get('state');
      const callback = await run(`/services/members/discord/callback?code=good-code&state=${state}`, `goon.oauth=${state}`);
      assert.strictEqual(callback.headers.location, '/sessions?signedIn=discord');
      const exchange = calls.filter((c) => c.url.endsWith('/oauth2/token')).pop();
      assert.strictEqual(new URLSearchParams(exchange.opts.body).get('client_id'), 'bot-app-id');
      assert.strictEqual(lookups, 2, 'looked up once it answered');
      assert.strictEqual(new Members({ discord: { applicationId: async () => 'x' } }).discordEnabled, false, 'needs the client secret');
    } finally {
      await borrowed.stop();
    }
  });

  it('reads the client secret from the bot\'s secrets file', function () {
    const { resolveDiscordClientSecret } = require('../functions/resolveDiscordToken');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-secrets-'));
    const file = path.join(dir, 'discord.secrets.json');
    fs.writeFileSync(file, JSON.stringify({ token: 'bot', appSecret: 'from-file' }));
    try {
      assert.deepStrictEqual(resolveDiscordClientSecret({}, { env: {}, candidates: [file] }), { clientSecret: 'from-file', source: file });
      assert.strictEqual(resolveDiscordClientSecret({}, { env: { DISCORD_APP_SECRET: 'from-env' }, candidates: [file] }).clientSecret, 'from-env');
      assert.deepStrictEqual(resolveDiscordClientSecret({}, { env: {}, candidates: [path.join(dir, 'none.json')] }), { clientSecret: null, source: null });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects a callback with an unknown state', async function () {
    const res = await request(`/services/members/discord/callback?code=good-code&state=${'0'.repeat(64)}`);
    assert.strictEqual(res.headers.location, '/sessions?error=expired_state');
  });

  it('signs in with a Hub-signed Passport session once', async function () {
    const pending = await request('/services/members/passport', {
      method: 'POST',
      body: { sessionId: 'pendingsession', pollSecret: 'x' }
    });
    assert.strictEqual(pending.status, 202);
    assert.strictEqual(pending.json.status, 'pending');

    const res = await request('/services/members/passport', {
      method: 'POST',
      body: { sessionId: 'signedsession1', pollSecret: 'poll-secret' }
    });
    assert.strictEqual(res.status, 200);
    assert.ok(MEMBER_ID.test(res.json.member.id));
    assert.strictEqual(res.json.member.provider, 'passport');
    assert.deepStrictEqual(res.json.member.platforms, ['fabric']);
    assert.strictEqual((await members.resolve(`fabric:${key('11')}`)).id, res.json.member.id);
    const cookie = cookieFrom(res);

    const again = await request('/services/members/passport', {
      method: 'POST',
      body: { sessionId: 'signedsession1', pollSecret: 'poll-secret' }
    });
    assert.strictEqual(again.status, 409);

    const logout = await request('/services/members/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.strictEqual(logout.status, 200);
    const after = await request('/services/members/session', { headers: { Cookie: cookie } });
    assert.strictEqual(after.status, 401);
  });

  it('polls the next Hub when one cannot be reached', async function () {
    const { createHubList } = require('../functions/hubApiProxy');
    const saved = members.hubs;
    members.hubs = createHubList(['http://down.test', 'http://hub.test']);
    try {
      const res = await request('/services/members/passport', {
        method: 'POST',
        body: { sessionId: 'signedsession2' }
      });
      assert.strictEqual(res.status, 200);
      assert.strictEqual((await members.resolve(`fabric:${key('22')}`)).id, res.json.member.id);
      assert.strictEqual(members.hubs.order()[0], 'http://hub.test');

      members.hubs = createHubList(['http://down.test']);
      const down = await request('/services/members/passport', {
        method: 'POST',
        body: { sessionId: 'pendingsession' }
      });
      assert.strictEqual(down.status, 502);
    } finally {
      members.hubs = saved;
    }
  });

  it('adopts members saved before accounts, keeping old sessions', async function () {
    await members.store.set('/members/discord:777777777', {
      id: 'discord:777777777',
      createdAt: '2026-01-01T00:00:00.000Z',
      provider: 'discord',
      discord: { id: '777777777', username: 'veteran', globalName: 'Veteran' },
      displayName: 'Old Timer',
      inGuild: true
    });
    await members.store.set('/members/fabric:fabric-id-9', {
      id: 'fabric:fabric-id-9',
      createdAt: '2026-01-02T00:00:00.000Z',
      provider: 'passport',
      fabric: { id: 'fabric-id-9', pubkeyHex: '02' + key('99') },
      displayName: 'Keyholder'
    });
    const token = await members._createSession('discord:777777777');
    const session = await request('/services/members/session', { headers: { Cookie: `goon.member=${token}` } });
    assert.strictEqual(session.status, 200);
    assert.ok(MEMBER_ID.test(session.json.member.id));
    assert.strictEqual(session.json.member.displayName, 'Old Timer');
    assert.strictEqual(session.json.member.createdAt, '2026-01-01T00:00:00.000Z');
    assert.strictEqual((await members.resolve('discord:777777777')).id, session.json.member.id, 'adopted once');
    assert.strictEqual((await members.memberFor('discord:777777777')).id, session.json.member.id);

    const keyholder = await passport('legacykey1', '02' + key('99'), { identityId: 'fabric-id-9' });
    assert.strictEqual(keyholder.json.member.displayName, 'Keyholder');
    assert.strictEqual((await members.resolve('fabric:fabric-id-9')).id, keyholder.json.member.id);
  });

  it('links Discord to a signed-in member', async function () {
    const signedIn = await passport('linkdiscord1', '02' + key('31'));
    const cookie = cookieFrom(signedIn);
    const linked = await discordLogin({ id: '500100000', username: 'fresh', global_name: 'Fresh' }, cookie);
    assert.strictEqual(linked.headers.location, '/sessions?linked=discord');
    assert.ok(!linked.headers['set-cookie'], 'a link keeps the session');

    const accounts = await request('/services/members/accounts', { headers: { Cookie: cookie } });
    assert.deepStrictEqual(accounts.json.accounts.map((a) => [a.platform, a.via]), [['fabric', 'passport'], ['discord', 'oauth']]);
    assert.strictEqual(accounts.json.accounts[1].label, '@fresh');
    assert.strictEqual((await members.resolve('discord:500100000')).id, signedIn.json.member.id);

    const anonymous = await request('/services/members/discord?link=1');
    assert.strictEqual(anonymous.headers.location, '/sessions?error=not_signed_in');
  });

  it('merges two members when one proves the other\'s account', async function () {
    const veteran = await members.linkDiscord({ id: '500200000', username: 'old' }, 'Old Name');
    const merges = [];
    members.on('merged', (event) => merges.push(event));
    const signedIn = await passport('mergesession1', '02' + key('41'), { name: 'Newcomer' });
    assert.strictEqual(signedIn.status, 200, JSON.stringify(signedIn.json));
    const cookie = cookieFrom(signedIn);
    assert.notStrictEqual(signedIn.json.member.id, veteran.id);

    const linked = await discordLogin({ id: '500200000', username: 'old', global_name: 'Old' }, cookie);
    assert.strictEqual(linked.headers.location, '/sessions?linked=discord&merged=1');
    assert.deepStrictEqual(merges, [{ from: signedIn.json.member.id, into: veteran.id }]);

    const session = await request('/services/members/session', { headers: { Cookie: cookie } });
    assert.strictEqual(session.json.member.id, veteran.id, 'the older member survives');
    assert.strictEqual(session.json.member.displayName, 'Old Name');
    assert.deepStrictEqual(session.json.member.platforms.sort(), ['discord', 'fabric']);
    assert.strictEqual((await members.resolve(signedIn.json.member.id)).id, veteran.id);
    assert.strictEqual((await members.resolve(`fabric:${key('41')}`)).id, veteran.id);
    const survivor = await members.resolve(veteran.id);
    assert.ok(survivor.log.some((entry) => entry.type === 'merge' && entry.from === signedIn.json.member.id));
  });

  it('links a Fabric identity to a signed-in member', async function () {
    const discord = await discordLogin({ id: '500300000', username: 'pilot', global_name: 'Pilot' });
    const cookie = cookieFrom(discord);
    const refused = await passport('linkfabric0', '02' + key('51'), { link: true });
    assert.strictEqual(refused.status, 401);

    const linked = await passport('linkfabric1', '02' + key('51'), { cookie, link: true });
    assert.strictEqual(linked.status, 200);
    assert.strictEqual(linked.json.linked, 'fabric');
    assert.strictEqual(linked.json.merged, false);
    assert.strictEqual(linked.json.member.provider, 'discord');
    assert.ok(!linked.headers['set-cookie']);
    assert.strictEqual((await members.resolve(`fabric:${key('51')}`)).id, (await members.resolve('discord:500300000')).id);
  });

  it('follows the Hub\'s device cluster for a Fabric key', async function () {
    clusters[key('61')] = [key('61'), key('62'), key('63')];
    const first = await passport('cluster1', '02' + key('61'));
    const cookie = cookieFrom(first);
    let accounts = (await request('/services/members/accounts', { headers: { Cookie: cookie } })).json.accounts;
    assert.deepStrictEqual(accounts.map((a) => [a.key, a.via]), [
      [`fabric:${key('61')}`, 'passport'],
      [`fabric:${key('62')}`, 'cluster'],
      [`fabric:${key('63')}`, 'cluster']
    ]);

    clusters[key('61')] = [key('61'), key('63')];
    assert.strictEqual((await passport('cluster2', '03' + key('61'))).status, 200);
    accounts = (await request('/services/members/accounts', { headers: { Cookie: cookie } })).json.accounts;
    assert.deepStrictEqual(accounts.map((a) => a.key), [`fabric:${key('61')}`, `fabric:${key('63')}`], 'a revoked device drops off');
    assert.strictEqual(await members.resolve(`fabric:${key('62')}`), null);

    delete clusters[key('61')];
    assert.strictEqual((await passport('cluster3', '02' + key('61'))).status, 200);
    accounts = (await request('/services/members/accounts', { headers: { Cookie: cookie } })).json.accounts;
    assert.strictEqual(accounts.length, 2, 'a Hub that cannot answer changes nothing');
  });

  it('unlinks accounts but never the last one', async function () {
    const res = await discordLogin({ id: '500400000', username: 'solo', global_name: 'Solo' });
    const cookie = cookieFrom(res);
    assert.strictEqual((await request('/services/members/accounts')).status, 401);
    assert.strictEqual((await request('/services/members/accounts/discord%3A500400000', { method: 'DELETE' })).status, 401);

    const only = await request('/services/members/accounts/discord%3A500400000', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.strictEqual(only.status, 409);

    clusters[key('71')] = [key('71'), key('72')];
    await passport('unlinksession1', '02' + key('71'), { cookie, link: true });
    const unknown = await request('/services/members/accounts/discord%3A999900000', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.strictEqual(unknown.status, 404);
    const dropped = await request(`/services/members/accounts/fabric%3A${key('71')}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.strictEqual(dropped.status, 200);
    assert.deepStrictEqual(dropped.json.accounts.map((a) => a.key), ['discord:500400000'], 'its cluster keys go with it');
    assert.strictEqual(await members.resolve(`fabric:${key('71')}`), null);
  });

  it('keeps members across a Store restart', async function () {
    await members.stop();
    members.store = null;
    await members.start();
    const stored = await members.getMember(`fabric:${key('11')}`);
    assert.strictEqual(stored.accounts[0].profile.pubkeyHex, '02' + key('11'));
    assert.strictEqual((await members.getMember('fabric:fabric-id-9')).displayName, 'Keyholder');
  });
});
