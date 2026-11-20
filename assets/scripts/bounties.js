// Compiled from components/BountiesPage.js by `npm run build`. Edit the component, not this file.
'use strict';

(function client () {
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
})(window);
