'use strict';

// RSI claim page (components/RsiClaimPage.js): get a g00n: code, put it in
// the RSI bio, verify. Also shows the member fleet totals.
(function () {
  var root = document.getElementById('rsi-page');
  if (!root) return;
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  if (path.toLowerCase() !== String(root.getAttribute('data-path')).toLowerCase()) return;

  var api = root.getAttribute('data-api');
  var fleetApi = root.getAttribute('data-fleet');
  var status = document.getElementById('rsi-status');
  var signedOut = document.getElementById('rsi-signed-out');
  var signedIn = document.getElementById('rsi-signed-in');
  var memberLine = document.getElementById('rsi-member');
  var claimedBox = document.getElementById('rsi-claimed-box');
  var claimedList = document.getElementById('rsi-claimed');
  var form = document.getElementById('rsi-claim-form');
  var handleInput = document.getElementById('rsi-handle');
  var pendingBox = document.getElementById('rsi-pending');
  var codeEl = document.getElementById('rsi-code');
  var copyBtn = document.getElementById('rsi-copy');
  var verifyBtn = document.getElementById('rsi-verify');
  var citizenLink = document.getElementById('rsi-citizen');

  var ERRORS = { link: 'That sign-in link was already used or has expired. Run /rsi claim on Discord for a new one.' };

  function call (url, opts) {
    return window.fetch(url, Object.assign({ cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
      });
  }

  function post (url, body) {
    return call(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) });
  }

  function showPending (pending) {
    pendingBox.hidden = !pending;
    if (!pending) return;
    codeEl.textContent = pending.code;
    citizenLink.href = pending.url || '#';
    if (!handleInput.value) handleInput.value = pending.handle;
  }

  function showHandles (handles) {
    claimedList.textContent = '';
    (handles || []).forEach(function (handle) {
      var li = document.createElement('li');
      li.textContent = handle;
      claimedList.appendChild(li);
    });
    claimedBox.hidden = !(handles && handles.length);
  }

  function render (data) {
    signedOut.hidden = !!data;
    signedIn.hidden = !data;
    if (!data) return;
    memberLine.textContent = 'Signed in as ' + ((data.member && data.member.displayName) || 'a member') + '.';
    showHandles(data.handles);
    showPending(data.pending);
  }

  var params = new URLSearchParams(window.location.search);
  if (params.get('error')) {
    status.textContent = ERRORS[params.get('error')] || 'Something went wrong. Try again.';
    window.history.replaceState(null, '', window.location.pathname);
  }

  call(api).then(function (r) {
    render(r.ok ? r.j : null);
  }).catch(function () {
    status.textContent = 'Could not reach goon.vc. Try again in a minute.';
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    status.textContent = 'Getting a code…';
    post(api + '/claims', { handle: handleInput.value }).then(function (r) {
      if (!r.ok) {
        status.textContent = (r.j && r.j.error) || 'Could not start the claim.';
        return;
      }
      status.textContent = 'Put this code in your RSI bio, then press Verify.';
      showPending(r.j.pending);
    });
  });

  copyBtn.addEventListener('click', function () {
    var text = codeEl.textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { status.textContent = 'Copied ' + text + '.'; });
    } else {
      window.getSelection().selectAllChildren(codeEl);
    }
  });

  verifyBtn.addEventListener('click', function () {
    verifyBtn.disabled = true;
    status.textContent = 'Checking your RSI bio…';
    post(api + '/claims/verify').then(function (r) {
      verifyBtn.disabled = false;
      if (!r.ok) {
        status.textContent = (r.j && r.j.error) || 'Verification failed.';
        return;
      }
      status.textContent = 'Claimed ' + r.j.handle + (r.j.merged ? '. It was on another profile of yours, so the two are now one.' : '.') + ' Run /hangar on Discord to sync your ships.';
      showPending(null);
      handleInput.value = '';
      showHandles(r.j.handles);
    }, function () {
      verifyBtn.disabled = false;
      status.textContent = 'Could not reach goon.vc. Try again.';
    });
  });

  var fleet = document.getElementById('rsi-fleet');
  call(fleetApi).then(function (r) {
    if (!r.ok || !r.j || !r.j.ships) return;
    document.getElementById('rsi-fleet-summary').textContent = r.j.ships + ' ships across ' + r.j.members + ' member' + (r.j.members === 1 ? '' : 's') + ' who synced their hangar.';
    var body = document.getElementById('rsi-fleet-models');
    (r.j.models || []).slice(0, 50).forEach(function (model) {
      var tr = document.createElement('tr');
      [(model.manufacturer ? model.manufacturer + ' ' : '') + model.model, model.count, model.owners].forEach(function (value, i) {
        var td = document.createElement('td');
        if (i) td.className = 'num';
        td.textContent = String(value);
        tr.appendChild(td);
      });
      body.appendChild(tr);
    });
    fleet.hidden = false;
  }).catch(function () {});
})();
