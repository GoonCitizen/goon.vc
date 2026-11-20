// Compiled from components/DiscordPage.js by `npm run build`. Edit the component, not this file.
'use strict';

(function client () {
  var page = document.getElementById('discord-page');
  if (!page) return;
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  if (path.toLowerCase() !== '/services/discord') return;

  function esc (value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  function linked (text) {
    return esc(text).replace(/&lt;(https?:\/\/[^&\s]+)&gt;/g, function (_, url) {
      var shown = url.replace(/^https?:\/\/[^/]+/, '') || url;
      return '<a href="' + url + '">' + esc(shown) + '</a>';
    });
  }

  function args (options) {
    if (!options || !options.length) return '';
    return '<ul>' + options.map(function (option) {
      var name = option.required ? option.name : '[' + option.name + ']';
      var choices = option.choices && option.choices.length && option.choices.length <= 6
        ? ' Choices: ' + option.choices.join(', ') + '.'
        : (option.choices && option.choices.length ? ' Pick from the list.' : '');
      return '<li><code>' + esc(name) + '</code> — ' + esc(option.description) + esc(choices) + '</li>';
    }).join('') + '</ul>';
  }

  function command (entry) {
    var body = '<section><h2><code>/' + esc(entry.name) + '</code></h2>';
    body += '<p>' + esc(entry.description) + '</p>';
    if (entry.about) body += '<p>' + linked(entry.about) + '</p>';
    if (entry.subcommands && entry.subcommands.length) {
      body += entry.subcommands.map(function (sub) {
        return '<p><code>' + esc(sub.usage) + '</code> — ' + esc(sub.description) + '</p>' + args(sub.options);
      }).join('');
    } else if (entry.usage) {
      body += '<p><code>' + esc(entry.usage) + '</code></p>' + args(entry.options);
    }
    var where = entry.where || '';
    if (entry.permission) where += (where ? ' ' : '') + 'Needs ' + entry.permission + '.';
    if (where) body += '<p class="discord-meta">' + esc(where) + '</p>';
    return body + '</section>';
  }

  window.fetch('/services/discord', { headers: { Accept: 'application/json' }, cache: 'no-store' }).then(function (res) {
    return res.json().then(function (body) { return { ok: res.ok, body: body }; });
  }).then(function (result) {
    var status = document.getElementById('discord-status');
    var list = document.getElementById('discord-commands');
    if (!result.ok || !result.body || !result.body.commands) {
      if (status) status.textContent = 'The command list is unavailable.';
      return;
    }
    if (status) status.textContent = '';
    if (list) list.innerHTML = result.body.commands.map(command).join('');
  }).catch(function () {
    var status = document.getElementById('discord-status');
    if (status) status.textContent = 'The command list is unavailable.';
  });
})(window);
