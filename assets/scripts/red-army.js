// Compiled from components/RedArmyPage.js by `npm run build`. Edit the component, not this file.
'use strict';

(function client () {
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
})(window);
