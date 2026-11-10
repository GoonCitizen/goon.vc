'use strict';

/**
 * @fileoverview Market escrow: a 2-of-3 named Fabric federation per order
 * (buyer, seller, goon.vc as arbiter) whose Taproot vault lives on the Hub.
 *
 * The descriptor is core's `FabricFederationDescriptor` (threshold 2, the
 * arbiter as publisher); its id is the descriptor hash, and every party
 * derives the same vault from it. goon.vc's arbiter key is fresh per order:
 * goon.vc's Fabric key at `m/7777'/4'/<a>'/<b>'`, a and b two 31-bit slices
 * of SHA-256(`market-order:<id>`).
 *
 * Each party signs only the withdrawal that pays them: the seller the
 * release to their payout address, the buyer the refund to theirs. goon.vc
 * adds the second signature when the other party agreed on the site (the
 * buyer confirms receipt; the seller refunds), when a deadline passes (no
 * delivery: refund; no confirmation: release), or when an arbiter rules on a
 * dispute. Buyer and seller signing together never need goon.vc.
 *
 * The pure order state machine lives here; services/market.js stores orders
 * and talks to the Hub.
 */

const bitcoin = require('bitcoinjs-lib');
const ecc = require('@fabric/core/types/ecc');
const Federation = require('@fabric/core/types/federation');
const {
  NETWORKS,
  accountPubkey,
  buildDescriptor,
  descriptorId,
  isValidator,
  seededKey,
  signFrame
} = require('./fabricFederation');
const { fabricPubkey } = require('./accountKey');

// Core initializes only the bitcoinjs-lib it resolves; a linked core resolves its own.
bitcoin.initEccLib(ecc);

// Hardened branch of goon.vc's key for Market arbiter keys.
const ARBITER_KEY_PATH = "m/7777'/4'";
const THRESHOLD = 2;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const DEFAULTS = Object.freeze({ payHours: 24, payGraceHours: 24, deliveryDays: 7, confirmDays: 3, feeSats: 1000 });
// Payments reported per order: a buyer may report a mistaken txid or two.
const MAX_PAYMENTS = 5;
const ORDER_STATES = Object.freeze(['awaiting-payment', 'paid', 'delivered', 'disputed', 'releasing', 'refunding', 'released', 'refunded', 'cancelled', 'expired']);
const OPEN_STATES = Object.freeze(['awaiting-payment', 'paid', 'delivered', 'disputed', 'releasing', 'refunding']);
// While an order is open its listing reads as reserved, paid, or delivered.
const LISTING_STATUS = Object.freeze({
  'awaiting-payment': 'reserved',
  paid: 'paid',
  delivered: 'delivered',
  disputed: 'delivered',
  releasing: 'delivered',
  refunding: 'paid',
  released: 'sold',
  refunded: 'available',
  cancelled: 'available',
  expired: 'available'
});

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function settingsOf (settings = {}) {
  const out = Object.assign({}, DEFAULTS);
  for (const name of Object.keys(DEFAULTS)) {
    const n = Number(settings[name]);
    if (Number.isFinite(n) && n > 0) out[name] = n;
  }
  return out;
}

/**
 * goon.vc's arbiter key for one order.
 * @param {string} xprv goon.vc's extended private key
 * @param {string} orderId
 * @returns {{ path: string, key: Object, pubkey: string }}
 */
function arbiterKey (xprv, orderId) {
  if (!xprv) throw fail(503, 'goon.vc has no Fabric key to arbitrate with.');
  const { path, key } = seededKey(xprv, ARBITER_KEY_PATH, `market-order:${orderId}`);
  return { path, key, pubkey: key.pubkey };
}

/**
 * A member's escrow key: the BIP87 cosigner key (`m/87'/B'/n'/0/0`) they
 * shared, with a proof tying it to one of their Fabric identities, through
 * the "Link your escrow key" Passport step. Never their identity key. The one
 * asked for when the member holds it, else the most recently linked one for
 * the network.
 * @param {Object} member goon.vc member
 * @param {string|null} [network] escrow network; null takes any
 * @param {string} [wanted] compressed or x-only cosigner pubkey
 * @returns {string|null} compressed pubkey
 */
function memberEscrowKey (member, network, wanted) {
  const keys = ((member && member.accounts) || []).filter((account) => account.platform === 'fabric' &&
    account.cosigner && /^0[23][0-9a-f]{64}$/.test(account.cosigner.pubkey) &&
    (!network || account.cosigner.network === network));
  if (wanted) {
    const x = fabricPubkey(String(wanted).toLowerCase());
    const held = x && keys.find((account) => account.cosigner.pubkey.slice(2) === x);
    return held ? held.cosigner.pubkey : null;
  }
  const pick = keys.slice().sort((a, b) => String(b.cosigner.linkedAt || '').localeCompare(String(a.cosigner.linkedAt || '')))[0];
  return pick ? pick.cosigner.pubkey : null;
}

