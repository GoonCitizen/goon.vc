'use strict';

const escapeHtml = require('../functions/escapeHtml');

const API = '/services/alliance';
const PAGE_SCRIPT = '/scripts/alliance-votes.js';

function renderStyles () {
  return `
      .pf-votes [hidden] { display: none !important; }
      .pf-votes-orgs { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 0.6rem; margin: 0; padding: 0; list-style: none; }
      .pf-votes-orgs li { display: flex; align-items: center; gap: 0.6rem; padding: 0.55rem 0.7rem; background: var(--pf-glass); border: 1px solid var(--pf-line); }
      .pf-votes-orgs img { width: 2rem; height: 2rem; object-fit: cover; border: 1px solid var(--pf-line); }
      .pf-votes-orgs a { color: var(--pf-text); font-weight: 700; text-decoration: none; }
      .pf-votes-orgs a:hover { color: #fff; }
      .pf-votes-orgs small { display: block; color: var(--pf-muted); font-size: 0.78rem; letter-spacing: 0.08em; }
      .pf-votes-choice { flex-shrink: 0; margin-left: auto; white-space: nowrap; padding: 0.1rem 0.45rem; border: 1px solid var(--pf-line); font-size: 0.75rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: var(--pf-muted); }
      .pf-votes-choice.yes { border-color: rgba(0, 212, 255, 0.7); color: var(--pf-signal); }
      .pf-votes-choice.no { border-color: rgba(255, 59, 59, 0.6); color: #ff8a8a; }
      .pf-votes-list { display: grid; gap: 0.75rem; margin: 0; padding: 0; list-style: none; }
      .pf-votes-list li { padding: 0.9rem 1.1rem; background: var(--pf-glass); border: 1px solid var(--pf-line); border-left: 3px solid var(--pf-accent); }
      .pf-votes-list li.open { border-left-color: var(--pf-cyan); }
      .pf-votes-list li.failed, .pf-votes-list li.expired { opacity: 0.75; }
      .pf-votes-list h3 { margin: 0; font-family: "Rajdhani", sans-serif; font-size: 1.1rem; font-weight: 700; letter-spacing: 0.04em; }
      .pf-votes-list h3 a { color: #fff; text-decoration: none; }
      .pf-votes-list h3 a:hover { color: var(--pf-signal); }
      .pf-votes-meta { margin: 0.25rem 0 0; color: var(--pf-muted); font-size: 0.9rem; }
      .pf-votes-status { display: inline-block; margin-right: 0.5rem; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--pf-signal); }
      .pf-votes-status.passed { color: #7dffb0; }
      .pf-votes-status.failed, .pf-votes-status.expired { color: #ff8a8a; }
      .pf-votes-bar { display: flex; height: 0.4rem; margin-top: 0.6rem; background: rgba(142, 191, 208, 0.12); }
      .pf-votes-bar span { display: block; height: 100%; }
      .pf-votes-bar .yes { background: var(--pf-cyan); }
      .pf-votes-bar .no { background: #ff3b3b; }
      .pf-votes-bar .abstain { background: var(--pf-muted); }
      .pf-votes-panel { margin-top: 1.25rem; padding: 1.1rem 1.15rem 1.2rem; background: var(--pf-glass); border: 1px solid var(--pf-line); border-left: 3px solid var(--pf-cyan); }
      .pf-page .pf-votes-panel h2 { margin: 0 0 0.6rem; text-align: left; font-family: "Rajdhani", sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.16em; }
      .pf-votes-form { display: grid; gap: 0.75rem; max-width: 36rem; }
      .pf-votes-form label { display: grid; gap: 0.3rem; font-weight: 600; }
      .pf-votes-form input, .pf-votes-form textarea, .pf-votes-form select { padding: 0.5rem 0.6rem; background: rgba(5, 10, 24, 0.85); border: 1px solid var(--pf-line); color: var(--pf-text); font: inherit; }
      .pf-votes-form textarea { min-height: 7rem; resize: vertical; }
      .pf-votes-buttons { display: flex; flex-wrap: wrap; gap: 0.5rem; }
      .pf-votes .goon-button[aria-pressed="true"] { border-color: var(--pf-cyan); color: var(--pf-signal); }
      .pf-votes-note { margin: 0.5rem 0 0; color: var(--pf-muted); }
      .pf-votes-note.error { color: #ff8a8a; }
      #pf-votes-status .pf-votes-note { text-align: center; }
      .pf-votes-summary { max-width: 42rem; margin: 1rem auto 0; line-height: 1.5; white-space: pre-wrap; color: var(--pf-text); }
      .pf-votes-proof { margin-top: 2rem; color: var(--pf-muted); font-size: 0.9rem; }
      .pf-votes-proof summary { cursor: pointer; font-weight: 700; color: var(--pf-accent); }
      .pf-votes-proof code, .pf-votes-proof pre { color: var(--pf-text); word-break: break-all; white-space: pre-wrap; }
      .pf-votes-proof pre { max-height: 16rem; overflow: auto; padding: 0.6rem; background: rgba(5, 10, 24, 0.85); border: 1px solid var(--pf-line); }`;
}

