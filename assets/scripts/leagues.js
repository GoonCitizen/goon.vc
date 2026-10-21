'use strict';

/**
 * goon.vc league pages: the index (every league and the creator) and one page
 * per league (standings for a season, logging a duel, voiding a mistake,
 * starting the next season, and the league's permanent log), all through the
 * leagues service.
 */
(function () {
  const indexEl = document.getElementById('leagues-page');
  const pageEl = document.getElementById('league-page');
  const host = indexEl || pageEl;
  if (!host) return;
  const base = (host.getAttribute('data-base') || '/leagues').replace(/\/+$/, '');
  const api = host.getAttribute('data-api') || '/services/leagues';
  const siteTitle = (pageEl && pageEl.getAttribute('data-site-title')) || 'GOON SQUAD';
  const path = (window.location.pathname || '/').replace(/\/+$/, '');

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
    return date.toLocaleString(undefined, Object.assign({ year: 'numeric', month: 'short', day: 'numeric' }, options || {}));
  }

  function note (form, message, isError) {
    const el = form.querySelector('.tournament-form-note');
    el.textContent = message;
    el.className = 'tournament-form-note' + (isError ? ' error' : '');
  }

  function busy (form, value) {
    form.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  }

  function leaguePath (id) {
    return `${base}/${encodeURIComponent(id)}`;
  }

  function dateEnd (value) {
    return value ? new Date(`${value}T23:59:59`).toISOString() : null;
  }

  function bestOfOptions (selected) {
    return [1, 3, 5, 7, 9].map((n) => `<option value="${n}"${n === selected ? ' selected' : ''}>Best of ${n}</option>`).join('');
  }

  function plural (n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
  }

  /* ---------- index ---------- */

  function listTable (leagues) {
    if (!leagues.length) return '<p class="tournament-muted">No leagues yet. Start one below.</p>';
    const rows = leagues.map((league) => `<tr>
        <td><a href="${esc(leaguePath(league.id))}">${esc(league.name)}</a>${league.tagline ? `<br><span class="tournament-muted">${esc(league.tagline)}</span>` : ''}</td>
        <td>${league.kind === 'seasonal' ? esc(league.season.name) : 'Perpetual'}</td>
        <td>${esc(league.players)}</td>
        <td>${league.leader ? `<span class="champion">${esc(league.leader.name)}</span> <span class="tournament-muted">${esc(league.leader.rating)}</span>` : '<span class="tournament-muted">No duels yet</span>'}</td>
      </tr>`).join('');
    return `<table class="tournament-results">
      <thead><tr><th>League</th><th>Season</th><th>Pilots</th><th>Leader</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  async function showIndex () {
    const form = document.getElementById('league-create-form');
    if (form) {
      const seasonal = form.querySelector('[data-seasonal]');
      const sync = () => { seasonal.hidden = form.kind.value !== 'seasonal'; };
      form.kind.addEventListener('change', sync);
      sync();
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(form, true);
        try {
          const league = await request('POST', api, {
            name: form.name.value,
            tagline: form.tagline.value,
            summary: form.summary.value,
            kind: form.kind.value,
            bestOf: Number(form.bestOf.value),
            k: form.k.value,
            initialRating: form.initialRating.value,
            players: form.players.value.split(/[,\n;]+/).map((name) => name.trim()).filter(Boolean),
            season: form.kind.value === 'seasonal' ? { name: form.seasonName.value, endsAt: dateEnd(form.seasonEndsAt.value) } : undefined
          });
          window.location.href = leaguePath(league.id);
        } catch (error) {
          note(form, error.message, true);
          busy(form, false);
        }
      });
    }
    const list = document.getElementById('league-list');
    try {
      const data = await request('GET', api);
      if (list) list.innerHTML = listTable(data.leagues);
    } catch (error) {
      if (list) list.innerHTML = `<p class="tournament-muted">Leagues are unavailable right now (${esc(error.message)}).</p>`;
    }
  }

  /* ---------- league ---------- */

  function streak (n) {
    if (!n) return '';
    return n > 0 ? `W${n}` : `L${-n}`;
  }

  function standingsTable (season) {
    const waiting = season.waiting && season.waiting.length
      ? `<p class="tournament-muted">Yet to duel: ${season.waiting.map(esc).join(', ')}</p>`
      : '';
    if (!season.standings.length) {
      return `<p class="tournament-muted">${season.status === 'active' ? 'No duels this season yet. Log the first one below.' : 'No duels were logged this season.'}</p>${waiting}`;
    }
    const rows = season.standings.map((p) => `<tr>
        <td class="num">${esc(p.rank)}</td>
        <td${p.rank === 1 ? ' class="champion"' : ''}>${esc(p.name)}</td>
        <td class="num rating">${esc(p.rating)}</td>
        <td class="num">${esc(p.wins)}–${esc(p.losses)}</td>
        <td class="num">${esc(p.gamesWon)}–${esc(p.gamesLost)}</td>
        <td class="num">${esc(streak(p.streak))}</td>
        <td class="num">${esc(p.peak)}</td>
      </tr>`).join('');
    return `<table class="tournament-results league-standings">
      <thead><tr><th class="num">#</th><th>Pilot</th><th class="num">Rating</th><th class="num">Duels</th><th class="num">Games</th><th class="num">Streak</th><th class="num">Peak</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>${waiting}`;
  }

  function duelList (duels, open) {
    if (!duels.length) return '<p class="tournament-muted">No duels yet.</p>';
    const items = duels.slice().reverse().map((duel) => {
      const change = duel.change;
      const delta = change && !duel.voided
        ? `<span class="league-delta">${esc(duel.winner)} ${esc(change.winner[1])} (+${esc(Math.round(change.points))}) · ${esc(duel.loser)} ${esc(change.loser[1])} (−${esc(Math.round(change.points))})</span>`
        : duel.voided ? `<span class="league-delta">Void${duel.voided.reason ? `: ${esc(duel.voided.reason)}` : ''}</span>` : '';
      const action = open
        ? `<button type="button" data-duel="${esc(duel.id)}" data-action="${duel.voided ? 'restore' : 'void'}">${duel.voided ? 'Restore' : 'Void'}</button>`
        : '';
      return `<li class="${duel.voided ? 'void' : ''}">
          <time class="tournament-muted" datetime="${esc(duel.playedAt || duel.loggedAt)}">${esc(when(duel.playedAt || duel.loggedAt, { year: undefined }))}</time>
          <span class="league-duel-text"><strong>${esc(duel.winner)}</strong> beat ${esc(duel.loser)} ${esc(duel.score.join('–'))} <span class="tournament-muted">(best of ${esc(duel.bestOf)})</span>${duel.source ? ` <span class="tournament-muted">— <a href="${esc(duel.source.path)}">${esc(duel.source.name)}</a></span>` : ''}${duel.note ? ` <span class="tournament-muted">— ${esc(duel.note)}</span>` : ''}${duel.confirmedBy ? ` <span class="tournament-muted">— confirmed by ${esc(duel.confirmedBy)} on Discord</span>` : ''}</span>
          ${delta}
          ${action}
        </li>`;
    }).join('');
    return `<ol class="league-duels" reversed>${items}</ol>`;
  }

  /** Datalist options: roster names containing the typed text, then Discord members as `@handle`. */
  function pilotOptions (roster, typed, handles) {
    const wanted = typed.replace(/^@/, '').toLowerCase();
    const names = typed.startsWith('@') ? [] : roster.filter((name) => name.toLowerCase().includes(wanted));
    return names.map((name) => `<option value="${esc(name)}"></option>`)
      .concat(handles.map((entry) => `<option value="@${esc(entry.handle)}">${esc(entry.name)}</option>`))
      .join('');
  }

  function scoreOptions (bestOf) {
    const need = (bestOf + 1) / 2;
    const out = [];
    for (let lost = 0; lost < need; lost++) out.push(`<option value="${lost}">${need}–${lost}</option>`);
    return out.join('');
  }

  function logLine (entry) {
    const by = entry.by ? ` <span class="tournament-muted">— ${esc(entry.by)}</span>` : '';
    let what;
    switch (entry.type) {
      case 'create': what = `League created (${esc(entry.kind)})${entry.players && entry.players.length ? ` with ${plural(entry.players.length, 'pilot')}` : ''}.`; break;
      case 'join': what = `${esc(entry.name)} joined.`; break;
      case 'link': what = `${esc(entry.name)} was linked to their Discord account.`; break;
      case 'update': what = `Details edited: ${esc((entry.fields || []).join(', '))}.`; break;
      case 'duel': what = `<strong>${esc(entry.winner)}</strong> beat ${esc(entry.loser)} ${esc((entry.score || []).join('–'))} (best of ${esc(entry.bestOf)})${entry.confirmedBy ? `, confirmed by ${esc(entry.confirmedBy)} on Discord` : ''}.`; break;
      case 'void': what = `Duel ${esc(entry.duel)} (${esc(entry.winner)} over ${esc(entry.loser)}) voided${entry.reason ? `: ${esc(entry.reason)}` : ''}.`; break;
      case 'restore': what = `Duel ${esc(entry.duel)} (${esc(entry.winner)} over ${esc(entry.loser)}) restored.`; break;
      case 'season-end': what = `${esc(entry.name || `Season ${entry.season}`)} closed${entry.champion ? `; <strong>${esc(entry.champion)}</strong> finished first` : ''}.`; break;
      case 'season-start': what = `${esc(entry.name)} began.`; break;
      case 'tournament': {
        const parts = [];
        if ((entry.duels || []).length) parts.push(`${plural(entry.duels.length, 'set')} logged as duels, dated when they were played`);
        if ((entry.voided || []).length) parts.push(`${plural(entry.voided.length, 'duel')} voided because its results changed`);
        if ((entry.restored || []).length) parts.push(`${plural(entry.restored.length, 'duel')} restored`);
        what = `<a href="${esc(entry.path)}">${esc(entry.name)}</a>: ${parts.join('; ')}.`;
        break;
      }
      default: what = esc(entry.type);
    }
    return `<li><time datetime="${esc(entry.at)}">${esc(when(entry.at, { year: undefined, hour: 'numeric', minute: '2-digit' }))}</time>${what}${by}</li>`;
  }

  function render (view, league, seasonNumber) {
    const latest = league.seasons[league.seasons.length - 1];
    const season = league.seasons.find((entry) => entry.number === seasonNumber) || latest;
    const open = season.status === 'active';
    const seasonal = league.kind === 'seasonal';
    document.title = `${league.name} — ${siteTitle}`;
    const seasonTabs = seasonal && league.seasons.length > 1
      ? `<ul class="league-seasons">${league.seasons.slice().reverse().map((entry) => `<li><a href="${esc(leaguePath(league.id))}${entry === latest ? '' : `?season=${entry.number}`}"${entry === season ? ' aria-current="page"' : ''}>${esc(entry.name)}</a></li>`).join('')}</ul>`
      : '';
    const seasonLine = seasonal
      ? `<p class="tournament-muted">${esc(season.name)}: started ${esc(when(season.startedAt))}${season.endedAt ? `, closed ${esc(when(season.endedAt))}` : season.endsAt ? `, planned to end ${esc(when(season.endsAt))}` : ''}.${!open && season.champion ? ` <strong>${esc(season.champion)}</strong> finished first.` : ''}</p>`
      : '';
    const players = pilotOptions(league.players, '', []);
    const duelForm = open
      ? `<section class="tournament-section">
          <h2>Log a duel</h2>
          <form class="tournament-form" id="league-duel-form">
            <datalist id="league-winner-options">${players}</datalist>
            <datalist id="league-loser-options">${players}</datalist>
            <div class="tournament-row">
              <label>Winner <input name="winner" list="league-winner-options" maxlength="33" placeholder="@handle or name" required autocomplete="off"></label>
              <label>Loser <input name="loser" list="league-loser-options" maxlength="33" placeholder="@handle or name" required autocomplete="off"></label>
            </div>
            <p class="tournament-muted">Type any name, or a Discord handle to find a member of our server. A pilot picked by <code>@handle</code> keeps their place in the league by their Discord account, whatever name they go by.</p>
            <div class="tournament-row">
              <label>Set <select name="bestOf">${bestOfOptions(league.bestOf)}</select></label>
              <label>Score <select name="lost">${scoreOptions(league.bestOf)}</select></label>
            </div>
            <label>Note (optional) <input name="note" maxlength="140" placeholder="Arrows, Area18"></label>
            <button class="goon-button" type="submit">Log duel</button>
            <p class="tournament-form-note" role="status"></p>
          </form>
        </section>`
      : '';
    const seasonForm = seasonal && open
      ? `<details>
            <summary>Start the next season</summary>
            <form class="tournament-form" id="league-season-form">
              <p class="tournament-muted">Closes ${esc(season.name)}, keeps its standings on record, and starts everyone again at ${esc(league.initialRating)}.</p>
              <div class="tournament-row">
                <label>Name <input name="name" maxlength="32" placeholder="Season ${esc(latest.number + 1)}"></label>
                <label>Planned end (optional) <input name="endsAt" type="date"></label>
              </div>
              <button class="goon-button" type="submit">Close ${esc(season.name)} and start the next</button>
              <p class="tournament-form-note" role="status"></p>
            </form>
          </details>`
      : '';
    view.innerHTML = `<h1>${esc(league.name)}</h1>
      ${league.tagline ? `<p class="league-tagline">${esc(league.tagline)}</p>` : ''}
      <p class="league-meta">${seasonal ? 'Seasonal' : 'Perpetual'} league · usually best of ${esc(league.bestOf)} · ${esc(plural(league.players.length, 'pilot'))}</p>
      ${seasonTabs}
      ${league.summary ? `<p>${esc(league.summary)}</p>` : ''}
      <section class="tournament-section">
        <h2>${seasonal ? `Standings · ${esc(season.name)}` : 'Standings'}</h2>
        ${seasonLine}
        ${standingsTable(season)}
      </section>
      ${duelForm}
      <section class="tournament-section">
        <h2>Duels</h2>
        ${duelList(league.duels.filter((duel) => duel.season === season.number), open)}
      </section>
      <section class="tournament-section">
        <h2>Manage</h2>
        <div class="tournament-form">
          ${seasonForm}
          <details>
            <summary>Add a pilot</summary>
            <form class="tournament-form" id="league-player-form">
              <label>Name <input name="name" maxlength="24" required autocomplete="off"></label>
              <button class="goon-button" type="submit">Add pilot</button>
              <p class="tournament-form-note" role="status"></p>
            </form>
          </details>
          <details>
            <summary>Edit details</summary>
            <form class="tournament-form" id="league-edit-form">
              <label>Name <input name="name" maxlength="48" required value="${esc(league.name)}"></label>
              <label>Tagline <input name="tagline" maxlength="120" value="${esc(league.tagline)}"></label>
              <label>Summary <textarea name="summary" maxlength="600">${esc(league.summary)}</textarea></label>
              <label>Usual set <select name="bestOf">${bestOfOptions(league.bestOf)}</select></label>
              <button class="goon-button" type="submit">Save</button>
              <p class="tournament-form-note" role="status"></p>
            </form>
          </details>
        </div>
      </section>`;
  }

  async function showLeague (view, id) {
    const src = `${api}/${encodeURIComponent(id)}`;
    const log = document.getElementById('league-log');
    const help = document.getElementById('league-help');
    let wanted = Number(new URLSearchParams(window.location.search).get('season')) || null;

    const draw = (league) => {
      render(view, league, wanted);
      help.hidden = false;
      help.querySelectorAll('[data-league-initial]').forEach((el) => { el.textContent = league.initialRating; });
      help.querySelectorAll('[data-league-k]').forEach((el) => { el.textContent = league.k; });
      log.hidden = false;
      log.innerHTML = `<h2>On record</h2><ol>${league.log.slice().reverse().map(logLine).join('')}</ol>`;
      bind(league);
    };

    const submit = (form, run) => {
      if (!form) return;
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(form, true);
        try {
          const league = await run(form);
          if (league) draw(league);
          else busy(form, false);
        } catch (error) {
          note(form, error.message, true);
          busy(form, false);
        }
      });
    };

    const bind = (league) => {
      const duelForm = document.getElementById('league-duel-form');
      if (duelForm) {
        duelForm.bestOf.addEventListener('change', () => {
          duelForm.lost.innerHTML = scoreOptions(Number(duelForm.bestOf.value));
        });
        [duelForm.winner, duelForm.loser].forEach((input) => {
          const list = document.getElementById(input.getAttribute('list'));
          let timer = null;
          let asked = 0;
          input.addEventListener('input', () => {
            clearTimeout(timer);
            const typed = input.value.trim();
            list.innerHTML = pilotOptions(league.players, typed, []);
            if (typed.replace(/^@/, '').length < 2) return;
            timer = setTimeout(async () => {
              const ticket = ++asked;
              let handles = [];
              try {
                handles = (await request('GET', `${src}/handles?query=${encodeURIComponent(typed)}`)).handles;
              } catch (error) {
                return;
              }
              if (ticket === asked && input.value.trim() === typed) list.innerHTML = pilotOptions(league.players, typed, handles);
            }, 250);
          });
        });
      }
      submit(duelForm, (form) => {
        const bestOf = Number(form.bestOf.value);
        return request('POST', `${src}/duels`, {
          winner: form.winner.value,
          loser: form.loser.value,
          bestOf,
          score: [(bestOf + 1) / 2, Number(form.lost.value)],
          note: form.note.value
        });
      });
      submit(document.getElementById('league-season-form'), (form) => {
        if (!window.confirm('Close this season? Its standings are frozen and everyone starts again.')) return null;
        return request('POST', `${src}/seasons`, { name: form.name.value, endsAt: dateEnd(form.endsAt.value) }).then((data) => {
          wanted = null;
          window.history.replaceState(null, '', leaguePath(league.id));
          return data;
        });
      });
      submit(document.getElementById('league-player-form'), (form) => request('POST', `${src}/players`, { name: form.name.value }));
      submit(document.getElementById('league-edit-form'), (form) => request('PATCH', src, {
        name: form.name.value,
        tagline: form.tagline.value,
        summary: form.summary.value,
        bestOf: Number(form.bestOf.value)
      }));
      view.querySelectorAll('.league-duels button[data-duel]').forEach((button) => {
        button.addEventListener('click', async () => {
          const action = button.getAttribute('data-action');
          let body = {};
          if (action === 'void') {
            const reason = window.prompt('Void this duel? It stays on record but stops counting. Reason (optional):', '');
            if (reason === null) return;
            body = { reason };
          }
          button.disabled = true;
          try {
            draw(await request('POST', `${src}/duels/${encodeURIComponent(button.getAttribute('data-duel'))}/${action}`, body));
          } catch (error) {
            button.disabled = false;
            window.alert(error.message);
          }
        });
      });
    };

    draw(await request('GET', src));
  }

  if (indexEl && path.toLowerCase() === base.toLowerCase()) {
    showIndex();
    return;
  }
  if (!pageEl || path.toLowerCase().indexOf(base.toLowerCase() + '/') !== 0) return;
  const view = document.getElementById('league-view');
  const parts = path.slice(base.length + 1).split('/');
  let id = null;
  try { id = parts.length === 1 ? decodeURIComponent(parts[0]).toLowerCase() : null; } catch (e) { id = null; }
  const shown = id ? showLeague(view, id) : Promise.reject(Object.assign(new Error('Not found'), { status: 404 }));
  shown.catch((error) => {
    view.innerHTML = error.status === 404
      ? '<h1>Not found</h1><p class="tournament-muted">There is no league here. Check the leagues index.</p>'
      : `<p class="tournament-muted">Couldn’t load this league: ${esc(error.message)}</p>`;
  });
})();
