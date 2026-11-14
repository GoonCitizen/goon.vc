'use strict';

const assert = require('assert');
const bitcoin = require('bitcoinjs-lib');
const Key = require('@fabric/core/types/key');
const bounty = require('../functions/bountyEscrow');
const market = require('../functions/marketEscrow');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-12T12:00:00Z');

function address () {
  const key = new Key();
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.pubkey, 'hex'), network: bitcoin.networks.regtest }).address;
}

function funding (escrowAddress, sats) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 4), 0);
  tx.addOutput(bitcoin.address.toOutputScript(escrowAddress, bitcoin.networks.regtest), BigInt(sats));
  return { txid: tx.getId(), vout: 0, amountSats: sats, txHex: tx.toHex() };
}

describe('bounty escrow', function () {
  const xprv = new Key().xprv;
  const posterKey = new Key();
  const claimantKey = new Key();

  function listed (id = 'bounty1') {
    return bounty.create({
      id,
      title: 'Paint the Idris',
      details: 'Two coats.',
      rewardSats: 50000,
      poster: 'a'.repeat(16),
      posterName: 'Poster',
      posterPubkey: posterKey.pubkey,
      refundAddress: address()
    }, { now: NOW });
  }

  function claimed (id = 'bounty1') {
    return bounty.claim(listed(id), {
      claimant: 'b'.repeat(16),
      claimantName: 'Claimant',
      claimantPubkey: claimantKey.pubkey,
      payoutAddress: address(),
      network: 'regtest'
    }, bounty.arbiterKey(xprv, id), { now: NOW });
  }

  it('keeps arbiter keys off the Market path', function () {
    const key = bounty.arbiterKey(xprv, 'bounty1');
    assert.match(key.path, /^m\/7777'\/6'\/\d+'\/\d+'$/);
    assert.notStrictEqual(key.pubkey, market.arbiterKey(xprv, 'bounty1').pubkey);
    assert.strictEqual(bounty.arbiterKey(xprv, 'bounty1').pubkey, key.pubkey);
  });

  it('lists a bounty with no vault, then one claim leaves the other alone', function () {
    const first = listed('one');
    const second = listed('two');
    assert.strictEqual(first.status, 'open');
    assert.strictEqual(first.order, null);
    const taken = bounty.claim(first, {
      claimant: 'b'.repeat(16),
      claimantName: 'Claimant',
      claimantPubkey: claimantKey.pubkey,
      payoutAddress: address(),
      network: 'regtest'
    }, bounty.arbiterKey(xprv, 'one'), { now: NOW });
    assert.strictEqual(taken.status, 'claimed');
    assert.strictEqual(taken.order.state, 'awaiting-payment');
    assert.strictEqual(taken.order.buyer, first.poster);
    assert.strictEqual(taken.order.seller, 'b'.repeat(16));
    assert.strictEqual(second.status, 'open');
    assert.strictEqual(second.order, null);
    assert.notStrictEqual(taken.order.arbiterPubkey, bounty.arbiterKey(xprv, 'two').pubkey);
  });

  it('funds, finishes, and confirms', function () {
    let current = claimed();
    const paid = bounty.act(current, 'fund', { by: 'system', now: NOW + HOUR, input: { funding: funding(current.order.escrow.address, 50000) } });
    current = paid.bounty;
    assert.strictEqual(current.status, 'funded');
    const done = bounty.act(current, 'finish', { by: 'claimant', now: NOW + 2 * HOUR });
    current = done.bounty;
    assert.strictEqual(current.status, 'finished');
    assert.strictEqual(done.effects.withdraw, 'release');
    const confirmed = bounty.act(current, 'confirm', { by: 'poster', now: NOW + 3 * HOUR });
    assert.strictEqual(confirmed.effects.arbiterSign, true);
    assert.strictEqual(confirmed.bounty.order.state, 'releasing');
  });

  it('releases when the poster stays quiet after the work is finished', function () {
    let current = claimed();
    current = bounty.act(current, 'fund', { by: 'system', now: NOW + HOUR, input: { funding: funding(current.order.escrow.address, 50000) } }).bounty;
    current = bounty.act(current, 'finish', { by: 'claimant', now: NOW + 2 * HOUR }).bounty;
    current.order.withdrawals.release = market.buildWithdrawal(current.order, 'release', 1000);
    assert.strictEqual(bounty.due(current, NOW + 2 * HOUR + 3 * DAY), 'release');
    const released = bounty.act(current, 'release', { by: 'system', now: NOW + 2 * HOUR + 3 * DAY });
    assert.strictEqual(released.effects.arbiterSign, true);
    assert.strictEqual(released.bounty.order.state, 'releasing');
    const settled = bounty.act(released.bounty, 'settle', { by: 'system', now: NOW + 2 * HOUR + 3 * DAY, input: { txid: 'ab'.repeat(32) } });
    assert.strictEqual(settled.bounty.status, 'released');
  });

  it('reopens a bounty whose payment window ends, and a drop does the same', function () {
    const current = claimed();
    assert.strictEqual(bounty.due(current, NOW + 25 * HOUR), 'expire');
    const expired = bounty.act(current, 'expire', { by: 'system', now: NOW + 25 * HOUR });
    assert.strictEqual(expired.bounty.status, 'open');
    assert.strictEqual(expired.bounty.claimant, null);
    assert.strictEqual(expired.bounty.order, null);
    const dropped = bounty.drop(claimed('other'), { now: NOW + HOUR, name: 'Claimant' });
    assert.strictEqual(dropped.status, 'open');
    assert.strictEqual(dropped.order, null);
    assert.strictEqual(current.status, 'claimed');
  });
});