/**
 * The escrow federation for an order.
 * @param {Object} opts
 * @param {string} opts.buyer compressed pubkey
 * @param {string} opts.seller compressed pubkey
 * @param {string} opts.arbiter compressed pubkey
 * @param {string} opts.network
 * @returns {{ federationId: string, descriptor: Object, address: string }}
 */
function escrowFor (opts = {}) {
  const network = String(opts.network || '').toLowerCase();
  if (!NETWORKS.includes(network)) throw fail(503, `Escrow needs a Bitcoin network (${NETWORKS.join(', ')}).`);
  const parties = [opts.buyer, opts.seller, opts.arbiter].map((pk) => accountPubkey(pk));
  if (parties.some((pk) => !pk)) throw fail(400, 'Escrow needs an escrow key for the buyer, the seller, and goon.vc.');
  if (new Set(parties.map((pk) => pk.slice(2))).size !== 3) throw fail(409, 'The buyer and seller must use different escrow keys.');
  const descriptor = buildDescriptor({ validators: parties, threshold: THRESHOLD, network, publisher: parties[2] });
  const vault = Federation.vaultForDescriptor(descriptor);
  return { federationId: descriptorId(descriptor), descriptor, address: vault.address };
}

/**
 * The `FederationInvite` goon.vc posts to the Hub mailbox for an order.
 * @param {Object} order
 * @param {Object} arbiter from {@link arbiterKey}
 * @returns {{ frame: string, id: string, body: Object }}
 */
function inviteFrame (order, arbiter) {
  const alias = { [fabricPubkey(order.buyerPubkey)]: 'buyer', [fabricPubkey(order.sellerPubkey)]: 'seller', [fabricPubkey(order.arbiterPubkey)]: 'arbiter' };
  const body = Federation.inviteMessage({
    descriptor: order.escrow.descriptor,
    name: `G00N SQUAD Market order ${order.id}`,
    members: order.escrow.descriptor.validators.map((pubkey) => ({ pubkey, alias: alias[pubkey.slice(2)] || null }))
  });
  return Object.assign(signFrame(body, arbiter.key), { body });
}

/**
 * Build a withdrawal from the escrow's funding coin: the whole coin, less
 * the fee, to one address.
 * @param {Object} order
 * @param {string} kind `release` | `refund`
 * @param {number} feeSats
 * @returns {Object} `{ kind, requestId, psbtBase64, fundedTxHex, vout, destinationAddress, amountSats, feeSats, signatures: [] }`
 */
function buildWithdrawal (order, kind, feeSats) {
  const destinationAddress = kind === 'release' ? order.payoutAddress : order.refundAddress;
  if (!destinationAddress) throw fail(409, kind === 'release' ? 'The seller has not given a payout address.' : 'The buyer has not given a refund address.');
  const funding = order.funding;
  if (!funding || !funding.txHex) throw fail(409, 'The escrow is not funded yet.');
  const amountSats = Number(funding.amountSats) - feeSats;
  if (!(amountSats >= Federation.DUST_SATS)) throw fail(409, 'The escrow holds too little to pay out after the fee.');
  const prepared = Federation.prepareWithdrawal({
    descriptor: order.escrow.descriptor,
    fundedTxHex: funding.txHex,
    vout: funding.vout,
    destinationAddress,
    amountSats,
    feeSats
  });
  return {
    kind,
    requestId: prepared.requestId,
    psbtBase64: prepared.psbtBase64,
    fundedTxHex: funding.txHex,
    vout: prepared.vout,
    destinationAddress,
    amountSats,
    feeSats,
    signatures: [],
    signers: []
  };
}

/** The `FederationWithdrawalRequest` body for a withdrawal. */
function withdrawalBody (order, withdrawal) {
  return Federation.withdrawalMessage(order.escrow.federationId, withdrawal);
}

/**
 * goon.vc's arbiter signatures for a withdrawal.
 * @param {Object} withdrawal
 * @param {Object} arbiter from {@link arbiterKey}
 * @returns {Array<{ pubkey: string, leafHash: string, signature: string }>}
 */
function arbiterSignatures (withdrawal, arbiter) {
  return Federation.signWithdrawal({ psbtBase64: withdrawal.psbtBase64, privateKey: arbiter.key.private }).signatures;
}

