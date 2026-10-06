'use strict';

const escapeHtml = require('../functions/escapeHtml');

function renderEventsCss () {
  return `
      .events-page { display: none; margin: 0 auto; max-width: 40em; padding: 0 1em 3em; text-align: left; }
      .events-page > h1, .events-page > .events-intro, .events-page > .events-meta { text-align: center; }
      .events-intro { color: #bbb; font-size: 0.92em; line-height: 1.45; margin: 0 auto 1.25em; max-width: 30em; }
      .events-meta { color: #888; font-size: 0.8em; min-height: 1.2em; }
      .events-filters { display: flex; flex-wrap: wrap; gap: 0.5em; justify-content: center; margin: 1em 0 1.5em; }
      .events-filters .goon-button { font-size: 0.75em; padding: 0.35em 0.75em; }
      .events-filters .goon-button[aria-pressed="true"] { background: #fff; color: #333; }
      .events-day { font-size: 1rem; letter-spacing: 0.06em; margin: 1.75em 0 0.75em; }
      .events-list { display: flex; flex-direction: column; gap: 1rem; }
      .event-card {
        background: rgba(0, 0, 0, 0.22);
        border: 1px solid #555;
        border-radius: 10px;
        display: flex;
        gap: 1rem;
        padding: 1rem 1.15rem;
      }
      .event-card.event-live { border-color: #fff; }
      .event-time { color: #fff; flex: 0 0 5.5em; font-family: "Bungee", sans-serif; font-size: 0.85rem; line-height: 1.3; }
      .event-live-badge { border: 1px solid #fff; border-radius: 4px; font-size: 0.7rem; margin-top: 0.35em; padding: 0 0.35em; width: fit-content; }
      .event-body { flex: 1; min-width: 0; }
      .event-name { font-size: 1.05rem; margin: 0 0 0.35rem; overflow-wrap: anywhere; }
      .event-name a { border-bottom: 1px solid rgba(255, 255, 255, 0.25); text-decoration: none; }
      .event-name a:hover { border-bottom-color: #fff; }
      .event-server { align-items: center; color: #c9c9c9; display: flex; font-size: 0.85rem; gap: 0.4em; }
      .event-server img { border-radius: 50%; height: 18px; width: 18px; }
      .event-details { color: #999; font-size: 0.8rem; margin-top: 0.35rem; }
      .event-description {
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 3;
        color: #aaa;
        display: -webkit-box;
        font-size: 0.82rem;
        line-height: 1.35;
        margin-top: 0.5rem;
        overflow: hidden;
        overflow-wrap: anywhere;
        white-space: pre-line;
      }
      .events-empty { color: #888; padding: 2em 0; text-align: center; }`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderEventsHtml (props) {
  return `<main id="events-page" class="events-page">
      <h1>${props.heading}</h1>
      <p class="events-intro">${props.intro}</p>
      <p id="events-meta" class="events-meta">Loading events…</p>
      <div id="events-filters" class="events-filters"></div>
      <div id="events-feed"></div>
      <footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

/**
 * Client: loads `/services/events`, groups upcoming events by the viewer's
 * local day, and filters by server.
 * @param {Object} props
 * @param {string} props.path SPA path for this page.
 */
function renderEventsScript (props) {
  return `<script type="text/javascript">
      (function () {
        var pagePath = ${JSON.stringify(props.path)};
        var path = (window.location.pathname || '/').replace(/\\/+$/, '') || '/';
        if (path.toLowerCase() !== pagePath.toLowerCase()) return;

        var meta = document.getElementById('events-meta');
        var filters = document.getElementById('events-filters');
        var feed = document.getElementById('events-feed');
        var data = { events: [], guilds: [] };
        var selected = new URLSearchParams(window.location.search).get('server') || 'all';

        function el (tag, className, text) {
          var node = document.createElement(tag);
          if (className) node.className = className;
          if (text != null) node.textContent = text;
          return node;
        }

        function dayKey (date) {
          return date.getFullYear() + '-' + (date.getMonth() + 1) + '-' + date.getDate();
        }

        function dayLabel (date) {
          var today = new Date();
          var tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
          if (dayKey(date) === dayKey(today)) return 'Today';
          if (dayKey(date) === dayKey(tomorrow)) return 'Tomorrow';
          return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
        }

        function ago (iso) {
          var mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
          if (!Number.isFinite(mins)) return 'unknown';
          if (mins < 1) return 'just now';
          if (mins < 60) return mins + ' min ago';
          var hours = Math.round(mins / 60);
          return hours < 48 ? hours + ' h ago' : Math.round(hours / 24) + ' days ago';
        }

        function renderCard (event) {
          var start = new Date(event.start);
          var live = event.status === 'active';
          var card = el('article', 'event-card' + (live ? ' event-live' : ''));
          var time = el('div', 'event-time', live ? 'NOW' : start.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
          if (live) time.appendChild(el('div', 'event-live-badge', 'LIVE'));
          card.appendChild(time);

          var body = el('div', 'event-body');
          var name = el('h3', 'event-name');
          var link = el('a', null, event.name);
          link.href = event.url;
          link.target = '_blank';
          link.rel = 'noopener';
          name.appendChild(link);
          body.appendChild(name);

          var server = el('div', 'event-server');
          if (event.guildIconUrl) {
            var icon = el('img');
            icon.src = event.guildIconUrl;
            icon.alt = '';
            server.appendChild(icon);
          }
          server.appendChild(el('span', null, event.guildName));
          body.appendChild(server);

          var details = [];
          // Discord recurrence weekdays are UTC; name the viewer's local day instead.
          if (event.cadence && /^weekly\\b/.test(event.cadence)) {
            details.push('every ' + start.toLocaleDateString(undefined, { weekday: 'long' }));
          } else if (event.cadence && event.cadence !== 'one-off or unknown') {
            details.push(event.cadence);
          }
          if (event.location) details.push(event.location);
          else if (event.type) details.push(event.type === 'external' ? 'external' : event.type + ' channel');
          if (event.interested) details.push(event.interested + ' interested');
          if (details.length) body.appendChild(el('div', 'event-details', details.join(' · ')));
          if (event.description) body.appendChild(el('div', 'event-description', event.description.replace(/\\n\\s*\\n+/g, '\\n').trim()));
          card.appendChild(body);
          return card;
        }

        function renderFilters () {
          filters.textContent = '';
          var options = [{ id: 'all', name: 'All servers' }].concat(data.guilds.filter(function (g) { return g.count > 0; }));
          if (options.length <= 2) return;
          options.forEach(function (option) {
            var button = el('button', 'goon-button', option.name);
            button.type = 'button';
            button.setAttribute('aria-pressed', String(option.id === selected));
            button.addEventListener('click', function () {
              selected = option.id;
              var url = option.id === 'all' ? pagePath : pagePath + '?server=' + encodeURIComponent(option.id);
              window.history.replaceState(null, '', url);
              renderFilters();
              renderFeed();
            });
            filters.appendChild(button);
          });
        }

        function renderFeed () {
          feed.textContent = '';
          var events = data.events.filter(function (e) { return selected === 'all' || e.guildId === selected; });
          if (!events.length) {
            feed.appendChild(el('p', 'events-empty', 'No upcoming events.'));
            return;
          }
          var currentKey = null;
          var list = null;
          events.forEach(function (event) {
            var start = new Date(event.start);
            var key = event.status === 'active' ? 'live' : dayKey(start);
            if (key !== currentKey) {
              currentKey = key;
              feed.appendChild(el('h2', 'events-day', key === 'live' ? 'Happening now' : dayLabel(start)));
              list = el('div', 'events-list');
              feed.appendChild(list);
            }
            list.appendChild(renderCard(event));
          });
        }

        window.fetch('/services/events', { headers: { Accept: 'application/json' }, cache: 'no-store' })
          .then(function (res) { return res.json(); })
          .then(function (j) {
            data = { events: Array.isArray(j.events) ? j.events : [], guilds: Array.isArray(j.guilds) ? j.guilds : [] };
            if (!data.guilds.some(function (g) { return g.id === selected; })) selected = 'all';
            var servers = data.guilds.length;
            var parts = [data.events.length + ' event' + (data.events.length === 1 ? '' : 's') + ' across ' + servers + ' server' + (servers === 1 ? '' : 's')];
            if (j.fetchedAt) parts.push('updated ' + ago(j.fetchedAt));
            if (j.stale) parts.push('Discord is unreachable; showing the last saved copy');
            meta.textContent = j.fetchedAt || data.events.length ? parts.join(' · ') : 'Events are unavailable right now.';
            renderFilters();
            renderFeed();
          })
          .catch(function () {
            meta.textContent = 'Events are unavailable right now.';
          });
      })();
    </script>`;
}

module.exports = {
  id: 'events-page',
  styles: renderEventsCss,
  render: renderEventsHtml,
  script: renderEventsScript
};
