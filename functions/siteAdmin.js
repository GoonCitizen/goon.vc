'use strict';

/**
 * Who may open the operator panel (`/admin`). A match is a linked Discord
 * account or the Fabric identity of a linked Passport key. A display name,
 * an RSI handle, and the `also` labels on an admin record are not a match.
 */

const { fabricIdentityIdFromPubkeyHex } = require('@fabric/core/functions/fabricIdentitySchnorr');
const { fabricPubkey } = require('./accountKey');

const DISCORD_RE = /^\d{5,25}$/;
const IDENTITY_RE = /^id1[0-9a-z]+$/;
const COMPRESSED_RE = /^0[23][0-9a-f]{64}$/;

/**
 * @param {*} raw `admins` from `contracts/goon-squad.json`.
 * @returns {Array<{ name: string|null, discord: string|null, fabric: string|null }>}
 */
function normalizeAdmins (raw) {
  const list = [];
  for (const entry of [].concat(raw || [])) {
    if (!entry || typeof entry !== 'object') continue;
    const discord = String(entry.discord || '').trim();
    const fabric = String(entry.fabric || '').trim().toLowerCase();
    const row = {
      name: entry.name ? String(entry.name) : null,
      discord: DISCORD_RE.test(discord) ? discord : null,
      fabric: IDENTITY_RE.test(fabric) ? fabric : null
    };
    if (row.discord || row.fabric) list.push(row);
  }
  return list;
}

/**
 * Fabric `id1…` for a linked account when its compressed pubkey was stored
 * (Passport sign-in keeps it on `profile.pubkeyHex`). Null for an x-only key:
 * the parity byte is gone, so the identity id is not known to display.
 * @param {Object|null} account
 * @returns {string|null}
 */
function fabricIdentityId (account) {
  if (!account || account.platform !== 'fabric') return null;
  const hex = account.profile && typeof account.profile.pubkeyHex === 'string'
    ? account.profile.pubkeyHex.trim().toLowerCase()
    : '';
  if (!COMPRESSED_RE.test(hex)) return null;
  try {
    return fabricIdentityIdFromPubkeyHex(hex);
  } catch (_) {
    return null;
  }
}

/**
 * Identity ids that can grant this account admin: the stored compressed key,
 * or either parity of an x-only key when that is all the record kept.
 * @param {Object|null} account
 * @returns {string[]}
 */
function authIdentityIds (account) {
  if (!account || account.platform !== 'fabric') return [];
  const known = fabricIdentityId(account);
  if (known) return [known];
  const xonly = fabricPubkey(account.id);
  if (!xonly) return [];
  const ids = [];
  for (const prefix of ['02', '03']) {
    try {
      ids.push(fabricIdentityIdFromPubkeyHex(prefix + xonly));
    } catch (_) { /* not a pubkey */ }
  }
  return ids;
}

/**
 * @param {Object|null} member
 * @param {*} admins
 * @returns {boolean}
 */
function memberIsAdmin (member, admins) {
  const list = normalizeAdmins(admins);
  if (!member || !list.length) return false;
  const discord = new Set();
  const fabric = new Set();
  for (const account of member.accounts || []) {
    if (account.platform === 'discord' && account.id) discord.add(String(account.id));
    for (const id of authIdentityIds(account)) fabric.add(id);
  }
  return list.some((admin) => (admin.discord && discord.has(admin.discord)) || (admin.fabric && fabric.has(admin.fabric)));
}

module.exports = { normalizeAdmins, fabricIdentityId, authIdentityIds, memberIsAdmin };
