'use strict';

/**
 * IdleRPG players & statistics page. Everything on it is filled client-side
 * from `GET /services/idlerpg` (aggregates + 30-day history + level
 * histogram) and `GET /services/idlerpg/players` (display names and game
 * numbers only — never Discord ids or messages).
 */

const escapeHtml = require('../functions/escapeHtml');

function renderIdleRPGCss () {
  return `
      .idlerpg-page { display: none; margin: 0 auto; max-width: 42em; padding: 0 1em 3em; text-align: left; }
      .idlerpg-page > h1, .idlerpg-page > .idlerpg-intro { text-align: center; }
      .idlerpg-intro { color: #bbb; font-size: 0.92em; line-height: 1.45; margin: 0 auto 1.75em; max-width: 30em; }
      .idlerpg-section { background: rgba(0, 0, 0, 0.22); border: 1px solid #555; border-radius: 10px; margin: 0 0 1.25rem; padding: 1rem 1.15rem; }
      .idlerpg-section h2 { font-size: 1.05rem; letter-spacing: 0.06em; margin: 0 0 0.75rem; text-transform: uppercase; }
      .idlerpg-stats { display: flex; flex-wrap: wrap; gap: 0.6rem 1.4rem; margin: 0; padding: 0; list-style: none; }
      .idlerpg-stat { display: flex; flex-direction: column; min-width: 5.5rem; }
      .idlerpg-stat-value { color: #fff; font-size: 1.3rem; font-variant-numeric: tabular-nums; font-weight: 700; }
      .idlerpg-stat-live .idlerpg-stat-value { color: #3ddc84; }
      .idlerpg-stat-label { color: #888; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; }
      .idlerpg-bars { display: flex; align-items: flex-end; gap: 2px; height: 6rem; margin: 0; padding: 0; list-style: none; }
      .idlerpg-bars li { background: #4C1D95; border-radius: 2px 2px 0 0; flex: 1 1 0; min-height: 2px; position: relative; }
      .idlerpg-bars li.idlerpg-bar-today { background: #7c3aed; }
      .idlerpg-bars li:hover { background: #a78bfa; }
      .idlerpg-bars-axis { color: #777; display: flex; font-size: 0.68rem; justify-content: space-between; margin-top: 0.3rem; }
      .idlerpg-levels { display: flex; flex-wrap: wrap; gap: 0.4rem; margin: 0; padding: 0; list-style: none; }
      .idlerpg-levels li { background: rgba(76, 29, 149, 0.35); border: 1px solid #4C1D95; border-radius: 6px; color: #ddd; font-size: 0.8rem; padding: 0.25rem 0.6rem; }
      .idlerpg-levels li b { color: #fff; }
      .idlerpg-table { border-collapse: collapse; font-size: 0.88rem; width: 100%; }
      .idlerpg-table th, .idlerpg-table td { border-bottom: 1px solid #444; padding: 0.4rem 0.5rem; text-align: left; vertical-align: middle; }
      .idlerpg-table th { color: #888; font-size: 0.68rem; font-weight: 400; letter-spacing: 0.08em; text-transform: uppercase; }
      .idlerpg-table td.num, .idlerpg-table th.num { font-variant-numeric: tabular-nums; text-align: right; }
      .idlerpg-table tr.idlerpg-online td.name::before { background: #3ddc84; border-radius: 50%; content: ''; display: inline-block; height: 0.5em; margin-right: 0.45em; width: 0.5em; }
      .idlerpg-table td.rank { color: #888; width: 2.5rem; }
      .idlerpg-empty, .idlerpg-note { color: #888; font-size: 0.82rem; margin: 0.5rem 0 0; }
      .idlerpg-rules { color: #aaa; font-size: 0.88rem; line-height: 1.5; margin: 0; padding-left: 1.2em; }
      .idlerpg-rules li { margin-bottom: 0.35em; }
      .idlerpg-rules b { color: #ddd; }
      .idlerpg-gateway { color: #777; font-size: 0.75rem; margin: 1.5rem 0 0; text-align: center; }`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.operationsPath
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} [props.alliance] Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderIdleRPGHtml (props) {
  return `<main id="idlerpg-page" class="idlerpg-page">
      <h1>${props.heading}</h1>
      <p class="idlerpg-intro">${props.intro}</p>
      <section class="idlerpg-section" aria-labelledby="idlerpg-stats-heading">
        <h2 id="idlerpg-stats-heading">Statistics</h2>
        <ul class="idlerpg-stats" id="idlerpg-stats"></ul>
        <p class="idlerpg-empty" id="idlerpg-stats-empty">No presence recorded yet.</p>
      </section>
      <section class="idlerpg-section" aria-labelledby="idlerpg-history-heading">
        <h2 id="idlerpg-history-heading">Hours idled, last 30 days</h2>
        <ul class="idlerpg-bars" id="idlerpg-history" aria-label="Hours idled per day"></ul>
        <div class="idlerpg-bars-axis"><span id="idlerpg-history-start"></span><span>today</span></div>
      </section>
      <section class="idlerpg-section" aria-labelledby="idlerpg-levels-heading">
        <h2 id="idlerpg-levels-heading">Levels</h2>
        <ul class="idlerpg-levels" id="idlerpg-levels"></ul>
        <p class="idlerpg-empty" id="idlerpg-levels-empty">Nobody has leveled yet.</p>
      </section>
      <section class="idlerpg-section" aria-labelledby="idlerpg-players-heading">
        <h2 id="idlerpg-players-heading">Players</h2>
        <table class="idlerpg-table" id="idlerpg-players" hidden>
          <thead><tr><th class="rank">#</th><th>Pilot</th><th class="num">Level</th><th class="num">XP</th><th class="num">Credits</th><th class="num">Hours</th><th>Last seen</th></tr></thead>
          <tbody></tbody>
        </table>
        <p class="idlerpg-empty" id="idlerpg-players-empty">No players yet — join an alliance voice channel.</p>
        <p class="idlerpg-note">Display names as shown on Discord. A green dot means the pilot is in voice right now.</p>
      </section>
      <section class="idlerpg-section" aria-labelledby="idlerpg-rules-heading">
        <h2 id="idlerpg-rules-heading">How it works</h2>
        <ol class="idlerpg-rules">
          <li><b>Be present.</b> Every pilot in an alliance voice channel the bot can see is a player. Each tick you stay earns experience and credits.</li>
          <li><b>Level up.</b> Levels cost more experience as you climb; the leaderboard ranks by experience, then hours.</li>
          <li><b>Keep the peace.</b> Chatting in the game channel halves your credits and starts a cooldown — idling is the game.</li>
          <li><b>Encounters.</b> Occasionally the ’verse rolls an encounter for someone present; outcomes are announced in Discord.</li>
        </ol>
      </section>
      <p class="idlerpg-gateway" id="idlerpg-gateway" hidden></p>
      <p class="page-back"><a href="${escapeHtml(props.operationsPath)}">&larr; Operations</a></p>
      <footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

/**
 * Fills the page from /services/idlerpg and /services/idlerpg/players
 * while it is on screen (polls every minute).
 * @param {{ endpoint?: string, playersEndpoint?: string, refreshMs?: number, limit?: number }} [opts]
 * @returns {string}
 */
function renderIdleRPGScript (opts = {}) {
  const endpoint = JSON.stringify(opts.endpoint || '/services/idlerpg');
  const playersEndpoint = JSON.stringify(opts.playersEndpoint || '/services/idlerpg/players');
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 100;
  const refreshMs = Number(opts.refreshMs) > 0 ? Number(opts.refreshMs) : 60000;
  return `<script>
    (function () {
      var page = document.getElementById('idlerpg-page');
      if (!page) return;
      var timer = null;
      var visible = false;

      function fmt (n) {
        if (!(n > 0)) return '0';
        if (n >= 100) return String(Math.round(n));
        return String(Math.round(n * 10) / 10);
      }
      function int (n) { return String(Math.round(Number(n) || 0)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }
      function el (tag, cls, text) {
        var node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text != null) node.textContent = text;
        return node;
      }
      function stat (value, label, cls) {
        var li = el('li', 'idlerpg-stat' + (cls ? ' ' + cls : ''));
        li.appendChild(el('span', 'idlerpg-stat-value', value));
        li.appendChild(el('span', 'idlerpg-stat-label', label));
        return li;
      }

      function renderStats (data) {
        var list = document.getElementById('idlerpg-stats');
        var empty = document.getElementById('idlerpg-stats-empty');
        list.textContent = '';
        var items = [];
        items.push(stat(String(data.presentNow || 0), 'playing now', data.presentNow > 0 ? 'idlerpg-stat-live' : ''));
        items.push(stat(String(data.uniquePlayers || 0), 'players'));
        items.push(stat(fmt(data.totalPresentHours), 'hours idled'));
        if (data.last7Days) {
          items.push(stat(fmt(data.last7Days.hours), 'hours, 7 days'));
          items.push(stat(String(data.last7Days.players), 'pilots, 7 days'));
          items.push(stat(String(data.last7Days.peak), 'peak, 7 days'));
        }
        if (data.last30Days) items.push(stat(fmt(data.last30Days.hours), 'hours, 30 days'));
        if (data.tickMs > 0) items.push(stat(fmt(data.tickMs / 60000) + ' min', 'per tick'));
        items.forEach(function (item) { list.appendChild(item); });
        var any = data.uniquePlayers > 0 || data.totalPresentHours > 0;
        if (empty) empty.hidden = any;
      }

      function renderHistory (data) {
        var bars = document.getElementById('idlerpg-history');
        var start = document.getElementById('idlerpg-history-start');
        var history = data.history || [];
        bars.textContent = '';
        var max = history.reduce(function (m, d) { return Math.max(m, d.hours || 0); }, 0);
        history.forEach(function (d, i) {
          var li = el('li', i === history.length - 1 ? 'idlerpg-bar-today' : '');
          li.style.height = (max > 0 ? Math.max(2, Math.round((d.hours || 0) / max * 100)) : 2) + '%';
          li.title = d.day + ': ' + fmt(d.hours) + ' h, ' + d.players + ' pilots, peak ' + d.peak;
          bars.appendChild(li);
        });
        if (start && history.length) start.textContent = history[0].day;
      }

      function renderLevels (data) {
        var list = document.getElementById('idlerpg-levels');
        var empty = document.getElementById('idlerpg-levels-empty');
        var levels = data.levels || {};
        list.textContent = '';
        var keys = Object.keys(levels).map(Number).sort(function (a, b) { return b - a; });
        keys.forEach(function (level) {
          var li = el('li', '');
          li.appendChild(el('b', '', 'Level ' + level));
          li.appendChild(document.createTextNode(' \\u00d7 ' + levels[level]));
          list.appendChild(li);
        });
        if (empty) empty.hidden = keys.length > 0;
      }

      function renderGateway (data) {
        var note = document.getElementById('idlerpg-gateway');
        if (!note) return;
        var g = data.gateway || {};
        var text = '';
        if (g.status === 'attached' && g.discord && g.discord !== 'connected') text = 'Discord gateway ' + g.discord + ' \\u2014 showing saved statistics.';
        else if (g.status === 'waiting') text = 'Waiting for the Discord gateway \\u2014 showing saved statistics.';
        else if (g.status === 'disabled') text = 'Live tracking is off \\u2014 showing saved statistics.';
        note.textContent = text;
        note.hidden = !text;
      }

      function renderPlayers (data) {
        var table = document.getElementById('idlerpg-players');
        var empty = document.getElementById('idlerpg-players-empty');
        var body = table.querySelector('tbody');
        var rows = (data && data.players) || [];
        body.textContent = '';
        rows.forEach(function (p) {
          var tr = el('tr', p.online ? 'idlerpg-online' : '');
          tr.appendChild(el('td', 'rank', String(p.rank)));
          tr.appendChild(el('td', 'name', p.name));
          tr.appendChild(el('td', 'num', String(p.level)));
          tr.appendChild(el('td', 'num', int(p.experience)));
          tr.appendChild(el('td', 'num', int(p.wealth)));
          tr.appendChild(el('td', 'num', fmt(p.hours)));
          tr.appendChild(el('td', '', p.online ? 'now' : (p.lastSeen || '\\u2014')));
          body.appendChild(tr);
        });
        table.hidden = !rows.length;
        if (empty) empty.hidden = rows.length > 0;
      }

      function load () {
        fetch(${endpoint}, { headers: { Accept: 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) {
            if (!data) return;
            renderStats(data); renderHistory(data); renderLevels(data); renderGateway(data);
          })
          .catch(function () {});
        fetch(${playersEndpoint} + '?limit=${limit}', { headers: { Accept: 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(renderPlayers)
          .catch(function () {});
      }

      function schedule () {
        if (timer) clearInterval(timer);
        timer = visible ? setInterval(load, ${refreshMs}) : null;
      }

      if (!('IntersectionObserver' in window)) { load(); return; }
      new IntersectionObserver(function (entries) {
        var now = entries.some(function (e) { return e.isIntersecting; });
        if (now && !visible) load();
        visible = now;
        schedule();
      }).observe(page);
    })();
  </script>`;
}

module.exports = {
  id: 'idlerpg-page',
  styles: renderIdleRPGCss,
  render: renderIdleRPGHtml,
  script: renderIdleRPGScript
};
