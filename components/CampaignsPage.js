'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');

function renderStyles () {
  return `
      .campaigns-page { display: none; margin: 3em auto; max-width: 46em; padding: 0 1em; text-align: left; }
      .campaigns-page h1 { text-align: center; }
      .campaigns-page [hidden] { display: none !important; }
      .campaigns-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; line-height: 1.45; margin: 1.5em 0; padding: 1em; }
      .campaigns-page h2 { font-size: 1.2em; margin-top: 0; }
      .campaigns-status { min-height: 1.2em; overflow-wrap: anywhere; text-align: center; }
      .campaigns-note, .campaigns-page small { color: #999; }
      .campaigns-list { list-style: none; margin: 0; padding: 0; }
      .campaigns-list > li { border-top: 1px solid rgba(255, 255, 255, 0.12); padding: 0.75em 0; }
      .campaigns-list > li:first-child { border-top: 0; }
      .campaigns-message { white-space: pre-wrap; }
      .campaigns-actions { display: flex; flex-wrap: wrap; gap: 0.5em; margin-top: 0.5em; }
      .campaigns-actions .goon-button { font-size: 0.85em; margin: 0; }
      .campaigns-links { display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; margin-top: 1em; }`;
}

/**
 * `/campaigns`. Admins inspect campaigns and send a draft by hand.
 * @param {Object} props
 * @param {string} props.path
 * @param {string} props.loginPath
 * @returns {string}
 */
function renderHtml (props) {
  return `<main id="campaigns-page" class="campaigns-page" data-path="${escapeHtml(props.path)}">
      <h1>Campaigns</h1>
      <p id="campaigns-status" class="campaigns-status" role="status"></p>
      <section id="campaigns-signed-out" hidden>
        <p>Sign in to inspect campaigns.</p>
        <p class="campaigns-links"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign in</a></p>
      </section>
      <section id="campaigns-denied" hidden>
        <p>This page isn’t available.</p>
      </section>
      <div id="campaigns-panel" hidden>
        <p id="campaigns-note" class="campaigns-note"></p>
        <ul id="campaigns-list" class="campaigns-list"></ul>
      </div>
    </main>`;
}

function renderScript () {
  return CLIENT.tag();
}

/**
 * Campaign desk at /campaigns. Reads `GET /services/campaigns`.
 * Send previews the draft and starts that preview.
 */
