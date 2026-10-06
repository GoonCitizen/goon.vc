'use strict';

/**
 * <fabric-calendar> — self-contained week calendar for Fabric sites.
 *
 * Renders a server-drawn SVG board and puts every control on it:
 *   - the board title picks the server (when `src` lists more than one),
 *   - the zone label picks the time zone (defaults to the visitor's own),
 *   - the subtitle shows `description`, the "as of" line the event counts,
 *   - the footer downloads the current view as SVG.
 *
 * Attributes:
 *   board                    SVG endpoint; receives `?server=<id>&tz=<IANA zone>`
 *   src                      optional JSON summary `{ events, guilds: [{ id, name, count }], fetchedAt, stale }`
 *   description              replaces the board subtitle
 *   server                   selected server id (default `all`)
 *   time-zone                selected IANA zone (default: visitor's local zone)
 *   default-time-zone        fallback and pinned zone (default `UTC`)
 *   default-time-zone-label  picker label for the pinned zone
 *   storage-key              remember the picked zone in localStorage under this key
 *   sync-url                 mirror `server` / `tz` in the page query string
 *
 * Board SVG contract (all optional; a missing hook just drops that control):
 *   #schedule-title, #schedule-subtitle, #schedule-timezone, #schedule-asof, #schedule-legend
 *
 * Emits `change` with `detail: { server, timeZone }` when the visitor picks either.
 */
