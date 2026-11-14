// Compiled from components/AdminPage.js by `npm run build`. Edit the component, not this file.
'use strict';

(function client () {
  var page = document.getElementById('admin-page');
  if (!page) return;
  var base = String(page.getAttribute('data-path') || '');
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  if (path.toLowerCase() !== base.toLowerCase()) return;

  var PLATFORMS = { discord: 'Discord', fabric: 'Fabric', rsi: 'RSI' };
  var status = document.getElementById('admin-status');

  function call (url, opts) {
    var options = opts || {};
    var headers = Object.assign({ Accept: 'application/json' }, options.headers || {});
    return window.fetch(url, {
      cache: 'no-store',
      credentials: 'same-origin',
      method: options.method || 'GET',
      headers: headers,
      body: options.body || null
    }).then(function (res) {
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

    function showReviews (reviews) {
    var waiting = (reviews && reviews.pending) || [];
    var reviewsNote = document.getElementById('admin-reviews-note');
    var reviewsList = document.getElementById('admin-reviews');
    var reviewStatus = document.getElementById('admin-review-status');
    reviewsList.textContent = '';
    if (!reviews.available && !waiting.length) text(reviewsNote, 'Reviews are off.');
    else if (!waiting.length) text(reviewsNote, 'No officers are waiting. Everyone else can claim an RSI handle without approval.');
    else text(reviewsNote, waiting.length + (waiting.length === 1 ? ' officer is' : ' officers are') + ' waiting. Approving one leaves the others waiting.');
    waiting.forEach(function (member) { reviewsList.appendChild(reviewCard(member)); });

    function reviewCard (member) {
      var box = document.createElement('div');
      box.className = 'admin-review';
      var title = document.createElement('strong');
      title.textContent = member.displayName || member.id;
      box.appendChild(title);
      var lines = [];
      if (member.discord) {
        lines.push('Discord @' + (member.discord.username || 'unknown') + ' (' + member.discord.id + ')');
      } else lines.push('No Discord account on the profile');
      if (member.officers && member.officers.length) lines.push('Officer of ' + member.officers.join(', '));
      lines.push(member.inGuild ? 'In the G00N SQUAD Discord' : 'Not in the G00N SQUAD Discord');
      (member.rsi || []).forEach(function (handle) { lines.push('RSI ' + handle.id); });
      (member.fabric || []).forEach(function (account) {
        if (account.identityId) lines.push('Fabric ' + account.identityId);
      });
      if (member.requestedAt) lines.push('Waiting since ' + when(member.requestedAt));
      lines.push('Member ' + member.id);
      lines.forEach(function (line) {
        var p = document.createElement('p');
        p.className = 'admin-meta';
        p.textContent = line;
        box.appendChild(p);
      });
      (member.rsi || []).forEach(function (handle) {
        if (!handle.url) return;
        var p = document.createElement('p');
        var a = document.createElement('a');
        a.href = handle.url;
        a.textContent = 'RSI profile';
        p.appendChild(a);
        box.appendChild(p);
      });
      var actions = document.createElement('div');
      actions.className = 'admin-actions';
      actions.appendChild(decisionButton(member, 'approved', 'Approve'));
      actions.appendChild(decisionButton(member, 'denied', 'Turn away'));
      box.appendChild(actions);
      return box;
    }

    function decisionButton (member, decision, label) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'goon-button';
      button.textContent = label;
      button.addEventListener('click', function () {
        var name = member.displayName || member.id;
        var question = decision === 'approved'
          ? 'Approve ' + name + '? They can claim an RSI handle. Nobody else in line is changed.'
          : 'Turn ' + name + ' away? Nobody else in line is changed.';
        if (!window.confirm(question)) return;
        reviewsList.querySelectorAll('button').forEach(function (el) { el.disabled = true; });
        text(reviewStatus, '');
        call('/services/admin/reviews/' + member.id, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ decision: decision })
        }).then(function (r) {
          if (!r.ok) {
            text(reviewStatus, (r.j && r.j.error) || 'Could not update that sign-in.');
            reviewsList.querySelectorAll('button').forEach(function (el) { el.disabled = false; });
            return;
          }
          text(reviewStatus, (decision === 'approved' ? 'Approved ' : 'Turned away ') + name + '.');
          showReviews(r.j.reviews || { pending: [] });
        }).catch(function () {
          text(reviewStatus, 'Could not update that sign-in. Reload to try again.');
          reviewsList.querySelectorAll('button').forEach(function (el) { el.disabled = false; });
        });
      });
      return button;
    }
    }

    showReviews(body.reviews || {});

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
})(window);
