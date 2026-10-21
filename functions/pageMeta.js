'use strict';

const escapeHtml = require('./escapeHtml');

const START = '<!-- page-meta -->';
const END = '<!-- /page-meta -->';
const MAX_DESCRIPTION = 200;

function plainText (html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function clip (text, max = MAX_DESCRIPTION) {
  const plain = plainText(text);
  if (plain.length <= max) return plain;
  return plain.slice(0, max - 1).replace(/\s+\S*$/, '') + '…';
}

function absolute (url, origin) {
  if (!url) return null;
  try {
    return new URL(url, origin).toString();
  } catch (_) {
    return null;
  }
}

/**
 * Key for {@link findPage}: same matching the client router uses
 * (case-insensitive, trailing slashes ignored).
 * @param {string} pathname
 * @returns {string}
 */
function pageKey (pathname) {
  return (String(pathname || '/').replace(/\/+$/, '') || '/').toLowerCase();
}

/**
 * @param {Array<{ path: string }>} pages
 * @param {string} pathname
 * @returns {object|null}
 */
function findPage (pages, pathname) {
  const key = pageKey(pathname);
  return (pages || []).find((page) => pageKey(page.path) === key) || null;
}

/**
 * Open Graph + Twitter card tags for one page, wrapped in markers so the
 * server can swap them per request.
 * @param {Object} page
 * @param {string} page.path
 * @param {string} page.title
 * @param {string} [page.description] Plain text or trusted HTML (tags are stripped).
 * @param {string} [page.image] Absolute, or relative to origin.
 * @param {string} [page.imageAlt]
 * @param {boolean} [page.largeImage] Wide image: use the large Twitter card.
 * @param {Object} site
 * @param {string} site.origin e.g. https://goon.vc
 * @param {string} site.name og:site_name
 * @returns {string}
 */
function renderMetaTags (page, site) {
  const url = absolute(page.path, site.origin);
  const image = absolute(page.image, site.origin);
  const description = clip(page.description);
  const tags = [
    description ? ['name', 'description', description] : null,
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', site.name],
    ['property', 'og:title', page.title],
    description ? ['property', 'og:description', description] : null,
    url ? ['property', 'og:url', url] : null,
    image ? ['property', 'og:image', image] : null,
    image && page.imageAlt ? ['property', 'og:image:alt', page.imageAlt] : null,
    ['name', 'twitter:card', image && page.largeImage ? 'summary_large_image' : 'summary'],
    ['name', 'twitter:title', page.title],
    description ? ['name', 'twitter:description', description] : null,
    image ? ['name', 'twitter:image', image] : null
  ].filter(Boolean).map(([attr, key, value]) => `<meta ${attr}="${key}" content="${escapeHtml(value)}">`);
  if (url) tags.push(`<link rel="canonical" href="${escapeHtml(url)}">`);
  return [START].concat(tags, END).join('\n    ');
}

/**
 * Replace the page-meta block and <title> in a built document.
 * @param {string} html
 * @param {string} tags Output of renderMetaTags.
 * @param {string} title
 * @returns {string}
 */
function injectMeta (html, tags, title) {
  const start = html.indexOf(START);
  const end = html.indexOf(END, start);
  if (start === -1 || end === -1) return html;
  return (html.slice(0, start) + tags + html.slice(end + END.length))
    .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
}

module.exports = {
  renderMetaTags,
  injectMeta,
  findPage,
  pageKey,
  plainText,
  clip
};
