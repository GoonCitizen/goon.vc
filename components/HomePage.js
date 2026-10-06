'use strict';

const escapeHtml = require('../functions/escapeHtml');
const DiscordRoster = require('./DiscordRoster');

function renderHomeCss () {
  return `
      .home-page { display: block; margin: 0 auto; max-width: 900px; }
      .home-columns { display: grid; gap: 2rem; grid-template-columns: minmax(0, 1fr) 350px; }
      /* Out of flow so the overview alone sets the row height; the roster scrolls within it. */
      .home-discord { position: relative; min-height: 16rem; }
      .home-discord .discord-roster { display: flex; flex-direction: column; inset: 0; margin: 0; position: absolute; }
      .home-discord .dr-body { flex: 1; max-height: none; min-height: 0; }
      @media (max-width: 760px) {
        .home-columns { grid-template-columns: minmax(0, 350px); justify-content: center; }
        .home-discord { min-height: 0; }
        .home-discord .discord-roster { position: static; }
        .home-discord .dr-body { max-height: 28rem; }
      }
      .home-overview { text-align: left; }
      .home-overview-head { align-items: center; display: flex; gap: 1rem; justify-content: flex-start; }
      .home-overview-head img { border: 1px solid #555; border-radius: 8px; height: 4.5rem; width: 4.5rem; }
      .home-overview-head h2 { margin: 0; }
      .home-facts { color: #bbb; font-size: 0.9rem; letter-spacing: 0.04em; margin: 0.35rem 0 0; }
      .home-overview p.home-copy { color: #ddd; line-height: 1.5; margin: 1rem 0 0; }
      .home-motto { color: #fff; font-family: "Bungee", sans-serif; font-size: 0.85rem; letter-spacing: 0.08em; margin: 1.25rem 0 0; }
      .home-actions { display: flex; flex-wrap: wrap; gap: 0.6rem; justify-content: flex-start; margin-top: 1.25rem; }
      .home-actions .goon-button { font-size: 0.8em; }
${DiscordRoster.styles()}`;
}

/**
 * @param {Object} overview
 * @param {string} overview.name
 * @param {string} [overview.logoUrl]
 * @param {string[]} overview.facts
 * @param {string[]} overview.paragraphs Trusted HTML.
 * @param {string[]} [overview.motto]
 * @param {Array<{ href: string, label: string }>} overview.actions
 */
function renderOverviewHtml (overview) {
  if (!overview) return '';
  const logo = overview.logoUrl ? `<img src="${escapeHtml(overview.logoUrl)}" alt="" loading="lazy">` : '';
  const facts = (overview.facts || []).filter(Boolean).map(escapeHtml).join(' · ');
  return `<section class="home-overview" aria-labelledby="home-overview-title">
        <div class="home-overview-head">
          ${logo}
          <div>
            <h2 id="home-overview-title">${escapeHtml(overview.name)}</h2>
            ${facts ? `<p class="home-facts">${facts}</p>` : ''}
          </div>
        </div>
        ${(overview.paragraphs || []).map((p) => `<p class="home-copy">${p}</p>`).join('\n        ')}
        ${(overview.motto || []).length ? `<p class="home-motto">${overview.motto.map(escapeHtml).join(' · ')}</p>` : ''}
        <div class="home-actions">${(overview.actions || []).map((a) => `<a class="goon-button" href="${escapeHtml(a.href)}">${escapeHtml(a.label)}</a>`).join('')}</div>
      </section>`;
}

/**
 * Title and nav live in SiteHeader.
 * @param {Object} props
 * @param {Object} props.overview See renderOverviewHtml.
 * @param {string} props.joinUrl
 * @param {string} props.joinLabel Trusted HTML.
 * @param {string} props.discordTitle
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.bitcoinAddress
 * @param {string} props.copyright Trusted HTML.
 */
function renderHomeMainHtml (props) {
  return `<main id="home-page" class="home-page">
      <div class="home-columns">
        ${renderOverviewHtml(props.overview)}
        <div class="home-discord">${DiscordRoster.render({ title: props.discordTitle, inviteUrl: props.joinUrl })}</div>
      </div>
      <footer>
        <div><h3><a href="${props.joinUrl}">${props.joinLabel}</a></h3></div>
        <div><a class="footer-login-button" href="${props.loginPath}">${props.loginLabel}</a></div>
        <div><a href="bitcoin:${escapeHtml(props.bitcoinAddress)}"><code>${escapeHtml(props.bitcoinAddress)}</code></a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

/**
 * @param {Object} props
 * @param {string} props.guildId
 */
function renderHomeScript (props) {
  return DiscordRoster.script({ guildId: props.guildId, pageId: 'home-page' });
}

module.exports = {
  id: 'home-page',
  styles: renderHomeCss,
  render: renderHomeMainHtml,
  script: renderHomeScript
};
