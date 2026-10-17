'use strict';

const escapeHtml = require('../functions/escapeHtml');
const elo = require('../functions/elo');

const API = '/services/leagues';
const PAGE_SCRIPT = '/scripts/leagues.js';

function renderLeaguesCss () {
  return `
      .league-page { display: none; margin: 0 auto; max-width: 46em; padding: 0 1em 3em; text-align: left; }
      .league-page > h1, .league-page > .operations-intro, .league-view > h1, .league-view > .league-tagline { text-align: center; }
      .league-meta { color: #bbb; font-size: 0.9em; letter-spacing: 0.04em; margin: 0.25em 0 0; text-align: center; }
      .league-seasons { display: flex; flex-wrap: wrap; gap: 0.4em; justify-content: center; margin: 1.25em 0 0; padding: 0; list-style: none; }
      .league-seasons a { border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 999px; color: #ddd; display: inline-block; font-size: 0.85em; padding: 0.2em 0.8em; text-decoration: none; }
      .league-seasons a[aria-current="page"] { background: #fff; border-color: #fff; color: #111; font-weight: 700; }
      .league-standings td.num, .league-standings th.num { text-align: right; white-space: nowrap; }
      .league-standings .rating { color: #fff; font-weight: 700; }
      .league-duels li { align-items: baseline; display: flex; flex-wrap: wrap; gap: 0.25em 0.75em; margin: 0.35em 0; }
      .league-duels li.void .league-duel-text { color: #888; text-decoration: line-through; }
      .league-delta { color: #bbb; font-size: 0.9em; white-space: nowrap; }
      .league-duels button { background: none; border: 0; color: #aaa; cursor: pointer; font: inherit; font-size: 0.85em; padding: 0; text-decoration: underline; }
      .league-duels button:hover { color: #fff; }
      .league-page details > summary { cursor: pointer; font-weight: 600; }
      .league-page details[open] > summary { margin-bottom: 0.85em; }
      .league-page [hidden] { display: none !important; }`;
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

function bestOfOptions (selected) {
  return [1, 3, 5, 7, 9].map((n) => `<option value="${n}"${n === selected ? ' selected' : ''}>Best of ${n}</option>`).join('');
}

/**
 * How ratings move, in plain words; the league page fills in its own numbers.
 * @returns {string}
 */
function renderRatingsHelp () {
  return `<section class="tournament-section league-help">
        <h2>How ratings work</h2>
        <p>Everyone starts at <span data-league-initial>${elo.DEFAULT_RATING}</span>. Each duel moves rating from the loser to the winner: a little for an expected win, a lot for an upset.</p>
        <p>Longer sets count for more. A duel is worth K × √(best of) at most, with K = <span data-league-k>${elo.DEFAULT_K}</span>, so a best of 3 moves ratings about 1.7× as much as a best of 1, and a best of 5 about 2.2×. The set score goes on record but doesn’t change the rating.</p>
        <p>In a <strong>perpetual</strong> league the ladder never resets. In a <strong>seasonal</strong> league everyone starts again each season, and a finished season’s standings stay on record.</p>
      </section>`;
}

/**
 * Leagues index: every league and the league creator; the page script fills
 * the list from the leagues service.
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
  return `<main id="leagues-page" class="league-page" data-api="${API}" data-base="${escapeHtml(props.basePath)}">
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <section class="tournament-section">
        <h2>Leagues</h2>
        <div id="league-list"><p class="tournament-muted">Loading leagues…</p></div>
      </section>
      <section class="tournament-section">
        <h2>New league</h2>
        <form class="tournament-form" id="league-create-form">
          <label>Name <input name="name" maxlength="48" required placeholder="Gladius Ladder"></label>
          <label>Tagline <input name="tagline" maxlength="120"></label>
          <label>Summary <textarea name="summary" maxlength="600"></textarea></label>
          <div class="tournament-row">
            <label>Kind <select name="kind">
              <option value="perpetual">Perpetual: one ladder, forever</option>
              <option value="seasonal">Seasonal: ratings restart each season</option>
            </select></label>
            <label>Usual set <select name="bestOf">${bestOfOptions(3)}</select></label>
          </div>
          <div class="tournament-row" data-seasonal hidden>
            <label>First season <input name="seasonName" maxlength="32" placeholder="Season 1"></label>
            <label>Planned end (optional) <input name="seasonEndsAt" type="date"></label>
          </div>
          <label>Pilots <span class="tournament-muted">optional, one per line; anyone who duels joins</span>
            <textarea name="players" spellcheck="false" autocomplete="off"></textarea></label>
          <details>
            <summary>Rating settings</summary>
            <div class="tournament-row">
              <label>K <input name="k" type="number" min="4" max="100" step="1" value="${elo.DEFAULT_K}"></label>
              <label>Starting rating <input name="initialRating" type="number" min="100" max="3000" step="1" value="${elo.DEFAULT_RATING}"></label>
            </div>
          </details>
          <button class="goon-button" type="submit">Create league</button>
          <p class="tournament-form-note" role="status"></p>
        </form>
      </section>
      ${renderRatingsHelp()}
      ${renderFooter(props)}
    </main>`;
}

/**
 * One page for every league under the index; the page script fills it from
 * the leagues service.
 * @param {Object} props Same as {@link renderIndexHtml}, plus `siteTitle`.
 * @returns {string}
 */
function renderLeagueHtml (props) {
  return `<main id="league-page" class="league-page" data-api="${API}" data-base="${escapeHtml(props.basePath)}" data-site-title="${escapeHtml(props.siteTitle || '')}">
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Leagues</a></p>
      <div class="league-view" id="league-view"><p class="tournament-muted">Loading…</p></div>
      <div id="league-help" hidden>${renderRatingsHelp()}</div>
      <section class="tournament-log" id="league-log" hidden></section>
      ${renderFooter(props)}
    </main>`;
}

function renderLeaguesScript () {
  return `<script src="${PAGE_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'leagues-page',
  API,
  styles: renderLeaguesCss,
  render: renderIndexHtml,
  renderLeague: renderLeagueHtml,
  script: renderLeaguesScript
};