/**
 * Add verified signatures to a withdrawal. Throws when one doesn't verify.
 * @param {Object} order
 * @param {Object} withdrawal
 * @param {Array<Object>} signatures
 * @returns {Object} the withdrawal with `psbtBase64`, `signatures`, and `signers` (x-only) updated
 */
function addSignatures (order, withdrawal, signatures) {
  const result = Federation.addWithdrawalSignatures({
    descriptor: order.escrow.descriptor,
    psbtBase64: withdrawal.psbtBase64,
    signatures
  });
  const seen = new Set(withdrawal.signatures.map((s) => fabricPubkey(s.pubkey)));
  const kept = withdrawal.signatures.slice();
  for (const s of signatures) {
    const x = fabricPubkey(s.pubkey);
    if (!seen.has(x)) {
      seen.add(x);
      kept.push({ pubkey: x, leafHash: s.leafHash, signature: s.signature });
    }
  }
  return Object.assign({}, withdrawal, { psbtBase64: result.psbtBase64, signatures: kept, signers: result.signers });
}

/**
 * The signed transaction once two parties have signed, else null.
 * @param {Object} order
 * @param {Object} withdrawal
 * @returns {{ txHex: string, txid: string }|null}
 */
function finalize (order, withdrawal) {
  if ((withdrawal.signers || []).length < THRESHOLD) return null;
  return Federation.finalizeWithdrawal({ descriptor: order.escrow.descriptor, psbtBase64: withdrawal.psbtBase64 });
}

const BITCOIN_NETWORKS = {
  mainnet: bitcoin.networks.bitcoin,
  testnet: bitcoin.networks.testnet,
  signet: bitcoin.networks.testnet,
  regtest: bitcoin.networks.regtest
};

/**
 * A Bitcoin address on the escrow's network, trimmed, or throws.
 * @param {string} address
 * @param {string} network
 * @returns {string}
 */
function checkAddress (address, network) {
  const text = String(address || '').trim();
  if (!text) throw fail(400, 'A Bitcoin address is required.');
  const net = BITCOIN_NETWORKS[network];
  if (!net) throw fail(503, 'Escrow has no Bitcoin network.');
  try {
    bitcoin.address.toOutputScript(text, net);
  } catch (_) {
    throw fail(400, `That is not a ${network} Bitcoin address.`);
  }
  return text;
}

/**
 * Who a viewer is to an order.
 * @param {Object} order
 * @param {Object|null} member resolved goon.vc member
 * @param {string[]} [arbiters] account keys allowed to rule on disputes
 * @returns {string|null} `buyer` | `seller` | `arbiter` | null
 */
function roleOf (order, member, arbiters = []) {
  if (!member) return null;
  if (member.id === order.buyer) return 'buyer';
  if (member.id === order.seller) return 'seller';
  const keys = new Set((member.accounts || []).map((account) => account.key));
  return arbiters.some((key) => keys.has(key)) ? 'arbiter' : null;
}

function iso (ms) {
  return new Date(ms).toISOString();
}

const RULES = {
  fund: { from: ['awaiting-payment'], by: ['system'], to: 'paid' },
  cancel: { from: ['awaiting-payment'], by: ['buyer', 'seller', 'arbiter'], to: 'cancelled' },
  expire: { from: ['awaiting-payment'], by: ['system'], to: 'expired' },
  deliver: { from: ['paid'], by: ['seller'], to: 'delivered' },
  confirm: { from: ['delivered'], by: ['buyer'], to: 'releasing' },
  dispute: { from: ['paid', 'delivered'], by: ['buyer', 'seller'], to: 'disputed' },
  release: { from: ['delivered', 'disputed'], fromBy: { arbiter: ['disputed'] }, by: ['arbiter', 'system'], to: 'releasing' },
  refund: { from: ['paid', 'delivered', 'disputed'], fromBy: { arbiter: ['disputed'] }, by: ['seller', 'arbiter', 'system'], to: 'refunding' },
  settle: { from: ['releasing', 'refunding'], by: ['system'] }
};

/**
 * Move an order along. Returns the new order (the input is not changed) and
 * what the service should do about it.
 * @param {Object} order
 * @param {string} action one of `fund`, `cancel`, `expire`, `deliver`, `confirm`, `dispute`, `release`, `refund`, `settle`
 * @param {Object} ctx
 * @param {string} ctx.by `buyer` | `seller` | `arbiter` | `system`
 * @param {number} ctx.now ms
 * @param {Object} [ctx.settings] `{ payHours, deliveryDays, confirmDays }`
 * @param {Object} [ctx.input] `{ funding }`, `{ payoutAddress }`, `{ reason }`, `{ txid }`
 * @param {string} [ctx.name] display name for the log
 * @returns {{ order: Object, effects: { withdraw?: string, arbiterSign?: boolean, listingStatus: string, milestone?: string } }}
 */
