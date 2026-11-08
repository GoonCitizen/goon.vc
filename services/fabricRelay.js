'use strict';

const Store = require('@fabric/core/types/store');
const Key = require('@fabric/core/types/key');
const Actor = require('@fabric/core/types/actor');
const Identity = require('@fabric/core/types/identity');
const Message = require('@fabric/core/types/message');
const startStore = require('../functions/startStore');
const share = require('../functions/discordFabricShare');

const BASE = '/services/fabric';
const IDENTITY_KEY = '/identity';
const NETWORK = 'regtest';
const DEFAULT_PEERS = ['hub.fabric.pub:7777', 'relay.goon.vc:7777'];
const INTENTS = ['MessageContent'];
const CATALOG_EVENTS = ['channelCreate', 'channelUpdate', 'channelDelete', 'roleUpdate', 'guildUpdate'];

// GoonCitizen application namespace (star-citizen-live contracts/gooncitizen.js);
// any change to this object moves the id.
const GOONCITIZEN_CONTRACT = {
  name: 'GoonCitizen',
  version: 1,
  messageTypes: ['MissionBroadcast', 'SCEventBatch'],
  proposalTypes: ['MissionEscrow', 'MissionPayout'],
  state: {}
};

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function errorMessage (error) {
  return error && error.message ? error.message : String(error);
}

function hostOf (address) {
  return String(address || '').replace(/^[^@]*@/, '').toLowerCase();
}

/**
 * Relays messages from the public channels of the home Discord server (G00N
 * SQUAD) to the Fabric network as GoonCitizen chat packs, so GoonCitizen's
 * Chat lists those channels and their messages without a bot of its own.
 *
 * Shares are `GroupDataShare` `CONTRACT_MESSAGE`s for one GoonCitizen
 * Federation group (`group`, sent under its `contract`); GoonCitizen only
 * accepts them while this relay's key (`pubkey`, logged on start and served at
 * `GET /services/fabric`) is a member of that group. The key is dedicated to
 * goon.vc: `xprv` (GOON_FABRIC_XPRV), else one generated once and kept in the
 * Store. The Peer only dials out (no listen); messages ride the existing
 * operations gateway client, which needs the Message Content intent for this.
 */
