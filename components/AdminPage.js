'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');

function renderStyles () {
  return `
      .admin-page { display: none; margin: 3em auto; max-width: 46em; padding: 0 1em; text-align: left; }
      .admin-page h1 { text-align: center; }
      .admin-page [hidden] { display: none !important; }
      .admin-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; line-height: 1.45; margin: 1.5em 0; padding: 1em; }
      .admin-page h2 { font-size: 1.2em; margin-top: 0; }
      .admin-status { min-height: 1.2em; overflow-wrap: anywhere; text-align: center; }
      .admin-note { color: #999; }
      .admin-page input[type="search"] { background: #111; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 4px; box-sizing: border-box; color: #fff; font: inherit; margin: 0.5em 0 1em; padding: 0.45em 0.6em; width: 100%; }
      .admin-list, .admin-accounts { list-style: none; margin: 0; padding: 0; }
      .admin-list > li { border-top: 1px solid rgba(255, 255, 255, 0.12); padding: 0.55em 0; }
      .admin-list > li:first-child { border-top: 0; }
      .admin-page summary { cursor: pointer; }
      .admin-page small, .admin-meta { color: #999; }
      .admin-accounts li { padding: 0.25em 0 0.25em 0.5em; }
      .admin-links { display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; margin-top: 1em; }
      .site-admin-link { display: block; margin-top: 0.4em; text-align: center; }
      .site-admin-link[hidden] { display: none !important; }`;
}

/**
 * `/admin`. The shell is in the site document; the data loads from
 * `GET /services/admin` and is 404 for anyone who is not an operator.
 * @param {Object} props
 * @param {string} props.path
 * @param {string} props.loginPath
 * @returns {string}
 */
function renderHtml (props) {
  return `<main id="admin-page" class="admin-page" data-path="${escapeHtml(props.path)}">
      <h1>Admin</h1>
      <p id="admin-status" class="admin-status" role="status"></p>
      <section id="admin-signed-out" hidden>
        <p>Sign in to open the operator panel.</p>
        <p class="admin-links"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign in</a></p>
      </section>
      <section id="admin-denied" hidden>
        <p>This page isn’t available.</p>
      </section>
      <div id="admin-panel" hidden>
        <p id="admin-you" class="admin-note"></p>
        <section>
          <h2>Waiting for review</h2>
          <p id="admin-reviews-note" class="admin-note"></p>
          <ul id="admin-reviews" class="admin-list"></ul>
        </section>
        <section>
          <h2>Campaigns</h2>
          <p id="admin-campaigns-note" class="admin-note" hidden></p>
          <ul id="admin-campaigns" class="admin-list"></ul>
        </section>
        <section>
          <h2>Check-ins</h2>
          <p id="admin-checkins" class="admin-note"></p>
        </section>
        <section>
          <h2>Welcome</h2>
          <p id="admin-welcome" class="admin-note"></p>
        </section>
        <section>
          <h2>Linked accounts</h2>
          <p class="admin-note">Every member and the accounts linked to them.</p>
          <input id="admin-filter" type="search" placeholder="Search name, handle, or id" aria-label="Search members">
          <p id="admin-count" class="admin-note"></p>
          <ul id="admin-members" class="admin-list"></ul>
        </section>
      </div>
    </main>`;
}

function renderScript () {
  return CLIENT.tag();
}

/**
 * Admin panel at /admin. Reads `GET /services/admin` and draws it.
 * Nothing here sends a campaign or decides a review.
 */
