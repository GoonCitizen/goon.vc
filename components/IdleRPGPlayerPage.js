'use strict';

/**
 * One IdleRPG player's page at `/services/idlerpg/players/<id>`. Filled
 * client-side from the same URL as JSON (`Presence#player`): display name,
 * rank, level progress, attributes, gear, battles, and most-slain creatures —
 * never Discord ids or messages. Shares the `idlerpg-*` styles of
 * {@link module:components/IdleRPGPage}.
 */

const escapeHtml = require('../functions/escapeHtml');

/**
 * Path prefix of player pages under the IdleRPG application.
 * @param {string} [idlerpgPath='/services/idlerpg']
 * @returns {string}
 */
function playersPath (idlerpgPath = '/services/idlerpg') {
  return `${String(idlerpgPath).replace(/\/+$/, '')}/players`;
}

function renderPlayerCss () {
  return `
      .idlerpg-player-standing { color: #bbb; font-size: 0.92em; margin: -0.5em 0 1.75em; text-align: center; }
      .idlerpg-player-standing.idlerpg-online::before { background: #3ddc84; border-radius: 50%; content: ''; display: inline-block; height: 0.55em; margin-right: 0.45em; width: 0.55em; }
      .idlerpg-progress { background: rgba(255, 255, 255, 0.08); border-radius: 4px; height: 0.5rem; margin: 1rem 0 0.3rem; overflow: hidden; }
      .idlerpg-progress span { background: #7c3aed; display: block; height: 100%; }
      .idlerpg-progress-label { color: #888; font-size: 0.75rem; }
      .idlerpg-rarity-rare { color: #60a5fa; }
      .idlerpg-rarity-legendary { color: #f59e0b; }
      .idlerpg-table a, .idlerpg-player-page a.idlerpg-name { color: inherit; }`;
}

/**
 * @param {Object} props
 * @param {string} props.idlerpgPath
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} [props.alliance] Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderPlayerHtml (props) {
  return `<main id="idlerpg-player-page" class="idlerpg-page idlerpg-player-page">
      <h1 id="idlerpg-player-name">Pilot</h1>
      <p class="idlerpg-player-standing" id="idlerpg-player-standing"></p>
      <p class="idlerpg-empty" id="idlerpg-player-missing" hidden>No pilot at this address. Find them on the leaderboard.</p>
      <div id="idlerpg-player-body" hidden>
        <section class="idlerpg-section" aria-labelledby="idlerpg-player-progress-heading">
          <h2 id="idlerpg-player-progress-heading">Progress</h2>
          <ul class="idlerpg-stats" id="idlerpg-player-stats"></ul>
          <div class="idlerpg-progress" aria-hidden="true"><span id="idlerpg-player-progress"></span></div>
          <div class="idlerpg-progress-label" id="idlerpg-player-progress-label"></div>
        </section>
        <section class="idlerpg-section" aria-labelledby="idlerpg-player-attributes-heading">
          <h2 id="idlerpg-player-attributes-heading">Attributes</h2>
          <ul class="idlerpg-stats" id="idlerpg-player-attributes"></ul>
        </section>
        <section class="idlerpg-section" aria-labelledby="idlerpg-player-gear-heading">
          <h2 id="idlerpg-player-gear-heading">Equipment</h2>
          <div class="idlerpg-table-wrap">
            <table class="idlerpg-table" id="idlerpg-player-gear" hidden>
              <thead><tr><th>Slot</th><th>Item</th><th class="num">Damage</th><th class="num">Armor</th></tr></thead>
              <tbody></tbody>
            </table>
          </div>
          <p class="idlerpg-empty" id="idlerpg-player-gear-empty">Bare-handed — no gear yet.</p>
          <h3 class="idlerpg-subhead" id="idlerpg-player-bag-heading" hidden>Bag</h3>
          <ul class="idlerpg-levels" id="idlerpg-player-bag" aria-labelledby="idlerpg-player-bag-heading"></ul>
        </section>
        <section class="idlerpg-section" aria-labelledby="idlerpg-player-battles-heading">
          <h2 id="idlerpg-player-battles-heading">Battles</h2>
          <ul class="idlerpg-stats" id="idlerpg-player-battles"></ul>
          <h3 class="idlerpg-subhead" id="idlerpg-player-slain-heading" hidden>Most slain</h3>
          <ul class="idlerpg-levels" id="idlerpg-player-slain" aria-labelledby="idlerpg-player-slain-heading"></ul>
          <p class="idlerpg-empty" id="idlerpg-player-battles-empty">No battles fought yet.</p>
        </section>
        <p class="idlerpg-note" id="idlerpg-player-seen"></p>
      </div>
      <p class="page-back"><a href="${escapeHtml(props.idlerpgPath)}">&larr; IdleRPG</a></p>
      <footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

/**
 * Loads the player named by the URL and refreshes every minute while shown.
 * @param {{ idlerpgPath?: string, titleSuffix?: string, refreshMs?: number }} [opts]
 * @returns {string}
 */
