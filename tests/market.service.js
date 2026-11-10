'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const { execFile } = require('child_process');
const path = require('path');
const bitcoin = require('bitcoinjs-lib');
const Key = require('@fabric/core/types/key');
const Federation = require('@fabric/core/types/federation');
const Message = require('@fabric/core/types/message');
const { decodeFabricUri } = require('@fabric/core/functions/fabricUri');
const { readMailboxFetch } = require('@fabric/core/types/delegation');
const { fabricPubkey } = require('../functions/accountKey');
const { deriveAccount } = require('@fabric/core/functions/accountKeys');
const Market = require('../services/market');
const { createHubList } = require('../functions/hubApiProxy');
const { signFrame } = require('../functions/fabricFederation');

const GUILD = '1190527980120850493';
const FORUM = '1200000000000000001';
const BOT = '1100000000000000001';
const SELLER_DISCORD = '1100000000000000777';
const REPLIER_DISCORD = '1100000000000000888';
const THREAD = '1300000000000000001';
const HUB = 'https://hub.test';
const DAY = 24 * 60 * 60 * 1000;
const VIEW = String(1n << 10n);
const TAGS = [
  { id: '1400000000000000001', name: 'Ship' },
  { id: '1400000000000000002', name: 'Paint' },
  { id: '1400000000000000003', name: 'Available' },
  { id: '1400000000000000004', name: 'Reserved' },
  { id: '1400000000000000005', name: 'Sold' },
  { id: '1400000000000000006', name: 'Dibs' }
];

function json (body, status = 200) {
  return new Response(body === undefined ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function regtestAddress () {
  return bitcoin.payments.p2wpkh({ pubkey: Buffer.from(new Key().pubkey, 'hex'), network: bitcoin.networks.regtest }).address;
}

function fundingTx (address, sats) {
  const tx = new bitcoin.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 9), 0);
  tx.addOutput(bitcoin.address.toOutputScript(address, bitcoin.networks.regtest), BigInt(sats));
  return { txid: tx.getId(), vout: 0, amountSats: sats, height: 101, txHex: tx.toHex() };
}

