'use strict';

const escapeHtml = require('../functions/escapeHtml');

const API = '/services/alliance/federations';
const PAGE_SCRIPT = '/scripts/federations.js';

function renderStyles () {
  return `
      .pf-federations-list h3 small { margin-left: 0.5rem; color: var(--pf-muted); font-size: 0.8rem; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; }
      .pf-federations-list li.organization { border-left-color: var(--pf-cyan); }
      .pf-federations-list li.retired { opacity: 0.7; }
      .pf-federation-id { font-family: monospace; font-size: 0.85rem; word-break: break-all; }`;
}

/**
 * Every Fabric federation goon.vc keeps for the alliance: the PERMAFLEET
 * federation of member orgs and each org's federation of officers. Not in
 * the PERMAFLEET menu; votes pages link here.
 * @param {Object} props
 * @param {string} props.basePath
 * @param {string} props.votesPath
 * @returns {string}
 */
function renderIndexHtml (props) {
  return `<main id="federations-page" class="pf-page pf-votes pf-federations" data-api="${API}" data-base="${escapeHtml(props.basePath)}">
      <p class="pf-eyebrow">Fabric</p>
      <h1>Federations</h1>
      <p class="pf-intro">The signing groups behind <a href="${escapeHtml(props.votesPath)}">alliance votes</a>: the alliance of member orgs, and each org that decides by its officers.</p>
      <div id="federations-list"><p class="pf-intro">Loading…</p></div>
    </main>`;
}

/**
 * One page for every federation; the page script fills it.
 * @param {Object} props Same as {@link renderIndexHtml}, plus `siteTitle`.
 * @returns {string}
 */
function renderFederationHtml (props) {
  return `<main id="federation-page" class="pf-page pf-votes pf-federations" data-api="${API}" data-base="${escapeHtml(props.basePath)}" data-votes="${escapeHtml(props.votesPath)}" data-site-title="${escapeHtml(props.siteTitle || '')}">
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; All federations</a></p>
      <div id="federation-view"><p class="pf-intro">Loading…</p></div>
    </main>`;
}

function renderScript () {
  return `<script src="${PAGE_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'federations-page',
  API,
  styles: renderStyles,
  render: renderIndexHtml,
  renderFederation: renderFederationHtml,
  script: renderScript
};
