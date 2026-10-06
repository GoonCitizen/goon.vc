'use strict';

const escapeHtml = require('../functions/escapeHtml');

function renderOperationsCss () {
  return `
      .operations-page { display: none; margin: 0 auto; max-width: 38em; padding: 0 1em 3em; text-align: left; }
      .operations-page > h1, .operations-page > .operations-intro { text-align: center; }
      .operations-intro { color: #bbb; font-size: 0.92em; line-height: 1.45; margin: 0 auto 2em; max-width: 28em; }
      .operations-grid { display: flex; flex-direction: column; gap: 1.25rem; }
      .operation-card {
        background: rgba(0, 0, 0, 0.22);
        border: 1px solid #555;
        border-radius: 10px;
        padding: 1rem 1.15rem;
      }
      .operation-name { font-size: 1.2rem; margin: 0 0 0.35rem; }
      .operation-name a { border-bottom: 1px solid rgba(255, 255, 255, 0.25); text-decoration: none; }
      .operation-name a:hover { border-bottom-color: #fff; }
      .operation-tagline { color: #fff; margin: 0 0 0.5rem; }
      .operation-summary { color: #aaa; font-size: 0.9rem; line-height: 1.4; margin: 0 0 0.75rem; }
      .operation-links { display: flex; flex-wrap: wrap; gap: 0.5em; }
      .operation-links .goon-button { font-size: 0.75em; padding: 0.35em 0.75em; }
      .operations-empty { color: #888; padding: 2em 0; text-align: center; }`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {Array<{ name: string, path: string, tagline?: string, summary?: string, links?: Array<{ label: string, href: string }> }>} props.operations Plain text.
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderOperationsHtml (props) {
  const cards = props.operations.map((op) => {
    const links = [{ label: 'Briefing', href: op.path }].concat(op.links || [])
      .map((link) => {
        const external = /^https?:/i.test(link.href);
        return `<a class="goon-button" href="${escapeHtml(link.href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(link.label)}</a>`;
      })
      .join('');
    return `<article class="operation-card">
          <h2 class="operation-name"><a href="${escapeHtml(op.path)}">${escapeHtml(op.name)}</a></h2>
          ${op.tagline ? `<p class="operation-tagline">${escapeHtml(op.tagline)}</p>` : ''}
          ${op.summary ? `<p class="operation-summary">${escapeHtml(op.summary)}</p>` : ''}
          <div class="operation-links">${links}</div>
        </article>`;
  }).join('\n');
  return `<main id="operations-page" class="operations-page">
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <div class="operations-grid">
        ${cards || '<p class="operations-empty">No operations yet.</p>'}
      </div>
      <footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

module.exports = {
  id: 'operations-page',
  styles: renderOperationsCss,
  render: renderOperationsHtml
};
