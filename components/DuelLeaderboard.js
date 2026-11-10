'use strict';

/**
 * 1v1 leaderboard: a page under /resources and a compact board for squadron
 * pages. Both are filled client-side from `GET /services/leaderboards/1v1`
 * (display names only), synced from the pinned message in #1v1-challenges.
 */

const escapeHtml = require('../functions/escapeHtml');

function renderStyles () {
  return `
      .leaderboard-page { display: none; margin: 0 auto; max-width: 34em; padding: 0 1em 3em; text-align: left; }
      .leaderboard-page > h1, .leaderboard-page > .leaderboard-intro { text-align: center; }
      .leaderboard-intro { color: #bbb; line-height: 1.45; margin: 0 auto 1.5em; max-width: 30em; }
      .leaderboard-section { background: rgba(0, 0, 0, 0.22); border: 1px solid #555; border-radius: 10px; margin: 0 0 1.25rem; padding: 1rem 1.15rem; }
      .leaderboard-section h2 { font-size: 1.05rem; letter-spacing: 0.06em; margin: 0 0 0.75rem; text-transform: uppercase; }
      .leaderboard-actions { display: flex; flex-wrap: wrap; gap: 0.6em; justify-content: center; margin: 0 0 1.5rem; }
      .duel-ladder { list-style: none; margin: 0; padding: 0; }
      .duel-ladder li { align-items: baseline; border-bottom: 1px solid rgba(255, 255, 255, 0.1); display: flex; gap: 0.75rem; padding: 0.4rem 0.25rem; }
      .duel-ladder li:last-child { border-bottom: 0; }
      .duel-rank { color: #888; flex: 0 0 2.25rem; font-variant-numeric: tabular-nums; text-align: right; }
      .duel-name { color: #fff; font-weight: 600; overflow-wrap: anywhere; }
      .duel-ladder li.duel-champion { background: linear-gradient(90deg, rgba(255, 196, 0, 0.16), transparent); border-radius: 6px; }
      .duel-ladder li.duel-champion .duel-rank { color: #ffc400; }
      .duel-ladder li.duel-champion .duel-name::after { color: #ffc400; content: 'Champion'; font-size: 0.7rem; font-weight: 700; letter-spacing: 0.14em; margin-left: 0.6rem; text-transform: uppercase; }
      .duel-ladder li.duel-podium .duel-rank { color: #ddd; }
      .duel-meta, .duel-empty { color: #888; font-size: 0.8rem; margin: 0.6rem 0 0; }
      .duel-rules { color: #bbb; line-height: 1.5; margin: 0; padding-left: 1.3em; }
      .pf-page .pf-duels { margin-top: 1.75rem; padding: 1.1rem 1.15rem 1.2rem; background: var(--pf-glass); border: 1px solid var(--pf-line); border-left: 3px solid var(--pf-cyan); }
      .pf-page .pf-duels h2 { margin: 0 0 0.35rem; text-align: left; font-family: "Rajdhani", sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.16em; }
      .pf-duels > p { margin: 0 0 0.75rem; color: var(--pf-muted); line-height: 1.45; }
      .pf-page .pf-duels .duel-ladder li { border-bottom-color: var(--pf-line); }
      .pf-page .pf-duels .duel-meta { color: var(--pf-muted); }`;
}

function renderBoard (limit) {
  return `<div class="duel-board" data-duel-board data-limit="${Number(limit) > 0 ? Number(limit) : 0}">
          <ol class="duel-ladder" aria-label="1v1 ladder" hidden></ol>
          <p class="duel-empty">Loading the ladder…</p>
          <p class="duel-meta" hidden></p>
        </div>`;
}

/**
 * @param {Object} props
 * @param {string} props.path This page's path.
 * @param {string} props.resourcesPath
 * @param {string} props.channelUrl #1v1-challenges on Discord.
 * @param {string} props.joinUrl Discord server invite.
 * @param {string} props.tournamentsPath
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} [props.alliance] Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 * @returns {string}
 */
