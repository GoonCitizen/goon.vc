'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const Key = require('@fabric/core/types/key');
const Federation = require('@fabric/core/types/federation');
const { createHubList } = require('../functions/hubApiProxy');
const { signFrame } = require('../functions/fabricFederation');
const Bounties = require('../services/bounties');

const HUB = 'https://hub.test';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function address () {
  const key = new Key();
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(key.pubkey, 'hex'), network: bitcoin.networks.regtest }).address;
}

function fundingTx (to, sats) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 8), 0);
  tx.addOutput(bitcoin.address.toOutputScript(to, bitcoin.networks.regtest), BigInt(sats));
  return { txid: tx.getId(), vout: 0, amountSats: sats, height: 3, txHex: tx.toHex() };
}

function member (id, name, key) {
  const identity = new Key().pubkey.slice(2);
  return {
    id,
    displayName: name,
    accounts: [{
      key: `fabric:${identity}`,
      platform: 'fabric',
      id: identity,
      via: 'passport',
      cosigner: { pubkey: key.pubkey, network: 'regtest', linkedAt: '2026-11-01T00:00:00.000Z' }
    }]
  };
}

function hubFetch (state) {
  return async function fetch (url, options = {}) {
    const u = new URL(url);
    const body = options.body ? JSON.parse(options.body) : {};
    const json = (status, payload) => ({ status, async text () { return JSON.stringify(payload); } });
    if (u.pathname === '/services/federations') return json(200, { network: 'regtest' });
    if (u.pathname === '/services/federations/messages' && options.method === 'POST') {
      state.frames.push(body.fabric);
      return json(200, { type: 'FederationMessageAccepted' });
    }
    const vault = /^\/services\/federations\/([0-9a-f]+)\/vault$/.exec(u.pathname);
    if (vault) return json(200, { federationId: vault[1], utxos: state.vault });
    const tx = /^\/services\/federations\/([0-9a-f]+)\/transactions$/.exec(u.pathname);
    if (tx && options.method === 'POST') {
      state.broadcasts.push(body.txHex);
      return json(200, { txid: bitcoin.Transaction.fromHex(body.txHex).getId() });
    }
    return json(404, { message: 'not found' });
  };
}

function route (service, method, url, { body = {}, as = null } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader () {},
      end (payload) { resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null }); }
    };
    const [pathname, search] = url.split('?');
    service.middleware()({ method, url: url, path: pathname, query: Object.fromEntries(new URLSearchParams(search || '')), body, member: as }, res, () => resolve({ status: 'next' }));
  });
}

describe('bounty board service', function () {
  this.timeout(10000);
  let dir;
  let board;
  let state;
  const clock = { now: Date.parse('2026-11-12T18:00:00Z') };
  const xprv = new Key().xprv;
  const posterKey = new Key();
  const claimantKey = new Key();
  const poster = member('a'.repeat(16), 'Poster', posterKey);
  const claimant = member('b'.repeat(16), 'Claimant', claimantKey);

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goon-bounties-'));
    state = { frames: [], vault: [], broadcasts: [] };
    board = new Bounties({
      path: dir,
      fetch: hubFetch(state),
      hubs: createHubList([HUB]),
      xprv,
      members: { async currentMember (req) { return req.member ? { member: req.member } : null; } },
      now: () => clock.now,
      tickMs: DAY
    });
    board.on('error', () => {});
    await board.start();
  });

  afterEach(async function () {
    await board.stop();
    fs.rmSync(dir, { recursive: true, force: true });
    clock.now = Date.parse('2026-11-12T18:00:00Z');
  });

  it('lists public names only, and one claim does not touch another bounty', async function () {
    const created = await route(board, 'POST', '/services/bounties', {
      as: poster,
      body: { title: 'Paint the Idris', details: 'Two coats.', reward: '50000', refundAddress: address() }
    });
    assert.strictEqual(created.status, 201, JSON.stringify(created.body));
    const other = await route(board, 'POST', '/services/bounties', {
      as: poster,
      body: { title: 'Escort the Hull-C', reward: '0.002 BTC', refundAddress: address() }
    });
    const listed = await route(board, 'GET', '/services/bounties?sort=reward');
    assert.strictEqual(listed.body.bounties[0].title, 'Escort the Hull-C');
    const text = JSON.stringify(listed.body);
    assert.ok(!text.includes(poster.id));
    assert.ok(!text.includes(posterKey.pubkey));
    assert.ok(text.includes('Poster'));

    const claim = await route(board, 'POST', `/services/bounties/${created.body.bounty.id}/claim`, {
      as: claimant,
      body: { payoutAddress: address() }
    });
    assert.strictEqual(claim.status, 200, JSON.stringify(claim.body));
    assert.strictEqual(claim.body.bounty.status, 'claimed');
    assert.strictEqual(claim.body.bounty.you, 'claimant');
    assert.ok(claim.body.bounty.invoice.address);
    assert.ok(claim.body.bounty.payUrl.includes('/payments?'));
    const untouched = board.bounties.get(other.body.bounty.id);
    assert.strictEqual(untouched.status, 'open');
    assert.strictEqual(untouched.claimant, null);

    const stranger = await route(board, 'GET', `/services/bounties/${created.body.bounty.id}`);
    assert.strictEqual(stranger.body.bounty.invoice, undefined);
    assert.ok(!JSON.stringify(stranger.body).includes(claimant.id));
  });

  it('pays the claimant when the poster confirms, and reopens an unpaid claim', async function () {
    const refund = address();
    const payout = address();
    const posted = await board.create({ title: 'Sweep the wreck', reward: '80000', refundAddress: refund }, poster);
    const open = await board.create({ title: 'Leave this one', reward: '1000', refundAddress: address() }, poster);
    const taken = await board.claim(posted.id, { payoutAddress: payout }, claimant);
    state.vault = [fundingTx(taken.invoice.address, 80000)];
    await board.tick();
    assert.strictEqual(board.bounties.get(posted.id).status, 'funded');
    await board.finish(posted.id, claimant);
    const finished = board.bounties.get(posted.id);
    const withdrawal = finished.order.withdrawals.release;
    const signed = Federation.signWithdrawal({ psbtBase64: withdrawal.psbtBase64, privateKey: claimantKey.private });
    const frame = signFrame(Federation.signatureMessage(finished.order.escrow.federationId, withdrawal.requestId, signed.signatures), claimantKey).frame;
    await board.ingest(frame);
    const confirmed = await board.confirm(posted.id, poster);
    assert.strictEqual(confirmed.status, 'released', JSON.stringify(confirmed));
    assert.strictEqual(state.broadcasts.length, 1);
    assert.strictEqual(board.bounties.get(open.id).status, 'open');

    const quiet = await board.create({ title: 'Quiet poster', reward: '90000', refundAddress: address() }, poster);
    const quietClaim = await board.claim(quiet.id, { payoutAddress: address() }, claimant);
    clock.now += 25 * HOUR;
    await board.tick();
    assert.strictEqual(board.bounties.get(quiet.id).status, 'open');
    assert.strictEqual(board.bounties.get(quiet.id).claimant, null);
    assert.ok(quietClaim.id);
  });
});
