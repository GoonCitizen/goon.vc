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
      .login-session .goon-button { font-size: 0.8em; margin-top: 0.75em; padding: 0.35em 0.8em; }
      .login-accounts { list-style: none; margin: 1em 0 0; padding: 0; }
      .login-accounts li { align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.12); display: flex; gap: 0.5em; justify-content: space-between; padding: 0.4em 0; }
      .login-accounts small { color: #999; }
      .login-accounts .goon-button { margin-top: 0; }`;
}

/**
 * @param {Object} props
 * @param {string} props.title Trusted HTML.
 * @param {string} props.joinUrl
 */
function renderLoginHtml (props) {
  return `<main id="login-page" class="login-page">
      <h1>${props.title}</h1>
      <p class="login-intro">Sign in with Discord or Fabric Passport. Passport can also ask a GoonCitizen desktop app you linked to it to sign.</p>
      <div class="login-buttons">
        <button type="button" id="login-discord" class="goon-button">Discord</button>
        <button type="button" id="login-passport" class="goon-button">Passport</button>
      </div>
      <p id="login-status" class="login-status"></p>
      <div id="login-session" class="login-session"></div>
      <p><small>Not in the Squad yet? <a href="${escapeHtml(props.joinUrl)}">Join the Discord &raquo;</a></small></p>
    </main>`;
}

/**
 * The site-wide footer card, shown only on pages whose own footer has no
 * Login button (and never on the login page).
 * @param {Object} props
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 */
function renderFooterHtml (props) {
  return `<footer id="site-member-footer" class="site-member-footer" hidden>
      <div><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
    </footer>`;
}

/**
 * Runs on every page: hides Login CTAs when neither Passport nor Discord
 * login is available. On the login page, wires both: the members service
 * issues a Passport v2 challenge for its pinned origin (bound to this browser
 * by a cookie holding a binding secret), the page hands it to Passport with a
 * private `MessagePort`, and the assertion that comes back on that port is
 * redeemed by the members service. No Hub is involved. Signed in, the same
 * buttons link another account to the member instead, after a confirmation
 * naming that member, and the member's linked accounts are listed with Unlink.
 * Every page gets `window.goonPassport(linking, say)`, the Passport flow as a
 * promise, so profile pages can link a Passport identity in place,
 * `window.goonEscrowKey(say)` for the Market's "Link your escrow key" (a
 * challenge asking Passport for its cosigner key on the escrow network),
 * `window.goonConfirmLink(what)` for their other Link buttons, and
 * `window.goonMember(member)` to redraw the footer card after a rename.
 * @param {Object} props
 * @param {string} props.path SPA path for the login page.
 * @param {string} [props.waitingPath] Where members waiting for review are sent.
 * @param {string} [props.membersPath] Profiles are `<membersPath>/<id>`; signed in,
 *   the footer Login buttons become a card for the member linking there.
 */
function renderLoginScript (props) {
  return `<script type="text/javascript">
      (function () {
        var loginPath = ${JSON.stringify(props.path)};
        var waitingPath = ${JSON.stringify(props.waitingPath || '/waiting')};
        var membersPath = ${JSON.stringify(props.membersPath || '/members')};
        var path = (window.location.pathname || '/').replace(/\\/+$/, '') || '/';
        var onLoginPage = path === loginPath;

        var btnDiscord = document.getElementById('login-discord');
        var btnPassport = document.getElementById('login-passport');
        var status = document.getElementById('login-status');
        var sessionBox = document.getElementById('login-session');
        var passportAvailable = false;
        var discordAvailable = false;
        var busy = false;
        var signedIn = null;
        var waiting = null;

        function getJson (url, opts) {
          return window.fetch(url, Object.assign({ cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}))
            .then(function (res) {
              return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
            });
        }

        function postJson (url, body) {
          return getJson(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body || {})
          });
        }

        function render () {
          btnDiscord.textContent = signedIn ? 'Link Discord' : 'Discord';
          btnPassport.textContent = signedIn ? 'Link a Passport identity' : 'Passport';
          btnDiscord.disabled = busy || !discordAvailable;
          btnPassport.disabled = busy || !passportAvailable;
        }

        function setBusy (value) {
          busy = !!value;
          render();
        }

        var siteFooter = document.getElementById('site-member-footer');
        if (siteFooter) {
          var pages = Array.prototype.filter.call(document.querySelectorAll('main'), function (el) {
            return window.getComputedStyle(el).display !== 'none';
          });
          siteFooter.hidden = onLoginPage || pages.some(function (el) { return !!el.querySelector('.footer-login-button'); });
        }

        var footerLogins = Array.prototype.slice.call(document.querySelectorAll('a.footer-login-button[href="' + loginPath + '"]'));
        footerLogins.forEach(function (el) { el.setAttribute('data-login-label', el.textContent); });

        // Signed in, each footer Login button becomes a card for the member
        // that links to their profile.
        function markMember (member) {
          var profilePath = member ? membersPath + '/' + member.id : null;
          footerLogins.forEach(function (el) {
            el.textContent = '';
            el.classList.toggle('footer-member', !!member);
            if (!member) {
              el.href = loginPath;
              el.removeAttribute('title');
              el.removeAttribute('aria-current');
              el.textContent = el.getAttribute('data-login-label');
              return;
            }
            el.href = profilePath;
            el.title = 'Your profile';
            if (path.toLowerCase() === profilePath) el.setAttribute('aria-current', 'page');
            else el.removeAttribute('aria-current');
            if (member.avatarUrl) {
              var img = document.createElement('img');
              img.src = member.avatarUrl;
              img.alt = '';
              el.appendChild(img);
            }
            var text = document.createElement('span');
            var name = document.createElement('strong');
            name.textContent = member.displayName || 'Member';
            var small = document.createElement('small');
            small.textContent = 'YOUR PROFILE';
            text.appendChild(name);
            text.appendChild(small);
            el.appendChild(text);
          });
        }

        window.goonMember = markMember;

        var sessionCheck = getJson('/services/members/session').then(function (r) {
          return r.ok && r.j && r.j.member ? r.j.member : null;
        }).catch(function () { return null; });
        sessionCheck.then(markMember);

        var PASSPORT_ERRORS = {
          rejected: 'Sign-in was rejected in Passport.',
          timeout: 'Timed out waiting for approval. Unlock Passport and try again.',
          expired: 'The sign-in expired before it was approved. Try again.',
          busy: 'Passport is busy with other sign-ins. Finish those first.',
          replaced: 'Another sign-in on this page replaced this one.',
          challenge_replayed: 'Passport already answered that sign-in. Try again.',
          passport_unavailable: 'Passport is not ready. Unlock it and try again.',
          invalid_challenge: 'Passport could not read the sign-in request.',
          origin_mismatch: 'Passport saw a different address than this page.',
          passport_outdated: 'Update Fabric Passport, or the desktop app it asked, to sign in here.'
        };

        // Linking adds an account to whoever is signed in here, so say who.
        function confirmLink (what) {
          return sessionCheck.then(function (member) {
            var name = (signedIn && signedIn.displayName) || (member && member.displayName) || 'this profile';
            if (!window.confirm('Link ' + what + ' to ' + name + '? Anyone signed in as ' + name + ' will be able to use it.')) {
              throw new Error('Linking cancelled.');
            }
          });
        }
        window.goonConfirmLink = confirmLink;

        // Passport answers only on the MessagePort handed over with the
        // challenge, so nothing else on the page can read or forge it.
        function passportPort (challenge, expiresAt) {
          return new Promise(function (resolve) {
            var channel = new window.MessageChannel();
            var done = false;
            var wait = Math.min(210000, Math.max(5000, Number(expiresAt) - Date.now() || 0));
            var timer = setTimeout(function () { finish({ ok: false, error: 'timeout' }); }, wait);
            function finish (result) {
              if (done) return;
              done = true;
              clearTimeout(timer);
              try { channel.port1.close(); } catch (_) {}
              waiting = null;
              resolve(result);
            }
            waiting = { cancel: function () { finish({ ok: false, error: 'cancelled' }); } };
            channel.port1.onmessage = function (event) {
              var d = event && event.data;
              if (!d || typeof d !== 'object') return;
              if (d.ok === true && d.type === 'PASSPORT_ASSERTION' && typeof d.assertion === 'string') finish({ ok: true, assertion: d.assertion });
              else if (d.ok === false) finish({ ok: false, error: typeof d.error === 'string' && d.error ? d.error : 'rejected' });
            };
            window.postMessage({ source: 'fabric-site', type: 'PASSPORT_CHALLENGE', challenge: challenge }, window.location.origin, [channel.port2]);
          });
        }

        // Signs in with Passport, or links its identity to the signed-in
        // member. Resolves with the members service's answer.
        // The Passport protocol version that answered PASSPORT_HELLO; 1 when
        // only an older Passport's data-fabric-passport marker is on the page;
        // null when there is none.
        function detectPassport () {
          return new Promise(function (resolve) {
            if (typeof window.MessageChannel !== 'function') return resolve(null);
            var channel = new MessageChannel();
            var done = false;
            var timer = setTimeout(function () {
              finish(document.documentElement.hasAttribute('data-fabric-passport') ? 1 : null);
            }, 600);
            function finish (version) {
              if (done) return;
              done = true;
              clearTimeout(timer);
              try { channel.port1.close(); } catch (_) {}
              resolve(version);
            }
            channel.port1.onmessage = function (event) {
              var d = event && event.data;
              if (d && d.type === 'PASSPORT_HELLO' && typeof d.v === 'number') finish(d.v);
            };
            try {
              window.postMessage({ source: 'fabric-site', type: 'PASSPORT_HELLO', v: 2 }, window.location.origin, [channel.port2]);
            } catch (_) {
              finish(null);
            }
          });
        }

        function askPassport (linking, say, options) {
          say = say || function () {};
          var escrow = !!(options && options.escrow);
          if (escrow) linking = true;
          return detectPassport().then(function (version) {
            if (version === null) {
              return Promise.reject(new Error('Fabric Passport extension not detected. Install or enable it, then reload this page.'));
            }
            if (version !== 2) return Promise.reject(new Error('Update Fabric Passport to sign in here.'));
            if (typeof window.MessageChannel !== 'function') return Promise.reject(new Error('This browser cannot talk to Passport.'));
            if (waiting) return Promise.reject(new Error('Passport is already asking. Approve or reject that request first.'));
            return (linking ? confirmLink(escrow ? 'your Market escrow key' : 'a Passport identity') : Promise.resolve()).then(function () {
            say('Starting Passport sign-in…');
            return postJson('/services/members/passport/challenges', escrow ? { escrow: true } : undefined);
          }).then(function (r) {
            if (!r.ok || !r.j || typeof r.j.challenge !== 'string') {
              throw new Error('Could not start sign-in: ' + ((r.j && r.j.error) || r.status));
            }
            say(escrow ? 'Open Passport and approve sharing your escrow key…' : 'Open Passport and approve the sign-in…');
            return passportPort(r.j.challenge, r.j.expiresAt);
          }).then(function (d) {
            if (!d.ok) throw new Error(PASSPORT_ERRORS[d.error] || ('Passport: ' + d.error));
            say(linking ? 'Linking…' : 'Signing in…');
            return postJson('/services/members/passport', { assertion: d.assertion, link: linking });
          }).then(function (r) {
            if (!r.ok) throw new Error((linking ? 'Linking failed: ' : 'Sign-in failed: ') + ((r.j && r.j.error) || r.status));
            if (escrow && !r.j.escrowKey) throw new Error('Passport did not share an escrow key. Try again and allow it.');
            return r.j;
          });
          });
        }
        window.goonPassport = askPassport;
        window.goonEscrowKey = function (say) { return askPassport(true, say, { escrow: true }); };

        getJson('/services/members').then(function (r) {
          discordAvailable = !!(r.ok && r.j && r.j.discord);
          passportAvailable = !!(r.ok && r.j && r.j.passport);
        }).catch(function () {}).then(function () {
          if (!passportAvailable && !discordAvailable) {
            document.querySelectorAll('a.footer-login-button[href="' + loginPath + '"], .site-nav a[href="' + loginPath + '"]').forEach(function (el) {
              (el.closest('.site-nav-item') || el).style.display = 'none';
            });
          }
          if (!onLoginPage) return;
          btnDiscord.title = discordAvailable ? '' : 'Discord login is not configured on this server.';
          btnPassport.title = passportAvailable ? '' : 'Passport login is not available on this server.';
          if (!passportAvailable && !discordAvailable && !status.textContent) {
            status.textContent = 'Login is unavailable on this server.';
          }
          render();
        });

        if (!onLoginPage) return;
        render();

        var ERRORS = {
          access_denied: 'Discord sign-in was cancelled.',
          expired_state: 'That sign-in link expired. Try again.',
          invalid_request: 'Discord returned an invalid response. Try again.',
          discord_failed: 'Could not complete Discord sign-in. Try again.',
          discord_unavailable: 'Discord could not be reached. Try again in a minute.',
          not_signed_in: 'Sign in first, then link another account.',
          link_failed: 'That link was started from a different sign-in. Try again.',
          one_time_link: 'You signed in with a one-time link. Sign in with Discord or Passport first, then link another account.',
          one_discord: 'Your profile already has a Discord account. A profile holds one: unlink it first to link a different one.'
        };
        var PLATFORMS = { discord: 'Discord', fabric: 'Fabric', rsi: 'RSI' };

        function linkedMessage (what, merged) {
          return (what === 'discord' ? 'Discord account' : 'Fabric identity') + ' linked.' +
            (merged ? ' It had its own profile, so the two are now one.' : '');
        }

        function showAccounts (list, accounts) {
          list.textContent = '';
          accounts.forEach(function (account) {
            var li = document.createElement('li');
            var label = document.createElement('span');
            label.textContent = account.label + ' ';
            var small = document.createElement('small');
            small.textContent = (PLATFORMS[account.platform] || account.platform) + (account.via === 'cluster' ? ' · linked device' : '');
            label.appendChild(small);
            li.appendChild(label);
            var unlink = document.createElement('button');
            unlink.type = 'button';
            unlink.className = 'goon-button';
            unlink.textContent = 'Unlink';
            unlink.disabled = accounts.length < 2;
            unlink.title = accounts.length < 2 ? 'Your only account stays linked.' : '';
            unlink.addEventListener('click', function () {
              if (!window.confirm('Unlink ' + account.label + ' from your profile?')) return;
              getJson('/services/members/accounts/' + encodeURIComponent(account.key), { method: 'DELETE' }).then(function (r) {
                if (!r.ok) {
                  status.textContent = (r.j && r.j.error) || 'Could not unlink that account.';
                  return;
                }
                status.textContent = account.label + ' unlinked.';
                showAccounts(list, r.j.accounts || []);
              });
            });
            li.appendChild(unlink);
            list.appendChild(li);
          });
        }

        function showMember (member) {
          sessionBox.textContent = '';
          signedIn = member || null;
          markMember(signedIn);
          render();
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
          line.appendChild(document.createTextNode(' via ' + (member.provider === 'discord' ? 'Discord' : member.provider === 'rsi-link' ? 'a Discord link' : 'Fabric')));
          sessionBox.appendChild(line);
          var profileLine = document.createElement('p');
          var profileLink = document.createElement('a');
          profileLink.href = membersPath + '/' + member.id;
          profileLink.textContent = 'View your profile »';
          profileLine.appendChild(profileLink);
          sessionBox.appendChild(profileLine);
          if (member.review && member.review.status !== 'approved') {
            var reviewLine = document.createElement('p');
            var reviewLink = document.createElement('a');
            reviewLink.href = waitingPath;
            reviewLink.textContent = member.review.status === 'pending'
              ? 'Your sign-in is waiting for review »'
              : 'Your sign-in was not approved »';
            reviewLine.appendChild(reviewLink);
            sessionBox.appendChild(reviewLine);
          }
          var accounts = document.createElement('ul');
          accounts.className = 'login-accounts';
          accounts.setAttribute('aria-label', 'Linked accounts');
          sessionBox.appendChild(accounts);
          getJson('/services/members/accounts').then(function (r) {
            if (r.ok && r.j && r.j.accounts) showAccounts(accounts, r.j.accounts);
          }).catch(function () {});
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
        else if (params.get('linked')) status.textContent = linkedMessage(params.get('linked'), params.get('merged'));
        else if (params.get('signedIn')) status.textContent = 'Welcome back.';
        if (params.get('error') || params.get('signedIn') || params.get('linked')) {
          window.history.replaceState(null, '', loginPath);
        }

        sessionCheck.then(function (member) {
          if (member) showMember(member);
        });

        btnDiscord.addEventListener('click', function () {
          var linking = !!signedIn;
          setBusy(true);
          (linking ? confirmLink('a Discord account') : Promise.resolve()).then(function () {
            status.textContent = 'Redirecting to Discord…';
            window.location.href = '/services/members/discord' + (linking ? '?link=1' : '');
          }).catch(function (error) {
            setBusy(false);
            status.textContent = error.message;
          });
        });

        btnPassport.addEventListener('click', function () {
          var linking = !!signedIn;
          setBusy(true);
          askPassport(linking, function (text) { status.textContent = text; }).then(function (j) {
            setBusy(false);
            status.textContent = j.linked ? linkedMessage(j.linked, j.merged) : 'Signed in.';
            showMember(j.member);
          }).catch(function (error) {
            setBusy(false);
            status.textContent = error.message;
          });
        });
      })();
    </script>`;
}

module.exports = {
  id: 'login-page',
  styles: renderLoginCss,
  render: renderLoginHtml,
  footer: renderFooterHtml,
  script: renderLoginScript
};
