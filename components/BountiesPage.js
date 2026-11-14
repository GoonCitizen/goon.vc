'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');

const STATUS = {
  open: 'Open',
  claimed: 'Claimed, waiting for payment',
  funded: 'Funded',
  finished: 'Finished, waiting for the poster',
  disputed: 'Disputed',
  released: 'Paid',
  refunded: 'Refunded',
  cancelled: 'Cancelled'
};

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
 * @returns {string}
 */
function renderHtml (props) {
  return `<main id="bounties-page" class="bounties-page" data-path="${escapeHtml(props.path)}">
      <h1>Bounties</h1>
      <p class="bounty-meta" style="text-align:center">Post a reward. Someone claims it, you pay the escrow, and confirming the work releases the bitcoin.</p>
      <p id="bounties-status" class="bounty-status" role="status"></p>
      <ul id="bounties-list" class="admin-list" style="list-style:none;padding:0"></ul>
      <section>
        <h2>Post a bounty</h2>
        <p id="bounties-signed-out" hidden>Sign in to post or claim. <a href="${escapeHtml(props.loginPath)}">Sign in</a></p>
        <form id="bounty-post" class="bounty-form">
          <input name="title" required maxlength="120" placeholder="Title" aria-label="Title">
          <textarea name="details" maxlength="2000" rows="3" placeholder="What done looks like" aria-label="Details"></textarea>
          <input name="reward" required placeholder="Reward, 0.005 BTC or 500k sats" aria-label="Reward">
          <input name="refundAddress" required placeholder="Your refund address" aria-label="Refund address">
          <button class="goon-button" type="submit">Post</button>
        </form>
      </section>
    </main>
    <main id="bounty-page" class="bounty-page" data-base="${escapeHtml(props.path)}">
      <p><a href="${escapeHtml(props.path)}">← Bounties</a></p>
      <h1 id="bounty-title">Bounty</h1>
      <p id="bounty-status" class="bounty-status" role="status"></p>
      <p id="bounty-meta" class="bounty-meta"></p>
      <p id="bounty-details"></p>
      <section id="bounty-refund" hidden>
        <h2>Refund address</h2>
        <p class="bounty-meta">Someone can claim this once you give the address a refund would return to.</p>
        <form id="bounty-refund-form" class="bounty-form">
          <input name="refundAddress" required placeholder="Your refund address" aria-label="Refund address">
          <button class="goon-button" type="submit">Save</button>
        </form>
      </section>
      <section id="bounty-pay" hidden>
        <h2>Pay the escrow</h2>
        <p id="bounty-invoice"></p>
        <form id="bounty-pay-form" class="bounty-form">
          <input name="txid" required placeholder="Transaction id, if you already paid" aria-label="Transaction id">
          <button class="goon-button" type="submit">I’ve paid</button>
        </form>
      </section>
      <section id="bounty-claim" hidden>
        <h2>Claim</h2>
        <form id="bounty-claim-form" class="bounty-form">
          <input name="payoutAddress" required placeholder="Address the reward should be paid to" aria-label="Payout address">
          <button class="goon-button" type="submit">Claim</button>
        </form>
      </section>
      <p id="bounty-actions" class="bounty-actions"></p>
      <section id="bounty-sign" hidden>
        <h2>Sign the payout</h2>
        <p id="bounty-payout" class="bounty-meta"></p>
        <form id="bounty-sign-form" class="bounty-form">
          <textarea name="frame" required rows="3" placeholder="Paste the signed frame" aria-label="Signed frame"></textarea>
          <button class="goon-button" type="submit">Submit signature</button>
        </form>
      </section>
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
}

const CLIENT = clientScript('/scripts/bounties.js', client, __filename);

module.exports = {
  id: 'bounties-page',
  client: CLIENT,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
