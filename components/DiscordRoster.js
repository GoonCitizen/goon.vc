'use strict';

const escapeHtml = require('../functions/escapeHtml');

// Discord's widget.json lists at most ~100 members; keep the panel short.
const MAX_MEMBERS = 60;

function renderRosterCss () {
  return `
      .discord-roster {
        background: rgba(0, 0, 0, 0.25);
        border: 1px solid #555;
        border-radius: 10px;
        box-sizing: border-box;
        margin: 2em auto 0;
        max-width: 350px;
        padding: 1rem 1.1rem 1.25rem;
        text-align: left;
      }
      .dr-head { align-items: baseline; display: flex; gap: 0.75rem; justify-content: space-between; }
      .dr-title { font-family: "Bungee", sans-serif; font-size: 0.95rem; letter-spacing: 0.06em; }
      .dr-online { color: #bbb; font-size: 0.9rem; }
      .dr-online strong { color: #fff; }
      .dr-section { color: #999; font-family: "Rajdhani", sans-serif; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.12em; margin: 1rem 0 0.35rem; text-transform: uppercase; }
      .dr-channel { color: #fff; font-weight: 700; margin: 0.6rem 0 0.15rem; }
      .dr-body { max-height: 28rem; overflow-y: auto; padding-right: 0.35rem; scrollbar-color: #666 transparent; scrollbar-width: thin; }
      .dr-body::-webkit-scrollbar { width: 8px; }
      .dr-body::-webkit-scrollbar-track { background: transparent; }
      .dr-body::-webkit-scrollbar-thumb { background: #555; border-radius: 4px; }
      .dr-body::-webkit-scrollbar-thumb:hover { background: #888; }
      .dr-list { list-style: none; margin: 0; padding: 0; }
      .dr-member { align-items: center; display: grid; gap: 0.55rem; grid-template-columns: 1.6rem minmax(0, 1fr); padding: 0.15rem 0.25rem; }
      .dr-avatar { height: 1.6rem; position: relative; width: 1.6rem; }
      .dr-avatar img { border-radius: 50%; height: 100%; object-fit: cover; width: 100%; }
      .dr-status { border: 2px solid #333; border-radius: 50%; bottom: -2px; height: 0.6rem; position: absolute; right: -2px; width: 0.6rem; }
      .dr-status-online { background: #23a55a; }
      .dr-status-idle { background: #f0b232; }
      .dr-status-dnd { background: #f23f43; }
      .dr-name { color: #ddd; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .dr-game { color: #888; font-size: 0.8rem; margin-left: 0.35em; }
      .dr-more, .dr-empty { color: #888; font-size: 0.85rem; margin: 0.5rem 0 0; }
      .dr-join { margin-top: 1rem; text-align: center; }`;
}

/**
 * Server-rendered shell; the script fills it from the guild's public widget.json.
 * @param {Object} props
 * @param {string} props.title
 * @param {string} props.inviteUrl Fallback until widget.json supplies an instant invite.
 */
function renderRosterHtml (props) {
  return `<section id="discord-roster" class="discord-roster" aria-labelledby="discord-roster-title">
        <div class="dr-head">
          <span class="dr-title" id="discord-roster-title">${escapeHtml(props.title)}</span>
          <span class="dr-online"><strong id="discord-roster-online">—</strong> online</span>
        </div>
        <div class="dr-body">
          <div id="discord-roster-voice"></div>
          <h3 class="dr-section">Members online</h3>
          <ul class="dr-list" id="discord-roster-members"></ul>
          <p class="dr-more" id="discord-roster-more" hidden></p>
          <p class="dr-empty" id="discord-roster-empty" hidden>The member list is unavailable right now.</p>
        </div>
        <p class="dr-join"><a class="goon-button" id="discord-roster-join" href="${escapeHtml(props.inviteUrl)}" target="_blank" rel="noopener noreferrer">Join Discord</a></p>
      </section>`;
}

/**
 * @param {Object} props
 * @param {string} props.guildId
 * @param {string} props.pageId Only runs while this page is visible.
 */
function renderRosterScript (props) {
  return `<script type="text/javascript">
      (function () {
        var page = document.getElementById(${JSON.stringify(props.pageId)});
        if (!page || page.style.display === 'none') return;
        var MAX_MEMBERS = ${MAX_MEMBERS};
        var online = document.getElementById('discord-roster-online');
        var voice = document.getElementById('discord-roster-voice');
        var list = document.getElementById('discord-roster-members');
        var more = document.getElementById('discord-roster-more');
        var empty = document.getElementById('discord-roster-empty');
        var join = document.getElementById('discord-roster-join');

        function memberRow (m, withGame) {
          var li = document.createElement('li');
          li.className = 'dr-member';
          var avatar = document.createElement('span');
          avatar.className = 'dr-avatar';
          var img = document.createElement('img');
          img.src = m.avatar_url || '';
          img.alt = '';
          img.loading = 'lazy';
          avatar.appendChild(img);
          var status = document.createElement('span');
          status.className = 'dr-status dr-status-' + (/^(online|idle|dnd)$/.test(m.status) ? m.status : 'online');
          avatar.appendChild(status);
          var name = document.createElement('span');
          name.className = 'dr-name';
          name.textContent = m.username || 'Member';
          if (withGame && m.game && m.game.name) {
            var game = document.createElement('span');
            game.className = 'dr-game';
            game.textContent = m.game.name;
            name.appendChild(game);
          }
          li.appendChild(avatar);
          li.appendChild(name);
          return li;
        }

        function render (data) {
          var members = data.members || [];
          online.textContent = String(typeof data.presence_count === 'number' ? data.presence_count : members.length);
          if (data.instant_invite) join.href = data.instant_invite;

          voice.textContent = '';
          (data.channels || []).slice().sort(function (a, b) { return (a.position || 0) - (b.position || 0); }).forEach(function (channel) {
            var inChannel = members.filter(function (m) { return m.channel_id != null && String(m.channel_id) === String(channel.id); });
            if (!inChannel.length) return;
            var heading = document.createElement('div');
            heading.className = 'dr-channel';
            heading.textContent = channel.name;
            var ul = document.createElement('ul');
            ul.className = 'dr-list';
            inChannel.forEach(function (m) { ul.appendChild(memberRow(m, false)); });
            voice.appendChild(heading);
            voice.appendChild(ul);
          });

          list.textContent = '';
          members.slice(0, MAX_MEMBERS).forEach(function (m) { list.appendChild(memberRow(m, true)); });
          var hidden = members.length - MAX_MEMBERS;
          more.hidden = hidden <= 0;
          if (hidden > 0) more.textContent = '+' + hidden + ' more on Discord';
          empty.hidden = members.length > 0;
        }

        window.fetch('https://discord.com/api/guilds/' + ${JSON.stringify(String(props.guildId))} + '/widget.json')
          .then(function (res) {
            if (!res.ok) throw new Error('widget ' + res.status);
            return res.json();
          })
          .then(render)
          .catch(function () {
            online.textContent = '—';
            empty.hidden = false;
          });
      })();
    </script>`;
}

module.exports = {
  id: 'discord-roster',
  styles: renderRosterCss,
  render: renderRosterHtml,
  script: renderRosterScript
};
