'use strict';

const escapeHtml = require('../functions/escapeHtml');

const GOONCITIZEN_FEATURES = [
  {
    title: 'Track your stats',
    body: 'Reads your Star Citizen Game.log as you play and keeps a running history across sessions and restarts: missions, outcomes, deaths, play sessions, and a heatmap of when you fly.'
  },
  {
    title: 'Fly with your group',
    body: 'Create a group for your friends or your org, chat in its channel, broadcast open missions to members, and share fleets so everyone knows what is in the hangar.'
  },
  {
    title: 'Missions with receipts',
    body: 'Officers post missions, members apply and do the work, and an officer signs off on completion. Every change lands in a tamper-evident audit log.'
  },
  {
    title: 'One chat, everywhere',
    body: 'Global shoutbox, group channels, and bridged Discord channels in one window, with optional desktop notifications.'
  },
  {
    title: 'Private by default',
    body: 'GoonCitizen only ever reads the game log; it never touches your install. Sharing gameplay with other players is opt-in, per group or per peer.'
  }
];

function renderResourcesCss () {
  return `
      .resources-page, .gooncitizen-page { display: none; margin: 0 auto; max-width: 38em; padding: 0 1em 3em; text-align: left; }
      .resources-page > h1, .resources-page > .operations-intro { text-align: center; }
      .gooncitizen-hero { text-align: center; }
      .gooncitizen-hero h1 { font-size: 2.2rem; margin: 0.25rem 0 0.35rem; }
      .gooncitizen-tagline { color: #fff; font-size: 1.15rem; margin: 0 0 0.75rem; }
      .gooncitizen-intro { color: #bbb; line-height: 1.45; margin: 0 auto 1.25rem; max-width: 32em; }
      .gooncitizen-actions { display: flex; flex-wrap: wrap; gap: 0.6em; justify-content: center; margin: 0 0 0.75rem; }
      .gooncitizen-note { color: #999; font-size: 0.85rem; line-height: 1.4; margin: 0 auto 2rem; max-width: 32em; text-align: center; }
      .gooncitizen-features { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); margin-bottom: 1.5rem; }
      .gooncitizen-features h2 { font-size: 1rem; margin: 0 0 0.4rem; }
      .gooncitizen-features p { color: #bbb; font-size: 0.92rem; line-height: 1.4; margin: 0; }
      .gooncitizen-section h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
      .gooncitizen-section ul { color: #ccc; line-height: 1.5; margin: 0; padding-left: 1.25rem; }
      .gooncitizen-downloads li { margin-bottom: 0.5rem; }
      .gooncitizen-sha { color: #999; font-size: 0.72rem; overflow-wrap: anywhere; }
      .gooncitizen-section .gooncitizen-note { margin: 0.75rem 0 0; text-align: left; }
      .gooncitizen-actions .goon-button[aria-disabled="true"] { cursor: not-allowed; opacity: 0.45; }
      .gooncitizen-actions .goon-button[hidden] { display: none; }
      #idlerpg-card { border-color: #4C1D95; border-style: dashed; }
      #idlerpg-card .operation-name a { color: #c4b5fd; }`;
}

/**
 * Installers are gitignored (over GitHub's file limit), so a deploy can ship
 * the page without them. Once the page is on screen, HEAD each download and
 * disable the ones this server can't serve; if none can, offer Discord.
 * @returns {string}
 */
function renderGoonCitizenScript () {
  return `<script>
    (function () {
      var page = document.getElementById('gooncitizen-page');
      if (!page) return;
      var links = Array.prototype.slice.call(page.querySelectorAll('a[data-download]'));
      if (!links.length) return;
      var checked = false;

      function unavailable (link) {
        link.removeAttribute('href');
        link.removeAttribute('download');
        link.setAttribute('aria-disabled', 'true');
        link.title = 'Not available on this server yet';
      }

      function check () {
        if (checked) return;
        checked = true;
        Promise.all(links.map(function (link) {
          return fetch(link.getAttribute('href'), { method: 'HEAD', cache: 'no-store' })
            .then(function (res) { return res.ok; })
            .catch(function () { return false; })
            .then(function (ok) { if (!ok) unavailable(link); return ok; });
        })).then(function (results) {
          var fallback = page.querySelector('.gooncitizen-fallback');
          if (fallback && results.indexOf(true) === -1) fallback.hidden = false;
        });
      }

      if (!('IntersectionObserver' in window)) return check();
      new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) check();
      }).observe(page);
    })();
  </script>`;
}

