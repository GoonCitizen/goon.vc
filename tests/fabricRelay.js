'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const net = require('net');
const path = require('path');
const EventEmitter = require('events');
const Identity = require('@fabric/core/types/identity');
const Key = require('@fabric/core/types/key');
const Message = require('@fabric/core/types/message');
const FabricRelay = require('../services/fabricRelay');
const share = require('../functions/discordFabricShare');

const GUILD = '1190527980120850493';
const OTHER_GUILD = '999999999999999999';
const VIEW = 1n << 10n;
const GROUP = 'g00n-squad';
const CONTRACT = 'c'.repeat(64);

function fakeGuild (id = GUILD) {
  return { id, name: id === GUILD ? 'G00N SQUAD' : 'Elsewhere', icon: 'abc', memberCount: 42, roles: { everyone: { id } }, channels: { cache: new Map() } };
}

function fakeChannel (guild, { id, name, type = 0, nsfw = false, everyone = true, position = 0, history = [] }) {
  const channel = {
    id,
    name,
    type,
    nsfw,
    guild,
    guildId: guild.id,
    parentId: null,
    rawPosition: position,
    permissionsFor: (role) => ({ has: (bit) => role === guild.roles.everyone && bit === VIEW && everyone }),
    messages: { fetch: async ({ limit }) => new Map(history.slice(-limit).map((m) => [m.id, m])) }
  };
  guild.channels.cache.set(id, channel);
  return channel;
}

let nextId = 1000;
function fakeMessage (channel, text, extra = {}) {
  nextId += 1;
  return Object.assign({
    id: String(nextId),
    channel,
    channelId: channel.id,
    guildId: channel.guildId,
    author: { id: '111111111111111111', username: 'ace', globalName: 'Ace', bot: false },
    member: { displayName: '[G00N] Ace' },
    content: text,
    cleanContent: text,
    attachments: new Map(),
    createdTimestamp: Date.UTC(2026, 9, 21, 5, 0, 0) + nextId * 1000,
    system: false
  }, extra);
}

class FakeDiscord extends EventEmitter {
  constructor (guilds) {
    super();
    this.client = new EventEmitter();
    this.client.guilds = { cache: new Map(guilds.map((g) => [g.id, g])) };
    this.client.application = { id: 'app-1' };
    this.botReady = false;
  }
}

class FakePeer extends EventEmitter {
  constructor (settings) {
    super();
    this.settings = settings;
    this.key = new Identity({ xprv: settings.key.xprv, network: settings.network }).fabricKey;
    this.connections = {};
    this.sent = [];
    this.dialed = [];
    FakePeer.last = this;
  }

  async start () { return this; }
  async stop () { return this; }
  connectTo (address) { this.dialed.push(address); }
  relayFrom (origin, message) { this.sent.push(message); }
  open (address = 'hub.fabric.pub:7777') {
    this.connections[address] = {};
    this.emit('connections:open', { address });
  }

  bodies () {
    return this.sent.map((message) => {
      const parsed = Message.tryParseLegacyBody(message);
      assert.strictEqual(parsed.encoding, 'fields', 'core peers drop JSON CONTRACT_MESSAGE bodies');
      return parsed.value;
    });
  }
}

function freePort () {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close((err) => (err ? reject(err) : resolve(port)));
    });
    probe.on('error', reject);
  });
}

async function until (check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out');
}

