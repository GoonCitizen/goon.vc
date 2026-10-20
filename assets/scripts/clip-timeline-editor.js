'use strict';

/**
 * <clip-timeline-editor> — storyboard clips on a recording-time timeline and
 * cut them into a film.
 *
 * Attributes:
 *   src       API base (e.g. `/services/clips`). Nothing loads until it is set.
 *   project   project id; without it the element browses sessions
 *             (timeline, preview, and the project list)
 *   session   session to open first (ignored with `project`)
 *   clip      clip to select first; opens its session
 *   base      page path for project links (default `/clips`)
 *   login     sign-in page shown when the API answers 401
 *
 * API (relative to src): `GET /` clips + status, `GET /sessions`,
 * `PATCH /<clip>` `{ recordedAt?, syncOffsetMs? }`, `POST /refresh`,
 * `GET|POST /projects`, `GET|PATCH /projects/<id>` `{ revision, name, segments }`,
 * `POST /projects/<id>/renders`. Clips carry `proxyUrl` / `thumbsUrl` and
 * `proxy.thumbs` `{ every, count, columns, rows, width, height }` for the sprite.
 *
 * Emits `projectopen` (cancelable; `detail: { id, path }`) before navigating
 * to a project, `projectsave` / `renderstart` after those succeed, and
 * `sessionchange` (`detail: { id }`) when the visitor picks another session.
 *
 * Keys: Space play/pause, I / O mark in / out, Enter add to program,
 * Delete remove the selected segment, ← / → step a frame, Ctrl+S save.
 */