/**
 * Fills the IdleRPG stats strip from GET /services/idlerpg (aggregates only)
 * while the resources page is on screen (polls every minute).
 * @param {{ endpoint?: string, refreshMs?: number }} [opts]
 * @returns {string}
 */
function renderPresenceScript (opts = {}) {
  const endpoint = JSON.stringify(opts.endpoint || '/services/idlerpg');
  const refreshMs = Number(opts.refreshMs) > 0 ? Number(opts.refreshMs) : 60000;
  return `<script>
    (function () {
      var page = document.getElementById('resources-page');
      var strip = document.getElementById('presence-strip');
      if (!page || !strip) return;
      var timer = null;
      var visible = false;

      function fmt (n) {
        if (!(n > 0)) return '0';
        if (n >= 100) return String(Math.round(n));
        return String(Math.round(n * 10) / 10);
      }

      function metric (value, label, cls) {
        var li = document.createElement('li');
        li.className = 'operation-metric' + (cls ? ' ' + cls : '');
        var v = document.createElement('span');
        v.className = 'operation-metric-value';
        v.textContent = value;
        var l = document.createElement('span');
        l.className = 'operation-metric-label';
        l.textContent = label;
        li.appendChild(v);
        li.appendChild(l);
        return li;
      }

      function render (data) {
        if (!data) return;
        var items = [];
        if (data.presentNow > 0) items.push(metric(String(data.presentNow), 'playing now', 'operation-metric-live'));
        if (data.uniquePlayers > 0) items.push(metric(String(data.uniquePlayers), 'players'));
        if (data.totalPresentHours > 0) items.push(metric(fmt(data.totalPresentHours), 'hours idled'));
        if (data.last7Days && data.last7Days.peak > 0) items.push(metric(String(data.last7Days.peak), 'peak, 7 days'));
        var top = Object.keys(data.levels || {}).map(Number).filter(function (n) { return n > 0; });
        if (top.length) items.push(metric(String(Math.max.apply(null, top)), 'top level'));
        strip.textContent = '';
        items.forEach(function (item) { strip.appendChild(item); });
        strip.hidden = !items.length;
      }

      function load () {
        fetch(${endpoint}, { headers: { Accept: 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(render)
          .catch(function () {});
      }

      if (!('IntersectionObserver' in window)) { load(); return; }
      new IntersectionObserver(function (entries) {
        var now = entries.some(function (e) { return e.isIntersecting; });
        if (now && !visible) load();
        visible = now;
        if (timer) clearInterval(timer);
        timer = visible ? setInterval(load, ${refreshMs}) : null;
      }).observe(page);
    })();
  </script>`;
}

