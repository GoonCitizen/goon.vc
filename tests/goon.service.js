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

    it('refuses to start when a store cannot be opened', async function () {
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const Store = require('@fabric/core/types/store');
      const startStore = require('../functions/startStore');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-locked-'));
      const holder = await startStore(new Store({ name: 'holder', path: path.join(root, 'events'), persistent: true, verbosity: 0 }));
      const goon = new GoonVC({
        listen: false,
        storePath: path.join(root, 'site'),
        members: { path: path.join(root, 'members') },
        events: { path: path.join(root, 'events'), resolveToken: () => ({ token: null, source: null }) },
        operations: { path: path.join(root, 'operations'), gateway: false }
      });
      try {
        await assert.rejects(goon.start(), /Could not open database at .*events: it is locked by another process/);
        const members = await startStore(new Store({ name: 'members', path: path.join(root, 'members'), persistent: true, verbosity: 0 }));
        await members.stop();
      } finally {
        await holder.stop();
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe('goon.vc HTTP', function () {
  this.timeout(30000);

  const fs = require('fs');
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
      presence: {
        path: path.join(os.tmpdir(), `goonvc-presence-test-${process.pid}`),
        tickMs: 0,
        gateway: false
      },
      tournaments: { path: fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-tournaments-test-')) },
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

  it('serves Open Graph tags for each page', async function () {
    const meta = (html, key) => {
      const m = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html);
      return m ? m[1] : null;
    };
    const home = await fetchJson('/', { headers: { Accept: 'text/html' } });
    assert.strictEqual(home.status, 200);
    assert.strictEqual(meta(home.body, 'og:title'), 'GOON SQUAD');
    assert.strictEqual(meta(home.body, 'og:url'), 'https://goon.vc/');
    assert.ok(/^G00N SQUAD: Star Citizen security and infiltration/.test(meta(home.body, 'og:description')), 'home description');
    assert.ok(/^https:\/\//.test(meta(home.body, 'og:image')), 'absolute og:image');

    const permafleet = await fetchJson('/operations/PERMAFLEET/', { headers: { Accept: 'text/html' } });
    assert.strictEqual(meta(permafleet.body, 'og:title'), 'PERMAFLEET — GOON SQUAD');
    assert.strictEqual(meta(permafleet.body, 'og:url'), 'https://goon.vc/operations/PERMAFLEET');
    assert.strictEqual(meta(permafleet.body, 'og:image'), 'https://goon.vc/hero-quantum.jpg');
    assert.strictEqual(meta(permafleet.body, 'twitter:card'), 'summary_large_image');
    assert.ok(permafleet.body.includes('<title>PERMAFLEET — GOON SQUAD</title>'));
    assert.strictEqual((permafleet.body.match(/property="og:title"/g) || []).length, 1, 'one block per page');

    // Link-preview bots often send Accept: */*.
    const events = await fetchJson('/events', { headers: { Accept: '*/*', 'User-Agent': 'Discordbot/2.0' } });
    assert.strictEqual(events.status, 200);
    assert.strictEqual(meta(events.body, 'og:title'), 'EVENTS — GOON SQUAD');

    const orgs = require('../contracts/organizations.json').organizations;
    if (orgs.length) {
      const org = orgs[0];
      const page = await fetchJson(`/organizations/${org.symbol.toLowerCase()}`, { headers: { Accept: 'text/html' } });
      assert.strictEqual(meta(page.body, 'og:title'), `${org.displayName || org.name} — GOON SQUAD`.replace(/&/g, '&amp;'));
    }

    const login = await fetchJson('/sessions', { headers: { Accept: 'text/html' } });
    assert.strictEqual(meta(login.body, 'og:title'), 'Login — GOON SQUAD');
    const api = await fetchJson('/sessions', { headers: { Accept: 'application/json' } });
    assert.ok(!String(api.body).includes('og:title'), 'JSON /sessions still goes to the Hub');
  });

  it('escapes page metadata', function () {
    const pageMeta = require('../functions/pageMeta');
    const tags = pageMeta.renderMetaTags({
      path: '/x',
      title: 'A "quoted" <title>',
      description: '<strong>Bold</strong> &amp; plain',
      image: '/hero.jpg'
    }, { origin: 'https://goon.vc', name: 'GOON SQUAD' });
    assert.ok(tags.includes('content="A &quot;quoted&quot; &lt;title&gt;"'));
    assert.ok(tags.includes('<meta name="description" content="Bold &amp; plain">'));
    assert.ok(tags.includes('content="https://goon.vc/hero.jpg"'));
    const html = pageMeta.injectMeta('<title>Old</title><!-- page-meta -->old<!-- /page-meta -->', tags, 'New & co');
    assert.ok(html.startsWith('<title>New &amp; co</title>'));
    assert.ok(!html.includes('-->old<'), 'previous block replaced');
  });

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
    assert.strictEqual(require('../constants').FEATURES.headerLogin, false);
    const nav = /<p class="site-nav">([\s\S]*?)<\/p>/.exec(res.body)[1];
    assert.ok(!nav.includes('href="/sessions"'), 'no Login link in the header');
    const home = res.body.slice(res.body.indexOf('id="home-page"'), res.body.indexOf('</main>', res.body.indexOf('id="home-page"')));
    assert.ok(!home.includes('<iframe'), 'Discord widget iframe replaced');
    assert.ok(home.includes('id="discord-roster"'));
    assert.ok(/<a href="bitcoin:bc1q\w+"><code>bc1q\w+<\/code><\/a>/.test(home), 'footer address is a bitcoin: link');
    assert.ok(res.body.includes("'https://discord.com/api/guilds/' + \"1190527980120850493\" + '/widget.json'"));
    assert.ok(home.includes('id="home-overview-title">G00N SQUAD</h2>'));
    assert.ok(home.includes('PMC · Security / Infiltration · Recruiting'));
    assert.ok(!/hardcore/i.test(home), 'no "hardcore" on the front page');
    assert.ok(home.includes('Membership is by invitation only'));
    assert.ok(home.includes('<a href="/operations/PERMAFLEET/squadrons#squadron-apply">squadron application</a>'));
    const copy = [...home.matchAll(/<p class="home-copy">([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));
    assert.ok(copy.join(' ').split(/\s+/).length <= 80, 'front-page overview stays short');
    assert.ok(!copy.join(' ').includes('Esse quam videri'), 'the creed is not in the copy');
    assert.ok(/<\/p>\s*<p class="home-creed">Esse quam videri\.<\/p>/.test(home), 'creed on its own line after the copy');
    assert.ok(home.includes('href="/operations/PERMAFLEET/squadrons#squadron-apply">Apply for a squadron</a>'));
    assert.ok(!home.includes('apply to ALPHA'), 'ALPHA is earned, not applied for');
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
    const permafleet = res.body.slice(res.body.indexOf('id="operation-permafleet"'));
    const charterAt = permafleet.indexOf('id="permafleet-charter"');
    const squadronsAt = permafleet.indexOf('id="squadrons"');
    assert.ok(permafleet.indexOf('class="op-pillars"') < charterAt && charterAt < squadronsAt, 'member orgs sit above the squadrons');
    const teaser = permafleet.slice(squadronsAt, permafleet.indexOf('<footer class="op-footer">'));
    assert.ok(teaser.includes('<h2 id="permafleet-squadrons">Your path to membership</h2>'));
    assert.ok(teaser.includes('<a href="/operations/PERMAFLEET/squadrons">Your path to membership &raquo;</a>'));
    for (const id of ['bravo-squadron', 'rat-squadron', 'turtle-brigade', 'alpha-squadron', 'shellback']) {
      assert.ok(teaser.includes(`href="/operations/PERMAFLEET/squadrons/${id}"`), id);
    }
    assert.ok(!teaser.includes('<form'), 'the squadron application lives on the squadrons page');
    assert.strictEqual(res.body.split('id="operation-permafleet"').length, 2, 'unique id');
    assert.ok(res.body.includes("var movedSquadron = document.getElementById('squadron-' + window.location.hash.slice(1).toLowerCase());"), 'old #squadron links move to their pages');
  });

  it('breaks PERMAFLEET squadrons out into their own pages', async function () {
    const meta = (html, key) => {
      const m = new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)">`).exec(html);
      return m ? m[1] : null;
    };
    const index = await fetchJson('/operations/PERMAFLEET/squadrons', { headers: { Accept: 'text/html' } });
    assert.strictEqual(index.status, 200);
    assert.strictEqual(meta(index.body, 'og:title'), 'PERMAFLEET Squadrons — GOON SQUAD');
    const page = index.body.slice(index.body.indexOf('<main id="squadrons-page"'));
    const squadrons = page.slice(0, page.indexOf('</main>'));
    assert.ok(squadrons.includes('<h1>Your path to membership</h1>'));
    const steps = [...squadrons.slice(squadrons.indexOf('<ol class="pf-path">'), squadrons.indexOf('</ol>')).matchAll(/<h3>([^<]+)<\/h3>/g)].map((m) => m[1]);
    assert.deepStrictEqual(steps, ['Join PERMAFLEET', 'Fly with the fleet', 'Get selected', 'Make the elite']);
    assert.ok(squadrons.includes('href="https://robertsspaceindustries.com/orgs/PERMAFLEET"'), 'apply on RSI');
    assert.ok(!/Prospect (IV|V|VI)\b/.test(squadrons), 'no rank gate on selection');
    const picksAt = squadrons.indexOf('id="squadron-picks"');
    assert.ok(picksAt > squadrons.indexOf('</ol>'), 'the squadrons follow the path');
    const applyAt = squadrons.indexOf('id="squadron-apply"');
    const eliteAt = squadrons.indexOf('id="squadron-elite"');
    const order = ['bravo-squadron', 'rat-squadron', 'turtle-brigade'].map((id) => squadrons.indexOf(`id="${id}"`));
    assert.ok(order.every((at, i) => at > picksAt && at < applyAt && (i === 0 || at > order[i - 1])), 'entry squadrons, then the application');
    assert.ok(applyAt < eliteAt, 'elite units follow the application');
    for (const id of ['alpha-squadron', 'shellback']) {
      assert.ok(squadrons.indexOf(`<article class="pf-squadron pf-squadron-elite" id="${id}">`) > eliteAt, id);
    }
    assert.ok(/id="bravo-squadron">\s*<p class="pf-squadron-entry">Selected by leadership<\/p>/.test(squadrons));
    assert.ok(/id="alpha-squadron">\s*<p class="pf-squadron-entry">Earned by performance<\/p>/.test(squadrons));
    assert.ok(!/apply (to|for) (ALPHA|SHELLBACK)/i.test(squadrons), 'elite units are earned, not applied for');
    assert.ok(!/ghost/i.test(squadrons), 'GHOST SQUADRON is not public');
    const application = squadrons.slice(applyAt, eliteAt);
    assert.ok(application.includes('<h2 id="squadron-apply-heading">Apply for a squadron</h2>'));
    assert.ok(application.includes('One application covers every squadron.'));
    const form = application.slice(application.indexOf('id="squadron-application-form"'), application.indexOf('</form>'));
    assert.ok(form.includes('action="https://docs.google.com/forms/d/e/1FAIpQLSdNqMmrcUJSSjzzTNzDQBIJ_foCL5m-EBp5nEQNIrlLNXMXVw/formResponse"'));
    assert.ok(form.includes('target="squadron-application-sink"'));
    assert.ok(/<input[^>]+name="entry\.1263490172"[^>]+required/.test(form), 'IGN');
    assert.ok(/<textarea[^>]+name="entry\.1476806575"[^>]+required/.test(form), 'reason');
    assert.ok(application.includes('name="squadron-application-sink"'));
    assert.ok(application.includes('href="https://forms.gle/GvUx3o1MuWtxJifT9"'));
    assert.strictEqual(index.body.split('action="https://docs.google.com/forms/').length, 2, 'one squadron application on the site');

    const alpha = await fetchJson('/operations/PERMAFLEET/squadrons/alpha-squadron', { headers: { Accept: 'text/html' } });
    assert.strictEqual(alpha.status, 200);
    assert.strictEqual(meta(alpha.body, 'og:title'), 'ALPHA SQUADRON — GOON SQUAD');
    assert.ok(meta(alpha.body, 'og:description').startsWith('Elite fighters · run by G00N SQUAD. The tip of the spear'));
    const alphaPage = alpha.body.slice(alpha.body.indexOf('<main id="squadron-alpha-squadron"'));
    const alphaMain = alphaPage.slice(0, alphaPage.indexOf('</main>'));
    assert.ok(alphaMain.includes('data-path="/operations/PERMAFLEET/squadrons/alpha-squadron"'));
    assert.ok(alphaMain.includes('<dt>How you get in</dt><dd>Earned by performance</dd>'));
    assert.ok(alphaMain.includes('<dt>Drawn from</dt><dd><a href="/operations/PERMAFLEET/squadrons/bravo-squadron">BRAVO SQUADRON</a></dd>'));
    assert.ok(!alphaMain.includes('<form'), 'no ALPHA-only application');

    const shellbackPage = index.body.slice(index.body.indexOf('<main id="squadron-shellback"'));
    const shellbackMain = shellbackPage.slice(0, shellbackPage.indexOf('</main>'));
    assert.ok(shellbackMain.includes('<dt>Drawn from</dt><dd><a href="/operations/PERMAFLEET/squadrons/turtle-brigade">TURTLE BRIGADE</a></dd>'));

    const bravoPage = index.body.slice(index.body.indexOf('<main id="squadron-bravo-squadron"'));
    const bravoMain = bravoPage.slice(0, bravoPage.indexOf('</main>'));
    assert.ok(bravoMain.includes('<dt>How you get in</dt><dd>Selected by leadership</dd>'));
    assert.ok(bravoMain.includes('<dt>Leads to</dt><dd><a href="/operations/PERMAFLEET/squadrons/alpha-squadron">ALPHA SQUADRON, for the top 5%</a></dd>'));
    assert.ok(bravoMain.includes('<a href="/operations/PERMAFLEET/squadrons#squadron-apply">Apply for a squadron &raquo;</a>'));
    assert.ok(bravoMain.includes('Not in PERMAFLEET yet?'));
    assert.ok(index.body.includes("document.body.classList.toggle('pf-section', isPermafleet || isSchedule || isSquadrons || !!squadronEl || isOrganizations || !!orgEl);"));
    const ids = [...index.body.matchAll(/\sid="([^"$]+)"/g)].map((m) => m[1]);
    assert.deepStrictEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], 'element ids are unique');
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

  it('reports global presence aggregates at /services/idlerpg', async function () {
    const res = await fetchJson('/services/idlerpg');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.gateway.status, 'disabled');
    assert.strictEqual(res.json.presentNow, 0);
    assert.strictEqual(res.json.uniquePlayers, 0);
    assert.strictEqual(typeof res.json.totalPresentHours, 'number');
    assert.ok(!('players' in res.json) && !('users' in res.json), 'aggregates only');
    const page = await fetchJson('/resources', { headers: { Accept: 'text/html' } });
    const section = (id) => {
      const start = page.body.indexOf(`<main id="${id}"`);
      return page.body.slice(start, page.body.indexOf('</main>', start));
    };
    const resources = section('resources-page');
    assert.ok(resources.includes('id="idlerpg-card"'), 'IdleRPG card on /resources');
    assert.ok(resources.includes('id="presence-strip"'), 'presence metrics on the IdleRPG card');
    assert.ok(resources.includes('href="/services/idlerpg"'), 'links to the IdleRPG application');
    assert.ok(page.body.includes('"/services/idlerpg"'));
    assert.ok(!section('operations-page').includes('idlerpg'), 'IdleRPG is no longer on /operations');
    assert.ok(section('idlerpg-page').includes('<a href="/resources">&larr; Resources</a>'));
  });

  it('mounts the IdleRPG application at /services/idlerpg (page for browsers, JSON for clients)', async function () {
    const page = await fetchJson('/services/idlerpg', { headers: { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } });
    assert.strictEqual(page.status, 200);
    assert.ok(page.body.includes('id="idlerpg-page"'));
    assert.ok(page.body.includes('id="idlerpg-players"'));
    assert.ok(page.body.includes('<meta property="og:title" content="IDLERPG — GOON SQUAD">'), 'per-page Open Graph');
    assert.ok(page.body.includes('<link rel="canonical" href="https://goon.vc/services/idlerpg">'));
    assert.ok(page.body.includes('"/services/idlerpg/players"'));
    const res = await fetchJson('/services/idlerpg/players?limit=10');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.players, []);
    assert.strictEqual(res.json.count, 0);
  });

  it('serves the drills index and the melee rotation drill component at /drills', async function () {
    const index = await fetchJson('/drills', { headers: { Accept: 'text/html' } });
    assert.strictEqual(index.status, 200);
    assert.ok(index.body.includes('id="drills-page"'));
    assert.ok(index.body.includes('href="/drills/melee-rotation"'), 'index links to the drill');
    assert.ok(index.body.includes('<meta property="og:title" content="DRILLS — GOON SQUAD">'));

    const drill = await fetchJson('/drills/melee-rotation', { headers: { Accept: 'text/html' } });
    assert.strictEqual(drill.status, 200);
    assert.ok(drill.body.includes('<melee-rotation-drill class="drill-element" heading="Melee Rotation Drill"></melee-rotation-drill>'));
    assert.ok(drill.body.includes('<script src="/scripts/melee-rotation-drill.js" defer></script>'));
    assert.ok(drill.body.includes('<meta property="og:title" content="Melee Rotation Drill — GOON SQUAD">'), 'per-drill Open Graph');

    const script = await fetchJson('/scripts/melee-rotation-drill.js');
    assert.strictEqual(script.status, 200);
    assert.ok(script.body.includes("customElements.define('melee-rotation-drill'"));

    const old = await fetchJson('/drills/melee-rotation-drill.html', { headers: { Accept: 'text/html' } });
    assert.strictEqual(old.status, 302);

    const slash = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: sitePort, path: '/drills/', headers: { Accept: 'text/html' } }, (incoming) => {
        incoming.resume();
        resolve({ status: incoming.statusCode, location: incoming.headers.location });
      }).on('error', reject);
    });
    assert.strictEqual(slash.status, 302);
    assert.strictEqual(slash.location, '/drills');
  });

  it('serves the tournaments index, created tournaments, and their records', async function () {
    const index = await fetchJson('/tournaments', { headers: { Accept: 'text/html' } });
    assert.strictEqual(index.status, 200);
    assert.ok(index.body.includes('id="tournaments-page"'));
    assert.ok(!index.body.includes('saturday-1v1'), 'no built-in tournament pages');
    assert.ok(index.body.includes('id="tournament-create-form"'), 'anyone can create a tournament');
    assert.ok(index.body.includes('<meta property="og:title" content="TOURNAMENTS — GOON SQUAD">'));
    assert.ok(index.body.includes('<script src="/scripts/tournament-bracket.js" defer></script>'));
    assert.ok(index.body.includes('<script src="/scripts/tournaments.js" defer></script>'));

    const resources = index.body.slice(index.body.indexOf('id="resources-page"'));
    assert.ok(resources.slice(0, resources.indexOf('</main>')).includes('href="/tournaments"'), 'listed on /resources');

    const listing = await fetchJson('/services/tournaments');
    assert.strictEqual(listing.status, 200);
    assert.deepStrictEqual(listing.json.tournaments, []);

    const post = (pathname, body, method = 'POST') => fetchJson(pathname, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const created = await post('/services/tournaments', {
      name: 'Saturday 1v1',
      format: 'double-elimination',
      bestOf: 3,
      startsAt: '2026-10-18T01:00:00Z',
      timeZone: 'America/Chicago',
      players: ['VIPER', 'KESTREL']
    });
    assert.strictEqual(created.status, 201);
    assert.strictEqual(created.json.id, 'saturday-1v1/2026-10-17');
    assert.strictEqual((await post('/services/tournaments/saturday-1v1', {})).status, 405, 'tournaments are created from the index only');
    const record = `/services/tournaments/saturday-1v1/${created.json.slug}`;
    for (let i = 0; i < 2; i++) assert.strictEqual((await post(`${record}/games`, { match: 'W1-1', side: 0, players: [0, 1] })).status, 200);
    const late = await post(`${record}/players`, { name: 'NOMAD' });
    assert.strictEqual(late.status, 409, 'a two-player bracket has no open seat');
    assert.match(late.json.error, /bracket is full/);
    for (const match of ['F1-1', 'F1-1']) await post(`${record}/games`, { match, side: 0 });
    const final = await fetchJson(record);
    assert.strictEqual(final.json.status, 'complete');
    assert.strictEqual(final.json.results.champion, 'VIPER');
    assert.strictEqual((await post(`${record}/undo`, { match: 'F1-1' })).status, 409, 'results are permanent');
    assert.strictEqual((await fetchJson('/services/tournaments/saturday-1v1/2020-01-01')).status, 404);
    assert.strictEqual((await fetchJson('/services/tournaments/nope')).status, 404);
    assert.strictEqual((await fetchJson('/services/tournaments/saturday-1v1')).json.tournaments.length, 1);

    const recordPage = await fetchJson(`/tournaments/saturday-1v1/${created.json.slug}`, { headers: { Accept: 'text/html' } });
    assert.strictEqual(recordPage.status, 200);
    assert.ok(recordPage.body.includes('<meta property="og:title" content="Saturday 1v1 — 2026-10-17 — GOON SQUAD">'));
    assert.ok(recordPage.body.includes('Champion: VIPER; runner-up: KESTREL.'), 'link previews name the winners');
    const seriesPage = await fetchJson('/tournaments/saturday-1v1', { headers: { Accept: 'text/html' } });
    assert.ok(seriesPage.body.includes('<meta property="og:title" content="Saturday 1v1 — GOON SQUAD">'));

    const script = await fetchJson('/scripts/tournament-bracket.js');
    assert.strictEqual(script.status, 200);
    assert.ok(script.body.includes("customElements.define('tournament-bracket'"));

    const slash = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: sitePort, path: '/tournaments/', headers: { Accept: 'text/html' } }, (incoming) => {
        incoming.resume();
        resolve({ status: incoming.statusCode, location: incoming.headers.location });
      }).on('error', reject);
    });
    assert.strictEqual(slash.status, 302);
    assert.strictEqual(slash.location, '/tournaments');
  });

  it('redirects the old IdleRPG URLs to /services/idlerpg', async function () {
    const old = await fetchJson('/idlerpg', { headers: { Accept: 'text/html' } });
    assert.strictEqual(old.status, 302);
    const api = await new Promise((resolve, reject) => {
      http.get({ hostname: '127.0.0.1', port: sitePort, path: '/services/presence/players?limit=5' }, (incoming) => {
        incoming.resume();
        resolve({ status: incoming.statusCode, location: incoming.headers.location });
      }).on('error', reject);
    });
    assert.strictEqual(api.status, 308);
    assert.strictEqual(api.location, '/services/idlerpg/players?limit=5');
  });

  it('serves the organizations index and a page per member org in the PERMAFLEET section', async function () {
    const base = '/organizations';
    const res = await fetchJson(`${base}/AIMOS`, { headers: { Accept: 'text/html' } });
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('id="organizations-page"'));
    const siteNav = /<p class="site-nav">([\s\S]*?)<\/p>/.exec(res.body)[1];
    assert.ok(!siteNav.includes('Organizations') && !siteNav.includes('ORGANIZATIONS'), 'not in the site header');
    assert.ok(new RegExp(`id="operation-permafleet"[\\s\\S]*?Weekly ops schedule &raquo;</a> · <a href="${base}">Member organizations &raquo;</a>`).test(res.body), 'linked from PERMAFLEET');
    for (const symbol of ['G00N', 'INFN', 'TRDE', 'LCRP', 'DOUBLEDOGZ', '4MCONTRACT', 'AIMOS']) {
      assert.ok(res.body.includes(`id="org-${symbol}"`), `${symbol} page`);
      assert.ok(res.body.includes(`href="https://robertsspaceindustries.com/orgs/${symbol}"`), `${symbol} RSI link`);
      assert.ok(res.body.includes(`<li><a href="${base}/${symbol}">`), `${symbol} charter chip`);
    }
    assert.ok(res.body.includes('>Apply on RSI</a>'));
    assert.ok(res.body.includes('pf-section'), 'organizations pages are part of the PERMAFLEET section');

    const index = await fetchJson(base, { headers: { Accept: 'text/html' } });
    assert.strictEqual(index.status, 200);
    assert.ok(index.body.includes('<meta property="og:title" content="PERMAFLEET Organizations — GOON SQUAD">'));
    assert.ok(index.body.includes('<meta property="og:image" content="https://goon.vc/hero-quantum.jpg">'));
    const orgIndex = index.body.slice(index.body.indexOf('<main id="organizations-page"'));
    const cta = orgIndex.slice(orgIndex.indexOf('<section class="org-roster-cta"'), orgIndex.indexOf('</section>'));
    assert.ok(cta.includes('<h2 id="org-roster-cta-title">Want to add your organization to the roster?</h2>'));
    const hotline = /#embassy chat on the <a href="([^"]+)"/.exec(index.body)[1];
    assert.ok(cta.includes(`<a class="goon-button" href="${hotline}" target="_blank" rel="noopener noreferrer">Go to #embassy &raquo;</a>`), 'same Discord as the #embassy hotline');
    assert.ok(orgIndex.indexOf('org-roster-cta') < orgIndex.indexOf('</main>'), 'on the index');
    assert.strictEqual(index.body.split('class="org-roster-cta"').length, 2, 'index only, not each org profile');
  });

  it('gives the PERMAFLEET section its own header menu', async function () {
    const res = await fetchJson('/operations/PERMAFLEET', { headers: { Accept: 'text/html' } });
    const start = res.body.indexOf('id="permafleet-header"');
    assert.ok(start > 0, 'PERMAFLEET header');
    assert.strictEqual(res.body.split('id="permafleet-header"').length, 2, 'one shared PERMAFLEET header');
    const header = res.body.slice(start, res.body.indexOf('</header>', start));
    assert.ok(header.includes('<a class="pf-header-home" href="/">&larr; GOON SQUAD</a>'));
    assert.ok(header.includes('<a class="pf-header-name" href="/operations/PERMAFLEET">PERMAFLEET</a>'));
    const labels = [...header.matchAll(/<a [^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => `${m[2]} ${m[1]}`);
    assert.deepStrictEqual(labels.slice(2), [
      'Overview /operations/PERMAFLEET',
      'Schedule /operations/PERMAFLEET/schedule',
      'Squadrons /operations/PERMAFLEET/squadrons',
      'Organizations /organizations',
      'Join https://discord.com/invite/M4h9bBWq'
    ]);
    assert.ok(!res.body.includes('class="op-nav"') && !res.body.includes('class="schedule-nav"'), 'replaces the per-page crumbs');
    assert.ok(res.body.includes("document.body.classList.toggle('pf-section', isPermafleet || isSchedule || isSquadrons || !!squadronEl || isOrganizations || !!orgEl);"));
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
      assert.ok(res.body.includes(`href="${file.href}" data-download download>`), `${file.platform} download`);
      assert.ok(res.body.includes(`sha256 ${file.sha256}`), `${file.platform} checksum`);
    }
    if (manifest.files.length) {
      assert.ok(res.body.includes('class="goon-button gooncitizen-fallback"'), 'Discord fallback when no installer is on the server');
      assert.ok(res.body.includes("querySelectorAll('a[data-download]')"), 'availability check');
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
    assert.ok(/<footer>[\s\S]*href="\/services\/discord\/invite"[^>]*>Add our bot to your Discord<\/a>/.test(page), 'add-bot button in the footer');
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
    const header = res.body.slice(res.body.indexOf('id="site-header"'), res.body.indexOf('</header>'));
    assert.ok(header.includes('<a href="/operations/PERMAFLEET">PERMAFLEET</a>'), 'links straight to PERMAFLEET');
    assert.ok(!header.includes('OPERATIONS'), 'no OPERATIONS link in the header');
    assert.ok(header.indexOf('EVENTS') < header.indexOf('RESOURCES') && header.indexOf('RESOURCES') < header.indexOf('>PERMAFLEET<'), 'PERMAFLEET is the rightmost link');
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

  it('reports the bot invite as unavailable without a Discord bot token', async function () {
    const res = await fetchJson('/services/discord/invite');
    assert.strictEqual(res.status, 503);
  });

  it('hides subscription tiers without a Discord bot token', async function () {
    const res = await fetchJson('/services/discord/subscriptions');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.tiers, []);
    assert.strictEqual(res.json.stale, true);
    const home = await fetchJson('/', { headers: { Accept: 'text/html' } });
    assert.strictEqual(typeof home.json, 'string');
    assert.ok(home.json.includes('id="home-subscriptions" class="home-subscriptions" hidden'), 'subscriptions start hidden');
    assert.ok(home.json.includes("fetch('/services/discord/subscriptions'"), 'home page loads tiers');
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
