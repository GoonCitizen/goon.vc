'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');


function renderStyles () {
  return `
      .members-page, .member-page { display: none; margin: 3em auto; max-width: 34em; padding: 0 1em; text-align: left; }
      .members-page h1, .member-page h1 { text-align: center; }
      .members-page [hidden], .member-page [hidden] { display: none !important; }
      .members-page section, .member-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; line-height: 1.45; margin: 1.5em 0; padding: 1em; }
      .members-page h2, .member-page h2 { font-size: 1.2em; margin-top: 0; }
      .members-status { min-height: 1.2em; overflow-wrap: anywhere; text-align: center; }
      .members-note { color: #999; text-align: center; }
      .members-list { display: flex; flex-direction: column; gap: 0.75em; list-style: none; margin: 0; padding: 0; }
      .members-card { align-items: center; border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; display: flex; gap: 0.75em; padding: 0.75em 1em; text-decoration: none; }
      .members-card:hover { background: rgba(255, 255, 255, 0.06); }
      .members-card img, .member-head img { border-radius: 50%; height: 48px; width: 48px; }
      .members-card small, .member-head small { color: #999; display: block; }
      .member-head { align-items: center; display: flex; flex-direction: column; gap: 0.4em; text-align: center; }
      .member-head h1 { margin: 0; }
      .member-head img { height: 96px; width: 96px; }
      .member-accounts { list-style: none; margin: 0; padding: 0; }
      .member-accounts li { align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.12); display: flex; gap: 0.5em; justify-content: space-between; padding: 0.4em 0; }
      .member-accounts small { color: #999; display: block; }
      .member-accounts .goon-button { font-size: 0.8em; margin: 0; padding: 0.35em 0.8em; }
      .member-rename-form { align-items: center; display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; }
      .member-rename-form select { background: #111; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 4px; color: #fff; font: inherit; max-width: 100%; padding: 0.45em 0.6em; }
      .member-rename-form .goon-button { margin: 0; }
      .members-links { display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; margin-top: 1em; }`;
}

/**
 * `/members` and `/members/<id>`. The directory isn't open yet: the index
 * lists only the signed-in member, and a profile shows only to its own
 * member (`GET /services/members/directory`, `…/profiles/<id>`). On their
 * profile a member links more accounts (Discord, Passport, RSI) and unlinks
 * them; a profile holds one Discord account. Its display name is picked from
 * the names those accounts carry (`nameChoices`; RSI handle or citizen name,
 * Discord display name or username) with `PATCH …/profiles/<id>`.
 * @param {Object} props
 * @param {string} props.path Directory path; profiles are `<path>/<id>`.
 * @param {string} props.loginPath
 * @param {string} props.waitingPath
 * @param {string} props.rsiClaimPath
 * @returns {string}
 */
function renderHtml (props) {
  const signIn = `<p class="members-links"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign in</a></p>`;
  return `<main id="members-page" class="members-page" data-path="${escapeHtml(props.path)}">
      <h1>Members</h1>
      <p id="members-status" class="members-status" role="status"></p>
      <section id="members-signed-out" hidden>
        <p>Sign in to see your member profile.</p>
        ${signIn}
      </section>
      <ul id="members-list" class="members-list" aria-label="Members" hidden></ul>
      <p id="members-note" class="members-note" hidden><small>The member directory isn’t open yet. For now, this page shows only you.</small></p>
    </main>
    <main id="member-page" class="member-page" data-base="${escapeHtml(props.path)}" data-waiting="${escapeHtml(props.waitingPath)}">
      <p id="member-status" class="members-status" role="status"></p>
      <section id="member-signed-out" hidden>
        <h2>Member profile</h2>
        <p>Sign in to see your own profile.</p>
        ${signIn}
      </section>
      <section id="member-private" hidden>
        <h2>Member profile</h2>
        <p>Member profiles are private until the member directory opens. You can see your own.</p>
        <p class="members-links"><a class="goon-button" id="member-own-link" href="${escapeHtml(props.path)}">Your profile</a></p>
      </section>
      <div id="member-profile" hidden>
        <div class="member-head">
          <img id="member-avatar" alt="" hidden>
          <h1 id="member-name"></h1>
          <small id="member-since"></small>
        </div>
        <p id="member-review" class="members-note" hidden><a href="${escapeHtml(props.waitingPath)}"></a></p>
        <section id="member-rename">
          <h2>Display name</h2>
          <p>The name the Squad sees on goon.vc. Pick one from your RSI profile or your Discord account.</p>
          <p id="member-rename-form" class="member-rename-form">
            <select id="member-rename-choice" aria-label="Display name"></select>
            <button type="button" id="member-rename-save" class="goon-button" disabled>Save</button>
          </p>
          <p id="member-rename-none" hidden>Link your Discord account or <a href="${escapeHtml(props.rsiClaimPath)}">claim your RSI handle</a> to choose a display name.</p>
          <p id="member-rename-status" class="members-status" role="status"></p>
        </section>
        <section>
          <h2>Linked accounts</h2>
          <ul id="member-accounts" class="member-accounts"></ul>
          <p id="member-rsi-none" hidden>No RSI handle yet. <a href="${escapeHtml(props.rsiClaimPath)}">Claim your RSI profile »</a></p>
        </section>
        <section id="member-add">
          <h2>Add an account</h2>
          <p>Sign in to each account you own to add it here, so the Squad sees one of you wherever you play. A profile holds one Discord account.</p>
          <p id="member-add-status" class="members-status" role="status"></p>
          <p class="members-links">
            <button type="button" id="member-add-discord" class="goon-button" disabled>Link Discord</button>
            <button type="button" id="member-add-passport" class="goon-button" disabled>Link a Passport identity</button>
            <a class="goon-button" href="${escapeHtml(props.rsiClaimPath)}">Claim an RSI handle</a>
          </p>
          <p id="member-discord-held" class="members-note" hidden><small></small></p>
        </section>
        <p class="members-links">
          <a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign-in page</a>
          <a class="goon-button" href="${escapeHtml(props.rsiClaimPath)}">RSI profile and hangar</a>
        </p>
        <p class="members-note"><small>Only you can see this page.</small></p>
      </div>
    </main>`;
}