class FabricRelay {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string} [settings.xprv] Relay key; generated and stored when unset.
   * @param {string[]} [settings.peers] Fabric seeds (`host:port`).
   * @param {string} [settings.group] GoonCitizen Federation group id.
   * @param {string} [settings.contract] That group's contract id (default: the GoonCitizen namespace).
   * @param {string} [settings.guildId] Only this Discord server's public channels are relayed.
   * @param {boolean} [settings.relay] false turns relaying off.
   * @param {Object} [settings.operations] Operations service owning the gateway client.
   * @param {number} [settings.flushMs] New messages go out at most this often.
   * @param {number} [settings.shareMs] Catalog + recent messages are re-shared this often for peers that joined later.
   * @param {number} [settings.reconnectMs]
   * @param {number} [settings.backfill] Messages per channel read on ready (0 = none).
   * @param {number} [settings.maxPending] Unsent messages kept while offline.
   * @param {Function} [settings.Peer] Injected for tests; defaults to @fabric/core Peer.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/fabric',
      xprv: null,
      peers: DEFAULT_PEERS,
      group: null,
      contract: null,
      guildId: null,
      relay: true,
      operations: null,
      flushMs: 15000,
      shareMs: 30 * 60 * 1000,
      reconnectMs: 60000,
      backfill: share.MAX_MESSAGES_PER_CHANNEL,
      maxPending: 1000
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.store = null;
    this.peer = null;
    this.discord = null;
    this.pubkey = null;
    this.recent = new Map();
    this.pending = new Map();
    this.channelCount = 0;
    this.relayed = { shares: 0, messages: 0 };
    this.lastSharedAt = null;
    this._xprv = null;
    this._tip = null;
    this._catalogDirty = true;
    this._timers = [];
    this._shareTimer = null;
    this._listeners = {};
    this._onGateway = (discord) => this.attach(discord);
    this._onMessage = (message) => this._receive(message);
    this._onUpdate = (_, message) => { if (!message || !message.partial) this._receive(message); };
    this._onDelete = (message) => this._forget(message);
    this._onCatalogChange = () => { this._catalogDirty = true; };
    this._onReady = () => this._ready().catch((error) => this.emit('error', 'fabric relay', errorMessage(error)));
  }

  /**
   * Whether these settings relay (and so need {@link FabricRelay.INTENTS} on the gateway).
   * @param {Object} [settings]
   * @returns {boolean}
   */
  static enabled (settings = {}) {
    return settings.relay !== false && !!settings.group;
  }

  on (event, handler) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(handler);
    return this;
  }

  emit (event, ...args) {
    for (const handler of this._listeners[event] || []) {
      try { handler(...args); } catch (_) { /* listener errors stay local */ }
    }
    return this;
  }

  get enabled () {
    return FabricRelay.enabled(this.settings) && !!this.settings.guildId;
  }

  get contract () {
    return this.settings.contract || new Actor(GOONCITIZEN_CONTRACT).id;
  }

  get connected () {
    return !!(this.peer && Object.keys(this.peer.connections || {}).length);
  }

  /** goon.vc's key (set once started); other services derive their keys from it. */
  get xprv () {
    return this._xprv;
  }

  /** goon.vc's Fabric identity key (the relay key), once started; Passport peer sign-ins name it. */
  get fabricKey () {
    if (!this._xprv) return null;
    if (!this._fabricKey) this._fabricKey = new Identity({ xprv: this._xprv, network: NETWORK }).fabricKey;
    return this._fabricKey;
  }

  /**
   * Put an already-signed frame on the Fabric network, if a peer is connected.
   * @param {string} frame Message bytes as hex
   * @returns {boolean} whether it was sent
   */
  publish (frame) {
    if (!this.connected) return false;
    this.peer.relayFrom(null, Message.fromBuffer(Buffer.from(String(frame), 'hex')));
    return true;
  }

  async start () {
    this.store = new Store({
      name: 'GOON.VC:fabric',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await startStore(this.store);
    this._xprv = this.settings.xprv || await this._storedKey();
    this.pubkey = new Identity({ xprv: this._xprv, network: NETWORK }).fabricKey.pubkey;
    if (!this.enabled) {
      const why = this.settings.relay === false ? 'off' : 'no Fabric group configured';
      this.emit('log', 'GOON.VC', `Fabric relay ${why}; relay key ${this.pubkey}`);
      return this;
    }

    const Peer = this.settings.Peer || require('@fabric/core/types/peer');
    this.peer = new Peer({
      listen: false,
      peers: [].concat(this.settings.peers || []),
      peersDb: null,
      reconnectToKnownPeers: false,
      upnp: false,
      network: NETWORK,
      key: { xprv: this._xprv }
    });
    this.peer.on('error', (error) => this.emit('error', 'fabric relay peer', errorMessage(error)));
    this.peer.on('warning', () => {});
    this.peer.on('connections:open', () => this._scheduleShare());
    await this.peer.start();
    this.emit('log', 'GOON.VC', `Fabric relay key ${this.pubkey} → group ${this.settings.group} via ${[].concat(this.settings.peers).join(', ')}`);

    this._every(this.settings.flushMs, () => this._flush());
    this._every(this.settings.shareMs, () => this._shareAll());
    this._every(this.settings.reconnectMs, () => this._reconnect());

    const operations = this.settings.operations;
    if (operations && operations.discord) this.attach(operations.discord);
    else if (operations && typeof operations.on === 'function') operations.on('gateway', this._onGateway);
    return this;
  }

  async stop () {
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];
    if (this._shareTimer) clearTimeout(this._shareTimer);
    this._shareTimer = null;
    this._detach();
    if (this.peer) {
      try { await this.peer.stop(); } catch (_) { /* already down */ }
    }
    if (this.store) await this.store.stop();
    return this;
  }

  async _storedKey () {
    const saved = await this.store.get(IDENTITY_KEY).catch(() => null);
    if (saved && saved.xprv) return saved.xprv;
    const xprv = new Key().xprv;
    await this.store.set(IDENTITY_KEY, { xprv, createdAt: new Date().toISOString() });
    return xprv;
  }

  _every (ms, task) {
    if (!(Number(ms) > 0)) return;
    const timer = setInterval(() => {
      try { task(); } catch (error) { this.emit('error', 'fabric relay', errorMessage(error)); }
    }, ms);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.push(timer);
  }

  /**
   * Listen on the shared gateway client (one connection for all of goon.vc).
   * @param {Object} discord `@fabric/discord` service
   */
  attach (discord) {
    if (!discord || !discord.client || this.discord === discord) return;
    this._detach();
    this.discord = discord;
    const client = discord.client;
    client.on('messageCreate', this._onMessage);
    client.on('messageUpdate', this._onUpdate);
    client.on('messageDelete', this._onDelete);
    for (const event of CATALOG_EVENTS) client.on(event, this._onCatalogChange);
    if (discord.botReady) this._onReady();
    else if (typeof discord.once === 'function') discord.once('ready', this._onReady);
  }

  _detach () {
    if (!this.discord) return;
    const client = this.discord.client;
    if (client && typeof client.removeListener === 'function') {
      client.removeListener('messageCreate', this._onMessage);
      client.removeListener('messageUpdate', this._onUpdate);
      client.removeListener('messageDelete', this._onDelete);
      for (const event of CATALOG_EVENTS) client.removeListener(event, this._onCatalogChange);
    }
    if (typeof this.discord.removeListener === 'function') this.discord.removeListener('ready', this._onReady);
    this.discord = null;
  }

  _guild () {
    const client = this.discord && this.discord.client;
    return (client && client.guilds && client.guilds.cache && client.guilds.cache.get(String(this.settings.guildId))) || null;
  }

  async _ready () {
    const guild = this._guild();
    const limit = Math.min(Number(this.settings.backfill) || 0, share.MAX_MESSAGES_PER_CHANNEL);
    if (guild && limit > 0) {
      for (const channel of share.publicChannels(guild)) {
        if (!channel.messages || typeof channel.messages.fetch !== 'function') continue;
        // No Read Message History in a channel just means nothing to backfill there.
        const batch = await channel.messages.fetch({ limit }).catch(() => null);
        if (!batch || typeof batch.values !== 'function') continue;
        for (const message of batch.values()) {
          const record = share.messageRecord(message);
          if (record) this._remember(record);
        }
      }
    }
    this._catalogDirty = true;
    this._scheduleShare(0);
  }

  _receive (message) {
    if (!message || !share.isPublicChannel(message.channel, this.settings.guildId)) return;
    const record = share.messageRecord(message);
    if (!record) return;
    this._remember(record);
    this.pending.delete(record.discordMessageId);
    this.pending.set(record.discordMessageId, record);
    while (this.pending.size > this.settings.maxPending) this.pending.delete(this.pending.keys().next().value);
  }

  _remember (record) {
    if (!this.recent.has(record.channelId)) this.recent.set(record.channelId, new Map());
    const channel = this.recent.get(record.channelId);
    channel.set(record.discordMessageId, record);
    if (channel.size <= share.MAX_MESSAGES_PER_CHANNEL) return;
    const oldest = Array.from(channel.values()).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
    for (const row of oldest.slice(0, channel.size - share.MAX_MESSAGES_PER_CHANNEL)) channel.delete(row.discordMessageId);
  }

  // Peers that already have a deleted message keep it; this only stops re-sharing it.
  _forget (message) {
    if (!message || !message.id) return;
    const id = String(message.id);
    this.pending.delete(id);
    const channel = this.recent.get(String(message.channelId));
    if (channel) channel.delete(id);
  }

  _scheduleShare (delayMs = 2000) {
    if (this._shareTimer) clearTimeout(this._shareTimer);
    this._shareTimer = setTimeout(() => {
      this._shareTimer = null;
      try { this._shareAll(); } catch (error) { this.emit('error', 'fabric relay', errorMessage(error)); }
    }, delayMs);
    if (typeof this._shareTimer.unref === 'function') this._shareTimer.unref();
  }

  _reconnect () {
    if (!this.peer) return;
    const open = Object.keys(this.peer.connections || {}).map(hostOf);
    for (const address of [].concat(this.settings.peers || [])) {
      if (!open.includes(hostOf(address))) this.peer.connectTo(address);
    }
  }

  _byChannel (records) {
    const channels = new Map();
    for (const record of records) {
      if (!channels.has(record.channelId)) channels.set(record.channelId, { channelId: record.channelId, guildId: record.guildId, messages: [] });
      channels.get(record.channelId).messages.push(record);
    }
    return Array.from(channels.values());
  }

  // A channel can turn private (or be deleted) after its messages were queued or kept for re-sharing.
  _publicOnly (records) {
    const guild = this._guild();
    const open = new Set(guild ? share.publicChannels(guild).map((channel) => String(channel.id)) : []);
    for (const channelId of Array.from(this.recent.keys())) {
      if (!open.has(String(channelId))) this.recent.delete(channelId);
    }
    return Array.from(records).filter((record) => open.has(String(record.channelId)));
  }

  /**
   * Send what arrived since the last flush (and the catalog, if it changed).
   * Kept for later while no Fabric peer is connected.
   * @returns {number} shares sent
   */
  _flush () {
    if (!this.connected) return 0;
    let sent = this._catalogDirty ? this._sendCatalog() : 0;
    if (!this.pending.size) return sent;
    for (const pack of share.messagePacks(this._byChannel(this._publicOnly(this.pending.values())))) sent += this._publish([pack]);
    this.pending.clear();
    return sent;
  }

  /**
   * Catalog plus the newest messages of every public channel, for peers that
   * connected after those messages were first sent.
   * @returns {number} shares sent
   */
  _shareAll () {
    if (!this.connected) return 0;
    let sent = this._sendCatalog();
    const records = new Map();
    for (const channel of this.recent.values()) for (const record of channel.values()) records.set(record.discordMessageId, record);
    for (const record of this.pending.values()) records.set(record.discordMessageId, record);
    for (const pack of share.messagePacks(this._byChannel(this._publicOnly(records.values())))) sent += this._publish([pack]);
    this.pending.clear();
    return sent;
  }

  _sendCatalog () {
    const guild = this._guild();
    if (!guild) return 0;
    const channels = share.publicChannels(guild);
    this.channelCount = channels.length;
    this._catalogDirty = false;
    return this._publish([share.catalogPack(guild, channels)]);
  }

  _publish (packs) {
    const client = this.discord && this.discord.client;
    const body = share.shareBody({
      contract: this.contract,
      groupId: this.settings.group,
      pubkey: this.pubkey,
      packs,
      sourceAppId: (client && client.application && client.application.id) || (client && client.user && client.user.id) || null
    });
    const message = Message.fromLegacyBody('CONTRACT_MESSAGE', body);
    Message.setMessageParent(message, this._tip || Message.ZERO_PARENT);
    message.signWithKey(this.peer.key);
    this._tip = message.id;
    this.peer.relayFrom(null, message);
    this.relayed.shares += 1;
    for (const pack of packs) {
      if (pack.pack !== share.PACK_MESSAGES) continue;
      for (const channel of pack.payload.channels) this.relayed.messages += channel.messages.length;
    }
    this.lastSharedAt = new Date().toISOString();
    return 1;
  }

  /**
   * Public status: relay key, group, seeds, counts — never message content.
   * @returns {Object}
   */
  status () {
    const open = this.peer ? Object.keys(this.peer.connections || {}).map(hostOf) : [];
    let status = this.connected ? 'connected' : 'connecting';
    if (!this.enabled) status = this.settings.relay === false ? 'disabled' : 'unconfigured';
    return {
      status,
      pubkey: this.pubkey,
      group: this.settings.group || null,
      contract: this.enabled ? this.contract : null,
      guildId: this.settings.guildId || null,
      peers: [].concat(this.settings.peers || []).map((address) => ({ address, connected: open.includes(hostOf(address)) })),
      channels: this.channelCount,
      pending: this.pending.size,
      relayed: Object.assign({}, this.relayed),
      lastSharedAt: this.lastSharedAt
    };
  }

  /**
   * Express middleware for `GET /services/fabric`.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const pathname = String(req.path || '').replace(/\/+$/, '');
      if (pathname !== BASE) return next();
      if (String(req.method || 'GET').toUpperCase() !== 'GET') return sendJson(res, 405, { error: 'Method not allowed' });
      sendJson(res, 200, this.status());
    };
  }
}

module.exports = FabricRelay;
module.exports.INTENTS = INTENTS;
module.exports.GOONCITIZEN_CONTRACT = GOONCITIZEN_CONTRACT;
