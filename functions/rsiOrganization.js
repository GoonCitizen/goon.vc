'use strict';

const RSI_ORIGIN = 'https://robertsspaceindustries.com';

// RSI fills unedited org fields with these defaults.
const PLACEHOLDERS = [
  /^Our Board of Directors will unveil our official corporate statements soon\./i,
  /^Welcome to our official Spectrum channel\. Feel free to browse/i
];

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' };

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
  return decodeEntities(String(html).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function absoluteUrl (href) {
  if (!href) return null;
  const value = decodeEntities(href).trim();
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith('//')) return `https:${value}`;
  if (value.startsWith('/')) return RSI_ORIGIN + value;
  return null;
}

/**
 * Markitup HTML → plain-text paragraphs (no markup survives).
 * @param {string} html
 * @returns {string[]}
 */
function paragraphs (html) {
  if (!html) return [];
  return String(html)
    .split(/<\/?p\b[^>]*>|<br\s*\/?>|<\/h[1-6]>|<\/li>|<\/div>|\n\s*\n/i)
    .map(plainText)
    .filter((text) => text && !PLACEHOLDERS.some((re) => re.test(text)));
}

function links (html) {
  const out = [];
  const seen = new Set();
  const re = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const href = absoluteUrl(m[1]);
    if (!href || seen.has(href)) continue;
    seen.add(href);
    out.push({ label: plainText(m[2]).replace(/…$/, '') || href, href });
  }
  return out;
}

function match (html, re) {
  const m = re.exec(html);
  return m ? m[1] : null;
}

function tab (html, id) {
  return match(html, new RegExp(`\\sid="tab-${id}"[\\s\\S]*?<div class="markitup-text">([\\s\\S]*?)</div>\\s*</div>`, 'i'));
}

/**
 * Parse a public RSI organization page.
 * @param {string} html Body of https://robertsspaceindustries.com/orgs/<SYMBOL>.
 * @param {string} symbol
 * @returns {Object} Plain-text org record; URLs are absolute.
 */
function parseRsiOrganization (html, symbol) {
  const sid = String(symbol).toUpperCase();
  const page = String(html || '');
  const heading = match(page, /<h1>([\s\S]*?)<span class="symbol">/i);
  const name = heading ? plainText(heading).replace(/\s*\/\s*$/, '') : sid;
  const membersText = match(page, /<span class="count">([^<]*)<\/span>/i);
  const members = membersText ? parseInt(membersText.replace(/[^\d]/g, ''), 10) : null;
  const focusText = (cls) => {
    const block = match(page, new RegExp(`<li class="${cls} tooltip-wrap">([\\s\\S]*?)</li>`, 'i'));
    return block ? match(block, /alt="([^"]*)"/i) : null;
  };
  const intro = match(page, /<div class="body markitup-text">([\s\S]*?)<\/div>/i);
  return {
    symbol: sid,
    name,
    url: `${RSI_ORIGIN}/orgs/${sid}`,
    logoUrl: absoluteUrl(match(page, /<div class="logo[^"]*">\s*<img src="([^"]+)"/i)),
    bannerUrl: absoluteUrl(match(page, /<div class="banner"><img src="([^"]+)"/i)),
    members: Number.isFinite(members) ? members : null,
    model: plainText(match(page, /<li class="model">([^<]*)<\/li>/i) || '') || null,
    commitment: plainText(match(page, /<li class="commitment">([^<]*)<\/li>/i) || '') || null,
    roleplay: plainText(match(page, /<li class="roleplay">([^<]*)<\/li>/i) || '') || null,
    focus: { primary: focusText('primary'), secondary: focusText('secondary') },
    recruiting: /js-orgs-apply/.test(page),
    intro: paragraphs(intro),
    links: links(intro),
    history: paragraphs(tab(page, 'history')),
    manifesto: paragraphs(tab(page, 'manifesto')),
    charter: paragraphs(tab(page, 'charter'))
  };
}

module.exports = parseRsiOrganization;
module.exports.RSI_ORIGIN = RSI_ORIGIN;
module.exports.paragraphs = paragraphs;