(function (root) {
  if (!root || typeof root.HTMLElement !== 'function' || !root.customElements) return;
  if (root.customElements.get('fabric-calendar')) return;

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CARET = ' \u25BE';

  const STYLE = `
    :host { display: block; }
    .wrap { position: relative; }
    .board { aspect-ratio: 16 / 9; background: #0c0c0d; border: 1px solid #2c2c30; }
    .board svg { display: block; height: auto; width: 100%; }
    .board a:hover rect { filter: brightness(1.35); }
    .board a:hover #schedule-download { fill: #fff; text-decoration: underline; }
    .status { color: #9a9488; font-size: 0.9em; padding: 2em; text-align: center; }
    /* Invisible native selects laid over board labels, so clicking a label opens its picker. */
    .picker { cursor: pointer; display: none; opacity: 0; position: absolute; z-index: 1; }
    .picker[data-picker="server"]:hover ~ .board #schedule-title,
    .picker[data-picker="server"]:focus-visible ~ .board #schedule-title,
    .picker[data-picker="zone"]:hover ~ .board #schedule-timezone,
    .picker[data-picker="zone"]:focus-visible ~ .board #schedule-timezone { fill: #fff; text-decoration: underline; }`;

  function validZone (tz) {
    if (!tz) return null;
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: tz }).resolvedOptions().timeZone;
    } catch (_) {
      return null;
    }
  }

  function zoneName (zone) {
    return String(zone).replace(/_/g, ' ');
  }

  function plural (n, word) {
    return n + ' ' + word + (n === 1 ? '' : 's');
  }

  class FabricCalendar extends root.HTMLElement {
    static get observedAttributes () {
      return ['board', 'src', 'description', 'server', 'time-zone'];
    }

    constructor () {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style>${STYLE}</style>
        <div class="wrap" part="wrap">
          <select class="picker" data-picker="server" aria-label="Server"></select>
          <select class="picker" data-picker="zone" aria-label="Time zone"></select>
          <div class="board" part="board" aria-busy="true"></div>
        </div>`;
      this._board = this.shadowRoot.querySelector('.board');
      this._serverPicker = this.shadowRoot.querySelector('[data-picker="server"]');
      this._zonePicker = this.shadowRoot.querySelector('[data-picker="zone"]');
      this._summary = null;
      this._started = false;
      this._request = 0;
      this._serverPicker.addEventListener('change', () => this._pick({ server: this._serverPicker.value }));
      this._zonePicker.addEventListener('change', () => this._pick({ timeZone: this._zonePicker.value }));
    }

    get server () {
      return this._server || 'all';
    }

    set server (value) {
      this.setAttribute('server', value || 'all');
    }

    get timeZone () {
      return this._timeZone;
    }

    set timeZone (value) {
      this.setAttribute('time-zone', value);
    }

    get _defaultZone () {
      return validZone(this.getAttribute('default-time-zone')) || 'UTC';
    }

    get _homeZone () {
      return validZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || this._defaultZone;
    }

    connectedCallback () {
      const params = this.hasAttribute('sync-url') ? new URLSearchParams(root.location.search) : new URLSearchParams();
      this._server = params.get('server') || this.getAttribute('server') || 'all';
      this._timeZone = validZone(params.get('tz')) ||
        validZone(this.getAttribute('time-zone')) ||
        validZone(this._stored()) ||
        this._homeZone;

      if (typeof root.ResizeObserver === 'function') {
        this._resizeObserver = new root.ResizeObserver(() => this._place());
        this._resizeObserver.observe(this._board);
      }
      // Pages often keep hidden views in the DOM; wait until this one is shown.
      if (typeof root.IntersectionObserver === 'function') {
        this._visibilityObserver = new root.IntersectionObserver((entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          this._visibilityObserver.disconnect();
          this._start();
        });
        this._visibilityObserver.observe(this);
      } else {
        this._start();
      }
    }

    disconnectedCallback () {
      if (this._resizeObserver) this._resizeObserver.disconnect();
      if (this._visibilityObserver) this._visibilityObserver.disconnect();
    }

    attributeChangedCallback (name, oldValue, value) {
      if (oldValue === value || !this._started) return;
      if (name === 'server') {
        this._server = value || 'all';
        this._serverPicker.value = this._server;
        this._loadBoard();
      } else if (name === 'time-zone') {
        this._timeZone = validZone(value) || this._homeZone;
        this._renderZones();
        this._loadBoard();
      } else if (name === 'src') {
        this.refresh();
      } else {
        this._loadBoard();
      }
    }

    /** Reload the summary and the board. */
    async refresh () {
      await this._loadSummary();
      await this._loadBoard();
    }

    _start () {
      this._started = true;
      this._renderZones();
      this.refresh();
    }

    _stored () {
      const key = this.getAttribute('storage-key');
      if (!key) return null;
      try { return root.localStorage.getItem(key); } catch (_) { return null; }
    }

    _servers () {
      const guilds = (this._summary && Array.isArray(this._summary.guilds)) ? this._summary.guilds : [];
      return [{ id: 'all', name: 'All servers' }].concat(guilds.filter((g) => g && g.count > 0));
    }

    async _loadSummary () {
      const src = this.getAttribute('src');
      if (!src) return;
      try {
        const res = await root.fetch(src, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        this._summary = await res.json();
      } catch (_) {
        this._summary = null;
      }
      if (!this._servers().some((s) => s.id === this.server)) this._server = 'all';
      this._renderServers();
    }

    _boardUrl () {
      const url = new URL(this.getAttribute('board') || '', root.location.href);
      if (this.server !== 'all') url.searchParams.set('server', this.server);
      else url.searchParams.delete('server');
      url.searchParams.set('tz', this._timeZone);
      return url.pathname + url.search;
    }

    async _loadBoard () {
      if (!this.getAttribute('board')) return;
      const request = ++this._request;
      const src = this._boardUrl();
      this._board.setAttribute('aria-busy', 'true');
      let svg = null;
      try {
        const res = await root.fetch(src, { cache: 'no-store' });
        if (!res.ok) throw new Error('board ' + res.status);
        const doc = new root.DOMParser().parseFromString(await res.text(), 'image/svg+xml');
        if (doc.documentElement && doc.documentElement.nodeName.toLowerCase() === 'svg') {
          svg = root.document.importNode(doc.documentElement, true);
        }
      } catch (_) { /* rendered as unavailable below */ }
      if (request !== this._request) return;

      this._board.textContent = '';
      this._board.removeAttribute('aria-busy');
      if (!svg) {
        const status = root.document.createElement('p');
        status.className = 'status';
        status.textContent = 'The calendar is unavailable right now.';
        this._board.appendChild(status);
        this._place();
        return;
      }
      this._decorate(svg, src);
      this._board.appendChild(svg);
      this._place();
    }

    _decorate (svg, src) {
      svg.setAttribute('role', 'group');
      const box = svg.viewBox && svg.viewBox.baseVal;
      if (box && box.width && box.height) this._board.style.aspectRatio = box.width + ' / ' + box.height;

      const title = svg.querySelector('#schedule-title');
      if (title && this._servers().length > 2) title.textContent += CARET;
      const zone = svg.querySelector('#schedule-timezone');
      if (zone) zone.textContent += CARET;
      const subtitle = svg.querySelector('#schedule-subtitle');
      const description = this.getAttribute('description');
      if (subtitle && description) subtitle.textContent = description;
      const asOf = svg.querySelector('#schedule-asof');
      if (asOf && this._summary) {
        const events = Array.isArray(this._summary.events) ? this._summary.events.length : 0;
        const servers = Array.isArray(this._summary.guilds) ? this._summary.guilds.length : 0;
        const notes = [plural(events, 'event') + ' across ' + plural(servers, 'server')];
        if (this._summary.stale) notes.push('offline copy');
        asOf.textContent += ' · ' + notes.join(' · ');
      }

      const legend = svg.querySelector('#schedule-legend');
      if (legend && box && box.width) {
        const link = root.document.createElementNS(SVG_NS, 'a');
        link.setAttribute('href', src);
        link.setAttribute('download', 'calendar.svg');
        const text = root.document.createElementNS(SVG_NS, 'text');
        text.setAttribute('id', 'schedule-download');
        text.setAttribute('x', String(box.width - Number(legend.getAttribute('x') || 0)));
        text.setAttribute('text-anchor', 'end');
        ['y', 'fill', 'font-family', 'font-size'].forEach((attr) => {
          if (legend.hasAttribute(attr)) text.setAttribute(attr, legend.getAttribute(attr));
        });
        text.textContent = 'Download SVG';
        link.appendChild(text);
        svg.appendChild(link);
      }
    }

    _renderServers () {
      this._serverPicker.textContent = '';
      for (const server of this._servers()) {
        const option = root.document.createElement('option');
        option.value = server.id;
        option.textContent = server.name;
        this._serverPicker.appendChild(option);
      }
      this._serverPicker.value = this.server;
    }

    _renderZones () {
      const home = this._homeZone;
      const fallback = this._defaultZone;
      let zones = [];
      try { zones = Intl.supportedValuesOf('timeZone').slice(); } catch (_) { /* list just the pinned zones */ }
      for (const zone of [fallback, 'UTC', home, this._timeZone]) {
        if (zone && zones.indexOf(zone) === -1) zones.push(zone);
      }
      zones.sort();

      const add = (parent, zone, label) => {
        const option = root.document.createElement('option');
        option.value = zone;
        option.textContent = label || zoneName(zone);
        parent.appendChild(option);
      };
      this._zonePicker.textContent = '';
      add(this._zonePicker, home, 'Your time · ' + zoneName(home));
      if (fallback !== home) add(this._zonePicker, fallback, this.getAttribute('default-time-zone-label') || zoneName(fallback));
      const all = root.document.createElement('optgroup');
      all.label = 'All time zones';
      zones.forEach((zone) => add(all, zone));
      this._zonePicker.appendChild(all);
      this._zonePicker.value = this._timeZone;
    }

    _place () {
      const svg = this._board.querySelector('svg');
      this._placeOver(this._serverPicker, svg && svg.querySelector('#schedule-title'), this._servers().length > 2);
      this._placeOver(this._zonePicker, svg && svg.querySelector('#schedule-timezone'), true);
    }

    _placeOver (picker, label, enabled) {
      if (!label || !enabled) {
        picker.style.display = 'none';
        return;
      }
      const box = label.getBoundingClientRect();
      const wrap = picker.parentNode.getBoundingClientRect();
      const pad = 4;
      picker.style.display = 'block';
      picker.style.left = (box.left - wrap.left - pad) + 'px';
      picker.style.top = (box.top - wrap.top - pad) + 'px';
      picker.style.width = (box.width + pad * 2) + 'px';
      picker.style.height = (box.height + pad * 2) + 'px';
    }

    _pick (change) {
      if (change.server) this._server = change.server;
      if (change.timeZone) {
        this._timeZone = validZone(change.timeZone) || this._homeZone;
        const key = this.getAttribute('storage-key');
        if (key) {
          try { root.localStorage.setItem(key, this._timeZone); } catch (_) { /* private mode */ }
        }
      }
      if (this.hasAttribute('sync-url')) {
        const url = new URL(root.location.href);
        if (this.server !== 'all') url.searchParams.set('server', this.server);
        else url.searchParams.delete('server');
        if (this._timeZone !== this._homeZone) url.searchParams.set('tz', this._timeZone);
        else url.searchParams.delete('tz');
        root.history.replaceState(root.history.state, '', url.pathname + url.search + url.hash);
      }
      this.dispatchEvent(new root.CustomEvent('change', {
        bubbles: true,
        detail: { server: this.server, timeZone: this._timeZone }
      }));
      this._loadBoard();
    }
  }

  root.customElements.define('fabric-calendar', FabricCalendar);
})(typeof window !== 'undefined' ? window : undefined);
