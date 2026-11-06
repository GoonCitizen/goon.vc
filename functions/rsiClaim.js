'use strict';

/**
 * RSI profile claims: a member proves an RSI handle is theirs by putting a
 * short code in that citizen's public bio. The code has the same `g00n:` +
 * 7 hex shape as GoonCitizen's bio token (star-citizen-live
 * `functions/rsiOwnershipClaim.js`), but is random per pending claim.
 */

const crypto = require('crypto');

const PREFIX = 'g00n:';
const CODE_RE = /\bg00n:([0-9a-f]{7})\b/gi;

/** @returns {string} a new claim code, e.g. `g00n:2b8b13c` */
function claimCode () {
  return PREFIX + crypto.randomBytes(4).toString('hex').slice(0, 7);
}

/**
 * True when `bio` holds `code` (case doesn't matter).
 * @param {string|null} bio
 * @param {string} code
 * @returns {boolean}
 */
function bioHasCode (bio, code) {
  const want = String(code || '').toLowerCase();
  if (!bio || !want.startsWith(PREFIX)) return false;
  for (const match of String(bio).matchAll(CODE_RE)) {
    if (`${PREFIX}${match[1].toLowerCase()}` === want) return true;
  }
  return false;
}

module.exports = { PREFIX, claimCode, bioHasCode };
