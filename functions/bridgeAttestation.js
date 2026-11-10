'use strict';

/**
 * @fileoverview A Bridge is a trusted goon.vc instance that brings accounts
 * from another network (the G00N SQUAD Discord, and anywhere else the bot
 * runs) onto Fabric. It holds one hardened key per attributed account and
 * vouches for it with a `BridgeAttestation` frame signed by the bridge key:
 * "this key speaks for one account on <platform>, as seen by this Bridge".
 *
 * The attestation carries the account's key, never its id or name, and the
 * key is a hardened child of goon.vc's key, so nobody without goon.vc's xprv
 * can tell which account a key belongs to. The same account always gets the
 * same key.
 */

const crypto = require('crypto');
const Key = require('@fabric/core/types/key');
const { stableStringify } = require('@fabric/core/functions/fabricCanonicalJson');
const { parseAccountKey, fabricPubkey } = require('./accountKey');
const { signFrame, openFrame } = require('./allianceFederation');

const DESCRIPTOR_TYPE = 'FabricBridge';
const DESCRIPTOR_VERSION = 1;
const ATTESTATION_TYPE = 'BridgeAttestation';
// m/7777'/2'/0' signs attestations; m/7777'/3'/<a>'/<b>' is one account's key.
const BRIDGE_KEY_PATH = "m/7777'/2'/0'";
const ACCOUNT_KEY_PATH = "m/7777'/3'";
const PLATFORM_RE = /^[a-z][a-z0-9-]{0,31}$/;

function sha256 (text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * goon.vc's bridge signing key.
 * @param {string} xprv
 * @returns {Key}
 */
function bridgeKey (xprv) {
  return new Key({ xprv }).derive(BRIDGE_KEY_PATH);
}

/**
 * The key goon.vc holds for one account: two hardened 31-bit indexes from
 * the account key's hash, so collisions are negligible.
 * @param {string} xprv
 * @param {string} account `platform:id`
 * @returns {Key}
 */
function accountKey (xprv, account) {
  const parsed = parseAccountKey(account);
  if (!parsed) throw new Error('invalid account');
  const digest = sha256(`bridge-account:${parsed.key}`);
  const a = parseInt(digest.slice(0, 8), 16) & 0x7fffffff;
  const b = parseInt(digest.slice(8, 16), 16) & 0x7fffffff;
  return new Key({ xprv }).derive(`${ACCOUNT_KEY_PATH}/${a}'/${b}'`);
}

/**
 * @param {Object} fields
 * @param {string} fields.name
 * @param {string} fields.origin
 * @param {string[]} fields.platforms platforms whose accounts this Bridge attests
 * @param {string} fields.pubkey compressed bridge key
 * @returns {Object}
 */
function bridgeDescriptor (fields) {
  const platforms = [...new Set((fields.platforms || []).map((p) => String(p).toLowerCase()))].sort();
  if (!platforms.length || !platforms.every((p) => PLATFORM_RE.test(p))) throw new Error('bridge needs platforms');
  if (!/^0[23][0-9a-f]{64}$/.test(String(fields.pubkey || ''))) throw new Error('bridge needs a compressed pubkey');
  return {
    type: DESCRIPTOR_TYPE,
    version: DESCRIPTOR_VERSION,
    name: String(fields.name || '').trim(),
    origin: String(fields.origin || '').replace(/\/+$/, ''),
    platforms,
    pubkey: fields.pubkey
  };
}

function bridgeId (descriptor) {
  return sha256(stableStringify(descriptor));
}

/**
 * @param {string} id bridge id
 * @param {Object} fields `{ platform, account, attestedAt }`; `account` is the compressed account key
 * @returns {Object}
 */
function attestationBody (id, fields) {
  return {
    contract: id,
    type: ATTESTATION_TYPE,
    bridge: id,
    platform: fields.platform,
    account: fields.account,
    attestedAt: fields.attestedAt
  };
}

/**
 * Attest one account: its key, and the frame vouching for it.
 * @param {string} xprv
 * @param {Object} descriptor bridge descriptor
 * @param {string} account `platform:id`
 * @param {string} attestedAt ISO time
 * @returns {{ key: Key, pubkey: string, platform: string, frame: string, id: string }}
 */
function attest (xprv, descriptor, account, attestedAt) {
  const parsed = parseAccountKey(account);
  if (!parsed) throw new Error('invalid account');
  if (!descriptor.platforms.includes(parsed.platform)) throw new Error(`this Bridge does not attest ${parsed.platform} accounts`);
  const key = accountKey(xprv, parsed.key);
  const signed = signFrame(attestationBody(bridgeId(descriptor), { platform: parsed.platform, account: key.pubkey, attestedAt }), bridgeKey(xprv));
  return { key, pubkey: key.pubkey, platform: parsed.platform, frame: signed.frame, id: signed.id };
}

/**
 * Check an attestation frame against a bridge descriptor; throws with the reason.
 * @param {Object} descriptor
 * @param {string} frame hex
 * @returns {{ id: string, platform: string, account: string, attestedAt: string }}
 */
function verifyAttestation (descriptor, frame) {
  const opened = openFrame(frame);
  const body = opened.body;
  if (opened.signer !== fabricPubkey(descriptor.pubkey)) throw new Error('attestation is not signed by this Bridge');
  if (body.type !== ATTESTATION_TYPE) throw new Error('not a bridge attestation');
  const id = bridgeId(descriptor);
  if (body.bridge !== id || body.contract !== id) throw new Error('attestation is for another Bridge');
  if (!descriptor.platforms.includes(body.platform)) throw new Error(`this Bridge does not attest ${body.platform} accounts`);
  if (!/^0[23][0-9a-f]{64}$/.test(String(body.account || ''))) throw new Error('attestation needs the account key');
  if (!Number.isFinite(Date.parse(body.attestedAt))) throw new Error('attestation needs a time');
  return { id: opened.id, platform: body.platform, account: body.account, attestedAt: body.attestedAt };
}

module.exports = {
  ACCOUNT_KEY_PATH,
  ATTESTATION_TYPE,
  BRIDGE_KEY_PATH,
  DESCRIPTOR_TYPE,
  accountKey,
  attest,
  attestationBody,
  bridgeDescriptor,
  bridgeId,
  bridgeKey,
  verifyAttestation
};