describe('Discord → Fabric chat packs', function () {
  it('relays only channels @everyone can view in the home server', function () {
    const guild = fakeGuild();
    const other = fakeGuild(OTHER_GUILD);
    assert.ok(share.isPublicChannel(fakeChannel(guild, { id: '1', name: 'general' }), GUILD));
    assert.ok(share.isPublicChannel(fakeChannel(guild, { id: '2', name: 'news', type: 5 }), GUILD));
    assert.ok(!share.isPublicChannel(fakeChannel(guild, { id: '3', name: 'officers', everyone: false }), GUILD), 'private');
    assert.ok(!share.isPublicChannel(fakeChannel(guild, { id: '4', name: 'spicy', nsfw: true }), GUILD), 'age-restricted');
    assert.ok(!share.isPublicChannel(fakeChannel(guild, { id: '5', name: 'voice', type: 2 }), GUILD), 'voice chat');
    assert.ok(!share.isPublicChannel(fakeChannel(guild, { id: '6', name: 'thread', type: 11 }), GUILD), 'thread');
    assert.ok(!share.isPublicChannel(fakeChannel(other, { id: '7', name: 'general' }), GUILD), 'another server');
    assert.ok(!share.isPublicChannel(null, GUILD));
    assert.deepStrictEqual(share.publicChannels(guild).map((c) => c.name), ['general', 'news']);
  });

  it('builds a catalog without members and message records without raw mentions', function () {
    const guild = fakeGuild();
    const general = fakeChannel(guild, { id: '1', name: 'general', position: 2 });
    const pack = share.catalogPack(guild, [general]);
    assert.strictEqual(pack.pack, 'chat.catalog');
    assert.deepStrictEqual(pack.payload.guilds[0].members, []);
    assert.deepStrictEqual(pack.payload.guilds[0].channels, [{ id: '1', name: 'general', type: 0, parentId: null, position: 2 }]);

    const message = fakeMessage(general, '<@222> o7', { cleanContent: '@Bob o7', attachments: new Map([['a', { name: 'clip.mp4' }]]) });
    const record = share.messageRecord(message);
    assert.strictEqual(record.body, '@Bob o7 [clip.mp4]');
    assert.strictEqual(record.handle, '[G00N] Ace');
    assert.strictEqual(record.channelId, '1');
    assert.strictEqual(record.guildId, GUILD);
    assert.strictEqual(record.bot, false);
    assert.strictEqual(share.messageRecord(fakeMessage(general, 'joined', { system: true })), null);
    assert.strictEqual(share.messageRecord(fakeMessage(general, '   ')), null);
    assert.strictEqual(share.messageRecord(fakeMessage(general, 'x'.repeat(900))).body.length, 500);
  });

  it('splits messages into packs GoonCitizen keeps whole', function () {
    const channels = [];
    for (let c = 0; c < 30; c++) {
      const messages = [];
      for (let m = 0; m < 25; m++) {
        messages.push({ discordMessageId: `${c}-${m}`, channelId: `ch${c}`, guildId: GUILD, authorId: '1', handle: 'A', bot: false, body: '🚀'.repeat(120), ts: new Date(Date.UTC(2026, 0, 1, 0, c, m)).toISOString() });
      }
      channels.push({ channelId: `ch${c}`, guildId: GUILD, messages });
    }
    const packs = share.messagePacks(channels);
    let total = 0;
    for (const pack of packs) {
      const list = pack.payload.channels;
      assert.ok(list.length <= 12);
      assert.strictEqual(new Set(list.map((c) => c.channelId)).size, list.length, 'a channel appears once per pack');
      for (const entry of list) assert.ok(entry.messages.length <= 20);
      assert.ok(Buffer.byteLength(JSON.stringify(pack)) <= share.MAX_PACK_BYTES + 200);
      total += list.reduce((n, c) => n + c.messages.length, 0);
    }
    assert.strictEqual(total, 30 * 25, 'nothing dropped');
  });
});

