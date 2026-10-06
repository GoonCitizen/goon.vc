'use strict';

const escapeHtml = require('../functions/escapeHtml');

const SECTIONS = [
  { key: 'history', label: 'History' },
  { key: 'manifesto', label: 'Manifesto' },
  { key: 'charter', label: 'Charter' }
];

function renderOrganizationsCss () {
  return `
      .organizations-page, .organization-page { display: none; margin: 0 auto; max-width: 38em; padding: 0 1em 3em; text-align: left; }
      .organizations-page > h1, .organizations-intro { text-align: center; }
      .organizations-intro { color: #bbb; font-size: 0.92em; line-height: 1.45; margin: 0 auto 2em; max-width: 28em; }
      .organizations-grid { display: flex; flex-direction: column; gap: 1.25rem; }
      .org-card, .org-profile {
        background: rgba(0, 0, 0, 0.22);
        border: 1px solid #555;
        border-radius: 10px;
        overflow: hidden;
      }
      .org-card { display: flex; gap: 1rem; padding: 1rem 1.15rem; }
      .org-logo { flex: 0 0 auto; height: 72px; object-fit: contain; width: 72px; }
      .org-card-body { flex: 1 1 auto; min-width: 0; }
      .org-name { font-size: 1.2rem; margin: 0 0 0.25rem; }
      .org-name a { border-bottom: 1px solid rgba(255, 255, 255, 0.25); text-decoration: none; }
      .org-name a:hover { border-bottom-color: #fff; }
      .org-meta { color: #c9c9c9; font-size: 0.88rem; margin: 0 0 0.35rem; }
      .org-symbol { color: #fff; font-weight: 700; letter-spacing: 0.08em; }
      .org-focus { color: #aaa; font-size: 0.85rem; margin: 0 0 0.6rem; }
      .org-summary { color: #ddd; line-height: 1.4; margin: 0 0 0.75rem; overflow-wrap: anywhere; }
      .org-links { display: flex; flex-wrap: wrap; gap: 0.5em; }
      .org-links .goon-button { font-size: 0.75em; padding: 0.35em 0.75em; }
      .org-banner { aspect-ratio: 4 / 1; background: #222; display: block; object-fit: cover; width: 100%; }
      .org-profile-head { align-items: center; display: flex; gap: 1rem; padding: 1rem 1.15rem 0; }
      .org-profile-head h1 { font-size: 1.6rem; margin: 0; }
      .org-profile-body { padding: 0.75rem 1.15rem 1.15rem; }
      .org-profile-body p { line-height: 1.45; overflow-wrap: anywhere; }
      .org-actions { display: flex; flex-wrap: wrap; gap: 0.6em; margin: 1rem 0; }
      .org-section { border-top: 1px solid #444; padding: 0.6rem 0; }
      .org-section summary { cursor: pointer; font-family: "Bungee", sans-serif; letter-spacing: 0.05em; }
      .org-section p { color: #ccc; font-size: 0.95rem; margin: 0.6rem 0; }
      .org-source { color: #888; font-size: 0.78rem; margin-top: 1rem; text-align: center; }
      .organizations-empty { color: #888; padding: 2em 0; text-align: center; }`;
}

function externalLink (href, label, extra = '') {
  return `<a class="goon-button" href="${escapeHtml(href)}" target="_blank" rel="noopener"${extra}>${escapeHtml(label)}</a>`;
}

function metaLine (org) {
  const parts = [`<span class="org-symbol">[${escapeHtml(org.symbol)}]</span>`];
  if (Number.isFinite(org.members)) parts.push(`${org.members} ${org.members === 1 ? 'member' : 'members'}`);
  for (const tag of [org.model, org.commitment, org.roleplay]) {
    if (tag) parts.push(escapeHtml(tag));
  }
  return `<p class="org-meta">${parts.join(' · ')}</p>`;
}

function focusLine (org) {
  const focus = [org.focus && org.focus.primary, org.focus && org.focus.secondary].filter(Boolean);
  return focus.length ? `<p class="org-focus">Focus: ${focus.map(escapeHtml).join(' / ')}</p>` : '';
}

function rsiButtons (org) {
  const buttons = [externalLink(org.url, 'RSI page')];
  if (org.recruiting) buttons.push(externalLink(org.url, 'Apply', ' title="Opens the RSI org page; choose “Join us now!” there"'));
  return buttons.join('');
}

function logoImg (org) {
  return org.logoUrl
    ? `<img class="org-logo" src="${escapeHtml(org.logoUrl)}" alt="${escapeHtml(org.displayName || org.name)} logo" loading="lazy">`
    : '';
}

