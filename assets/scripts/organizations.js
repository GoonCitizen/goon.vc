// Compiled from components/Organizations.js by `npm run build`. Edit the component, not this file.
'use strict';

(function client () {
  var nodes = document.querySelectorAll('[data-org-discord]');
  if (!nodes.length) return;

  function paint (bySymbol) {
    Array.prototype.forEach.call(nodes, function (el) {
      var discord = bySymbol[el.getAttribute('data-org-discord')];
      if (!discord) return;
      var linked = !!discord.linked;
      el.hidden = false;
      el.classList.toggle('linked', linked);
      el.classList.toggle('unlinked', !linked);
      el.textContent = linked
        ? (discord.name ? 'Discord: ' + discord.name : 'Discord linked')
        : 'Discord not linked';
    });
  }

  fetch('/services/organizations', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
    .then(function (res) {
      if (!res.ok) throw new Error('unavailable');
      return res.json();
    })
    .then(function (data) {
      var bySymbol = {};
      (data.organizations || []).forEach(function (org) {
        bySymbol[org.symbol] = org.discord || { linked: false };
      });
      paint(bySymbol);
    })
    .catch(function () { /* leave the placeholders hidden */ });
})(window);
