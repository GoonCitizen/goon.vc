'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');

function renderStyles () {
  return `
      .bounties-page, .bounty-page { display: none; margin: 3em auto; max-width: 40em; padding: 0 1em 3em; text-align: left; }
      .bounties-page h1, .bounty-page h1 { text-align: center; }
      .bounties-page [hidden], .bounty-page [hidden] { display: none !important; }
      .bounties-page section, .bounty-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; line-height: 1.45; margin: 1.25em 0; padding: 1em; }
      .bounty-card { color: inherit; display: block; text-decoration: none; }
      .bounty-card:hover { background: rgba(255, 255, 255, 0.06); }
      .bounty-card small, .bounty-meta { color: #999; }
      .bounty-form { display: flex; flex-direction: column; gap: 0.6em; }
      .bounty-form input, .bounty-form textarea { background: #111; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 4px; color: #fff; font: inherit; padding: 0.45em 0.6em; }
      .bounty-actions { display: flex; flex-wrap: wrap; gap: 0.5em; }
      .bounty-actions .goon-button { margin: 0; }
      .bounty-status { min-height: 1.2em; text-align: center; }`;
}

/**
 * `/bounties` and `/bounties/<id>`.
 * @param {Object} props
 * @param {string} props.path
 * @param {string} props.loginPath
 * @param {string} props.rsiPath
 * @returns {string}
 */
function renderHtml (props) {
  const rsiPath = props.rsiPath || '/rsi';
  return `<main id="bounties-page" class="bounties-page" data-path="${escapeHtml(props.path)}">
      <h1>Bounties</h1>
      <p class="bounty-meta" style="text-align:center">A price on a pilot. Kill them, and the poster pays you in game. Prices are aUEC. The game calls that UEC once it launches.</p>
      <p id="bounties-status" class="bounty-status" role="status"></p>
      <ul id="bounties-list" class="admin-list" style="list-style:none;padding:0"></ul>
      <section>
        <h2>Post a bounty</h2>
        <p class="bounty-meta">Posting takes a linked RSI handle. <a href="${escapeHtml(rsiPath)}">Link one</a>, or <a href="${escapeHtml(props.loginPath)}">sign in</a>.</p>
        <p id="bounties-signed-out" hidden>Sign in, and link an RSI handle, before you post. <a href="${escapeHtml(props.loginPath)}">Sign in</a></p>
        <form id="bounty-post" class="bounty-form">
          <input name="target" required maxlength="60" placeholder="Target RSI handle" aria-label="Target RSI handle" autocapitalize="off" spellcheck="false">
          <input name="reward" required placeholder="Reward in aUEC, such as 150000 or 150k" aria-label="Reward in aUEC" inputmode="decimal">
          <textarea name="note" maxlength="500" rows="3" placeholder="Where they fly, or why (optional)" aria-label="Note"></textarea>
          <button class="goon-button" type="submit">Post</button>
        </form>
      </section>
    </main>
    <main id="bounty-page" class="bounty-page" data-base="${escapeHtml(props.path)}">
      <p><a href="${escapeHtml(props.path)}">← Bounties</a></p>
      <h1 id="bounty-title">Bounty</h1>
      <p id="bounty-status" class="bounty-status" role="status"></p>
      <p id="bounty-meta" class="bounty-meta"></p>
      <p id="bounty-note"></p>
      <p id="bounty-actions" class="bounty-actions"></p>
    </main>`;
}

function renderScript () {
  return CLIENT.tag();
}