function transition (order, action, ctx = {}) {
  const rule = RULES[action];
  if (!rule) throw fail(400, `Unknown order action: ${action}`);
  if (!rule.by.includes(ctx.by)) throw fail(403, `Only the ${rule.by.filter((r) => r !== 'system').join(' or ') || 'Market'} can ${action} this order.`);
  const from = (rule.fromBy && rule.fromBy[ctx.by]) || rule.from;
  if (!from.includes(order.state)) throw fail(409, `This order is ${order.state.replace('-', ' ')}, so you can't ${action} it now.`);
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const s = settingsOf(ctx.settings);
  const input = ctx.input || {};
  const next = JSON.parse(JSON.stringify(order));
  const effects = {};
  const at = iso(now);

  if (action === 'fund') {
    if (!input.funding || !input.funding.txid) throw fail(400, 'Funding needs the coin paying the escrow.');
    next.funding = input.funding;
    next.paidAt = at;
    next.deliverBy = iso(now + s.deliveryDays * DAY);
    effects.milestone = 'paid';
  } else if (action === 'deliver') {
    if (!next.payoutAddress) throw fail(400, 'Give a payout address for the release.');
    next.deliveredAt = at;
    next.confirmBy = iso(now + s.confirmDays * DAY);
    effects.withdraw = 'release';
    effects.arbiterSign = false;
    effects.milestone = 'delivered';
  } else if (action === 'confirm') {
    next.confirmedAt = at;
    effects.arbiterSign = true;
  } else if (action === 'dispute') {
    next.disputedAt = at;
    next.dispute = { by: ctx.by, reason: String(input.reason || '').trim().slice(0, 1000) || null };
    effects.milestone = 'disputed';
  } else if (action === 'release') {
    if (!next.withdrawals || !next.withdrawals.release) throw fail(409, 'The seller has not marked the order delivered with a payout address.');
    effects.arbiterSign = true;
  } else if (action === 'refund') {
    effects.withdraw = 'refund';
    effects.arbiterSign = true;
  } else if (action === 'cancel' || action === 'expire') {
    effects.milestone = 'released';
  }

  if (action === 'settle') {
    if (!input.txid) throw fail(400, 'Settling needs the payout transaction id.');
    next.state = order.state === 'releasing' ? 'released' : 'refunded';
    next.txid = input.txid;
    next.settledAt = at;
    effects.milestone = next.state === 'released' ? 'sold' : 'refunded';
  } else {
    next.state = rule.to;
  }
  if (action === 'release' || action === 'confirm') next.active = 'release';
  if (action === 'refund') next.active = 'refund';
  next.updatedAt = at;
  next.log = (next.log || []).concat(Object.assign({ type: action, by: ctx.by, at }, ctx.name ? { name: ctx.name } : {}, input.reason ? { reason: String(input.reason).slice(0, 200) } : {}));
  effects.listingStatus = LISTING_STATUS[next.state];
  return { order: next, effects };
}

/**
 * The deadline an order has passed, if any.
 * @param {Object} order
 * @param {number} now ms
 * @returns {string|null} `expire` | `refund` | `release`
 */
function due (order, now) {
  const past = (iso) => iso && Date.parse(iso) <= now;
  if (order.state === 'awaiting-payment' && past(order.payBy) && !(order.payGraceUntil && !past(order.payGraceUntil))) return 'expire';
  if (order.state === 'paid' && past(order.deliverBy)) return 'refund';
  if (order.state === 'delivered' && past(order.confirmBy)) return 'release';
  return null;
}

/**
 * A new order, awaiting payment.
 * @param {Object} fields `{ id, listing, title, priceSats, buyer, seller, buyerName, sellerName, buyerPubkey, sellerPubkey, refundAddress, network }`
 * @param {Object} arbiter from {@link arbiterKey}
 * @param {Object} ctx `{ now, settings }`
 * @returns {Object}
 */
