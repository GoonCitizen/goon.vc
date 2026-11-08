'use strict';

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const Key = require('@fabric/core/types/key');
const Federation = require('@fabric/core/types/federation');
const escrow = require('../functions/marketEscrow');
const { openFrame, descriptorId } = require('../functions/fabricFederation');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-10-25T12:00:00Z');

function regtestAddress () {
  const key = new Key();
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.pubkey, 'hex'), network: bitcoin.networks.regtest }).address;
}

// A transaction paying `sats` to the escrow vault, as the buyer's wallet would.
function fundingTx (address, sats) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 7), 0);
  tx.addOutput(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest), BigInt(sats));
  return { txid: tx.getId(), vout: 0, amountSats: sats, txHex: tx.toHex() };
}

describe('market escrow', function () {
  const xprv = new Key().xprv;
  const buyer = new Key();
  const seller = new Key();

  function order (extra = {}) {
    const arbiter = escrow.arbiterKey(xprv, 'order1');
    return escrow.newOrder(Object.assign({
      id: 'order1',
      listing: 'listing1',
      title: 'Cutlass Black',
      priceSats: 120000,
      buyer: 'b'.repeat(16),
      seller: 's'.repeat(16),
      buyerPubkey: buyer.pubkey,
      sellerPubkey: seller.pubkey,
      refundAddress: regtestAddress(),
      network: 'regtest'
    }, extra), arbiter, { now: NOW });
  }

  it('derives a fresh, stable arbiter key per order', function () {
    const a = escrow.arbiterKey(xprv, 'order1');
    assert.match(a.path, /^m\/7777'\/4'\/\d+'\/\d+'$/);
    assert.strictEqual(escrow.arbiterKey(xprv, 'order1').pubkey, a.pubkey);
    assert.notStrictEqual(escrow.arbiterKey(xprv, 'order2').pubkey, a.pubkey);
    assert.throws(() => escrow.arbiterKey(null, 'order1'), (e) => e.status === 503);
  });

  it('builds a 2-of-3 core descriptor with goon.vc as publisher', function () {
    const o = order();
    const d = o.escrow.descriptor;
    assert.strictEqual(d.type, 'FabricFederationDescriptor');
    assert.strictEqual(d.threshold, 2);
    assert.strictEqual(d.validators.length, 3);
    assert.strictEqual(d.publisher, o.arbiterPubkey);
    assert.strictEqual(o.escrow.federationId, descriptorId(d));
    assert.deepStrictEqual(Federation.buildDescriptor({ validators: d.validators, threshold: 2, network: 'regtest', publisher: d.publisher }), d);
    assert.match(o.escrow.address, /^bcrt1p/);
    assert.throws(() => escrow.escrowFor({ buyer: buyer.pubkey, seller: buyer.pubkey, arbiter: o.arbiterPubkey, network: 'regtest' }), (e) => e.status === 409);
  });

  it('signs an invite the Hub accepts from its publisher', function () {
    const o = order();
    const invite = escrow.inviteFrame(o, escrow.arbiterKey(xprv, 'order1'));
    const opened = openFrame(invite.frame);
    assert.strictEqual(opened.body.type, 'FederationInvite');
    assert.deepStrictEqual(Federation.verifyInvite(opened.body, opened.signer), o.escrow.descriptor);
    assert.deepStrictEqual(opened.body.members.map((m) => m.alias).sort(), ['arbiter', 'buyer', 'seller']);
  });

  it('picks a member’s escrow key for the network, never an identity key', function () {
    const x = (key) => key.pubkey.slice(2);
    const identity = new Key();
    const member = { accounts: [
      { platform: 'fabric', id: x(identity), via: 'passport', linkedAt: '2026-01-01T00:00:00Z',
        cosigner: { pubkey: buyer.pubkey, network: 'regtest', linkedAt: '2026-01-01T00:00:00Z' } },
      { platform: 'fabric', id: x(new Key()), via: 'passport', linkedAt: '2026-06-01T00:00:00Z',
        cosigner: { pubkey: seller.pubkey, network: 'regtest', linkedAt: '2026-06-01T00:00:00Z' } },
      { platform: 'fabric', id: x(new Key()), via: 'passport', cosigner: { pubkey: new Key().pubkey, network: 'testnet', linkedAt: '2026-09-01T00:00:00Z' } },
      { platform: 'discord', id: '1', key: 'discord:1' }
    ] };
    assert.strictEqual(escrow.memberEscrowKey(member, 'regtest'), seller.pubkey, 'newest for the network');
    assert.strictEqual(escrow.memberEscrowKey(member, 'regtest', buyer.pubkey), buyer.pubkey);
    assert.strictEqual(escrow.memberEscrowKey(member, 'regtest', x(buyer)), buyer.pubkey);
    assert.strictEqual(escrow.memberEscrowKey(member, 'regtest', identity.pubkey), null, 'not the identity key');
    assert.strictEqual(escrow.memberEscrowKey(member, 'signet'), null);
    assert.strictEqual(escrow.memberEscrowKey({ accounts: [{ platform: 'fabric', id: x(identity), via: 'passport' }] }, 'regtest'), null);
    assert.strictEqual(escrow.memberEscrowKey({ accounts: [] }, null), null);
  });

  it('walks the happy path: pay, deliver, seller and buyer sign, no arbiter needed', function () {
    let o = order();
    assert.strictEqual(o.state, 'awaiting-payment');
    assert.strictEqual(o.payBy, new Date(NOW + 24 * HOUR).toISOString());
    let step = escrow.transition(o, 'fund', { by: 'system', now: NOW + HOUR, input: { funding: fundingTx(o.escrow.address, 120000) } });
    assert.deepStrictEqual(step.effects, { milestone: 'paid', listingStatus: 'paid' });
    o = step.order;
    assert.strictEqual(o.deliverBy, new Date(NOW + HOUR + 7 * DAY).toISOString());

    assert.throws(() => escrow.transition(o, 'deliver', { by: 'buyer', now: NOW }), (e) => e.status === 403);
    assert.throws(() => escrow.transition(o, 'deliver', { by: 'seller', now: NOW }), /payout address/);
    o.payoutAddress = regtestAddress();
    step = escrow.transition(o, 'deliver', { by: 'seller', now: NOW + 2 * HOUR });
    assert.strictEqual(step.effects.withdraw, 'release');
    assert.strictEqual(step.effects.arbiterSign, false);
    o = step.order;

    let w = escrow.buildWithdrawal(o, 'release', 1000);
    assert.strictEqual(w.amountSats, 119000);
    assert.strictEqual(w.destinationAddress, o.payoutAddress);
    assert.strictEqual(Federation.verifyWithdrawalRequest(o.escrow.descriptor, escrow.withdrawalBody(o, w)).requestId, w.requestId);
    const sellerSigs = Federation.signWithdrawal({ psbtBase64: w.psbtBase64, privateKey: seller.private }).signatures;
    w = escrow.addSignatures(o, w, sellerSigs);
    assert.strictEqual(escrow.finalize(o, w), null, 'one signature is not enough');
    const buyerSigs = Federation.signWithdrawal({ psbtBase64: w.psbtBase64, privateKey: buyer.private }).signatures;
    w = escrow.addSignatures(o, w, buyerSigs);
    assert.strictEqual(w.signers.length, 2);
    const done = escrow.finalize(o, w);
    assert.match(done.txid, /^[0-9a-f]{64}$/);
    const tx = bitcoin.Transaction.fromHex(done.txHex);
    assert.strictEqual(Number(tx.outs[0].value), 119000);

    step = escrow.transition(Object.assign({}, o, { state: 'releasing' }), 'settle', { by: 'system', now: NOW + 3 * HOUR, input: { txid: done.txid } });
    assert.strictEqual(step.order.state, 'released');
    assert.deepStrictEqual(step.effects, { milestone: 'sold', listingStatus: 'sold' });
  });

  it('lets goon.vc co-sign a refund with the buyer, and refuses outsiders’ signatures', function () {
    let o = escrow.transition(order(), 'fund', { by: 'system', now: NOW, input: { funding: fundingTx(order().escrow.address, 150000) } }).order;
    const step = escrow.transition(o, 'refund', { by: 'seller', now: NOW + HOUR });
    assert.deepStrictEqual([step.effects.withdraw, step.effects.arbiterSign, step.effects.listingStatus], ['refund', true, 'paid']);
    o = step.order;
    let w = escrow.buildWithdrawal(o, 'refund', 500);
    assert.strictEqual(w.destinationAddress, o.refundAddress);
    w = escrow.addSignatures(o, w, escrow.arbiterSignatures(w, escrow.arbiterKey(xprv, 'order1')));
    const outsider = Federation.signWithdrawal.bind(null, { psbtBase64: w.psbtBase64, privateKey: new Key().private });
    assert.throws(() => escrow.addSignatures(o, w, outsider().signatures));
    w = escrow.addSignatures(o, w, Federation.signWithdrawal({ psbtBase64: w.psbtBase64, privateKey: buyer.private }).signatures);
    assert.ok(escrow.finalize(o, w));
  });

  it('enforces who may act and when', function () {
    const o = order();
    assert.throws(() => escrow.transition(o, 'confirm', { by: 'buyer', now: NOW }), (e) => e.status === 409);
    assert.throws(() => escrow.transition(o, 'release', { by: 'buyer', now: NOW }), (e) => e.status === 403);
    assert.strictEqual(escrow.transition(o, 'cancel', { by: 'seller', now: NOW }).effects.listingStatus, 'available');
    const paid = escrow.transition(o, 'fund', { by: 'system', now: NOW, input: { funding: fundingTx(o.escrow.address, 120000) } }).order;
    const disputed = escrow.transition(paid, 'dispute', { by: 'buyer', now: NOW, input: { reason: 'never arrived' } });
    assert.deepStrictEqual(disputed.order.dispute, { by: 'buyer', reason: 'never arrived' });
    assert.throws(() => escrow.transition(disputed.order, 'release', { by: 'arbiter', now: NOW }), /payout address/);
    assert.strictEqual(escrow.transition(disputed.order, 'refund', { by: 'arbiter', now: NOW }).order.state, 'refunding');
  });

  it('lets a Market arbiter release or refund only in a dispute', function () {
    const o = order();
    const paid = escrow.transition(o, 'fund', { by: 'system', now: NOW, input: { funding: fundingTx(o.escrow.address, 120000) } }).order;
    assert.throws(() => escrow.transition(paid, 'refund', { by: 'arbiter', now: NOW }), (e) => e.status === 409);
    assert.throws(() => escrow.transition(Object.assign({}, paid, { state: 'delivered' }), 'release', { by: 'arbiter', now: NOW }), (e) => e.status === 409);
    assert.strictEqual(escrow.transition(paid, 'refund', { by: 'seller', now: NOW }).order.state, 'refunding');
  });

  it('finds passed deadlines', function () {
    const o = order();
    assert.strictEqual(escrow.due(o, NOW), null);
    assert.strictEqual(escrow.due(o, NOW + 25 * HOUR), 'expire');
    const paid = escrow.transition(o, 'fund', { by: 'system', now: NOW, input: { funding: fundingTx(o.escrow.address, 120000) } }).order;
    assert.strictEqual(escrow.due(paid, NOW + 6 * DAY), null);
    assert.strictEqual(escrow.due(paid, NOW + 8 * DAY), 'refund');
    const delivered = escrow.transition(Object.assign(paid, { payoutAddress: regtestAddress() }), 'deliver', { by: 'seller', now: NOW, settings: { confirmDays: 2 } }).order;
    assert.strictEqual(escrow.due(delivered, NOW + DAY), null);
    assert.strictEqual(escrow.due(delivered, NOW + 3 * DAY), 'release');
  });

  it('checks addresses against the escrow network', function () {
    const address = regtestAddress();
    assert.strictEqual(escrow.checkAddress(` ${address} `, 'regtest'), address);
    assert.throws(() => escrow.checkAddress(address, 'mainnet'), /mainnet/);
    assert.throws(() => escrow.checkAddress('', 'regtest'), (e) => e.status === 400);
    const taproot = bitcoin.payments.p2tr({
      internalPubkey: Buffer.from(new Key().pubkey, 'hex').subarray(1),
      network: bitcoin.networks.regtest
    }).address;
    assert.ok(taproot.startsWith('bcrt1p'));
    assert.strictEqual(escrow.checkAddress(taproot, 'regtest'), taproot);
  });

  it('writes a BIP21 link for the exact amount', function () {
    const o = order();
    assert.strictEqual(escrow.paymentUri(o), `bitcoin:${o.escrow.address}?amount=0.0012&label=G00N%20SQUAD%20Market%20order%20order1`);
  });

  it('reads as a Hub invoice', function () {
    const o = order();
    const inv = escrow.invoice(o);
    assert.deepStrictEqual(Object.keys(inv).sort(), ['address', 'amountBtc', 'amountSats', 'bitcoinUri', 'createdAt', 'expiresAt', 'id', 'label', 'memo', 'network', 'txids']);
    assert.strictEqual(inv.address, o.escrow.address);
    assert.strictEqual(inv.amountSats, 120000);
    assert.strictEqual(inv.amountBtc, '0.0012');
    assert.strictEqual(inv.bitcoinUri, escrow.paymentUri(o));
    assert.strictEqual(inv.expiresAt, o.payBy);
    assert.deepStrictEqual(inv.txids, []);
  });

  it('holds an order open while a payment seen in time confirms', function () {
    const o = order();
    const txid = 'ab'.repeat(32);
    assert.throws(() => escrow.notePayment(o, 'nope', {}, { now: NOW }), (e) => e.status === 400);
    const unverified = escrow.notePayment(o, txid, { verified: false, matchedSats: 1000 }, { now: NOW });
    assert.strictEqual(unverified.payGraceUntil, undefined);
    assert.strictEqual(escrow.due(unverified, NOW + 25 * HOUR), 'expire');

    const seen = escrow.notePayment(o, txid, { verified: true, confirmations: 0, inMempool: true, matchedSats: 120000 }, { now: NOW + 23 * HOUR, by: 'buyer' });
    assert.strictEqual(seen.payments.length, 1);
    assert.strictEqual(seen.payments[0].seenAt, new Date(NOW + 23 * HOUR).toISOString());
    assert.strictEqual(seen.payGraceUntil, new Date(NOW + 48 * HOUR).toISOString());
    assert.ok(seen.log.some((e) => e.type === 'payment-seen' && e.by === 'buyer'));
    assert.deepStrictEqual(escrow.invoice(seen).txids, [txid]);
    assert.strictEqual(escrow.invoice(seen).expiresAt, seen.payGraceUntil);
    assert.strictEqual(escrow.due(seen, NOW + 25 * HOUR), null);
    assert.strictEqual(escrow.due(seen, NOW + 49 * HOUR), 'expire');

    const again = escrow.notePayment(seen, txid, { verified: true, confirmations: 2, matchedSats: 120000 }, { now: NOW + 24 * HOUR });
    assert.strictEqual(again.payments.length, 1);
    assert.strictEqual(again.payments[0].confirmations, 2);
    assert.strictEqual(again.payGraceUntil, seen.payGraceUntil);
    assert.strictEqual(again.log.filter((e) => e.type === 'payment-seen').length, 1);
  });

  it('knows each party’s role', function () {
    const o = order();
    assert.strictEqual(escrow.roleOf(o, { id: o.buyer, accounts: [] }), 'buyer');
    assert.strictEqual(escrow.roleOf(o, { id: o.seller, accounts: [] }), 'seller');
    assert.strictEqual(escrow.roleOf(o, { id: 'x'.repeat(16), accounts: [{ key: 'discord:9' }] }, ['discord:9']), 'arbiter');
    assert.strictEqual(escrow.roleOf(o, { id: 'x'.repeat(16), accounts: [] }, ['discord:9']), null);
  });
});
