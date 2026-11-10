'use strict';

const clientScript = require('../functions/clientScript');
const escapeHtml = require('../functions/escapeHtml');
const TournamentBracket = require('./TournamentBracket');

const API = '/services/tournaments';

function renderTournamentsCss () {
  return `
      .tournaments-page { display: none; margin: 0 auto; max-width: 42em; padding: 0 1em 3em; text-align: left; }
      .tournaments-page > h1, .tournaments-page > .operations-intro { text-align: center; }
      .tournament-section { margin-top: 2.5em; }
      .tournament-section h2 { font-size: 1.1em; letter-spacing: 0.06em; margin: 0 0 0.75em; }
      .tournament-results { border-collapse: collapse; width: 100%; }
      .tournament-results th, .tournament-results td { border-bottom: 1px solid rgba(255, 255, 255, 0.15); padding: 0.45em 0.5em; text-align: left; vertical-align: top; }
      .tournament-results th { color: #bbb; font-size: 0.8em; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
      .tournament-results .champion { color: #fff; font-weight: 700; }
      .tournament-muted { color: #aaa; }
      .tournament-form { display: grid; gap: 0.85em; }
      .tournament-form label { display: grid; gap: 0.3em; font-weight: 600; color: #fff; }
      .tournament-form .tournament-row { display: flex; flex-wrap: wrap; gap: 0.85em; }
      .tournament-form .tournament-row label { flex: 1 1 10em; }
      .tournament-form input, .tournament-form select, .tournament-form textarea {
        background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 4px;
        color: #fff; font: inherit; font-weight: 500; padding: 0.5em 0.6em; width: 100%; box-sizing: border-box;
      }
      .tournament-form textarea { min-height: 7em; resize: vertical; }
      .tournament-form .goon-button { justify-self: start; }
      .tournament-form-note { margin: 0; min-height: 1.2em; }
      .tournament-form-note.error { color: #ff7b7b; }
      .tournament-page { display: none; margin: 0 auto; max-width: 1180px; padding: 0 0 3em; }
      .tournament-view { margin: 0 auto; max-width: 42em; padding: 0 1em; text-align: left; }
      .tournament-view.wide { max-width: none; padding: 0; }
      .tournament-view > h1 { text-align: center; }
      .tournament-log { margin: 2em auto 0; max-width: 42em; padding: 0 1em; text-align: left; }
      .tournament-log ol { margin: 0; padding-left: 1.4em; }
      .tournament-log li { margin: 0.2em 0; }
      .tournament-log time { color: #aaa; font-size: 0.9em; margin-right: 0.5em; }`;
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

/**
 * Tournaments index: every tournament on record and the tournament creator;
 * the page script fills the list from the tournaments service.
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.basePath
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 * @returns {string}
 */
function renderIndexHtml (props) {
  return `<main id="tournaments-page" class="tournaments-page" data-api="${API}" data-base="${escapeHtml(props.basePath)}">
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <section class="tournament-section">
        <h2>Results</h2>
        <div id="tournament-history"><p class="tournament-muted">Loading results…</p></div>
      </section>
      <section class="tournament-section">
        <h2>New tournament</h2>
        <p class="tournament-muted">Pick a name, format, and start time. The bracket and every result are kept on record, and once there’s a champion every set played counts as a duel in the <a href="/leagues/open-league">Open League</a>.</p>
        <form class="tournament-form" id="tournament-create-form">
          <label>Name <input name="name" maxlength="48" required placeholder="Gladius Cup"></label>
          <label>Tagline <input name="tagline" maxlength="120"></label>
          <label>Summary <textarea name="summary" maxlength="600"></textarea></label>
          <div class="tournament-row">
            <label>Format <select name="format">
              <option value="single-elimination">Single elimination</option>
              <option value="double-elimination">Double elimination</option>
            </select></label>
            <label>Sets <select name="bestOf">
              <option value="1">Best of 1</option>
              <option value="3" selected>Best of 3</option>
              <option value="5">Best of 5</option>
              <option value="7">Best of 7</option>
              <option value="9">Best of 9</option>
            </select></label>
          </div>
          <label>Date and time (your time) <input name="startsAt" type="datetime-local" required></label>
          <label>Players <span class="tournament-muted">best seed first, one per line; optional — add players until the first game, and latecomers after</span>
            <textarea name="players" spellcheck="false" autocomplete="off"></textarea></label>
          <button class="goon-button" type="submit">Create tournament</button>
          <p class="tournament-form-note" role="status"></p>
        </form>
      </section>
      ${renderFooter(props)}
    </main>`;
}

/**
 * One page for every series and tournament record under the index; the
 * page script fills it from the tournaments service.
 * @param {Object} props Same as {@link renderIndexHtml}, plus `siteTitle`.
 * @returns {string}
 */
function renderTournamentPageHtml (props) {
  return `<main id="tournament-page" class="tournament-page" data-api="${API}" data-base="${escapeHtml(props.basePath)}" data-site-title="${escapeHtml(props.siteTitle || '')}">
      <p class="page-back"><a id="tournament-back" href="${escapeHtml(props.basePath)}">&larr; Tournaments</a></p>
      <div class="tournament-view" id="tournament-view"><p class="tournament-muted">Loading…</p></div>
      <section class="tournament-log" id="tournament-log" hidden></section>
      ${renderFooter(props)}
    </main>`;
}

function renderTournamentsScript () {
  return `${TournamentBracket.client.tag()}
    ${CLIENT.tag()}`;
}

/**
 * goon.vc tournaments pages: the index (every tournament on record and the
 * creator), one page per series (tournaments sharing a name), and one per
 * tournament (a <tournament-bracket> saved to the tournaments service, plus
 * its permanent log). Needs the TournamentBracket element loaded first.
 */
function client () {
  const indexEl = document.getElementById('tournaments-page');
  const pageEl = document.getElementById('tournament-page');
  const host = indexEl || pageEl;
  if (!host) return;
  const base = (host.getAttribute('data-base') || '/tournaments').replace(/\/+$/, '');
  const api = host.getAttribute('data-api') || '/services/tournaments';
  const siteTitle = (pageEl && pageEl.getAttribute('data-site-title')) || 'GOON SQUAD';
  const path = (window.location.pathname || '/').replace(/\/+$/, '');
  const visitorZone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { return ''; }
  })();

  function esc (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function request (method, url, body) {
    const res = await fetch(url, {
      method,
      headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const error = new Error((data && data.error) || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function when (iso, options) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, Object.assign({ weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }, options || {}));
  }

  function localInput (date) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function note (form, message, isError) {
    const el = form.querySelector('.tournament-form-note');
    el.textContent = message;
    el.className = 'tournament-form-note' + (isError ? ' error' : '');
  }

  function parsePlayers (value) {
    return value.split(/[,\n;]+/).map((name) => name.trim()).filter(Boolean);
  }

  function recordPath (summary) {
    return `${base}/${encodeURIComponent(summary.seriesId)}/${encodeURIComponent(summary.slug)}`;
  }

  function resultCell (summary) {
    if (summary.results && summary.results.champion) {
      const runnerUp = summary.results.runnerUp ? `<br><span class="tournament-muted">Runner-up: ${esc(summary.results.runnerUp)}</span>` : '';
      return `<span class="champion">${esc(summary.results.champion)}</span>${runnerUp}`;
    }
    if (summary.status === 'live') return 'In progress';
    return new Date(summary.startsAt).getTime() > Date.now() ? 'Upcoming' : 'Not started';
  }

  function historyTable (list, withName) {
    if (!list.length) return '<p class="tournament-muted">No tournaments on record yet.</p>';
    const rows = list.map((summary) => `<tr>
        <td><a href="${esc(recordPath(summary))}">${esc(when(summary.startsAt))}</a></td>
        ${withName ? `<td>${esc(summary.name)}</td>` : ''}
        <td>${esc(summary.players)}</td>
        <td>${resultCell(summary)}</td>
      </tr>`).join('');
    return `<table class="tournament-results">
      <thead><tr><th>Date</th>${withName ? '<th>Tournament</th>' : ''}<th>Players</th><th>Champion</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  /* ---------- index ---------- */

  async function showIndex () {
    const form = document.getElementById('tournament-create-form');
    if (form) {
      if (!form.startsAt.value) form.startsAt.value = localInput(new Date(Math.ceil(Date.now() / 1800000) * 1800000));
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const start = new Date(form.startsAt.value);
        if (isNaN(start.getTime())) return note(form, 'Pick a date and time.', true);
        const button = form.querySelector('button[type=submit]');
        button.disabled = true;
        try {
          const tournament = await request('POST', api, {
            name: form.name.value,
            tagline: form.tagline.value,
            summary: form.summary.value,
            format: form.format.value,
            bestOf: Number(form.bestOf.value),
            startsAt: start.toISOString(),
            timeZone: visitorZone || 'UTC',
            players: parsePlayers(form.players.value)
          });
          window.location.href = recordPath(tournament);
        } catch (error) {
          note(form, error.message, true);
          button.disabled = false;
        }
      });
    }
    const history = document.getElementById('tournament-history');
    try {
      const data = await request('GET', api);
      if (history) history.innerHTML = historyTable(data.tournaments.slice(0, 100), true);
    } catch (error) {
      if (history) history.innerHTML = `<p class="tournament-muted">Results are unavailable right now (${esc(error.message)}).</p>`;
    }
  }

  /* ---------- series ---------- */

  async function showSeries (view, seriesId) {
    const data = await request('GET', `${api}/${encodeURIComponent(seriesId)}`);
    if (data.tournaments.length === 1) {
      window.location.replace(recordPath(data.tournaments[0]));
      return;
    }
    const name = data.tournaments[0].name;
    document.title = `${name} — ${siteTitle}`;
    view.innerHTML = `<h1>${esc(name)}</h1>
      <section class="tournament-section">
        <h2>Results</h2>
        ${historyTable(data.tournaments, false)}
      </section>`;
  }

  /* ---------- tournament ---------- */

  function logLine (entry) {
    const by = entry.by ? ` <span class="tournament-muted">— ${esc(entry.by)}</span>` : '';
    let what;
    switch (entry.type) {
      case 'create': what = `Scheduled for ${esc(when(entry.startsAt))}${entry.players && entry.players.length ? ` with ${entry.players.length} players` : ''}.`; break;
      case 'seeds': what = `Seeds set: ${esc((entry.players || []).join(', ')) || 'none'}.`; break;
      case 'join': what = `${esc(entry.name)} joined${entry.late ? ' late' : ''}.`; break;
      case 'game': {
        const other = (entry.players || []).find((name) => name !== entry.winner);
        what = `${esc(entry.winner)} won a game against ${esc(other)}.`;
        break;
      }
      case 'set': what = `<strong>${esc(entry.winner)}</strong> beat ${esc(entry.loser)}, ${esc((entry.score || []).slice().sort((x, y) => y - x).join('–'))}.`; break;
      case 'forfeit': what = `${esc(entry.player)} was disqualified (DQ); <strong>${esc(entry.winner)}</strong> advances.`; break;
      case 'undo': what = entry.forfeit ? `${esc(entry.forfeit)}’s DQ was taken back.` : `A game for ${esc(entry.winner)} was taken back.`; break;
      case 'complete': what = `<strong>${esc(entry.champion)}</strong> is the champion.`; break;
      case 'reopen': what = `Reopened by an edit; ${esc(entry.champion)} is no longer recorded as champion.`; break;
      default: what = esc(entry.type);
    }
    return `<li><time datetime="${esc(entry.at)}">${esc(when(entry.at, { weekday: undefined, year: undefined }))}</time>${what}${by}</li>`;
  }

  async function showTournament (view, seriesId, slug) {
    const src = `${api}/${encodeURIComponent(seriesId)}/${encodeURIComponent(slug)}`;
    const log = document.getElementById('tournament-log');
    const record = await request('GET', src);
    document.title = `${record.name} — ${when(record.startsAt, { weekday: undefined, hour: undefined, minute: undefined })} — ${siteTitle}`;
    view.classList.add('wide');
    const description = record.summary || record.tagline;
    view.innerHTML = `<tournament-bracket src="${esc(src)}" class="tournament-element"${description ? ` description="${esc(description)}"` : ''}></tournament-bracket>`;
    const renderLog = (data) => {
      log.hidden = false;
      log.innerHTML = `<h2>On record</h2><ol>${(data.log || []).map(logLine).join('')}</ol>`;
    };
    renderLog(record);
    view.firstElementChild.addEventListener('bracketchange', () => {
      request('GET', src).then(renderLog, () => {});
    });
  }

  if (indexEl && path.toLowerCase() === base.toLowerCase()) {
    showIndex();
    return;
  }
  if (!pageEl || path.toLowerCase().indexOf(base.toLowerCase() + '/') !== 0) return;
  const view = document.getElementById('tournament-view');
  const parts = path.slice(base.length + 1).split('/').map((part) => {
    try { return decodeURIComponent(part); } catch (e) { return part; }
  });
  const shown = parts.length === 1
    ? showSeries(view, parts[0].toLowerCase())
    : parts.length === 2 ? showTournament(view, parts[0].toLowerCase(), parts[1]) : Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
  shown.catch((error) => {
    view.innerHTML = error.status === 404
      ? '<h1>Not found</h1><p class="tournament-muted">There is no tournament here. It may have moved; check the tournaments index.</p>'
      : `<p class="tournament-muted">Couldn’t load this page: ${esc(error.message)}</p>`;
  });
}

const CLIENT = clientScript('/scripts/tournaments.js', client, __filename);

module.exports = {
  id: 'tournaments-page',
  client: CLIENT,
  API,
  styles: renderTournamentsCss,
  render: renderIndexHtml,
  renderTournaments: renderTournamentPageHtml,
  script: renderTournamentsScript
};