function newOrder (fields, arbiter, ctx = {}) {
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const s = settingsOf(ctx.settings);
  const escrow = escrowFor({ buyer: fields.buyerPubkey, seller: fields.sellerPubkey, arbiter: arbiter.pubkey, network: fields.network });
  return {
    id: fields.id,
    listing: fields.listing,
    title: fields.title,
    priceSats: fields.priceSats,
    buyer: fields.buyer,
    seller: fields.seller,
    buyerName: fields.buyerName || null,
    sellerName: fields.sellerName || null,
    buyerPubkey: accountPubkey(fields.buyerPubkey),
    sellerPubkey: accountPubkey(fields.sellerPubkey),
    arbiterPubkey: arbiter.pubkey,
    arbiterPath: arbiter.path,
    network: fields.network,
    escrow,
    refundAddress: fields.refundAddress,
    payoutAddress: fields.payoutAddress || null,
    state: 'awaiting-payment',
    createdAt: iso(now),
    updatedAt: iso(now),
    payBy: iso(now + s.payHours * HOUR),
    funding: null,
    withdrawals: {},
    active: null,
    frames: [],
    log: [{ type: 'open', by: 'buyer', at: iso(now) }]
  };
}

/**
 * BIP21 payment link for the escrow.
 * @param {Object} order
 * @returns {string}
 */
function paymentUri (order) {
  const btc = (order.priceSats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  return `bitcoin:${order.escrow.address}?amount=${btc}&label=${encodeURIComponent(`G00N SQUAD Market order ${order.id}`)}`;
}

/**
 * The order's payment as a Hub invoice: the fields of Hub's invoice store
 * (`id`, `address`, `amountSats`, `memo`, `label`, `network`, `createdAt`,
 * `txids`) plus `amountBtc`, `bitcoinUri`, and `expiresAt`, so Hub's Invoice
 * view and wallets read it as they read their own.
 * @param {Object} order
 * @returns {Object}
 */
function invoice (order) {
  const txids = (order.payments || []).filter((p) => p.verified).map((p) => p.txid);
  if (order.funding && order.funding.txid && !txids.includes(order.funding.txid)) txids.unshift(order.funding.txid);
  return {
    id: order.id,
    address: order.escrow.address,
    amountSats: order.priceSats,
    amountBtc: (order.priceSats / 1e8).toFixed(8).replace(/0+$/, '').replace(/\.$/, ''),
    memo: `G00N SQUAD Market order ${order.id}`,
    label: order.title,
    network: order.network,
    createdAt: order.createdAt,
    expiresAt: order.payGraceUntil || order.payBy,
    bitcoinUri: paymentUri(order),
    txids
  };
}

/**
 * Record what the Hub said about a transaction paying the escrow (its L1
 * payment check: `verified`, `confirmations`, `inMempool`, `matchedSats`).
 * The first verified payment seen while the order awaits payment holds it
 * open `payGraceHours` past `payBy`, so a payment sent in time can confirm.
 * @param {Object} order
 * @param {string} txid
 * @param {Object} detail Hub L1 payment check
 * @param {Object} [ctx] `{ now, settings, by }`
 * @returns {Object} the updated order
 */
function notePayment (order, txid, detail = {}, ctx = {}) {
  const id = String(txid || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(id)) throw fail(400, 'A transaction id is 64 hex characters.');
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const s = settingsOf(ctx.settings);
  const next = JSON.parse(JSON.stringify(order));
  const payments = next.payments || [];
  let entry = payments.find((p) => p.txid === id);
  if (!entry) {
    if (payments.length >= MAX_PAYMENTS) throw fail(409, `This order already has ${MAX_PAYMENTS} reported payments.`);
    entry = { txid: id, reportedAt: iso(now), by: ctx.by || null, seenAt: null };
    payments.push(entry);
  }
  Object.assign(entry, {
    verified: !!detail.verified,
    confirmations: Number(detail.confirmations) || 0,
    inMempool: !!detail.inMempool,
    matchedSats: Number(detail.matchedSats) || 0,
    checkedAt: iso(now)
  });
  if (entry.verified && !entry.seenAt) {
    entry.seenAt = iso(now);
    next.log = (next.log || []).concat({ type: 'payment-seen', by: ctx.by || 'system', at: iso(now) });
    if (next.state === 'awaiting-payment' && !next.payGraceUntil) {
      next.payGraceUntil = iso(Math.max(Date.parse(next.payBy), now) + s.payGraceHours * HOUR);
    }
  }
  next.payments = payments;
  next.updatedAt = iso(now);
  return next;
}

module.exports = {
  ARBITER_KEY_PATH,
  DEFAULTS,
  LISTING_STATUS,
  OPEN_STATES,
  ORDER_STATES,
  THRESHOLD,
  addSignatures,
  arbiterKey,
  arbiterSignatures,
  buildWithdrawal,
  checkAddress,
  due,
  escrowFor,
  finalize,
  inviteFrame,
  invoice,
  isValidator,
  memberEscrowKey,
  newOrder,
  notePayment,
  paymentUri,
  roleOf,
  settingsOf,
  transition,
  withdrawalBody
};
