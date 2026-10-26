'use strict';

/**
 * Public RSI citizen pages (`/citizens/<handle>`): the handle, citizen record,
 * bio, and main org a browser would see. RSI has no documented API for these;
 * the parser follows the page markup (ported from star-citizen-live
 * `functions/rsiLookup.js`).
 */

const { RSI_ORIGIN } = require('./rsiOrganization');

const HANDLE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,59}$/;
const ORG_SID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;
const FETCH_TIMEOUT_MS = 12000;
const USER_AGENT = 'Mozilla/5.0 (compatible; goon.vc/1.0; +https://goon.vc) AppleWebKit/537.36';
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

/**
 * @param {*} value
 * @returns {string|null} the handle, or null when it can't be one
 */
function sanitizeHandle (value) {
  const handle = String(value == null ? '' : value).trim().replace(/^@/, '');
  return HANDLE_RE.test(handle) ? handle : null;
}

function citizenUrl (handle) {
  const clean = sanitizeHandle(handle);
  return clean ? `${RSI_ORIGIN}/en/citizens/${encodeURIComponent(clean)}` : null;
}

function decodeEntities (text) {
  return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    const named = ENTITIES[code.toLowerCase()];
    return named !== undefined ? named : match;
  });
}

function plainText (html) {
  return decodeEntities(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Parse an RSI citizen profile page.
 * @param {string} html
 * @returns {{ handle: string, displayName: string, citizenRecord: number|null, bio: string|null, mainOrgSid: string|null, mainOrgName: string|null, url: string }|null}
 *   null for a missing citizen or a page that isn't one
 */
function parseCitizenHtml (html) {
  if (!html || typeof html !== 'string') return null;
  const title = /<title>\s*([^<]+?)\s*<\/title>/i.exec(html);
  if (title && /404\s*-/i.test(title[1])) return null;
  const labeled = (label) => {
    const match = new RegExp(`<span class="label">\\s*${label}\\s*</span>\\s*<strong class="value">\\s*([\\s\\S]*?)\\s*</strong>`, 'i').exec(html);
    return match ? plainText(match[1]) : null;
  };
  const handle = sanitizeHandle(labeled('Handle name'));
  if (!handle) return null;
  const record = labeled('UEE Citizen Record');
  const recordNumber = record ? parseInt(record.replace(/[^\d]/g, ''), 10) : NaN;
  const display = /<div class="info">\s*<p class="entry">\s*<strong class="value">\s*([^<]+?)\s*<\/strong>/i.exec(html);
  const bio = /<div class="entry bio">[\s\S]*?<div class="value">\s*([\s\S]*?)\s*<\/div>/i.exec(html);
  let mainOrgSid = null;
  let mainOrgName = null;
  const org = /<div class="main-org[\s\S]*?<div class="info">([\s\S]*?)<\/div>\s*<\/div>/i.exec(html);
  if (org) {
    const sid = /\/orgs\/([A-Za-z0-9_-]+)/i.exec(org[1]);
    if (sid && ORG_SID_RE.test(sid[1])) mainOrgSid = sid[1].toUpperCase();
    const name = /<strong class="value">\s*([^<]+?)\s*<\/strong>/i.exec(org[1]) || /<span class="value">\s*([^<]+?)\s*<\/span>/i.exec(org[1]);
    if (name) mainOrgName = plainText(name[1]) || null;
  }
  return {
    handle,
    displayName: display ? plainText(display[1]) || handle : handle,
    citizenRecord: Number.isFinite(recordNumber) ? recordNumber : null,
    bio: bio ? plainText(bio[1]).slice(0, 4000) || null : null,
    mainOrgSid,
    mainOrgName,
    url: citizenUrl(handle)
  };
}

/**
 * Fetch and parse one citizen page.
 * @param {string} handle
 * @param {Object} [opts]
 * @param {Function} [opts.fetch] Defaults to global fetch.
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{ ok: true, citizen: Object }|{ ok: false, status: number, error: string }>}
 */
async function lookupCitizen (handle, opts = {}) {
  const url = citizenUrl(handle);
  if (!url) return { ok: false, status: 400, error: 'That isn’t an RSI handle.' };
  const fetchImpl = opts.fetch || ((...args) => fetch(...args));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || FETCH_TIMEOUT_MS);
  let res;
  let html;
  try {
    res = await fetchImpl(url, {
      redirect: 'follow',
      headers: { Accept: 'text/html,application/xhtml+xml', 'User-Agent': USER_AGENT },
      signal: controller.signal
    });
    html = await res.text();
  } catch (_) {
    return { ok: false, status: 502, error: 'RSI could not be reached. Try again in a minute.' };
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return { ok: false, status: 404, error: 'RSI has no citizen with that handle.' };
  if (!res.ok) return { ok: false, status: 502, error: `RSI answered ${res.status}. Try again in a minute.` };
  const citizen = parseCitizenHtml(html);
  if (!citizen) return { ok: false, status: 404, error: 'RSI has no citizen with that handle.' };
  return { ok: true, citizen };
}

module.exports = { sanitizeHandle, citizenUrl, parseCitizenHtml, lookupCitizen };
