'use strict';

/**
 * <clip-library> — every clip from the Discord clip channels: recording
 * sessions of thumbnail cards, search and filters, a player that jumps to the
 * other pilots' angles of the same moment, and the projects cut from them.
 *
 * Attributes:
 *   src        API base (e.g. `/services/clips`). Nothing loads until it is set.
 *   base       page path for project links (default `/clips`)
 *   timeline   page path of the session timeline (default `<base>/timeline`)
 *   clip       clip to open in the player once loaded
 *   sessions   sessions shown before "Show more" (default 24)
 *
 * API (relative to src): `GET /` clips + status, `GET /sessions`,
 * `GET|POST /projects`, `POST /refresh`. Clips carry `proxyUrl` / `thumbsUrl`
 * and `proxy.thumbs` `{ every, count, columns, rows, width, height }`.
 *
 * Emits `clipopen` / `clipclose` (`detail: { id }`) as the player opens and
 * closes, and `projectopen` (cancelable; `detail: { id, path }`) before
 * navigating to a new project.
 */
(function (root) {
  if (!root || typeof root.HTMLElement !== 'function' || !root.customElements) return;
  if (root.customElements.get('clip-library')) return;

  const POLL_MS = 15000;

  function esc (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function clockTime (ms) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function dayLabel (ms) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    const sameYear = d.getFullYear() === new Date().getFullYear();
    return d.toLocaleDateString(undefined, sameYear
      ? { weekday: 'short', month: 'short', day: 'numeric' }
      : { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  }

  function dateTime (ms) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  }

  function duration (ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function longDuration (ms) {
    const minutes = Math.round((Number(ms) || 0) / 60000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes} min`;
    const h = Math.floor(minutes / 60);
    return minutes % 60 ? `${h} h ${minutes % 60} min` : `${h} h`;
  }

  function ago (ms) {
    const seconds = (Date.now() - ms) / 1000;
    if (!Number.isFinite(seconds)) return '';
    if (seconds < 90) return 'just now';
    if (seconds < 5400) return `${Math.round(seconds / 60)} minutes ago`;
    if (seconds < 129600) return `${Math.round(seconds / 3600)} hours ago`;
    return `${Math.round(seconds / 86400)} days ago`;
  }

  function plural (n, one, many) {
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
  }

  const SOURCE_LABEL = {
    metadata: 'from the file',
    filename: 'from the file name',
    posted: 'estimated from the Discord post',
    manual: 'set by hand',
    unknown: 'unknown'
  };

  const STYLE = `
    :host { display: block; color: #ddd; font: inherit; text-align: left; --accent: #a78bfa; --accent-strong: #7c3aed; --panel: rgba(0, 0, 0, 0.28); --line: rgba(255, 255, 255, 0.14); }
    * { box-sizing: border-box; }
    button, input, select { font: inherit; }
    button, .button { background: transparent; border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 6px; color: #fff; cursor: pointer; display: inline-block; padding: 0.3em 0.7em; text-decoration: none; }
    button:hover:not(:disabled), .button:hover { background: rgba(255, 255, 255, 0.1); }
    button:disabled { cursor: default; opacity: 0.4; }
    .primary { border-color: var(--accent); background: rgba(124, 58, 237, 0.35); }
    input, select { background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 4px; color: #fff; padding: 0.3em 0.45em; }
    a { color: #fff; }
    .muted { color: #999; }
    .error { color: #ff8a8a; }
    .hidden { display: none !important; }
    .bar { align-items: center; display: flex; flex-wrap: wrap; gap: 0.5em 0.75em; margin-bottom: 0.75em; }
    .bar .grow { flex: 1 1 auto; }
    .bar input[type=search] { flex: 1 1 16em; min-width: 10em; }
    .status { margin: 0 0 0.6em; min-height: 1.2em; }
    .section-title { font-size: 0.8em; letter-spacing: 0.12em; margin: 1.4em 0 0.5em; text-transform: uppercase; }
    .projects { display: grid; gap: 0.5em; grid-template-columns: repeat(auto-fill, minmax(15em, 1fr)); }
    .project { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; display: block; padding: 0.55em 0.7em; text-decoration: none; }
    .project:hover { border-color: var(--accent); }
    .project strong { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sessions { align-items: flex-start; display: flex; flex-wrap: wrap; gap: 1em; margin-top: 1em; }
    .session { --span: 1; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; display: flex; flex: var(--span) 1 calc(var(--span) * 14em + (var(--span) - 1) * 0.6em + 1.3em); flex-direction: column; gap: 0.6em; max-width: min(100%, calc(var(--span) * 24em)); min-width: 0; padding: 0.65em; }
    .session.wide { max-width: 100%; }
    @media (max-width: 600px) { .session { max-width: 100%; } }
    .session-head { display: flex; flex-direction: column; gap: 0.15em; min-width: 0; }
    .session-head h3 { font-size: 1em; margin: 0; }
    .session-head .muted { font-size: 0.85em; }
    .session-head .actions { display: flex; flex-wrap: wrap; gap: 0.35em; margin-top: 0.35em; }
    .session-head .actions .button, .session-head .actions button { font-size: 0.82em; padding: 0.2em 0.55em; }
    .grid { display: grid; gap: 0.6em; grid-template-columns: repeat(auto-fill, minmax(min(100%, 13em), 1fr)); }
    .card { background: rgba(0, 0, 0, 0.3); border: 1px solid var(--line); border-radius: 6px; color: inherit; cursor: pointer; display: block; overflow: hidden; padding: 0; text-align: left; width: 100%; }
    .card:hover, .card:focus-visible { border-color: var(--accent); outline: none; }
    .thumb { align-items: center; aspect-ratio: 16 / 9; background: #000; display: flex; justify-content: center; overflow: hidden; position: relative; }
    .thumb .frame { background-repeat: no-repeat; height: 100%; max-width: 100%; }
    .thumb .placeholder { color: #888; font-size: 0.85em; padding: 0 1em; text-align: center; }
    .thumb.pending { background: repeating-linear-gradient(45deg, #2f2f2f 0 8px, #232323 8px 16px); }
    .thumb.failed { background: #3a1717; }
    .thumb.link { background: #14283d; }
    .badge { background: rgba(0, 0, 0, 0.75); border-radius: 3px; bottom: 5px; font-size: 0.75em; font-variant-numeric: tabular-nums; padding: 0 4px; position: absolute; right: 5px; }
    .badge.left { left: 5px; right: auto; }
    .meta { padding: 0.45em 0.6em 0.55em; }
    .meta .who { display: flex; gap: 0.5em; justify-content: space-between; }
    .meta .who strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta .when { color: #999; flex: 0 0 auto; font-size: 0.88em; }
    .meta .caption { -webkit-box-orient: vertical; -webkit-line-clamp: 2; color: #bbb; display: -webkit-box; font-size: 0.88em; margin-top: 0.2em; overflow: hidden; overflow-wrap: anywhere; }
    .more { margin: 1.5em 0 0; text-align: center; }
    .empty { background: var(--panel); border: 1px dashed var(--line); border-radius: 6px; flex: 1 1 100%; padding: 1.2em; text-align: center; }
    .overlay { align-items: center; background: rgba(0, 0, 0, 0.82); display: flex; inset: 0; justify-content: center; padding: 1em; position: fixed; z-index: 1000; }
    .player { background: #121018; border: 1px solid var(--line); border-radius: 8px; display: grid; gap: 0.9em; grid-template-columns: minmax(0, 3fr) minmax(15em, 2fr); max-height: 100%; max-width: 1200px; overflow: auto; padding: 0.9em; width: 100%; }
    @media (max-width: 800px) { .player { grid-template-columns: 1fr; } }
    .player video { aspect-ratio: 16 / 9; background: #000; border-radius: 6px; display: block; width: 100%; }
    .player .linkbox { align-items: center; aspect-ratio: 16 / 9; background: #14283d; border-radius: 6px; display: flex; flex-direction: column; gap: 0.6em; justify-content: center; padding: 1em; text-align: center; }
    .player h3 { margin: 0 0 0.3em; }
    .player dl { display: grid; gap: 0.25em 0.7em; grid-template-columns: auto 1fr; margin: 0.6em 0; }
    .player dt { color: #999; }
    .player dd { margin: 0; overflow-wrap: anywhere; }
    .player .caption { overflow-wrap: anywhere; white-space: pre-wrap; }
    .player .row { display: flex; flex-wrap: wrap; gap: 0.4em; margin: 0.5em 0; }
    .player .angles button { font-size: 0.9em; }
    .player .angles button.current { border-color: var(--accent); }
    .player .top { align-items: center; display: flex; gap: 0.4em; justify-content: flex-end; }
  `;

  const SKELETON = `
    <style>${STYLE}</style>
    <p class="status" data-ref="status" role="status"></p>
    <div class="bar">
      <span class="muted grow" data-ref="summary"></span>
      <button type="button" data-action="refresh" title="Look for clips posted since the last check">Check Discord</button>
    </div>
    <div class="bar" role="search">
      <input type="search" data-ref="search" placeholder="Search captions, pilots, file names" aria-label="Search clips">
      <select data-ref="pilot" aria-label="Pilot"></select>
      <select data-ref="channel" aria-label="Channel"></select>
      <select data-ref="sort" aria-label="Sort sessions">
        <option value="newest">Newest first</option>
        <option value="oldest">Oldest first</option>
        <option value="angles">Most pilots</option>
        <option value="longest">Longest</option>
      </select>
      <label class="muted"><input type="checkbox" data-ref="links" checked> Links</label>
    </div>
    <div data-ref="projectsSection" class="hidden">
      <h3 class="section-title">Projects</h3>
      <div class="projects" data-ref="projects"></div>
    </div>
    <div class="sessions" data-ref="sessions"></div>
    <p class="more hidden" data-ref="more"><button type="button" data-action="more">Show more sessions</button></p>
    <div class="overlay hidden" data-ref="overlay" role="dialog" aria-modal="true" aria-label="Clip player"></div>`;

  class ClipLibrary extends root.HTMLElement {
    static get observedAttributes () {
      return ['src'];
    }

    constructor () {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = SKELETON;
      this.ref = {};
      this.shadowRoot.querySelectorAll('[data-ref]').forEach((el) => { this.ref[el.getAttribute('data-ref')] = el; });
      this.state = { loaded: false, clips: {}, sessions: [], undated: [], projects: [], status: null, channels: [], polling: false, shown: 0, openId: null };
      this._loadToken = 0;
      this._pollTimer = null;
      this._observer = null;
      this._bind();
    }

    connectedCallback () {
      this._scheduleLoad();
      root.addEventListener('keydown', this._onKey);
    }

    disconnectedCallback () {
      if (this._pollTimer) clearTimeout(this._pollTimer);
      this._pollTimer = null;
      if (this._observer) this._observer.disconnect();
      root.removeEventListener('keydown', this._onKey);
    }

    attributeChangedCallback (name, before, after) {
      if (before !== after) this._scheduleLoad();
    }

    // Upgrading with attributes already set fires several callbacks; load once.
    _scheduleLoad () {
      if (this._loadQueued) return;
      this._loadQueued = true;
      Promise.resolve().then(() => {
        this._loadQueued = false;
        if (this.isConnected && this.getAttribute('src')) this.load();
      });
    }

    get api () {
      return String(this.getAttribute('src') || '').replace(/\/+$/, '');
    }

    get base () {
      return String(this.getAttribute('base') || '/clips').replace(/\/+$/, '');
    }

    get timeline () {
      return String(this.getAttribute('timeline') || `${this.base}/timeline`).replace(/\/+$/, '');
    }

    get pageSize () {
      const n = Number(this.getAttribute('sessions'));
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 24;
    }

    async _request (method, url, body) {
      const res = await fetch(this.api + url, {
        method,
        credentials: 'same-origin',
        headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (_) { data = null; }
      if (!res.ok) {
        const error = new Error((data && data.error) || `Request failed (${res.status})`);
        error.status = res.status;
        throw error;
      }
      return data;
    }

    _status (message, isError) {
      this.ref.status.className = 'status' + (isError ? ' error' : ' muted');
      this.ref.status.textContent = message || '';
    }

    // ------------------------------------------------------------ loading

    async load (quiet) {
      const token = ++this._loadToken;
      if (!quiet) this._status('Loading clips…');
      try {
        const [library, sessions, projects] = await Promise.all([
          this._request('GET', '/'),
          this._request('GET', '/sessions'),
          this._request('GET', '/projects')
        ]);
        if (token !== this._loadToken) return;
        this.state.clips = {};
        for (const clip of library.clips || []) this.state.clips[clip.id] = clip;
        this.state.status = library.status || null;
        this.state.channels = library.channels || [];
        this.state.polling = !!library.polling;
        this.state.sessions = sessions.sessions || [];
        const dated = new Set();
        for (const session of this.state.sessions) {
          for (const clip of session.clips || []) {
            this.state.clips[clip.id] = clip;
            dated.add(clip.id);
          }
        }
        this.state.undated = (library.clips || []).filter((clip) => !dated.has(clip.id));
        this.state.projects = projects.projects || [];
        const first = !this.state.loaded;
        this.state.loaded = true;
        if (!quiet) this._status('');
        this._renderFilters();
        this._renderSummary();
        this._renderProjects();
        this._renderSessions(!first);
        if (first && this.getAttribute('clip') && this.state.clips[this.getAttribute('clip')]) this.open(this.getAttribute('clip'));
        this._schedulePoll();
      } catch (error) {
        if (token !== this._loadToken) return;
        this._status(error.message, true);
      }
    }

    _schedulePoll (soon) {
      if (this._pollTimer) clearTimeout(this._pollTimer);
      this._pollTimer = null;
      const waiting = this.state.status && this.state.status.pending > 0;
      if (!waiting && !soon) return;
      this._pollTimer = setTimeout(() => {
        this._pollTimer = null;
        if (this.isConnected) this.load(true);
      }, soon ? 5000 : POLL_MS);
    }

    async refresh () {
      const button = this.shadowRoot.querySelector('[data-action="refresh"]');
      button.disabled = true;
      try {
        await this._request('POST', '/refresh');
        this._status('Checking Discord for new clips…');
        this._schedulePoll(true);
      } catch (error) {
        this._status(error.status === 409 ? 'This server is not checking Discord right now.' : error.message, true);
      } finally {
        setTimeout(() => { button.disabled = false; }, 5000);
      }
    }

    // ------------------------------------------------------------ filters

    _filters () {
      return {
        query: this.ref.search.value.trim().toLowerCase(),
        pilot: this.ref.pilot.value,
        channel: this.ref.channel.value,
        sort: this.ref.sort.value,
        links: this.ref.links.checked
      };
    }

    _matches (clip, f) {
      if (!clip) return false;
      if (!f.links && clip.kind === 'link' && !clip.proxyUrl) return false;
      if (f.pilot && clip.author !== f.pilot) return false;
      if (f.channel && clip.channel !== f.channel) return false;
      if (!f.query) return true;
      const haystack = [clip.caption, clip.author, clip.filename, clip.channel, clip.thread, clip.linkUrl].filter(Boolean).join(' ').toLowerCase();
      return f.query.split(/\s+/).every((word) => haystack.includes(word));
    }

    _renderFilters () {
      const pilots = new Map();
      const channels = new Map();
      for (const clip of Object.values(this.state.clips)) {
        if (clip.author) pilots.set(clip.author, (pilots.get(clip.author) || 0) + 1);
        if (clip.channel) channels.set(clip.channel, (channels.get(clip.channel) || 0) + 1);
      }
      const options = (select, map, all) => {
        const current = select.value;
        select.innerHTML = `<option value="">${esc(all)}</option>` + Array.from(map.entries())
          .sort((a, b) => a[0].localeCompare(b[0], undefined, { sensitivity: 'base' }))
          .map(([name, n]) => `<option value="${esc(name)}"${name === current ? ' selected' : ''}>${esc(name)} (${n})</option>`)
          .join('');
        if (current && !map.has(current)) select.value = '';
      };
      options(this.ref.pilot, pilots, 'Every pilot');
      options(this.ref.channel, channels, 'Every channel');
      this.ref.channel.classList.toggle('hidden', channels.size < 2);
    }

    _renderSummary () {
      const clips = Object.values(this.state.clips);
      const s = this.state.status || {};
      const pilots = new Set(clips.map((clip) => clip.author).filter(Boolean)).size;
      const parts = [
        `${plural(clips.length, 'clip')} from ${plural(pilots, 'pilot')} in ${plural(this.state.sessions.length, 'session')}`
      ];
      if (s.pending) parts.push(`${s.pending} still processing`);
      const channels = this.state.channels.map((c) => `#${c.name}`).join(', ');
      if (channels) parts.push(channels);
      if (s.polledAt) parts.push(`checked ${ago(Date.parse(s.polledAt))}`);
      this.ref.summary.textContent = parts.join(' · ');
      this.shadowRoot.querySelector('[data-action="refresh"]').classList.toggle('hidden', !this.state.polling);
      if (s.error) this._status(`Last check: ${s.error}`, true);
    }

    _renderProjects () {
      const projects = this.state.projects;
      this.ref.projectsSection.classList.toggle('hidden', !projects.length);
      this.ref.projects.innerHTML = projects.map((p) => `
        <a class="project" href="${esc(this.base)}/projects/${encodeURIComponent(p.id)}">
          <strong>${esc(p.name)}</strong>
          <span class="muted">${p.segments ? `${plural(p.segments, 'cut')}, ${duration(p.durationMs)}` : 'No cuts yet'} · ${esc(ago(Date.parse(p.updatedAt)))}</span>
        </a>`).join('');
    }

    // ------------------------------------------------------------ sessions

    _groups (f) {
      const start = (clip) => Date.parse(clip.recordedAt);
      const groups = this.state.sessions.map((session) => ({
        session,
        clips: session.clips
          .filter((clip) => this._matches(clip, f))
          .sort((a, b) => (start(a) - start(b)) || String(a.id).localeCompare(String(b.id)))
      })).filter((group) => group.clips.length);
      const order = {
        newest: (a, b) => Date.parse(b.session.startsAt) - Date.parse(a.session.startsAt),
        oldest: (a, b) => Date.parse(a.session.startsAt) - Date.parse(b.session.startsAt),
        angles: (a, b) => (b.session.authors.length - a.session.authors.length) || (b.clips.length - a.clips.length),
        longest: (a, b) => b.session.durationMs - a.session.durationMs
      }[f.sort] || (() => 0);
      groups.sort(order);
      const undated = this.state.undated.filter((clip) => this._matches(clip, f));
      if (undated.length) groups.push({ session: null, clips: undated });
      return groups;
    }

    _renderSessions (keepShown) {
      const f = this._filters();
      const groups = this._groups(f);
      if (!keepShown || !this.state.shown) this.state.shown = this.pageSize;
      const shown = groups.slice(0, this.state.shown);
      if (this._observer) this._observer.disconnect();
      if (!groups.length) {
        const any = Object.keys(this.state.clips).length;
        this.ref.sessions.innerHTML = `<div class="empty">${any
          ? 'No clips match. Try another search or pilot.'
          : 'No clips yet. Post a video in a clips channel on our Discord and it shows up here at the next check.'}</div>`;
      } else {
        this.ref.sessions.innerHTML = shown.map((group) => this._sessionHtml(group)).join('');
      }
      this.ref.more.classList.toggle('hidden', groups.length <= shown.length);
      this.ref.more.querySelector('button').textContent = `Show more sessions (${groups.length - shown.length} left)`;
      this._lazyThumbs();
    }

    _sessionHtml (group) {
      const cards = group.clips.map((clip) => this._cardHtml(clip)).join('');
      // Wide enough for up to four clips side by side; bigger sessions take the whole row.
      const span = Math.min(group.clips.length, 4);
      const box = `class="session${group.clips.length > 4 ? ' wide' : ''}" style="--span:${span}"`;
      if (!group.session) {
        return `<section ${box}>
          <div class="session-head"><h3>Not dated yet</h3><span class="muted">${plural(group.clips.length, 'clip')} still being processed or without a recording time</span></div>
          <div class="grid">${cards}</div>
        </section>`;
      }
      const s = group.session;
      const startMs = Date.parse(s.startsAt);
      const endMs = Date.parse(s.endsAt);
      const start = clockTime(startMs);
      const end = clockTime(endMs);
      const filtered = group.clips.length !== s.clipCount ? ` (${group.clips.length} shown)` : '';
      const pilots = s.authors.length > 4 ? `${s.authors.slice(0, 3).join(', ')} +${s.authors.length - 3}` : s.authors.join(', ');
      return `<section ${box} data-session="${esc(s.id)}">
        <div class="session-head">
          <h3>${esc(dayLabel(startMs))} · ${esc(start)}${end && end !== start ? `–${esc(end)}` : ''}</h3>
          <span class="muted">${esc(longDuration(s.durationMs))} · ${plural(s.clipCount, 'clip')}${filtered} · ${esc(pilots)}</span>
          <span class="actions">
            <a class="button" href="${esc(this.timeline)}?session=${encodeURIComponent(s.id)}">Open timeline</a>
            <button type="button" class="primary" data-action="start" data-session="${esc(s.id)}">Start a project</button>
          </span>
        </div>
        <div class="grid">${cards}</div>
      </section>`;
    }

    _cardHtml (clip) {
      const status = clip.proxyUrl ? 'ready' : clip.kind === 'link' ? 'link' : (clip.proxy && clip.proxy.status) || 'pending';
      const recorded = Date.parse(clip.recordedAt);
      let inner = '';
      if (status === 'ready' && clip.thumbsUrl && clip.proxy.thumbs) {
        const t = clip.proxy.thumbs;
        inner = `<div class="frame" data-thumbs="${esc(clip.thumbsUrl)}" style="aspect-ratio:${t.width} / ${t.height};background-size:${t.columns * 100}% ${t.rows * 100}%"></div>`;
      } else if (status === 'link') {
        inner = `<span class="placeholder">Link to ${esc(hostOf(clip.linkUrl))}</span>`;
      } else if (status === 'failed') {
        inner = '<span class="placeholder">Could not load this video</span>';
      } else {
        inner = '<span class="placeholder">Processing…</span>';
      }
      const badge = clip.durationMs ? `<span class="badge">${duration(clip.durationMs)}</span>` : '';
      const angles = this._angles(clip).length;
      const angleBadge = angles ? `<span class="badge left">+${plural(angles, 'angle')}</span>` : '';
      const caption = String(clip.caption || '')
        .replace(/\[([^\]]*)\]\(<?https?:\/\/[^)\s]*>?\)/g, (link, label) => (/^\d*$/.test(label.trim()) ? '' : label))
        .replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
      return `<button type="button" class="card" data-clip="${esc(clip.id)}" title="${esc(clip.filename || clip.caption || '')}">
        <div class="thumb ${esc(status)}">${inner}${badge}${angleBadge}</div>
        <div class="meta">
          <div class="who"><strong>${esc(clip.author || 'Unknown pilot')}</strong><span class="when">${Number.isFinite(recorded) ? esc(clockTime(recorded)) : ''}</span></div>
          ${caption ? `<div class="caption">${esc(caption)}</div>` : ''}
        </div>
      </button>`;
    }

    _lazyThumbs () {
      const frames = Array.from(this.ref.sessions.querySelectorAll('.frame[data-thumbs]'));
      const show = (el) => {
        if (el.style.backgroundImage) return;
        el.style.backgroundImage = `url("${el.getAttribute('data-thumbs')}")`;
        this._showFrame(el, null);
      };
      if (typeof root.IntersectionObserver !== 'function') {
        frames.forEach(show);
        return;
      }
      this._observer = new root.IntersectionObserver((entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          show(entry.target);
          this._observer.unobserve(entry.target);
        }
      }, { rootMargin: '300px' });
      frames.forEach((el) => this._observer.observe(el));
    }

    _showFrame (el, fraction) {
      const card = el.closest('[data-clip]');
      const clip = card && this.state.clips[card.getAttribute('data-clip')];
      const t = clip && clip.proxy && clip.proxy.thumbs;
      if (!t || !t.count) return;
      const index = fraction === null
        ? Math.floor(t.count / 3)
        : Math.min(t.count - 1, Math.max(0, Math.floor(fraction * t.count)));
      const col = index % t.columns;
      const row = Math.floor(index / t.columns);
      const x = t.columns > 1 ? (col / (t.columns - 1)) * 100 : 0;
      const y = t.rows > 1 ? (row / (t.rows - 1)) * 100 : 0;
      el.style.backgroundPosition = `${x}% ${y}%`;
    }

    // Clips from other pilots in the same session that overlap this one.
    _angles (clip) {
      const start = Date.parse(clip.recordedAt);
      const end = start + (clip.durationMs || 0);
      if (!Number.isFinite(start) || !clip.durationMs) return [];
      const session = this.state.sessions.find((s) => s.clips.some((c) => c.id === clip.id));
      if (!session) return [];
      return session.clips.filter((other) => {
        if (other.id === clip.id || !other.proxyUrl || !other.durationMs || other.author === clip.author) return false;
        const os = Date.parse(other.recordedAt);
        return Number.isFinite(os) && os < end && os + other.durationMs > start;
      });
    }

    async startProject (sessionId) {
      const session = this.state.sessions.find((s) => s.id === sessionId);
      if (!session) return;
      const name = `${dayLabel(Date.parse(session.startsAt))} ${clockTime(Date.parse(session.startsAt))}`;
      try {
        const project = await this._request('POST', '/projects', { name, sessionId });
        const path = `${this.base}/projects/${encodeURIComponent(project.id)}`;
        const event = new CustomEvent('projectopen', { cancelable: true, detail: { id: project.id, path } });
        if (this.dispatchEvent(event)) root.location.assign(path);
      } catch (error) {
        this._status(error.message, true);
      }
    }

    // ------------------------------------------------------------ player

    _visibleIds () {
      return Array.from(this.ref.sessions.querySelectorAll('[data-clip]')).map((el) => el.getAttribute('data-clip'));
    }

    open (id, at) {
      const clip = this.state.clips[id];
      if (!clip) return;
      const wasOpen = !!this.state.openId;
      this.state.openId = id;
      const overlay = this.ref.overlay;
      const recorded = Date.parse(clip.recordedAt);
      const posted = Date.parse(clip.postedAt);
      const rec = clip.recording || {};
      const angles = this._angles(clip);
      const session = this.state.sessions.find((s) => s.clips.some((c) => c.id === clip.id));
      const media = clip.proxyUrl
        ? `<video data-ref-video controls autoplay playsinline preload="metadata" src="${esc(clip.proxyUrl)}"></video>`
        : `<div class="linkbox">${clip.kind === 'link'
          ? `<span>This clip is a link.</span>${clip.linkUrl ? `<a class="button primary" href="${esc(clip.linkUrl)}" target="_blank" rel="noopener">Watch on ${esc(hostOf(clip.linkUrl))}</a>` : ''}`
          : `<span>${clip.proxy && clip.proxy.status === 'failed' ? 'This video could not be loaded.' : 'This video is still being processed.'}</span>`}</div>`;
      const anglesHtml = angles.length
        ? `<h4 class="muted" style="margin:0.8em 0 0.2em">Other angles</h4><div class="row angles">${angles.map((other) => `<button type="button" data-angle="${esc(other.id)}">${esc(other.author)}</button>`).join('')}</div>`
        : '';
      overlay.innerHTML = `<div class="player">
        <div>${media}</div>
        <div>
          <div class="top">
            <button type="button" data-action="prev" title="Previous clip (←)" aria-label="Previous clip">‹</button>
            <button type="button" data-action="next" title="Next clip (→)" aria-label="Next clip">›</button>
            <button type="button" data-action="close" title="Close (Esc)" aria-label="Close">✕</button>
          </div>
          <h3>${esc(clip.author || 'Unknown pilot')}</h3>
          ${clip.caption ? `<div class="caption">${esc(clip.caption)}</div>` : ''}
          <dl>
            ${Number.isFinite(recorded) ? `<dt>Recorded</dt><dd>${esc(dateTime(recorded))} <span class="muted">(${esc(SOURCE_LABEL[rec.source] || rec.source || 'unknown')})</span></dd>` : ''}
            ${Number.isFinite(posted) ? `<dt>Posted</dt><dd>${esc(dateTime(posted))}</dd>` : ''}
            ${clip.durationMs ? `<dt>Length</dt><dd>${duration(clip.durationMs)}</dd>` : ''}
            ${clip.width && clip.height ? `<dt>Original</dt><dd>${clip.width}×${clip.height}${clip.hasAudio === false ? ', no sound' : ''}</dd>` : ''}
            ${clip.channel ? `<dt>Channel</dt><dd>#${esc(clip.channel)}${clip.thread ? ` › ${esc(clip.thread)}` : ''}${clip.guild ? ` <span class="muted">${esc(clip.guild)}</span>` : ''}</dd>` : ''}
            ${clip.filename ? `<dt>File</dt><dd>${esc(clip.filename)}</dd>` : ''}
          </dl>
          <div class="row">
            ${clip.messageUrl ? `<a class="button" href="${esc(clip.messageUrl)}" target="_blank" rel="noopener">View on Discord</a>` : ''}
            ${session ? `<a class="button primary" href="${esc(this.timeline)}?clip=${encodeURIComponent(clip.id)}">Open in timeline</a>` : ''}
          </div>
          ${anglesHtml}
        </div>
      </div>`;
      overlay.classList.remove('hidden');
      const video = overlay.querySelector('video');
      if (video && at) video.addEventListener('loadedmetadata', () => { video.currentTime = Math.min(at, video.duration || at); }, { once: true });
      if (!wasOpen) this._lastFocus = this.shadowRoot.activeElement;
      overlay.querySelector('[data-action="close"]').focus({ preventScroll: true });
      this.dispatchEvent(new CustomEvent('clipopen', { detail: { id } }));
    }

    close () {
      if (!this.state.openId) return;
      const id = this.state.openId;
      this.state.openId = null;
      const video = this.ref.overlay.querySelector('video');
      if (video) video.pause();
      this.ref.overlay.innerHTML = '';
      this.ref.overlay.classList.add('hidden');
      if (this._lastFocus && this._lastFocus.isConnected) this._lastFocus.focus({ preventScroll: true });
      this.dispatchEvent(new CustomEvent('clipclose', { detail: { id } }));
    }

    _step (delta) {
      const ids = this._visibleIds();
      const index = ids.indexOf(this.state.openId);
      const next = ids[index + delta];
      if (next) this.open(next);
    }

    _switchAngle (otherId) {
      const clip = this.state.clips[this.state.openId];
      const other = this.state.clips[otherId];
      if (!clip || !other) return;
      const video = this.ref.overlay.querySelector('video');
      const now = Date.parse(clip.recordedAt) + ((video && video.currentTime) || 0) * 1000;
      const at = Math.max(0, Math.min((other.durationMs || 0) / 1000, (now - Date.parse(other.recordedAt)) / 1000));
      this.open(otherId, at);
    }

    // ------------------------------------------------------------ events

    _bind () {
      const sr = this.shadowRoot;
      let typing = null;
      this.ref.search.addEventListener('input', () => {
        clearTimeout(typing);
        typing = setTimeout(() => this._renderSessions(), 150);
      });
      for (const name of ['pilot', 'channel', 'sort', 'links']) {
        this.ref[name].addEventListener('change', () => this._renderSessions());
      }
      sr.addEventListener('click', (event) => {
        const target = event.target.closest('[data-action], [data-clip], [data-angle]');
        if (!target) {
          if (event.target === this.ref.overlay) this.close();
          return;
        }
        const action = target.getAttribute('data-action');
        if (action === 'refresh') this.refresh();
        else if (action === 'more') {
          this.state.shown += this.pageSize;
          this._renderSessions(true);
        } else if (action === 'start') this.startProject(target.getAttribute('data-session'));
        else if (action === 'close') this.close();
        else if (action === 'prev') this._step(-1);
        else if (action === 'next') this._step(1);
        else if (target.hasAttribute('data-angle')) this._switchAngle(target.getAttribute('data-angle'));
        else if (target.hasAttribute('data-clip')) this.open(target.getAttribute('data-clip'));
      });
      this.ref.sessions.addEventListener('pointermove', (event) => {
        const frame = event.target.closest && event.target.closest('.thumb') && event.target.closest('.thumb').querySelector('.frame[data-thumbs]');
        if (!frame || !frame.style.backgroundImage) return;
        const box = frame.getBoundingClientRect();
        if (box.width) this._showFrame(frame, (event.clientX - box.left) / box.width);
      });
      this.ref.sessions.addEventListener('pointerout', (event) => {
        const thumb = event.target.closest && event.target.closest('.thumb');
        if (!thumb || (event.relatedTarget && thumb.contains(event.relatedTarget))) return;
        const frame = thumb.querySelector('.frame[data-thumbs]');
        if (frame && frame.style.backgroundImage) this._showFrame(frame, null);
      });
      this._onKey = (event) => {
        if (!this.state.openId) return;
        if (event.key === 'Escape') {
          event.preventDefault();
          this.close();
        } else if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.altKey && !event.metaKey && !event.ctrlKey) {
          const video = this.ref.overlay.querySelector('video');
          if (video && event.composedPath().includes(video)) return;
          event.preventDefault();
          this._step(event.key === 'ArrowLeft' ? -1 : 1);
        }
      };
    }
  }

  function hostOf (url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return 'another site';
    }
  }

  root.customElements.define('clip-library', ClipLibrary);
})(typeof window !== 'undefined' ? window : null);
