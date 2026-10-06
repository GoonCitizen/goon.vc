'use strict';

const escapeHtml = require('../functions/escapeHtml');

function renderLoginCss () {
  return `
      .login-page { display: none; margin: 3em auto; max-width: 30em; padding: 0 1em; }
      .login-intro { color: #bbb; line-height: 1.45; }
      .login-buttons { display: flex; flex-direction: column; gap: 0.75em; margin: 2em auto; max-width: 22em; }
      .login-status { min-height: 1.2em; overflow-wrap: anywhere; }
      .login-session {
        border: 1px solid rgba(255, 255, 255, 0.25);
        border-radius: 8px;
        display: none;
        margin: 1.5em auto;
        max-width: 22em;
        overflow-wrap: anywhere;
        padding: 1em;
      }
      .login-session img { border-radius: 50%; height: 48px; width: 48px; }
      .login-session .goon-button { font-size: 0.8em; margin-top: 0.75em; padding: 0.35em 0.8em; }`;
}

/**
 * @param {Object} props
 * @param {string} props.title Trusted HTML.
 * @param {string} props.joinUrl
 */
function renderLoginHtml (props) {
  return `<main id="login-page" class="login-page">
      <h1>${props.title}</h1>
      <p class="login-intro">Sign in with Discord, Fabric Passport, or the GoonCitizen desktop app.</p>
      <div class="login-buttons">
        <button type="button" id="login-discord" class="goon-button">Discord</button>
        <button type="button" id="login-passport" class="goon-button">Passport</button>
        <button type="button" id="login-desktop" class="goon-button">GoonCitizen desktop</button>
      </div>
      <p id="login-status" class="login-status"></p>
      <div id="login-session" class="login-session"></div>
      <p><small>Not in the Squad yet? <a href="${escapeHtml(props.joinUrl)}">Join the Discord &raquo;</a></small></p>
    </main>`;
}

/**
 * Runs on every page: hides Login CTAs when neither the Hub proxy nor Discord
 * login is available. On the login page, wires the three sign-in methods;
 * Passport and desktop both sign a Hub session (same-origin `/sessions` proxy)
 * that the members service redeems at `/services/members/passport`.
 * @param {Object} props
 * @param {string} props.path SPA path for the login page.
 */