/**
 * @param {Object} org Record from contracts/organizations.json (plain text).
 * @param {string} basePath
 * @returns {string}
 */
function organizationPath (org, basePath) {
  return `${basePath}/${encodeURIComponent(org.symbol)}`;
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

function renderSource (props) {
  if (!props.fetchedAt) return '';
  const date = String(props.fetchedAt).slice(0, 10);
  return `<p class="org-source">Organization details from the public RSI org pages, fetched ${escapeHtml(date)}.</p>`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.basePath
 * @param {Array<Object>} props.organizations Plain-text records.
 * @param {string} [props.fetchedAt]
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderIndexHtml (props) {
  const cards = props.organizations.map((org) => {
    const href = organizationPath(org, props.basePath);
    const summary = (org.intro || [])[0];
    return `<article class="org-card">
          ${logoImg(org)}
          <div class="org-card-body">
            <h2 class="org-name"><a href="${escapeHtml(href)}">${escapeHtml(org.displayName || org.name)}</a></h2>
            ${metaLine(org)}
            ${focusLine(org)}
            ${summary ? `<p class="org-summary">${escapeHtml(summary)}</p>` : ''}
            <div class="org-links"><a class="goon-button" href="${escapeHtml(href)}">Profile</a>${rsiButtons(org)}</div>
          </div>
        </article>`;
  }).join('\n');
  return `<main id="organizations-page" class="organizations-page">
      <h1>${props.heading}</h1>
      <p class="organizations-intro">${props.intro}</p>
      <div class="organizations-grid">
        ${cards || '<p class="organizations-empty">No member organizations listed.</p>'}
      </div>
      ${renderSource(props)}
      ${renderFooter(props)}
    </main>`;
}

/**
 * @param {Object} org Plain-text record.
 * @param {Object} props Same shape as renderIndexHtml props plus allianceName / alliancePath.
 */
function renderOrganizationHtml (org, props) {
  const name = org.displayName || org.name;
  const linkLabels = new Set((org.links || []).map((link) => link.label.replace(/[\s»…]+$/, '')));
  const intro = (org.intro || [])
    .filter((p) => !linkLabels.has(p.replace(/[\s»…]+$/, '')))
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join('');
  const links = (org.links || []).map((link) => externalLink(link.href, link.label)).join('');
  const sections = SECTIONS
    .filter((section) => (org[section.key] || []).length)
    .map((section, i) => `<details class="org-section"${i === 0 ? ' open' : ''}>
            <summary>${section.label}</summary>
            ${org[section.key].map((p) => `<p>${escapeHtml(p)}</p>`).join('')}
          </details>`)
    .join('');
  const rsiName = org.displayName && org.name && org.displayName.toLowerCase() !== org.name.toLowerCase()
    ? `<p class="org-meta">Listed on RSI as <strong>${escapeHtml(org.name)}</strong></p>`
    : '';
  const alliance = props.alliancePath
    ? `<p class="org-meta">Member of the <a href="${escapeHtml(props.alliancePath)}">${escapeHtml(props.allianceName || 'PERMAFLEET')}</a> alliance.</p>`
    : '';
  return `<main id="org-${escapeHtml(org.symbol)}" class="organization-page" data-symbol="${escapeHtml(org.symbol)}">
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Organizations</a></p>
      <article class="org-profile">
        ${org.bannerUrl ? `<img class="org-banner" src="${escapeHtml(org.bannerUrl)}" alt="" loading="lazy">` : ''}
        <header class="org-profile-head">
          ${logoImg(org)}
          <h1>${escapeHtml(name)}</h1>
        </header>
        <div class="org-profile-body">
          ${metaLine(org)}
          ${rsiName}
          ${focusLine(org)}
          ${alliance}
          ${intro}
          <div class="org-actions">
            ${org.recruiting ? externalLink(org.url, 'Apply on RSI', ' title="Opens the RSI org page; choose “Join us now!” there"') : ''}
            ${externalLink(org.url, 'View on RSI')}
            ${externalLink(`${org.url}/members`, 'Members')}
            ${links}
          </div>
          ${sections}
        </div>
      </article>
      ${renderSource(props)}
      ${renderFooter(props)}
    </main>`;
}

module.exports = {
  id: 'organizations-page',
  styles: renderOrganizationsCss,
  render: renderIndexHtml,
  renderOrganization: renderOrganizationHtml,
  organizationPath
};
