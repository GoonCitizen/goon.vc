'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const rsiCitizen = require('../functions/rsiCitizen');
const rsiClaim = require('../functions/rsiClaim');
const Members = require('../services/members');

// Markup follows a real RSI citizen page (star-citizen-live tests/fixtures/rsi).
function citizenPage ({ handle, name = handle, record = 7411388, bio = '', org = 'PERMAFLEET' }) {
  return `<!DOCTYPE html><html><head><title>
  ${name} | ${handle} - Roberts Space Industries | Follow the development of Star Citizen and Squadron 42
</title></head><body>
<div class="profile-content overview-content clearfix">
        <p class="entry citizen-record">
          <span class="label">UEE Citizen Record</span>
          <strong class="value">#${record}</strong>
        </p>
        <div class="box-content profile-wrapper clearfix">
          <div class="inner-bg clearfix">
            <div class="profile left-col">
              <div class="inner clearfix">
                <div class="info">
                  <p class="entry">
                    <strong class="value">${name}</strong>
                  </p>
                  <p class="entry">
                    <span class="label">Handle name</span>
                    <strong class="value">${handle}</strong>
                  </p>
                </div>
              </div>
            </div>
            <div class="main-org right-col visibility-R">
              <div class="inner clearfix">
                  <div class="info">
                    <p class="entry">
                      <a href="/orgs/${org}"><strong class="value">${org}</strong></a>
                    </p>
                  </div>
              </div>
            </div>
          </div>
        </div>
        <div class="right-col">
          <div class="inner">
              <div class="entry bio">
                <span class="label">Bio</span>
                <div class="value">
                  ${bio}
                </div>
              </div>
          </div>
        </div>
</div>
</body></html>`;
}

describe('RSI citizen pages', function () {
  it('reads the handle, record, bio, and main org', function () {
    const citizen = rsiCitizen.parseCitizenHtml(citizenPage({ handle: 'Kersa', name: 'Kersa &amp; Co', bio: 'Pilot<br/>g00n:abc1234' }));
    assert.deepStrictEqual(citizen, {
      handle: 'Kersa',
      displayName: 'Kersa & Co',
      citizenRecord: 7411388,
      bio: 'Pilot g00n:abc1234',
      mainOrgSid: 'PERMAFLEET',
      mainOrgName: 'PERMAFLEET',
      url: 'https://robertsspaceindustries.com/en/citizens/Kersa'
    });
  });

  it('reads nothing from a 404 page or a page without a handle', function () {
    assert.strictEqual(rsiCitizen.parseCitizenHtml('<html><head><title>404 - Roberts Space Industries</title></head></html>'), null);
    assert.strictEqual(rsiCitizen.parseCitizenHtml('<html><body>nothing</body></html>'), null);
    assert.strictEqual(rsiCitizen.parseCitizenHtml(null), null);
  });

  it('only takes handles RSI could have', function () {
    assert.strictEqual(rsiCitizen.sanitizeHandle('@Kersa'), 'Kersa');
    assert.strictEqual(rsiCitizen.sanitizeHandle('a'), null);
    assert.strictEqual(rsiCitizen.sanitizeHandle('../etc'), null);
    assert.strictEqual(rsiCitizen.citizenUrl('bad handle'), null);
  });

  it('looks a citizen up, telling a missing citizen from RSI being down', async function () {
    const page = citizenPage({ handle: 'Kersa' });
    const seen = [];
    const ok = await rsiCitizen.lookupCitizen('kersa', {
      fetch: async (url) => { seen.push(url); return { ok: true, status: 200, text: async () => page }; }
    });
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.citizen.handle, 'Kersa');
    assert.deepStrictEqual(seen, ['https://robertsspaceindustries.com/en/citizens/kersa']);
    const missing = await rsiCitizen.lookupCitizen('Nobody', { fetch: async () => ({ ok: false, status: 404, text: async () => '' }) });
    assert.deepStrictEqual([missing.ok, missing.status], [false, 404]);
    const down = await rsiCitizen.lookupCitizen('Kersa', { fetch: async () => { throw new Error('ECONNRESET'); } });
    assert.deepStrictEqual([down.ok, down.status], [false, 502]);
    const error = await rsiCitizen.lookupCitizen('Kersa', { fetch: async () => ({ ok: false, status: 503, text: async () => '' }) });
    assert.deepStrictEqual([error.ok, error.status], [false, 502]);
    const bad = await rsiCitizen.lookupCitizen('no way', { fetch: async () => assert.fail('never fetched') });
    assert.deepStrictEqual([bad.ok, bad.status], [false, 400]);
  });
});

