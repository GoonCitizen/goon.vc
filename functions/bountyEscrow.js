'use strict';

/**
 * Bounty escrow. A bounty is listed first. When a member claims it, the reward
 * becomes a Market 2-of-3 federation: the poster is the buyer, the claimant
 * is the seller, and goon.vc is the arbiter. The poster then funds that vault.
 * Confirming the work, or letting the confirm window pass, releases it to the
 * claimant. The arbiter key is goon.vc's Fabric key at `m/7777'/6'`, seeded
 * by `bounty:<id>`, so it is never a Market order key.
 *
 * The order itself is a Market escrow order. This module keeps the bounty
 * status in step with that order and clears the claim when the payment window
 * ends or the claimant drops it before paying.
 */

const escrow = require('./marketEscrow');
const { seededKey } = require('./fabricFederation');

const ARBITER_KEY_PATH = "m/7777'/6'";
const STATUSES = Object.freeze(['open', 'claimed', 'funded', 'finished', 'disputed', 'released', 'refunded', 'cancelled']);
const ORDER_STATUS = Object.freeze({
  'awaiting-payment': 'claimed',
  paid: 'funded',
  delivered: 'finished',
  disputed: 'disputed',
  releasing: 'finished',
  refunding: 'funded',
  released: 'released',
  refunded: 'refunded',
  cancelled: 'open',
  expired: 'open'
});
const PARTY = Object.freeze({ poster: 'buyer', claimant: 'seller', arbiter: 'arbiter', system: 'system' });
const ACTION = Object.freeze({
  fund: 'fund',
  finish: 'deliver',
  confirm: 'confirm',
  dispute: 'dispute',
  release: 'release',
  refund: 'refund',
  expire: 'expire',
  settle: 'settle'
});

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function copy (value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * goon.vc's arbiter key for one bounty.
 * @param {string} xprv
 * @param {string} bountyId
 * @returns {{ path: string, key: Object, pubkey: string }}
 */
function arbiterKey (xprv, bountyId) {
  if (!xprv) throw fail(503, 'goon.vc has no Fabric key to arbitrate with.');
  const { path, key } = seededKey(xprv, ARBITER_KEY_PATH, `bounty:${bountyId}`);
  return { path, key, pubkey: key.pubkey };
}

/**
 * A listed bounty. No vault yet: the claimant's escrow key is not known.
 * @param {Object} fields `{ id, title, details, rewardSats, poster, posterName, posterPubkey, refundAddress }`
 * @param {Object} [ctx] `{ now }`
 * @returns {Object}
 */
function create (fields, ctx = {}) {
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const at = new Date(now).toISOString();
  const rewardSats = Math.round(Number(fields.rewardSats));
  if (!(rewardSats > 0)) throw fail(400, 'A bounty needs a reward.');
  const title = String(fields.title || '').trim();
  if (!title) throw fail(400, 'A bounty needs a title.');
  return {
    id: fields.id,
    title: title.slice(0, 120),
    details: String(fields.details || '').trim().slice(0, 2000),
    rewardSats,
    poster: fields.poster,
    posterName: fields.posterName || null,
    posterPubkey: fields.posterPubkey,
    refundAddress: fields.refundAddress,
    claimant: null,
    claimantName: null,
    claimantPubkey: null,
    payoutAddress: null,
    status: 'open',
    order: null,
    createdAt: at,
    updatedAt: at,
    log: [{ type: 'post', by: 'poster', at, name: fields.posterName || null }]
  };
}

function _withOrder (bounty, order) {
  const status = ORDER_STATUS[order.state] || bounty.status;
  const next = copy(bounty);
  next.order = order;
  next.status = status;
  next.updatedAt = order.updatedAt;
  if (status === 'open') {
    next.claimant = null;
    next.claimantName = null;
    next.claimantPubkey = null;
    next.payoutAddress = null;
    next.order = null;
  }
  return next;
}

/**
 * Claim an open bounty. Builds the 2-of-3 order and leaves it awaiting payment.
 * @param {Object} bounty
 * @param {Object} fields `{ claimant, claimantName, claimantPubkey, payoutAddress, network }`
 * @param {Object} arbiter from {@link arbiterKey}
 * @param {Object} [ctx] `{ now, settings }`
 * @returns {Object}
 */
function claim (bounty, fields, arbiter, ctx = {}) {
  if (bounty.status !== 'open') throw fail(409, 'This bounty is not open.');
  if (!fields.claimant || fields.claimant === bounty.poster) throw fail(409, 'You can’t claim your own bounty.');
  if (!bounty.posterPubkey || !bounty.refundAddress) throw fail(409, 'The poster has not finished setting up escrow for this bounty.');
  const order = escrow.newOrder({
    id: bounty.id,
    listing: bounty.id,
    title: bounty.title,
    priceSats: bounty.rewardSats,
    buyer: bounty.poster,
    seller: fields.claimant,
    buyerName: bounty.posterName,
    sellerName: fields.claimantName,
    buyerPubkey: bounty.posterPubkey,
    sellerPubkey: fields.claimantPubkey,
    refundAddress: bounty.refundAddress,
    payoutAddress: fields.payoutAddress,
    network: fields.network
  }, arbiter, ctx);
  const next = copy(bounty);
  next.claimant = fields.claimant;
  next.claimantName = fields.claimantName || null;
  next.claimantPubkey = order.sellerPubkey;
  next.payoutAddress = order.payoutAddress;
  next.status = 'claimed';
  next.order = order;
  next.updatedAt = order.updatedAt;
  next.log = (next.log || []).concat({ type: 'claim', by: 'claimant', at: order.updatedAt, name: fields.claimantName || null });
  return next;
}

/**
 * The claimant walks away before the poster has paid. The bounty is open again.
 * @param {Object} bounty
 * @param {Object} [ctx] `{ now, name }`
 * @returns {Object}
 */
function drop (bounty, ctx = {}) {
  if (bounty.status !== 'claimed') throw fail(409, 'You can only drop a claim before it is paid.');
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const at = new Date(now).toISOString();
  const next = copy(bounty);
  next.claimant = null;
  next.claimantName = null;
  next.claimantPubkey = null;
  next.payoutAddress = null;
  next.order = null;
  next.status = 'open';
  next.updatedAt = at;
  next.log = (next.log || []).concat({ type: 'drop', by: 'claimant', at, name: ctx.name || null });
  return next;
}

/**
 * Move a claimed bounty along its Market order.
 * @param {Object} bounty
 * @param {string} action `fund` | `finish` | `confirm` | `dispute` | `release` | `refund` | `expire` | `settle`
 * @param {Object} ctx `{ by: poster|claimant|arbiter|system, now, settings, input, name }`
 * @returns {{ bounty: Object, effects: Object }}
 */
function act (bounty, action, ctx = {}) {
  const orderAction = ACTION[action];
  if (!orderAction) throw fail(400, `Unknown bounty action: ${action}`);
  if (!bounty.order) throw fail(409, 'This bounty has no escrow yet.');
  const by = PARTY[ctx.by];
  if (!by) throw fail(403, 'You can’t do that to this bounty.');
  const { order, effects } = escrow.transition(bounty.order, orderAction, {
    by,
    now: ctx.now,
    settings: ctx.settings,
    input: ctx.input,
    name: ctx.name
  });
  const next = _withOrder(bounty, order);
  if (action === 'expire' || (action === 'settle' && next.status === 'refunded' && bounty.status === 'claimed')) {
    // A claim that was never paid, or whose payment window ended, is listed again.
  }
  return { bounty: next, effects };
}

/**
 * The deadline a claimed bounty has passed, if any.
 * @param {Object} bounty
 * @param {number} now
 * @returns {string|null} `expire` | `refund` | `release`
 */
function due (bounty, now) {
  if (!bounty.order) return null;
  return escrow.due(bounty.order, now);
}

/**
 * Who the viewer is: `poster`, `claimant`, `arbiter`, or null.
 * @param {Object} bounty
 * @param {Object|null} member
 * @param {string[]} [arbiters]
 * @returns {string|null}
 */
function roleOf (bounty, member, arbiters = []) {
  if (!member) return null;
  if (member.id === bounty.poster) return 'poster';
  if (bounty.claimant && member.id === bounty.claimant) return 'claimant';
  if (!bounty.order) return null;
  const role = escrow.roleOf(bounty.order, member, arbiters);
  return role === 'arbiter' ? 'arbiter' : null;
}

module.exports = {
  ARBITER_KEY_PATH,
  STATUSES,
  act,
  arbiterKey,
  claim,
  create,
  drop,
  due,
  roleOf
};
