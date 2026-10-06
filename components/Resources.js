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
      .gooncitizen-section .gooncitizen-note { margin: 0.75rem 0 0; text-align: left; }`;
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
 * @param {Array<{ name: string, path: string, tagline?: string, summary?: string, links?: Array<{ label: string, href: string }> }>} props.resources Plain text.
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderIndexHtml (props) {
  const cards = props.resources.map((item) => {
    const links = [{ label: 'Open', href: item.path }].concat(item.links || []).map(button).join('');
    return `<article class="operation-card">
          <h2 class="operation-name"><a href="${escapeHtml(item.path)}">${escapeHtml(item.name)}</a></h2>
          ${item.tagline ? `<p class="operation-tagline">${escapeHtml(item.tagline)}</p>` : ''}
          ${item.summary ? `<p class="operation-summary">${escapeHtml(item.summary)}</p>` : ''}
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
    ? downloads.map((d) => `<a class="goon-button" href="${escapeHtml(d.href)}" download>${escapeHtml(d.label)}</a>`).join('')
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
  renderGoonCitizen: renderGoonCitizenHtml
};