function button (link) {
  const external = /^https?:/i.test(link.href);
  return `<a class="goon-button" href="${escapeHtml(link.href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(link.label)}</a>`;
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {Array<{ id?: string, name: string, path: string, tagline?: string, summary?: string, openLabel?: string, presence?: boolean, links?: Array<{ label: string, href: string }> }>} props.resources Plain text. `presence` reserves the IdleRPG stats strip filled from /services/idlerpg.
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderIndexHtml (props) {
  const cards = props.resources.map((item) => {
    const links = [{ label: item.openLabel || 'Open', href: item.path }].concat(item.links || []).map(button).join('');
    return `<article class="operation-card"${item.id ? ` id="${escapeHtml(item.id)}"` : ''}>
          <h2 class="operation-name"><a href="${escapeHtml(item.path)}">${escapeHtml(item.name)}</a></h2>
          ${item.tagline ? `<p class="operation-tagline">${escapeHtml(item.tagline)}</p>` : ''}
          ${item.summary ? `<p class="operation-summary">${escapeHtml(item.summary)}</p>` : ''}
          ${item.presence ? '<ul class="operation-metrics" id="presence-strip" aria-label="IdleRPG presence" hidden></ul>' : ''}
          <div class="operation-links">${links}</div>
        </article>`;
  }).join('\n');
  return `<main id="resources-page" class="resources-page">
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <div class="operations-grid">
        ${cards || '<p class="operations-empty">No resources yet.</p>'}
      </div>
      ${renderFooter(props)}
    </main>`;
}

/**
 * @param {Object} props
 * @param {string} props.resourcesPath
 * @param {string} props.tagline Plain text.
 * @param {string} props.summary Plain text.
 * @param {Array<{ label: string, href: string }>} props.downloads Installer links; empty until a public release exists.
 * @param {string} props.repoUrl
 * @param {string} props.discordUrl
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderGoonCitizenHtml (props) {
  const downloads = props.downloads || [];
  const actions = downloads.length
    ? downloads.map((d) => `<a class="goon-button" href="${escapeHtml(d.href)}" data-download download>${escapeHtml(d.label)}</a>`).join('')
      + `<a class="goon-button gooncitizen-fallback" href="${escapeHtml(props.discordUrl)}" target="_blank" rel="noopener" hidden>Get a build on Discord</a>`
    : [{ label: 'Get a build on Discord', href: props.discordUrl }, { label: 'Source on GitHub', href: props.repoUrl }].map(button).join('');
  const version = downloads.find((d) => d.version);
  const note = downloads.length
    ? `${version ? `Pre-release ${version.version}. ` : ''}Future builds will be published to the Fabric network. Free and open source (MIT).`
    : 'Installers for Windows, macOS, and Linux are in testing with the Squad. Ask in the Discord for a build, or run it from source.';
  const checksums = downloads.filter((d) => d.sha256).map((d) => `<li><strong>${escapeHtml(d.label)}</strong>${Number.isFinite(d.size) ? ` · ${(d.size / 1048576).toFixed(0)} MB` : ''}${d.builtAt ? ` · built ${escapeHtml(String(d.builtAt).slice(0, 10))}` : ''}<br><code class="gooncitizen-sha">sha256 ${escapeHtml(d.sha256)}</code></li>`).join('');
  const features = GOONCITIZEN_FEATURES.map((f) => `<article class="operation-card"><h2>${escapeHtml(f.title)}</h2><p>${escapeHtml(f.body)}</p></article>`).join('\n');
  return `<main id="gooncitizen-page" class="gooncitizen-page">
      <p class="page-back"><a href="${escapeHtml(props.resourcesPath)}">&larr; Resources</a></p>
      <section class="gooncitizen-hero">
        <h1>GoonCitizen</h1>
        <p class="gooncitizen-tagline">${escapeHtml(props.tagline)}</p>
        <p class="gooncitizen-intro">${escapeHtml(props.summary)}</p>
        <div class="gooncitizen-actions">${actions}</div>
        <p class="gooncitizen-note">${escapeHtml(note)}</p>
      </section>
      <section class="gooncitizen-features" aria-label="Features">
        ${features}
      </section>
      <section class="gooncitizen-section">
        <h2>Requirements</h2>
        <ul>
          <li>Windows, with Star Citizen installed. GoonCitizen finds your install and channel (LIVE, PTU, EPTU, HOTFIX) on its own.</li>
          <li>Linux with Star Citizen under Wine or Proton is detected too.</li>
          <li>macOS and Linux builds also run without the game, for groups, chat, and missions.</li>
        </ul>
        <h2>Good to know</h2>
        <ul>
          <li>Kill tracking only works on old logs: CIG stopped logging kills after Star Citizen 4.3.0. Combat shows up as progress on mission objectives instead.</li>        </ul>
        ${checksums ? `<h2>Downloads</h2>
        <ul class="gooncitizen-downloads">${checksums}</ul>
        <p class="gooncitizen-note">Source: <a href="${escapeHtml(props.repoUrl)}" target="_blank" rel="noopener">GitHub</a>. Pre-release builds are not code-signed. Windows: choose More info → Run anyway if SmartScreen warns. macOS: if the app is blocked, open System Settings → Privacy &amp; Security and choose Open Anyway. Android: allow installs from unknown sources to sideload.</p>` : ''}
      </section>
      ${renderFooter(props)}
    </main>`;
}

module.exports = {
  id: 'resources-page',
  styles: renderResourcesCss,
  render: renderIndexHtml,
  renderGoonCitizen: renderGoonCitizenHtml,
  gooncitizenScript: renderGoonCitizenScript,
  presenceScript: renderPresenceScript
};
