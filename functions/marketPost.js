'use strict';

/**
 * @fileoverview Market listings and their Discord forum posts.
 *
 * Listing fields follow the Turtle Brigade spreadsheet that the G00N SQUAD
 * Market forum grew out of: title (`Item`), kind, contents, quantity,
 * insurance, MSRP (USD, reference only), price (always sats), source,
 * giftable, notes, image, and status. The sheet's private columns (Paid,
 * Pledge IDs, Buyer) have no field here.
 *
 * goon.vc writes a forum post as a short body, an embed carrying those
 * fields, and two buttons: View on goon.vc and Buy with escrow
 * (`market:buy:<listing>`). Hand-written posts are read best-effort: labelled
 * lines (`Price: 0.005 BTC`), then loose mentions (`500k sats`, `LTI`, `x2`,
 * `buyback`). Forum tags map to kind and status by name.
 */

const SATS_PER_BTC = 100000000;
const KINDS = Object.freeze(['Ship', 'Paint', 'Vehicle', 'Pack', 'CCU', 'Other']);
const STATUSES = Object.freeze(['available', 'dibs', 'reserved', 'paid', 'delivered', 'sold', 'hidden']);
const SOURCES = Object.freeze(['Hangar', 'Buyback']);
// The forum carries four status tags; paid and delivered orders still read as Reserved there.
const STATUS_TAGS = Object.freeze({ available: 'Available', dibs: 'Dibs', reserved: 'Reserved', paid: 'Reserved', delivered: 'Reserved', sold: 'Sold' });
const STATUS_LABELS = Object.freeze({ available: 'Available', dibs: 'Dibs', reserved: 'Reserved', paid: 'Paid', delivered: 'Delivered', sold: 'Sold', hidden: 'Hidden' });
const FIELDS = Object.freeze(['title', 'kind', 'contents', 'qty', 'insurance', 'msrpUsd', 'priceSats', 'source', 'giftable', 'notes', 'imageUrl', 'status']);
const LIMITS = Object.freeze({ title: 100, contents: 1000, notes: 1500, imageUrl: 2000 });
const MAX_QTY = 999;
const MAX_PRICE_SATS = 21000000 * SATS_PER_BTC;
const MAX_APPLIED_TAGS = 5;
const BUY_PREFIX = 'market:buy:';
const EMBED_COLOR = 0x520002;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)(\?|$)/i;

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function clean (value, max) {
  const text = String(value === undefined || value === null ? '' : value).replace(/\r\n?/g, '\n').trim();
  return max ? text.slice(0, max) : text;
}

// Case, emoji, punctuation, and a trailing plural "s" don't matter when matching names.
function nameKey (value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '').replace(/s$/, '');
}

function normalizeKind (value) {
  const key = nameKey(value);
  if (!key) return null;
  const kind = KINDS.find((k) => nameKey(k) === key);
  if (kind) return kind;
  if (['upgrade', 'ccu', 'crossupgrade'].includes(key)) return 'CCU';
  if (['skin', 'livery', 'paintjob'].includes(key)) return 'Paint';
  if (['bundle', 'package', 'gamepackage', 'starterpack'].includes(key)) return 'Pack';
  if (['ground', 'groundvehicle', 'rover', 'bike'].includes(key)) return 'Vehicle';
  return null;
}

function normalizeStatus (value) {
  const key = nameKey(value);
  if (!key) return null;
  if (key === 'reservedpaid') return 'paid';
  return STATUSES.find((s) => nameKey(s) === key) || null;
}

function normalizeSource (value) {
  const key = nameKey(value);
  if (!key) return null;
  if (['buyback', 'buybackpledge', 'bb'].includes(key)) return 'Buyback';
  if (['hangar', 'pledge', 'original', 'standalone'].includes(key)) return 'Hangar';
  return null;
}

/**
 * Insurance as the sheet writes it: `LTI`, or `<months> mo`.
 * @param {*} value `LTI`, `lifetime`, `6 mo`, `120 months`, `10 years`, `6`
 * @returns {string|null}
 */