// Discord, the webhook, mempool.space, and the Hub, all in memory.
function world (opts = {}) {
  let snow = 1500000000000000000n;
  const next = () => String(++snow);
  const state = {
    calls: [],
    forumPublic: opts.forumPublic !== false,
    threads: new Map(),
    messages: new Map(),
    webhooks: [],
    hubFrames: [],
    mailboxReads: [],
    vault: [],
    broadcasts: [],
    // txid → { address, sats, confirmations }: what the Hub's bitcoind sees
    chain: new Map(),
    network: opts.network || 'regtest'
  };
  state.addThread = (thread, starter, replies = []) => {
    state.threads.set(thread.id, Object.assign({ parent_id: FORUM, applied_tags: [], thread_metadata: { archived: false, locked: false } }, thread));
    state.messages.set(thread.id, [Object.assign({ id: thread.id, channel_id: thread.id, type: 0, attachments: [], embeds: [], mentions: [] }, starter)]
      .concat(replies.map((r) => Object.assign({ channel_id: thread.id, type: 0, attachments: [], embeds: [], mentions: [] }, r))));
  };
  state.fetch = async (url, init = {}) => {
    const method = (init.method || 'GET').toUpperCase();
    const body = init.body ? JSON.parse(init.body) : undefined;
    const u = new URL(url);
    state.calls.push({ method, url: u.pathname + u.search, body });
    if (u.hostname === 'mempool.space') return json({ USD: 80000 });
    if (url.startsWith(HUB)) return hub(method, u, body, init.headers || {});
    const p = u.pathname.replace('/api/v10', '');
    if (p === '/users/@me') return json({ id: BOT, username: 'goon.vc' });
    if (p === `/guilds/${GUILD}`) return json({ id: GUILD, roles: [{ id: GUILD, permissions: state.forumPublic ? VIEW : '0' }] });
    if (p === `/guilds/${GUILD}/channels`) return json([{ id: FORUM, guild_id: GUILD, type: 15, name: 'market', permission_overwrites: [], available_tags: TAGS }]);
    if (p === `/guilds/${GUILD}/threads/active`) return json({ threads: Array.from(state.threads.values()).filter((t) => !t.thread_metadata.archived) });
    if (p === `/channels/${FORUM}/threads/archived/public`) return json({ threads: Array.from(state.threads.values()).filter((t) => t.thread_metadata.archived), has_more: false });
    if (p === `/channels/${FORUM}/webhooks`) {
      if (method === 'GET') return json(state.webhooks);
      const hook = { id: next(), token: 'secret-token', type: 1, name: body.name, user: { id: BOT } };
      state.webhooks.push(hook);
      return json(hook);
    }
    if (p === `/channels/${FORUM}/threads` && method === 'POST') {
      const id = next();
      state.addThread({ id, name: body.name, applied_tags: body.applied_tags }, Object.assign({ author: { id: BOT, bot: true } }, body.message));
      return json({ id, message: { id } }, 201);
    }
    let m = /^\/webhooks\/(\d+)\/([^/]+)(?:\/messages\/(\d+))?$/.exec(p);
    if (m) {
      if (method === 'PATCH') return json({ id: m[3] });
      const threadId = u.searchParams.get('thread_id');
      if (threadId) {
        const id = next();
        state.messages.get(threadId).push({ id, channel_id: threadId, webhook_id: m[1], author: { id: m[1], username: body.username, bot: true }, content: body.content });
        state.threads.get(threadId).last_message_id = id;
        return json({ id, channel_id: threadId });
      }
      const id = next();
      state.addThread({ id, name: body.thread_name, applied_tags: body.applied_tags }, { webhook_id: m[1], author: { id: m[1], username: body.username, bot: true }, content: body.content, embeds: body.embeds });
      return json({ id, channel_id: id });
    }
    m = /^\/channels\/(\d+)(?:\/messages(?:\/(\d+))?)?$/.exec(p);
    if (m) {
      const thread = state.threads.get(m[1]);
      if (!thread) return json({ message: 'Unknown Channel', code: 10003 }, 404);
      const list = state.messages.get(m[1]);
      if (!p.includes('/messages')) {
        if (method === 'PATCH') {
          if (body.applied_tags) thread.applied_tags = body.applied_tags;
          if (body.name) thread.name = body.name;
          thread.thread_metadata = Object.assign({}, thread.thread_metadata, 'archived' in body ? { archived: body.archived } : {}, 'locked' in body ? { locked: body.locked } : {});
        }
        return json(thread);
      }
      if (m[2]) {
        const found = list.find((x) => x.id === m[2]);
        if (method === 'PATCH') return json(Object.assign(found, body));
        return found ? json(found) : json({ message: 'Unknown Message', code: 10008 }, 404);
      }
      if (method === 'POST') {
        const id = next();
        list.push({ id, channel_id: m[1], author: { id: BOT, bot: true }, content: body.content });
        thread.last_message_id = id;
        return json({ id, channel_id: m[1] });
      }
      const after = BigInt(u.searchParams.get('after') || '0');
      return json(list.filter((x) => BigInt(x.id) > after));
    }
    return json({ message: `unexpected ${method} ${p}` }, 500);
  };
  function hub (method, u, body, headers = {}) {
    if (u.pathname === '/services/federations') return json({ type: 'FederationsStatus', network: state.network, pubkey: '02'.padEnd(66, 'a') });
    if (u.pathname === '/services/federations/messages') {
      if (method === 'POST') {
        const decoded = decodeFabricUri(body.fabric);
        assert.ok(decoded.ok, decoded.error);
        const parsed = Message.tryParseLegacyBody(decoded.message);
        assert.strictEqual(parsed.encoding, 'fields', 'a Hub drops JSON CONTRACT_MESSAGE bodies');
        state.hubFrames.push(parsed.value);
        return json({ type: 'FederationMessageAccepted' });
      }
      const read = readMailboxFetch(headers['X-Fabric-Mailbox'] || '', { origin: u.origin, purpose: 'federation-mailbox' });
      if (!read.ok || u.searchParams.has('pubkey')) return json({ message: 'signed mailbox read required' }, 401);
      state.mailboxReads.push(read);
      return json({ type: 'FederationMessages', messages: [], next: 0, more: false });
    }
    let m = /^\/services\/federations\/([0-9a-f]+)\/vault$/.exec(u.pathname);
    if (m) return json({ federationId: m[1], utxos: state.vault, balanceSats: state.vault.reduce((s, x) => s + x.amountSats, 0) });
    m = /^\/services\/bitcoin\/transactions\/([0-9a-f]{64})$/.exec(u.pathname);
    if (m) {
      const address = u.searchParams.get('address');
      const amountSats = Number(u.searchParams.get('amountSats'));
      const tx = state.chain.get(m[1]);
      const matchedSats = tx && tx.address === address ? tx.sats : 0;
      const verified = !!tx && matchedSats >= amountSats;
      const confirmations = tx ? tx.confirmations : 0;
      return json({ verified, confirmations, inMempool: verified && confirmations === 0, matchedSats, network: state.network, txid: m[1], address, amountSats });
    }
    m = /^\/services\/federations\/([0-9a-f]+)\/transactions$/.exec(u.pathname);
    if (m) {
      const tx = bitcoin.Transaction.fromHex(body.txHex);
      state.broadcasts.push(body.txHex);
      return json({ txid: tx.getId() });
    }
    return json({ message: 'not found' }, 404);
  }
  return state;
}

