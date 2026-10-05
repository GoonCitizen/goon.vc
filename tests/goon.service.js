'use strict';

const assert = require('assert');
const http = require('http');
const {
  HUB_API_PREFIXES,
  isHubApiPath,
  shouldProxyHubApi,
  normalizeHubOrigin
} = require('../functions/hubApiProxy');
const GoonVC = require('../services/goon.vc');

describe('goon.vc', function () {
  describe('Hub API zipper', function () {
    it('allowlists Hub API prefixes only', function () {
      assert.ok(isHubApiPath('/sessions'));
      assert.ok(isHubApiPath('/sessions/abc'));
      assert.ok(isHubApiPath('/device-links/xyz/signatures'));
      assert.ok(isHubApiPath('/services/rpc'));
      assert.ok(isHubApiPath('/identity/cluster'));
      assert.ok(!isHubApiPath('/services/star-citizen'));
      assert.ok(!isHubApiPath('/services/bitcoin'));
      assert.ok(!isHubApiPath('/'));
      assert.ok(!isHubApiPath('/dossier'));
      assert.ok(HUB_API_PREFIXES.includes('/sessions'));
    });

    it('does not proxy HTML navigation to /sessions', function () {
      assert.strictEqual(shouldProxyHubApi({
        method: 'GET',
        url: '/sessions',
        headers: { accept: 'text/html' }
      }), false);
      assert.strictEqual(shouldProxyHubApi({
        method: 'POST',
        url: '/sessions',
        headers: { accept: 'application/json' }
      }), true);
      assert.strictEqual(shouldProxyHubApi({
        method: 'GET',
        url: '/sessions/deadbeef',
        headers: { accept: 'application/json' }
      }), true);
    });

    it('normalizes Hub origins', function () {
      assert.strictEqual(normalizeHubOrigin('https://hub.fabric.pub/'), 'https://hub.fabric.pub');
      assert.strictEqual(normalizeHubOrigin('not-a-url'), null);
    });

    it('proxies allowlisted POSTs through the middleware', async function () {
      const { createHubApiMiddleware } = require('../functions/hubApiProxy');
      const stub = http.createServer((req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, echoed: req.url }));
      });
      await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
      const stubPort = stub.address().port;
      const mw = createHubApiMiddleware(`http://127.0.0.1:${stubPort}`);
      const edge = http.createServer((req, res) => {
        mw(req, res, () => {
          res.statusCode = 404;
          res.end('not proxied');
        });
      });
      await new Promise((resolve) => edge.listen(0, '127.0.0.1', resolve));
      const edgePort = edge.address().port;
      try {
        const body = await new Promise((resolve, reject) => {
          const req = http.request({
            hostname: '127.0.0.1',
            port: edgePort,
            path: '/sessions',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' }
          }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          });
          req.on('error', reject);
          req.end(JSON.stringify({ origin: 'http://127.0.0.1' }));
        });
        assert.strictEqual(body.status, 200);
        assert.strictEqual(JSON.parse(body.body).ok, true);
        const skipped = await new Promise((resolve, reject) => {
          http.get({
            hostname: '127.0.0.1',
            port: edgePort,
            path: '/dossier',
            headers: { Accept: 'text/html' }
          }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          }).on('error', reject);
        });
        assert.strictEqual(skipped.body, 'not proxied');
      } finally {
        await new Promise((resolve) => edge.close(resolve));
        await new Promise((resolve) => stub.close(resolve));
      }
    });
  });

  describe('GoonVC', function () {
    this.timeout(20000);

    it('constructs without a Hub contract or Star Citizen relay', function () {
      const goon = new GoonVC({ listen: false });
      assert.ok(goon);
      assert.strictEqual(goon.contract, undefined);
      assert.strictEqual(goon.starcitizen, undefined);
    });
  });
});

