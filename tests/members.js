'use strict';

const assert = require('assert');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Key = require('@fabric/core/types/key');
const Message = require('@fabric/core/types/message');
const { encodeFabricUri } = require('@fabric/core/functions/fabricUri');
const passportCore = require('@fabric/core/functions/passport');
const { deriveAccount } = require('@fabric/core/functions/accountKeys');
const Members = require('../services/members');

const MEMBER_ID = /^[0-9a-f]{16}$/;
const xonly = (signer) => signer.pubkey.slice(2);

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
  const first = new Key();
  let legacyHolder = null;

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

  function setCookie (res, name) {
    return [].concat(res.headers['set-cookie'] || []).find((raw) => raw.startsWith(`${name}=`)) || '';
  }

  function cookieFrom (res, name = 'goon.member') {
    return setCookie(res, name).split(';')[0];
  }

  const origin = () => `http://127.0.0.1:${port}`;

  const challengeKey = (cookie) => `/passport-requests/${crypto.createHash('sha256').update(cookie.split('=')[1]).digest('hex')}`;

  async function startPassport (headers = {}) {
    const res = await request('/services/members/passport/challenges', { method: 'POST', headers });
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    const read = passportCore.readChallenge(res.json.challenge);
    assert.ok(read.ok, read.error);
    return { res, uri: res.json.challenge, challenge: read.challenge, cookie: cookieFrom(res, 'goon.passport') };
  }

  function sign (started, signer, opts = {}) {
    return passportCore.signAssertion({
      origin: started.challenge.origin,
      challenge: started.uri,
      signer: opts.label || 'passport',
      network: opts.network || 'mainnet',
      now: opts.now
    }, signer);
  }

  function claim (assertion, opts = {}) {
    return request('/services/members/passport', {
      method: 'POST',
      headers: Object.assign({}, opts.headers || {}, opts.cookie ? { Cookie: opts.cookie } : {}),
      body: Object.assign({ assertion }, opts.link ? { link: true } : {})
    });
  }

  // Passport's answer: start a challenge, sign it with `signer`, redeem it.
  async function passport (signer, opts = {}) {
    const started = await startPassport();
    const signed = sign(started, signer, opts);
    const cookie = [opts.cookie, started.cookie].filter(Boolean).join('; ');
    const res = await claim(signed.uri, { cookie, link: opts.link });
    return Object.assign(res, { started, signed, cookie });
  }

  async function discordLogin (user, cookie, opts = {}) {
    discordUser = user;
    const headers = cookie ? { Cookie: cookie } : {};
    const start = await request(`/services/members/discord${cookie ? '?link=1' : ''}${cookie && opts.next ? `&next=${opts.next}` : ''}`, { headers });
    if (opts.beforeCallback) await opts.beforeCallback();
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
      const res = {
        headers: {},
        getHeader (k) { return this.headers[k.toLowerCase()]; },
        setHeader (k, v) { this.headers[k.toLowerCase()] = v; },
        end () { resolve(this); }
      };
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

  it('offers Passport when the installed @fabric/http can verify it', async function () {
    const res = await request('/services/members');
    assert.strictEqual(res.json.passport, true);
  });

  it('issues a Passport challenge bound to this browser by a binding secret', async function () {
    const { res, challenge, cookie } = await startPassport();
    assert.strictEqual(challenge.origin, origin());
    assert.ok(/^[0-9a-f]{64}$/.test(challenge.nonce));
    assert.ok(challenge.expiresAt - challenge.issuedAt <= 2 * 60 * 1000);
    assert.deepStrictEqual(challenge.request, [], 'sign-in asks for nothing beyond the identity');
    assert.strictEqual(challenge.network, null, 'sign-in works on any network');
    assert.ok(/^goon\.passport=[0-9a-f]{64}$/.test(cookie));
    assert.ok(!cookie.includes(challenge.nonce), 'the cookie is not the nonce');
    assert.ok(/; Path=\/services\/members\/passport; HttpOnly; SameSite=Lax; Max-Age=120$/.test(setCookie(res, 'goon.passport')));
    const record = await members.store.get(challengeKey(cookie));
    assert.strictEqual(record.origin, origin());
    assert.ok(!JSON.stringify(record).includes(cookie.split('=')[1]), 'the store keeps only the binding secret hash');
  });

  it('signs in with a Passport assertion once', async function () {
    const res = await passport(first);
    assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    assert.ok(MEMBER_ID.test(res.json.member.id));
    assert.strictEqual(res.json.member.provider, 'passport');
    assert.deepStrictEqual(res.json.member.platforms, ['fabric']);
    assert.strictEqual((await members.resolve(`fabric:${xonly(first)}`)).id, res.json.member.id);
    assert.ok(/^goon\.passport=; .*Max-Age=0/.test(setCookie(res, 'goon.passport')), 'the binding cookie is cleared');
    const cookie = cookieFrom(res);
    assert.ok(/^goon\.member=[0-9a-f]{64}$/.test(cookie));

    const replay = await claim(res.signed.uri, { cookie: res.started.cookie });
    assert.strictEqual(replay.status, 401, 'a challenge is redeemed once');

    const logout = await request('/services/members/logout', { method: 'POST', headers: { Cookie: cookie } });
    assert.strictEqual(logout.status, 200);
    const after = await request('/services/members/session', { headers: { Cookie: cookie } });
    assert.strictEqual(after.status, 401);
  });

  it('tells a page or Passport from before v2 to update', async function () {
    const started = await startPassport();
    const v1Request = await request('/services/members/passport/requests', { method: 'POST' });
    assert.strictEqual(v1Request.status, 426);
    assert.strictEqual(v1Request.json.error, 'passport_outdated');
    const v1Claim = await request('/services/members/passport', {
      method: 'POST',
      headers: { Cookie: started.cookie },
      body: { fabric: started.uri, link: false }
    });
    assert.strictEqual(v1Claim.status, 426, 'a frame other than PASSPORT_ASSERTION');
    assert.match(v1Claim.json.message, /Update Fabric Passport/);
    const signed = sign(started, new Key());
    const res = await claim(signed.uri, { cookie: started.cookie });
    assert.strictEqual(res.status, 200, 'the challenge survives the v1 attempt');
  });

  it('gives a challenge to only one of two racing claims', async function () {
    const signer = new Key();
    const started = await startPassport();
    const signed = sign(started, signer);
    const both = await Promise.all([
      claim(signed.uri, { cookie: started.cookie }),
      claim(signed.uri, { cookie: started.cookie })
    ]);
    assert.deepStrictEqual(both.map((res) => res.status).sort(), [200, 401]);
  });

  it('refuses an assertion without the browser\'s binding cookie', async function () {
    const signer = new Key();
    const started = await startPassport();
    const signed = sign(started, signer);
    const elsewhere = await claim(signed.uri);
    assert.strictEqual(elsewhere.status, 401, 'an assertion relayed to another browser is refused');
    const other = await startPassport();
    const mixed = await claim(signed.uri, { cookie: other.cookie });
    assert.strictEqual(mixed.status, 401, 'another challenge does not match');
    assert.match(mixed.json.error, /nonce mismatch/);
    assert.strictEqual(await members.resolve(`fabric:${xonly(signer)}`), null);
    const spent = await claim(signed.uri, { cookie: started.cookie });
    assert.strictEqual(spent.status, 200, 'its own browser still can');
  });

  it('refuses expired challenges and expired assertions', async function () {
    const signer = new Key();
    const started = await startPassport();
    const recordKey = challengeKey(started.cookie);
    await members.store.set(recordKey, Object.assign({}, await members.store.get(recordKey), { expiresAt: Date.now() - 1 }));
    const late = await claim(sign(started, signer).uri, { cookie: started.cookie });
    assert.strictEqual(late.status, 401);
    assert.match(late.json.error, /expired/);

    const fresh = await startPassport();
    const identityId = sign(fresh, signer).identity.id;
    const stale = Message.fromFields('PASSPORT_ASSERTION', {
      v: 2,
      origin: fresh.challenge.origin,
      nonce: fresh.challenge.nonce,
      challengeHash: Buffer.from(passportCore.challengeHash(fresh.uri), 'hex'),
      issuedAt: BigInt(Date.now() - 10 * 60 * 1000),
      expiresAt: BigInt(Date.now() - 9 * 60 * 1000),
      network: 'mainnet',
      pubkey: signer.pubkey,
      identityId,
      signer: 'passport',
      device: '',
      wallet: '',
      cosigner: ''
    });
    stale.signWithKey(signer);
    const old = await claim(encodeFabricUri(stale), { cookie: fresh.cookie });
    assert.strictEqual(old.status, 401);
    assert.match(old.json.error, /expired/);
    assert.strictEqual(await members.resolve(`fabric:${xonly(signer)}`), null);
  });

  it('refuses an assertion signed for another origin', async function () {
    const signer = new Key();
    const started = await startPassport();
    const evil = passportCore.createChallenge({ origin: 'https://evil.test' });
    const signed = passportCore.signAssertion({ origin: 'https://evil.test', challenge: evil.uri, signer: 'passport', network: 'mainnet' }, signer);
    const res = await claim(signed.uri, { cookie: started.cookie });
    assert.strictEqual(res.status, 401);
    assert.match(res.json.error, /origin mismatch/);
    assert.strictEqual(await members.resolve(`fabric:${xonly(signer)}`), null);
  });

  it('issues challenges only for pinned origins, never for the Host header', async function () {
    const saved = members.passport;
    members.settings.origins = ['https://goon.vc'];
    members.passport = members._createPassport();
    try {
      const refused = await request('/services/members/passport/challenges', { method: 'POST' });
      assert.strictEqual(refused.status, 400, 'a Host the site does not serve gets no challenge');
      const spoofed = await request('/services/members/passport/challenges', { method: 'POST', headers: { Host: 'evil.test' } });
      assert.strictEqual(spoofed.status, 400);
      const proxied = { Host: 'goon.vc', 'X-Forwarded-Proto': 'https' };
      const started = await startPassport(proxied);
      assert.strictEqual(started.challenge.origin, 'https://goon.vc');
      assert.ok(/; Secure$/.test(setCookie(started.res, 'goon.passport')));
      const res = await claim(sign(started, new Key()).uri, { cookie: started.cookie, headers: proxied });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
    } finally {
      delete members.settings.origins;
      members.passport = saved;
    }
  });

  it('links an escrow key: a challenge asking for the cosigner key on the escrow network', async function () {
    const master = new Key().xprv;
    const account = deriveAccount(master, { account: 0, network: 'regtest' });
    const startEscrow = (cookie) => request('/services/members/passport/challenges', { method: 'POST', headers: cookie ? { Cookie: cookie } : {}, body: { escrow: true } });

    const signedOut = await startEscrow();
    assert.strictEqual(signedOut.status, 401, 'escrow keys are linked to a signed-in member');

    const login = await passport(account.identity.key, { network: 'regtest' });
    assert.strictEqual(login.status, 200, JSON.stringify(login.json));
    const session = cookieFrom(login);
    const unavailable = await startEscrow(session);
    assert.strictEqual(unavailable.status, 503, 'no escrow network, no challenge');

    members.settings.escrowNetwork = async () => 'regtest';
    try {
      const res = await startEscrow(session);
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      const read = passportCore.readChallenge(res.json.challenge);
      assert.strictEqual(read.challenge.network, 'regtest');
      assert.deepStrictEqual(read.challenge.request, ['cosigner']);
      const binding = cookieFrom(res, 'goon.passport');
      const signed = passportCore.signAssertion({
        origin: read.challenge.origin,
        challenge: res.json.challenge,
        signer: 'passport',
        disclose: ['cosigner'],
        cosignerKey: account.cosigner.key
      }, account.identity.key);
      const linked = await claim(signed.uri, { cookie: `${session}; ${binding}`, link: true });
      assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
      assert.deepStrictEqual(linked.json.escrowKey, { network: 'regtest' });
      const member = await members.getMember(`fabric:${xonly(account.identity.key)}`);
      const held = member.accounts.find((a) => a.platform === 'fabric');
      assert.strictEqual(held.cosigner.pubkey, account.cosigner.pubkey);
      assert.strictEqual(held.cosigner.network, 'regtest');
      assert.notStrictEqual(held.cosigner.pubkey.slice(2), held.id, 'never the identity key');
      assert.ok(member.log.some((entry) => entry.type === 'escrow-key' && entry.network === 'regtest'));
      const accounts = await request('/services/members/accounts', { headers: { Cookie: session } });
      assert.strictEqual(accounts.json.accounts.find((a) => a.platform === 'fabric').escrow, 'regtest');
      assert.ok(!JSON.stringify(accounts.json).includes(account.cosigner.pubkey), 'the escrow key itself is not served');

      const again = await startEscrow(session);
      const rebound = cookieFrom(again, 'goon.passport');
      const withoutDisclosure = passportCore.signAssertion({ origin: read.challenge.origin, challenge: again.json.challenge, signer: 'passport' }, account.identity.key);
      const plain = await claim(withoutDisclosure.uri, { cookie: `${session}; ${rebound}`, link: true });
      assert.strictEqual(plain.status, 200, 'Passport may decline to share it');
      assert.strictEqual(plain.json.escrowKey, undefined);
    } finally {
      delete members.settings.escrowNetwork;
    }
  });

  it('pins siteUrl in production, and turns Passport off with nothing to pin', function () {
    const pinned = new Members({ path: storePath, production: true, siteUrl: 'https://goon.vc/' });
    assert.deepStrictEqual(pinned.passport.pinnedOrigins, ['https://goon.vc']);
    const local = new Members({ path: storePath, production: false, siteUrl: 'https://goon.vc' });
    assert.deepStrictEqual(local.passport.pinnedOrigins, [], 'outside production a public siteUrl is not pinned: loopback only');
    assert.strictEqual(local.passport.resolveOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
    assert.strictEqual(local.passport.resolveOrigin('https://goon.vc'), null);
    const off = new Members({ path: storePath, production: true });
    assert.strictEqual(off.passport, null, 'production with no origin to pin');
  });

  it('refuses a challenge started on another address', async function () {
    const signer = new Key();
    const started = await startPassport({ Host: 'localhost:' + port });
    const res = await claim(sign(started, signer).uri, { cookie: started.cookie });
    assert.strictEqual(res.status, 401);
    assert.match(res.json.error, /another address/);
  });

  it('refuses a tampered frame or one naming another key', async function () {
    const victim = new Key();
    const attacker = new Key();

    let started = await startPassport();
    const signed = sign(started, victim);
    const bytes = Buffer.from(signed.uri.slice('fabric:'.length), 'base64url');
    bytes[bytes.length - 1] ^= 1;
    let res = await claim(encodeFabricUri(bytes), { cookie: started.cookie });
    assert.strictEqual(res.status, 401, 'changed body');

    started = await startPassport();
    const forged = Message.fromFields('PASSPORT_ASSERTION', {
      v: 2,
      origin: started.challenge.origin,
      nonce: started.challenge.nonce,
      challengeHash: Buffer.from(passportCore.challengeHash(started.uri), 'hex'),
      issuedAt: BigInt(Date.now()),
      expiresAt: BigInt(Date.now() + 60000),
      network: 'mainnet',
      pubkey: victim.pubkey,
      identityId: signed.identity.id,
      signer: 'passport',
      device: '',
      wallet: '',
      cosigner: ''
    });
    forged.signWithKey(attacker);
    res = await claim(encodeFabricUri(forged), { cookie: started.cookie });
    assert.strictEqual(res.status, 401, 'signed by another key');
    assert.match(res.json.error, /pubkey does not match/);

    res = await claim('not a frame', { cookie: (await startPassport()).cookie });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(await members.resolve(`fabric:${xonly(victim)}`), null);
  });

  it('signs in a key a desktop app signed for, as the same account', async function () {
    const signer = new Key();
    const viaPassport = await passport(signer);
    const viaDesktop = await passport(signer, { label: 'gooncitizen' });
    assert.strictEqual(viaDesktop.status, 200, JSON.stringify(viaDesktop.json));
    assert.strictEqual(viaDesktop.json.member.id, viaPassport.json.member.id, 'the signer label grants nothing of its own');
    assert.strictEqual(viaDesktop.json.member.provider, 'passport');
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
    const holder = new Key();
    const holderChallenge = passportCore.createChallenge({ origin: origin() });
    const holderId = passportCore.signAssertion({ origin: origin(), challenge: holderChallenge.uri, signer: 'passport', network: 'mainnet' }, holder).identity.id;
    await members.store.set(`/members/fabric:${holderId}`, {
      id: `fabric:${holderId}`,
      createdAt: '2026-01-02T00:00:00.000Z',
      provider: 'passport',
      fabric: { id: holderId, pubkeyHex: holder.pubkey },
      displayName: 'Keyholder'
    });
    legacyHolder = holderId;
    const token = await members._createSession('discord:777777777');
    const session = await request('/services/members/session', { headers: { Cookie: `goon.member=${token}` } });
    assert.strictEqual(session.status, 200);
    assert.ok(MEMBER_ID.test(session.json.member.id));
    assert.strictEqual(session.json.member.displayName, 'Old Timer');
    assert.strictEqual(session.json.member.createdAt, '2026-01-01T00:00:00.000Z');
    assert.strictEqual((await members.resolve('discord:777777777')).id, session.json.member.id, 'adopted once');
    assert.strictEqual((await members.memberFor('discord:777777777')).id, session.json.member.id);

    const keyholder = await passport(holder);
    assert.strictEqual(keyholder.status, 200, JSON.stringify(keyholder.json));
    assert.strictEqual(keyholder.json.member.displayName, 'Keyholder');
    assert.strictEqual((await members.resolve(`fabric:${holderId}`)).id, keyholder.json.member.id);
    assert.strictEqual((await members.resolve(`fabric:${xonly(holder)}`)).id, keyholder.json.member.id);
  });

  it('links Discord to a signed-in member', async function () {
    const signedIn = await passport(new Key());
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
    const newcomer = new Key();
    const signedIn = await passport(newcomer);
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
    const oldProfile = await request(`/services/members/profiles/${signedIn.json.member.id}`, { headers: { Cookie: cookie } });
    assert.strictEqual(oldProfile.json.member.path, `/members/${veteran.id}`, 'a merged-away id opens the survivor');
    assert.strictEqual((await members.resolve(`fabric:${xonly(newcomer)}`)).id, veteran.id);
    const survivor = await members.resolve(veteran.id);
    assert.ok(survivor.log.some((entry) => entry.type === 'merge' && entry.from === signedIn.json.member.id));
  });

  it('shows a member only their own directory entry and profile', async function () {
    const signedOut = await request('/services/members/directory');
    assert.strictEqual(signedOut.status, 401);
    assert.strictEqual((await request('/services/members/profiles/0123456789abcdef')).status, 401);

    const me = await members.linkDiscord({ id: '500250000', username: 'mepilot', global_name: 'Me' }, 'Me Pilot');
    const other = await members.linkDiscord({ id: '500260000', username: 'them' }, 'Them');
    const cookie = `goon.member=${await members._createSession(me.id, 'discord')}`;
    const headers = { Cookie: cookie };

    const directory = await request('/services/members/directory', { headers });
    assert.strictEqual(directory.status, 200);
    assert.strictEqual(directory.json.directory, false);
    assert.deepStrictEqual(directory.json.members.map((member) => member.id), [me.id]);
    assert.strictEqual(directory.json.members[0].path, `/members/${me.id}`);
    assert.strictEqual(directory.json.members[0].displayName, 'Me Pilot');

    const profile = await request(`/services/members/profiles/${me.id.toUpperCase()}`, { headers });
    assert.strictEqual(profile.status, 200, JSON.stringify(profile.json));
    assert.strictEqual(profile.json.member.id, me.id);
    assert.strictEqual(profile.json.member.self, true);
    assert.deepStrictEqual(profile.json.member.accounts.map((account) => [account.platform, account.label]), [['discord', '@mepilot']]);
    assert.strictEqual(profile.json.member.accounts[0].key, 'discord:500250000', 'its owner gets the key to unlink with');
    assert.ok(!JSON.stringify(directory.json).includes('500250000'), 'no account ids in the directory');

    for (const id of [other.id, 'ffffffffffffffff', 'discord:500260000', 'nope']) {
      const hidden = await request(`/services/members/profiles/${encodeURIComponent(id)}`, { headers });
      assert.strictEqual(hidden.status, 404, id);
      assert.ok(!JSON.stringify(hidden.json).includes('Them'));
    }

    assert.deepStrictEqual(await members.page(`/members/${other.id}`), {
      path: `/members/${other.id}`,
      title: 'Member profile',
      description: 'A G00N SQUAD member profile. Sign in to see your own.'
    });
    assert.strictEqual(await members.page('/members/login'), null);
  });

  it('links Discord from the profile page, one Discord account per member', async function () {
    const signedIn = await passport(new Key());
    const cookie = cookieFrom(signedIn);
    const id = signedIn.json.member.id;
    const headers = { Cookie: cookie };

    const linked = await discordLogin({ id: '500700000', username: 'firstcord' }, cookie, { next: 'profile' });
    assert.strictEqual(linked.headers.location, `/members/${id}?linked=discord`);

    const again = await request('/services/members/discord?link=1&next=profile', { headers });
    assert.strictEqual(again.headers.location, `/members/${id}?error=one_discord`, 'refused before going to Discord');
    const fromLogin = await request('/services/members/discord?link=1', { headers });
    assert.strictEqual(fromLogin.headers.location, '/sessions?error=one_discord');
    await assert.rejects(members.link(id, 'discord:500700001'), (error) => error.status === 409 && error.code === 'one_discord' && /@firstcord/.test(error.message));

    // Another member with its own Discord account: proving its Fabric key would merge two Discords.
    const otherKey = new Key();
    const other = await passport(otherKey);
    await discordLogin({ id: '500700002', username: 'othercord' }, cookieFrom(other));
    const merge = await passport(otherKey, { cookie, link: true });
    assert.strictEqual(merge.status, 409, JSON.stringify(merge.json));
    assert.match(merge.json.error, /one Discord account/);
    assert.strictEqual((await members.resolve(`fabric:${xonly(otherKey)}`)).id, other.json.member.id, 'nothing merged');

    // A Discord account linked while the OAuth round trip was out still wins.
    const unlinked = await request('/services/members/accounts/discord%3A500700000', { method: 'DELETE', headers });
    assert.strictEqual(unlinked.status, 200);
    const raced = await discordLogin({ id: '500700003', username: 'late' }, cookie, {
      next: 'profile',
      beforeCallback: () => members.link(id, 'discord:500700004', { via: 'oauth' })
    });
    assert.strictEqual(raced.headers.location, `/members/${id}?error=one_discord`);
    assert.strictEqual(await members.resolve('discord:500700003'), null);

    await request('/services/members/accounts/discord%3A500700004', { method: 'DELETE', headers });
    const swapped = await discordLogin({ id: '500700005', username: 'newcord' }, cookie, { next: 'profile' });
    assert.strictEqual(swapped.headers.location, `/members/${id}?linked=discord`);
    const profile = await request(`/services/members/profiles/${id}`, { headers });
    assert.deepStrictEqual(profile.json.member.accounts.filter((a) => a.platform === 'discord').map((a) => a.label), ['@newcord']);

    // Discord sign-in (not a link) of another account still makes its own member.
    const solo = await discordLogin({ id: '500700006', username: 'solocord' });
    assert.strictEqual(solo.headers.location, '/sessions?signedIn=discord');
  });

  it('lets a member pick a display name from their RSI or Discord account', async function () {
    const signedIn = await passport(new Key());
    const cookie = cookieFrom(signedIn);
    const id = signedIn.json.member.id;
    const headers = { Cookie: cookie };
    const rename = (displayName, opts = {}) => request(`/services/members/profiles/${opts.id || id}`, {
      method: 'PATCH',
      headers: opts.signedOut ? {} : headers,
      body: { displayName }
    });

    let profile = await request(`/services/members/profiles/${id}`, { headers });
    assert.strictEqual(profile.json.member.displayName, null);
    assert.deepStrictEqual(profile.json.member.nameChoices, []);
    assert.strictEqual((await rename('Anyone')).status, 400);

    await discordLogin({ id: '500800000', username: 'renamecord', global_name: 'Rename Cord' }, cookie, { next: 'profile' });
    profile = await request(`/services/members/profiles/${id}`, { headers });
    assert.strictEqual(profile.json.member.displayName, 'Rename Cord', 'a first linked account fills an empty name');

    await members.link(id, 'rsi:RenamePilot', { via: 'bio', profile: { displayName: 'Rename Pilot' } });
    profile = await request(`/services/members/profiles/${id}`, { headers });
    assert.strictEqual(profile.json.member.displayName, 'Rename Cord', 'a later account keeps the name');
    assert.deepStrictEqual(profile.json.member.nameChoices.map((choice) => [choice.name, choice.platform]), [
      ['RenamePilot', 'rsi'],
      ['Rename Pilot', 'rsi'],
      ['Rename Cord', 'discord'],
      ['renamecord', 'discord']
    ]);

    const renamed = await rename(' RenamePilot ');
    assert.strictEqual(renamed.status, 200, JSON.stringify(renamed.json));
    assert.strictEqual(renamed.json.member.displayName, 'RenamePilot');
    const session = await request('/services/members/session', { headers });
    assert.strictEqual(session.json.member.displayName, 'RenamePilot');
    const stored = await members.getMember(id);
    assert.deepStrictEqual(stored.log.filter((entry) => entry.type === 'rename').map((entry) => [entry.from, entry.to]), [['Rename Cord', 'RenamePilot']]);

    const taken = await rename('Chairman');
    assert.strictEqual(taken.status, 400, 'only names a linked account carries');
    assert.strictEqual((await request('/services/members/profiles/' + id, { method: 'PATCH', headers, body: {} })).status, 400);
    assert.strictEqual((await rename('renamecord', { signedOut: true })).status, 401);
    const other = await passport(new Key());
    assert.strictEqual((await rename('renamecord', { id: other.json.member.id })).status, 404);
    assert.strictEqual((await members.getMember(id)).displayName, 'RenamePilot');
  });

  it('links a Fabric identity to a signed-in member', async function () {
    const discord = await discordLogin({ id: '500300000', username: 'pilot', global_name: 'Pilot' });
    const cookie = cookieFrom(discord);
    const device = new Key();
    const refused = await passport(device, { link: true });
    assert.strictEqual(refused.status, 401);

    const linked = await passport(device, { cookie, link: true });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
    assert.strictEqual(linked.json.linked, 'fabric');
    assert.strictEqual(linked.json.merged, false);
    assert.strictEqual(linked.json.member.provider, 'discord');
    assert.strictEqual(setCookie(linked, 'goon.member'), '', 'a link keeps the session');
    assert.strictEqual((await members.resolve(`fabric:${xonly(device)}`)).id, (await members.resolve('discord:500300000')).id);
  });

  it('refuses links from a session a one-time link started', async function () {
    const discord = await discordLogin({ id: '500310000', username: 'forwarded', global_name: 'Forwarded' });
    const memberId = (await members.resolve('discord:500310000')).id;
    const cookie = `goon.member=${await members._createSession(memberId, 'rsi-link')}`;
    assert.ok(cookieFrom(discord));
    const device = new Key();
    const refused = await passport(device, { cookie, link: true });
    assert.strictEqual(refused.status, 403);
    assert.match(refused.json.error, /one-time link/);
    assert.strictEqual(await members.resolve(`fabric:${xonly(device)}`), null);
    const discordLink = await request('/services/members/discord?link=1', { headers: { Cookie: cookie } });
    assert.strictEqual(discordLink.headers.location, '/sessions?error=one_time_link');
    const fromProfile = await request('/services/members/discord?link=1&next=profile', { headers: { Cookie: cookie } });
    assert.strictEqual(fromProfile.headers.location, `${members.profilePath(memberId)}?error=one_time_link`);
  });

  it('unlinks accounts but never the last one', async function () {
    const res = await discordLogin({ id: '500400000', username: 'solo', global_name: 'Solo' });
    const cookie = cookieFrom(res);
    assert.strictEqual((await request('/services/members/accounts')).status, 401);
    assert.strictEqual((await request('/services/members/accounts/discord%3A500400000', { method: 'DELETE' })).status, 401);

    const only = await request('/services/members/accounts/discord%3A500400000', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.strictEqual(only.status, 409);

    const device = new Key();
    const linked = await passport(device, { cookie, link: true });
    assert.strictEqual(linked.status, 200, JSON.stringify(linked.json));
    // A device key an earlier Hub cluster import brought in with this one.
    const sibling = new Key();
    await members.link(linked.json.member.id, `fabric:${xonly(sibling)}`, { via: 'cluster', from: xonly(device) });
    const unknown = await request('/services/members/accounts/discord%3A999900000', { method: 'DELETE', headers: { Cookie: cookie } });
    assert.strictEqual(unknown.status, 404);
    const dropped = await request(`/services/members/accounts/fabric%3A${xonly(device)}`, { method: 'DELETE', headers: { Cookie: cookie } });
    assert.strictEqual(dropped.status, 200);
    assert.deepStrictEqual(dropped.json.accounts.map((a) => a.key), ['discord:500400000'], 'its cluster keys go with it');
    assert.strictEqual(await members.resolve(`fabric:${xonly(device)}`), null);
    assert.strictEqual(await members.resolve(`fabric:${xonly(sibling)}`), null);
  });

  it('keeps members and redeemed challenges across a Store restart, and sweeps expired ones', async function () {
    const signer = new Key();
    const used = await passport(signer);
    assert.strictEqual(used.status, 200);
    const stale = await startPassport();
    const staleKey = challengeKey(stale.cookie);
    await members.store.set(staleKey, Object.assign({}, await members.store.get(staleKey), { expiresAt: Date.now() - 1 }));
    const live = await startPassport();
    const liveKey = challengeKey(live.cookie);

    await members.stop();
    members.store = null;
    await members.start();
    const stored = await members.getMember(`fabric:${xonly(first)}`);
    assert.strictEqual(stored.accounts[0].profile.pubkeyHex, first.pubkey);
    assert.strictEqual((await members.getMember(`fabric:${legacyHolder}`)).displayName, 'Keyholder');

    const replay = await claim(used.signed.uri, { cookie: used.started.cookie });
    assert.strictEqual(replay.status, 401, 'still redeemed after a restart');
    assert.strictEqual(await members.store.db.get(staleKey).catch(() => undefined), undefined, 'an expired request is swept on start');
    assert.ok(await members.store.db.get(liveKey), 'an open request survives');
    assert.strictEqual((await claim(sign(live, signer).uri, { cookie: live.cookie })).status, 200);
  });
});