function membersStub () {
  const byId = new Map();
  let n = 0;
  const stub = {
    add (member) {
      byId.set(member.id, member);
      return member;
    },
    async currentMember (req) {
      return req.member ? { member: req.member } : null;
    },
    async resolve (id) {
      if (byId.has(id)) return byId.get(id);
      return Array.from(byId.values()).find((m) => m.accounts.some((a) => a.key === id)) || null;
    },
    async memberFor (key, opts = {}) {
      const found = await stub.resolve(key);
      if (found || !opts.create) return found;
      const [platform, id] = key.split(':');
      return stub.add({ id: String(++n).padStart(16, 'd'), displayName: opts.displayName || null, accounts: [{ key, platform, id, via: opts.via }] });
    }
  };
  return stub;
}

// A member whose Fabric identity (a key of its own) shared `key` as its
// escrow key for `network`.
function fabricMember (id, name, key, network = 'regtest') {
  const x = new Key().pubkey.slice(2);
  return { id, displayName: name, accounts: [{ key: `fabric:${x}`, platform: 'fabric', id: x, via: 'passport', linkedAt: '2026-10-01T00:00:00.000Z',
    cosigner: { pubkey: key.pubkey, network, linkedAt: '2026-10-01T00:00:00.000Z' } }] };
}

function route (service, method, url, { body = {}, as = null } = {}) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      statusCode: 200,
      headers: {},
      setHeader (name, value) { this.headers[name.toLowerCase()] = value; },
      end (payload) { resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null, headers: this.headers }); }
    };
    const [pathname, search] = url.split('?');
    const query = Object.fromEntries(new URLSearchParams(search || ''));
    service.middleware()({ method, url, path: pathname, query, body, member: as }, res, () => resolve({ status: 'next' }));
  });
}

async function settle (market) {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    await market._queue;
    await market._syncQueue;
  }
}

