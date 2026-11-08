'use strict';

/**
 * @fileoverview Named Fabric federations as goon.vc builds them: core's
 * `FabricFederationDescriptor` (version 1), its id (SHA-256 of the canonical
 * JSON, so Hub, GoonCitizen, and Passport derive the same one), and the
 * signed `CONTRACT_MESSAGE` frames members exchange under it. Core's
 * `Federation.buildDescriptor` is used when the installed core has it;
 * otherwise the same descriptor is built here. Shared by alliance votes
 * (./allianceFederation) and Market escrow (./marketEscrow).
 */

const crypto = require('crypto');
const Key = require('@fabric/core/types/key');
const Message = require('@fabric/core/types/message');
const { stableStringify } = require('@fabric/core/functions/fabricCanonicalJson');
const { fabricPubkey, parseAccountKey } = require('./accountKey');

const DESCRIPTOR_TYPE = 'FabricFederationDescriptor';
const DESCRIPTOR_VERSION = 1;
const NETWORKS = ['regtest', 'signet', 'testnet', 'mainnet'];
const DEFAULT_CSV_BLOCKS = 144;
const MAX_FRAME_HEX = 64 * 1024;

function sha256 (text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * A compressed secp256k1 pubkey (lowercase hex) that is a point, or null.
 * @param {*} value
 * @returns {string|null}
 */
function compressedPubkey (value) {
  const hex = String(value || '').trim().toLowerCase().replace(/^0x/, '');
  if (!/^0[23][0-9a-f]{64}$/.test(hex)) return null;
  try {
    return new Key({ public: hex }).pubkey === hex ? hex : null;
  } catch (_) {
    return null;
  }
}

/**
 * A key as a compressed pubkey: a `fabric:<x-only>` account key (even y, as
 * BIP340 reads it), x-only hex, or compressed hex.
 * @param {*} value
 * @returns {string|null}
 */
function accountPubkey (value) {
  const text = String(value || '').trim();
  if (text.indexOf(':') !== -1) {
    const parsed = parseAccountKey(text);
    return parsed && parsed.platform === 'fabric' ? compressedPubkey('02' + parsed.id) : null;
  }
  if (/^[0-9a-fA-F]{64}$/.test(text)) return compressedPubkey('02' + text);
  return compressedPubkey(text);
}

function coreBuildDescriptor () {
  try {
    const Federation = require('@fabric/core/types/federation');
    return typeof Federation.buildDescriptor === 'function' ? Federation.buildDescriptor : null;
  } catch (_) {
    return null;
  }
}

/**
 * `@fabric/core` `Federation.buildDescriptor`, same output.
 * @param {Object} opts `{ validators, threshold, network, publisher, csvBlocks? }`
 * @returns {Object}
 */
function buildDescriptor (opts = {}) {
  const core = coreBuildDescriptor();
  if (core) return core(opts);
  const validators = [];
  for (const v of Array.isArray(opts.validators) ? opts.validators : []) {
    const pk = compressedPubkey(v);
    if (!pk) throw new Error(`invalid validator pubkey: ${String(v).slice(0, 80)}`);
    if (validators.some((x) => x.slice(2) === pk.slice(2))) continue;
    validators.push(pk);
  }
  validators.sort();
  if (validators.length < 1) throw new Error('at least one validator is required');
  const threshold = Number(opts.threshold);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > validators.length) {
    throw new Error(`threshold must be an integer from 1 to ${validators.length}`);
  }
  const network = String(opts.network || '').trim().toLowerCase();
  if (!NETWORKS.includes(network)) throw new Error(`unknown network: ${opts.network}`);
  const publisher = compressedPubkey(opts.publisher);
  if (!publisher) throw new Error('publisher pubkey is required');
  if (!validators.some((v) => v.slice(2) === publisher.slice(2))) throw new Error('publisher must be one of the validators');
  const csvBlocks = opts.csvBlocks != null ? Number(opts.csvBlocks) : DEFAULT_CSV_BLOCKS;
  if (!Number.isInteger(csvBlocks) || csvBlocks < 1 || csvBlocks > 65535) {
    throw new Error('csvBlocks must be an integer from 1 to 65535');
  }
  return {
    type: DESCRIPTOR_TYPE,
    version: DESCRIPTOR_VERSION,
    network,
    validators,
    threshold,
    signatureScheme: 'schnorr',
    internalKeyMode: 'nums',
    ladder: { softMode: 'reduced', softThreshold: threshold, csvBlocks },
    publisher
  };
}