function client () {
  var page = document.getElementById('admin-page');
  if (!page) return;
  var base = String(page.getAttribute('data-path') || '');
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  if (path.toLowerCase() !== base.toLowerCase()) return;

  var PLATFORMS = { discord: 'Discord', fabric: 'Fabric', rsi: 'RSI' };
  var status = document.getElementById('admin-status');

  function call (url) {
    return window.fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'application/json' } })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) { return { ok: res.ok, status: res.status, j: j }; });
      });
  }

  function when (iso) {
    var date = iso ? new Date(iso) : null;
    if (!date || isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function text (el, value) {
    if (el) el.textContent = value || '';
  }

  function campaignLine (campaign) {
    var li = document.createElement('li');
    var title = document.createElement('strong');
    title.textContent = campaign.title || campaign.id;
    li.appendChild(title);
    var meta = document.createElement('div');
    meta.className = 'admin-meta';
    var stats = campaign.stats || {};
    var owner = campaign.owner && campaign.owner.kind === 'guild' && campaign.owner.name ? campaign.owner.name : 'Staff';
    var bits = [campaign.status || 'unknown', owner];
    if (stats.targeted) bits.push(stats.sent + ' sent of ' + stats.targeted);
    else if (stats.sent) bits.push(stats.sent + ' sent');
    if (stats.pending) bits.push(stats.pending + ' still going out');
    if (stats.failed) bits.push(stats.failed + ' failed');
    if (stats.optedOut) bits.push(stats.optedOut + ' opted out');
    var stamp = when(campaign.finishedAt || campaign.startedAt || campaign.sendAt || campaign.updatedAt || campaign.createdAt);
    if (stamp) bits.push(stamp);
    meta.textContent = bits.join(' · ');
    li.appendChild(meta);
    return li;
  }

  function runLine (label, report) {
    if (!report || report.available === false) return label + ' are off.';
    var bits = [];
    if (report.sending) bits.push(report.sending + ' still going out');
    if (report.lastRunAt) bits.push('last sent ' + when(report.lastRunAt));
    if (report.lastRun && report.lastRun.reach != null) bits.push(report.lastRun.reach + ' reached');
    if (Array.isArray(report.lastRun)) {
      report.lastRun.forEach(function (tier) {
        bits.push((tier.tier || 'tier') + ' ' + (tier.reach || 0) + (tier.status ? ' (' + tier.status + ')' : ''));
      });
    }
    if (report.welcomed != null) bits.push(report.welcomed + ' welcomed');
    if (report.error) bits.push(report.error);
    return bits.length ? bits.join(' · ') : 'Nothing sent yet.';
  }

  function accountLine (account) {
    var li = document.createElement('li');
    var name = PLATFORMS[account.platform] || account.platform;
    var bits = [name, account.label || account.id];
    if (account.name && account.name !== account.label) bits.push(account.name);
    if (account.platform === 'discord') bits.push(account.id);
    if (account.platform === 'fabric' && account.identityId && account.identityId !== account.label) bits.push(account.identityId);
    if (account.via) bits.push('via ' + account.via);
    if (account.linkedAt) bits.push(when(account.linkedAt));
    if (account.escrow) bits.push('escrow ' + account.escrow);
    li.textContent = bits.join(' · ');
    if (account.url) {
      li.appendChild(document.createTextNode(' '));
      var a = document.createElement('a');
      a.href = account.url;
      a.textContent = 'RSI';
      li.appendChild(a);
    }
    return li;
  }

  function memberHaystack (member) {
    var parts = [member.displayName || '', member.id];
    (member.accounts || []).forEach(function (account) {
      parts.push(account.platform, account.id, account.label, account.name, account.username, account.identityId);
    });
    return parts.filter(Boolean).join(' ').toLowerCase();
  }

  function draw (body) {
    document.getElementById('admin-panel').hidden = false;
    text(document.getElementById('admin-you'), body.you && body.you.displayName
      ? 'Signed in as ' + body.you.displayName + '.'
      : 'Signed in.');

    var reviews = body.reviews || {};
    var waiting = reviews.pending || [];
    var reviewsNote = document.getElementById('admin-reviews-note');
    var reviewsList = document.getElementById('admin-reviews');
    reviewsList.textContent = '';
    if (!reviews.available && !waiting.length) text(reviewsNote, 'Reviews are off.');
    else if (!waiting.length) text(reviewsNote, 'Nobody is waiting.');
    else {
      text(reviewsNote, waiting.length + (waiting.length === 1 ? ' member is' : ' members are') + ' waiting.');
      waiting.forEach(function (member) {
        var li = document.createElement('li');
        var label = (member.displayName || member.id) + (member.requestedAt ? ' · since ' + when(member.requestedAt) : '');
        if (member.inGuild === false) label += ' · not in the G00N SQUAD Discord';
        li.textContent = label;
        reviewsList.appendChild(li);
      });
    }

    var campaigns = (body.campaigns && body.campaigns.list) || [];
    var campaignBox = document.getElementById('admin-campaigns');
    var campaignNote = document.getElementById('admin-campaigns-note');
    campaignBox.textContent = '';
    if (!body.campaigns || body.campaigns.available === false) {
      campaignBox.hidden = true;
      campaignNote.hidden = false;
      campaignNote.textContent = 'Campaigns are off.';
    } else if (!campaigns.length) {
      campaignBox.hidden = true;
      campaignNote.hidden = false;
      campaignNote.textContent = 'No campaigns yet.';
    } else {
      campaignNote.hidden = true;
      campaignBox.hidden = false;
      campaigns.forEach(function (campaign) { campaignBox.appendChild(campaignLine(campaign)); });
    }

    text(document.getElementById('admin-checkins'), runLine('Check-ins', body.checkins));
    text(document.getElementById('admin-welcome'), runLine('Welcome DMs', body.welcome));

    var members = body.members || [];
    var list = document.getElementById('admin-members');
    var count = document.getElementById('admin-count');
    var filter = document.getElementById('admin-filter');
    var rows = members.map(function (member) {
      var details = document.createElement('details');
      var summary = document.createElement('summary');
      var platforms = {};
      (member.accounts || []).forEach(function (account) { platforms[account.platform] = true; });
      var names = Object.keys(platforms).map(function (platform) { return PLATFORMS[platform] || platform; });
      var title = member.displayName || member.id;
      if (names.length) title += ' · ' + names.join(', ');
      if (member.review && member.review.status && member.review.status !== 'approved') title += ' · ' + member.review.status;
      summary.textContent = title;
      details.appendChild(summary);
      var meta = document.createElement('div');
      meta.className = 'admin-meta';
      var bits = ['member ' + member.id];
      if (member.createdAt) bits.push('since ' + when(member.createdAt));
      if (member.lastLoginAt) bits.push('last sign-in ' + when(member.lastLoginAt));
      if (member.inGuild) bits.push('in the G00N SQUAD Discord');
      meta.textContent = bits.join(' · ');
      details.appendChild(meta);
      var accounts = document.createElement('ul');
      accounts.className = 'admin-accounts';
      (member.accounts || []).forEach(function (account) { accounts.appendChild(accountLine(account)); });
      if (!member.accounts || !member.accounts.length) {
        var none = document.createElement('li');
        none.textContent = 'No linked accounts.';
        accounts.appendChild(none);
      }
      details.appendChild(accounts);
      var li = document.createElement('li');
      li.appendChild(details);
      return { li: li, haystack: memberHaystack(member) };
    });

    function applyFilter () {
      var query = String(filter.value || '').trim().toLowerCase();
      var shown = 0;
      list.textContent = '';
      rows.forEach(function (row) {
        if (query && row.haystack.indexOf(query) === -1) return;
        list.appendChild(row.li);
        shown += 1;
      });
      text(count, query ? (shown + ' of ' + rows.length + (rows.length === 1 ? ' member' : ' members')) : (shown + (shown === 1 ? ' member' : ' members')));
    }
    filter.oninput = applyFilter;
    applyFilter();
  }

  call('/services/admin').then(function (r) {
    if (r.status === 401) {
      document.getElementById('admin-signed-out').hidden = false;
      return;
    }
    if (!r.ok || !r.j || !r.j.ok) {
      document.getElementById('admin-denied').hidden = false;
      return;
    }
    draw(r.j);
  }).catch(function () {
    text(status, 'Could not load the admin panel. Reload to try again.');
  });
}

const CLIENT = clientScript('/scripts/admin.js', client, __filename);

module.exports = {
  id: 'admin-page',
  client: CLIENT,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
