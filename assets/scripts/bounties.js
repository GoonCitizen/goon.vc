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
    claimed: 'Claimed, waiting for payment',
    funded: 'Funded',
    finished: 'Finished, waiting for the poster',
    disputed: 'Disputed',
    released: 'Paid',
    refunded: 'Refunded'
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
    el.addEventListener('click', action);
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
      if (!bounties.length) text('bounties-status', 'No open bounties yet.');
      bounties.forEach(function (bounty) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.className = 'bounty-card';
        a.href = bounty.path;
        var strong = document.createElement('strong');
        strong.textContent = bounty.title;
        a.appendChild(strong);
        var small = document.createElement('small');
        small.textContent = (bounty.reward || '') + ' · ' + (STATUS[bounty.status] || bounty.status) + (bounty.posterName ? ' · ' + bounty.posterName : '');
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
        body: { title: data.get('title'), details: data.get('details'), reward: data.get('reward'), refundAddress: data.get('refundAddress') }
      }).then(function (r) {
        if (r.status === 401) {
          document.getElementById('bounties-signed-out').hidden = false;
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
      text('bounty-title', bounty.title);
      document.title = bounty.title + ' — Bounties';
      text('bounty-meta', [bounty.reward, STATUS[bounty.status] || bounty.status, bounty.posterName ? 'Posted by ' + bounty.posterName : '', bounty.claimantName ? 'Claimed by ' + bounty.claimantName : ''].filter(Boolean).join(' · '));
      text('bounty-details', bounty.details || '');
      var pay = document.getElementById('bounty-pay');
      var claim = document.getElementById('bounty-claim');
      var refund = document.getElementById('bounty-refund');
      pay.hidden = !(bounty.you === 'poster' && bounty.invoice);
      refund.hidden = !bounty.needsRefund;
      claim.hidden = bounty.status !== 'open' || bounty.you === 'poster' || !bounty.ready;
      if (bounty.status === 'open' && !bounty.ready && bounty.you !== 'poster') text('bounty-status', 'The poster still has to set a refund address.');
      if (bounty.invoice) {
        var box = document.getElementById('bounty-invoice');
        box.textContent = '';
        var address = document.createElement('p');
        address.textContent = bounty.invoice.address + ' · ' + bounty.invoice.amountBtc + ' BTC';
        box.appendChild(address);
        var link = document.createElement('a');
        link.href = bounty.invoice.bitcoinUri;
        link.textContent = 'Open in a wallet';
        box.appendChild(link);
        if (bounty.payUrl) {
          box.appendChild(document.createTextNode(' · '));
          var hub = document.createElement('a');
          hub.href = bounty.payUrl;
          hub.textContent = 'Pay on the Hub';
          box.appendChild(hub);
        }
      }
      var actions = document.getElementById('bounty-actions');
      actions.textContent = '';
      function act (label, action, body) {
        actions.appendChild(button(label, function () {
          call('/services/bounties/' + encodeURIComponent(bounty.id) + '/' + action, { method: 'POST', body: body || {} }).then(function (res) {
            if (!res.ok) text('bounty-status', (res.j && res.j.error) || 'That did not work.');
            else window.location.reload();
          });
        }));
      }
      if (bounty.you === 'claimant' && bounty.status === 'claimed') act('Drop claim', 'drop');
      if (bounty.you === 'claimant' && bounty.status === 'funded') act('Mark finished', 'finish');
      if (bounty.you === 'poster' && bounty.status === 'finished') act('Confirm and pay', 'confirm');
      if ((bounty.you === 'poster' || bounty.you === 'claimant') && (bounty.status === 'funded' || bounty.status === 'finished')) act('Dispute', 'dispute');
      var sign = document.getElementById('bounty-sign');
      sign.hidden = !(bounty.you && bounty.payouts && bounty.payouts.length);
      if (!sign.hidden) {
        var payout = bounty.payouts.find(function (item) { return item.active; }) || bounty.payouts[0];
        text('bounty-payout', (payout.kind === 'release' ? 'Pay the claimant' : 'Refund the poster') + ': ' + payout.amountSats + ' sats. ' + payout.signers + ' of 2 signatures.');
      }
    }).catch(function () { text('bounty-status', 'Could not load this bounty.'); });

    document.getElementById('bounty-claim-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new window.FormData(event.target);
      call('/services/bounties/' + encodeURIComponent(bountyId) + '/claim', { method: 'POST', body: { payoutAddress: data.get('payoutAddress') } }).then(function (r) {
        if (r.status === 401) {
          text('bounty-status', 'Sign in to claim this bounty.');
          return;
        }
        if (!r.ok) text('bounty-status', (r.j && r.j.error) || 'Could not claim this bounty.');
        else window.location.reload();
      });
    });
    document.getElementById('bounty-refund-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new window.FormData(event.target);
      call('/services/bounties/' + encodeURIComponent(bountyId) + '/refund', { method: 'POST', body: { refundAddress: data.get('refundAddress') } }).then(function (r) {
        if (!r.ok) text('bounty-status', (r.j && r.j.error) || 'Could not save that address.');
        else window.location.reload();
      });
    });
    document.getElementById('bounty-sign-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new window.FormData(event.target);
      call('/services/bounties/messages', { method: 'POST', body: { frame: data.get('frame') } }).then(function (r) {
        if (!r.ok) text('bounty-status', (r.j && r.j.error) || 'That signature was not accepted.');
        else window.location.reload();
      });
    });
    document.getElementById('bounty-pay-form').addEventListener('submit', function (event) {
      event.preventDefault();
      var data = new window.FormData(event.target);
      call('/services/bounties/' + encodeURIComponent(bountyId) + '/payments', { method: 'POST', body: { txid: data.get('txid') } }).then(function (r) {
        if (!r.ok) text('bounty-status', (r.j && r.j.error) || 'That payment was not found.');
        else window.location.reload();
      });
    });
  }

  if (onIndex) showIndex();
  else showDetail();
})(window);