describe('RSI claim codes', function () {
  it('are g00n: plus seven hex characters, found in a bio in any case', function () {
    const code = rsiClaim.claimCode();
    assert.match(code, /^g00n:[0-9a-f]{7}$/);
    assert.notStrictEqual(rsiClaim.claimCode(), code);
    assert.strictEqual(rsiClaim.bioHasCode(`Flying for G00N. ${code.toUpperCase()}`, code), true);
    assert.strictEqual(rsiClaim.bioHasCode(`${code}0`, code), false, 'a longer code is a different code');
    assert.strictEqual(rsiClaim.bioHasCode('g00n:0000000', code), false);
    assert.strictEqual(rsiClaim.bioHasCode(null, code), false);
  });
});

describe('RSI profile claims', function () {
  this.timeout(20000);

  let members;
  let server;
  let port;
  let storePath;
  const pages = new Map();
  let rsiDown = false;
  let rsiCalls = 0;

  function stubFetch (url) {
    const match = /^https:\/\/robertsspaceindustries\.com\/en\/citizens\/([^/?#]+)$/.exec(url);
    if (!match) return Promise.reject(new TypeError(`unexpected fetch ${url}`));
    rsiCalls += 1;
    if (rsiDown) return Promise.reject(new Error('ECONNREFUSED'));
    const page = pages.get(decodeURIComponent(match[1]).toLowerCase());
    return Promise.resolve({ ok: !!page, status: page ? 200 : 404, text: async () => page ? citizenPage(page) : '<title>404 - Roberts Space Industries</title>' });
  }

  function request (pathname, opts = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: Object.assign({ Accept: 'application/json' }, opts.cookie ? { Cookie: opts.cookie } : {})
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

  // Redeem a member's one-time claim link; the session cookie it sets.
  async function signIn (memberId) {
    const { url } = await members.claimLink(memberId);
    const link = new URL(url);
    const res = await request(`${link.pathname}${link.search}`);
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.headers.location, '/rsi');
    const cookie = [].concat(res.headers['set-cookie'] || []).find((raw) => raw.startsWith('goon.member='));
    assert.ok(cookie, 'the link signs its holder in');
    return cookie.split(';')[0];
  }

  before(async function () {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-rsi-claim-'));
    members = new Members({ path: storePath, fetch: stubFetch, siteUrl: 'https://goon.vc/', claimPath: '/rsi' });
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

  it('sends a one-time link that signs in once, and never after it expires', async function () {
    const member = await members.linkDiscord({ id: '700000000000000001', username: 'kersa' }, 'Kersa');
    const { url, expiresAt } = await members.claimLink(member.id);
    assert.match(url, /^https:\/\/goon\.vc\/rsi\/claim\?t=[0-9a-f]{64}$/);
    assert.ok(expiresAt > Date.now() + 29 * 60 * 1000 && expiresAt <= Date.now() + 30 * 60 * 1000);
    const link = new URL(url);

    const first = await request(`${link.pathname}${link.search}`);
    assert.strictEqual(first.status, 302);
    assert.strictEqual(first.headers.location, '/rsi');
    const cookie = [].concat(first.headers['set-cookie']).find((raw) => raw.startsWith('goon.member=')).split(';')[0];
    const session = await request('/services/members/session', { cookie });
    assert.strictEqual(session.json.member.id, member.id);
    assert.strictEqual(session.json.member.provider, 'rsi-link');

    const again = await request(`${link.pathname}${link.search}`);
    assert.strictEqual(again.status, 302);
    assert.strictEqual(again.headers.location, '/rsi?error=link', 'used once');
    assert.ok(!again.headers['set-cookie']);

    const stale = new URL((await members.claimLink(member.id)).url);
    const key = `/claim-links/${crypto.createHash('sha256').update(stale.searchParams.get('t')).digest('hex')}`;
    await members.store.set(key, Object.assign({}, await members.store.get(key), { expiresAt: Date.now() - 1 }));
    const expired = await request(`${stale.pathname}${stale.search}`);
    assert.strictEqual(expired.headers.location, '/rsi?error=link');
    assert.ok(!expired.headers['set-cookie']);

    const forged = await request('/rsi/claim?t=nope');
    assert.strictEqual(forged.headers.location, '/rsi?error=link');
  });

  it('answers 401 signed out', async function () {
    assert.strictEqual((await request('/services/members/rsi')).status, 401);
    assert.strictEqual((await request('/services/members/rsi/claims', { method: 'POST', body: { handle: 'Kersa' } })).status, 401);
    assert.strictEqual((await request('/services/members/rsi/claims/verify', { method: 'POST' })).status, 401);
  });

  it('links rsi:<Handle> once the code is in the RSI bio', async function () {
    const member = await members.linkDiscord({ id: '700000000000000002', username: 'pilot' }, 'Pilot');
    const cookie = await signIn(member.id);
    pages.set('goonpilot', { handle: 'GoonPilot', name: 'Goon Pilot', bio: 'Hello' });

    const empty = await request('/services/members/rsi', { cookie });
    assert.deepStrictEqual([empty.status, empty.json.handles, empty.json.pending], [200, [], null]);

    assert.strictEqual((await request('/services/members/rsi/claims/verify', { method: 'POST', cookie })).status, 409, 'nothing to verify yet');
    assert.strictEqual((await request('/services/members/rsi/claims', { method: 'POST', cookie, body: { handle: 'no spaces' } })).status, 400);

    const started = await request('/services/members/rsi/claims', { method: 'POST', cookie, body: { handle: '@goonpilot' } });
    assert.strictEqual(started.status, 200);
    const { code } = started.json.pending;
    assert.match(code, /^g00n:[0-9a-f]{7}$/);
    assert.strictEqual(started.json.pending.url, 'https://robertsspaceindustries.com/en/citizens/goonpilot');
    const restarted = await request('/services/members/rsi/claims', { method: 'POST', cookie, body: { handle: 'GOONPILOT' } });
    assert.strictEqual(restarted.json.pending.code, code, 'the same handle keeps its code');
    assert.strictEqual((await request('/services/members/rsi', { cookie })).json.pending.code, code);

    const missing = await request('/services/members/rsi/claims/verify', { method: 'POST', cookie });
    assert.strictEqual(missing.status, 409);
    assert.match(missing.json.error, /isn’t in GoonPilot’s RSI bio yet/);

    pages.set('goonpilot', { handle: 'GoonPilot', name: 'Goon Pilot', bio: `Flying with G00N. ${code}`, org: 'GOON' });
    const verified = await request('/services/members/rsi/claims/verify', { method: 'POST', cookie });
    assert.strictEqual(verified.status, 200, JSON.stringify(verified.json));
    assert.deepStrictEqual([verified.json.handle, verified.json.merged, verified.json.handles], ['GoonPilot', false, ['GoonPilot']]);

    const after = await members.resolve(member.id);
    const account = after.accounts.find((entry) => entry.key === 'rsi:GoonPilot');
    assert.ok(account, 'rsi:<Handle> as RSI writes it');
    assert.strictEqual(account.via, 'bio');
    assert.deepStrictEqual(Members.rsiHandles(after), ['GoonPilot']);
    const status = await request('/services/members/rsi', { cookie });
    assert.deepStrictEqual([status.json.handles, status.json.pending], [['GoonPilot'], null], 'the claim is done');
    const accounts = await request('/services/members/accounts', { cookie });
    assert.ok(accounts.json.accounts.some((entry) => entry.platform === 'rsi' && entry.label === 'GoonPilot'));
    assert.ok(!JSON.stringify(status.json).includes('700000000000000002'), 'no Discord ids');
  });

  it('refuses a citizen RSI says is someone else, and passes on RSI being missing or down', async function () {
    const member = await members.linkDiscord({ id: '700000000000000003', username: 'third' }, 'Third');
    const cookie = await signIn(member.id);
    const started = await request('/services/members/rsi/claims', { method: 'POST', cookie, body: { handle: 'Renamed' } });
    pages.set('renamed', { handle: 'SomeoneElse', bio: started.json.pending.code });
    assert.strictEqual((await request('/services/members/rsi/claims/verify', { method: 'POST', cookie })).status, 409);
    pages.delete('renamed');
    assert.strictEqual((await request('/services/members/rsi/claims/verify', { method: 'POST', cookie })).status, 404);
    rsiDown = true;
    try {
      assert.strictEqual((await request('/services/members/rsi/claims/verify', { method: 'POST', cookie })).status, 502);
    } finally {
      rsiDown = false;
    }
    assert.deepStrictEqual(Members.rsiHandles(await members.resolve(member.id)), []);
  });

  it('allows five verifies per member every 15 minutes', async function () {
    const member = await members.linkDiscord({ id: '700000000000000004', username: 'eager' }, 'Eager');
    const cookie = await signIn(member.id);
    pages.set('eagerpilot', { handle: 'EagerPilot', bio: 'not yet' });
    await request('/services/members/rsi/claims', { method: 'POST', cookie, body: { handle: 'EagerPilot' } });
    const before = rsiCalls;
    for (let i = 0; i < 5; i++) {
      assert.strictEqual((await request('/services/members/rsi/claims/verify', { method: 'POST', cookie })).status, 409);
    }
    const limited = await request('/services/members/rsi/claims/verify', { method: 'POST', cookie });
    assert.strictEqual(limited.status, 429);
    assert.strictEqual(rsiCalls - before, 5, 'RSI is not asked once limited');
  });

  it('merges a member who claims a handle another member holds', async function () {
    const first = await members.linkDiscord({ id: '700000000000000005', username: 'alt-one' }, 'Alt One');
    const fabric = `fabric:${'ab'.repeat(32)}`;
    const second = await members.memberFor(fabric, { create: true, via: 'passport' });
    const third = await members.linkDiscord({ id: '700000000000000006', username: 'alt-two' }, 'Alt Two');
    async function verify (member) {
      const cookie = await signIn(member.id);
      const started = await request('/services/members/rsi/claims', { method: 'POST', cookie, body: { handle: 'SharedAlt' } });
      pages.set('sharedalt', { handle: 'SharedAlt', bio: started.json.pending.code });
      return request('/services/members/rsi/claims/verify', { method: 'POST', cookie });
    }
    for (const member of [first, second]) {
      const verified = await verify(member);
      assert.strictEqual(verified.status, 200);
      assert.strictEqual(verified.json.merged, member === second);
    }
    const survivor = await members.resolve(second.id);
    assert.strictEqual(survivor.id, first.id, 'the older member survives');
    const keys = survivor.accounts.map((entry) => entry.key).sort();
    assert.deepStrictEqual(keys, ['discord:700000000000000005', fabric, 'rsi:SharedAlt']);

    const refused = await verify(third);
    assert.strictEqual(refused.status, 409, 'a member holds one Discord account');
    assert.match(refused.json.error, /one Discord account/);
    assert.strictEqual((await members.resolve('rsi:SharedAlt')).id, first.id);
  });
});