function renderPlayerScript (opts = {}) {
  const prefix = JSON.stringify(`${playersPath(opts.idlerpgPath)}/`.toLowerCase());
  const titleSuffix = JSON.stringify(opts.titleSuffix || ' — IDLERPG — GOON SQUAD');
  const refreshMs = Number(opts.refreshMs) > 0 ? Number(opts.refreshMs) : 60000;
  return `<script>
    (function () {
      var page = document.getElementById('idlerpg-player-page');
      var path = (window.location.pathname || '').replace(/\\/+$/, '');
      if (!page || path.toLowerCase().indexOf(${prefix}) !== 0) return;
      var url = path;

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
      function stat (value, label) {
        var li = el('li', 'idlerpg-stat');
        li.appendChild(el('span', 'idlerpg-stat-value', value));
        li.appendChild(el('span', 'idlerpg-stat-label', label));
        return li;
      }
      function label (key) {
        var text = String(key).replace(/-/g, ' ');
        return text.charAt(0).toUpperCase() + text.slice(1);
      }
      function rarity (item) {
        return item.rarity && item.rarity !== 'common' ? 'idlerpg-rarity-' + item.rarity : '';
      }

      function render (p) {
        document.getElementById('idlerpg-player-name').textContent = p.name;
        document.title = p.name + ${titleSuffix};
        var standing = document.getElementById('idlerpg-player-standing');
        standing.textContent = 'Rank ' + p.rank + ' of ' + p.players + ' \\u00b7 Level ' + p.level + (p.online ? ' \\u00b7 in voice now' : '');
        standing.className = 'idlerpg-player-standing' + (p.online ? ' idlerpg-online' : '');

        var stats = document.getElementById('idlerpg-player-stats');
        stats.textContent = '';
        stats.appendChild(stat(String(p.level), 'level'));
        stats.appendChild(stat(int(p.experience), 'experience'));
        stats.appendChild(stat(int(p.wealth), 'credits'));
        stats.appendChild(stat(int(p.kills), 'kills'));
        stats.appendChild(stat(fmt(p.hours), 'hours present'));
        var span = Math.max(1, p.nextLevelExperience - p.levelExperience);
        var into = Math.max(0, Math.min(span, p.experience - p.levelExperience));
        document.getElementById('idlerpg-player-progress').style.width = Math.round(into / span * 100) + '%';
        document.getElementById('idlerpg-player-progress-label').textContent = int(p.nextLevelExperience - p.experience) + ' XP to level ' + (p.level + 1);

        var attributes = document.getElementById('idlerpg-player-attributes');
        attributes.textContent = '';
        Object.keys(p.attributes || {}).forEach(function (key) { attributes.appendChild(stat(String(p.attributes[key]), key)); });
        attributes.appendChild(stat(int(p.armor), 'armor'));

        var gear = document.getElementById('idlerpg-player-gear');
        var body = gear.querySelector('tbody');
        var equipment = p.equipment || [];
        body.textContent = '';
        equipment.forEach(function (item) {
          var tr = el('tr', '');
          tr.appendChild(el('td', '', label(item.slot)));
          tr.appendChild(el('td', rarity(item), item.name));
          tr.appendChild(el('td', 'num', item.damage ? fmt(item.damage) : '\\u2014'));
          tr.appendChild(el('td', 'num', item.armor ? int(item.armor) : '\\u2014'));
          body.appendChild(tr);
        });
        gear.hidden = !equipment.length;
        document.getElementById('idlerpg-player-gear-empty').hidden = equipment.length > 0;
        var bag = document.getElementById('idlerpg-player-bag');
        var held = p.inventory || [];
        bag.textContent = '';
        held.forEach(function (item) { bag.appendChild(el('li', rarity(item), item.name)); });
        document.getElementById('idlerpg-player-bag-heading').hidden = !held.length;

        var battles = p.battles || { won: 0, lost: 0, total: 0 };
        var list = document.getElementById('idlerpg-player-battles');
        var slain = document.getElementById('idlerpg-player-slain');
        var top = p.slain || [];
        list.textContent = '';
        slain.textContent = '';
        if (battles.total > 0) {
          list.appendChild(stat(int(battles.total), 'battles'));
          list.appendChild(stat(int(battles.won), 'won'));
          list.appendChild(stat(int(battles.lost), 'lost'));
          list.appendChild(stat(Math.round(battles.won / battles.total * 100) + '%', 'win rate'));
        }
        top.forEach(function (c) {
          var li = el('li', '');
          li.appendChild(el('b', '', c.name));
          li.appendChild(document.createTextNode(' \\u00d7 ' + int(c.count)));
          slain.appendChild(li);
        });
        document.getElementById('idlerpg-player-slain-heading').hidden = !top.length;
        document.getElementById('idlerpg-player-battles-empty').hidden = battles.total > 0;

        var seen = [];
        if (p.firstSeen) seen.push('Playing since ' + p.firstSeen + '.');
        if (!p.online && p.lastSeen) seen.push('Last seen ' + p.lastSeen + '.');
        document.getElementById('idlerpg-player-seen').textContent = seen.join(' ');
        document.getElementById('idlerpg-player-body').hidden = false;
        document.getElementById('idlerpg-player-missing').hidden = true;
      }

      function missing () {
        document.getElementById('idlerpg-player-body').hidden = true;
        document.getElementById('idlerpg-player-missing').hidden = false;
      }

      function load () {
        fetch(url, { headers: { Accept: 'application/json' } })
          .then(function (res) {
            if (res.status === 404) { missing(); return null; }
            return res.ok ? res.json() : null;
          })
          .then(function (data) { if (data) render(data); })
          .catch(function () {});
      }

      load();
      setInterval(function () { if (!document.hidden) load(); }, ${refreshMs});
    })();
  </script>`;
}

module.exports = {
  id: 'idlerpg-player-page',
  playersPath,
  styles: renderPlayerCss,
  render: renderPlayerHtml,
  script: renderPlayerScript
};