/**
 * Federation id: SHA-256 of the canonical descriptor.
 * @param {Object} descriptor
 * @returns {string}
 */
function descriptorId (descriptor) {
  return sha256(stableStringify(descriptor));
}

function isValidator (descriptor, pubkey) {
  const x = fabricPubkey(pubkey);
  return !!x && !!descriptor && Array.isArray(descriptor.validators) && descriptor.validators.some((v) => v.slice(2) === x);
}

/**
 * Hardened child of an extended key, at `<base>/<a>'/<b>'` where a and b are
 * two 31-bit slices of SHA-256(`seed`): stable for the seed, and not linkable
 * to it without the xprv.
 * @param {string} xprv
 * @param {string} base e.g. `m/7777'/4'`
 * @param {string} seed
 * @returns {{ path: string, key: Key }}
 */
function seededKey (xprv, base, seed) {
  const digest = sha256(seed);
  const a = parseInt(digest.slice(0, 8), 16) & 0x7fffffff;
  const b = parseInt(digest.slice(8, 16), 16) & 0x7fffffff;
  const path = `${base}/${a}'/${b}'`;
  return { path, key: new Key({ xprv }).derive(path) };
}

/**
 * A signed `CONTRACT_MESSAGE` frame (hex) carrying `body`.
 * @param {Object} body
 * @param {Key} key
 * @returns {{ frame: string, id: string }}
 */
function signFrame (body, key) {
  const message = Message.fromLegacyBody('CONTRACT_MESSAGE', body);
  message.signWithKey(key);
  return { frame: message.toBuffer().toString('hex'), id: message.id };
}

/**
 * Read a frame and check its author's signature.
 * @param {string} frame hex
 * @returns {{ id: string, signer: string, body: Object }} `signer` is the x-only author pubkey
 */
function openFrame (frame) {
  const hex = String(frame || '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex) || hex.length % 2) throw new Error('frame must be hex');
  if (hex.length > MAX_FRAME_HEX) throw new Error('frame is too large');
  let message;
  try {
    message = Message.fromBuffer(Buffer.from(hex, 'hex'));
  } catch (_) {
    throw new Error('not a Fabric message');
  }
  if (message.type !== 'CONTRACT_MESSAGE') throw new Error('not a CONTRACT_MESSAGE');
  const author = message.raw && message.raw.author ? Buffer.from(message.raw.author).toString('hex') : '';
  const signer = fabricPubkey(author);
  if (!signer || /^0+$/.test(signer)) throw new Error('message is not signed');
  let verified = false;
  for (const prefix of ['02', '03']) {
    try {
      if (message.verifyWithKey(new Key({ public: prefix + signer }))) verified = true;
    } catch (_) { /* not a point with this parity */ }
    if (verified) break;
  }
  if (!verified) throw new Error('bad signature');
  // Field-encoded bodies (what core peers, Hubs, and Passport send) and JSON
  // bodies (frames stored before core moved to fields) both open.
  const parsed = Message.tryParseLegacyBody(message);
  if (!parsed.ok) throw new Error('message body is not readable');
  const body = parsed.value;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('message body is not an object');
  return { id: message.id, signer, body };
}

/**
 * A frame as the `fabric:` URI the Hub mailbox takes (core `encodeFabricUri`).
 * @param {string} frame hex
 * @returns {string}
 */
function frameUri (frame) {
  const { encodeFabricUri } = require('@fabric/core/functions/fabricUri');
  return encodeFabricUri(Buffer.from(frame, 'hex'), { encoding: 'base64url' });
}

/**
 * A frame from a `fabric:` URI or hex, as hex.
 * @param {string} value
 * @returns {string}
 */
function frameHex (value) {
  const text = String(value || '').trim();
  if (!/^fabric:/i.test(text)) return text.toLowerCase();
  const { decodeFabricUri } = require('@fabric/core/functions/fabricUri');
  const decoded = decodeFabricUri(text);
  if (!decoded || decoded.ok === false || !decoded.buffer) throw new Error((decoded && decoded.error) || 'not a fabric: frame');
  return Buffer.from(decoded.buffer).toString('hex');
}

module.exports = {
  DEFAULT_CSV_BLOCKS,
  DESCRIPTOR_TYPE,
  DESCRIPTOR_VERSION,
  NETWORKS,
  accountPubkey,
  buildDescriptor,
  compressedPubkey,
  descriptorId,
  frameHex,
  frameUri,
  isValidator,
  openFrame,
  seededKey,
  sha256,
  signFrame
};
