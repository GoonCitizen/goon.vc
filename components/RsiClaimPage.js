'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');

const API = '/services/members/rsi';
const FLEET_API = '/services/hangar';
const RSI_PROFILE_EDIT = 'https://robertsspaceindustries.com/account/profile';

function renderStyles () {
  return `
      .rsi-page { display: none; margin: 3em auto; max-width: 34em; padding: 0 1em; text-align: left; }
      .rsi-page h1, .rsi-page h2 { text-align: center; }
      .rsi-page .rsi-intro { color: #bbb; line-height: 1.45; }
      .rsi-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; margin: 1.5em 0; padding: 1em; }
      .rsi-page [hidden] { display: none !important; }
      .rsi-page form { display: flex; flex-wrap: wrap; gap: 0.5em; }
      .rsi-page input[type="text"] { background: #222; border: 1px solid #777; border-radius: 6px; color: #fff; flex: 1 1 12em; font-size: 1em; padding: 0.45em 0.6em; }
      .rsi-page ol { line-height: 1.5; padding-left: 1.4em; }
      .rsi-code { align-items: center; display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; margin: 1em 0; }
      .rsi-code code { background: #111; border: 1px dashed #aaa; border-radius: 6px; font-size: 1.4em; padding: 0.3em 0.7em; }
      .rsi-status { min-height: 1.2em; overflow-wrap: anywhere; text-align: center; }
      .rsi-claimed { list-style: none; margin: 0.5em 0 0; padding: 0; }
      .rsi-claimed li { border-top: 1px solid rgba(255, 255, 255, 0.12); padding: 0.4em 0; }
      .rsi-fleet table { border-collapse: collapse; width: 100%; }
      .rsi-fleet td, .rsi-fleet th { border-top: 1px solid rgba(255, 255, 255, 0.12); padding: 0.3em 0.4em; text-align: left; }
      .rsi-fleet td.num, .rsi-fleet th.num { text-align: right; }`;
}

/**
 * The RSI claim page: a member proves an RSI handle by putting a one-time
 * `g00n:` code in that citizen's public bio. `/rsi claim` on Discord sends a
 * private link that signs the member in here. Below it, the member fleet
 * totals from `/services/hangar` (no names).
 * @param {Object} props
 * @param {string} props.path
 * @param {string} props.loginPath
 * @param {string} props.joinUrl
 * @returns {string}
 */
function renderHtml (props) {
  return `<main id="rsi-page" class="rsi-page" data-path="${escapeHtml(props.path)}" data-api="${API}" data-fleet="${FLEET_API}">
      <h1>Claim your RSI profile</h1>
      <p class="rsi-intro">Link your Star Citizen handle to your G00N SQUAD profile. You prove it’s yours by putting a short code in your public RSI bio for a minute; then you can sync your hangar with <code>/hangar</code> on Discord.</p>
      <p id="rsi-status" class="rsi-status" role="status"></p>
      <section id="rsi-signed-out" hidden>
        <p>Run <code>/rsi claim</code> in the G00N SQUAD Discord (or in a DM with our bot). It replies with a private link that signs you in here.</p>
        <p>Or <a href="${escapeHtml(props.loginPath)}">log in</a> with Discord or Passport. Not in the Squad yet? <a href="${escapeHtml(props.joinUrl)}">Join the Discord &raquo;</a></p>
      </section>
      <section id="rsi-signed-in" hidden>
        <p id="rsi-member"></p>
        <div id="rsi-claimed-box" hidden>
          <strong>Claimed</strong>
          <ul id="rsi-claimed" class="rsi-claimed"></ul>
          <p><small>You can remove the code from your RSI bio now. To claim another handle, start again below.</small></p>
        </div>
        <form id="rsi-claim-form" autocomplete="off">
          <input type="text" id="rsi-handle" name="handle" aria-label="RSI handle" placeholder="Your RSI handle" maxlength="60" required>
          <button type="submit" class="goon-button">Get a code</button>
        </form>
        <div id="rsi-pending" hidden>
          <div class="rsi-code"><code id="rsi-code"></code><button type="button" id="rsi-copy" class="goon-button">Copy</button></div>
          <ol>
            <li>Open your <a href="${RSI_PROFILE_EDIT}" target="_blank" rel="noopener noreferrer">RSI profile settings</a>.</li>
            <li>Paste the code anywhere in your <strong>Short Bio</strong> and save.</li>
            <li>Come back and press Verify. We read your <a id="rsi-citizen" href="#" target="_blank" rel="noopener noreferrer">public citizen page</a> once.</li>
          </ol>
          <p style="text-align: center;"><button type="button" id="rsi-verify" class="goon-button">Verify</button></p>
          <p><small>The code is good for 24 hours.</small></p>
        </div>
      </section>
      <section id="rsi-fleet" class="rsi-fleet" hidden>
        <h2>Member fleet</h2>
        <p id="rsi-fleet-summary" class="rsi-intro"></p>
        <table><thead><tr><th>Ship</th><th class="num">Owned</th><th class="num">Members</th></tr></thead><tbody id="rsi-fleet-models"></tbody></table>
      </section>
    </main>`;
}

function renderScript () {
  return CLIENT.tag();
}

/**
 * RSI claim page: get a g00n: code, put it in the RSI bio, verify. Also
 * shows the member fleet totals.
 */
function client () {
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
}

const CLIENT = clientScript('/scripts/rsi-claim.js', client, __filename);

module.exports = {
  id: 'rsi-page',
  client: CLIENT,
  API,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
