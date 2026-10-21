'use strict';

/**
 * goon.vc tournaments pages: the index (every tournament on record and the
 * creator), one page per series (tournaments sharing a name), and one per
 * tournament (a <tournament-bracket> saved to the tournaments service, plus
 * its permanent log). Needs /scripts/tournament-bracket.js first.
 */
(function () {
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
})();
