'use strict';

/**
 * Bounty board. A bounty is a public listing until someone claims it. The
 * claim is a Market 2-of-3 escrow ({@link module:functions/bountyEscrow}):
 * the poster funds the vault, and confirming the work releases it to the
 * claimant. Public JSON carries display names and the bounty itself, never
 * Discord ids, member ids, or pubkeys.
 */

const crypto = require('crypto');
const EventEmitter = require('events');
const Store = require('@fabric/core/types/store');
const Federation = require('@fabric/core/types/federation');
const { createMailboxFetch } = require('@fabric/core/types/delegation');
const startStore = require('../functions/startStore');
const { isMailboxSafeOrigin, isUnreachable } = require('../functions/hubApiProxy');
const { fabricPubkey } = require('../functions/accountKey');
const { frameHex, frameUri, openFrame, signFrame } = require('../functions/fabricFederation');
const post = require('../functions/marketPost');
const marketEscrow = require('../functions/marketEscrow');
const bountyEscrow = require('../functions/bountyEscrow');

const BASE = '/services/bounties';
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const ACTIVE = new Set(['open', 'claimed', 'funded', 'finished', 'disputed']);

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function randomId () {
  return crypto.randomBytes(6).toString('hex');
}

class Bounties extends EventEmitter {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path]
   * @param {string} [settings.basePath] Site path (`/bounties`).
   * @param {string} [settings.siteUrl]
   * @param {string} [settings.network] Refuse a Hub on any other network.
   * @param {boolean} [settings.allowMainnet]
   * @param {string[]} [settings.arbiters] Account keys that may rule on a dispute.
   * @param {Object} [settings.hubs] Hub list (`order()`, `answered()`).
   * @param {string|Function} [settings.xprv]
   * @param {Object} [settings.members]
   * @param {Function} [settings.fetch]
   * @param {Function} [settings.now]
   */
  constructor (settings = {}) {
    super();
    this.settings = Object.assign({
      path: './stores/bounties',
      basePath: '/bounties',
      siteUrl: 'https://goon.vc',
      network: null,
      allowMainnet: false,
      payHours: marketEscrow.DEFAULTS.payHours,
      payGraceHours: marketEscrow.DEFAULTS.payGraceHours,
      deliveryDays: marketEscrow.DEFAULTS.deliveryDays,
      confirmDays: marketEscrow.DEFAULTS.confirmDays,
      feeSats: marketEscrow.DEFAULTS.feeSats,
      arbiters: [],
      tickMs: MINUTE,
      vaultEveryMs: 2 * MINUTE,
      inviteEveryMs: DAY,
      hubs: null,
      xprv: null,
      members: null,
      fetch: null,
      now: () => Date.now()
    }, settings);
    this.bounties = new Map();
    this.store = null;
    this._hubInfo = null;
    this._queue = Promise.resolve();
    this._timers = [];
    this.base = String(this.settings.basePath || '/bounties').replace(/\/+$/, '');
  }

  _now () {
    return this.settings.now();
  }

  _iso (ms = this._now()) {
    return new Date(ms).toISOString();
  }

  _xprv () {
    const value = this.settings.xprv;
    return typeof value === 'function' ? value() : value;
  }

  _escrowSettings () {
    const s = this.settings;
    return { payHours: s.payHours, payGraceHours: s.payGraceHours, deliveryDays: s.deliveryDays, confirmDays: s.confirmDays, feeSats: s.feeSats };
  }

  _exclusive (fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.catch(() => {});
    return run;
  }

  _name (member) {
    return (member && member.displayName) || 'A member';
  }

  async _save (bounty) {
    this.bounties.set(bounty.id, bounty);
    await this.store.set(`/bounties/${bounty.id}`, bounty);
    if (bounty.order && bounty.order.escrow) {
      await this.store.set(`/federations/${bounty.order.escrow.federationId}`, { bounty: bounty.id });
    }
    await this.store.set('/index/bounties', [...this.bounties.keys()]);
    return bounty;
  }

  async start () {
    this.store = new Store({ name: 'GOON.VC:bounties', path: this.settings.path, persistent: true, verbosity: 1 });
    await startStore(this.store);
    for (const id of (await this.store.get('/index/bounties')) || []) {
      const bounty = await this.store.get(`/bounties/${id}`);
      if (bounty) this.bounties.set(id, bounty);
    }
    const timer = setInterval(() => {
      this.tick().catch((error) => this.emit('error', 'BOUNTIES', error.message));
    }, this.settings.tickMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.push(timer);
    this.emit('log', 'BOUNTIES', `${this.bounties.size} bounties`);
    return this;
  }

  async stop () {
    for (const timer of this._timers) clearInterval(timer);
    this._timers = [];
    if (this.store) await this.store.stop();
    return this;
  }

  async _hub (method, apiPath, body, extraHeaders = {}) {
    const hubs = this.settings.hubs;
    if (!hubs || typeof hubs.order !== 'function' || !hubs.order().length) throw fail(503, 'No Hub is configured for escrow.');
    let lastError = null;
    const fetch = this.settings.fetch || globalThis.fetch;
    for (const origin of hubs.order()) {
      let res;
      try {
        const extra = typeof extraHeaders === 'function' ? extraHeaders(origin) : extraHeaders;
        if (extra === false) continue;
        res = await fetch(origin + apiPath, {
          method,
          headers: Object.assign({ Accept: 'application/json' }, body !== undefined ? { 'Content-Type': 'application/json' } : {}, extra),
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(20000)
        });
      } catch (error) {
        if (isUnreachable(error)) {
          lastError = error;
          continue;
        }
        throw fail(502, `The Hub did not answer: ${error.message}`);
      }
      if (typeof hubs.answered === 'function') hubs.answered(origin);
      let json = null;
      try { json = JSON.parse(await res.text()); } catch (_) { json = null; }
      return { status: res.status, json };
    }
    throw fail(503, `No Hub could be reached${lastError ? ` (${lastError.message})` : ''}.`);
  }

  async _network () {
    if (this._hubInfo && this._hubInfo.at + 10 * MINUTE > this._now()) return this._hubInfo.network;
    const res = await this._hub('GET', '/services/federations');
    if (res.status !== 200 || !res.json || !res.json.network) throw fail(503, 'The Hub has no federations service for escrow.');
    const network = String(res.json.network).toLowerCase();
    const wanted = this.settings.network ? String(this.settings.network).toLowerCase() : null;
    if (wanted && wanted !== network) throw fail(503, `Escrow runs on ${wanted}, but the Hub is on ${network}.`);
    if (network === 'mainnet' && !this.settings.allowMainnet) throw fail(503, 'Escrow on mainnet is not turned on yet.');
    this._hubInfo = { network, at: this._now() };
    return network;
  }

  async _postFrame (hex) {
    const res = await this._hub('POST', '/services/federations/messages', { fabric: frameUri(hex) });
    if (res.status !== 200) throw fail(502, `The Hub refused a frame: ${(res.json && res.json.message) || res.status}`);
    return res.json;
  }

  _requireMember (member) {
    if (!member) throw fail(401, 'Sign in first.');
    return member;
  }

  _get (id) {
    const bounty = this.bounties.get(String(id || '').toLowerCase());
    if (!bounty || bounty.status === 'cancelled') throw fail(404, 'No such bounty.');
    return bounty;
  }

  /**
   * What the public, or a party, may see.
   * @param {Object} bounty
   * @param {Object|null} [member]
   * @returns {Object}
   */
  view (bounty, member) {
    const role = bountyEscrow.roleOf(bounty, member, this.settings.arbiters);
    const order = bounty.order;
    const view = {
      id: bounty.id,
      path: `${this.base}/${bounty.id}`,
      title: bounty.title,
      details: bounty.details || '',
      rewardSats: bounty.rewardSats,
      reward: post.formatPrice(bounty.rewardSats),
      status: bounty.status,
      posterName: bounty.posterName,
      claimantName: bounty.claimantName,
      createdAt: bounty.createdAt,
      updatedAt: bounty.updatedAt,
      you: role,
      ready: !!bounty.refundAddress
    };
    if (role === 'poster' && bounty.status === 'open' && !bounty.refundAddress) view.needsRefund = true;
    if (order && role && bounty.status === 'claimed') {
      const invoice = marketEscrow.invoice(order);
      invoice.memo = `G00N SQUAD bounty ${bounty.id}`;
      invoice.label = bounty.title;
      invoice.bitcoinUri = invoice.bitcoinUri.replace(/label=[^&]*/, `label=${encodeURIComponent(`G00N SQUAD bounty ${bounty.id}`)}`);
      view.invoice = invoice;
      view.payBy = order.payBy;
      view.payUrl = this._hubPayUrl(invoice.bitcoinUri);
    }
    if (role && order && ['funded', 'finished', 'disputed'].includes(bounty.status)) {
      view.finishBy = order.deliverBy || null;
      view.confirmBy = order.confirmBy || null;
    }
    if (role && order) {
      const payouts = Object.values(order.withdrawals || {}).filter(Boolean).map((withdrawal) => ({
        kind: withdrawal.kind,
        amountSats: withdrawal.amountSats,
        destinationAddress: withdrawal.destinationAddress,
        active: order.active === withdrawal.kind,
        signers: (withdrawal.signers || []).length
      }));
      if (payouts.length) view.payouts = payouts;
    }
    return view;
  }

  /** Hub's Payments page with this bounty's BIP21 link filled in. */
  _hubPayUrl (bitcoinUri) {
    const hubs = this.settings.hubs;
    const origin = hubs && typeof hubs.order === 'function' ? hubs.order()[0] : null;
    if (!origin || !bitcoinUri) return null;
    return `${origin}/payments?${new URLSearchParams({ bitcoinUri })}#fabric-btc-make-payment-h4`;
  }

  list ({ status = null, q = '', sort = null, mine = null } = {}) {
    const query = String(q || '').trim().toLowerCase();
    return [...this.bounties.values()]
      .filter((bounty) => bounty.status !== 'cancelled')
      .filter((bounty) => {
        if (status === 'all') return true;
        if (status) return bounty.status === status;
        return ACTIVE.has(bounty.status);
      })
      .filter((bounty) => !query || `${bounty.title} ${bounty.details} ${bounty.posterName || ''} ${bounty.claimantName || ''}`.toLowerCase().includes(query))
      .filter((bounty) => !mine || bounty.poster === mine.id || bounty.claimant === mine.id)
      .sort((a, b) => sort === 'reward' ? b.rewardSats - a.rewardSats : String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map((bounty) => this.view(bounty, mine));
  }

  async create (input, member) {
    this._requireMember(member);
    const parsed = post.parsePrice(input && (input.reward || input.price));
    if (!parsed || !(parsed.sats > 0)) throw fail(400, 'Reward must be in BTC (0.005 BTC), sats (500k sats), or a number of sats.');
    const network = await this._network();
    const posterPubkey = marketEscrow.memberEscrowKey(member, network);
    if (!posterPubkey) throw fail(409, `Link your escrow key first, on ${network}, then post the bounty.`);
    const refundAddress = input && input.refundAddress ? marketEscrow.checkAddress(input.refundAddress, network) : null;
    const bounty = await this._exclusive(async () => {
      let id;
      do id = randomId(); while (this.bounties.has(id));
      const record = bountyEscrow.create({
        id,
        title: input.title,
        details: input.details,
        rewardSats: parsed.sats,
        poster: member.id,
        posterName: this._name(member),
        posterPubkey,
        refundAddress
      }, { now: this._now() });
      await this._save(record);
      return record;
    });
    return this.view(bounty, member);
  }

  async setRefund (id, input, member) {
    this._requireMember(member);
    const network = await this._network();
    const refundAddress = marketEscrow.checkAddress(input && input.refundAddress, network);
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      if (current.poster !== member.id) throw fail(403, 'Only the poster can set the refund address.');
      if (current.status !== 'open') throw fail(409, 'The refund address is already part of the escrow.');
      current.refundAddress = refundAddress;
      current.updatedAt = new Date(this._now()).toISOString();
      await this._save(current);
      return current;
    });
    return this.view(bounty, member);
  }

  async claim (id, input, member) {
    this._requireMember(member);
    const network = await this._network();
    const claimantPubkey = marketEscrow.memberEscrowKey(member, network);
    if (!claimantPubkey) throw fail(409, `Link your escrow key first, on ${network}, then claim the bounty.`);
    const payoutAddress = marketEscrow.checkAddress(input && input.payoutAddress, network);
    if (!this._xprv()) throw fail(503, 'goon.vc has no Fabric key to arbitrate with.');
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      const next = bountyEscrow.claim(current, {
        claimant: member.id,
        claimantName: this._name(member),
        claimantPubkey,
        payoutAddress,
        network
      }, bountyEscrow.arbiterKey(this._xprv(), current.id), { now: this._now(), settings: this._escrowSettings() });
      await this._save(next);
      return next;
    });
    await this._postInvite(bounty).catch((error) => this.emit('error', 'BOUNTIES', error.message));
    return this.view(this.bounties.get(bounty.id), member);
  }

  async drop (id, member) {
    this._requireMember(member);
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      if (current.claimant !== member.id) throw fail(403, 'Only the claimant can drop a claim.');
      const next = bountyEscrow.drop(current, { now: this._now(), name: this._name(member) });
      await this._save(next);
      return next;
    });
    return this.view(bounty, member);
  }

  async _act (id, action, member, by, input) {
    const bounty = await this._exclusive(async () => {
      const current = this._get(id);
      const role = bountyEscrow.roleOf(current, member, this.settings.arbiters);
      if (by !== 'system' && role !== by && !(by === 'arbiter' && role === 'arbiter')) {
        if (role !== by) throw fail(403, 'You can’t do that to this bounty.');
      }
      const { bounty: next, effects } = bountyEscrow.act(current, action, {
        by,
        now: this._now(),
        settings: this._escrowSettings(),
        input,
        name: member ? this._name(member) : null
      });
      await this._effects(next, effects);
      await this._save(next);
      return next;
    });
    return this.view(this.bounties.get(bounty.id) || bounty, member);
  }

  async _effects (bounty, effects) {
    const order = bounty.order;
    if (!order) return;
    const fee = marketEscrow.settingsOf(this._escrowSettings()).feeSats;
    if (effects.withdraw && !order.withdrawals[effects.withdraw]) {
      const withdrawal = marketEscrow.buildWithdrawal(order, effects.withdraw, fee);
      order.withdrawals[effects.withdraw] = withdrawal;
      const arbiter = bountyEscrow.arbiterKey(this._xprv(), bounty.id);
      await this._postFrame(signFrame(marketEscrow.withdrawalBody(order, withdrawal), arbiter.key).frame).catch(() => {});
    }
    if (effects.arbiterSign && order.active) {
      const withdrawal = order.withdrawals[order.active];
      const arbiter = bountyEscrow.arbiterKey(this._xprv(), bounty.id);
      if (withdrawal && !(withdrawal.signers || []).includes(fabricPubkey(arbiter.pubkey))) {
        const signatures = marketEscrow.arbiterSignatures(withdrawal, arbiter);
        order.withdrawals[order.active] = marketEscrow.addSignatures(order, withdrawal, signatures);
        await this._postFrame(signFrame(Federation.signatureMessage(order.escrow.federationId, withdrawal.requestId, signatures), arbiter.key).frame).catch(() => {});
      }
    }
    await this._settle(bounty);
  }

  async _settle (bounty) {
    const order = bounty.order;
    if (!order || order.txid) return;
    for (const kind of [order.active, 'release', 'refund']) {
      const withdrawal = kind && order.withdrawals[kind];
      if (!withdrawal) continue;
      const done = marketEscrow.finalize(order, withdrawal);
      if (!done) continue;
      const res = await this._hub('POST', `/services/federations/${order.escrow.federationId}/transactions`, { txHex: done.txHex });
      if (res.status !== 200) return;
      const { bounty: next } = bountyEscrow.act(bounty, 'settle', { by: 'system', now: this._now(), input: { txid: (res.json && res.json.txid) || done.txid } });
      Object.assign(bounty, next);
      return;
    }
  }

  async _postInvite (bounty) {
    const order = bounty.order;
    if (!order) return;
    const arbiter = bountyEscrow.arbiterKey(this._xprv(), bounty.id);
    const invite = marketEscrow.inviteFrame(order, arbiter);
    await this._postFrame(invite.frame);
    order.invitePostedAt = this._iso();
  }

  finish (id, member) {
    return this._act(id, 'finish', member, 'claimant');
  }

  confirm (id, member) {
    return this._act(id, 'confirm', member, 'poster');
  }

  dispute (id, input, member) {
    const role = bountyEscrow.roleOf(this._get(id), member, this.settings.arbiters);
    if (role !== 'poster' && role !== 'claimant') throw fail(403, 'Only the poster or the claimant can dispute a bounty.');
    return this._act(id, 'dispute', member, role, { reason: input && input.reason });
  }

  async rule (id, input, member) {
    const role = bountyEscrow.roleOf(this._get(id), member, this.settings.arbiters);
    if (role !== 'arbiter') throw fail(403, 'Only a bounty arbiter can rule on a dispute.');
    const decision = input && input.decision;
    if (decision !== 'release' && decision !== 'refund') throw fail(400, 'A ruling pays the claimant or refunds the poster.');
    return this._act(id, decision, member, 'arbiter');
  }

  async reportPayment (id, input, member) {
    this._requireMember(member);
    const bounty = this._get(id);
    if (bounty.poster !== member.id && bounty.claimant !== member.id) throw fail(403, 'Only the poster or the claimant can report a payment.');
    const txid = String(input && input.txid || '').trim().toLowerCase();
    const order = bounty.order;
    if (!order) throw fail(409, 'This bounty is not waiting for a payment.');
    const query = new URLSearchParams({ address: order.escrow.address, amountSats: String(order.priceSats) });
    const res = await this._hub('GET', `/services/bitcoin/transactions/${encodeURIComponent(txid)}?${query}`);
    if (res.status !== 200 || !res.json) throw fail(409, 'That transaction does not pay this bounty.');
    await this._exclusive(async () => {
      const current = this._get(id);
      current.order = marketEscrow.notePayment(current.order, txid, res.json, { now: this._now(), settings: this._escrowSettings(), by: this._name(member) });
      await this._save(current);
    });
    await this._checkVault(id).catch(() => {});
    return this.view(this.bounties.get(bounty.id), member);
  }

  async tick () {
    if (!this._xprv() || !this.settings.hubs) return;
    const now = this._now();
    for (const bounty of this.bounties.values()) {
      try {
        await this._tickOne(bounty.id, now);
      } catch (error) {
        this.emit('error', 'BOUNTIES', `${bounty.id}: ${error.message}`);
      }
    }
  }

  async _tickOne (id, now) {
    const bounty = this.bounties.get(id);
    const order = bounty && bounty.order;
    if (!order || !marketEscrow.OPEN_STATES.includes(order.state)) return;
    if (!order.invitePostedAt || Date.parse(order.invitePostedAt) + this.settings.inviteEveryMs <= now) {
      await this._postInvite(bounty).catch(() => {});
      await this._save(bounty);
    }
    if (order.state === 'awaiting-payment' && (!order.vaultCheckedAt || order.vaultCheckedAt + this.settings.vaultEveryMs <= now)) {
      await this._checkVault(id);
    }
    const action = bountyEscrow.due(this.bounties.get(id), now);
    if (action) await this._act(id, action, null, 'system');
  }

  async _checkVault (id) {
    const bounty = this.bounties.get(id);
    const order = bounty && bounty.order;
    if (!order) return;
    let res = await this._hub('GET', `/services/federations/${order.escrow.federationId}/vault`);
    if (res.status === 404) {
      await this._postInvite(bounty).catch(() => {});
      res = await this._hub('GET', `/services/federations/${order.escrow.federationId}/vault`);
    }
    const coins = res.status === 200 && res.json && Array.isArray(res.json.utxos) ? res.json.utxos : [];
    const coin = coins.filter((utxo) => Number(utxo.amountSats) >= order.priceSats && utxo.txHex).sort((a, b) => a.amountSats - b.amountSats)[0];
    await this._exclusive(async () => {
      const current = this.bounties.get(id);
      if (!current.order) return;
      current.order.vaultCheckedAt = this._now();
      if (coin && current.order.state === 'awaiting-payment') {
        const funding = { txid: coin.txid, vout: coin.vout, amountSats: Number(coin.amountSats), height: coin.height ?? null, txHex: coin.txHex };
        const { bounty: next, effects } = bountyEscrow.act(current, 'fund', { by: 'system', now: this._now(), settings: this._escrowSettings(), input: { funding } });
        Object.assign(current, next);
        await this._effects(current, effects);
      }
      await this._save(current);
    });
  }

  /**
   * A party's `FederationWithdrawalSignature`.
   * @param {string} frame
   * @returns {Promise<Object>}
   */
  async ingest (frame) {
    let opened;
    let hex;
    try {
      hex = frameHex(frame);
      opened = openFrame(hex);
    } catch (error) {
      throw fail(400, error.message);
    }
    const body = opened.body;
    if (body.type !== Federation.MESSAGE_TYPES.signature) throw fail(400, 'Only a withdrawal signature is taken here.');
    const ref = await this.store.get(`/federations/${String(body.federationId || '').toLowerCase()}`);
    const bounty = ref && this.bounties.get(ref.bounty);
    if (!bounty || !bounty.order) throw fail(404, 'No bounty uses that federation.');
    return this._exclusive(async () => {
      const order = bounty.order;
      let signer;
      try {
        signer = Federation.verifySender(order.escrow.descriptor, body, opened.signer);
      } catch (error) {
        throw fail(403, error.message);
      }
      const withdrawal = Object.values(order.withdrawals || {}).find((item) => item.requestId === String(body.requestId));
      if (!withdrawal) throw fail(404, 'That withdrawal is not part of this bounty.');
      const signatures = (Array.isArray(body.signatures) ? body.signatures : []).filter((signature) => fabricPubkey(signature && signature.pubkey) === signer);
      if (!signatures.length) throw fail(400, 'The frame carries no signature by its signer.');
      order.withdrawals[withdrawal.kind] = marketEscrow.addSignatures(order, withdrawal, signatures);
      await this._settle(bounty);
      await this._save(bounty);
      return { id: bounty.id, status: bounty.status };
    });
  }

  async page (pathname) {
    const clean = String(pathname || '').replace(/\/+$/, '');
    if (clean === this.base || clean.indexOf(`${this.base}/`) !== 0) return null;
    const id = clean.slice(this.base.length + 1);
    if (!id || id.includes('/')) return null;
    const bounty = this.bounties.get(id.toLowerCase());
    if (!bounty || bounty.status === 'cancelled') return null;
    return {
      path: clean,
      title: `${bounty.title} · Bounties`,
      description: `${post.formatBtc(bounty.rewardSats)} posted by ${bounty.posterName || 'a member'}. ${bounty.status}.`
    };
  }

  middleware () {
    const readBody = (req) => {
      if (req.body && typeof req.body === 'object') return req.body;
      return {};
    };
    return (req, res, next) => {
      const pathname = String(req.path || '').replace(/\/+$/, '');
      if (pathname !== BASE && !pathname.startsWith(`${BASE}/`)) return next();
      const method = String(req.method || 'GET').toUpperCase();
      const parts = pathname.slice(BASE.length).split('/').filter(Boolean);
      const send = (status, body) => {
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify(body));
      };
      Promise.resolve(this.settings.members && this.settings.members.currentMember(req)).then(async (current) => {
        const member = current && current.member;
        if (!parts.length && method === 'GET') {
          const url = new URL(req.url, 'http://localhost');
          return send(200, { ok: true, bounties: this.list({ status: url.searchParams.get('status'), q: url.searchParams.get('q'), sort: url.searchParams.get('sort'), mine: url.searchParams.get('mine') === '1' ? member : null }) });
        }
        if (!parts.length && method === 'POST') return send(201, { ok: true, bounty: await this.create(readBody(req), member) });
        if (parts.length === 1 && method === 'GET') return send(200, { ok: true, bounty: this.view(this._get(parts[0]), member) });
        if (parts.length === 2 && method === 'POST') {
          const [id, action] = parts;
          const body = readBody(req);
          if (action === 'claim') return send(200, { ok: true, bounty: await this.claim(id, body, member) });
          if (action === 'refund') return send(200, { ok: true, bounty: await this.setRefund(id, body, member) });
          if (action === 'drop') return send(200, { ok: true, bounty: await this.drop(id, member) });
          if (action === 'finish') return send(200, { ok: true, bounty: await this.finish(id, member) });
          if (action === 'confirm') return send(200, { ok: true, bounty: await this.confirm(id, member) });
          if (action === 'dispute') return send(200, { ok: true, bounty: await this.dispute(id, body, member) });
          if (action === 'rule') return send(200, { ok: true, bounty: await this.rule(id, body, member) });
          if (action === 'payments') return send(200, { ok: true, bounty: await this.reportPayment(id, body, member) });
        }
        if (parts.length === 1 && method === 'POST' && parts[0] === 'messages') {
          return send(200, { ok: true, bounty: await this.ingest((readBody(req) || {}).frame) });
        }
        if (parts.length === 2 && method === 'GET' && parts[1] === 'invoice') {
          const bounty = this._get(parts[0]);
          const view = this.view(bounty, member);
          if (!view.invoice) return send(404, { error: 'This bounty is not waiting for a payment.' });
          return send(200, { ok: true, invoice: view.invoice });
        }
        return send(404, { error: 'Not found' });
      }).catch((error) => {
        if (res.headersSent) return;
        const status = error && error.status >= 400 && error.status < 500 ? error.status : 500;
        send(status, { error: status === 500 ? 'The bounty board is unavailable.' : error.message });
      });
    };
  }
}

module.exports = Bounties;
module.exports.BASE = BASE;