function renderHow (props) {
  return `<h2>How alliance votes work</h2>
      <dl class="pf-facts">
        <div><dt>One vote per org</dt><dd>Every member organization holds one vote, and only its officers cast it. Alliance leadership puts each org's officers on record by their Discord accounts. An officer signs in to goon.vc with that account and votes on the proposal page, or runs <code>/vote</code> on Discord; goon.vc signs for them. The org votes once a majority of its officers (or the number the org sets) agree, and its vote carries their signatures. A later vote from an officer replaces their earlier one while voting is open.</dd></div>
        <div><dt>Officers see each other</dt><dd>An org's officers see how each of them voted on its behalf. Everyone else sees the org's vote and how many officers it takes. An officer's vote also counts as their member vote.</dd></div>
        <div><dt>Majority of the alliance</dt><dd>A proposal passes once a majority of all member orgs vote yes. It fails as soon as it no longer can, or when its voting window closes. An org votes once leadership has its officers on record.</dd></div>
        <div><dt>Signed and public</dt><dd>The alliance is a Fabric Federation: every proposal and every org's vote is a signed message, so anyone can check the count.</dd></div>
        <div><dt>Members have a say</dt><dd>Every member can vote too, on the proposal page or with <code>/vote</code> in any Discord server with our bot. It is advice to the orgs, one vote per member (the latest from any of your linked accounts), signed by goon.vc for your account without naming you.</dd></div>
      </dl>
      <p class="pf-links"><a href="${escapeHtml(props.onboardingPath)}">How orgs name their officers &raquo;</a></p>`;
}

/**
 * Alliance votes index: the member orgs, every proposal, and a proposal
 * form for officers; the page script fills it from the alliance service.
 * @param {Object} props
 * @param {string} props.basePath
 * @param {string} props.loginPath
 * @param {string} props.onboardingPath
 * @returns {string}
 */
function renderIndexHtml (props) {
  return `<main id="pf-votes-page" class="pf-page pf-votes" data-api="${API}" data-base="${escapeHtml(props.basePath)}" data-login="${escapeHtml(props.loginPath)}">
      <p class="pf-eyebrow">Alliance business</p>
      <h1>PERMAFLEET Votes</h1>
      <p class="pf-intro">Decisions for the Protectorate, one vote per member organization.</p>
      <div id="pf-votes-status"><p class="pf-intro">Loading…</p></div>
      <section class="pf-votes-panel" id="pf-votes-officers" hidden></section>
      <h2>Proposals</h2>
      <div id="pf-votes-list"><p class="pf-intro">Loading…</p></div>
      <h2>Member organizations</h2>
      <div id="pf-votes-orgs"></div>
      ${renderHow(props)}
    </main>`;
}

/**
 * One page for every proposal; the page script fills it from the alliance service.
 * @param {Object} props Same as {@link renderIndexHtml}, plus `siteTitle`.
 * @returns {string}
 */
function renderProposalHtml (props) {
  return `<main id="pf-vote-page" class="pf-page pf-votes" data-api="${API}" data-base="${escapeHtml(props.basePath)}" data-login="${escapeHtml(props.loginPath)}" data-site-title="${escapeHtml(props.siteTitle || '')}">
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; All votes</a></p>
      <div id="pf-vote-view"><p class="pf-intro">Loading…</p></div>
    </main>`;
}

function renderScript () {
  return `<script src="${PAGE_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'pf-votes-page',
  API,
  styles: renderStyles,
  render: renderIndexHtml,
  renderProposal: renderProposalHtml,
  script: renderScript
};
