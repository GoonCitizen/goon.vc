'use strict';

const escapeHtml = require('../functions/escapeHtml');

const CUSTOM_ELEMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;
const ATTRIBUTE = /^[a-z][a-z0-9-]*$/;

function renderDrillsCss () {
  return `
      .drills-page { display: none; margin: 0 auto; max-width: 38em; padding: 0 1em 3em; text-align: left; }
      .drills-page > h1, .drills-page > .operations-intro { text-align: center; }
      .drill-page { display: none; margin: 0 auto; max-width: 1180px; padding: 0 0 3em; }
      .drill-page .drill-element { background: none; }`;
}

/**
 * URL of one drill under the drills index.
 * @param {{ id: string }} drill
 * @param {string} basePath e.g. `/drills`
 * @returns {string}
 */
function drillPath (drill, basePath) {
  return `${String(basePath).replace(/\/+$/, '')}/${encodeURIComponent(drill.id)}`;
}

/**
 * Drills with a usable Web Component (`element` must be a valid custom element name).
 * @param {Array<Object>} drills
 * @returns {Array<Object>}
 */
function validDrills (drills) {
  return (drills || []).filter((drill) => drill && /^[a-z0-9-]+$/.test(String(drill.id || '')) && CUSTOM_ELEMENT.test(String(drill.element || '')));
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

/**
 * Index of drills: one card per drill, linking to its page.
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.basePath
 * @param {Array<{ id: string, name: string, tagline?: string, summary?: string, element: string }>} props.drills Plain text.
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 * @returns {string}
 */
function renderIndexHtml (props) {
  const cards = validDrills(props.drills).map((drill) => {
    const href = drillPath(drill, props.basePath);
    return `<article class="operation-card">
          <h2 class="operation-name"><a href="${escapeHtml(href)}">${escapeHtml(drill.name)}</a></h2>
          ${drill.tagline ? `<p class="operation-tagline">${escapeHtml(drill.tagline)}</p>` : ''}
          ${drill.summary ? `<p class="operation-summary">${escapeHtml(drill.summary)}</p>` : ''}
          <div class="operation-links"><a class="goon-button" href="${escapeHtml(href)}">Fly the drill</a></div>
        </article>`;
  }).join('\n');
  return `<main id="drills-page" class="drills-page">
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <div class="operations-grid">
        ${cards || '<p class="operations-empty">No drills yet.</p>'}
      </div>
      ${renderFooter(props)}
    </main>`;
}

/**
 * One page per drill; the page is the drill's Web Component.
 * @param {Object} props Same as {@link renderIndexHtml}, plus `siteTitle` for the document title.
 * @returns {string}
 */
function renderDrillPagesHtml (props) {
  return validDrills(props.drills).map((drill) => {
    const attributes = Object.entries(Object.assign({ heading: drill.name }, drill.attributes || {}))
      .filter(([name, value]) => ATTRIBUTE.test(name) && value !== undefined && value !== null && value !== false)
      .map(([name, value]) => value === true ? ` ${name}` : ` ${name}="${escapeHtml(String(value))}"`)
      .join('');
    const title = props.siteTitle ? `${drill.name} — ${props.siteTitle}` : drill.name;
    return `<main class="drill-page" id="drill-${escapeHtml(drill.id)}" data-path="${escapeHtml(drillPath(drill, props.basePath).toLowerCase())}" data-title="${escapeHtml(title)}">
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Drills</a></p>
      <${drill.element} class="drill-element"${attributes}></${drill.element}>
      ${renderFooter(props)}
    </main>`;
  }).join('\n');
}

/**
 * One deferred `<script>` per distinct drill element script.
 * @param {Object} props
 * @param {Array<{ script?: string }>} props.drills
 * @returns {string}
 */
function renderDrillsScript (props) {
  const scripts = [...new Set(validDrills(props.drills).map((drill) => drill.script).filter(Boolean))];
  return scripts.map((src) => `<script src="${escapeHtml(src)}" defer></script>`).join('\n    ');
}

module.exports = {
  id: 'drills-page',
  styles: renderDrillsCss,
  render: renderIndexHtml,
  renderDrills: renderDrillPagesHtml,
  script: renderDrillsScript,
  drillPath,
  validDrills
};
