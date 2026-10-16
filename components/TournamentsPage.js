'use strict';

const escapeHtml = require('../functions/escapeHtml');

const API = '/services/tournaments';
const BRACKET_SCRIPT = '/scripts/tournament-bracket.js';
const PAGE_SCRIPT = '/scripts/tournaments.js';

function renderTournamentsCss () {
  return `
      .tournaments-page { display: none; margin: 0 auto; max-width: 42em; padding: 0 1em 3em; text-align: left; }
      .tournaments-page > h1, .tournaments-page > .operations-intro { text-align: center; }
      .tournament-section { margin-top: 2.5em; }
      .tournament-section h2 { font-size: 1.1em; letter-spacing: 0.06em; margin: 0 0 0.75em; }
      .tournament-results { border-collapse: collapse; width: 100%; }
      .tournament-results th, .tournament-results td { border-bottom: 1px solid rgba(255, 255, 255, 0.15); padding: 0.45em 0.5em; text-align: left; vertical-align: top; }
      .tournament-results th { color: #bbb; font-size: 0.8em; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .tournament-results .champion { color: #fff; font-weight: 700; }
      .tournament-muted { color: #aaa; }
      .tournament-form { display: grid; gap: 0.85em; }
      .tournament-form label { display: grid; gap: 0.3em; font-weight: 600; color: #fff; }
      .tournament-form .tournament-row { display: flex; flex-wrap: wrap; gap: 0.85em; }
      .tournament-form .tournament-row label { flex: 1 1 10em; }
      .tournament-form input, .tournament-form select, .tournament-form textarea {
        background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 4px;
        color: #fff; font: inherit; font-weight: 500; padding: 0.5em 0.6em; width: 100%; box-sizing: border-box;
      }
      .tournament-form textarea { min-height: 7em; resize: vertical; }
      .tournament-form .goon-button { justify-self: start; }
      .tournament-form-note { margin: 0; min-height: 1.2em; }
      .tournament-form-note.error { color: #ff7b7b; }
      .tournament-page { display: none; margin: 0 auto; max-width: 1180px; padding: 0 0 3em; }
      .tournament-view { margin: 0 auto; max-width: 42em; padding: 0 1em; text-align: left; }
      .tournament-view.wide { max-width: none; padding: 0; }
      .tournament-view > h1 { text-align: center; }
      .tournament-log { margin: 2em auto 0; max-width: 42em; padding: 0 1em; text-align: left; }
      .tournament-log ol { margin: 0; padding-left: 1.4em; }
      .tournament-log li { margin: 0.2em 0; }
      .tournament-log time { color: #aaa; font-size: 0.9em; margin-right: 0.5em; }`;
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

/**
 * Tournaments index: every tournament on record and the tournament creator;
 * the page script fills the list from the tournaments service.
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.basePath
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 * @returns {string}
 */
function renderIndexHtml (props) {
  return `<main id="tournaments-page" class="tournaments-page" data-api="${API}" data-base="${escapeHtml(props.basePath)}">
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <section class="tournament-section">
        <h2>Results</h2>
        <div id="tournament-history"><p class="tournament-muted">Loading results…</p></div>
      </section>
      <section class="tournament-section">
        <h2>New tournament</h2>
        <p class="tournament-muted">Pick a name, format, and start time. The bracket and every result are kept on record.</p>
        <form class="tournament-form" id="tournament-create-form">
          <label>Name <input name="name" maxlength="48" required placeholder="Gladius Cup"></label>
          <label>Tagline <input name="tagline" maxlength="120"></label>
          <label>Summary <textarea name="summary" maxlength="600"></textarea></label>
          <div class="tournament-row">
            <label>Format <select name="format">
              <option value="single-elimination">Single elimination</option>
              <option value="double-elimination">Double elimination</option>
            </select></label>
            <label>Sets <select name="bestOf">
              <option value="1">Best of 1</option>
              <option value="3" selected>Best of 3</option>
              <option value="5">Best of 5</option>
              <option value="7">Best of 7</option>
              <option value="9">Best of 9</option>
            </select></label>
          </div>
          <label>Date and time (your time) <input name="startsAt" type="datetime-local" required></label>
          <label>Players <span class="tournament-muted">best seed first, one per line; optional — add players until the first game, and latecomers after</span>
            <textarea name="players" spellcheck="false" autocomplete="off"></textarea></label>
          <button class="goon-button" type="submit">Create tournament</button>
          <p class="tournament-form-note" role="status"></p>
        </form>
      </section>
      ${renderFooter(props)}
    </main>`;
}

/**
 * One page for every series and tournament record under the index; the
 * page script fills it from the tournaments service.
 * @param {Object} props Same as {@link renderIndexHtml}, plus `siteTitle`.
 * @returns {string}
 */
function renderTournamentPageHtml (props) {
  return `<main id="tournament-page" class="tournament-page" data-api="${API}" data-base="${escapeHtml(props.basePath)}" data-site-title="${escapeHtml(props.siteTitle || '')}">
      <p class="page-back"><a id="tournament-back" href="${escapeHtml(props.basePath)}">&larr; Tournaments</a></p>
      <div class="tournament-view" id="tournament-view"><p class="tournament-muted">Loading…</p></div>
      <section class="tournament-log" id="tournament-log" hidden></section>
      ${renderFooter(props)}
    </main>`;
}

function renderTournamentsScript () {
  return `<script src="${BRACKET_SCRIPT}" defer></script>
    <script src="${PAGE_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'tournaments-page',
  API,
  styles: renderTournamentsCss,
  render: renderIndexHtml,
  renderTournaments: renderTournamentPageHtml,
  script: renderTournamentsScript
};