function client () {
  var page = document.getElementById('campaigns-page');
  if (!page) return;
  var base = String(page.getAttribute('data-path') || '');
  var path = (window.location.pathname || '/').replace(/\/+$/, '') || '/';
  if (path.toLowerCase() !== base.toLowerCase()) return;

  var status = document.getElementById('campaigns-status');
  var list = document.getElementById('campaigns-list');
  var open = {};

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

  function text (el, value) {
    if (el) el.textContent = value || '';
  }

  function when (iso) {
    var date = iso ? new Date(iso) : null;
    if (!date || isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function line (parent, value, className) {
    var p = document.createElement('p');
    if (className) p.className = className;
    p.textContent = value;
    parent.appendChild(p);
    return p;
  }

  function button (label, onClick) {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'goon-button';
    el.textContent = label;
    el.addEventListener('click', onClick);
    return el;
  }

  function meta (campaign) {
    var stats = campaign.stats || {};
    var bits = [campaign.status || 'unknown'];
    if (campaign.owner && campaign.owner.name) bits.push(campaign.owner.name);
    else if (campaign.owner && campaign.owner.kind === 'staff') bits.push('Staff');
    if (stats.targeted) bits.push(stats.sent + ' sent of ' + stats.targeted);
    else if (stats.sent) bits.push(stats.sent + ' sent');
    if (stats.pending) bits.push(stats.pending + ' still going out');
    var stamp = when(campaign.finishedAt || campaign.startedAt || campaign.sendAt || campaign.createdAt);
    if (stamp) bits.push(stamp);
    return bits.join(' · ');
  }

  function drawOne (campaign) {
    var li = document.createElement('li');
    var title = document.createElement('strong');
    title.textContent = campaign.title || campaign.id;
    li.appendChild(title);
    line(li, meta(campaign), 'campaigns-note');
    var detail = open[campaign.id];
    if (detail) {
      var content = detail.content || {};
      if (content.script) line(li, 'Script: ' + content.script);
      if (content.text) line(li, content.text, 'campaigns-message');
      else if (content.type === 'script') line(li, 'No message. The script carries the conversation.', 'campaigns-note');
      var filter = detail.filter || {};
      var who = [];
      if (filter.roles && filter.roles.length) who.push('roles ' + filter.roles.join(', '));
      if (filter.excludeRoles && filter.excludeRoles.length) who.push('excluding ' + filter.excludeRoles.join(', '));
      if (filter.activeWithinDays) who.push('active within ' + filter.activeWithinDays + ' days');
      if (filter.inactiveForDays) who.push('quiet for ' + filter.inactiveForDays + ' days');
      if (who.length) line(li, who.join(' · '), 'campaigns-note');
      (detail.log || []).forEach(function (entry) {
        line(li, [entry.type, entry.by, when(entry.at)].filter(Boolean).join(' · '), 'campaigns-note');
      });
      if (detail.recipients) {
        var names = detail.recipients.map(function (recipient) { return recipient.name; });
        line(li, names.length ? ('Would reach ' + names.join(', ') + '.') : 'Nobody to send to.');
      }
    }
    var actions = document.createElement('div');
    actions.className = 'campaigns-actions';
    actions.appendChild(button(detail ? 'Refresh' : 'Inspect', function () { inspect(campaign.id); }));
    if (detail && (detail.status === 'draft' || detail.status === 'scheduled')) {
      actions.appendChild(button('Preview', function () { preview(campaign.id, actions); }));
      actions.appendChild(button('Send now', function () { send(campaign, actions); }));
    }
    li.appendChild(actions);
    return li;
  }

  function draw (body) {
    document.getElementById('campaigns-panel').hidden = false;
    var note = document.getElementById('campaigns-note');
    list.textContent = '';
    if (!body.available) {
      text(note, 'Campaigns are off.');
      return;
    }
    var campaigns = body.campaigns || [];
    text(note, campaigns.length ? '' : 'No campaigns yet.');
    campaigns.forEach(function (campaign) {
      list.appendChild(drawOne(open[campaign.id] || campaign));
    });
  }

  function load () {
    return call('/services/campaigns').then(function (r) {
      if (r.status === 401) {
        document.getElementById('campaigns-signed-out').hidden = false;
        return;
      }
      if (!r.ok || !r.j || !r.j.ok) {
        document.getElementById('campaigns-denied').hidden = false;
        return;
      }
      draw(r.j);
    }).catch(function () {
      text(status, 'Could not load campaigns. Reload to try again.');
    });
  }

  function inspect (id) {
    text(status, '');
    call('/services/campaigns/' + id).then(function (r) {
      if (!r.ok) {
        text(status, (r.j && r.j.error) || 'Could not open that campaign.');
        return;
      }
      open[id] = r.j.campaign;
      load();
    }).catch(function () {
      text(status, 'Could not open that campaign.');
    });
  }

  function preview (id, actions) {
    actions.querySelectorAll('button').forEach(function (el) { el.disabled = true; });
    text(status, '');
    call('/services/campaigns/' + id + '/preview', { method: 'POST' }).then(function (r) {
      if (!r.ok) {
        text(status, (r.j && r.j.error) || 'Could not preview that campaign.');
        actions.querySelectorAll('button').forEach(function (el) { el.disabled = false; });
        return;
      }
      if (open[id]) open[id].recipients = r.j.recipients || [];
      text(status, 'Preview ready.');
      load();
    }).catch(function () {
      text(status, 'Could not preview that campaign.');
      actions.querySelectorAll('button').forEach(function (el) { el.disabled = false; });
    });
  }

  function send (campaign, actions) {
    var name = campaign.title || campaign.id;
    if (!window.confirm('Send “' + name + '” now to the people in its latest preview?')) return;
    actions.querySelectorAll('button').forEach(function (el) { el.disabled = true; });
    text(status, '');
    call('/services/campaigns/' + campaign.id + '/send', { method: 'POST' }).then(function (r) {
      if (!r.ok) {
        text(status, (r.j && r.j.error) || 'Could not send that campaign.');
        actions.querySelectorAll('button').forEach(function (el) { el.disabled = false; });
        return;
      }
      open[campaign.id] = r.j.campaign;
      if (r.j.recipients) open[campaign.id].recipients = r.j.recipients;
      text(status, 'Sending “' + name + '”.');
      load();
    }).catch(function () {
      text(status, 'Could not send that campaign.');
      actions.querySelectorAll('button').forEach(function (el) { el.disabled = false; });
    });
  }

  load();
}

const CLIENT = clientScript('/scripts/campaigns.js', client, __filename);

module.exports = {
  id: 'campaigns-page',
  client: CLIENT,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
