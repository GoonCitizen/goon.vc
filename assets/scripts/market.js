// Compiled from components/MarketPage.js by `npm run build`. Edit the component, not this file.
'use strict';

(function client () {
  const hosts = ['market-page', 'market-listing-page', 'market-seller-page', 'market-order-page', 'market-mine-page']
    .map((id) => document.getElementById(id))
    .filter(Boolean);
  if (!hosts.length) return;
  const host = hosts[0];
  const base = (host.getAttribute('data-base') || '/services/market').replace(/\/+$/, '');
  const loginPath = host.getAttribute('data-login') || '/sessions';
  const siteTitle = host.getAttribute('data-site-title') || 'GOON SQUAD';
  const path = (window.location.pathname || '/').replace(/\/+$/, '');
  const lower = path.toLowerCase();
  const baseLower = base.toLowerCase();
  if (lower !== baseLower && lower.indexOf(baseLower + '/') !== 0) return;
  const rest = path.slice(base.length).split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch (e) { return part; }
  });

  const STEP_LABELS = { 'awaiting-payment': 'Payment', paid: 'In escrow', delivered: 'Delivered', released: 'Paid out', refunded: 'Refunded' };
  const STEP_INDEX = { 'awaiting-payment': 0, paid: 1, refunding: 1, delivered: 2, disputed: 2, releasing: 2, released: 4, refunded: 4 };
  const ACTION_LABELS = { cancel: 'Cancel order', delivered: 'I delivered it', release: 'Release to seller', refund: 'Refund the buyer', dispute: 'Open a dispute' };
  const EXPLORERS = { mainnet: 'https://mempool.space', testnet: 'https://mempool.space/testnet', signet: 'https://mempool.space/signet' };

  function esc (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function request (method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
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

  function when (iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function day (iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function note (el, message, isError) {
    if (!el) return;
    el.textContent = message || '';
    el.className = 'market-note' + (isError ? ' error' : '');
  }

  function busy (form, value) {
    form.querySelectorAll('button').forEach((button) => { button.disabled = value; });
  }

  function statusBadge (listing) {
    return `<span class="market-status ${esc(listing.status)}">${esc(listing.statusLabel || listing.status)}</span>`;
  }

  function signIn (what) {
    return `<p><a class="goon-button" href="${esc(loginPath)}">Sign in to ${esc(what)}</a></p>`;
  }

  function setTitle (text) {
    document.title = `${text} · Market — ${siteTitle}`;
  }

  function formFields (form) {
    const out = {};
    ['title', 'kind', 'price', 'qty', 'insurance', 'msrpUsd', 'source', 'giftable', 'contents', 'imageUrl', 'notes'].forEach((name) => {
      if (form.elements[name]) out[name] = form.elements[name].value;
    });
    if (out.qty === '') out.qty = 1;
    return out;
  }

  function fillFields (form, listing) {
    const set = (name, value) => { if (form.elements[name]) form.elements[name].value = value === null || value === undefined ? '' : value; };
    set('title', listing.title);
    set('kind', listing.kind);
    set('price', listing.priceSats !== null ? `${listing.priceSats} sats` : '');
    set('qty', listing.qty);
    set('insurance', listing.insurance);
    set('msrpUsd', listing.msrpUsd !== null ? `$${listing.msrpUsd}` : '');
    set('source', listing.source);
    set('giftable', listing.giftable === null ? '' : (listing.giftable ? 'yes' : 'no'));
    set('contents', listing.contents);
    set('imageUrl', listing.imageUrl && /^https:/i.test(listing.imageUrl) ? listing.imageUrl : '');
    set('notes', listing.notes);
  }

  function priceHtml (listing) {
    if (listing.priceSats === null) return `<div class="market-price">${esc(listing.price.label)}</div>`;
    const sub = [listing.price.sats, listing.price.usd].filter(Boolean).join(' · ');
    return `<div class="market-price">${esc(listing.price.btc)}</div><div class="market-price-sub">${esc(sub)}</div>`;
  }

  // Percent-encode what could end a CSS url('…') string before HTML escaping
  // (an escaped apostrophe is decoded back by the browser inside the attribute).
  function cssUrl (value) {
    return String(value).replace(/['"()\\\s]/g, (c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`);
  }

  function card (listing) {
    const image = listing.imageUrl
      ? `<div class="market-card-image" style="background-image: url('${esc(cssUrl(listing.imageUrl))}')"></div>`
      : `<div class="market-card-image empty">${esc(listing.kind)}</div>`;
    const meta = [listing.kind, listing.qty > 1 ? `×${listing.qty}` : null, listing.insurance].filter(Boolean).join(' · ');
    return `<a class="market-card" href="${esc(listing.path)}">
        ${image}
        <div class="market-card-body">
          <div class="market-card-title">${esc(listing.title)}</div>
          ${priceHtml(listing)}
          <div class="market-meta">${statusBadge(listing)} ${esc(meta)}</div>
          <div class="market-meta">${esc(listing.seller.name)}${listing.replies ? ` · ${listing.replies} repl${listing.replies === 1 ? 'y' : 'ies'}` : ''}</div>
        </div>
      </a>`;
  }

  function cards (listings) {
    if (!listings.length) return '<p class="market-muted">Nothing matches.</p>';
    return `<div class="market-cards">${listings.map(card).join('')}</div>`;
  }

  function table (listings, opts) {
    if (!listings.length) return '<p class="market-muted">Nothing matches.</p>';
    const select = opts && opts.select;
    const rows = listings.map((l) => `<tr>
        ${select ? `<td><input type="checkbox" name="pick" value="${esc(l.id)}" aria-label="Select ${esc(l.title)}"></td>` : ''}
        <td><a href="${esc(l.path)}">${esc(l.title)}</a>${l.contents ? `<br><span class="market-muted">${esc(l.contents.slice(0, 90))}</span>` : ''}</td>
        <td>${esc(l.kind)}</td>
        <td class="num">${esc(l.qty)}</td>
        <td>${esc(l.insurance || '')}</td>
        <td class="num">${esc(l.price.btc || l.price.label)}</td>
        <td class="num">${esc(l.price.usd || '')}</td>
        <td>${statusBadge(l)}</td>
        ${select ? '' : `<td><a href="${esc(l.seller.path)}">${esc(l.seller.name)}</a></td>`}
        <td class="num">${esc(day(l.activityAt))}</td>
      </tr>`).join('');
    return `<table class="market-table">
        <thead><tr>${select ? '<th></th>' : ''}<th>Item</th><th>Kind</th><th class="num">Qty</th><th>Insurance</th><th class="num">Price</th><th class="num">≈ USD</th><th>Status</th>${select ? '' : '<th>Seller</th>'}<th class="num">Updated</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function rateLine (rate, forum) {
    const parts = [];
    if (rate && rate.usdPerBtc) parts.push(`Dollar amounts are a reference at $${Math.round(rate.usdPerBtc).toLocaleString()} per BTC from ${esc(rate.source)}${rate.stale ? ' (stale)' : ''}; listings are priced in BTC.`);
    if (forum && forum.syncedAt) parts.push(`Forum synced ${esc(when(forum.syncedAt))}.`);
    return parts.join(' ');
  }

  /* ---------- catalog ---------- */

  async function showCatalog () {
    const page = document.getElementById('market-page');
    const form = document.getElementById('market-filters');
    const results = document.getElementById('market-results');
    const kindsEl = document.getElementById('market-kinds');
    const params = new URLSearchParams(window.location.search);
    let view = params.get('view') === 'table' ? 'table' : 'cards';
    let kind = params.get('kind') || '';
    ['q', 'status', 'source', 'sort'].forEach((name) => { if (params.get(name)) form.elements[name].value = params.get(name); });
    let data = null;

    const query = () => {
      const q = new URLSearchParams();
      ['q', 'status', 'source', 'sort'].forEach((name) => {
        const value = form.elements[name].value.trim();
        if (value && !(name === 'sort' && value === 'recent')) q.set(name, value);
      });
      if (kind) q.set('kind', kind);
      return q;
    };

    const render = () => {
      if (!data) return;
      form.querySelectorAll('[data-view]').forEach((button) => button.setAttribute('aria-pressed', String(button.getAttribute('data-view') === view)));
      kindsEl.innerHTML = [''].concat(data.kinds).map((k) => {
        const count = k ? (data.counts.kinds[k] || 0) : null;
        if (k && !count) return '';
        return `<li><button type="button" data-kind="${esc(k)}" aria-pressed="${String(k === kind)}">${esc(k || 'All')}${count !== null ? `<span class="count">${count}</span>` : ''}</button></li>`;
      }).join('');
      results.innerHTML = view === 'table' ? table(data.listings) : cards(data.listings);
      document.getElementById('market-rate').innerHTML = rateLine(data.rate, data.forum);
      const forumLink = document.getElementById('market-forum-link');
      if (data.forum && data.forum.url) {
        forumLink.href = data.forum.url;
        forumLink.textContent = data.forum.name ? `#${data.forum.name} on Discord` : 'Market forum';
        forumLink.hidden = false;
      }
    };

    let seq = 0;
    const load = async () => {
      const mine = ++seq;
      const q = query();
      const url = `${base}${q.toString() ? `?${q}` : ''}`;
      const shown = new URLSearchParams(q);
      if (view === 'table') shown.set('view', 'table');
      history.replaceState(null, '', `${path}${shown.toString() ? `?${shown}` : ''}`);
      try {
        const next = await request('GET', url);
        if (mine !== seq) return;
        data = next;
        render();
      } catch (error) {
        if (mine === seq) results.innerHTML = `<p class="market-note error">${esc(error.message)}</p>`;
      }
    };

    let timer = null;
    form.addEventListener('input', (event) => {
      clearTimeout(timer);
      timer = setTimeout(load, event.target.name === 'q' ? 250 : 0);
    });
    form.addEventListener('submit', (event) => { event.preventDefault(); load(); });
    form.addEventListener('click', (event) => {
      const button = event.target.closest('[data-view]');
      if (!button) return;
      view = button.getAttribute('data-view');
      const shown = query();
      if (view === 'table') shown.set('view', 'table');
      history.replaceState(null, '', `${path}${shown.toString() ? `?${shown}` : ''}`);
      render();
    });
    kindsEl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-kind]');
      if (!button) return;
      kind = button.getAttribute('data-kind');
      load();
    });
    if (page) await load();
  }

  /* ---------- listing ---------- */

  function factRows (listing) {
    const rows = [
      ['Kind', listing.kind],
      ['Contents', listing.contents],
      ['Quantity', listing.qty > 1 ? listing.qty : null],
      ['Insurance', listing.insurance],
      ['MSRP', listing.msrpUsd !== null ? `$${listing.msrpUsd.toLocaleString()}` : null],
      ['Source', listing.source],
      ['Giftable', listing.giftable === null ? null : (listing.giftable ? 'Yes' : 'No')]
    ].filter((row) => row[1] !== null && row[1] !== undefined && row[1] !== '');
    return rows.map((row) => `<dt>${esc(row[0])}</dt><dd>${esc(row[1])}</dd>`).join('')
      + `<dt>Seller</dt><dd><a href="${esc(listing.seller.path)}">${esc(listing.seller.name)}</a></dd>`
      + `<dt>Listed</dt><dd>${esc(when(listing.createdAt))}${listing.discordUrl ? ` · <a href="${esc(listing.discordUrl)}" rel="noopener">Discord thread</a>` : ''}</dd>`;
  }

  // "Link your escrow key": Passport shares its cosigner key for the escrow
  // network (window.goonEscrowKey, from the login script).
  function escrowKeyPrompt (what) {
    return `<div class="market-escrow-key"><p class="market-grey">To ${esc(what)} with escrow, link your escrow key: Passport shares a key it keeps for escrow only, apart from the one you sign in with.</p>
        <button class="goon-button" type="button" data-escrow-key>Link your escrow key</button>
        <p class="market-note" role="status"></p></div>`;
  }

  function bindEscrowKey (root, done) {
    root.querySelectorAll('[data-escrow-key]').forEach((button) => button.addEventListener('click', async () => {
      const status = button.parentNode.querySelector('.market-note');
      if (typeof window.goonEscrowKey !== 'function') return note(status, 'Passport is not available on this page.', true);
      button.disabled = true;
      try {
        await window.goonEscrowKey((text) => note(status, text));
        note(status, 'Escrow key linked.');
        done();
      } catch (error) {
        note(status, error.message, true);
        button.disabled = false;
      }
    }));
  }

  function buyBox (listing) {
    const you = listing.you;
    if (listing.removed) return '<p class="market-muted">The Discord thread for this listing was deleted.</p>';
    if (!you) return `<div class="market-buy" id="buy">${listing.buyable ? '<p>Call dibs, or buy with 2-of-3 Bitcoin escrow.</p>' : ''}${signIn('call dibs or buy')}</div>`;
    const parts = [];
    if (you.order) parts.push(`<p>Your escrow order: <a href="${esc(you.order.path)}">${esc(you.order.state.replace(/-/g, ' '))}</a></p>`);
    if (listing.dibs) parts.push(`<p>${esc(listing.dibs.name)} has dibs until ${esc(when(listing.dibs.until))}.</p>`);
    if (you.seller) {
      if (listing.dibs) parts.push('<button class="goon-button" type="button" data-dibs="release">Drop dibs</button>');
      if (!you.order) parts.push('<p class="market-muted">This is your listing. Edits here show up in the Discord thread too.</p>');
    } else {
      if (you.dibs || (listing.dibs && you.canEdit)) parts.push('<button class="goon-button" type="button" data-dibs="release">Drop dibs</button>');
      else if (listing.status === 'available' && !listing.dibs) parts.push('<button class="goon-button" type="button" data-dibs="call">Call dibs</button>');
      if (listing.buyable && (!listing.dibs || you.dibs) && !you.escrowKey) {
        parts.push(escrowKeyPrompt('buy'));
      } else if (listing.buyable && (!listing.dibs || you.dibs)) {
        parts.push(`<form class="market-form" id="market-buy-form">
            <label>Your refund address <input name="refundAddress" required autocomplete="off" spellcheck="false" placeholder="bc1…"></label>
            <p class="market-muted">You pay ${esc(listing.price.label)} into an address that needs two of three keys to spend: yours, the seller's, and goon.vc's. If the seller never delivers, it comes back here. Both of you need an escrow key linked to goon.vc.</p>
            <button class="goon-button" type="submit">Buy with escrow</button>
          </form>`);
      }
    }
    if (!parts.length) parts.push(`<p class="market-muted">${listing.priceSats === null && listing.status === 'available' ? 'No BTC price yet. Reply to make an offer.' : `This listing is ${esc((listing.statusLabel || listing.status).toLowerCase())}.`}</p>`);
    parts.push('<p class="market-note" id="market-buy-note" role="status"></p>');
    return `<div class="market-buy" id="buy">${parts.join('')}</div>`;
  }

  function editForm (listing) {
    if (!listing.you || !listing.you.canEdit) return '';
    const fields = document.getElementById('market-listing-fields');
    const statuses = ['available', 'reserved', 'sold', 'hidden'];
    return `<section class="market-section">
        <details>
          <summary>Edit listing</summary>
          <form class="market-form" id="market-edit-form">
            ${fields ? fields.innerHTML : ''}
            <label>Status <select name="status">${statuses.map((s) => `<option value="${s}"${['reserved', 'paid', 'delivered'].includes(listing.status) && s === 'reserved' ? ' selected' : (listing.status === s ? ' selected' : '')}>${s[0].toUpperCase() + s.slice(1)}</option>`).join('')}</select></label>
            <button class="goon-button" type="submit">Save</button>
            <p class="market-note" role="status"></p>
          </form>
        </details>
      </section>`;
  }

  function replyList (replies) {
    if (!replies.length) return '<p class="market-muted">No replies yet.</p>';
    return `<ul class="market-replies">${replies.map((reply) => `<li>
        <span class="who">${esc(reply.author)}</span> <span class="market-muted">${esc(when(reply.at))}${reply.editedAt ? ' · edited' : ''}${reply.via === 'site' ? ' · on goon.vc' : ''}</span>
        <div class="body">${esc(reply.body)}</div>
      </li>`).join('')}</ul>`;
  }

  async function showListing (id) {
    const el = document.getElementById('market-listing');
    let listing;
    try {
      listing = await request('GET', `${base}/listings/${encodeURIComponent(id)}`);
    } catch (error) {
      el.innerHTML = `<p class="market-note error">${esc(error.message)}</p>`;
      return;
    }
    setTitle(listing.title);
    el.innerHTML = `<div class="market-listing">
        <div>
          ${listing.imageUrl ? `<img src="${esc(listing.imageUrl)}" alt="${esc(listing.title)}">` : ''}
          ${listing.notes ? `<section class="market-section"><h2>Notes</h2><p class="market-notes">${esc(listing.notes)}</p></section>` : ''}
          <section class="market-section">
            <h2>Replies</h2>
            ${replyList(listing.replies)}
            ${listing.you && !listing.removed ? `<form class="market-form" id="market-reply-form" style="margin-top: 1em;">
              <label>Reply <textarea name="body" maxlength="1800" required></textarea></label>
              <button class="goon-button" type="submit">Post reply</button>
              <p class="market-note" role="status"></p>
            </form>` : (listing.removed ? '' : signIn('reply'))}
          </section>
        </div>
        <div>
          <h1>${esc(listing.title)}</h1>
          <p>${statusBadge(listing)}</p>
          ${priceHtml(listing)}
          <dl class="market-facts">${factRows(listing)}</dl>
          ${buyBox(listing)}
          ${editForm(listing)}
        </div>
      </div>`;

    if (window.location.hash === '#buy') {
      const box = document.getElementById('buy');
      if (box) box.scrollIntoView({ block: 'center' });
    }
    const buyNote = document.getElementById('market-buy-note');
    bindEscrowKey(el, () => showListing(id));
    el.querySelectorAll('[data-dibs]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await request('POST', `${base}/listings/${encodeURIComponent(listing.id)}/dibs`, { release: button.getAttribute('data-dibs') === 'release' });
        showListing(id);
      } catch (error) {
        note(buyNote, error.message, true);
        button.disabled = false;
      }
    }));
    const buy = document.getElementById('market-buy-form');
    if (buy) {
      buy.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(buy, true);
        try {
          const order = await request('POST', `${base}/listings/${encodeURIComponent(listing.id)}/orders`, { refundAddress: buy.refundAddress.value.trim() });
          window.location.href = order.path;
        } catch (error) {
          note(buyNote, error.message, true);
          busy(buy, false);
        }
      });
    }
    const reply = document.getElementById('market-reply-form');
    if (reply) {
      reply.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(reply, true);
        try {
          await request('POST', `${base}/listings/${encodeURIComponent(listing.id)}/replies`, { body: reply.body.value });
          showListing(id);
        } catch (error) {
          note(reply.querySelector('.market-note'), error.message, true);
          busy(reply, false);
        }
      });
    }
    const edit = document.getElementById('market-edit-form');
    if (edit) {
      fillFields(edit, listing);
      // The status the form shows (a `dibs` listing has no option of its own):
      // only a status the seller changed is sent.
      const shown = edit.elements.status.value;
      edit.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(edit, true);
        const changes = formFields(edit);
        const status = edit.elements.status.value;
        if (status !== shown) changes.status = status;
        try {
          await request('PATCH', `${base}/listings/${encodeURIComponent(listing.id)}`, changes);
          showListing(id);
        } catch (error) {
          note(edit.querySelector('.market-note'), error.message, true);
          busy(edit, false);
        }
      });
    }
  }

  /* ---------- seller ---------- */

  async function showSeller (slug) {
    const el = document.getElementById('market-seller');
    try {
      const data = await request('GET', `${base}/sellers/${encodeURIComponent(slug)}`);
      setTitle(data.seller.name);
      const open = data.listings.filter((l) => l.status !== 'sold');
      const sold = data.listings.filter((l) => l.status === 'sold');
      el.innerHTML = `<h1 style="text-align: center;">${esc(data.seller.name)}</h1>
        <p class="operations-intro" style="text-align: center;">${open.length} listed · ${sold.length} sold</p>
        <section class="market-section"><h2>Listings</h2>${cards(open)}</section>
        ${sold.length ? `<section class="market-section"><h2>Sold</h2>${table(sold)}</section>` : ''}`;
    } catch (error) {
      el.innerHTML = `<p class="market-note error">${esc(error.message)}</p>`;
    }
  }

  /* ---------- seller dashboard ---------- */

  function ordersTable (orders) {
    if (!orders.length) return '<p class="market-muted">No orders yet.</p>';
    return `<table class="market-table">
        <thead><tr><th>Item</th><th>You are</th><th>With</th><th>State</th><th class="num">Price</th><th class="num">Updated</th></tr></thead>
        <tbody>${orders.map((o) => `<tr>
          <td><a href="${esc(o.path)}">${esc(o.title)}</a></td>
          <td>${esc(o.role)}</td>
          <td>${esc(o.role === 'seller' ? o.buyerName : o.sellerName)}</td>
          <td>${esc(o.stateLabel)}</td>
          <td class="num">${esc(o.price)}</td>
          <td class="num">${esc(day(o.updatedAt))}</td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  async function showMine () {
    setTitle('Your listings');
    const signin = document.getElementById('market-mine-signin');
    const body = document.getElementById('market-mine-body');
    let data;
    try {
      data = await request('GET', `${base}/mine`);
    } catch (error) {
      if (error.status === 401) {
        signin.hidden = false;
        return;
      }
      body.hidden = false;
      document.getElementById('market-mine-listings').innerHTML = `<p class="market-note error">${esc(error.message)}</p>`;
      return;
    }
    body.hidden = false;
    const intro = document.getElementById('market-mine-intro');
    const prompt = intro.parentNode.querySelector('.market-escrow-key');
    if (prompt) prompt.remove();
    if (!data.escrowKey) {
      intro.insertAdjacentHTML('afterend', escrowKeyPrompt('buy or sell'));
      bindEscrowKey(intro.parentNode, () => showMine());
    }
    const listingsEl = document.getElementById('market-mine-listings');
    const bulk = document.getElementById('market-bulk');
    listingsEl.innerHTML = data.listings.length ? table(data.listings, { select: true }) : '<p class="market-muted">You have no listings yet.</p>';
    bulk.hidden = !data.listings.length;
    document.getElementById('market-mine-orders').innerHTML = ordersTable(data.orders);
    const picked = () => Array.from(listingsEl.querySelectorAll('input[name="pick"]:checked')).map((input) => input.value);
    listingsEl.addEventListener('change', () => {
      bulk.querySelector('[data-selected]').textContent = `${picked().length} selected`;
    });
    if (!bulk.dataset.bound) {
      bulk.dataset.bound = '1';
      bulk.addEventListener('submit', async (event) => {
        event.preventDefault();
        const ids = picked();
        const changes = {};
        if (bulk.status.value) changes.status = bulk.status.value;
        if (bulk.price.value.trim()) changes.price = bulk.price.value.trim();
        const status = bulk.querySelector('.market-note');
        if (!ids.length || !Object.keys(changes).length) return note(status, 'Pick listings and a change first.', true);
        busy(bulk, true);
        try {
          const result = await request('PATCH', `${base}/listings`, { ids, changes });
          note(status, result.errors.length ? `${result.listings.length} updated; ${result.errors.map((e) => e.error).join(' ')}` : `${result.listings.length} updated.`, !!result.errors.length);
          bulk.reset();
          await showMine();
        } catch (error) {
          note(status, error.message, true);
        }
        busy(bulk, false);
      });
    }
    const form = document.getElementById('market-new-form');
    if (!form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(form, true);
        try {
          const listing = await request('POST', `${base}/listings`, formFields(form));
          window.location.href = listing.path;
        } catch (error) {
          note(form.querySelector('.market-note'), error.message, true);
          busy(form, false);
        }
      });
    }
    if (window.location.hash === '#new') document.getElementById('new').scrollIntoView();
  }

  /* ---------- order ---------- */

  function steps (order) {
    const at = STEP_INDEX[order.state];
    if (at === undefined) return `<p><strong>${esc(order.stateLabel)}</strong></p>`;
    return `<ol class="market-steps">${order.steps.map((step, i) => {
      const cls = at > i ? 'done' : (at === i ? 'current' : '');
      return `<li class="${cls}">${esc(STEP_LABELS[step] || step)}</li>`;
    }).join('')}</ol>`;
  }

  function paymentLines (order) {
    const seen = (order.payments || []).filter((p) => p.verified);
    if (!seen.length) return '';
    return seen.map((p) => {
      const state = p.confirmations > 0
        ? `${p.confirmations} confirmation${p.confirmations === 1 ? '' : 's'}; the escrow opens once goon.vc sees it in the vault`
        : 'seen in the mempool, waiting for its first confirmation';
      return `<p>Payment <code>${esc(p.txid.slice(0, 16))}…</code>: ${esc(state)}.</p>`;
    }).join('') + (order.payGraceUntil ? `<p class="market-muted">The order stays open until ${esc(when(order.payGraceUntil))} while it confirms.</p>` : '');
  }

  function payBox (order) {
    if (order.state !== 'awaiting-payment') return '';
    if (order.role !== 'buyer') {
      const lines = paymentLines(order);
      return lines ? `<section class="market-section"><h2>Payment</h2>${lines}</section>` : '';
    }
    const inv = order.invoice;
    return `<section class="market-section">
        <h2>Pay into escrow</h2>
        <div class="market-pay">
          ${order.escrow.qr ? `<a class="market-qr" href="${esc(inv.bitcoinUri)}">${order.escrow.qr}</a>` : ''}
          <div style="flex: 1 1 18em;">
            <p>Send exactly <strong>${esc(inv.amountBtc)} BTC</strong> (${esc(inv.amountSats.toLocaleString())} sats) in one payment to:</p>
            <code class="market-code">${esc(inv.address)}</code>
            <p class="market-actions">
              <a class="goon-button" href="${esc(inv.bitcoinUri)}">Open in wallet</a>
              ${order.hubPayUrl ? `<a class="goon-button" href="${esc(order.hubPayUrl)}" target="_blank" rel="noopener">Pay from a Fabric Hub</a>` : ''}
            </p>
            <p class="market-muted">Pay by ${esc(when(order.payBy))}. goon.vc watches the address and tells the seller once it confirms. Network: ${esc(order.network)}.</p>
            ${paymentLines(order)}
            <form class="market-form" id="market-payment-form">
              <label>Already paid? Paste the transaction id <input name="txid" autocomplete="off" spellcheck="false" placeholder="64 hex characters"></label>
              <button class="goon-button" type="submit">Check payment</button>
              <p class="market-note" role="status"></p>
            </form>
          </div>
        </div>
      </section>`;
  }

  function withdrawalBox (order) {
    const list = Object.values(order.withdrawals || {}).filter(Boolean);
    if (!list.length) return '';
    return `<section class="market-section">
        <h2>Payouts</h2>
        ${list.map((w) => {
          const yours = w.needs && w.needs === order.role;
          return `<div style="margin-bottom: 1em;">
            <p><strong>${w.kind === 'release' ? 'Pay the seller' : 'Refund the buyer'}</strong>: ${esc((w.amountSats || 0).toLocaleString())} sats to <code>${esc(w.destinationAddress)}</code>${w.kind === order.active ? ' · active' : ''}</p>
            <p class="market-muted">Signed by ${esc(w.signers.length ? w.signers.join(', ') : 'nobody yet')}; two of three settle it.</p>
            ${yours ? `<p>Your signature is needed. Run this with your seed's xprv (it signs with your escrow key), or paste a signed frame below:</p><code class="market-code">${esc(w.sign)}</code>` : ''}
          </div>`;
        }).join('')}
        ${order.role === 'buyer' || order.role === 'seller' ? `<form class="market-form" id="market-frame-form">
          <label>Signed frame <textarea name="frame" spellcheck="false" placeholder="fabric:…"></textarea></label>
          <button class="goon-button" type="submit">Submit signature</button>
          <p class="market-note" role="status"></p>
        </form>` : ''}
      </section>`;
  }

  function actionsBox (order) {
    if (!order.actions.length) return '';
    return `<section class="market-section">
        <h2>Next step</h2>
        <form class="market-form" id="market-action-form">
          ${order.actions.includes('delivered') ? `<label>Your payout address <input name="payoutAddress" autocomplete="off" spellcheck="false" placeholder="bc1…"></label>
          <p class="market-muted">Gift the pledge on RSI first, then mark it delivered. The buyer has until ${esc(when(order.confirmBy) || 'the deadline')} to release or dispute; after that goon.vc releases it to you.</p>` : ''}
          ${order.actions.includes('dispute') ? '<label>Reason (for a dispute) <input name="reason" maxlength="500"></label>' : ''}
          <div class="market-row">${order.actions.map((a) => `<button class="goon-button" type="submit" value="${esc(a)}">${esc(ACTION_LABELS[a] || a)}</button>`).join(' ')}</div>
          <p class="market-note" role="status"></p>
        </form>
      </section>`;
  }

  function txLink (order) {
    if (!order.txid) return '';
    const explorer = EXPLORERS[order.network];
    return `<p>Settled in ${explorer ? `<a href="${esc(explorer)}/tx/${esc(order.txid)}" rel="noopener">${esc(order.txid.slice(0, 16))}…</a>` : `<code>${esc(order.txid)}</code>`}${order.settledAt ? ` on ${esc(when(order.settledAt))}` : ''}.</p>`;
  }

  async function showOrder (id) {
    const el = document.getElementById('market-order');
    let order;
    try {
      order = await request('GET', `${base}/orders/${encodeURIComponent(id)}`);
    } catch (error) {
      el.innerHTML = error.status === 401 ? signIn('see this order') : `<p class="market-note error">${esc(error.message)}</p>`;
      return;
    }
    setTitle(`Order ${order.id}`);
    el.innerHTML = `<h1 style="text-align: center;">${esc(order.title)}</h1>
      <p class="operations-intro" style="text-align: center;"><a href="${esc(order.listing.path)}">Listing</a> · ${esc(order.price)} · you are the ${esc(order.role)}</p>
      ${steps(order)}
      <p><strong>${esc(order.stateLabel)}</strong>${order.dispute ? ` — ${esc(order.dispute.reason || 'dispute open')}; a Market arbiter will decide.` : ''}</p>
      ${order.state === 'paid' ? `<p class="market-muted">The seller delivers by ${esc(when(order.deliverBy))}, or the buyer is refunded.</p>` : ''}
      ${order.state === 'delivered' ? `<p class="market-muted">The buyer releases or disputes by ${esc(when(order.confirmBy))}; after that the seller is paid.</p>` : ''}
      ${txLink(order)}
      ${payBox(order)}
      ${actionsBox(order)}
      ${withdrawalBox(order)}
      <section class="market-section">
        <h2>Escrow</h2>
        <dl class="market-facts">
          <dt>Address</dt><dd><code>${esc(order.escrow.address)}</code></dd>
          <dt>Keys</dt><dd>${esc(order.parties.buyer.name)} (buyer), ${esc(order.parties.seller.name)} (seller), goon.vc; any ${esc(order.escrow.threshold)} spend</dd>
          <dt>Federation</dt><dd><code>${esc(order.escrow.federationId)}</code></dd>
          ${order.funding ? `<dt>Funding</dt><dd><code>${esc(order.funding.txid)}:${esc(order.funding.vout)}</code></dd>` : ''}
          ${order.refundAddress ? `<dt>Refunds to</dt><dd><code>${esc(order.refundAddress)}</code></dd>` : ''}
          ${order.payoutAddress ? `<dt>Pays out to</dt><dd><code>${esc(order.payoutAddress)}</code></dd>` : ''}
        </dl>
      </section>
      <section class="market-section">
        <h2>History</h2>
        <ul class="market-replies">${order.log.slice().reverse().map((entry) => `<li><span class="who">${esc(entry.type)}</span> <span class="market-muted">${esc(entry.name || entry.by || '')} · ${esc(when(entry.at))}</span></li>`).join('')}</ul>
      </section>`;

    const actions = document.getElementById('market-action-form');
    if (actions) {
      let action = null;
      actions.addEventListener('click', (event) => { if (event.target.value) action = event.target.value; });
      actions.addEventListener('submit', async (event) => {
        event.preventDefault();
        const step = (event.submitter && event.submitter.value) || action;
        if (!step) return;
        if (['cancel', 'refund', 'release'].includes(step) && !window.confirm(`${ACTION_LABELS[step]}?`)) return;
        busy(actions, true);
        try {
          await request('POST', `${base}/orders/${encodeURIComponent(order.id)}/${step}`, {
            payoutAddress: actions.elements.payoutAddress ? actions.elements.payoutAddress.value.trim() : undefined,
            reason: actions.elements.reason ? actions.elements.reason.value.trim() : undefined
          });
          showOrder(id);
        } catch (error) {
          note(actions.querySelector('.market-note'), error.message, true);
          busy(actions, false);
        }
      });
    }
    const payment = document.getElementById('market-payment-form');
    if (payment) {
      payment.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(payment, true);
        try {
          await request('POST', `${base}/orders/${encodeURIComponent(order.id)}/payments`, { txid: payment.elements.txid.value.trim() });
          showOrder(id);
        } catch (error) {
          note(payment.querySelector('.market-note'), error.message, true);
          busy(payment, false);
        }
      });
    }
    const frame = document.getElementById('market-frame-form');
    if (frame) {
      frame.addEventListener('submit', async (event) => {
        event.preventDefault();
        busy(frame, true);
        try {
          await request('POST', `${base}/messages`, { frame: frame.frame.value.trim() });
          showOrder(id);
        } catch (error) {
          note(frame.querySelector('.market-note'), error.message, true);
          busy(frame, false);
        }
      });
    }
  }

  if (!rest.length) showCatalog();
  else if (rest[0] === 'mine' && rest.length === 1) showMine();
  else if (rest[0] === 'listings' && rest.length === 2) showListing(rest[1]);
  else if (rest[0] === 'sellers' && rest.length === 2) showSeller(rest[1]);
  else if (rest[0] === 'orders' && rest.length === 2) showOrder(rest[1]);
})(window);