function renderPageHtml (props) {
  return `<main id="leaderboard-page" class="leaderboard-page">
      <p class="page-back"><a href="${escapeHtml(props.resourcesPath)}">&larr; Resources</a></p>
      <h1>1V1 LEADERBOARD</h1>
      <p class="leaderboard-intro">The Squad’s standing dogfight ladder. Anyone can challenge anyone in <strong>#1v1-challenges</strong>, including pilots from other orgs.</p>
      <div class="leaderboard-actions">
        <a class="goon-button" href="${escapeHtml(props.channelUrl)}" target="_blank" rel="noopener">Challenge someone &raquo;</a>
        <a class="goon-button" href="${escapeHtml(props.joinUrl)}" target="_blank" rel="noopener">Join the Discord</a>
      </div>
      <section class="leaderboard-section" aria-labelledby="leaderboard-ladder-heading">
        <h2 id="leaderboard-ladder-heading">Ladder</h2>
        ${renderBoard(0)}
      </section>
      <section class="leaderboard-section" aria-labelledby="leaderboard-rules-heading" data-duel-rules-section hidden>
        <h2 id="leaderboard-rules-heading">Rules</h2>
        <ol class="duel-rules" data-duel-rules></ol>
      </section>
      <p class="duel-meta">Synced from the pinned message in #1v1-challenges. Looking for a bracket instead? See <a href="${escapeHtml(props.tournamentsPath)}">Tournaments</a>.</p>
      <footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

/**
 * Top of the ladder for a squadron page.
 * @param {Object} props
 * @param {string} props.path Full leaderboard page.
 * @param {string} props.channelUrl
 * @param {string} props.id Unique per page (e.g. the squadron id).
 * @param {number} [props.limit=10]
 * @returns {string}
 */
function renderEmbedHtml (props) {
  const heading = `${escapeHtml(props.id)}-duels-heading`;
  return `<section class="pf-duels" aria-labelledby="${heading}">
        <h2 id="${heading}">1v1 leaderboard</h2>
        <p>The Squad’s standing dogfight ladder. Challenge anyone in #1v1-challenges to climb it.</p>
        ${renderBoard(props.limit || 10)}
        <p class="pf-links"><a href="${escapeHtml(props.path)}">Full leaderboard &raquo;</a> · <a href="${escapeHtml(props.channelUrl)}" target="_blank" rel="noopener noreferrer">Challenge someone &raquo;</a></p>
      </section>`;
}

/**
 * Fills every `[data-duel-board]` (and the rules list) the first time one
 * comes on screen, then every few minutes while one is visible.
 * @param {{ endpoint?: string, refreshMs?: number }} [opts]
 * @returns {string}
 */
function renderScript (opts = {}) {
  const endpoint = JSON.stringify(opts.endpoint || '/services/leaderboards/1v1');
  const refreshMs = Number(opts.refreshMs) > 0 ? Number(opts.refreshMs) : 5 * 60 * 1000;
  return `<script>
    (function () {
      var boards = Array.prototype.slice.call(document.querySelectorAll('[data-duel-board]'));
      if (!boards.length) return;
      var visible = [];
      var timer = null;

      function el (tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      }

      function when (iso) {
        var t = Date.parse(iso || '');
        if (!isFinite(t)) return '';
        return new Date(t).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
      }

      function renderBoard (board, data) {
        var list = board.querySelector('.duel-ladder');
        var empty = board.querySelector('.duel-empty');
        var meta = board.querySelector('.duel-meta');
        var limit = Number(board.getAttribute('data-limit')) || 0;
        var ladder = (data && data.ladder) || [];
        var rows = limit ? ladder.slice(0, limit) : ladder;
        list.textContent = '';
        rows.forEach(function (row) {
          var li = el('li', row.rank === 1 ? 'duel-champion' : (row.rank <= 3 ? 'duel-podium' : ''));
          li.appendChild(el('span', 'duel-rank', String(row.rank)));
          li.appendChild(el('span', 'duel-name', row.name));
          list.appendChild(li);
        });
        list.hidden = !rows.length;
        empty.hidden = !!rows.length;
        if (!rows.length) empty.textContent = 'The ladder is unavailable right now.';
        var parts = [];
        if (limit && ladder.length > rows.length) parts.push('Top ' + rows.length + ' of ' + ladder.length + ' pilots.');
        if (data && data.updatedAt) parts.push('Updated ' + when(data.updatedAt) + '.');
        if (data && data.stale && rows.length) parts.push('Saved copy; Discord is unreachable.');
        meta.textContent = parts.join(' ');
        meta.hidden = !parts.length;
      }

      function renderRules (data) {
        var list = document.querySelector('[data-duel-rules]');
        var section = document.querySelector('[data-duel-rules-section]');
        if (!list || !section) return;
        var rules = (data && data.rules) || [];
        list.textContent = '';
        rules.forEach(function (rule) { list.appendChild(el('li', '', rule)); });
        section.hidden = !rules.length;
      }

      function load () {
        fetch(${endpoint}, { headers: { Accept: 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .catch(function () { return null; })
          .then(function (data) {
            boards.forEach(function (board) { renderBoard(board, data); });
            renderRules(data);
          });
      }

      function schedule () {
        if (timer) clearInterval(timer);
        timer = visible.length ? setInterval(load, ${refreshMs}) : null;
      }

      if (!('IntersectionObserver' in window)) { load(); return; }
      var observer = new IntersectionObserver(function (entries) {
        var wasVisible = visible.length > 0;
        entries.forEach(function (e) {
          var i = visible.indexOf(e.target);
          if (e.isIntersecting && i === -1) visible.push(e.target);
          if (!e.isIntersecting && i !== -1) visible.splice(i, 1);
        });
        if (visible.length && !wasVisible) load();
        schedule();
      });
      boards.forEach(function (board) { observer.observe(board); });
    })();
  </script>`;
}

module.exports = {
  id: 'leaderboard-page',
  styles: renderStyles,
  render: renderPageHtml,
  renderEmbed: renderEmbedHtml,
  script: renderScript
};
