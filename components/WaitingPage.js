'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');


function renderStyles () {
  return `
      .waiting-page { display: none; margin: 3em auto; max-width: 34em; padding: 0 1em; text-align: left; }
      .waiting-page h1 { text-align: center; }
      .waiting-page [hidden] { display: none !important; }
      .waiting-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; line-height: 1.45; margin: 1.5em 0; padding: 1em; }
      .waiting-page h2 { font-size: 1.2em; margin-top: 0; }
      .waiting-page .waiting-since { color: #999; }
      .waiting-status { min-height: 1.2em; overflow-wrap: anywhere; text-align: center; }
      .waiting-links { display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; margin-top: 1em; }`;
}

/**
 * The waiting area: members who signed in with Discord since reviews began
 * wait here until an alliance administrator approves them (services/reviews.js).
 * One section per review status, picked from `GET /services/members/session`.
 * @param {Object} props
 * @param {string} props.path
 * @param {string} props.loginPath
 * @param {string} props.joinUrl
 * @param {string} props.eventsPath
 * @param {string} props.squadronsPath
 * @param {string} props.rsiClaimPath
 * @returns {string}
 */
function renderHtml (props) {
  const join = `<a href="${escapeHtml(props.joinUrl)}">Join the G00N SQUAD Discord &raquo;</a>`;
  return `<main id="waiting-page" class="waiting-page" data-path="${escapeHtml(props.path)}">
      <h1>Waiting area</h1>
      <p id="waiting-status" class="waiting-status" role="status"></p>
      <section id="waiting-signed-out" hidden>
        <p>New members sign in with Discord. Officers on record wait here while an administrator approves them. Everyone else can claim an RSI handle without waiting.</p>
        <p class="waiting-links"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign in</a></p>
      </section>
      <section id="waiting-pending" hidden>
        <h2>You’re in line</h2>
        <p>Thanks for signing in<span id="waiting-name"></span>. An administrator reviews officer sign-ins. There’s nothing else to do: come back to this page to see the result.</p>
        <p class="waiting-since" id="waiting-since"></p>
        <p id="waiting-join" hidden>You’re not in our Discord yet; joining it helps. ${join}</p>
        <p class="waiting-links"><a href="${escapeHtml(props.eventsPath)}">Events</a> <a href="${escapeHtml(props.squadronsPath)}">PERMAFLEET squadrons</a></p>
      </section>
      <section id="waiting-approved" hidden>
        <h2>You’re approved</h2>
        <p>Welcome to G00N SQUAD. You can claim your Star Citizen handle next.</p>
        <p class="waiting-links"><a class="goon-button" href="${escapeHtml(props.rsiClaimPath)}">Claim your RSI profile</a> <a href="${escapeHtml(props.eventsPath)}">Events</a> <a href="/">Home</a></p>
      </section>
      <section id="waiting-denied" hidden>
        <h2>Not approved</h2>
        <p>An alliance administrator didn’t approve this sign-in. If you think that’s a mistake, ask in the G00N SQUAD Discord.</p>
        <p class="waiting-links">${join}</p>
      </section>
      <section id="waiting-none" hidden>
        <h2>Nothing to wait for yet</h2>
        <p>The waiting area is for Discord sign-ins. Link your Discord account on the login page to join it.</p>
        <p class="waiting-links"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Link Discord</a></p>
      </section>
      <section id="waiting-off" hidden>
        <h2>No waiting area right now</h2>
        <p>Sign-ins aren’t being reviewed, so you’re all set.</p>
        <p class="waiting-links"><a href="/">Home</a></p>
      </section>
    </main>`;
}

function renderScript () {
  return CLIENT.tag();
}

/**
 * Waiting area: shows where the signed-in member's review stands, and checks
 * again every minute while they wait.
 */
function client () {
  var root = document.getElementById('waiting-page');
  if (!root) return;
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  if (path.toLowerCase() !== String(root.getAttribute('data-path')).toLowerCase()) return;

  var POLL_MS = 60 * 1000;
  var status = document.getElementById('waiting-status');
  var sections = ['signed-out', 'pending', 'approved', 'denied', 'none', 'off'];
  var reviewsOn = true;
  var timer = null;

  if (new URLSearchParams(window.location.search).get('signedIn')) {
    status.textContent = 'Signed in with Discord.';
    window.history.replaceState(null, '', root.getAttribute('data-path'));
  }

  function call (url) {
    return window.fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
      });
  }

  function show (name) {
    sections.forEach(function (section) {
      document.getElementById('waiting-' + section).hidden = section !== name;
    });
  }

  function render (member) {
    if (!member) return show('signed-out');
    var review = member.review || null;
    if (!reviewsOn) return show('off');
    if (!review) return show('none');
    if (review.status === 'pending') {
      document.getElementById('waiting-name').textContent = member.displayName ? ', ' + member.displayName : '';
      var since = review.requestedAt ? new Date(review.requestedAt) : null;
      document.getElementById('waiting-since').textContent = since && !isNaN(since) ? 'Waiting since ' + since.toLocaleString() + '.' : '';
      document.getElementById('waiting-join').hidden = member.inGuild === true;
    }
    show(review.status === 'pending' || review.status === 'approved' || review.status === 'denied' ? review.status : 'none');
  }

  function refresh () {
    return call('/services/members/session').then(function (r) {
      if (r.status === 401) return render(null);
      if (!r.ok || !r.j || !r.j.member) {
        status.textContent = 'Could not check your sign-in. Reload to try again.';
        return;
      }
      render(r.j.member);
      var waiting = !!(r.j.member.review && r.j.member.review.status === 'pending');
      if (waiting && !timer) {
        timer = setInterval(function () {
          if (!document.hidden) refresh();
        }, POLL_MS);
      } else if (!waiting && timer) {
        clearInterval(timer);
        timer = null;
      }
    }).catch(function () {
      status.textContent = 'Could not check your sign-in. Reload to try again.';
    });
  }

  call('/services/members').then(function (r) {
    reviewsOn = !(r.ok && r.j && r.j.review === false);
  }).catch(function () {}).then(refresh);
}

const CLIENT = clientScript('/scripts/waiting.js', client, __filename);

module.exports = {
  id: 'waiting-page',
  client: CLIENT,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