(function (root) {
  if (!root || typeof root.HTMLElement !== 'function' || !root.customElements) return;
  if (root.customElements.get('clip-timeline-editor')) return;

  const LABEL_W = 132;
  const LANE_H = 46;
  const PROXY_FPS = 15;
  const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

  function esc (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function clockTime (ms, withSeconds = true) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString(undefined, withSeconds ? { hour: 'numeric', minute: '2-digit', second: '2-digit' } : { hour: 'numeric', minute: '2-digit' });
  }

  function dateTime (ms) {
    const d = new Date(ms);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function duration (seconds) {
    const s = Math.max(0, Math.round(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor(s / 60) % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
  }

  function timecode (seconds) {
    const s = Math.max(0, Number(seconds) || 0);
    return `${duration(Math.floor(s))}.${String(Math.floor((s % 1) * 10))}`;
  }

  function localInput (ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  const SOURCE_LABEL = {
    metadata: 'file metadata',
    filename: 'file name',
    posted: 'Discord post time',
    manual: 'set by hand',
    unknown: 'unknown'
  };

  const STYLE = `
    :host { display: block; color: #ddd; font: inherit; text-align: left; --accent: #a78bfa; --accent-strong: #7c3aed; --panel: rgba(0, 0, 0, 0.28); --line: rgba(255, 255, 255, 0.14); }
    * { box-sizing: border-box; }
    button, input, select { font: inherit; }
    button { background: transparent; border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 6px; color: #fff; cursor: pointer; padding: 0.3em 0.7em; }
    button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
    button:disabled { cursor: default; opacity: 0.4; }
    button.primary { border-color: var(--accent); background: rgba(124, 58, 237, 0.35); }
    input, select { background: rgba(0, 0, 0, 0.35); border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 4px; color: #fff; padding: 0.3em 0.45em; }
    a { color: #fff; }
    .wrap { outline: none; }
    .muted { color: #999; }
    .error { color: #ff8a8a; }
    .bar { align-items: center; display: flex; flex-wrap: wrap; gap: 0.5em 0.75em; margin-bottom: 0.75em; }
    .bar .grow { flex: 1 1 auto; }
    .bar input[name=name] { flex: 1 1 14em; font-weight: 700; min-width: 10em; }
    .bar select { max-width: 100%; }
    .status { margin: 0 0 0.6em; min-height: 1.2em; }
    .stage { display: grid; gap: 0.75em; grid-template-columns: minmax(0, 3fr) minmax(14em, 2fr); margin-bottom: 0.75em; }
    @media (max-width: 760px) { .stage { grid-template-columns: 1fr; } }
    .viewer { background: #000; border-radius: 6px; overflow: hidden; }
    .viewer video { aspect-ratio: 16 / 9; background: #000; display: block; width: 100%; }
    .transport { align-items: center; background: var(--panel); display: flex; flex-wrap: wrap; gap: 0.4em; padding: 0.45em; }
    .transport .tc { font-variant-numeric: tabular-nums; margin-left: auto; }
    .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; padding: 0.7em 0.8em; }
    .panel h3 { font-size: 0.8em; letter-spacing: 0.12em; margin: 0 0 0.5em; text-transform: uppercase; }
    .panel dl { display: grid; gap: 0.2em 0.6em; grid-template-columns: auto 1fr; margin: 0 0 0.6em; }
    .panel dt { color: #999; }
    .panel dd { margin: 0; overflow-wrap: anywhere; }
    .row { align-items: center; display: flex; flex-wrap: wrap; gap: 0.35em; margin: 0.35em 0; }
    .angles button { font-size: 0.9em; }
    .section-title { font-size: 0.8em; letter-spacing: 0.12em; margin: 1em 0 0.4em; text-transform: uppercase; }
    .timeline { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; position: relative; }
    .timeline-inner { position: relative; }
    .ruler { border-bottom: 1px solid var(--line); height: 22px; margin-left: ${LABEL_W}px; position: relative; }
    .tick { border-left: 1px solid rgba(255, 255, 255, 0.25); color: #aaa; font-size: 0.72em; height: 22px; padding-left: 3px; position: absolute; top: 0; white-space: nowrap; }
    .track { border-bottom: 1px solid var(--line); display: flex; }
    .track-label { background: rgba(0, 0, 0, 0.35); flex: 0 0 ${LABEL_W}px; font-weight: 600; left: 0; overflow: hidden; padding: 0.3em 0.5em; position: sticky; text-overflow: ellipsis; white-space: nowrap; z-index: 2; }
    .track-lanes { flex: 0 0 auto; position: relative; }
    .clip { background-color: #3b2a63; background-repeat: no-repeat; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 4px; cursor: pointer; height: ${LANE_H - 6}px; overflow: hidden; position: absolute; }
    .clip span { background: rgba(0, 0, 0, 0.6); bottom: 0; font-size: 0.72em; left: 0; max-width: 100%; overflow: hidden; padding: 0 3px; position: absolute; text-overflow: ellipsis; white-space: nowrap; }
    .clip.selected { border-color: #fff; box-shadow: 0 0 0 2px var(--accent); }
    .clip.pending { background-image: repeating-linear-gradient(45deg, #3b3b3b 0 6px, #2a2a2a 6px 12px); }
    .clip.failed { background-color: #5b1f1f; }
    .clip.link { background-color: #1f3b5b; border-style: dashed; }
    .clip.used::after { background: var(--accent); content: ''; height: 3px; left: 0; position: absolute; right: 0; top: 0; }
    .playhead { background: #ff5a5a; bottom: 0; pointer-events: none; position: absolute; top: 0; width: 2px; z-index: 3; }
    .program { background: var(--panel); border: 1px solid var(--line); border-radius: 6px; display: flex; gap: 3px; min-height: 64px; overflow-x: auto; padding: 6px; }
    .program .empty { align-self: center; color: #999; padding: 0 0.5em; }
    .segment { background-color: #3b2a63; background-repeat: no-repeat; border: 1px solid rgba(255, 255, 255, 0.35); border-radius: 4px; cursor: grab; flex: 0 0 auto; height: 52px; min-width: 48px; overflow: hidden; position: relative; }
    .segment span { background: rgba(0, 0, 0, 0.65); bottom: 0; font-size: 0.72em; left: 0; overflow: hidden; padding: 0 3px; position: absolute; right: 0; text-overflow: ellipsis; white-space: nowrap; }
    .segment.selected { border-color: #fff; box-shadow: 0 0 0 2px var(--accent); }
    .segment.playing { box-shadow: 0 0 0 2px #ff5a5a; }
    .segment.drop { border-left: 3px solid #fff; }
    .segment .mute { position: absolute; right: 3px; top: 1px; font-size: 0.75em; background: rgba(0, 0, 0, 0.6); padding: 0 3px; border-radius: 3px; }
    table { border-collapse: collapse; font-size: 0.92em; width: 100%; }
    th, td { border-bottom: 1px solid var(--line); padding: 0.35em 0.4em; text-align: left; vertical-align: top; }
    th { color: #aaa; font-size: 0.78em; letter-spacing: 0.1em; text-transform: uppercase; }
    td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .progress { background: rgba(255, 255, 255, 0.12); border-radius: 3px; display: inline-block; height: 8px; vertical-align: middle; width: 8em; }
    .progress i { background: var(--accent); border-radius: 3px; display: block; height: 100%; }
    .hidden { display: none !important; }
  `;

  const SKELETON = `
    <style>${STYLE}</style>
    <div class="wrap" tabindex="0">
      <p class="status" data-ref="status" role="status"></p>
      <div class="bar" data-ref="projectBar">
        <input name="name" maxlength="80" aria-label="Project name">
        <span class="muted" data-ref="revision"></span>
        <button type="button" data-action="save">Save</button>
        <button type="button" class="primary" data-action="render">Render</button>
      </div>
      <div class="bar">
        <label>Session <select data-ref="session" aria-label="Recording session"></select></label>
        <span class="grow"></span>
        <label class="muted">Zoom <input type="range" data-ref="zoom" min="0" max="100" value="0" aria-label="Timeline zoom"></label>
        <button type="button" data-action="refresh" title="Check Discord for new clips">Check Discord</button>
      </div>
      <p class="muted" data-ref="library"></p>
      <div class="stage">
        <div class="viewer">
          <video data-ref="video" playsinline preload="metadata"></video>
          <div class="transport">
            <button type="button" data-action="play" title="Play / pause (Space)">Play</button>
            <button type="button" data-action="mark-in" title="Mark in (I)">In</button>
            <button type="button" data-action="mark-out" title="Mark out (O)">Out</button>
            <button type="button" data-action="add" data-ref="addButton" title="Add to program (Enter)">Add to program</button>
            <button type="button" data-action="play-program" data-ref="playProgram" title="Play the program from the selected segment">Play program</button>
            <span class="tc" data-ref="tc"></span>
          </div>
        </div>
        <div class="panel" data-ref="inspector"></div>
      </div>
      <div class="timeline" data-ref="timeline"><div class="timeline-inner" data-ref="timelineInner"></div></div>
      <div data-ref="programSection">
        <h3 class="section-title">Program <span class="muted" data-ref="programInfo"></span></h3>
        <div class="program" data-ref="program"></div>
        <h3 class="section-title">Sources</h3>
        <div data-ref="sources"></div>
        <h3 class="section-title">Renders</h3>
        <div data-ref="renders"></div>
        <h3 class="section-title">Notes</h3>
        <textarea data-ref="notes" maxlength="2000" rows="3" style="width:100%;background:rgba(0,0,0,0.35);border:1px solid rgba(255,255,255,0.3);border-radius:4px;color:#fff;font:inherit;padding:0.4em" aria-label="Project notes"></textarea>
      </div>
      <div data-ref="projectsSection">
        <h3 class="section-title">Projects</h3>
        <div class="bar">
          <input name="new-project" maxlength="80" placeholder="New project name" aria-label="New project name">
          <button type="button" class="primary" data-action="create">Start a project from this session</button>
        </div>
        <div data-ref="projects"></div>
      </div>
    </div>`;

  class ClipTimelineEditor extends root.HTMLElement {
    static get observedAttributes () {
      return ['src', 'project'];
    }

    constructor () {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = SKELETON;
      this.ref = {};
      this.shadowRoot.querySelectorAll('[data-ref]').forEach((el) => { this.ref[el.getAttribute('data-ref')] = el; });
      this.state = {
        loaded: false,
        clips: {},
        sessions: [],
        projects: [],
        status: null,
        sessionId: null,
        clipId: null,
        markIn: null,
        markOut: null,
        project: null,
        segments: [],
        segmentIndex: null,
        dirty: false,
        programPlaying: null,
        zoom: 0
      };
      this._loadToken = 0;
      this._pollTimer = null;
      this._bind();
    }

    connectedCallback () {
      this._scheduleLoad();
    }

    disconnectedCallback () {
      if (this._pollTimer) clearTimeout(this._pollTimer);
      this._pollTimer = null;
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

    get editing () {
      return !!this.state.project;
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
      const el = this.ref.status;
      if (!message) {
        el.textContent = '';
        return;
      }
      el.className = 'status' + (isError ? ' error' : ' muted');
      el.textContent = message;
    }

    // ------------------------------------------------------------ loading

    async load () {
      const token = ++this._loadToken;
      const projectId = this.getAttribute('project');
      this._status('Loading clips…');
      try {
        const [library, sessions, projects, project] = await Promise.all([
          this._request('GET', '/'),
          this._request('GET', '/sessions'),
          projectId ? Promise.resolve(null) : this._request('GET', '/projects'),
          projectId ? this._request('GET', `/projects/${encodeURIComponent(projectId)}`) : Promise.resolve(null)
        ]);
        if (token !== this._loadToken) return;
        this._applyLibrary(library, sessions.sessions);
        this.state.projects = projects ? projects.projects : [];
        this.state.project = project;
        this.state.segments = project ? project.segments.slice() : [];
        this.state.segmentIndex = null;
        this.state.dirty = false;
        const has = (id) => !!id && this.state.sessions.some((s) => s.id === id);
        const askedClip = this.getAttribute('clip');
        const holding = askedClip ? this.state.sessions.find((s) => s.clips.some((c) => c.id === askedClip)) : null;
        const asked = holding ? holding.id : this.getAttribute('session');
        const wanted = project && has(project.sessionId)
          ? project.sessionId
          : has(asked) ? asked : (this.state.sessions[0] && this.state.sessions[0].id) || null;
        this.state.sessionId = has(this.state.sessionId) ? this.state.sessionId : wanted;
        this.state.loaded = true;
        this._status('');
        this._renderAll();
        if (holding && !this.state.clipId && this.state.sessionId === holding.id) this._selectClip(askedClip, 0);
        this._pollRenders();
      } catch (error) {
        if (token !== this._loadToken) return;
        this._renderAll();
        if (error.status === 401) {
          const login = this.getAttribute('login');
          this.ref.status.className = 'status';
          this.ref.status.innerHTML = `The clips are for members. ${login ? `<a href="${esc(login)}">Sign in</a> to see them.` : 'Sign in to see them.'}`;
        } else {
          this._status(error.message, true);
        }
      }
    }

    _applyLibrary (library, sessions) {
      this.state.clips = {};
      for (const clip of library.clips || []) this.state.clips[clip.id] = clip;
      this.state.status = library.status || null;
      this.state.polling = !!library.polling;
      this.state.channels = library.channels || [];
      this.state.sessions = sessions || [];
      for (const session of this.state.sessions) {
        for (const clip of session.clips || []) this.state.clips[clip.id] = clip;
      }
    }

    async _reloadClips () {
      const [library, sessions] = await Promise.all([this._request('GET', '/'), this._request('GET', '/sessions')]);
      const before = this._session();
      this._applyLibrary(library, sessions.sessions);
      if (before && !this.state.sessions.some((s) => s.id === this.state.sessionId)) {
        // The session's first clip moved; follow the selected clip instead.
        const follow = this.state.sessions.find((s) => s.clips.some((c) => c.id === this.state.clipId));
        this.state.sessionId = follow ? follow.id : (this.state.sessions[0] && this.state.sessions[0].id) || null;
      }
      this._renderAll();
    }

    _session () {
      return this.state.sessions.find((s) => s.id === this.state.sessionId) || null;
    }

    _clip (id) {
      return this.state.clips[id || this.state.clipId] || null;
    }

    _clipStartMs (clip) {
      return Date.parse(clip && clip.recordedAt);
    }

    // ------------------------------------------------------------ rendering

    _renderAll () {
      const editing = this.editing;
      this.ref.projectBar.classList.toggle('hidden', !editing);
      this.ref.programSection.classList.toggle('hidden', !editing);
      this.ref.projectsSection.classList.toggle('hidden', editing || !this.state.loaded);
      this.ref.addButton.classList.toggle('hidden', !editing);
      this.ref.playProgram.classList.toggle('hidden', !editing);
      this.shadowRoot.querySelector('[data-action="refresh"]').classList.toggle('hidden', !this.state.polling);
      if (editing) {
        const name = this.shadowRoot.querySelector('input[name=name]');
        if (this.shadowRoot.activeElement !== name) name.value = this.state.project.name;
        if (this.shadowRoot.activeElement !== this.ref.notes) this.ref.notes.value = this.state.project.notes || '';
      }
      this._renderLibraryLine();
      this._renderSessionSelect();
      this._renderTimeline();
      this._renderInspector();
      this._renderProgram();
      this._renderSources();
      this._renderRenders();
      this._renderProjects();
      this._renderRevision();
    }

    _renderRevision () {
      if (!this.editing) return;
      const p = this.state.project;
      this.ref.revision.textContent = `rev ${p.revision}${this.state.dirty ? ' · unsaved changes' : ''}${p.updatedBy ? ` · saved by ${p.updatedBy}` : ''}`;
    }

    _renderLibraryLine () {
      const s = this.state.status;
      if (!s || !this.state.loaded) {
        this.ref.library.textContent = '';
        return;
      }
      const parts = [`${s.ready || 0} clips ready`];
      if (s.pending) parts.push(`${s.pending} processing`);
      if (s.failed) parts.push(`${s.failed} could not be read`);
      if (s.linksOnly) parts.push(`${s.linksOnly} links (not imported)`);
      const channels = (this.state.channels || []).map((c) => `#${c.name}${c.guild ? ` (${c.guild})` : ''}`).join(', ');
      if (channels) parts.push(`from ${channels}`);
      if (s.polledAt) parts.push(`checked ${dateTime(Date.parse(s.polledAt))}`);
      this.ref.library.textContent = parts.join(' · ') + (s.error ? ` · last check failed: ${s.error}` : '');
    }

    _renderSessionSelect () {
      const select = this.ref.session;
      if (!this.state.sessions.length) {
        select.innerHTML = '<option value="">No clips yet</option>';
        select.disabled = true;
        return;
      }
      select.disabled = false;
      select.innerHTML = this.state.sessions.map((s) => {
        const label = `${dateTime(Date.parse(s.startsAt))} · ${duration(s.durationMs / 1000)} · ${s.authors.slice(0, 4).join(', ')}${s.authors.length > 4 ? ` +${s.authors.length - 4}` : ''} (${s.clipCount} clip${s.clipCount === 1 ? '' : 's'})`;
        return `<option value="${esc(s.id)}"${s.id === this.state.sessionId ? ' selected' : ''}>${esc(label)}</option>`;
      }).join('');
    }

    _pps (session) {
      const seconds = Math.max(1, session.durationMs / 1000);
      const width = Math.max(200, (this.ref.timeline.clientWidth || 800) - LABEL_W - 16);
      const fit = width / seconds;
      // Zoom runs from "whole session fits" to 120 px per second, exponentially.
      const max = Math.max(fit, 120);
      return fit * Math.pow(max / fit, this.state.zoom / 100);
    }

    _sprite (clip, seconds, height) {
      const t = clip && clip.proxy && clip.proxy.thumbs;
      if (!t || !clip.thumbsUrl) return '';
      const frame = Math.max(0, Math.min(t.count - 1, Math.floor(seconds / t.every)));
      const scale = height / t.height;
      const w = t.width * scale;
      return `background-image:url('${clip.thumbsUrl}');background-size:${t.columns * w}px ${t.rows * height}px;` +
        `background-position:${-(frame % t.columns) * w}px ${-Math.floor(frame / t.columns) * height}px;`;
    }

    _renderTimeline () {
      const inner = this.ref.timelineInner;
      const session = this._session();
      if (!session) {
        inner.innerHTML = `<p class="muted" style="padding:0.75em">${this.state.loaded ? 'No clips found in the clip channels yet.' : ''}</p>`;
        return;
      }
      const pps = this._pps(session);
      this._timelinePps = pps;
      const width = Math.ceil((session.durationMs / 1000) * pps) + 24;
      const start = Date.parse(session.startsAt);
      const step = TICK_STEPS.find((s) => s * pps >= 90) || TICK_STEPS[TICK_STEPS.length - 1];
      const ticks = [];
      for (let s = 0; s <= session.durationMs / 1000; s += step) {
        ticks.push(`<div class="tick" style="left:${s * pps}px">${esc(clockTime(start + s * 1000, step < 60))}</div>`);
      }
      const used = new Set(this.state.segments.map((seg) => seg.clipId));
      const tracks = session.tracks.map((track) => {
        const blocks = track.clips.map((entry) => {
          const clip = this._clip(entry.id) || {};
          const status = clip.kind === 'link' ? 'link' : (clip.proxy && clip.proxy.status);
          const cls = ['clip', status === 'ready' ? '' : status, entry.id === this.state.clipId ? 'selected' : '', used.has(entry.id) ? 'used' : ''].filter(Boolean).join(' ');
          const left = (entry.offsetMs / 1000) * pps;
          const w = Math.max(6, (entry.durationMs / 1000) * pps);
          const title = `${clip.author || ''} · ${clip.filename || clip.linkUrl || ''} · ${clockTime(this._clipStartMs(clip))}${status !== 'ready' ? ` · ${status === 'link' ? 'link only' : status}` : ''}`;
          return `<div class="${cls}" data-clip="${esc(entry.id)}" title="${esc(title)}" style="left:${left}px;top:${entry.lane * LANE_H + 3}px;width:${w}px;${this._sprite(clip, 0, LANE_H - 6)}"><span>${esc(clip.filename || clip.author || '')}</span></div>`;
        }).join('');
        return `<div class="track"><div class="track-label" style="height:${track.lanes * LANE_H}px" title="${esc(track.author)}">${esc(track.author)}</div>` +
          `<div class="track-lanes" style="width:${width}px;height:${track.lanes * LANE_H}px">${blocks}</div></div>`;
      }).join('');
      inner.style.width = `${LABEL_W + width}px`;
      inner.innerHTML = `<div class="ruler" style="width:${width}px">${ticks.join('')}</div>${tracks}<div class="playhead hidden" data-ref-playhead></div>`;
      this._updatePlayhead();
    }

    _updatePlayhead () {
      const head = this.ref.timelineInner.querySelector('[data-ref-playhead]');
      const session = this._session();
      const clip = this._clip();
      if (!head || !session || !clip || !this._timelinePps) return head && head.classList.add('hidden');
      const offset = (this._clipStartMs(clip) - Date.parse(session.startsAt)) / 1000 + (this.ref.video.currentTime || 0);
      if (offset < 0 || offset > session.durationMs / 1000 + 1) return head.classList.add('hidden');
      head.classList.remove('hidden');
      head.style.left = `${LABEL_W + offset * this._timelinePps}px`;
      this.ref.tc.textContent = `${timecode(this.ref.video.currentTime)} / ${timecode(clip.durationMs / 1000)}` +
        `${this.state.markIn !== null ? ` · in ${timecode(this.state.markIn)}` : ''}${this.state.markOut !== null ? ` · out ${timecode(this.state.markOut)}` : ''}` +
        ` · ${clockTime(this._clipStartMs(clip) + (this.ref.video.currentTime || 0) * 1000)}`;
    }

    _anglesNow () {
      const clip = this._clip();
      const session = this._session();
      if (!clip || !session) return [];
      const instant = this._clipStartMs(clip) + (this.ref.video.currentTime || 0) * 1000;
      return session.clips.filter((other) => other.id !== clip.id && other.proxyUrl &&
        this._clipStartMs(other) <= instant && instant < this._clipStartMs(other) + (other.durationMs || 0))
        .map((other) => ({ clip: other, at: (instant - this._clipStartMs(other)) / 1000 }));
    }

    _renderInspector () {
      const el = this.ref.inspector;
      const clip = this._clip();
      const segment = this.state.segmentIndex !== null ? this.state.segments[this.state.segmentIndex] : null;
      if (!clip) {
        el.innerHTML = `<h3>Clip</h3><p class="muted">${this.state.loaded ? 'Pick a clip on the timeline. Hover a clip to scrub its thumbnails; click to preview from that moment.' : ''}</p>`;
        return;
      }
      const rec = clip.recording || {};
      const manual = clip.override && clip.override.recordedAt;
      const source = manual ? 'manual' : rec.source;
      const sync = (clip.override && clip.override.syncOffsetMs) || 0;
      const angles = this._anglesNow();
      const status = clip.kind === 'link' ? 'Link only (not imported)' : clip.proxy.status === 'ready' ? null : clip.proxy.status === 'failed' ? `Could not be read: ${clip.proxy.error || 'unknown error'}` : 'Still processing';
      el.innerHTML = `
        <h3>${segment ? `Segment ${this.state.segmentIndex + 1}` : 'Clip'}</h3>
        <dl>
          <dt>Pilot</dt><dd>${esc(clip.author)}</dd>
          <dt>Channel</dt><dd>#${esc(clip.channel)}${clip.guild ? ` <span class="muted">(${esc(clip.guild)})</span>` : ''}</dd>
          <dt>Source</dt><dd><a href="${esc(clip.messageUrl)}" target="_blank" rel="noopener noreferrer">Discord message</a>${clip.linkUrl ? ` · <a href="${esc(clip.linkUrl)}" target="_blank" rel="noopener noreferrer">link</a>` : ''}</dd>
          ${clip.filename ? `<dt>File</dt><dd>${esc(clip.filename)}</dd>` : ''}
          ${clip.caption ? `<dt>Caption</dt><dd>${esc(clip.caption)}</dd>` : ''}
          <dt>Recorded</dt><dd>${esc(dateTime(this._clipStartMs(clip)))} <span class="muted">${esc(clockTime(this._clipStartMs(clip)))}</span><br><span class="muted">from ${esc(SOURCE_LABEL[source] || source || 'unknown')}${manual ? '' : ` · ${esc(rec.confidence || 'low')} confidence`}${sync ? ` · nudged ${sync > 0 ? '+' : ''}${(sync / 1000).toFixed(1)}s` : ''}</span></dd>
          <dt>Posted</dt><dd>${esc(dateTime(Date.parse(clip.postedAt)))}</dd>
          <dt>Length</dt><dd>${clip.durationMs ? esc(duration(clip.durationMs / 1000)) : '—'}${clip.width ? ` · ${clip.width}×${clip.height}` : ''}${clip.hasAudio === false ? ' · no audio' : ''}</dd>
          ${status ? `<dt>Status</dt><dd class="${clip.proxy.status === 'failed' ? 'error' : 'muted'}">${esc(status)}</dd>` : ''}
        </dl>
        <div class="row" title="Shift this clip on the timeline to line it up with the other angles">
          <span class="muted">Sync</span>
          <button type="button" data-nudge="-1000">−1s</button><button type="button" data-nudge="-100">−0.1s</button>
          <button type="button" data-nudge="100">+0.1s</button><button type="button" data-nudge="1000">+1s</button>
          ${sync ? '<button type="button" data-nudge="reset">Reset</button>' : ''}
        </div>
        <div class="row">
          <input type="datetime-local" step="1" data-ref-recorded value="${esc(localInput(this._clipStartMs(clip) - sync))}" aria-label="Recording start (your time)">
          <button type="button" data-action="set-recorded">Set start</button>
          ${manual ? '<button type="button" data-action="clear-recorded">Use estimate</button>' : ''}
        </div>
        ${angles.length ? `<div class="row angles"><span class="muted">Other angles now:</span>${angles.map((a) => `<button type="button" data-angle="${esc(a.clip.id)}" data-at="${a.at}">${esc(a.clip.author)}</button>`).join('')}</div>` : ''}
        ${segment ? this._segmentControls(segment) : ''}`;
    }

    _segmentControls (segment) {
      return `
        <h3 style="margin-top:0.8em">Segment</h3>
        <div class="row">
          <label>In <input type="number" step="0.1" min="0" data-seg="in" value="${segment.in}" style="width:6em"></label>
          <label>Out <input type="number" step="0.1" min="0" data-seg="out" value="${segment.out}" style="width:6em"></label>
          <span class="muted">${esc(duration(segment.out - segment.in))}</span>
        </div>
        <div class="row">
          <button type="button" data-action="seg-in">In from playhead</button>
          <button type="button" data-action="seg-out">Out from playhead</button>
        </div>
        <div class="row">
          <label><input type="checkbox" data-seg="mute"${segment.audio === 'mute' ? ' checked' : ''}> Mute</label>
          <label>Volume <input type="range" min="0" max="2" step="0.05" data-seg="volume" value="${segment.volume === undefined ? 1 : segment.volume}"></label>
        </div>
        <div class="row">
          <button type="button" data-action="seg-left">← Earlier</button>
          <button type="button" data-action="seg-right">Later →</button>
          <button type="button" data-action="seg-remove">Remove</button>
        </div>`;
    }

    _renderProgram () {
      if (!this.editing) return;
      const el = this.ref.program;
      const segs = this.state.segments;
      const total = segs.reduce((sum, s) => sum + (s.out - s.in), 0);
      this.ref.programInfo.textContent = segs.length ? `· ${segs.length} segment${segs.length === 1 ? '' : 's'} · ${duration(total)}` : '';
      if (!segs.length) {
        el.innerHTML = '<span class="empty">Mark a range on a clip and press Add to program.</span>';
        return;
      }
      const width = Math.max(300, (el.clientWidth || 800) - 20);
      const pps = Math.max(2, Math.min(40, width / Math.max(1, total)));
      el.innerHTML = segs.map((seg, i) => {
        const clip = this._clip(seg.clipId) || {};
        const cls = ['segment', i === this.state.segmentIndex ? 'selected' : '', i === this.state.programPlaying ? 'playing' : ''].filter(Boolean).join(' ');
        const w = Math.max(48, (seg.out - seg.in) * pps);
        return `<div class="${cls}" draggable="true" data-segment="${i}" title="${esc(`${clip.author || ''} · ${timecode(seg.in)}–${timecode(seg.out)}`)}" style="width:${w}px;${this._sprite(clip, seg.in, 52)}">` +
          `${seg.audio === 'mute' ? '<b class="mute">muted</b>' : ''}<span>${i + 1}. ${esc(clip.author || '?')} · ${esc(duration(seg.out - seg.in))}</span></div>`;
      }).join('');
    }

    _renderSources () {
      if (!this.editing) return;
      const segs = this.state.segments;
      if (!segs.length) {
        this.ref.sources.innerHTML = '<p class="muted">Every segment\'s source shows here.</p>';
        return;
      }
      let at = 0;
      const rows = segs.map((seg, i) => {
        const clip = this._clip(seg.clipId) || {};
        const rec = clip.recording || {};
        const manual = clip.override && clip.override.recordedAt;
        const row = `<tr>
            <td class="num">${i + 1}</td>
            <td class="num">${esc(timecode(at))}</td>
            <td>${esc(clip.author || '?')}</td>
            <td>#${esc(clip.channel || '?')}<br><a href="${esc(clip.messageUrl || '#')}" target="_blank" rel="noopener noreferrer">message</a></td>
            <td>${esc(clip.filename || clip.linkUrl || '')}</td>
            <td class="num">${esc(timecode(seg.in))}–${esc(timecode(seg.out))}</td>
            <td>${esc(clockTime(this._clipStartMs(clip) + seg.in * 1000))}<br><span class="muted">${esc(SOURCE_LABEL[manual ? 'manual' : rec.source] || '')}${manual ? '' : `, ${esc(rec.confidence || 'low')}`}</span></td>
          </tr>`;
        at += seg.out - seg.in;
        return row;
      }).join('');
      this.ref.sources.innerHTML = `<table><thead><tr><th>#</th><th>At</th><th>Pilot</th><th>Where</th><th>File</th><th>Range</th><th>Recorded</th></tr></thead><tbody>${rows}</tbody></table>`;
    }

    _renderRenders () {
      if (!this.editing) return;
      const renders = this.state.project.renders || [];
      if (!renders.length) {
        this.ref.renders.innerHTML = '<p class="muted">Render the program to cut it from the full-resolution originals on Discord.</p>';
        return;
      }
      this.ref.renders.innerHTML = `<table><thead><tr><th>Started</th><th>By</th><th>Rev</th><th>Length</th><th>Status</th><th></th></tr></thead><tbody>${renders.map((r) => `<tr>
          <td>${esc(dateTime(Date.parse(r.createdAt)))}</td>
          <td>${esc(r.createdBy || '')}</td>
          <td class="num">${esc(r.revision)}</td>
          <td class="num">${esc(duration((r.durationMs || 0) / 1000))}</td>
          <td>${r.status === 'running' ? `<span class="progress"><i style="width:${Math.round((r.progress || 0) * 100)}%"></i></span> ${Math.round((r.progress || 0) * 100)}%` : r.status === 'failed' ? `<span class="error">Failed: ${esc(r.error || '')}</span>` : esc(r.status)}</td>
          <td>${r.status === 'complete' ? `<a href="${esc(r.fileUrl)}">Download</a> · <a href="${esc(r.sourcesUrl)}" target="_blank">Sources</a>${r.bytes ? ` <span class="muted">${(r.bytes / 1048576).toFixed(1)} MB</span>` : ''}` : ''}</td>
        </tr>`).join('')}</tbody></table>`;
    }

    _renderProjects () {
      if (this.editing || !this.state.loaded) return;
      const list = this.state.projects;
      this.ref.projects.innerHTML = list.length
        ? `<table><thead><tr><th>Project</th><th>Segments</th><th>Length</th><th>Saved</th><th>Renders</th></tr></thead><tbody>${list.map((p) => `<tr>
            <td><a href="${esc(`${this.base}/projects/${encodeURIComponent(p.id)}`)}" data-open="${esc(p.id)}">${esc(p.name)}</a></td>
            <td class="num">${esc(p.segments)}</td>
            <td class="num">${esc(duration(p.durationMs / 1000))}</td>
            <td>${esc(dateTime(Date.parse(p.updatedAt)))}${p.updatedBy ? ` <span class="muted">by ${esc(p.updatedBy)}</span>` : ''}</td>
            <td class="num">${esc(p.renders)}</td>
          </tr>`).join('')}</tbody></table>`
        : '<p class="muted">No projects yet. Pick a session above and start one.</p>';
      const input = this.shadowRoot.querySelector('input[name="new-project"]');
      const session = this._session();
      if (session && !input.value) input.placeholder = `${dateTime(Date.parse(session.startsAt))} — ${session.authors.slice(0, 3).join(', ')}`;
    }

    // ------------------------------------------------------------ preview

    _selectClip (id, at, keepSegment) {
      const clip = this._clip(id);
      if (!clip) return;
      const changed = this.state.clipId !== id;
      this.state.clipId = id;
      if (!keepSegment) this.state.segmentIndex = null;
      if (changed) {
        this.state.markIn = null;
        this.state.markOut = null;
      }
      const video = this.ref.video;
      if (clip.proxyUrl) {
        const seek = () => { video.currentTime = Math.max(0, Math.min(at || 0, (clip.durationMs || 0) / 1000)); };
        if (changed || !video.src) {
          video.src = clip.proxyUrl;
          video.addEventListener('loadedmetadata', seek, { once: true });
        } else {
          seek();
        }
      } else {
        video.removeAttribute('src');
        video.load();
      }
      this.shadowRoot.querySelectorAll('.clip.selected').forEach((el) => el.classList.remove('selected'));
      const block = this.shadowRoot.querySelector(`.clip[data-clip="${CSS.escape(id)}"]`);
      if (block) block.classList.add('selected');
      this._renderInspector();
      this._renderProgram();
      this._updatePlayhead();
    }

    _togglePlay () {
      const video = this.ref.video;
      if (!video.src) return;
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    }

    _step (frames) {
      const video = this.ref.video;
      if (!video.src) return;
      video.pause();
      video.currentTime = Math.max(0, video.currentTime + frames / PROXY_FPS);
    }

    _mark (which) {
      if (!this._clip() || !this.ref.video.src) return;
      const t = Number(this.ref.video.currentTime.toFixed(3));
      if (which === 'in') this.state.markIn = t;
      else this.state.markOut = t;
      this._updatePlayhead();
    }

    _addToProgram () {
      const clip = this._clip();
      if (!this.editing || !clip || !clip.proxyUrl) return;
      const length = (clip.durationMs || 0) / 1000;
      let start = this.state.markIn !== null ? this.state.markIn : 0;
      let end = this.state.markOut !== null ? this.state.markOut : length;
      if (end < start) [start, end] = [end, start];
      if (end - start < 0.1) {
        this._status('Mark an out point after the in point first.', true);
        return;
      }
      const at = this.state.segmentIndex !== null ? this.state.segmentIndex + 1 : this.state.segments.length;
      this.state.segments.splice(at, 0, { clipId: clip.id, in: Number(start.toFixed(3)), out: Number(end.toFixed(3)), audio: 'on', volume: 1 });
      this.state.segmentIndex = at;
      this.state.markIn = null;
      this.state.markOut = null;
      this._changed();
    }

    _changed () {
      this.state.dirty = true;
      this._status('');
      this._renderProgram();
      this._renderSources();
      this._renderInspector();
      this._renderRevision();
      this._markUsed();
    }

    _markUsed () {
      const used = new Set(this.state.segments.map((seg) => seg.clipId));
      this.shadowRoot.querySelectorAll('.clip[data-clip]').forEach((el) => el.classList.toggle('used', used.has(el.getAttribute('data-clip'))));
    }

    _selectSegment (index, play) {
      const seg = this.state.segments[index];
      if (!seg) return;
      this.state.segmentIndex = index;
      const session = this.state.sessions.find((s) => s.clips.some((c) => c.id === seg.clipId));
      if (session && session.id !== this.state.sessionId) {
        this.state.sessionId = session.id;
        this._renderSessionSelect();
        this._renderTimeline();
      }
      this._selectClip(seg.clipId, seg.in, true);
      if (play) {
        const video = this.ref.video;
        const start = () => video.play().catch(() => {});
        if (video.readyState >= 1) start();
        else video.addEventListener('loadedmetadata', start, { once: true });
      }
    }

    _playProgram () {
      if (!this.state.segments.length) return;
      this.state.programPlaying = this.state.segmentIndex !== null ? this.state.segmentIndex : 0;
      this._selectSegment(this.state.programPlaying, true);
    }

    _onTimeUpdate () {
      this._updatePlayhead();
      const playing = this.state.programPlaying;
      if (playing === null) return;
      const seg = this.state.segments[playing];
      if (!seg || seg.clipId !== this.state.clipId) {
        this.state.programPlaying = null;
        return;
      }
      if (this.ref.video.currentTime >= seg.out - 0.03) {
        const next = playing + 1;
        if (next >= this.state.segments.length) {
          this.ref.video.pause();
          this.state.programPlaying = null;
          this._renderProgram();
          return;
        }
        this.state.programPlaying = next;
        this._selectSegment(next, true);
      }
    }

    // ------------------------------------------------------------ actions

    async _nudge (value) {
      const clip = this._clip();
      if (!clip) return;
      const current = (clip.override && clip.override.syncOffsetMs) || 0;
      const syncOffsetMs = value === 'reset' ? 0 : current + Number(value);
      await this._patchClip(clip.id, { syncOffsetMs });
    }

    async _patchClip (id, body) {
      try {
        const updated = await this._request('PATCH', `/${encodeURIComponent(id)}`, body);
        this.state.clips[id] = updated;
        await this._reloadClips();
        this._selectClip(id, this.ref.video.currentTime || 0, this.state.segmentIndex !== null);
      } catch (error) {
        this._status(error.message, true);
      }
    }

    async _save () {
      if (!this.editing) return null;
      const name = this.shadowRoot.querySelector('input[name=name]').value;
      try {
        this._status('Saving…');
        const project = await this._request('PATCH', `/projects/${encodeURIComponent(this.state.project.id)}`, {
          revision: this.state.project.revision,
          name,
          notes: this.ref.notes.value,
          sessionId: this.state.sessionId,
          segments: this.state.segments
        });
        this.state.project = project;
        this.state.segments = project.segments.slice();
        this.state.dirty = false;
        this._status(`Saved revision ${project.revision}.`);
        this._renderAll();
        this.dispatchEvent(new CustomEvent('projectsave', { detail: { id: project.id, revision: project.revision } }));
        return project;
      } catch (error) {
        this._status(error.message, true);
        return null;
      }
    }

    async _render () {
      if (!this.editing) return;
      if (this.state.dirty && !await this._save()) return;
      try {
        const render = await this._request('POST', `/projects/${encodeURIComponent(this.state.project.id)}/renders`);
        this.state.project.renders = [render].concat(this.state.project.renders || []);
        this._status('Render queued. The originals are fetched from Discord and cut at full resolution.');
        this._renderRenders();
        this.dispatchEvent(new CustomEvent('renderstart', { detail: { id: render.id, projectId: this.state.project.id } }));
        this._pollRenders();
      } catch (error) {
        this._status(error.message, true);
      }
    }

    _pollRenders () {
      if (this._pollTimer) clearTimeout(this._pollTimer);
      this._pollTimer = null;
      if (!this.editing) return;
      const active = (this.state.project.renders || []).some((r) => r.status === 'queued' || r.status === 'running');
      if (!active) return;
      this._pollTimer = setTimeout(async () => {
        try {
          const project = await this._request('GET', `/projects/${encodeURIComponent(this.state.project.id)}`);
          this.state.project.renders = project.renders;
          this._renderRenders();
        } catch (_) { /* keep polling */ }
        this._pollRenders();
      }, 2000);
    }

    async _create () {
      const input = this.shadowRoot.querySelector('input[name="new-project"]');
      const session = this._session();
      const name = input.value.trim() || input.placeholder;
      if (!name || name.length < 2) {
        this._status('Give the project a name.', true);
        return;
      }
      try {
        const project = await this._request('POST', '/projects', { name, sessionId: session ? session.id : null });
        this._open(project.id);
      } catch (error) {
        this._status(error.message, true);
      }
    }

    _open (id) {
      const path = `${this.base}/projects/${encodeURIComponent(id)}`;
      const event = new CustomEvent('projectopen', { detail: { id, path }, cancelable: true });
      if (this.dispatchEvent(event)) window.location.assign(path);
    }

    async _refreshDiscord () {
      try {
        await this._request('POST', '/refresh');
        this._status('Checking Discord for new clips… new clips appear here as their previews are built.');
        setTimeout(() => this._reloadClips().catch(() => {}), 8000);
      } catch (error) {
        this._status(error.message, true);
      }
    }

    _updateSegment (field, value) {
      const seg = this.state.segments[this.state.segmentIndex];
      if (!seg) return;
      const clip = this._clip(seg.clipId) || {};
      const length = (clip.durationMs || 0) / 1000;
      if (field === 'in') seg.in = Math.max(0, Math.min(Number(value) || 0, seg.out - 0.1));
      if (field === 'out') seg.out = Math.min(length || Infinity, Math.max(Number(value) || 0, seg.in + 0.1));
      if (field === 'mute') seg.audio = value ? 'mute' : 'on';
      if (field === 'volume') seg.volume = Number(value);
      seg.in = Number(seg.in.toFixed(3));
      seg.out = Number(seg.out.toFixed(3));
      this.state.dirty = true;
      this._renderProgram();
      this._renderSources();
      this._renderRevision();
    }

    _moveSegment (from, to) {
      const segs = this.state.segments;
      if (from === to || from < 0 || to < 0 || from >= segs.length || to > segs.length) return;
      const [seg] = segs.splice(from, 1);
      const index = to > from ? to - 1 : to;
      segs.splice(index, 0, seg);
      this.state.segmentIndex = index;
      this._changed();
    }

    _bind () {
      const sr = this.shadowRoot;
      const video = this.ref.video;
      video.addEventListener('timeupdate', () => this._onTimeUpdate());
      video.addEventListener('seeked', () => this._updatePlayhead());
      video.addEventListener('play', () => { sr.querySelector('[data-action="play"]').textContent = 'Pause'; });
      video.addEventListener('pause', () => { sr.querySelector('[data-action="play"]').textContent = 'Play'; this._renderInspector(); });

      this.ref.session.addEventListener('change', () => {
        this.state.sessionId = this.ref.session.value;
        this._renderTimeline();
        this._renderProjects();
        this.dispatchEvent(new CustomEvent('sessionchange', { detail: { id: this.state.sessionId } }));
      });
      this.ref.zoom.addEventListener('input', () => {
        const session = this._session();
        const timeline = this.ref.timeline;
        const center = session && this._timelinePps ? (timeline.scrollLeft + timeline.clientWidth / 2 - LABEL_W) / this._timelinePps : 0;
        this.state.zoom = Number(this.ref.zoom.value);
        this._renderTimeline();
        if (session) timeline.scrollLeft = Math.max(0, center * this._timelinePps + LABEL_W - timeline.clientWidth / 2);
      });
      this.ref.notes.addEventListener('input', () => {
        this.state.dirty = true;
        this._renderRevision();
      });
      sr.querySelector('input[name=name]').addEventListener('input', () => {
        this.state.dirty = true;
        this._renderRevision();
      });

      // Thumbnail scrubbing on the timeline.
      this.ref.timeline.addEventListener('mousemove', (event) => {
        const block = event.target.closest && event.target.closest('.clip[data-clip]');
        if (!block) return;
        const clip = this._clip(block.getAttribute('data-clip'));
        const rect = block.getBoundingClientRect();
        const t = ((event.clientX - rect.left) / rect.width) * ((clip && clip.durationMs) || 0) / 1000;
        const style = this._sprite(clip, t, LANE_H - 6);
        if (style) block.style.cssText = block.style.cssText.replace(/background-[^;]*;/g, '') + style;
      });
      this.ref.timeline.addEventListener('click', (event) => {
        const block = event.target.closest && event.target.closest('.clip[data-clip]');
        if (!block) return;
        const id = block.getAttribute('data-clip');
        const clip = this._clip(id);
        const rect = block.getBoundingClientRect();
        const t = ((event.clientX - rect.left) / rect.width) * ((clip && clip.durationMs) || 0) / 1000;
        this.state.programPlaying = null;
        this._selectClip(id, t);
      });

      this.ref.program.addEventListener('click', (event) => {
        const block = event.target.closest && event.target.closest('[data-segment]');
        if (!block) return;
        this.state.programPlaying = null;
        this._selectSegment(Number(block.getAttribute('data-segment')), false);
      });
      this.ref.program.addEventListener('dragstart', (event) => {
        const block = event.target.closest && event.target.closest('[data-segment]');
        if (!block) return;
        this._dragFrom = Number(block.getAttribute('data-segment'));
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(this._dragFrom));
      });
      this.ref.program.addEventListener('dragover', (event) => {
        if (this._dragFrom === undefined) return;
        event.preventDefault();
        sr.querySelectorAll('.segment.drop').forEach((el) => el.classList.remove('drop'));
        const block = event.target.closest && event.target.closest('[data-segment]');
        if (block) block.classList.add('drop');
      });
      this.ref.program.addEventListener('drop', (event) => {
        if (this._dragFrom === undefined) return;
        event.preventDefault();
        const block = event.target.closest && event.target.closest('[data-segment]');
        const to = block ? Number(block.getAttribute('data-segment')) : this.state.segments.length;
        const from = this._dragFrom;
        this._dragFrom = undefined;
        this._moveSegment(from, to);
      });
      this.ref.program.addEventListener('dragend', () => {
        this._dragFrom = undefined;
        sr.querySelectorAll('.segment.drop').forEach((el) => el.classList.remove('drop'));
      });

      this.ref.inspector.addEventListener('change', (event) => {
        const field = event.target.getAttribute && event.target.getAttribute('data-seg');
        if (!field) return;
        this._updateSegment(field, field === 'mute' ? event.target.checked : event.target.value);
        if (field === 'in' || field === 'out') this._renderInspector();
      });

      sr.addEventListener('click', (event) => {
        const target = event.target.closest ? event.target.closest('[data-action],[data-nudge],[data-angle],[data-open]') : null;
        if (!target) return;
        if (target.hasAttribute('data-open')) {
          event.preventDefault();
          this._open(target.getAttribute('data-open'));
          return;
        }
        if (target.hasAttribute('data-nudge')) return this._nudge(target.getAttribute('data-nudge'));
        if (target.hasAttribute('data-angle')) {
          const wasPlaying = !video.paused;
          this._selectClip(target.getAttribute('data-angle'), Number(target.getAttribute('data-at')));
          if (wasPlaying) video.addEventListener('seeked', () => video.play().catch(() => {}), { once: true });
          return;
        }
        const seg = this.state.segments[this.state.segmentIndex];
        switch (target.getAttribute('data-action')) {
          case 'play': return this._togglePlay();
          case 'mark-in': return this._mark('in');
          case 'mark-out': return this._mark('out');
          case 'add': return this._addToProgram();
          case 'play-program': return this._playProgram();
          case 'save': return this._save();
          case 'render': return this._render();
          case 'create': return this._create();
          case 'refresh': return this._refreshDiscord();
          case 'set-recorded': {
            const input = sr.querySelector('[data-ref-recorded]');
            const ms = new Date(input.value).getTime();
            if (!Number.isFinite(ms)) return this._status('Pick a date and time.', true);
            return this._patchClip(this.state.clipId, { recordedAt: new Date(ms).toISOString() });
          }
          case 'clear-recorded': return this._patchClip(this.state.clipId, { recordedAt: null });
          case 'seg-in': return seg && seg.clipId === this.state.clipId && (this._updateSegment('in', video.currentTime), this._renderInspector());
          case 'seg-out': return seg && seg.clipId === this.state.clipId && (this._updateSegment('out', video.currentTime), this._renderInspector());
          case 'seg-left': return this._moveSegment(this.state.segmentIndex, this.state.segmentIndex - 1);
          case 'seg-right': return this._moveSegment(this.state.segmentIndex, this.state.segmentIndex + 2);
          case 'seg-remove': {
            this.state.segments.splice(this.state.segmentIndex, 1);
            this.state.segmentIndex = null;
            return this._changed();
          }
        }
      });

      sr.querySelector('.wrap').addEventListener('keydown', (event) => {
        const tag = event.composedPath()[0] && event.composedPath()[0].tagName;
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
          event.preventDefault();
          this._save();
          return;
        }
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag || '')) return;
        const key = event.key;
        if (key === ' ') this._togglePlay();
        else if (key === 'i' || key === 'I') this._mark('in');
        else if (key === 'o' || key === 'O') this._mark('out');
        else if (key === 'Enter') this._addToProgram();
        else if (key === 'ArrowLeft') this._step(-1);
        else if (key === 'ArrowRight') this._step(1);
        else if ((key === 'Delete' || key === 'Backspace') && this.state.segmentIndex !== null) {
          this.state.segments.splice(this.state.segmentIndex, 1);
          this.state.segmentIndex = null;
          this._changed();
        } else return;
        event.preventDefault();
      });

      root.addEventListener('beforeunload', (event) => {
        if (this.state.dirty && this.isConnected) {
          event.preventDefault();
          event.returnValue = '';
        }
      });
      if (typeof root.ResizeObserver === 'function') {
        let last = 0;
        new root.ResizeObserver(() => {
          const width = this.ref.timeline.clientWidth;
          if (!this.state.loaded || Math.abs(width - last) < 40) return;
          last = width;
          this._renderTimeline();
          this._renderProgram();
        }).observe(this.ref.timeline);
      }
    }
  }

  root.customElements.define('clip-timeline-editor', ClipTimelineEditor);
})(typeof window !== 'undefined' ? window : null);
