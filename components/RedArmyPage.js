'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');

const INTRO = 'Friends of the alliance. Not yet members, but those who enjoy the fight. Blood for the blood god.';

function renderStyles () {
  return `
      .red-army-page { display: none; margin: 0 auto; max-width: 38em; padding: 1.5em 1em 3em; text-align: left; color: #E8F4FF; }
      .red-army-page > h1, .red-army-intro { text-align: center; }
      .red-army-page > h1 { color: #fff; margin-top: 0.5em; }
      .red-army-intro { color: #8AA4B8; font-size: 0.92em; line-height: 1.45; margin: 0 auto 2em; max-width: 28em; }
      .red-army-page [hidden], .red-army-block [hidden] { display: none !important; }
      .red-army-page .page-back a, .red-army-page footer a:not(.footer-login-button), .red-army-block a { color: #e08a8a; }
      .red-army-block {
        background: rgba(40, 10, 12, 0.55);
        border: 1px solid rgba(194, 59, 59, 0.35);
        border-left: 3px solid #c23b3b;
        margin-top: 2rem;
        padding: 1.25rem 1.15rem;
        scroll-margin-top: 5rem;
      }
      .red-army-block h2 { color: #fff; font-size: 1.15rem; margin: 0 0 0.4rem; }
      .red-army-block > p { color: #8AA4B8; line-height: 1.45; margin: 0 0 0.9rem; }
      .red-army-more { margin: 0.9rem 0 0; text-align: center; }
      .red-army-card { border-left-color: #c23b3b; }
      .red-army-officers { color: #E8F4FF; font-size: 0.88rem; margin: 0.35rem 0 0; }
      .red-army-note { color: #8AA4B8; font-size: 0.85rem; line-height: 1.4; margin: 0.45rem 0 0; }
      .red-army-servers-title { color: #fff; font-size: 1.05rem; margin: 1.5rem 0 0.75rem; }
      .red-army-grid { margin-top: 0.75rem; }`;
}

/**
 * Compact RED ARMY teaser. Unique `id` when the SPA also embeds it on the
 * PERMAFLEET operation page (`id="red-army"` stays on `/organizations`).
 * @param {Object} props
 * @param {string} props.path `/red-army`
 * @param {string} [props.id]
 * @param {string} [props.titleId]
 * @returns {string}
 */
function renderTeaser (props) {
  if (!props.path) return '';
  const id = String(props.id || 'red-army').trim() || 'red-army';
  const titleId = String(props.titleId || (id === 'red-army' ? 'red-army-teaser-title' : `${id}-title`)).trim();
  return `<section class="red-army-block" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(titleId)}">
        <h2 id="${escapeHtml(titleId)}">RED ARMY</h2>
        <p>${escapeHtml(props.intro || INTRO)}</p>
        <div data-red-army="teaser" hidden></div>
        <p class="red-army-more"><a href="${escapeHtml(props.path)}">RED ARMY roster &raquo;</a></p>
      </section>`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.organizationsPath
 * @param {string} props.onboardingPath
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 * @returns {string}
 */
function renderHtml (props) {
  const orgs = props.organizationsPath
    ? `<a href="${escapeHtml(props.organizationsPath)}">PERMAFLEET organizations</a>`
    : 'PERMAFLEET organizations';
  const join = props.onboardingPath
    ? ` <a href="${escapeHtml(props.onboardingPath)}">How an organization joins</a>.`
    : '';
  return `<main id="red-army-page" class="red-army-page">
      <h1>${props.heading}</h1>
      <p class="red-army-intro">${props.intro} Not a vote, and not a Fabric federation. ${orgs}.${join}</p>
      <div data-red-army="page" hidden></div>
      <footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

/**
 * Fills `[data-red-army]` from `GET /services/red-army`. Hidden until the
 * answer arrives. Compact on the organizations teaser.
 */
function client () {
  var hosts = document.querySelectorAll('[data-red-army]');
  if (!hosts.length) return;

  function escapeText (value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function discordLine (discord) {
    if (!discord) return '';
    var linked = !!discord.linked;
    var text = linked
      ? (discord.name ? 'Discord: ' + discord.name : 'Discord linked')
      : 'Discord not linked';
    return '<span class="org-discord ' + (linked ? 'linked' : 'unlinked') + '">' + escapeText(text) + '</span>';
  }

  function officersLine (officers) {
    var names = (officers || []).map(function (officer) { return officer && officer.name; }).filter(Boolean);
    if (!names.length) return '';
    return '<p class="red-army-officers">Officer' + (names.length === 1 ? '' : 's') + ': ' + escapeText(names.join(', ')) + '</p>';
  }

  function card (entry, compact) {
    var rsi = entry.rsi && entry.rsi.url
      ? '<a class="goon-button" href="' + escapeText(entry.rsi.url) + '" target="_blank" rel="noopener">RSI page</a>'
      : '';
    var note = !compact && entry.note ? '<p class="red-army-note">' + escapeText(entry.note) + '</p>' : '';
    var symbol = entry.symbol
      ? '<p class="org-meta"><span class="org-symbol">[' + escapeText(entry.symbol) + ']</span></p>'
      : '<p class="org-meta">Discord server</p>';
    return '<article class="org-card red-army-card"><div class="org-card-body">' +
      '<h3 class="org-name">' + escapeText(entry.name) + '</h3>' +
      symbol +
      discordLine(entry.discord) +
      officersLine(entry.officers) +
      note +
      (rsi ? '<div class="org-links">' + rsi + '</div>' : '') +
      '</div></article>';
  }

  function list (data, compact) {
    var orgs = data.organizations || [];
    var servers = data.servers || [];
    if (!orgs.length && !servers.length) {
      return '<p class="organizations-empty">No RED ARMY servers yet. Adding our bot to a Discord that is not a PERMAFLEET member org lists it here.</p>';
    }
    var html = '';
    if (orgs.length) {
      html += '<div class="organizations-grid red-army-grid">' + orgs.map(function (org) { return card(org, compact); }).join('') + '</div>';
    }
    if (servers.length) {
      if (!compact) html += '<h2 class="red-army-servers-title">Other servers</h2>';
      html += '<div class="organizations-grid red-army-grid">' + servers.map(function (org) { return card(org, compact); }).join('') + '</div>';
    }
    return html;
  }

  fetch('/services/red-army', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('unavailable');
      return res.json();
    })
    .then(function (data) {
      Array.prototype.forEach.call(hosts, function (el) {
        el.hidden = false;
        el.innerHTML = list(data, el.getAttribute('data-red-army') === 'teaser');
      });
    })
    .catch(function () { /* leave the placeholders hidden */ });
}

const CLIENT = clientScript('/scripts/red-army.js', client, __filename);

function renderScript () {
  return CLIENT.tag();
}

module.exports = {
  id: 'red-army-page',
  intro: INTRO,
  client: CLIENT,
  styles: renderStyles,
  render: renderHtml,
  renderTeaser,
  script: renderScript
};
