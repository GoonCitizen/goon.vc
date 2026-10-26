'use strict';

const escapeHtml = require('../functions/escapeHtml');
const post = require('../functions/marketPost');

const PAGE_SCRIPT = '/scripts/market.js';

function renderMarketCss () {
  return `
      .market-page { display: none; margin: 0 auto; max-width: 64em; padding: 0 1em 3em; text-align: left; }
      .market-page > h1, .market-page > .operations-intro, .market-page > .market-grey, .market-page > .market-actions { text-align: center; }
      .market-grey { color: #bbb; font-size: 0.9em; margin: 0.5em auto 0; max-width: 40em; }
      .market-actions { display: flex; flex-wrap: wrap; gap: 0.6em; justify-content: center; margin: 1.25em 0 0; }
      .market-filters { display: flex; flex-wrap: wrap; gap: 0.6em; margin: 2em 0 0.75em; }
      .market-filters input, .market-filters select, .market-form input, .market-form select, .market-form textarea, .market-bulk input, .market-bulk select {
        background: #222; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 6px; color: #fff; font: inherit; padding: 0.4em 0.55em;
      }
      .market-filters input[type="search"] { flex: 1 1 14em; }
      .market-view-toggle { display: inline-flex; gap: 0; }
      .market-view-toggle button { background: transparent; border: 1px solid rgba(255, 255, 255, 0.3); color: #ddd; cursor: pointer; font: inherit; padding: 0.4em 0.8em; }
      .market-view-toggle button:first-child { border-radius: 6px 0 0 6px; }
      .market-view-toggle button:last-child { border-left: 0; border-radius: 0 6px 6px 0; }
      .market-view-toggle button[aria-pressed="true"] { background: #fff; color: #111; font-weight: 700; }
      .market-chips { display: flex; flex-wrap: wrap; gap: 0.4em; list-style: none; margin: 0 0 1.25em; padding: 0; }
      .market-chips button { background: transparent; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 999px; color: #ddd; cursor: pointer; font: inherit; font-size: 0.85em; padding: 0.15em 0.75em; }
      .market-chips button[aria-pressed="true"] { background: #fff; border-color: #fff; color: #111; font-weight: 700; }
      .market-chips .count { color: inherit; opacity: 0.6; margin-left: 0.3em; }
      .market-cards { display: grid; gap: 1em; grid-template-columns: repeat(auto-fill, minmax(15em, 1fr)); }
      .market-card { background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.15); border-radius: 10px; color: inherit; display: flex; flex-direction: column; overflow: hidden; text-decoration: none; }
      .market-card:hover { border-color: rgba(255, 255, 255, 0.5); }
      .market-card-image { aspect-ratio: 16 / 9; background: #1a1a1a center / cover no-repeat; }
      .market-card-image.empty { align-items: center; color: #555; display: flex; font-family: "Bungee", sans-serif; justify-content: center; }
      .market-card-body { display: grid; gap: 0.3em; padding: 0.7em 0.85em 0.85em; }
      .market-card-title { color: #fff; font-weight: 700; line-height: 1.2; }
      .market-price { color: #fff; font-family: "Bungee", sans-serif; font-size: 1.05em; letter-spacing: 0.03em; }
      .market-price-sub { color: #aaa; font-size: 0.85em; }
      .market-meta { color: #bbb; font-size: 0.85em; }
      .market-status { border-radius: 4px; display: inline-block; font-size: 0.75em; font-weight: 700; letter-spacing: 0.06em; padding: 0.05em 0.45em; text-transform: uppercase; }
      .market-status.available { background: #1f5f2c; color: #e6ffe9; }
      .market-status.dibs { background: #6b5a12; color: #fff6d1; }
      .market-status.reserved, .market-status.paid, .market-status.delivered { background: #2b4a7a; color: #e3eeff; }
      .market-status.sold { background: #555; color: #eee; }
      .market-status.hidden { background: #333; color: #aaa; }
      .market-table { border-collapse: collapse; font-size: 0.95em; width: 100%; }
      .market-table th, .market-table td { border-bottom: 1px solid rgba(255, 255, 255, 0.12); padding: 0.4em 0.5em; text-align: left; vertical-align: top; }
      .market-table th { color: #bbb; font-size: 0.8em; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; }
      .market-table td.num, .market-table th.num { text-align: right; white-space: nowrap; }
      .market-listing { display: grid; gap: 1.5em; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); margin-top: 1em; }
      @media (max-width: 760px) { .market-listing { grid-template-columns: minmax(0, 1fr); } }
      .market-listing img { border-radius: 10px; max-width: 100%; }
      .market-listing h1 { font-size: 1.5em; margin: 0 0 0.35em; text-align: left; }
      .market-facts { display: grid; gap: 0.25em 1em; grid-template-columns: auto 1fr; margin: 1em 0; }
      .market-facts dt { color: #aaa; }
      .market-facts dd { color: #fff; margin: 0; }
      .market-notes { white-space: pre-wrap; }
      .market-buy { background: rgba(0, 0, 0, 0.25); border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 10px; display: grid; gap: 0.75em; padding: 1em; }
      .market-replies { list-style: none; margin: 0; padding: 0; }
      .market-replies li { border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding: 0.6em 0; }
      .market-replies .who { color: #fff; font-weight: 700; }
      .market-replies .body { white-space: pre-wrap; }
      .market-form { display: grid; gap: 0.75em; }
      .market-form label { color: #fff; display: grid; font-weight: 600; gap: 0.3em; }
      .market-form .market-row { display: flex; flex-wrap: wrap; gap: 0.75em; }
      .market-form .market-row label { flex: 1 1 9em; }
      .market-actions { display: flex; flex-wrap: wrap; gap: 0.75em; }
      .market-form textarea { min-height: 5em; resize: vertical; }
      .market-note { color: #bbb; font-size: 0.9em; min-height: 1.2em; }
      .market-note.error { color: #ff9a9a; }
      .market-note:empty { min-height: 0; margin: 0; }
      .market-steps { counter-reset: step; display: flex; flex-wrap: wrap; gap: 0.5em; list-style: none; margin: 1em 0; padding: 0; }
      .market-steps li { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 999px; color: #aaa; font-size: 0.9em; padding: 0.2em 0.85em; }
      .market-steps li.done { background: rgba(255, 255, 255, 0.12); color: #fff; }
      .market-steps li.current { background: #fff; color: #111; font-weight: 700; }
      .market-pay { align-items: center; display: flex; flex-wrap: wrap; gap: 1.25em; }
      .market-qr { background: #fff; border-radius: 8px; line-height: 0; padding: 0.4em; width: 11em; }
      .market-qr svg { height: auto; width: 100%; }
      .market-code { background: #1a1a1a; border-radius: 6px; color: #fff; display: block; font-family: ui-monospace, Menlo, monospace; font-size: 0.85em; overflow-wrap: anywhere; padding: 0.5em 0.65em; }
      .market-page code { font-size: 0.85em; overflow-wrap: anywhere; }
      .market-bulk { align-items: center; display: flex; flex-wrap: wrap; gap: 0.5em; margin: 0.75em 0; }
      .market-section { margin-top: 2.5em; }
      .market-section h2 { font-size: 1.1em; letter-spacing: 0.06em; margin: 0 0 0.75em; }
      .market-muted { color: #aaa; }
      .market-page [hidden] { display: none !important; }`;
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

function options (values, labels, placeholder) {
  return `<option value="">${escapeHtml(placeholder)}</option>`
    + values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml((labels && labels[value]) || value)}</option>`).join('');
}

function dataAttributes (props) {
  return `data-base="${escapeHtml(props.basePath)}" data-login="${escapeHtml(props.loginPath)}" data-site-title="${escapeHtml(props.siteTitle || '')}"`;
}

/**
 * The listing fields a seller fills in, shared by the new-listing form and
 * the listing page's edit form.
 * @returns {string}
 */
function renderListingFields () {
  return `<label>Title <input name="title" maxlength="${post.LIMITS.title}" required placeholder="Carrack Expedition w/ Pisces"></label>
          <div class="market-row">
            <label>Kind <select name="kind">${post.KINDS.map((k) => `<option>${k}</option>`).join('')}</select></label>
            <label>Price <input name="price" placeholder="0.005 BTC, 500k sats, or $400"></label>
            <label>Qty <input name="qty" type="number" min="1" max="999" value="1"></label>
          </div>
          <div class="market-row">
            <label>Insurance <input name="insurance" placeholder="LTI or 120 mo"></label>
            <label>MSRP (USD) <input name="msrpUsd" placeholder="$600"></label>
            <label>Source <select name="source">${options(['Hangar', 'Buyback'], null, '—')}</select></label>
            <label>Giftable <select name="giftable"><option value="">—</option><option value="yes">Yes</option><option value="no">No</option></select></label>
          </div>
          <label>Contents <textarea name="contents" maxlength="${post.LIMITS.contents}" placeholder="What's in the pledge: ship, paints, game package…"></textarea></label>
          <label>Image link <input name="imageUrl" type="url" placeholder="https://…"></label>
          <label>Notes <textarea name="notes" maxlength="${post.LIMITS.notes}"></textarea></label>`;
}

/**
 * The catalog: every listing mirrored from the Market forum or posted here.
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.greyMarket Trusted HTML.
 * @param {string} props.basePath
 * @param {string} props.installPath Discord user install redirect.
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 * @returns {string}
 */
function renderCatalogHtml (props) {
  return `<main id="market-page" class="market-page" ${dataAttributes(props)}>
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <p class="market-grey">${props.greyMarket}</p>
      <div class="market-actions">
        <a class="goon-button" href="${escapeHtml(props.basePath)}/mine#new">Sell something</a>
        <a class="goon-button" href="${escapeHtml(props.basePath)}/mine">Your listings &amp; orders</a>
        <a class="goon-button" href="${escapeHtml(props.installPath)}">Add /market to Discord</a>
        <a class="goon-button" id="market-forum-link" href="#" hidden>Market forum</a>
      </div>
      <form class="market-filters" id="market-filters" role="search">
        <input type="search" name="q" placeholder="Search ships, paints, packs…" aria-label="Search listings">
        <select name="status" aria-label="Status">
          <option value="">For sale</option>
          ${post.STATUSES.filter((s) => !['hidden', 'paid', 'delivered'].includes(s)).map((s) => `<option value="${s}">${post.STATUS_LABELS[s]}</option>`).join('')}
          <option value="all">Everything</option>
        </select>
        <select name="source" aria-label="Source">${options(['Hangar', 'Buyback'], null, 'Any source')}</select>
        <select name="sort" aria-label="Sort">
          <option value="recent">Newest activity</option>
          <option value="price-asc">Price: low to high</option>
          <option value="price-desc">Price: high to low</option>
          <option value="title">Title</option>
        </select>
        <span class="market-view-toggle" role="group" aria-label="View">
          <button type="button" data-view="cards" aria-pressed="true">Cards</button>
          <button type="button" data-view="table" aria-pressed="false">Table</button>
        </span>
      </form>
      <ul class="market-chips" id="market-kinds" aria-label="Kind"></ul>
      <div id="market-results"><p class="market-muted">Loading listings…</p></div>
      <p class="market-muted" id="market-rate"></p>
      ${renderFooter(props)}
    </main>`;
}

function renderListingHtml (props) {
  return `<main id="market-listing-page" class="market-page" ${dataAttributes(props)}>
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Market</a></p>
      <div id="market-listing"><p class="market-muted">Loading…</p></div>
      <template id="market-listing-fields">${renderListingFields()}</template>
      ${renderFooter(props)}
    </main>`;
}

function renderSellerHtml (props) {
  return `<main id="market-seller-page" class="market-page" ${dataAttributes(props)}>
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Market</a></p>
      <div id="market-seller"><p class="market-muted">Loading…</p></div>
      ${renderFooter(props)}
    </main>`;
}

function renderOrderHtml (props) {
  return `<main id="market-order-page" class="market-page" ${dataAttributes(props)}>
      <p class="page-back"><a href="${escapeHtml(props.basePath)}/mine">&larr; Your orders</a></p>
      <div id="market-order"><p class="market-muted">Loading…</p></div>
      ${renderFooter(props)}
    </main>`;
}

function renderMineHtml (props) {
  return `<main id="market-mine-page" class="market-page" ${dataAttributes(props)}>
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Market</a></p>
      <h1>Your market</h1>
      <p class="operations-intro" id="market-mine-intro">Listings you post here go up in the Market forum under your name, and edits on either side show up on both.</p>
      <div id="market-mine-signin" hidden><p style="text-align: center;"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign in to sell</a></p></div>
      <div id="market-mine-body" hidden>
        <section class="market-section">
          <h2>Your listings</h2>
          <form class="market-bulk" id="market-bulk" hidden>
            <span class="market-muted" data-selected>0 selected</span>
            <select name="status" aria-label="Set status">
              <option value="">Set status…</option>
              <option value="available">Available</option>
              <option value="reserved">Reserved</option>
              <option value="sold">Sold</option>
              <option value="hidden">Hidden</option>
            </select>
            <input name="price" placeholder="New price" aria-label="New price">
            <button class="goon-button" type="submit">Apply</button>
            <span class="market-note" role="status"></span>
          </form>
          <div id="market-mine-listings"><p class="market-muted">Loading…</p></div>
        </section>
        <section class="market-section">
          <h2>Orders</h2>
          <div id="market-mine-orders"><p class="market-muted">Loading…</p></div>
        </section>
        <section class="market-section" id="new">
          <h2>New listing</h2>
          <form class="market-form" id="market-new-form">
            ${renderListingFields()}
            <button class="goon-button" type="submit">List it</button>
            <p class="market-note" role="status"></p>
          </form>
        </section>
      </div>
      ${renderFooter(props)}
    </main>`;
}

function renderMarketScript () {
  return `<script src="${PAGE_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'market-page',
  styles: renderMarketCss,
  render: renderCatalogHtml,
  renderListing: renderListingHtml,
  renderSeller: renderSellerHtml,
  renderOrder: renderOrderHtml,
  renderMine: renderMineHtml,
  script: renderMarketScript
};