describe('goon.vc HTTP', function () {
  this.timeout(30000);

  const net = require('net');
  const os = require('os');
  const path = require('path');

  let hubServer;
  let hubPort;
  let site;
  let sitePort;

  function freePort () {
    return new Promise((resolve, reject) => {
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => {
        const port = s.address().port;
        s.close((err) => (err ? reject(err) : resolve(port)));
      });
      s.on('error', reject);
    });
  }

  before(async function () {
    hubServer = http.createServer((req, res) => {
      const url = req.url || '/';
      if (req.method === 'POST' && url === '/sessions') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true, sessionId: 'stub', hub: 'stub' }));
        return;
      }
      if (req.method === 'POST' && url === '/services/rpc') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', result: { pong: true }, id: 1 }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'stub not found', path: url }));
    });
    await new Promise((resolve) => hubServer.listen(0, '127.0.0.1', resolve));
    hubPort = hubServer.address().port;
    sitePort = await freePort();

    site = new GoonVC({
      hub: { origin: `http://127.0.0.1:${hubPort}` },
      http: {
        port: sitePort,
        interface: '127.0.0.1',
        hostname: '127.0.0.1'
      },
      storePath: path.join(os.tmpdir(), `goonvc-test-${process.pid}`),
      listen: true
    });
    await site.start();
    sitePort = site.http.settings.port;
  });

  after(async function () {
    if (site) await site.stop();
    if (hubServer) await new Promise((resolve) => hubServer.close(resolve));
  });

  function fetchJson (pathname, opts = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port: sitePort,
        path: pathname,
        method: opts.method || 'GET',
        headers: Object.assign({ Accept: 'application/json' }, opts.headers || {})
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(body); } catch (_) { json = body; }
          resolve({ status: res.statusCode, json, body });
        });
      });
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  }

  it('serves the GoonSPA HTML home', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/',
        headers: { Accept: 'text/html' }
      }, (incoming) => {
        const chunks = [];
        incoming.on('data', (c) => chunks.push(c));
        incoming.on('end', () => resolve({
          status: incoming.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 200);
    assert.ok(/GOON SQUAD/i.test(res.body));
    assert.ok(res.body.includes('favicon.svg'));
    assert.ok(res.body.includes('#4C1D95'));
    assert.ok(!/Star Citizen relay API/i.test(res.body));
  });

  it('serves the PERMAFLEET operation page via SPA fallback', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/operations/PERMAFLEET',
        headers: { Accept: 'text/html' }
      }, (incoming) => {
        const chunks = [];
        incoming.on('data', (c) => chunks.push(c));
        incoming.on('end', () => resolve({
          status: incoming.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('id="operation-permafleet"'));
    assert.ok(res.body.includes('/operations/PERMAFLEET'));
    assert.ok(res.body.includes('/hero-quantum.jpg'));
  });

  it('serves the PERMAFLEET schedule page via SPA fallback', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/operations/PERMAFLEET/schedule',
        headers: { Accept: 'text/html' }
      }, (incoming) => {
        const chunks = [];
        incoming.on('data', (c) => chunks.push(c));
        incoming.on('end', () => resolve({
          status: incoming.statusCode,
          body: Buffer.concat(chunks).toString('utf8')
        }));
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('id="permafleet-schedule"'));
    assert.ok(res.body.includes('/permafleet-schedule.svg'));
  });

  it('redirects /permafleet to the PERMAFLEET operation page', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/permafleet',
        headers: { Accept: 'text/html' }
      }, (incoming) => {
        incoming.resume();
        resolve({ status: incoming.statusCode, location: incoming.headers.location });
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.location, '/operations/PERMAFLEET');
  });

  it('redirects / to the PERMAFLEET operation page', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/',
        headers: { Accept: 'text/html' }
      }, (incoming) => {
        incoming.resume();
        resolve({ status: incoming.statusCode, location: incoming.headers.location });
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.location, '/operations/PERMAFLEET');
  });

  it('proxies POST /sessions to the Hub', async function () {
    const res = await fetchJson('/sessions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:' + sitePort,
        Accept: 'application/json'
      },
      body: JSON.stringify({ origin: 'http://127.0.0.1:' + sitePort })
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.ok, true);
    assert.strictEqual(res.json.sessionId, 'stub');
  });

  it('does not mount /services/star-citizen', async function () {
    const res = await fetchJson('/services/star-citizen');
    assert.notStrictEqual(res.status, 200);
    const blob = JSON.stringify(res.json) + res.body;
    assert.ok(!/signed ingest/i.test(blob));
  });
});
