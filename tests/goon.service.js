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
      assert.ok(!isHubApiPath('/organizations'));
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
            path: '/organizations',
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
      members: { path: path.join(os.tmpdir(), `goonvc-members-test-${process.pid}`) },
      events: {
        path: path.join(os.tmpdir(), `goonvc-events-test-${process.pid}`),
        resolveToken: () => ({ token: null, source: null })
      },
      operations: {
        path: path.join(os.tmpdir(), `goonvc-operations-test-${process.pid}`),
        gateway: false
      },
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
    const home = res.body.slice(res.body.indexOf('id="home-page"'), res.body.indexOf('</main>', res.body.indexOf('id="home-page"')));
    assert.ok(!home.includes('<iframe'), 'Discord widget iframe replaced');
    assert.ok(home.includes('id="discord-roster"'));
    assert.ok(/<a href="bitcoin:bc1q\w+"><code>bc1q\w+<\/code><\/a>/.test(home), 'footer address is a bitcoin: link');
    assert.ok(res.body.includes("'https://discord.com/api/guilds/' + \"1190527980120850493\" + '/widget.json'"));
    assert.ok(home.includes('id="home-overview-title">G00N SQUAD</h2>'));
    assert.ok(home.includes('PMC · Hardcore · Security / Infiltration · Recruiting'));
    assert.ok(home.includes('href="/operations/PERMAFLEET#alpha-squadron">Apply to ALPHA SQUADRON</a>'));
    assert.ok(home.includes('href="/organizations/G00N"'));
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
    const squadrons = res.body.slice(res.body.indexOf('id="squadrons"'), res.body.indexOf('id="permafleet-charter"'));
    for (const id of ['alpha-squadron', 'bravo-squadron', 'rat-squadron', 'ghost-squadron', 'turtle-brigade']) {
      assert.ok(squadrons.includes(`id="${id}"`), id);
    }
    assert.ok(!squadrons.includes('id="permafleet"'), 'PERMAFLEET is the operation, not a squadron');
    assert.strictEqual(res.body.split('id="operation-permafleet"').length, 2, 'unique id');
    const form = squadrons.slice(squadrons.indexOf('id="alpha-squadron-form"'), squadrons.indexOf('</form>'));
    assert.ok(form.includes('action="https://docs.google.com/forms/d/e/1FAIpQLSdNqMmrcUJSSjzzTNzDQBIJ_foCL5m-EBp5nEQNIrlLNXMXVw/formResponse"'));
    assert.ok(form.includes('target="alpha-squadron-sink"'));
    assert.ok(/<input[^>]+name="entry\.1263490172"[^>]+required/.test(form), 'IGN');
    assert.ok(/<textarea[^>]+name="entry\.1476806575"[^>]+required/.test(form), 'reason');
    assert.ok(squadrons.includes('name="alpha-squadron-sink"'));
    assert.ok(squadrons.includes('href="https://forms.gle/GvUx3o1MuWtxJifT9"'));
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

  it('serves the /operations index listing PERMAFLEET', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/operations',
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
    assert.ok(res.body.includes('id="operations-page"'));
    assert.ok(res.body.includes('<h2 class="operation-name"><a href="/operations/PERMAFLEET">PERMAFLEET</a></h2>'));
    assert.ok(res.body.includes('href="/operations/PERMAFLEET/schedule">Weekly schedule</a>'));
    assert.ok(res.body.includes('class="operation-metrics" data-operation="permafleet"'), 'PERMAFLEET metrics strip');
    const page = res.body.slice(res.body.indexOf('id="operations-page"'));
    assert.strictEqual(page.slice(0, page.indexOf('</main>')).split('<article class="operation-card"').length, 2, 'PERMAFLEET is the only operation');
    assert.ok(res.body.includes("'/services/operations'") || res.body.includes('"/services/operations"'));
  });

  it('reports per-operation metrics without exposing member ids', async function () {
    const res = await fetchJson('/services/operations');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.gateway.status, 'disabled');
    const permafleet = res.json.operations.find((op) => op.id === 'permafleet');
    assert.strictEqual(permafleet.path, '/operations/PERMAFLEET');
    assert.strictEqual(permafleet.metrics.voice.last7Days.hours, 0);
    assert.ok(!('messages' in permafleet.metrics));
    assert.strictEqual(res.json.operations.length, 1);
  });

  it('serves the /organizations index and a page per member org', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/organizations/AIMOS',
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
    assert.ok(res.body.includes('id="organizations-page"'));
    assert.ok(res.body.includes('<a href="/organizations">ORGANIZATIONS</a>'));
    for (const symbol of ['G00N', 'INFN', 'TRDE', 'LCRP', 'DOUBLEDOGZ', '4MCONTRACT', 'AIMOS']) {
      assert.ok(res.body.includes(`id="org-${symbol}"`), `${symbol} page`);
      assert.ok(res.body.includes(`href="https://robertsspaceindustries.com/orgs/${symbol}"`), `${symbol} RSI link`);
      assert.ok(res.body.includes(`<li><a href="/organizations/${symbol}">`), `${symbol} charter chip`);
    }
    assert.ok(res.body.includes('>Apply on RSI</a>'));
  });

  it('serves /resources with a dedicated GoonCitizen page', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/resources/gooncitizen',
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
    assert.ok(res.body.includes('<a href="/resources">RESOURCES</a>'));
    assert.ok(res.body.includes('id="resources-page"'));
    assert.ok(res.body.includes('<h2 class="operation-name"><a href="/resources/gooncitizen">GoonCitizen</a></h2>'));
    assert.ok(res.body.includes('id="gooncitizen-page"'));
    assert.ok(res.body.includes('Fly with your group'));
    assert.ok(res.body.includes('href="https://github.com/GoonCitizen/star-citizen-live"'));
    const manifest = require('../assets/downloads/gooncitizen/index.json');
    for (const file of manifest.files) {
      assert.ok(res.body.includes(`href="${file.href}" download>`), `${file.platform} download`);
      assert.ok(res.body.includes(`sha256 ${file.sha256}`), `${file.platform} checksum`);
    }
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

  it('serves the login page at /sessions with every sign-in method', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/sessions',
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
    assert.ok(res.body.includes('id="login-page"'));
    assert.ok(res.body.includes('id="login-discord"'));
    assert.ok(res.body.includes('id="login-passport"'));
    assert.ok(res.body.includes('id="login-desktop"'));
    assert.ok(res.body.includes('class="footer-login-button" href="/sessions"'));
    assert.ok(!res.body.includes('member-login'));
  });

  it('redirects the retired /members/login page to /sessions', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/members/login',
        headers: { Accept: 'text/html' }
      }, (incoming) => {
        incoming.resume();
        resolve({ status: incoming.statusCode, location: incoming.headers.location });
      }).on('error', reject);
    });
    assert.strictEqual(res.status, 302);
    assert.strictEqual(res.location, '/sessions');
  });

  it('serves the /events page and links it from the home nav', async function () {
    const res = await new Promise((resolve, reject) => {
      http.get({
        hostname: '127.0.0.1',
        port: sitePort,
        path: '/events',
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
    assert.ok(res.body.includes('id="events-page"'));
    const page = res.body.slice(res.body.indexOf('id="events-page"'), res.body.indexOf('</main>', res.body.indexOf('id="events-page"')));
    const calendar = page.match(/<fabric-calendar[\s\S]*?<\/fabric-calendar>/);
    assert.ok(calendar, 'page is one <fabric-calendar>');
    assert.ok(calendar[0].includes('board="/services/events/schedule.svg"') && calendar[0].includes('src="/services/events"'));
    assert.ok(calendar[0].includes('description="Upcoming scheduled events from every Discord server we fly with."'));
    assert.ok(!/<h1|<select|<button|<p /.test(page.replace(calendar[0], '').replace(/<footer>[\s\S]*<\/footer>/, '')), 'nothing outside the calendar but the footer');
    assert.ok(res.body.includes('<script src="/scripts/fabric-calendar.js" defer></script>'));
    const element = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: sitePort, path: '/scripts/fabric-calendar.js' }, (incoming) => {
        const chunks = [];
        incoming.on('data', (c) => chunks.push(c));
        incoming.on('end', () => resolve({ status: incoming.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }).on('error', reject);
    });
    assert.strictEqual(element.status, 200);
    assert.ok(element.body.includes("customElements.define('fabric-calendar'"));
    assert.ok(res.body.includes('<a href="/events">EVENTS</a>'));
    assert.ok(res.body.includes('<a href="/operations">OPERATIONS</a>'));
    const header = res.body.slice(res.body.indexOf('id="site-header"'), res.body.indexOf('</header>'));
    assert.ok(!header.includes('PERMAFLEET PROTECTORATE'), 'alliance line moved out of the header');
    const alliances = res.body.match(/<footer>[\s\S]*?<\/footer>/g).filter((f) => f.includes('THE <a href="/operations/PERMAFLEET">PERMAFLEET PROTECTORATE</a>'));
    assert.ok(alliances.length >= 6, 'alliance line in every page footer');
    const home = res.body.slice(res.body.indexOf('id="home-page"'), res.body.indexOf('<footer', res.body.indexOf('id="home-page"')));
    assert.ok(!home.includes('Join the Squad'), 'join link only in the footer');
    assert.strictEqual(res.body.split('id="site-header"').length, 2, 'one shared header');
    assert.ok(res.body.indexOf('id="site-header"') < res.body.indexOf('<main'), 'header precedes every page');
    assert.ok(!res.body.includes('page-back"><a href="/">'), 'no redundant Home crumbs');
    assert.ok(!/dossier/i.test(res.body), 'dossier removed');
    assert.ok(!res.body.includes('relay.goon.vc') && !/>Monitor</i.test(res.body), 'no Monitor link yet');
  });

  it('reports events as unavailable without a Discord bot token', async function () {
    const res = await fetchJson('/services/events');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.events, []);
    assert.strictEqual(res.json.stale, true);
    assert.ok(/token/i.test(res.json.error));
  });

  it('reports member login capabilities', async function () {
    const res = await fetchJson('/services/members');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, { discord: false, passport: true });
    const session = await fetchJson('/services/members/session');
    assert.strictEqual(session.status, 401);
    assert.ok(Number.isFinite(site.members.settings.sessionTtlMs) && site.members.settings.sessionTtlMs > 0);
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