function renderScript () {
  return CLIENT.tag();
}

/**
 * Members: the directory at /members (only the signed-in member until it
 * opens) and profiles at /members/<id> (only your own).
 */
function client () {
  var list = document.getElementById('members-page');
  var profile = document.getElementById('member-page');
  if (!list || !profile) return;
  var base = String(list.getAttribute('data-path'));
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  var onDirectory = path.toLowerCase() === base.toLowerCase();
  var profileMatch = path.toLowerCase().indexOf(base.toLowerCase() + '/') === 0
    ? /^[0-9a-f]{16}$/i.exec(path.slice(base.length + 1))
    : null;
  if (!onDirectory && !profileMatch) return;

  var PLATFORMS = { discord: 'Discord', fabric: 'Fabric', rsi: 'RSI' };

  function call (url, opts) {
    return window.fetch(url, Object.assign({ cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } }, opts || {}))
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
      });
  }

  function since (iso) {
    var date = iso ? new Date(iso) : null;
    return date && !isNaN(date) ? date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  }

  function avatar (url, size) {
    var img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.width = size;
    img.height = size;
    return img;
  }

  function showDirectory () {
    var status = document.getElementById('members-status');
    var ul = document.getElementById('members-list');
    call('/services/members/directory').then(function (r) {
      if (r.status === 401) {
        document.getElementById('members-signed-out').hidden = false;
        return;
      }
      if (!r.ok || !r.j || !Array.isArray(r.j.members)) {
        status.textContent = 'Could not load members. Reload to try again.';
        return;
      }
      ul.textContent = '';
      r.j.members.forEach(function (member) {
        var li = document.createElement('li');
        var a = document.createElement('a');
        a.className = 'members-card';
        a.href = member.path;
        if (member.avatarUrl) a.appendChild(avatar(member.avatarUrl, 48));
        var text = document.createElement('span');
        var strong = document.createElement('strong');
        strong.textContent = member.displayName || 'Member ' + member.id;
        text.appendChild(strong);
        var small = document.createElement('small');
        small.textContent = 'You · ' + member.platforms.map(function (p) { return PLATFORMS[p] || p; }).join(', ') +
          (member.createdAt ? ' · member since ' + since(member.createdAt) : '');
        text.appendChild(small);
        a.appendChild(text);
        li.appendChild(a);
        ul.appendChild(li);
      });
      ul.hidden = false;
      document.getElementById('members-note').hidden = r.j.directory !== false;
    }).catch(function () {
      status.textContent = 'Could not load members. Reload to try again.';
    });
  }

  function renderProfile (member) {
    document.getElementById('member-name').textContent = member.displayName || 'Member ' + member.id;
    document.title = (member.displayName || 'Member profile') + ' — GOON SQUAD';
    if (member.avatarUrl) {
      var img = document.getElementById('member-avatar');
      img.src = member.avatarUrl;
      img.hidden = false;
    }
    document.getElementById('member-since').textContent = member.createdAt ? 'Member since ' + since(member.createdAt) : '';
    var review = member.review;
    if (review && review.status !== 'approved') {
      var line = document.getElementById('member-review');
      line.querySelector('a').textContent = review.status === 'pending'
        ? 'Your sign-in is waiting for review »'
        : 'Your sign-in was not approved »';
      line.hidden = false;
    }
    var ul = document.getElementById('member-accounts');
    ul.textContent = '';
    member.accounts.forEach(function (account) {
      var li = document.createElement('li');
      var text = document.createElement('span');
      var label = document.createElement(account.url ? 'a' : 'span');
      if (account.url) {
        label.href = account.url;
        label.target = '_blank';
        label.rel = 'noopener noreferrer';
      }
      label.textContent = account.label + (account.name && account.name !== account.label ? ' (' + account.name + ')' : '');
      text.appendChild(label);
      var small = document.createElement('small');
      small.textContent = (PLATFORMS[account.platform] || account.platform) +
        (account.via === 'cluster' ? ' · linked device' : '') +
        (account.linkedAt ? ' · linked ' + since(account.linkedAt) : '');
      text.appendChild(small);
      li.appendChild(text);
      if (account.key) li.appendChild(unlinkButton(account, member.accounts.length));
      ul.appendChild(li);
    });
    document.getElementById('member-rsi-none').hidden = member.rsiHandles.length > 0;
    showRename(member);
    showAdd(member);
    document.getElementById('member-profile').hidden = false;
  }

  function say (text) {
    document.getElementById('member-add-status').textContent = text || '';
  }

  var currentName = null;

  // The names this member's accounts carry; a name from elsewhere (a server
  // nickname, say) stays listed as current until they pick another.
  function showRename (member) {
    var choices = member.nameChoices || [];
    var select = document.getElementById('member-rename-choice');
    currentName = member.displayName || null;
    select.textContent = '';
    if (currentName && !choices.some(function (choice) { return choice.name === currentName; })) {
      var kept = document.createElement('option');
      kept.value = currentName;
      kept.textContent = currentName + ' (current)';
      select.appendChild(kept);
    }
    choices.forEach(function (choice) {
      var option = document.createElement('option');
      option.value = choice.name;
      option.textContent = choice.name + ' · ' + choice.label;
      select.appendChild(option);
    });
    if (currentName) select.value = currentName;
    document.getElementById('member-rename-form').hidden = choices.length === 0;
    document.getElementById('member-rename-none').hidden = choices.length > 0;
    document.getElementById('member-rename-save').disabled = select.value === currentName;
  }

  function wireRename () {
    var select = document.getElementById('member-rename-choice');
    var save = document.getElementById('member-rename-save');
    var status = document.getElementById('member-rename-status');
    select.addEventListener('change', function () {
      save.disabled = select.value === currentName;
      status.textContent = '';
    });
    save.addEventListener('click', function () {
      var name = select.value;
      save.disabled = true;
      status.textContent = 'Saving…';
      call('/services/members/profiles/' + encodeURIComponent(profileId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ displayName: name })
      }).then(function (r) {
        if (!r.ok || !r.j || !r.j.member) {
          save.disabled = false;
          status.textContent = (r.j && r.j.error) || 'Could not change your display name. Try again.';
          return;
        }
        status.textContent = 'You now go by ' + r.j.member.displayName + '.';
        renderProfile(r.j.member);
        if (typeof window.goonMember === 'function') window.goonMember(r.j.member);
      }).catch(function () {
        save.disabled = false;
        status.textContent = 'Could not change your display name. Try again.';
      });
    });
  }

  function unlinkButton (account, total) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'goon-button';
    button.textContent = 'Unlink';
    button.disabled = total < 2;
    button.title = total < 2 ? 'Your only account stays linked. Add another first.' : '';
    button.addEventListener('click', function () {
      if (!window.confirm('Unlink ' + account.label + ' from your profile?')) return;
      button.disabled = true;
      call('/services/members/accounts/' + encodeURIComponent(account.key), { method: 'DELETE' }).then(function (r) {
        if (!r.ok) {
          button.disabled = false;
          say((r.j && r.j.error) || 'Could not unlink that account.');
          return;
        }
        say(account.label + ' unlinked.');
        reload();
      }).catch(function () {
        button.disabled = false;
        say('Could not unlink that account. Try again.');
      });
    });
    return button;
  }

  var available = call('/services/members').then(function (r) {
    return { discord: !!(r.ok && r.j && r.j.discord), passport: !!(r.ok && r.j && r.j.passport) };
  }).catch(function () { return { discord: false, passport: false }; });

  function showAdd (member) {
    var discord = member.accounts.filter(function (account) { return account.platform === 'discord'; });
    var btnDiscord = document.getElementById('member-add-discord');
    var held = document.getElementById('member-discord-held');
    btnDiscord.hidden = discord.length > 0;
    held.hidden = discord.length === 0;
    held.querySelector('small').textContent = discord.length
      ? 'Discord: ' + discord.map(function (account) { return account.label; }).join(', ') +
        '. To link a different Discord account, unlink this one first.'
      : '';
    available.then(function (on) {
      btnDiscord.disabled = !on.discord;
      btnDiscord.title = on.discord ? '' : 'Discord login is not configured on this server.';
      var btnPassport = document.getElementById('member-add-passport');
      btnPassport.disabled = !on.passport;
      btnPassport.title = on.passport ? '' : 'Passport login is not available on this server.';
    });
  }

  var ERRORS = {
    access_denied: 'Discord linking was cancelled.',
    expired_state: 'That Discord link expired. Try again.',
    invalid_request: 'Discord returned an invalid response. Try again.',
    discord_failed: 'Could not complete the Discord link. Try again.',
    discord_unavailable: 'Discord could not be reached. Try again in a minute.',
    link_failed: 'That link was started from a different sign-in. Try again.',
    one_time_link: 'You signed in with a one-time link. Sign in with Discord or Passport first, then link another account.',
    one_discord: 'Your profile already has a Discord account. A profile holds one: unlink it first to link a different one.'
  };

  function linkedMessage (what, merged) {
    return (what === 'discord' ? 'Discord account' : 'Fabric identity') + ' linked.' +
      (merged ? ' It had its own profile, so the two are now one.' : '');
  }

  var profileId = null;

  function reload () {
    if (profileId) showProfile(profileId);
  }

  function wireAdd () {
    var btnDiscord = document.getElementById('member-add-discord');
    btnDiscord.addEventListener('click', function () {
      btnDiscord.disabled = true;
      var confirmed = typeof window.goonConfirmLink === 'function'
        ? window.goonConfirmLink('a Discord account')
        : Promise.resolve();
      confirmed.then(function () {
        say('Redirecting to Discord…');
        window.location.href = '/services/members/discord?link=1&next=profile';
      }).catch(function (error) {
        btnDiscord.disabled = false;
        say(error.message);
      });
    });
    var btnPassport = document.getElementById('member-add-passport');
    btnPassport.addEventListener('click', function () {
      if (typeof window.goonPassport !== 'function') {
        say('Passport linking is not available on this page. Reload and try again.');
        return;
      }
      btnPassport.disabled = true;
      window.goonPassport(true, say).then(function (j) {
        btnPassport.disabled = false;
        say(linkedMessage(j.linked || 'fabric', j.merged));
        if (j.member && j.member.id) profileId = j.member.id;
        reload();
      }).catch(function (error) {
        btnPassport.disabled = false;
        say(error.message);
      });
    });
  }

  function showProfile (id) {
    profileId = id;
    var status = document.getElementById('member-status');
    call('/services/members/profiles/' + encodeURIComponent(id)).then(function (r) {
      if (r.status === 401) {
        document.getElementById('member-signed-out').hidden = false;
        return;
      }
      if (r.status === 404) {
        call('/services/members/session').then(function (s) {
          if (s.ok && s.j && s.j.member) document.getElementById('member-own-link').href = base + '/' + s.j.member.id;
        }).catch(function () {});
        document.getElementById('member-private').hidden = false;
        return;
      }
      if (!r.ok || !r.j || !r.j.member) {
        status.textContent = 'Could not load this profile. Reload to try again.';
        return;
      }
      if (r.j.member.path && r.j.member.path !== window.location.pathname) window.history.replaceState(null, '', r.j.member.path);
      profileId = r.j.member.id;
      renderProfile(r.j.member);
    }).catch(function () {
      status.textContent = 'Could not load this profile. Reload to try again.';
    });
  }

  if (onDirectory) {
    showDirectory();
    return;
  }
  var params = new URLSearchParams(window.location.search);
  if (params.get('error')) say(ERRORS[params.get('error')] || 'Linking failed.');
  else if (params.get('linked')) say(linkedMessage(params.get('linked'), params.get('merged')));
  if (window.location.search) window.history.replaceState(null, '', window.location.pathname);
  wireAdd();
  wireRename();
  showProfile(profileMatch[0].toLowerCase());
}

const CLIENT = clientScript('/scripts/members.js', client, __filename);

module.exports = {
  id: 'members-page',
  client: CLIENT,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
