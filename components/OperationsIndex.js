'use strict';

const escapeHtml = require('../functions/escapeHtml');

function renderOperationsCss () {
  return `
      .operations-page { display: none; margin: 0 auto; max-width: 38em; padding: 0 1em 3em; text-align: left; }
      .operations-page > h1, .operations-page > .operations-intro { text-align: center; }
      .operations-intro { color: #bbb; font-size: 0.92em; line-height: 1.45; margin: 0 auto 2em; max-width: 28em; }
      .operations-grid { display: flex; flex-direction: column; gap: 1.25rem; }
      .operation-card {
        background: rgba(0, 0, 0, 0.22);
        border: 1px solid #555;
        border-radius: 10px;
        padding: 1rem 1.15rem;
      }
      .operation-name { font-size: 1.2rem; margin: 0 0 0.35rem; }
      .operation-name a { border-bottom: 1px solid rgba(255, 255, 255, 0.25); text-decoration: none; }
      .operation-name a:hover { border-bottom-color: #fff; }
      .operation-tagline { color: #fff; margin: 0 0 0.5rem; }
      .operation-summary { color: #aaa; font-size: 0.9rem; line-height: 1.4; margin: 0 0 0.75rem; }
      .operation-links { display: flex; flex-wrap: wrap; gap: 0.5em; }
      .operation-links .goon-button { font-size: 0.75em; padding: 0.35em 0.75em; }
      .operation-metrics { display: flex; flex-wrap: wrap; gap: 0.4rem 1.1rem; margin: 0 0 0.85rem; padding: 0; list-style: none; }
      .operation-metrics[hidden] { display: none; }
      .operation-metric { display: flex; flex-direction: column; min-width: 4.5rem; }
      .operation-metric-value { color: #fff; font-size: 1.05rem; font-variant-numeric: tabular-nums; font-weight: 700; }
      .operation-metric-label { color: #888; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; }
      .operation-metric-live .operation-metric-value { color: #3ddc84; }
      .operations-metrics-note { color: #777; font-size: 0.75rem; margin: 1.5rem 0 0; text-align: center; }
      .operations-empty { color: #888; padding: 2em 0; text-align: center; }`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {Array<{ id?: string, name: string, path: string, tagline?: string, summary?: string, links?: Array<{ label: string, href: string }>, metrics?: boolean }>} props.operations Plain text. `metrics` reserves a strip filled from /services/operations by `id`.
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderOperationsHtml (props) {
  const cards = props.operations.map((op) => {
    const links = [{ label: 'Briefing', href: op.path }].concat(op.links || [])
      .map((link) => {
        const external = /^https?:/i.test(link.href);
        return `<a class="goon-button" href="${escapeHtml(link.href)}"${external ? ' target="_blank" rel="noopener"' : ''}>${escapeHtml(link.label)}</a>`;
      })
      .join('');
    const metrics = op.metrics && op.id
      ? `<ul class="operation-metrics" data-operation="${escapeHtml(op.id)}" aria-label="${escapeHtml(op.name)} activity" hidden></ul>`
      : '';
    return `<article class="operation-card">
          <h2 class="operation-name"><a href="${escapeHtml(op.path)}">${escapeHtml(op.name)}</a></h2>
          ${op.tagline ? `<p class="operation-tagline">${escapeHtml(op.tagline)}</p>` : ''}
          ${op.summary ? `<p class="operation-summary">${escapeHtml(op.summary)}</p>` : ''}
          ${metrics}
          <div class="operation-links">${links}</div>
        </article>`;
  }).join('\n');
  const hasMetrics = props.operations.some((op) => op.metrics && op.id);
  return `<main id="operations-page" class="operations-page">
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <div class="operations-grid">
        ${cards || '<p class="operations-empty">No operations yet.</p>'}
      </div>
      ${hasMetrics ? '<p class="operations-metrics-note" id="operations-metrics-note" hidden>Activity from Discord voice and text channels, last 7 days.</p>' : ''}
      <footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

/**
 * Fills each card's metrics strip from GET /services/operations while the
 * operations page is on screen (polls every minute).
 * @param {{ endpoint?: string, refreshMs?: number }} [opts]
 * @returns {string}
 */
function renderOperationsScript (opts = {}) {
  const endpoint = JSON.stringify(opts.endpoint || '/services/operations');
  const refreshMs = Number(opts.refreshMs) > 0 ? Number(opts.refreshMs) : 60000;
  return `<script>
    (function () {
      var page = document.getElementById('operations-page');
      if (!page || !page.querySelector('.operation-metrics')) return;
      var timer = null;
      var visible = false;

      function fmt (n) {
        if (!(n > 0)) return '0';
        if (n >= 100) return String(Math.round(n));
        return String(Math.round(n * 10) / 10);
      }

      function metric (value, label, cls) {
        var li = document.createElement('li');
        li.className = 'operation-metric' + (cls ? ' ' + cls : '');
        var v = document.createElement('span');
        v.className = 'operation-metric-value';
        v.textContent = value;
        var l = document.createElement('span');
        l.className = 'operation-metric-label';
        l.textContent = label;
        li.appendChild(v);
        li.appendChild(l);
        return li;
      }

      // /services/operations lists operations most active first.
      function reorder (cards) {
        var grid = page.querySelector('.operations-grid');
        if (!grid || !cards.length) return;
        var anchor = null;
        Array.prototype.forEach.call(grid.children, function (child) {
          if (!anchor && cards.indexOf(child) !== -1) anchor = child;
        });
        cards.forEach(function (card) { grid.insertBefore(card, anchor); anchor = card.nextSibling; });
      }

      function render (data) {
        var shown = false;
        var cards = [];
        (data.operations || []).forEach(function (op) {
          var list = page.querySelector('.operation-metrics[data-operation="' + String(op.id).replace(/"/g, '') + '"]');
          if (!list) return;
          var card = list.closest('.operation-card');
          if (card) cards.push(card);
          var voice = op.metrics && op.metrics.voice;
          var messages = op.metrics && op.metrics.messages;
          var items = [];
          if (voice) {
            if (voice.live > 0) items.push(metric(String(voice.live), 'in voice now', 'operation-metric-live'));
            items.push(metric(fmt(voice.last7Days.hours), 'voice hours'));
            items.push(metric(String(voice.last7Days.members), 'pilots'));
            items.push(metric(String(voice.last7Days.peak), 'peak'));
          }
          if (messages) items.push(metric(String(messages.last7Days.messages), 'messages'));
          list.textContent = '';
          items.forEach(function (item) { list.appendChild(item); });
          list.hidden = !items.length;
          shown = shown || items.length > 0;
        });
        reorder(cards);
        var note = document.getElementById('operations-metrics-note');
        if (note) note.hidden = !shown;
      }

      function load () {
        fetch(${endpoint}, { headers: { Accept: 'application/json' } })
          .then(function (res) { return res.ok ? res.json() : null; })
          .then(function (data) { if (data) render(data); })
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
  id: 'operations-page',
  styles: renderOperationsCss,
  render: renderOperationsHtml,
  script: renderOperationsScript
};