function normalizeInsurance (value) {
  const text = clean(value).toLowerCase();
  if (!text) return null;
  if (/\blti\b|life\s*time|lifetime/.test(text)) return 'LTI';
  const match = /^(\d{1,3})\s*(m|mo|mos|month|months|y|yr|yrs|year|years)?\.?(\s+insurance)?$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  const months = match[2] && match[2][0] === 'y' ? n * 12 : n;
  return months > 0 && months <= 1200 ? `${months} mo` : null;
}

function normalizeBool (value) {
  if (value === true || value === false) return value;
  const key = String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (['yes', 'y', 'true', '1', 'giftable', 'gift'].includes(key)) return true;
  if (['no', 'n', 'false', '0', 'notgiftable', 'nogift'].includes(key)) return false;
  return null;
}

function normalizeImage (value) {
  const text = clean(value, LIMITS.imageUrl);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === 'https:' ? url.toString() : null;
  } catch (_) {
    return null;
  }
}

function parseNumber (text) {
  const n = Number(String(text).replace(/[,_\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

const SUFFIX = { k: 1e3, m: 1e6 };

/**
 * A price as sats. `₿0.005`, `0.005 BTC`, `500k sats`, `500,000 sats`,
 * `1.2m sats`, and plain numbers with an explicit unit are read as written;
 * `$40`, `40 USD`, or `40$` are converted at `usdPerBtc` when given.
 * @param {*} value
 * @param {Object} [opts]
 * @param {number} [opts.usdPerBtc] reference rate for USD input
 * @param {boolean} [opts.loose] find the first price anywhere in a sentence
 * @returns {{ sats: number, unit: string, amount: number, converted: boolean }|null}
 */
function parsePrice (value, opts = {}) {
  const text = clean(value).toLowerCase();
  if (!text) return null;
  const num = '(\\d[\\d,]*(?:\\.\\d+)?|\\.\\d+)';
  const anchor = (re) => (opts.loose ? new RegExp(re, 'i') : new RegExp(`^${re}$`, 'i'));
  const patterns = [
    { re: anchor(`(?:₿|btc\\s*)${num}`), unit: 'btc' },
    { re: anchor(`${num}\\s*(?:(?:btc|bitcoin)\\b|₿)`), unit: 'btc' },
    { re: anchor(`${num}\\s*([km])?\\s*(?:sats?|satoshis?)\\b`), unit: 'sats' },
    { re: anchor(`(?:usd\\s*)?\\$\\s*${num}\\s*([km](?![a-z]))?`), unit: 'usd' },
    { re: anchor(`${num}\\s*([km])?\\s*(?:usd\\b|\\$|dollars?\\b)`), unit: 'usd' }
  ];
  if (!opts.loose && /^\d[\d,]*$/.test(text)) patterns.push({ re: /^(\d[\d,]*)$/, unit: 'sats' });
  for (const { re, unit } of patterns) {
    const match = re.exec(text);
    if (!match) continue;
    const amount = parseNumber(match[1]) * (match[2] ? SUFFIX[match[2].toLowerCase()] : 1);
    if (!Number.isFinite(amount) || amount < 0) continue;
    if (unit === 'btc') return { sats: Math.round(amount * SATS_PER_BTC), unit, amount, converted: false };
    if (unit === 'sats') return { sats: Math.round(amount), unit, amount, converted: false };
    const rate = Number(opts.usdPerBtc);
    if (!(rate > 0)) return { sats: null, unit, amount, converted: false };
    return { sats: Math.round((amount / rate) * SATS_PER_BTC), unit, amount, converted: true };
  }
  return null;
}

function parseUsd (value) {
  const match = /^\s*(?:usd\s*)?\$?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:usd|\$)?\s*$/i.exec(String(value || ''));
  return match ? parseNumber(match[1]) : NaN;
}

function trimZeros (text) {
  return text.indexOf('.') === -1 ? text : text.replace(/0+$/, '').replace(/\.$/, '');
}

/** `0.005 BTC`. */
function formatBtc (sats) {
  if (!Number.isFinite(Number(sats))) return '';
  return `${trimZeros((Number(sats) / SATS_PER_BTC).toFixed(8))} BTC`;
}

/** `500,000 sats`. */
function formatSats (sats) {
  if (!Number.isFinite(Number(sats))) return '';
  return `${Math.round(Number(sats)).toLocaleString('en-US')} sats`;
}

/** `≈ $40` at a reference rate, or ''. */
function formatUsd (sats, usdPerBtc) {
  const rate = Number(usdPerBtc);
  if (!Number.isFinite(Number(sats)) || !(rate > 0)) return '';
  const usd = (Number(sats) / SATS_PER_BTC) * rate;
  return `≈ $${usd >= 100 ? Math.round(usd).toLocaleString('en-US') : usd.toFixed(2)}`;
}

/** Price as shown everywhere: BTC, sats, and the USD hint. */
function formatPrice (sats, usdPerBtc) {
  if (sats === null || sats === undefined || !Number.isFinite(Number(sats))) return 'Make an offer';
  const usd = formatUsd(sats, usdPerBtc);
  return `${formatBtc(sats)} (${formatSats(sats)}${usd ? `, ${usd}` : ''})`;
}

/**
 * Check and normalize listing fields. Only the fields present in `input` are
 * returned, so the result is a patch.
 * @param {Object} input
 * @param {Object} [opts]
 * @param {number} [opts.usdPerBtc] for a price given as `$40`
 * @param {boolean} [opts.create] a new listing: title required
 * @returns {{ fields: Object, conversion: Object|null }}
 */
function normalizeFields (input = {}, opts = {}) {
  const fields = {};
  let conversion = null;
  const has = (name) => Object.prototype.hasOwnProperty.call(input, name) && input[name] !== undefined;
  if (has('title') || opts.create) {
    const title = clean(input.title, LIMITS.title);
    if (!title) throw fail(400, 'A listing needs a title.');
    fields.title = title;
  }
  if (has('kind')) {
    const kind = input.kind === null || input.kind === '' ? 'Other' : normalizeKind(input.kind);
    if (!kind) throw fail(400, `Kind must be one of ${KINDS.join(', ')}.`);
    fields.kind = kind;
  }
  if (has('contents')) fields.contents = clean(input.contents, LIMITS.contents) || null;
  if (has('notes')) fields.notes = clean(input.notes, LIMITS.notes) || null;
  if (has('qty')) {
    const qty = input.qty === null || input.qty === '' ? 1 : Number(input.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) throw fail(400, `Quantity must be a whole number from 1 to ${MAX_QTY}.`);
    fields.qty = qty;
  }
  if (has('insurance')) {
    if (input.insurance === null || input.insurance === '') fields.insurance = null;
    else {
      const insurance = normalizeInsurance(input.insurance);
      if (!insurance) throw fail(400, 'Insurance must be LTI or a number of months, like 6 mo or 120 mo.');
      fields.insurance = insurance;
    }
  }
  if (has('msrpUsd')) {
    if (input.msrpUsd === null || input.msrpUsd === '') fields.msrpUsd = null;
    else {
      const msrp = typeof input.msrpUsd === 'number' ? input.msrpUsd : parseUsd(input.msrpUsd);
      if (!Number.isFinite(msrp) || msrp < 0 || msrp > 1e6) throw fail(400, 'MSRP must be a dollar amount.');
      fields.msrpUsd = Math.round(msrp * 100) / 100;
    }
  }
  if (has('priceSats') || has('price')) {
    const raw = has('price') ? input.price : input.priceSats;
    if (raw === null || raw === '') fields.priceSats = null;
    else {
      const parsed = typeof raw === 'number' ? { sats: raw, unit: 'sats', amount: raw, converted: false } : parsePrice(raw, { usdPerBtc: opts.usdPerBtc });
      if (!parsed) throw fail(400, 'Price must be in BTC (0.005 BTC), sats (500000 sats or 500k sats), or dollars ($40).');
      if (parsed.sats === null) throw fail(503, 'A dollar price needs the BTC reference rate, which is unavailable right now. Give the price in BTC or sats.');
      if (!Number.isSafeInteger(parsed.sats) || parsed.sats < 0 || parsed.sats > MAX_PRICE_SATS) throw fail(400, 'Price is out of range.');
      fields.priceSats = parsed.sats;
      if (parsed.converted) conversion = { usd: parsed.amount, sats: parsed.sats, usdPerBtc: Number(opts.usdPerBtc) };
    }
  }
  if (has('source')) {
    if (input.source === null || input.source === '') fields.source = null;
    else {
      const source = normalizeSource(input.source);
      if (!source) throw fail(400, 'Source must be Hangar or Buyback.');
      fields.source = source;
    }
  }
  if (has('giftable')) {
    const giftable = input.giftable === null || input.giftable === '' ? null : normalizeBool(input.giftable);
    if (giftable === null && input.giftable !== null && input.giftable !== '') throw fail(400, 'Giftable must be yes or no.');
    fields.giftable = giftable;
  }
  if (has('imageUrl')) {
    if (input.imageUrl === null || input.imageUrl === '') fields.imageUrl = null;
    else {
      const image = normalizeImage(input.imageUrl);
      if (!image) throw fail(400, 'Image must be an https:// link.');
      fields.imageUrl = image;
    }
  }
  if (has('status')) {
    const status = normalizeStatus(input.status);
    if (!status) throw fail(400, `Status must be one of ${STATUSES.join(', ')}.`);
    fields.status = status;
  }
  return { fields, conversion };
}

/* ---------- reading forum posts ---------- */

const LABELS = [
  { field: 'price', re: /^(?:price|ask(?:ing)?|cost|wts\s*price|selling\s*for)$/ },
  { field: 'kind', re: /^(?:kind|type|category)$/ },
  { field: 'insurance', re: /^(?:insurance|ins)$/ },
  { field: 'qty', re: /^(?:qty|quantity|count|amount)$/ },
  { field: 'msrpUsd', re: /^(?:msrp|retail|melt|melt\s*value|value)$/ },
  { field: 'source', re: /^(?:source|from|origin)$/ },
  { field: 'giftable', re: /^(?:giftable|gift(?:able)?\??)$/ },
  { field: 'contents', re: /^(?:contents|includes|items?)$/ },
  { field: 'notes', re: /^(?:notes?|details|info)$/ },
  { field: 'status', re: /^status$/ },
  { field: 'title', re: /^(?:item|title|ship)$/ }
];

function labelField (label) {
  const key = String(label || '').toLowerCase().replace(/[*_`~]/g, '').replace(/\s+/g, ' ').trim();
  const hit = LABELS.find((l) => l.re.test(key));
  return hit ? hit.field : null;
}

// Strip markdown emphasis so `**Price:** 0.005 BTC` reads as a label and a value.
function plain (line) {
  return line.replace(/[*_`~]+/g, '').replace(/^[\s>•\-–—]+/, '').trim();
}

function firstImage (attachments = [], embeds = []) {
  for (const a of attachments || []) {
    const type = String(a.content_type || a.contentType || '');
    const url = a.url || a.proxy_url || a.proxyURL;
    if (url && (type.startsWith('image/') || IMAGE_EXT_RE.test(String(a.filename || a.name || url)))) return url;
  }
  for (const e of embeds || []) {
    const url = (e.image && e.image.url) || (e.thumbnail && e.thumbnail.url);
    if (url) return url;
  }
  return null;
}

/**
 * Read a listing out of a forum post. Fields goon.vc wrote into an embed are
 * read exactly; a hand-written body is read best-effort.
 * @param {Object} post
 * @param {string} post.title thread name
 * @param {string} [post.content] starter message text, mentions already shown as names
 * @param {Array<Object>} [post.attachments]
 * @param {Array<Object>} [post.embeds]
 * @param {string[]} [post.tags] applied tag names
 * @param {Object} [opts]
 * @param {number} [opts.usdPerBtc]
 * @param {Object} [opts.tags] tag aliases (see {@link tagAliases})
 * @returns {{ fields: Object, tags: string[], priced: boolean }} `fields` holds only what the post says
 */
function parsePost (post = {}, opts = {}) {
  const fields = {};
  const set = (name, value) => {
    if (value === null || value === undefined || value === '') return;
    if (fields[name] === undefined) fields[name] = value;
  };
  const title = clean(post.title, LIMITS.title);
  if (title) fields.title = title;
  for (const tag of post.tags || []) {
    const mapped = mapTag(tag, opts.tags);
    if (mapped && mapped.kind) set('kind', mapped.kind);
    if (mapped && mapped.status) set('status', mapped.status);
  }

  const raw = {};
  const embed = (post.embeds || []).find((e) => Array.isArray(e.fields) && e.fields.length);
  if (embed) {
    for (const f of embed.fields) {
      const field = labelField(f.name);
      if (field && raw[field] === undefined) raw[field] = f.value;
    }
    if (embed.description && raw.notes === undefined) raw.notes = embed.description;
  }

  const rest = [];
  for (const line of String(post.content || '').replace(/\r\n?/g, '\n').split('\n')) {
    const text = plain(line);
    const match = /^([A-Za-z][A-Za-z ?]{1,24})\s*[:=\-–—]\s*(.+)$/.exec(text);
    const field = match && labelField(match[1]);
    if (field && raw[field] === undefined) raw[field] = match[2].trim();
    else if (text) rest.push(line.trim());
  }
  const body = rest.join('\n');

  if (raw.title) set('title', clean(raw.title, LIMITS.title));
  if (raw.kind) set('kind', normalizeKind(raw.kind));
  if (raw.status) set('status', normalizeStatus(raw.status));
  if (raw.contents) set('contents', clean(raw.contents, LIMITS.contents));
  if (raw.insurance) set('insurance', normalizeInsurance(raw.insurance));
  if (raw.source) set('source', normalizeSource(raw.source));
  if (raw.giftable !== undefined) set('giftable', normalizeBool(raw.giftable));
  if (raw.qty) {
    const qty = parseInt(String(raw.qty).replace(/^x/i, ''), 10);
    if (qty >= 1 && qty <= MAX_QTY) set('qty', qty);
  }
  if (raw.msrpUsd) {
    const msrp = parseUsd(raw.msrpUsd);
    if (Number.isFinite(msrp)) set('msrpUsd', msrp);
  }
  if (raw.price) {
    // Our own embed writes `0.005 BTC (500,000 sats, ≈ $40)`: the first price wins.
    const price = parsePrice(raw.price, { usdPerBtc: opts.usdPerBtc, loose: true });
    if (price && price.sats !== null) set('priceSats', price.sats);
  }

  // Loose mentions in the rest of the body.
  if (fields.priceSats === undefined) {
    const price = parsePrice(body, { usdPerBtc: opts.usdPerBtc, loose: true }) || parsePrice(title, { usdPerBtc: opts.usdPerBtc, loose: true });
    if (price && price.sats !== null) set('priceSats', price.sats);
  }
  if (fields.insurance === undefined) {
    const lti = /\bLTI\b|lifetime insurance/i.test(body) || /\bLTI\b/.test(title);
    const months = /\b(\d{1,3})\s*(?:mo|mos|month|months)\b(?:\s*(?:of\s*)?insurance|\s*ins\b)?/i.exec(body);
    const years = /\b(\d{1,2})\s*(?:y|yr|yrs|year|years)\s*(?:of\s*)?insurance\b/i.exec(body);
    if (lti) set('insurance', 'LTI');
    else if (months) set('insurance', normalizeInsurance(`${months[1]} mo`));
    else if (years) set('insurance', normalizeInsurance(`${years[1]} years`));
  }
  if (fields.qty === undefined) {
    const qty = /(?:^|\s)(?:x\s*(\d{1,3})|(\d{1,3})\s*x)(?:\s|$)|\bqty\.?\s*(\d{1,3})\b/i.exec(`${title} ${body}`);
    const n = qty && Number(qty[1] || qty[2] || qty[3]);
    if (n >= 1 && n <= MAX_QTY) set('qty', n);
  }
  if (fields.source === undefined) {
    if (/\bbuy\s*-?back\b/i.test(`${title} ${body}`)) set('source', 'Buyback');
  }
  if (fields.giftable === undefined) {
    if (/\bnot\s+giftable\b|\bnon-?giftable\b/i.test(body)) set('giftable', false);
    else if (/\bgiftable\b/i.test(body)) set('giftable', true);
  }
  if (fields.kind === undefined) {
    if (/\bccu\b|\bupgrade\b/i.test(title)) set('kind', 'CCU');
    else if (/\bpaint\b|\bskin\b|\blivery\b/i.test(title)) set('kind', 'Paint');
    else if (/\bpack(age)?\b|\bbundle\b/i.test(title)) set('kind', 'Pack');
  }
  if (raw.notes) set('notes', clean(raw.notes, LIMITS.notes));
  else if (body) set('notes', clean(body, LIMITS.notes));
  set('imageUrl', normalizeImage(firstImage(post.attachments, post.embeds)));

  const tags = (post.tags || []).filter((tag) => !mapTag(tag, opts.tags));
  return { fields, tags, priced: fields.priceSats !== undefined };
}

/* ---------- tags ---------- */

/**
 * Tag aliases: canonical kind or status label → names the forum may use.
 * Defaults cover the kinds and the four status tags; `overrides` adds names
 * (`{ Ship: ['Ships', 'WTS Ship'], Sold: ['SOLD ✅'] }`).
 * @param {Object<string, string[]>} [overrides]
 * @returns {Object<string, string[]>}
 */
function tagAliases (overrides = {}) {
  const out = {};
  for (const kind of KINDS) out[kind] = [kind];
  out.CCU.push('Upgrade', 'Upgrades');
  out.Paint.push('Paints', 'Skin', 'Livery');
  out.Pack.push('Package', 'Bundle');
  for (const label of new Set(Object.values(STATUS_TAGS))) out[label] = [label];
  for (const [label, names] of Object.entries(overrides || {})) {
    out[label] = (out[label] || [label]).concat([].concat(names || []));
  }
  return out;
}

/**
 * What a forum tag name stands for.
 * @param {string} name
 * @param {Object<string, string[]>} [aliases] from {@link tagAliases}
 * @returns {{ kind?: string, status?: string }|null}
 */
function mapTag (name, aliases) {
  const key = nameKey(name);
  if (!key) return null;
  const table = aliases && Object.keys(aliases).length ? aliases : tagAliases();
  for (const [label, names] of Object.entries(table)) {
    if (!names.some((n) => nameKey(n) === key)) continue;
    if (KINDS.includes(label)) return { kind: label };
    const status = Object.keys(STATUS_TAGS).find((s) => STATUS_TAGS[s] === label);
    if (status) return { status };
  }
  return null;
}

/**
 * Tag ids to apply to a listing's thread: its kind, its status, and any other
 * tags it already carries, at most five.
 * @param {Object} listing
 * @param {Array<{ id: string, name: string }>} available the forum's `available_tags`
 * @param {Object<string, string[]>} [aliases]
 * @returns {string[]}
 */
function appliedTags (listing, available = [], aliases) {
  const table = aliases && Object.keys(aliases).length ? aliases : tagAliases();
  const find = (label) => {
    const names = (table[label] || [label]).map(nameKey);
    const tag = available.find((t) => names.includes(nameKey(t.name)));
    return tag ? String(tag.id) : null;
  };
  const ids = [];
  const push = (id) => { if (id && !ids.includes(id) && ids.length < MAX_APPLIED_TAGS) ids.push(id); };
  if (listing.kind && listing.kind !== 'Other') push(find(listing.kind));
  if (STATUS_TAGS[listing.status]) push(find(STATUS_TAGS[listing.status]));
  for (const name of listing.tags || []) {
    const tag = available.find((t) => nameKey(t.name) === nameKey(name));
    if (tag && !mapTag(tag.name, table)) push(String(tag.id));
  }
  return ids;
}

/* ---------- writing forum posts ---------- */

function threadName (listing) {
  return clean(listing.title, LIMITS.title) || 'Listing';
}

function canBuy (listing) {
  return (listing.status === 'available' || listing.status === 'dibs') && Number.isSafeInteger(listing.priceSats) && listing.priceSats > 0;
}

/**
 * The starter message goon.vc posts (and re-renders) for a listing, as
 * Discord API JSON.
 * @param {Object} listing
 * @param {Object} [opts]
 * @param {string} [opts.url] the listing page
 * @param {number} [opts.usdPerBtc]
 * @param {string} [opts.sellerName] for "Listed by <name> via goon.vc" when the bot posts it
 * @returns {{ content: string, embeds: Object[], components: Object[], allowed_mentions: Object }}
 */
function renderPost (listing, opts = {}) {
  const fields = [];
  const add = (name, value, inline = true) => {
    if (value === null || value === undefined || value === '') return;
    fields.push({ name, value: String(value).slice(0, 1024), inline });
  };
  add('Price', formatPrice(listing.priceSats, opts.usdPerBtc), false);
  add('Kind', listing.kind);
  add('Status', STATUS_LABELS[listing.status] || listing.status);
  add('Qty', listing.qty);
  add('Insurance', listing.insurance);
  add('MSRP', Number.isFinite(listing.msrpUsd) ? `$${listing.msrpUsd}` : null);
  add('Source', listing.source);
  add('Giftable', listing.giftable === true ? 'Yes' : listing.giftable === false ? 'No' : null);
  add('Contents', listing.contents, false);
  const embed = {
    title: threadName(listing),
    color: EMBED_COLOR,
    fields
  };
  if (opts.url) embed.url = opts.url;
  if (listing.notes) embed.description = String(listing.notes).slice(0, 4096);
  if (listing.imageUrl) embed.image = { url: listing.imageUrl };
  embed.footer = { text: 'G00N SQUAD Market · prices in BTC · escrow on goon.vc' };

  const buttons = [];
  if (opts.url) buttons.push({ type: 2, style: 5, label: 'View on goon.vc', url: opts.url });
  if (listing.id) buttons.push({ type: 2, style: 1, label: 'Buy with escrow', custom_id: `${BUY_PREFIX}${listing.id}`, disabled: !canBuy(listing) });

  const lines = [`**${threadName(listing)}** — ${formatPrice(listing.priceSats, opts.usdPerBtc)}`];
  if (opts.sellerName) lines.push(`Listed by ${opts.sellerName} via goon.vc`);
  return {
    content: lines.join('\n').slice(0, 2000),
    embeds: [embed],
    components: buttons.length ? [{ type: 1, components: buttons }] : [],
    allowed_mentions: { parse: [] }
  };
}

/**
 * The reply goon.vc posts under a hand-written listing it can't edit.
 * @param {Object} changes field → new value
 * @param {Object} [opts] `{ usdPerBtc }`
 * @returns {string}
 */
function updateText (changes = {}, opts = {}) {
  const parts = [];
  for (const [field, value] of Object.entries(changes)) {
    if (field === 'priceSats') parts.push(`price ${formatPrice(value, opts.usdPerBtc)}`);
    else if (field === 'status') parts.push(`status ${STATUS_LABELS[value] || value}`);
    else if (field === 'msrpUsd') parts.push(value === null ? 'MSRP cleared' : `MSRP $${value}`);
    else if (field === 'giftable') parts.push(value === null ? 'giftable cleared' : value ? 'giftable' : 'not giftable');
    else if (field === 'imageUrl') parts.push(value ? 'new image' : 'image removed');
    else if (field === 'notes' || field === 'contents') parts.push(`${field} updated`);
    else if (value === null) parts.push(`${field} cleared`);
    else parts.push(`${field === 'qty' ? 'qty' : field} ${value}`);
  }
  return parts.length ? `Updated on goon.vc: ${parts.join(', ')}` : '';
}

const MILESTONES = Object.freeze({
  reserved: 'Reserved: a buyer opened an escrow order on goon.vc.',
  paid: 'Paid: the escrow is funded. The seller can deliver now.',
  delivered: 'Delivered: the seller marked the pledge as gifted. Waiting on the buyer to confirm.',
  sold: 'Sold: the escrow paid out to the seller.',
  refunded: 'Back on the market: the escrow was refunded to the buyer.',
  released: 'Available again: the order was cancelled.',
  disputed: 'Disputed: a G00N SQUAD arbiter will decide this order.'
});

/**
 * The thread reply for an order milestone (no amounts, addresses, or names).
 * @param {string} milestone
 * @returns {string}
 */
function milestoneText (milestone) {
  return MILESTONES[milestone] || '';
}

module.exports = {
  BUY_PREFIX,
  FIELDS,
  KINDS,
  LIMITS,
  MAX_APPLIED_TAGS,
  SATS_PER_BTC,
  SOURCES,
  STATUSES,
  STATUS_LABELS,
  STATUS_TAGS,
  appliedTags,
  canBuy,
  fail,
  formatBtc,
  formatPrice,
  formatSats,
  formatUsd,
  mapTag,
  milestoneText,
  nameKey,
  normalizeFields,
  normalizeInsurance,
  normalizeKind,
  normalizeSource,
  normalizeStatus,
  parsePost,
  parsePrice,
  renderPost,
  tagAliases,
  threadName,
  updateText
};
