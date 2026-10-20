'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Members = require('../services/members');

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

  function stubFetch (url, opts = {}) {
    calls.push({ url, opts });
    if (url === 'https://discord.com/api/v10/oauth2/token') {
      const body = new URLSearchParams(opts.body);
      if (body.get('code') !== 'good-code') return Promise.resolve(jsonResponse(400, { error: 'invalid_grant' }));
      return Promise.resolve(jsonResponse(200, { access_token: 'discord-access' }));
    }
    if (url === 'https://discord.com/api/v10/users/@me') {
      return Promise.resolve(jsonResponse(200, { id: '42', username: 'goon', global_name: 'Goon', avatar: 'abc' }));
    }
    if (url === 'https://discord.com/api/v10/users/@me/guilds') {
      return Promise.resolve(jsonResponse(200, [{ id: '1190527980120850493' }]));
    }
    if (url === 'http://hub.test/sessions/signedsession1') {
      if (opts.headers['X-Fabric-Poll-Secret'] !== 'poll-secret') return Promise.resolve(jsonResponse(403, {}));
      return Promise.resolve(jsonResponse(200, { status: 'signed', identity: { id: 'fabric-id-1' }, pubkeyHex: '02ab' }));
    }
    if (url === 'http://hub.test/sessions/pendingsession') {
      return Promise.resolve(jsonResponse(200, { status: 'pending' }));
    }
    if (url === 'http://hub.test/sessions/signedsession2') {
      return Promise.resolve(jsonResponse(200, { status: 'signed', identity: { id: 'fabric-id-2' }, pubkeyHex: '02cd' }));
    }
    if (url.startsWith('http://down.test/')) {
      return Promise.reject(new TypeError('fetch failed'));
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

    const callback = await request(`/services/members/discord/callback?code=good-code&state=${state}`);
    assert.strictEqual(callback.status, 302);
    assert.strictEqual(callback.headers.location, '/sessions?signedIn=discord');
    const cookie = cookieFrom(callback);
    assert.ok(/^goon\.member=[0-9a-f]{64}$/.test(cookie));
    assert.ok(/HttpOnly/.test(callback.headers['set-cookie'][0]));

    const replay = await request(`/services/members/discord/callback?code=good-code&state=${state}`);
    assert.strictEqual(replay.headers.location, '/sessions?error=expired_state');

    const session = await request('/services/members/session', { headers: { Cookie: cookie } });
    assert.strictEqual(session.status, 200);
    assert.strictEqual(session.json.member.id, 'discord:42');
    assert.strictEqual(session.json.member.displayName, 'Goon');
    assert.strictEqual(session.json.member.inGuild, true);

    const stored = await members.getMember('discord:42');
    assert.strictEqual(stored.discord.username, 'goon');
    assert.ok(!JSON.stringify(stored).includes('discord-access'));
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
    const run = (url) => new Promise((resolve) => {
      const res = { headers: {}, setHeader (k, v) { this.headers[k.toLowerCase()] = v; }, end () { resolve(this); } };
      mw({ method: 'GET', url, headers: { host: 'goon.vc', 'x-forwarded-proto': 'https' } }, res, () => resolve(null));
    });
    try {
      assert.strictEqual(borrowed.discordEnabled, true);
      assert.strictEqual((await run('/services/members/discord')).headers.location, '/sessions?error=discord_unavailable', 'Discord unreachable');
      const start = await run('/services/members/discord');
      const authorize = new URL(start.headers.location);
      assert.strictEqual(authorize.searchParams.get('client_id'), 'bot-app-id');
      assert.strictEqual(authorize.searchParams.get('redirect_uri'), 'https://goon.vc/services/members/discord/callback');
      const callback = await run(`/services/members/discord/callback?code=good-code&state=${authorize.searchParams.get('state')}`);
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
    assert.strictEqual(res.json.member.id, 'fabric:fabric-id-1');
    assert.strictEqual(res.json.member.provider, 'passport');
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
      assert.strictEqual(res.json.member.id, 'fabric:fabric-id-2');
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

  it('keeps members across a Store restart', async function () {
    await members.stop();
    members.store = null;
    await members.start();
    const stored = await members.getMember('fabric:fabric-id-1');
    assert.strictEqual(stored.fabric.pubkeyHex, '02ab');
  });
});
