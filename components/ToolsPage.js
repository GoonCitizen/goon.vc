'use strict';

const fs = require('fs');
const path = require('path');
const escapeHtml = require('../functions/escapeHtml');

const ID_RE = /^[a-z0-9-]+$/;

function renderToolsCss () {
  return `
      .tools-page { display: none; margin: 0 auto; max-width: 38em; padding: 0 1em 3em; text-align: left; }
      .tools-page > h1, .tools-page > .operations-intro { text-align: center; }
      .tool-page { display: none; margin: 0 auto; max-width: 1180px; padding: 0 1em 3em; text-align: left; background: transparent; overflow: visible; }
      .tool-page .page-back { text-align: left; }
      .tool-sheet {
        --line: #5a5a5a; --ink: #eee; --mute: #aaa; --acc: #fff; --acc-ink: #222;
        --goon: #8f1d1d; --goon-hot: #b32626;
        background: transparent; color: #ddd; overflow: visible;
      }`;
}

/**
 * URL of one tool under the tools index.
 * @param {{ id: string }} tool
 * @param {string} basePath e.g. `/tools`
 * @returns {string}
 */
function toolPath (tool, basePath) {
  return `${String(basePath).replace(/\/+$/, '')}/${encodeURIComponent(tool.id)}`;
}

/**
 * Tools with an id, a name, and files the page can read.
 * @param {Array<Object>} tools
 * @returns {Array<Object>}
 */
function validTools (tools) {
  return (tools || []).filter((tool) => tool && ID_RE.test(String(tool.id || '')) && tool.name && tool.html && tool.css && tool.script);
}

function readTool (file) {
  return fs.readFileSync(path.resolve(file), 'utf8');
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

/**
 * Index of one-off tools.
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.basePath
 * @param {Array<Object>} props.tools
 * @returns {string}
 */
function renderIndexHtml (props) {
  const cards = validTools(props.tools).map((tool) => {
    const href = toolPath(tool, props.basePath);
    return `<article class="operation-card">
          <h2 class="operation-name"><a href="${escapeHtml(href)}">${escapeHtml(tool.name)}</a></h2>
          ${tool.tagline ? `<p class="operation-tagline">${escapeHtml(tool.tagline)}</p>` : ''}
          ${tool.summary ? `<p class="operation-summary">${escapeHtml(tool.summary)}</p>` : ''}
          <div class="operation-links"><a class="goon-button" href="${escapeHtml(href)}">${escapeHtml(tool.openLabel || 'Open')}</a></div>
        </article>`;
  }).join('\n');
  return `<main id="tools-page" class="tools-page">
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <div class="operations-grid">
        ${cards || '<p class="operations-empty">No tools yet.</p>'}
      </div>
      ${renderFooter(props)}
    </main>`;
}

/**
 * One page per tool, inside the site shell so the header stays.
 * The tool's own stylesheet is scoped to its sheet. Its script is named on
 * the page and loaded by the router only when that page is open.
 * @param {Object} props
 * @returns {string}
 */
function renderToolPagesHtml (props) {
  return validTools(props.tools).map((tool) => {
    const href = toolPath(tool, props.basePath);
    const title = props.siteTitle ? `${tool.name} — ${props.siteTitle}` : tool.name;
    return `<main class="tool-page" id="tool-${escapeHtml(tool.id)}" data-path="${escapeHtml(href.toLowerCase())}" data-title="${escapeHtml(title)}" data-script="${escapeHtml(tool.script)}">
      <div class="tool-sheet">
        <style>@scope (.tool-sheet) { ${readTool(tool.css)} }</style>
        ${readTool(tool.html)}
      </div>
      ${renderFooter(props)}
    </main>`;
  }).join('\n');
}

/**
 * Styles contributed by each tool, already scoped by {@link renderToolPagesHtml}.
 * Kept so the page chrome (index and sheet) has a home.
 * @returns {string}
 */
function renderToolStyles () {
  return renderToolsCss();
}

module.exports = {
  id: 'tools-page',
  styles: renderToolStyles,
  render: renderIndexHtml,
  renderTools: renderToolPagesHtml,
  toolPath,
  validTools
};
