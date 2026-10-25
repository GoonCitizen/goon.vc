'use strict';

/**
 * Account keys for goon.vc members: `platform:nativeId`, one per remote
 * account a member has proven (`discord:<snowflake>`, `fabric:<x-only
 * pubkey>`, later `slack:…`, `rsi:…`). Fabric pubkeys are lowercase x-only
 * hex — compressed keys drop their parity byte — so a key matches the Hub's
 * `IdentityCluster` members.
 */

const PLATFORM_RE = /^[a-z][a-z0-9-]{0,31}$/;
const DISCORD_RE = /^\d{5,25}$/;
// `/` and `~` would split or escape the Store's JSON pointer paths.
const NATIVE_RE = /^[^\s/~]{1,128}$/;

/**
 * Lowercase x-only hex for a compressed (33-byte) or x-only (32-byte) pubkey.
 * @param {*} value
 * @returns {string|null}
 */
function fabricPubkey (value) {
  const hex = String(value || '').trim().toLowerCase().replace(/^0x/, '');
  if (/^0[23][0-9a-f]{64}$/.test(hex)) return hex.slice(2);
  if (/^[0-9a-f]{64}$/.test(hex)) return hex;
  return null;
}

/**
 * @param {*} value `platform:nativeId`
 * @returns {{ platform: string, id: string, key: string }|null}
 */
function parseAccountKey (value) {
  const text = String(value || '').trim();
  const i = text.indexOf(':');
  if (i < 1) return null;
  return accountKey(text.slice(0, i), text.slice(i + 1));
}

/**
 * @param {string} platform
 * @param {*} nativeId
 * @returns {{ platform: string, id: string, key: string }|null}
 */
function accountKey (platform, nativeId) {
  const name = String(platform || '').trim().toLowerCase();
  if (!PLATFORM_RE.test(name)) return null;
  let id = String(nativeId == null ? '' : nativeId).trim();
  if (name === 'fabric') id = fabricPubkey(id);
  else if (name === 'discord') id = DISCORD_RE.test(id) ? id : null;
  else id = NATIVE_RE.test(id) ? id : null;
  if (!id) return null;
  return { platform: name, id, key: `${name}:${id}` };
}

module.exports = { accountKey, parseAccountKey, fabricPubkey };