describe('FabricRelay service', function () {
  this.timeout(20000);
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-fabric-'));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps one generated key and stays off without a group', async function () {
    const first = new FabricRelay({ path: dir, guildId: GUILD, Peer: FakePeer });
    await first.start();
    const pubkey = first.pubkey;
    assert.match(pubkey, /^0[23][0-9a-f]{64}$/);
    assert.strictEqual(first.peer, null, 'no peer without a group');
    assert.strictEqual(first.status().status, 'unconfigured');
    await first.stop();

    const again = new FabricRelay({ path: dir, guildId: GUILD, Peer: FakePeer });
    await again.start();
    assert.strictEqual(again.pubkey, pubkey, 'same key after a restart');
    await again.stop();

    const xprv = new Key().xprv;
    const given = new FabricRelay({ path: dir, guildId: GUILD, xprv, group: GROUP, relay: false, Peer: FakePeer });
    await given.start();
    assert.strictEqual(given.pubkey, new Identity({ xprv, network: 'regtest' }).fabricKey.pubkey);
    assert.strictEqual(given.status().status, 'disabled');
    await given.stop();
    assert.ok(FabricRelay.enabled({ group: GROUP }));
    assert.ok(!FabricRelay.enabled({ group: GROUP, relay: false }));
    assert.ok(!FabricRelay.enabled({}));
  });

  it('relays public channel messages of the home server as group shares', async function () {
    const guild = fakeGuild();
    const other = fakeGuild(OTHER_GUILD);
    const general = fakeChannel(guild, { id: '10', name: 'general' });
    const officers = fakeChannel(guild, { id: '11', name: 'officers', everyone: false });
    const elsewhere = fakeChannel(other, { id: '12', name: 'general' });
    const earlier = fakeMessage(general, 'earlier');
    general.messages.fetch = async ({ limit }) => new Map([[earlier.id, earlier]].slice(-limit));
    const discord = new FakeDiscord([guild, other]);
    const operations = new EventEmitter();

    const relay = new FabricRelay({ path: dir, guildId: GUILD, group: GROUP, contract: CONTRACT, operations, Peer: FakePeer, flushMs: 0, shareMs: 0, reconnectMs: 0 });
    await relay.start();
    const peer = FakePeer.last;
    assert.strictEqual(peer.settings.listen, false, 'dial out only');
    assert.strictEqual(peer.settings.peersDb, null);
    operations.discord = discord;
    operations.emit('gateway', discord);
    discord.botReady = true;
    discord.emit('ready');
    await until(() => relay.recent.size);

    discord.client.emit('messageCreate', fakeMessage(general, 'o7 pilots'));
    discord.client.emit('messageCreate', fakeMessage(officers, 'secret plans'));
    discord.client.emit('messageCreate', fakeMessage(elsewhere, 'other server'));
    assert.strictEqual(relay.pending.size, 1);
    assert.strictEqual(relay._flush(), 0, 'nothing goes out while offline');

    peer.open();
    assert.strictEqual(relay._flush(), 2, 'catalog, then the new message');
    const [catalog, messages] = peer.bodies();
    for (const body of [catalog, messages]) {
      assert.strictEqual(body.contract, CONTRACT);
      assert.strictEqual(body.type, 'GroupDataShare');
      assert.strictEqual(body.actor.publicKey, relay.pubkey);
      assert.strictEqual(body.object.groupId, GROUP);
      assert.strictEqual(body.object.sourceAppId, 'app-1');
    }
    assert.deepStrictEqual(catalog.object.packs[0].payload.guilds[0].channels.map((c) => c.name), ['general']);
    const relayed = messages.object.packs[0].payload.channels;
    assert.deepStrictEqual(relayed.map((c) => c.channelId), ['10']);
    assert.deepStrictEqual(relayed[0].messages.map((m) => m.body), ['o7 pilots']);
    assert.ok(peer.sent.every((message) => message.verifyWithKey(peer.key)), 'signed by the relay key');
    const text = JSON.stringify(peer.bodies());
    assert.ok(!text.includes('secret plans') && !text.includes('other server'));
    assert.strictEqual(relay._flush(), 0, 'nothing new');

    relay._shareAll();
    const full = peer.bodies().slice(2);
    const bodies = full.filter((b) => b.object.packs[0].pack === 'chat.messages').flatMap((b) => b.object.packs[0].payload.channels[0].messages.map((m) => m.body));
    assert.deepStrictEqual(bodies, ['earlier', 'o7 pilots'], 'periodic share carries backfilled history');

    const deleted = fakeMessage(general, 'oops');
    discord.client.emit('messageCreate', deleted);
    discord.client.emit('messageDelete', deleted);
    assert.strictEqual(relay.pending.size, 0);

    const status = relay.status();
    assert.strictEqual(status.status, 'connected');
    assert.strictEqual(status.channels, 1);
    assert.ok(!JSON.stringify(status).includes('o7 pilots'), 'status carries no content');
    await relay.stop();
    assert.strictEqual(discord.client.listenerCount('messageCreate'), 0);
  });

  it('stops sharing a channel once it turns private', async function () {
    const guild = fakeGuild();
    const general = fakeChannel(guild, { id: '10', name: 'general' });
    const lounge = fakeChannel(guild, { id: '13', name: 'lounge' });
    const discord = new FakeDiscord([guild]);
    discord.botReady = true;
    const relay = new FabricRelay({ path: dir, guildId: GUILD, group: GROUP, contract: CONTRACT, operations: { discord }, Peer: FakePeer, backfill: 0, flushMs: 0, shareMs: 0, reconnectMs: 0 });
    await relay.start();
    const peer = FakePeer.last;

    discord.client.emit('messageCreate', fakeMessage(general, 'o7 pilots'));
    discord.client.emit('messageCreate', fakeMessage(lounge, 'said while public'));
    assert.strictEqual(relay.pending.size, 2, 'both queued while offline');
    lounge.permissionsFor = () => ({ has: () => false });
    discord.client.emit('channelUpdate', lounge, lounge);

    peer.open();
    relay._flush();
    relay._shareAll();
    const text = JSON.stringify(peer.bodies());
    assert.ok(text.includes('o7 pilots'));
    assert.ok(!text.includes('said while public'), 'queued message from the now-private channel is dropped');
    assert.ok(!text.includes('lounge'), 'the catalog no longer lists it');
    assert.ok(!relay.recent.has('13'), 'nor kept for re-sharing');
    await relay.stop();
  });

  it('keeps queued messages when the home guild is unavailable', async function () {
    const guild = fakeGuild();
    const general = fakeChannel(guild, { id: '10', name: 'general' });
    const discord = new FakeDiscord([guild]);
    discord.botReady = true;
    const relay = new FabricRelay({ path: dir, guildId: GUILD, group: GROUP, contract: CONTRACT, operations: { discord }, Peer: FakePeer, backfill: 0, flushMs: 0, shareMs: 0, reconnectMs: 0 });
    await relay.start();
    const peer = FakePeer.last;
    discord.client.emit('messageCreate', fakeMessage(general, 'keep me'));
    assert.strictEqual(relay.pending.size, 1);
    discord.client.guilds.cache.delete(GUILD);
    peer.open();
    assert.strictEqual(relay._flush(), 0, 'nothing goes out without the guild');
    assert.strictEqual(relay._shareAll(), 0);
    assert.strictEqual(relay.pending.size, 1, 'queued messages wait for the guild');
    discord.client.guilds.cache.set(GUILD, guild);
    assert.ok(relay._flush() > 0);
    await relay.stop();
  });

  it('delivers a signed GroupDataShare to a real Fabric peer', async function () {
    const Peer = require('@fabric/core/types/peer');
    const port = await freePort();
    const hub = new Peer({ listen: true, interface: '127.0.0.1', port, peersDb: null, peers: [], key: { xprv: new Key().xprv } });
    hub.on('error', () => {});
    hub.on('warning', () => {});
    await hub.start();
    const received = [];
    hub.on('contract:message', (event) => received.push(event));

    const guild = fakeGuild();
    const general = fakeChannel(guild, { id: '10', name: 'general' });
    const discord = new FakeDiscord([guild]);
    discord.botReady = true;
    const relay = new FabricRelay({ path: dir, guildId: GUILD, group: GROUP, peers: [`127.0.0.1:${port}`], operations: { discord }, backfill: 0, flushMs: 0, shareMs: 0, reconnectMs: 0 });
    try {
      await relay.start();
      await until(() => relay.connected);
      discord.client.emit('messageCreate', fakeMessage(general, 'hello mesh'));
      relay._flush();
      const event = await until(() => received.find((e) => e.object.object.packs[0].pack === 'chat.messages'));
      assert.strictEqual(event.contract, new (require('@fabric/core/types/actor'))(FabricRelay.GOONCITIZEN_CONTRACT).id);
      assert.strictEqual(event.contract, 'e2515747c655eece28f33f03cd353c0ea3f17c6d64219a5451743765c5353ecb', 'GoonCitizen namespace by default');
      // The wire carries the x-only key; GoonCitizen matches it against the compressed member key.
      assert.strictEqual(event.signer, relay.pubkey.slice(-64), 'GoonCitizen checks group membership against this signer');
      assert.strictEqual(event.object.object.packs[0].payload.channels[0].messages[0].body, 'hello mesh');
    } finally {
      await relay.stop();
      await hub.stop();
    }
  });
});
