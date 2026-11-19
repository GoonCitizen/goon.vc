'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');

function renderStyles () {
  return `
      .discord-page { display: none; margin: 3em auto; max-width: 42em; padding: 0 1em 3em; text-align: left; }
      .discord-page h1, .discord-page .discord-lead { text-align: center; }
      .discord-page [hidden] { display: none !important; }
      .discord-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; line-height: 1.45; margin: 1.25em 0; padding: 1em 1.1em; }
      .discord-page h2 { font-size: 1.15em; margin: 0 0 0.4em; }
      .discord-page code { font-size: 0.95em; overflow-wrap: anywhere; }
      .discord-page .discord-meta { color: #999; }
      .discord-page ul { margin: 0.4em 0 0; padding-left: 1.2em; }
      .discord-page .discord-actions { display: flex; flex-wrap: wrap; gap: 0.5em; justify-content: center; margin: 1em 0; }
      .discord-page .discord-actions .goon-button { margin: 0; }
      .discord-status { min-height: 1.2em; text-align: center; }`;
}

/**
 * `/services/discord`: how to use the bot, and every running command the way
 * `/help` explains it, with each argument written out.
 * @param {Object} props
 * @param {string} props.loginPath
 * @param {string} props.invitePath
 * @param {string} props.installPath
 * @returns {string}
 */
function renderHtml (props) {
  return `<main id="discord-page" class="discord-page">
      <h1>Discord</h1>
      <p class="discord-lead">Slash commands for the goon.vc bot. This is the same help as <code>/help</code>, with every command and argument written out.</p>
      <div class="discord-actions">
        <a class="goon-button" href="${escapeHtml(props.invitePath)}">Add the bot to a server</a>
        <a class="goon-button" href="${escapeHtml(props.installPath)}">Add /market to your account</a>
      </div>
      <section>
        <h2>How to use it</h2>
        <ul>
          <li>In a server the bot is in, or in a DM with the bot, type <code>/</code> and the command.</li>
          <li><code>/goon</code>, <code>/schedule</code>, and <code>/clips</code> only run in a server. The others here also run in a DM with the bot. <code>/market</code> and <code>/help</code> also run in any DM once you add the bot to your account.</li>
          <li>A command does not sign you in. <code>/vote</code>, <code>/bounty</code>, <code>/market</code>, <code>/1v1</code>, <code>/rsi</code>, and <code>/hangar</code> act for the goon.vc member linked to your Discord account. <a href="${escapeHtml(props.loginPath)}">Sign in</a> first.</li>
          <li>Replies are private. A <code>/1v1</code> in a server posts the confirm card in that channel. In a DM with the bot, the card is sent to your opponent.</li>
          <li><code>/help</code> in Discord lists what is running right now, or explains one command. The commands below are that same list.</li>
        </ul>
      </section>
      <p id="discord-status" class="discord-status" role="status">Loading commands…</p>
      <div id="discord-commands"></div>
    </main>`;
}

function renderScript () {
  return CLIENT.tag();
}

function client () {
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
}

const CLIENT = clientScript('/scripts/discord.js', client, __filename);

module.exports = {
  id: 'discord-page',
  client: CLIENT,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