describe('Market service', function () {
  this.timeout(10000);
  let dir;
  let market;
  let w;
  let members;
  const clock = { now: Date.parse('2026-10-25T12:00:00Z') };
  const xprv = new Key().xprv;

  async function boot (opts = {}) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goon-market-'));
    w = world(opts.world);
    members = membersStub();
    market = new Market(Object.assign({
      path: dir,
      discord: { token: 'bot-token', guildId: GUILD },
      fetch: w.fetch,
      resolveToken: () => ({ token: 'bot-token' }),
      hubs: createHubList([HUB]),
      xprv,
      members,
      now: () => clock.now,
      tickMs: 0,
      ttlMs: 0,
      rateTtlMs: 0,
      siteUrl: 'https://goon.vc',
      arbiters: ['discord:1100000000000000999']
    }, opts.market));
    market.on('error', () => {});
    await market.start();
    await market._syncing;
    await market._refreshRate();
  }

  afterEach(async function () {
    if (market) await market.stop();
    market = null;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('mirrors a hand-written forum post and its replies, without Discord ids', async function () {
    await boot();
    w.addThread(
      { id: THREAD, name: 'WTS Cutlass Black LTI', owner_id: SELLER_DISCORD, applied_tags: [TAGS[0].id, TAGS[2].id] },
      { author: { id: SELLER_DISCORD, username: 'drake_fan', global_name: 'Drake Fan' }, content: 'Price: 0.005 BTC\nGiftable, from my hangar.' },
      [{ id: '1300000000000000010', author: { id: REPLIER_DISCORD, username: 'buyer1' }, content: `<@${SELLER_DISCORD}> still available?`, mentions: [{ id: SELLER_DISCORD, username: 'drake_fan', global_name: 'Drake Fan' }], timestamp: '2026-10-25T12:01:00.000Z' }]
    );
    await market.syncForum({ archived: true });
    const catalog = await route(market, 'GET', '/services/market');
    assert.strictEqual(catalog.status, 200);
    assert.strictEqual(catalog.body.listings.length, 1);
    const listing = catalog.body.listings[0];
    assert.strictEqual(listing.title, 'WTS Cutlass Black LTI');
    assert.strictEqual(listing.kind, 'Ship');
    assert.strictEqual(listing.priceSats, 500000);
    assert.strictEqual(listing.insurance, 'LTI');
    assert.strictEqual(listing.giftable, true);
    assert.strictEqual(listing.seller.name, 'Drake Fan');
    assert.strictEqual(listing.postedOn, 'discord');
    assert.strictEqual(listing.price.usd, '≈ $400');
    const detail = await route(market, 'GET', `/services/market/listings/${listing.id}`);
    assert.strictEqual(detail.body.replies.length, 1);
    assert.strictEqual(detail.body.replies[0].body, '@Drake Fan still available?');
    const text = JSON.stringify([catalog.body, detail.body]);
    assert.ok(!text.includes(SELLER_DISCORD) && !text.includes(REPLIER_DISCORD), 'no Discord user ids');
    const seller = await members.resolve(`discord:${SELLER_DISCORD}`);
    assert.strictEqual(seller.accounts[0].via, 'directory');
    assert.ok(!text.includes(seller.id), 'no member ids');

    w.threads.get(THREAD).name = 'WTS Cutlass Black LTI (price drop)';
    await market.syncForum();
    const again = await route(market, 'GET', `/services/market/listings/${listing.id}`);
    assert.strictEqual(again.body.title, 'WTS Cutlass Black LTI (price drop)');
  });

  it('does not mirror a forum everyone cannot view', async function () {
    await boot({ world: { forumPublic: false } });
    assert.match(market.status.error, /not public/);
    const catalog = await route(market, 'GET', '/services/market');
    assert.strictEqual(catalog.body.forum.mirrored, false);
  });

  it('posts site listings as the seller through a webhook and edits that post', async function () {
    await boot();
    const seller = members.add({ id: 'a'.repeat(16), displayName: 'Hangar Queen', avatarUrl: 'https://cdn.example/a.png', accounts: [] });
    const made = await route(market, 'POST', '/services/market/listings', { as: seller, body: { title: 'Carrack Expedition', kind: 'ship', price: '$400', insurance: '120 mo' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.priceSats, 500000);
    await settle(market);
    const post = w.calls.find((c) => c.method === 'POST' && /^\/api\/v10\/webhooks\//.test(c.url));
    assert.ok(post, 'webhook post');
    assert.strictEqual(post.body.username, 'Hangar Queen');
    assert.strictEqual(post.body.thread_name, 'Carrack Expedition');
    assert.deepStrictEqual(post.body.applied_tags, [TAGS[0].id, TAGS[2].id]);
    assert.ok(post.body.components[0].components.some((b) => b.custom_id === `market:buy:${made.body.id}`));
    const listing = market.listings.get(made.body.id);
    assert.strictEqual(listing.forum.authored, 'webhook');

    const edited = await route(market, 'PATCH', `/services/market/listings/${made.body.id}`, { as: seller, body: { price: '0.004 BTC' } });
    assert.strictEqual(edited.body.priceSats, 400000);
    await settle(market);
    assert.ok(w.calls.some((c) => c.method === 'PATCH' && c.url.includes(`/messages/${listing.forum.starterId}`)), 'starter edited');

    const stranger = members.add({ id: 'c'.repeat(16), displayName: 'Nobody', accounts: [] });
    const refused = await route(market, 'PATCH', `/services/market/listings/${made.body.id}`, { as: stranger, body: { price: '1 BTC' } });
    assert.strictEqual(refused.status, 403);
    const anonymous = await route(market, 'POST', '/services/market/listings', { body: { title: 'x' } });
    assert.strictEqual(anonymous.status, 401);
    const stored = await market.store.get('/webhook');
    assert.ok(!JSON.stringify((await route(market, 'GET', '/services/market')).body).includes(stored.token), 'webhook token stays private');
  });

  it('turns site edits of hand-written posts into tags plus an update reply, keeping site values', async function () {
    await boot();
    w.addThread(
      { id: THREAD, name: 'Paint pack', owner_id: SELLER_DISCORD, applied_tags: [TAGS[1].id] },
      { author: { id: SELLER_DISCORD, username: 'drake_fan' }, content: 'Price: 100k sats' }
    );
    await market.syncForum({ archived: true });
    const id = market.threads.get(THREAD);
    const seller = await members.resolve(`discord:${SELLER_DISCORD}`);
    const res = await route(market, 'PATCH', `/services/market/listings/${id}`, { as: seller, body: { price: '150k sats', status: 'sold' } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    await settle(market);
    const reply = w.messages.get(THREAD).find((m) => /^Updated on goon\.vc/.test(m.content || ''));
    assert.ok(reply, 'update reply');
    assert.match(reply.content, /price 0\.0015 BTC/);
    const thread = w.threads.get(THREAD);
    assert.deepStrictEqual(thread.applied_tags, [TAGS[1].id, TAGS[4].id]);
    assert.strictEqual(thread.thread_metadata.locked, true);
    assert.strictEqual(thread.thread_metadata.archived, true);

    w.messages.get(THREAD)[0].content = 'Price: 90k sats';
    await market._refreshStarter('bot-token', id);
    assert.strictEqual(market.listings.get(id).priceSats, 150000);
    assert.ok(market.listings.get(id).log.some((e) => e.type === 'post' && (e.kept || []).includes('priceSats')));
  });

  it('posts site replies through the webhook and hides removed threads', async function () {
    await boot();
    w.addThread({ id: THREAD, name: 'Arrow', owner_id: SELLER_DISCORD }, { author: { id: SELLER_DISCORD, username: 'drake_fan' }, content: '0.001 btc' });
    await market.syncForum({ archived: true });
    const id = market.threads.get(THREAD);
    const buyer = members.add({ id: 'b'.repeat(16), displayName: 'Pilot B', accounts: [] });
    const res = await route(market, 'POST', `/services/market/listings/${id}/replies`, { as: buyer, body: { body: 'I\'ll take it' } });
    assert.strictEqual(res.status, 201);
    assert.strictEqual(res.body.via, 'site');
    const posted = w.messages.get(THREAD).find((m) => m.content === 'I\'ll take it');
    assert.strictEqual(posted.author.username, 'Pilot B');
    await market.syncForum();
    const detail = await route(market, 'GET', `/services/market/listings/${id}`);
    assert.strictEqual(detail.body.replies.length, 1, 'own webhook reply not stored twice');

    market._gatewayThreadDelete({ id: THREAD });
    await settle(market);
    const catalog = await route(market, 'GET', '/services/market');
    assert.strictEqual(catalog.body.listings.length, 0);
    const removed = await route(market, 'GET', `/services/market/listings/${id}`);
    assert.strictEqual(removed.body.removed, true);
  });

  it('holds dibs for a while and lets them lapse', async function () {
    await boot();
    const seller = members.add({ id: 'a'.repeat(16), displayName: 'Seller', accounts: [] });
    const buyer = members.add({ id: 'b'.repeat(16), displayName: 'Buyer', accounts: [] });
    const other = members.add({ id: 'c'.repeat(16), displayName: 'Other', accounts: [] });
    const made = await route(market, 'POST', '/services/market/listings', { as: seller, body: { title: 'Mustang Alpha', price: '20000 sats' } });
    const dibs = await route(market, 'POST', `/services/market/listings/${made.body.id}/dibs`, { as: buyer });
    assert.strictEqual(dibs.body.status, 'dibs');
    assert.strictEqual(dibs.body.dibs.name, 'Buyer');
    assert.strictEqual((await route(market, 'POST', `/services/market/listings/${made.body.id}/dibs`, { as: other })).status, 409);
    assert.strictEqual((await route(market, 'POST', `/services/market/listings/${made.body.id}/dibs`, { as: seller })).status, 409);
    clock.now += 25 * 60 * 60 * 1000;
    await market.tick();
    assert.strictEqual(market.listings.get(made.body.id).status, 'available');
    clock.now = Date.parse('2026-10-25T12:00:00Z');
  });

  describe('escrow', function () {
    const sellerKey = new Key();
    // The buyer's escrow key is account 0's BIP87 cosigner key of a seed.
    const buyerMaster = new Key().xprv;
    const buyerKey = deriveAccount(buyerMaster, { account: 0, network: 'regtest' }).cosigner.key;

    async function openOrder () {
      const seller = members.add(fabricMember('a'.repeat(16), 'Seller', sellerKey));
      const buyer = members.add(fabricMember('b'.repeat(16), 'Buyer', buyerKey));
      const made = await route(market, 'POST', '/services/market/listings', { as: seller, body: { title: 'Cutlass Black', price: '120000 sats' } });
      const order = await route(market, 'POST', `/services/market/listings/${made.body.id}/orders`, { as: buyer, body: { refundAddress: regtestAddress() } });
      assert.strictEqual(order.status, 201, JSON.stringify(order.body));
      return { seller, buyer, listingId: made.body.id, order: order.body };
    }

    function signAs (key, view, kind) {
      const w = view.withdrawals[kind];
      const { signatures } = Federation.signWithdrawal({ psbtBase64: w.psbtBase64, privateKey: key.private });
      return signFrame(Federation.signatureMessage(view.escrow.federationId, w.requestId, signatures), key).frame;
    }

    it('runs an order from payment to release and marks the listing sold', async function () {
      await boot();
      const { seller, buyer, listingId, order } = await openOrder();
      assert.strictEqual(order.state, 'awaiting-payment');
      assert.strictEqual(order.role, 'buyer');
      assert.match(order.escrow.paymentUri, /^bitcoin:bcrt1p/);
      assert.ok(w.hubFrames.some((f) => f.type === 'FederationInvite' && f.federationId === order.escrow.federationId));
      assert.strictEqual(market.listings.get(listingId).status, 'reserved');

      const stranger = members.add({ id: 'c'.repeat(16), displayName: 'Nosy', accounts: [] });
      assert.strictEqual((await route(market, 'GET', `/services/market/orders/${order.id}`, { as: stranger })).status, 403);
      assert.strictEqual((await route(market, 'GET', `/services/market/orders/${order.id}/request?pubkey=${new Key().pubkey}`)).status, 404);

      w.vault = [fundingTx(order.escrow.address, 120000)];
      await market.tick();
      let view = market.getOrder(order.id, seller);
      assert.strictEqual(view.state, 'paid');
      assert.deepStrictEqual(view.actions.sort(), ['delivered', 'dispute', 'refund']);

      const delivered = await route(market, 'POST', `/services/market/orders/${order.id}/delivered`, { as: seller, body: { payoutAddress: regtestAddress() } });
      assert.strictEqual(delivered.body.state, 'delivered', JSON.stringify(delivered.body));
      assert.strictEqual(delivered.body.withdrawals.release.needs, 'seller');
      assert.ok(w.hubFrames.some((f) => f.type === 'FederationWithdrawalRequest'));

      const request = await route(market, 'GET', `/services/market/orders/${order.id}/request?pubkey=fabric:${sellerKey.pubkey.slice(2)}`);
      assert.strictEqual(request.body.role, 'seller');
      assert.strictEqual(request.body.withdrawals[0].kind, 'release');

      const signed = await route(market, 'POST', '/services/market/messages', { body: { frame: signAs(sellerKey, delivered.body, 'release') } });
      assert.strictEqual(signed.status, 200, JSON.stringify(signed.body));
      assert.deepStrictEqual(signed.body.signers, ['seller']);
      assert.strictEqual(w.broadcasts.length, 0);

      const sellerSigs = Federation.signWithdrawal({ psbtBase64: delivered.body.withdrawals.release.psbtBase64, privateKey: sellerKey.private }).signatures;
      const forged = signFrame(Federation.signatureMessage(delivered.body.escrow.federationId, delivered.body.withdrawals.release.requestId, sellerSigs), new Key()).frame;
      const wrongKey = await route(market, 'POST', '/services/market/messages', { body: { frame: forged } });
      assert.strictEqual(wrongKey.status, 403);

      const confirmed = await route(market, 'POST', `/services/market/orders/${order.id}/release`, { as: buyer });
      assert.strictEqual(confirmed.body.state, 'released', JSON.stringify(confirmed.body));
      assert.strictEqual(w.broadcasts.length, 1);
      assert.ok(confirmed.body.txid);
      assert.ok(w.hubFrames.some((f) => f.type === 'FederationWithdrawalBroadcast'));
      await settle(market);
      view = await route(market, 'GET', `/services/market/listings/${listingId}`);
      assert.strictEqual(view.body.status, 'sold');
      const thread = w.threads.get(market.listings.get(listingId).forum.threadId);
      assert.strictEqual(thread.thread_metadata.locked, true);
      const milestones = w.messages.get(thread.id).map((m) => m.content || '');
      assert.ok(milestones.some((t) => /^Paid:/.test(t)) && milestones.some((t) => /^Sold:/.test(t)));
      assert.ok(!milestones.join('\n').includes(order.escrow.address), 'no addresses in the thread');
    });

    it('refunds the buyer when the seller never delivers', async function () {
      await boot();
      const { listingId, order } = await openOrder();
      w.vault = [fundingTx(order.escrow.address, 150000)];
      await market.tick();
      clock.now += 8 * DAY;
      await market.tick();
      let current = market.orders.get(order.id);
      assert.strictEqual(current.state, 'refunding');
      await market.tick();
      assert.ok(w.mailboxReads.some((r) => fabricPubkey(r.pubkey) === fabricPubkey(current.arbiterPubkey) && r.origin === HUB && r.purpose === 'federation-mailbox'), 'reads its mailbox with a proof signed for this Hub');
      assert.strictEqual(current.withdrawals.refund.signers.length, 1);
      const buyer = await members.resolve('b'.repeat(16));
      const view = market.getOrder(order.id, buyer);
      assert.strictEqual(view.withdrawals.refund.amountSats, 150000 - 1000);
      const signed = await route(market, 'POST', '/services/market/messages', { body: { frame: signAs(buyerKey, view, 'refund') } });
      assert.strictEqual(signed.body.state, 'refunded', JSON.stringify(signed.body));
      current = market.orders.get(order.id);
      assert.strictEqual(w.broadcasts.length, 1);
      await settle(market);
      assert.strictEqual(market.listings.get(listingId).status, 'available');
      assert.strictEqual(market.listings.get(listingId).order, null);
      clock.now = Date.parse('2026-10-25T12:00:00Z');
    });

    it('signs a party’s part with npm run market:sign, rebuilding the payout first', async function () {
      await boot();
      const { order } = await openOrder();
      w.vault = [fundingTx(order.escrow.address, 150000)];
      await market.tick();
      clock.now += 8 * DAY;
      await market.tick();
      assert.strictEqual(market.orders.get(order.id).state, 'refunding');
      const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://localhost');
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
          Object.assign(req, { path: url.pathname, query: Object.fromEntries(url.searchParams), body: raw ? JSON.parse(raw) : {} });
          market.middleware()(req, res, () => { res.statusCode = 404; res.end(); });
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const origin = `http://127.0.0.1:${server.address().port}`;
      const run = (...args) => new Promise((resolve) => {
        execFile(process.execPath, [path.join(__dirname, '../scripts/market-sign.js'), ...args, '--origin', origin], {
          env: Object.assign({}, process.env, { FABRIC_XPRV: buyerMaster })
        }, (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }));
      });
      try {
        const pubkey = await run('pubkey');
        assert.strictEqual(pubkey.code, 0, pubkey.stderr);
        assert.strictEqual(pubkey.stdout.trim(), `${buyerKey.pubkey} (account 0, regtest)`, 'the cosigner key, network read from the Market');
        const otherAccount = await run('show', order.id, '--account', '1');
        assert.notStrictEqual(otherAccount.code, 0, 'account 1 holds no escrow key in this order');
        const shown = await run('show', order.id);
        assert.strictEqual(shown.code, 0, shown.stderr);
        assert.match(shown.stdout, /you are the buyer · refunding/);
        assert.match(shown.stdout, /Refund the buyer: 0\.00149 BTC \(149,000 sats\)/);
        const signed = await run('sign', order.id);
        assert.strictEqual(signed.code, 0, signed.stderr);
        assert.match(signed.stdout, new RegExp(`Order ${order.id}: refunded · refund signed by `));
        assert.strictEqual(market.orders.get(order.id).state, 'refunded');
        assert.strictEqual(w.broadcasts.length, 1);
        const again = await run('sign', order.id, 'refund');
        assert.notStrictEqual(again.code, 0);
      } finally {
        await new Promise((resolve) => server.close(resolve));
        clock.now = Date.parse('2026-10-25T12:00:00Z');
      }
    });

    it('expires unpaid orders and refuses escrow on the wrong network', async function () {
      await boot({ market: { network: 'testnet' } });
      const seller = members.add(fabricMember('a'.repeat(16), 'Seller', sellerKey));
      const buyer = members.add(fabricMember('b'.repeat(16), 'Buyer', buyerKey));
      const made = await route(market, 'POST', '/services/market/listings', { as: seller, body: { title: 'Aurora', price: '50000 sats' } });
      const res = await route(market, 'POST', `/services/market/listings/${made.body.id}/orders`, { as: buyer, body: { refundAddress: regtestAddress() } });
      assert.strictEqual(res.status, 503);
      assert.match(res.body.error, /testnet/);
    });

    it('needs an escrow key for the Hub’s network from both parties, never the identity key', async function () {
      await boot();
      const seller = members.add(fabricMember('a'.repeat(16), 'Seller', sellerKey));
      const made = await route(market, 'POST', '/services/market/listings', { as: seller, body: { title: 'Aurora', price: '50000 sats' } });
      const buy = (as) => route(market, 'POST', `/services/market/listings/${made.body.id}/orders`, { as, body: { refundAddress: regtestAddress() } });
      const x = buyerKey.pubkey.slice(2);
      const identityOnly = members.add({ id: 'c'.repeat(16), displayName: 'Keyless', accounts: [{ key: `fabric:${x}`, platform: 'fabric', id: x, via: 'passport' }] });
      let refused = await buy(identityOnly);
      assert.strictEqual(refused.status, 409);
      assert.match(refused.body.error, /Link your escrow key/);
      const wrongNetwork = members.add(fabricMember('d'.repeat(16), 'Testnet', buyerKey, 'testnet'));
      refused = await buy(wrongNetwork);
      assert.strictEqual(refused.status, 409);
      assert.match(refused.body.error, /Link your escrow key/);
      assert.strictEqual(market.canEscrow(identityOnly), false);
      const sellerless = members.add({ id: 'e'.repeat(16), displayName: 'Sellerless', accounts: [] });
      const theirs = await route(market, 'POST', '/services/market/listings', { as: sellerless, body: { title: 'Pisces', price: '50000 sats' } });
      const buyer = members.add(fabricMember('b'.repeat(16), 'Buyer', buyerKey));
      refused = await route(market, 'POST', `/services/market/listings/${theirs.body.id}/orders`, { as: buyer, body: { refundAddress: regtestAddress() } });
      assert.strictEqual(refused.status, 409);
      assert.match(refused.body.error, /hasn't linked an escrow key/);
      const ok = await buy(buyer);
      assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));
      const validators = ok.body.escrow.descriptor.validators;
      assert.ok(validators.includes(buyerKey.pubkey) && validators.includes(sellerKey.pubkey), JSON.stringify(validators));
      assert.ok(!validators.some((v) => v.slice(2) === buyer.accounts[0].id), 'not the identity key');
    });

    it('checks a reported payment with the Hub’s invoice check and waits for it to confirm', async function () {
      await boot();
      const { seller, buyer, order } = await openOrder();
      assert.match(order.hubPayUrl, /^https:\/\/hub\.test\/payments\?bitcoinUri=bitcoin%3Abcrt1p.+#fabric-btc-make-payment-h4$/);
      assert.strictEqual(order.invoice.address, order.escrow.address);
      assert.strictEqual(order.invoice.amountSats, 120000);

      const invoice = await route(market, 'GET', `/services/market/orders/${order.id}/invoice`, { as: seller });
      assert.strictEqual(invoice.status, 200);
      assert.strictEqual(invoice.body.bitcoinUri, order.escrow.paymentUri);
      const stranger = members.add({ id: 'c'.repeat(16), displayName: 'Nosy', accounts: [] });
      assert.strictEqual((await route(market, 'GET', `/services/market/orders/${order.id}/invoice`, { as: stranger })).status, 403);
      assert.strictEqual((await route(market, 'GET', `/services/market/orders/${order.id}/invoice`)).status, 401);

      const short = 'aa'.repeat(32);
      w.chain.set(short, { address: order.escrow.address, sats: 100000, confirmations: 0 });
      let res = await route(market, 'POST', `/services/market/orders/${order.id}/payments`, { as: buyer, body: { txid: short } });
      assert.strictEqual(res.status, 409);
      assert.match(res.body.error, /pays 100,000 sats/);
      res = await route(market, 'POST', `/services/market/orders/${order.id}/payments`, { as: buyer, body: { txid: 'bb'.repeat(32) } });
      assert.strictEqual(res.status, 409);
      assert.match(res.body.error, /doesn't see that transaction/);
      res = await route(market, 'POST', `/services/market/orders/${order.id}/payments`, { as: buyer, body: { txid: 'nope' } });
      assert.strictEqual(res.status, 400);

      const funding = fundingTx(order.escrow.address, 120000);
      w.chain.set(funding.txid, { address: order.escrow.address, sats: 120000, confirmations: 0 });
      clock.now += 23 * 60 * 60 * 1000;
      res = await route(market, 'POST', `/services/market/orders/${order.id}/payments`, { as: buyer, body: { txid: funding.txid } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.state, 'awaiting-payment');
      assert.deepStrictEqual(res.body.payments.map((p) => [p.txid, p.verified, p.inMempool]), [[funding.txid, true, true]]);
      assert.deepStrictEqual(res.body.invoice.txids, [funding.txid]);
      assert.ok(res.body.payGraceUntil);

      clock.now += 2 * 60 * 60 * 1000;
      await market.tick();
      assert.strictEqual(market.orders.get(order.id).state, 'awaiting-payment', 'a payment seen in time keeps the order open');

      w.chain.get(funding.txid).confirmations = 1;
      w.vault = [funding];
      clock.now += 5 * 60 * 1000;
      await market.tick();
      const view = market.getOrder(order.id, buyer);
      assert.strictEqual(view.state, 'paid');
      assert.strictEqual(view.funding.txid, funding.txid);
      assert.strictEqual(view.hubPayUrl, null);
      res = await route(market, 'POST', `/services/market/orders/${order.id}/payments`, { as: buyer, body: { txid: funding.txid } });
      assert.strictEqual(res.status, 409);
      clock.now = Date.parse('2026-10-25T12:00:00Z');
    });

    it('lets an unpaid order lapse and frees the listing', async function () {
      await boot();
      const { listingId, order } = await openOrder();
      clock.now += 25 * 60 * 60 * 1000;
      await market.tick();
      assert.strictEqual(market.orders.get(order.id).state, 'expired');
      assert.strictEqual(market.listings.get(listingId).status, 'available');
      assert.strictEqual(market.listings.get(listingId).order, null);
      clock.now = Date.parse('2026-10-25T12:00:00Z');
    });
  });
});