function renderLoginScript (props) {
  return `<script type="text/javascript">
      (function () {
        var loginPath = ${JSON.stringify(props.path)};
        var path = (window.location.pathname || '/').replace(/\\/+$/, '') || '/';
        var onLoginPage = path === loginPath;

        var btnDiscord = document.getElementById('login-discord');
        var btnPassport = document.getElementById('login-passport');
        var btnDesktop = document.getElementById('login-desktop');
        var status = document.getElementById('login-status');
        var sessionBox = document.getElementById('login-session');
        var hubAvailable = false;
        var discordAvailable = false;
        var busy = false;
        var pollTimer = null;

        function getJson (url, opts) {
          return window.fetch(url, Object.assign({ cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}))
            .then(function (res) {
              return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
            });
        }

        function render () {
          btnDiscord.disabled = busy || !discordAvailable;
          btnPassport.disabled = busy || !hubAvailable;
          btnDesktop.disabled = busy || !hubAvailable;
        }

        function setBusy (value) {
          busy = !!value;
          render();
        }

        var hubProbe = window.fetch('/services/rpc', {
          method: 'OPTIONS',
          headers: { Accept: 'application/json' },
          cache: 'no-store'
        }).then(function (res) {
          if (res.status >= 502) return false;
          return res.text().then(function (t) {
            try {
              var j = t ? JSON.parse(t) : null;
              return !(j && (j.error === 'hub-unreachable' || j.error === 'Hub unreachable'));
            } catch (e) { return true; }
          });
        }).catch(function () { return false; });
        var membersProbe = getJson('/services/members')
          .then(function (r) { return !!(r.ok && r.j && r.j.discord); })
          .catch(function () { return false; });

        Promise.all([hubProbe, membersProbe]).then(function (results) {
          hubAvailable = results[0];
          discordAvailable = results[1];
          if (!hubAvailable && !discordAvailable) {
            document.querySelectorAll('a.footer-login-button[href="' + loginPath + '"], .site-nav a[href="' + loginPath + '"]').forEach(function (el) {
              (el.closest('.site-nav-item') || el).style.display = 'none';
            });
          }
          if (!onLoginPage) return;
          btnDiscord.title = discordAvailable ? '' : 'Discord login is not configured on this server.';
          btnPassport.title = btnDesktop.title = hubAvailable ? '' : 'The Fabric Hub is unreachable.';
          if (!hubAvailable && !status.textContent) {
            status.textContent = discordAvailable
              ? 'Passport and desktop sign-in are unavailable: the Fabric Hub is unreachable.'
              : 'Login unavailable: the Fabric Hub is unreachable and Discord login is not configured.';
          }
          render();
        });

        if (!onLoginPage) return;
        render();

        var ERRORS = {
          access_denied: 'Discord sign-in was cancelled.',
          expired_state: 'That sign-in link expired. Try again.',
          invalid_request: 'Discord returned an invalid response. Try again.',
          discord_failed: 'Could not complete Discord sign-in. Try again.'
        };

        function showMember (member) {
          sessionBox.textContent = '';
          if (!member) {
            sessionBox.style.display = 'none';
            return;
          }
          if (member.avatarUrl) {
            var img = document.createElement('img');
            img.src = member.avatarUrl;
            img.alt = '';
            sessionBox.appendChild(img);
          }
          var line = document.createElement('div');
          var strong = document.createElement('strong');
          strong.textContent = member.displayName || member.id;
          line.appendChild(document.createTextNode('Signed in as '));
          line.appendChild(strong);
          line.appendChild(document.createTextNode(' via ' + (member.provider === 'discord' ? 'Discord' : 'Fabric')));
          sessionBox.appendChild(line);
          var out = document.createElement('button');
          out.type = 'button';
          out.className = 'goon-button';
          out.textContent = 'Log out';
          out.addEventListener('click', function () {
            getJson('/services/members/logout', { method: 'POST' }).then(function () {
              showMember(null);
              status.textContent = 'Signed out.';
            });
          });
          sessionBox.appendChild(out);
          sessionBox.style.display = 'block';
        }

        var params = new URLSearchParams(window.location.search);
        if (params.get('error')) status.textContent = ERRORS[params.get('error')] || 'Sign-in failed.';
        else if (params.get('signedIn')) status.textContent = 'Welcome back.';
        if (params.get('error') || params.get('signedIn')) {
          window.history.replaceState(null, '', loginPath);
        }

        getJson('/services/members/session').then(function (r) {
          if (r.ok && r.j && r.j.member) showMember(r.j.member);
        }).catch(function () {});

        btnDiscord.addEventListener('click', function () {
          setBusy(true);
          status.textContent = 'Redirecting to Discord…';
          window.location.href = '/services/members/discord';
        });

        // The Hub releases a signed session exactly once, so only the members service may redeem it.
        function pollClaim (sessionId, pollSecret) {
          var tries = 0;
          var inFlight = false;
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = setInterval(function () {
            if (inFlight) return;
            tries += 1;
            if (tries > 90) {
              clearInterval(pollTimer);
              status.textContent = 'Timed out waiting for approval. Unlock your wallet and try again.';
              setBusy(false);
              return;
            }
            inFlight = true;
            getJson('/services/members/passport', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
              body: JSON.stringify({ sessionId: sessionId, pollSecret: pollSecret || null })
            }).then(function (r) {
              inFlight = false;
              if (r.status === 202) return;
              clearInterval(pollTimer);
              setBusy(false);
              if (!r.ok) {
                status.textContent = 'Sign-in failed: ' + ((r.j && r.j.error) || r.status);
                return;
              }
              status.textContent = 'Signed in.';
              showMember(r.j.member);
            }).catch(function () { inFlight = false; });
          }, 1500);
        }

        function startSession (startLabel, onCreated) {
          setBusy(true);
          status.textContent = startLabel;
          getJson('/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ origin: window.location.origin })
          }).then(function (r) {
            if (!r.ok || !r.j || !r.j.ok) {
              status.textContent = r.status >= 502
                ? 'Sign-in is unavailable: the Fabric Hub is unreachable' + (r.j && r.j.detail ? ' (' + r.j.detail + ')' : '') + '.'
                : 'Could not start sign-in: ' + ((r.j && r.j.error) || r.status);
              setBusy(false);
              return;
            }
            onCreated(r.j);
            pollClaim(r.j.sessionId, r.j.pollSecret);
          }).catch(function (error) {
            status.textContent = 'Could not start sign-in: ' + error.message;
            setBusy(false);
          });
        }

        var PASSPORT_ERRORS = {
          hub_not_allowed: 'Passport does not trust this site’s Hub.',
          origin_mismatch: 'Passport rejected the request (origin mismatch).',
          passport_rejected: 'Sign-in was rejected in Passport.'
        };

        window.addEventListener('message', function (event) {
          if (event.origin !== window.location.origin) return;
          var d = event.data;
          if (!d || d.source !== 'fabric-passport' || d.type !== 'FABRIC_SITE_LOGIN_RESULT' || d.ok) return;
          if (pollTimer) clearInterval(pollTimer);
          status.textContent = PASSPORT_ERRORS[d.error] || ('Passport: ' + (d.error || 'rejected'));
          setBusy(false);
        });

        btnPassport.addEventListener('click', function () {
          if (!document.documentElement.hasAttribute('data-fabric-passport')) {
            status.textContent = 'Fabric Passport extension not detected. Install or enable it, then reload this page.';
            return;
          }
          startSession('Starting Passport sign-in…', function (session) {
            window.postMessage({
              source: 'fabric-site',
              type: 'FABRIC_SITE_LOGIN_REQUEST',
              sessionId: session.sessionId,
              hub: window.location.origin,
              origin: window.location.origin,
              message: session.message
            }, window.location.origin);
            status.textContent = 'Open Passport and approve the sign-in…';
          });
        });

        btnDesktop.addEventListener('click', function () {
          startSession('Starting desktop sign-in…', function (session) {
            var a = document.createElement('a');
            a.href = session.protocolUrl ||
              ('fabric://login?sessionId=' + encodeURIComponent(session.sessionId) +
                '&hub=' + encodeURIComponent(window.location.origin));
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            status.textContent = 'Approve the request in GoonCitizen (or your Fabric desktop app)…';
          });
        });
      })();
    </script>`;
}

module.exports = {
  id: 'login-page',
  styles: renderLoginCss,
  render: renderLoginHtml,
  script: renderLoginScript
};