function client () {
  var index = document.getElementById('bounties-page');
  var detail = document.getElementById('bounty-page');
  if (!index || !detail) return;
  var base = String(index.getAttribute('data-path') || '/bounties');
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  var onIndex = path.toLowerCase() === base.toLowerCase();
  var bountyId = path.toLowerCase().indexOf(base.toLowerCase() + '/') === 0 ? path.slice(base.length + 1) : '';
  if (!onIndex && !bountyId) return;

  var STATUS = {
    open: 'Open',
    claimed: 'Kill claimed',
    paid: 'Paid'
  };

  function call (url, opts) {
    var options = opts || {};
    return window.fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      method: options.method || 'GET',
      headers: Object.assign({ Accept: 'application/json' }, options.body ? { 'Content-Type': 'application/json' } : {}),
      body: options.body ? JSON.stringify(options.body) : null
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
    });
  }

  function text (id, value) {
    var el = document.getElementById(id);
    if (el) el.textContent = value || '';
  }

  function button (label, action) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'goon-button';
    el.textContent = label;
    el.addEventListener('click', function () {
      call('/services/bounties/' + encodeURIComponent(bountyId) + '/' + action, { method: 'POST', body: {} }).then(function (res) {
        if (res.status === 401) {
          text('bounty-status', 'Sign in first.');
          return;
        }
        if (!res.ok) text('bounty-status', (res.j && res.j.error) || 'That did not work.');
        else window.location.reload();
      });
    });
    return el;
  }

  function showIndex () {
    call('/services/bounties').then(function (r) {
      var list = document.getElementById('bounties-list');
      list.textContent = '';
      if (!r.ok) {
        text('bounties-status', (r.j && r.j.error) || 'Could not load bounties.');
        return;
      }
      var bounties = (r.j && r.j.bounties) || [];
      if (!bounties.length) text('bounties-status', 'No bounties yet.');
      bounties.forEach(function (bounty) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.className = 'bounty-card';
        a.href = bounty.path;
        var strong = document.createElement('strong');
        strong.textContent = bounty.target;
        a.appendChild(strong);
        var small = document.createElement('small');
        small.textContent = (bounty.reward || '') + ' · ' + (STATUS[bounty.status] || bounty.status) + (bounty.posterHandle ? ' · posted by ' + bounty.posterHandle : '');
        a.appendChild(document.createElement('br'));
        a.appendChild(small);
        li.appendChild(a);
        list.appendChild(li);
      });
    }).catch(function () { text('bounties-status', 'Could not load bounties.'); });

    document.getElementById('bounty-post').addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new window.FormData(event.target);
      call('/services/bounties', {
        method: 'POST',
        body: { target: data.get('target'), reward: data.get('reward'), note: data.get('note') }
      }).then(function (r) {
        if (r.status === 401) {
          document.getElementById('bounties-signed-out').hidden = false;
          text('bounties-status', '');
          return;
        }
        if (!r.ok) {
          text('bounties-status', (r.j && r.j.error) || 'Could not post that bounty.');
          return;
        }
        window.location.href = r.j.bounty.path;
      });
    });
  }

  function showDetail () {
    call('/services/bounties/' + encodeURIComponent(bountyId)).then(function (r) {
      if (!r.ok || !r.j || !r.j.bounty) {
        text('bounty-status', (r.j && r.j.error) || 'No such bounty.');
        return;
      }
      var bounty = r.j.bounty;
      var title = document.getElementById('bounty-title');
      title.textContent = '';
      if (bounty.targetUrl) {
        var link = document.createElement('a');
        link.href = bounty.targetUrl;
        link.textContent = bounty.target;
        title.appendChild(link);
      } else title.textContent = bounty.target;
      document.title = bounty.target + ' — Bounties';
      text('bounty-meta', [bounty.reward, STATUS[bounty.status] || bounty.status, bounty.posterHandle ? 'Posted by ' + bounty.posterHandle : '', bounty.claimantHandle ? 'Claimed by ' + bounty.claimantHandle : ''].filter(Boolean).join(' · '));
      text('bounty-note', bounty.note || '');
      var actions = document.getElementById('bounty-actions');
      actions.textContent = '';
      if (bounty.status === 'open' && bounty.you !== 'poster') actions.appendChild(button('I killed them', 'claim'));
      if (bounty.you === 'poster' && bounty.status === 'open') actions.appendChild(button('Take it down', 'cancel'));
      if (bounty.you === 'claimant' && bounty.status === 'claimed') actions.appendChild(button('Drop the claim', 'drop'));
      if (bounty.you === 'poster' && bounty.status === 'claimed') {
        actions.appendChild(button('Confirm and pay', 'confirm'));
        actions.appendChild(button('Turn the claim away', 'reject'));
      }
      if (bounty.status === 'paid') text('bounty-status', 'The poster confirmed the kill. The reward is paid in game.');
    }).catch(function () { text('bounty-status', 'Could not load this bounty.'); });
  }

  if (onIndex) showIndex();
  else showDetail();
}

const CLIENT = clientScript('/scripts/bounties.js', client, __filename);

module.exports = {
  id: 'bounties-page',
  client: CLIENT,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
