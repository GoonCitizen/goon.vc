'use strict';

// Waiting area (components/WaitingPage.js): shows where the signed-in
// member's review stands, and checks again every minute while they wait.
(function () {
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
})();
