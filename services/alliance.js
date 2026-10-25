'use strict';

const fs = require('fs');
const path = require('path');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const federation = require('../functions/allianceFederation');
const bridgeAttestation = require('../functions/bridgeAttestation');
const { fabricPubkey, parseAccountKey } = require('../functions/accountKey');

const BASE = '/services/alliance';
const LIMITS = { title: 120, summary: 2000 };
const DEFAULT_DAYS = 7;
const MAX_DAYS = 30;
const CLOCK_SKEW_MS = 10 * 60 * 1000;
const SHORT_ID = 12;
const MAX_PROPOSALS = 10000;
const DAY_MS = 24 * 60 * 60 * 1000;

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function text (value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/[ \t]+/g, ' ').trim().slice(0, max);
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * PERMAFLEET alliance votes: one vote per member organization, as a named
 * Fabric Federation ({@link module:functions/allianceFederation}).
 *
 * The roster (`contracts/alliance.json`) lists the member orgs and the
 * account keys of each org's stewards. Each org's validator key is derived
 * from goon.vc's key unless the roster gives the org's own pubkey. A steward
 * signed in to goon.vc proposes and votes for their org; goon.vc signs the
 * `FederationProposal` / `FederationVote` frame with that org's key. An org
 * holding its own key posts frames it signed itself to `POST …/messages`.
 * Every frame is verified, stored, and served, so anyone can recount; each
 * org's latest vote counts, and a proposal passes once a majority of all
 * member orgs vote yes (then it is closed). Changing the roster's orgs or
 * keys makes a new federation; open proposals stay with the one they were
 * made under. Everything lives in one `@fabric/core` {@link Store}.
 *
 * An org that lists `officers` is its own federation of their keys (a nested
 * multisig). Officers sign frames under the org federation with their own
 * keys and post them to `POST …/messages`; one officer's proposal, or the org
 * threshold of officers agreeing on a vote, has goon.vc sign the org's
 * alliance frame with the org key, carrying those officer frames as
 * `endorsements`. Stewards cannot vote for such an org from the buttons.
 *
 * Members vote too, as advice beside the orgs' decision. goon.vc is a Bridge
 * ({@link module:functions/bridgeAttestation}): it holds a key for each account
 * that votes (Discord `/vote`, or the proposal page), attests it once with
 * the bridge key, and signs the member's `FederationMemberVote` with it. A
 * Fabric key linked to a member may sign its own. Each member's latest vote
 * counts, whichever of their accounts cast it.
 */
class Alliance {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string} [settings.file] Roster (`contracts/alliance.json`).
   * @param {string} [settings.organizationsFile] RSI snapshot for org names and logos.
   * @param {string} [settings.organizationsPath] Site path of the org pages.
   * @param {string} [settings.basePath] Site path of the vote pages (for link previews).
   * @param {string} [settings.federationsPath] Site path of the federation pages.
   * @param {string|Function} [settings.xprv] goon.vc's key, or a function returning it.
   * @param {Object} [settings.members] goon.vc {@link Members}: who is signed in.
   * @param {Function} [settings.publish] `(frameHex) => void`, puts accepted frames on the Fabric network.
   * @param {Object} [settings.bridge] `{ name, origin, platforms }` of this Bridge.
   * @param {Function} [settings.now] Clock, injected for tests.
   */
  constructor (settings = {}) {
    const bridge = Object.assign({
      name: 'G00N SQUAD Discord',
      origin: 'https://goon.vc',
      platforms: ['discord', 'fabric']
    }, Object.fromEntries(Object.entries(settings.bridge || {}).filter(([, value]) => value !== undefined && value !== null)));
    this.settings = Object.assign({
      path: './stores/alliance',
      file: path.resolve(__dirname, '../contracts/alliance.json'),
      organizationsFile: path.resolve(__dirname, '../contracts/organizations.json'),
      organizationsPath: '/organizations',
      basePath: '/operations/PERMAFLEET/votes',
      federationsPath: '/federations',
      xprv: null,
      members: null,
      publish: null,
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)), { bridge });
    this.store = null;
    this.roster = null;
    this.current = null;
    this.bridge = null;
    this.error = null;
    this._xprv = null;
    this._orgs = new Map();
    this._queue = Promise.resolve();
    this._listeners = {};
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

  async start () {
    this.store = new Store({
      name: 'GOON.VC:alliance',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await startStore(this.store);
    this._loadOrganizations();
    const xprv = typeof this.settings.xprv === 'function' ? this.settings.xprv() : this.settings.xprv;
    this._xprv = xprv || null;
    if (this._xprv) {
      try {
        const descriptor = bridgeAttestation.bridgeDescriptor(Object.assign({}, this.settings.bridge, { pubkey: bridgeAttestation.bridgeKey(this._xprv).pubkey }));
        this.bridge = { id: bridgeAttestation.bridgeId(descriptor), descriptor };
        await this.store.set(`/bridge/${this.bridge.id}`, descriptor);
      } catch (error) {
        this.emit('error', 'GOON.VC', `member votes are off: ${error.message}`);
      }
    }
    try {
      this.roster = federation.parseRoster(readJson(this.settings.file));
      const validators = federation.validatorsFor(this.roster, this._xprv);
      const descriptor = federation.allianceDescriptor(this.roster, validators);
      this.current = await this._remember(descriptor, validators);
      await this._indexOrgFederations(this.current);
      this.emit('log', 'GOON.VC', `${this.roster.name} federation ${this.current.id} (${descriptor.threshold} of ${descriptor.validators.length} orgs)`);
    } catch (error) {
      this.error = error.message;
      this.emit('error', 'GOON.VC', `alliance votes are off: ${error.message}`);
    }
    return this;
  }

  async stop () {
    await this._queue.catch(() => {});
    if (this.store) await this.store.stop();
    return this;
  }

  _exclusive (task) {
    const run = this._queue.then(task, task);
    this._queue = run.catch(() => {});
    return run;
  }

  _iso (ms = this.settings.now()) {
    return new Date(ms).toISOString();
  }

  _loadOrganizations () {
    try {
      for (const org of readJson(this.settings.organizationsFile).organizations || []) {
        if (org && org.symbol) this._orgs.set(String(org.symbol).toUpperCase(), org);
      }
    } catch (_) { /* names fall back to symbols */ }
  }

  _orgView (symbol) {
    const org = this._orgs.get(symbol) || {};
    return {
      symbol,
      name: org.displayName || org.name || symbol,
      logoUrl: org.logoUrl || null,
      path: `${this.settings.organizationsPath}/${encodeURIComponent(symbol)}`
    };
  }

  /** Save a federation the first time it is seen, with its publisher-signed invite. */
  async _remember (descriptor, validators) {
    const id = federation.descriptorId(descriptor);
    const saved = await this.store.get(`/federation/${id}`);
    if (saved) return saved;
    const publisher = validators.find((v) => v.pubkey === descriptor.publisher);
    const record = {
      id,
      name: this.roster.name,
      descriptor,
      organizations: validators.map((v) => Object.assign({ symbol: v.symbol, pubkey: v.pubkey, custody: v.custody }, v.federation ? { federation: v.federation } : {})),
      invite: publisher.key ? federation.signFrame(federation.inviteBody(descriptor, this.roster.name, validators), publisher.key).frame : null,
      createdAt: this._iso()
    };
    await this.store.set(`/federation/${id}`, record);
    await this.store.set('/index/federations', (await this._list('/index/federations')).concat(id));
    return record;
  }

  /** Every org federation of officers, with the alliance federations it has been part of. */
  async _indexOrgFederations (record) {
    for (const org of record.organizations) {
      if (!org.federation) continue;
      const key = `/org-federation/${org.federation.id}`;
      const saved = await this.store.get(key);
      if (saved && saved.alliances.includes(record.id)) continue;
      await this.store.set(key, {
        id: org.federation.id,
        symbol: org.symbol,
        descriptor: org.federation.descriptor,
        alliances: (saved ? saved.alliances : []).concat(record.id),
        createdAt: saved ? saved.createdAt : this._iso()
      });
      if (!saved) await this.store.set('/index/org-federations', (await this._list('/index/org-federations')).concat(org.federation.id));
    }
  }

  _federationPath (id) {
    return `${this.settings.federationsPath}/${id.slice(0, SHORT_ID)}`;
  }

  async _list (key) {
    const list = await this.store.get(key);
    return Array.isArray(list) ? list : [];
  }

  async _federation (id) {
    if (!/^[0-9a-f]{64}$/.test(String(id || ''))) return null;
    return this.store.get(`/federation/${id}`);
  }

  async _proposal (id) {
    const wanted = String(id || '').toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(wanted)) return null;
    if (wanted.length === 64) return this.store.get(`/proposal/${wanted}`);
    const matches = (await this._list('/index/proposals')).filter((pid) => pid.startsWith(wanted));
    return matches.length === 1 ? this.store.get(`/proposal/${matches[0]}`) : null;
  }

  _assertReady () {
    if (!this.current) throw fail(503, 'Alliance votes are not configured.');
  }

  /**
   * Who is asking: the signed-in member, the orgs whose stewards list one of
   * their accounts, and the orgs listing one of their Fabric keys as an officer.
   * @returns {Promise<{ member: Object|null, by: string|null, orgs: string[], officers: string[] }>}
   */
  async actor (req) {
    const members = this.settings.members;
    const current = members ? await members.currentMember(req).catch(() => null) : null;
    if (!current || !this.roster) return { member: null, by: null, orgs: [], officers: [] };
    const keys = new Set((current.member.accounts || []).map((account) => account.key));
    const orgs = this.roster.organizations
      .filter((org) => org.stewards.some((key) => keys.has(key)))
      .map((org) => org.symbol);
    const officers = this.roster.organizations
      .filter((org) => org.officers.some((pubkey) => keys.has(`fabric:${pubkey.slice(2)}`)))
      .map((org) => org.symbol);
    return { member: current.member, by: current.member.displayName || null, orgs, officers };
  }

  /** An officer's goon.vc display name, or a short form of their key. */
  async _officerName (signer) {
    const members = this.settings.members;
    const member = members && typeof members.resolve === 'function'
      ? await members.resolve(`fabric:${signer}`).catch(() => null)
      : null;
    return (member && member.displayName) || `officer ${signer.slice(0, 8)}`;
  }

  /** Org federations by the x-only alliance validator key of each org of officers. */
  _officerOrgs (record) {
    const out = {};
    for (const org of record.organizations) {
      if (org.federation) out[org.pubkey.slice(2)] = { symbol: org.symbol, descriptor: org.federation.descriptor };
    }
    return out;
  }

  /** The org a steward acts for: the one they steward, or the one they named. */
  _orgFor (actor, requested) {
    if (!actor.member) throw fail(401, 'Sign in as an Org Steward to propose or vote.');
    if (!actor.orgs.length) throw fail(403, 'Only Org Stewards of a member org can propose or vote.');
    const wanted = requested ? String(requested).trim().toUpperCase() : null;
    if (wanted) {
      if (!actor.orgs.includes(wanted)) throw fail(403, `You are not a steward of ${wanted}.`);
      return wanted;
    }
    if (actor.orgs.length > 1) throw fail(400, `You steward ${actor.orgs.join(', ')}; say which org this is for.`);
    return actor.orgs[0];
  }

  /** goon.vc's key for an org a steward acts for, or why it cannot sign for it. */
  _signer (record, symbol) {
    const entry = record.organizations.find((org) => org.symbol === symbol);
    if (!entry) throw fail(403, `${symbol} is not a member of this federation.`);
    if (entry.custody === 'officers') {
      throw fail(409, `${symbol} decides by its officers' signatures; officers sign with npm run alliance:sign and post to ${BASE}/messages.`);
    }
    if (entry.custody !== 'goon.vc') {
      throw fail(409, `${symbol} signs with its own key; post its signed frame to ${BASE}/messages.`);
    }
    return this._orgKey(entry);
  }

  /** goon.vc's key for an org entry of a federation record. */
  _orgKey (entry) {
    if (!this._xprv) throw fail(409, `goon.vc no longer holds ${entry.symbol}'s key for this federation.`);
    const key = federation.orgKey(this._xprv, entry.symbol, entry.federation ? entry.federation.id : undefined);
    if (key.pubkey !== entry.pubkey) throw fail(409, `goon.vc no longer holds ${entry.symbol}'s key for this federation.`);
    return key;
  }

  _latestVote (proposal, signer) {
    const votes = proposal.votes.filter((vote) => vote.signer === signer);
    return votes.length ? votes[votes.length - 1] : null;
  }

  _symbolFor (record, signer) {
    const entry = record.organizations.find((org) => org.pubkey.slice(2) === fabricPubkey(signer));
    return entry ? entry.symbol : null;
  }

  /**
   * Verify and store a signed proposal or vote frame.
   * @param {string} frame hex
   * @param {Object} [meta] `{ by, member }` of the steward it was signed for
   * @returns {Promise<Object>} the proposal, as served
   */
  ingest (frame, meta = {}) {
    return this._exclusive(() => this._ingest(frame, meta));
  }

  async _ingest (frame, meta = {}) {
    let opened;
    try {
      opened = federation.openFrame(frame);
    } catch (error) {
      throw fail(400, `Rejected frame: ${error.message}`);
    }
    const { body, signer, id } = opened;
    const now = this.settings.now();
    if (body.type === federation.MESSAGE_TYPES.memberVote) return this._ingestMember(String(frame).toLowerCase(), opened, now, meta);
    if (body.allianceFederationId !== undefined) return this._ingestOfficer(String(frame).toLowerCase(), opened, now);
    if (body.type === federation.MESSAGE_TYPES.proposal) {
      const record = await this._federation(body.federationId);
      if (!record) throw fail(404, 'Unknown federation.');
      const endorsements = this._verify(record, body, signer);
      if (body.title.length > LIMITS.title || String(body.summary || '').length > LIMITS.summary) throw fail(400, 'Proposal is too long.');
      const created = Date.parse(body.createdAt);
      if (created > now + CLOCK_SKEW_MS) throw fail(400, 'Proposal is dated in the future.');
      if (Date.parse(body.closesAt) - created > MAX_DAYS * DAY_MS) throw fail(400, `Voting can stay open ${MAX_DAYS} days at most.`);
      const pid = federation.proposalId(body);
      const existing = await this.store.get(`/proposal/${pid}`);
      if (existing) return this._view(existing);
      const ids = await this._list('/index/proposals');
      if (ids.length >= MAX_PROPOSALS) throw fail(409, 'The proposal archive is full.');
      if (record.id !== this.current.id) throw fail(409, 'New proposals go to the current federation.');
      const proposal = {
        id: pid,
        federationId: record.id,
        frame: String(frame).toLowerCase(),
        frameId: id,
        signer,
        body,
        endorsements: this._endorsements(body, endorsements),
        by: meta.by || null,
        member: meta.member || null,
        receivedAt: this._iso(now),
        votes: [],
        officerVotes: []
      };
      await this.store.set(`/proposal/${pid}`, proposal);
      await this.store.set('/index/proposals', ids.concat(pid));
      this._publish(frame);
      return this._view(proposal);
    }
    if (body.type === federation.MESSAGE_TYPES.vote) {
      const proposal = await this.store.get(`/proposal/${String(body.proposalId || '').toLowerCase()}`);
      if (!proposal) throw fail(404, 'No such proposal.');
      const record = await this._federation(proposal.federationId);
      const endorsements = this._verify(record, body, signer);
      if (Date.parse(body.castAt) > now + CLOCK_SKEW_MS) throw fail(400, 'Vote is dated in the future.');
      if (proposal.votes.some((vote) => vote.frameId === id)) return this._view(proposal);
      const counted = federation.tally(record.descriptor, proposal.body, proposal.votes, now);
      if (counted.status !== 'open') throw fail(409, `Voting on this proposal is closed (${counted.status}).`);
      // Frames are public: an org's older vote must not be replayable over its newer one.
      const previous = this._latestVote(proposal, signer);
      if (previous && Date.parse(body.castAt) <= Date.parse(previous.castAt)) {
        throw fail(409, `${this._symbolFor(record, signer)} has already voted more recently.`);
      }
      if (counted.choices[signer] === body.choice) return this._view(proposal);
      proposal.votes.push({
        frame: String(frame).toLowerCase(),
        frameId: id,
        signer,
        choice: body.choice,
        castAt: body.castAt,
        endorsements: this._endorsements(body, endorsements),
        by: meta.by || null,
        member: meta.member || null,
        receivedAt: this._iso(now)
      });
      await this.store.set(`/proposal/${proposal.id}`, proposal);
      this._publish(frame);
      return this._view(proposal);
    }
    throw fail(400, `Rejected frame: not a proposal or vote (${body.type}).`);
  }

  /**
   * An officer's frame under their org federation: a proposal is wrapped into
   * the org's alliance proposal at once; a vote is kept, and once the org
   * threshold of officers agree on a choice the org's alliance vote follows.
   */
  async _ingestOfficer (frame, opened, now) {
    const { body, signer, id } = opened;
    const record = await this._federation(body.allianceFederationId);
    if (!record) throw fail(404, 'Unknown federation.');
    const entry = record.organizations.find((org) => org.symbol === body.org);
    if (!entry || !entry.federation || entry.federation.id !== body.federationId) {
      throw fail(403, `Rejected frame: ${body.org} has no such org federation in this alliance.`);
    }
    const descriptor = entry.federation.descriptor;
    try {
      federation.verifyOfficerBody(descriptor, body, signer);
    } catch (error) {
      throw fail(403, `Rejected frame: ${error.message}`);
    }
    const key = this._orgKey(entry);
    const by = await this._officerName(signer);
    if (body.type === federation.MESSAGE_TYPES.proposal) {
      const outer = federation.proposalBody(record.id, {
        title: body.title,
        summary: body.summary,
        proposer: key.pubkey,
        createdAt: body.createdAt,
        closesAt: body.closesAt,
        orgFederationId: entry.federation.id,
        endorsements: [frame]
      });
      return this._ingest(federation.signFrame(outer, key).frame, { by });
    }
    const proposal = await this.store.get(`/proposal/${String(body.proposalId).toLowerCase()}`);
    if (!proposal) throw fail(404, 'No such proposal.');
    if (proposal.federationId !== record.id) throw fail(403, 'Rejected frame: officer vote is for another alliance federation.');
    if (Date.parse(body.castAt) > now + CLOCK_SKEW_MS) throw fail(400, 'Vote is dated in the future.');
    const officerVotes = proposal.officerVotes || [];
    if (officerVotes.some((vote) => vote.frameId === id)) return this._view(proposal);
    const counted = federation.tally(record.descriptor, proposal.body, proposal.votes, now);
    if (counted.status !== 'open') throw fail(409, `Voting on this proposal is closed (${counted.status}).`);
    const mine = officerVotes.filter((vote) => vote.org === entry.symbol);
    const previous = mine.filter((vote) => vote.signer === signer).pop();
    if (previous && Date.parse(body.castAt) <= Date.parse(previous.castAt)) throw fail(409, 'This officer has already voted more recently.');
    if (previous && previous.choice === body.choice) return this._view(proposal);
    const vote = { org: entry.symbol, frame, frameId: id, signer, choice: body.choice, castAt: body.castAt, by, receivedAt: this._iso(now) };
    proposal.officerVotes = officerVotes.concat(vote);
    await this.store.set(`/proposal/${proposal.id}`, proposal);
    this._publish(frame);
    const decided = federation.orgTally(descriptor, mine.concat(vote)).decided;
    const orgSigner = entry.pubkey.slice(2);
    if (!decided || decided === counted.choices[orgSigner]) return this._view(proposal);
    const latest = new Map();
    for (const row of mine.concat(vote)) latest.set(row.signer, row);
    const backers = Array.from(latest.values()).filter((row) => row.choice === decided);
    const prior = this._latestVote(proposal, orgSigner);
    const castAt = Math.max(now, prior ? Date.parse(prior.castAt) + 1 : 0);
    const outer = federation.voteBody(record.id, {
      proposalId: proposal.id,
      choice: decided,
      castAt: this._iso(castAt),
      orgFederationId: entry.federation.id,
      endorsements: backers.map((row) => row.frame)
    });
    return this._ingest(federation.signFrame(outer, key).frame, { by: backers.map((row) => row.by).join(', ') });
  }

  /**
   * A member's vote: attested by this Bridge (the account must be one it
   * holds, so its member is known) or signed by a Fabric key a member holds.
   */
  async _ingestMember (frame, opened, now, meta = {}) {
    const { body, signer, id } = opened;
    const proposal = await this.store.get(`/proposal/${String(body.proposalId || '').toLowerCase()}`);
    if (!proposal) throw fail(404, 'No such proposal.');
    const record = await this._federation(proposal.federationId);
    let checked;
    try {
      checked = federation.verifyMemberVote(record.descriptor, this.bridge ? this.bridge.descriptor : null, body, signer);
    } catch (error) {
      throw fail(403, `Rejected frame: ${error.message}`);
    }
    let memberId = null;
    if (checked.attested) {
      const held = await this.store.get(`/attested-key/${checked.attestation.account}`);
      const attested = held && await this.store.get(`/attested/${held.account}`);
      if (!attested) throw fail(403, 'Rejected frame: this Bridge has not attested that account.');
      memberId = (await this._memberId(attested.account)) || meta.member || attested.member;
    } else {
      memberId = await this._memberId(`fabric:${signer}`);
      if (!memberId) throw fail(403, 'Rejected frame: that Fabric key is not linked to a goon.vc member.');
    }
    if (!memberId) throw fail(403, 'Rejected frame: no member for that account.');
    if (Date.parse(body.castAt) > now + CLOCK_SKEW_MS) throw fail(400, 'Vote is dated in the future.');
    const memberVotes = proposal.memberVotes || [];
    if (memberVotes.some((vote) => vote.frameId === id)) return this._view(proposal, memberId);
    const counted = federation.tally(record.descriptor, proposal.body, proposal.votes, now);
    if (counted.status !== 'open') throw fail(409, `Voting on this proposal is closed (${counted.status}).`);
    const previous = (await this._resolvedMemberVotes(proposal)).filter((vote) => vote.member === memberId).pop();
    if (previous && Date.parse(body.castAt) <= Date.parse(previous.castAt)) throw fail(409, 'You have already voted more recently.');
    if (previous && previous.signer === signer && previous.choice === body.choice) return this._view(proposal, memberId);
    proposal.memberVotes = memberVotes.concat({
      member: memberId,
      frame,
      frameId: id,
      signer,
      platform: checked.platform,
      bridge: checked.attested ? this.bridge.id : null,
      choice: body.choice,
      castAt: body.castAt,
      receivedAt: this._iso(now)
    });
    await this.store.set(`/proposal/${proposal.id}`, proposal);
    this._publish(frame);
    return this._view(proposal, memberId);
  }

  /** The goon.vc member id an account key or (older) member id resolves to now. */
  async _memberId (idOrKey) {
    const members = this.settings.members;
    if (!members || typeof members.resolve !== 'function') return null;
    const member = await members.resolve(idOrKey).catch(() => null);
    return member && member.id ? member.id : null;
  }

  /** Member votes with each member id resolved through merges. */
  async _resolvedMemberVotes (proposal) {
    const ids = new Map();
    const out = [];
    for (const vote of proposal.memberVotes || []) {
      if (!ids.has(vote.member)) ids.set(vote.member, (await this._memberId(vote.member)) || vote.member);
      out.push(Object.assign({}, vote, { member: ids.get(vote.member) }));
    }
    return out;
  }

  /** This Bridge's attestation for an account, made the first time it votes. */
  async _attestation (account, memberId) {
    const saved = await this.store.get(`/attested/${account}`);
    if (saved && saved.bridge === this.bridge.id) return saved;
    const attestedAt = this._iso();
    const made = bridgeAttestation.attest(this._xprv, this.bridge.descriptor, account, attestedAt);
    const record = {
      account,
      member: memberId || null,
      bridge: this.bridge.id,
      platform: made.platform,
      pubkey: made.pubkey,
      frame: made.frame,
      id: made.id,
      attestedAt
    };
    await this.store.set(`/attested/${account}`, record);
    await this.store.set(`/attested-key/${made.pubkey}`, { account });
    return record;
  }

  /**
   * A member votes from one of their accounts (`platform:id`): goon.vc signs
   * with the key it holds for that account, under this Bridge's attestation.
   * Their latest vote, from any of their accounts, counts.
   * @param {string} id proposal id (or its first 12 characters)
   * @param {Object} input `{ account, member, choice }`; `member` is the goon.vc member (or its id)
   * @returns {Promise<Object>} the proposal, as served, with `you.memberVote` and `you.replaced`
   */
  memberVote (id, input = {}) {
    return this._exclusive(async () => {
      this._assertReady();
      if (!this.bridge) throw fail(503, 'Member votes are not set up right now.');
      const proposal = await this._proposal(id);
      if (!proposal) throw fail(404, 'No such proposal.');
      const choice = String(input.choice || '').toLowerCase();
      if (!federation.CHOICES.includes(choice)) throw fail(400, 'Vote yes, no, or abstain.');
      const parsed = parseAccountKey(input.account);
      if (!parsed) throw fail(400, 'An account is required.');
      if (!this.bridge.descriptor.platforms.includes(parsed.platform)) throw fail(400, `This Bridge does not attest ${parsed.platform} accounts.`);
      const given = input.member && typeof input.member === 'object' ? input.member.id : input.member;
      const memberId = (await this._memberId(parsed.key)) || given || null;
      if (!memberId) throw fail(400, 'A member is required.');
      const attestation = await this._attestation(parsed.key, memberId);
      const previous = (await this._resolvedMemberVotes(proposal)).filter((vote) => vote.member === memberId).pop();
      const now = this.settings.now();
      const castAt = Math.max(now, previous ? Date.parse(previous.castAt) + 1 : 0);
      const key = bridgeAttestation.accountKey(this._xprv, parsed.key);
      const body = federation.memberVoteBody(proposal.federationId, {
        proposalId: proposal.id,
        choice,
        castAt: this._iso(castAt),
        attestation: attestation.frame
      });
      const signed = federation.signFrame(body, key);
      const view = await this._ingestMember(signed.frame, federation.openFrame(signed.frame), now, { member: memberId });
      view.you.replaced = previous
        ? { choice: previous.choice, otherAccount: previous.signer !== key.pubkey.slice(2) }
        : null;
      return view;
    });
  }

  /** The account a signed-in member votes from on the web: the one they signed in with. */
  _webAccount (current) {
    const platforms = this.bridge ? this.bridge.descriptor.platforms : [];
    const accounts = (current.member.accounts || [])
      .map((account) => parseAccountKey(account.key))
      .filter((parsed) => parsed && platforms.includes(parsed.platform));
    const signedInWith = current.via === 'discord' ? 'discord' : (current.via ? 'fabric' : null);
    const account = accounts.find((parsed) => parsed.platform === signedInWith) || accounts[0];
    if (!account) throw fail(409, 'None of your linked accounts can vote here.');
    return account.key;
  }

  /**
   * A signed-in member votes from the proposal page.
   * @param {string} id
   * @param {Object} input `{ choice }`
   * @param {Object} req
   */
  async webMemberVote (id, input, req) {
    const members = this.settings.members;
    const current = members ? await members.currentMember(req).catch(() => null) : null;
    if (!current) throw fail(401, 'Sign in to vote as a member.');
    this._assertReady();
    if (!this.bridge) throw fail(503, 'Member votes are not set up right now.');
    return this.memberVote(id, { account: this._webAccount(current), member: current.member.id, choice: (input || {}).choice });
  }

  _bridgeView () {
    return this.bridge ? { id: this.bridge.id, descriptor: this.bridge.descriptor } : null;
  }

  _endorsements (body, opened) {
    return opened.map((endorsement, i) => ({ id: endorsement.id, frame: String(body.endorsements[i]).toLowerCase() }));
  }

  _verify (record, body, signer) {
    try {
      return federation.verifyBody(record.descriptor, body, signer, this._officerOrgs(record));
    } catch (error) {
      throw fail(403, `Rejected frame: ${error.message}`);
    }
  }

  _publish (frame) {
    if (typeof this.settings.publish !== 'function') return;
    try {
      this.settings.publish(frame);
    } catch (error) {
      this.emit('error', 'GOON.VC', `could not publish alliance frame: ${error.message}`);
    }
  }

  /**
   * A steward proposes something for the member orgs to vote on.
   * @param {Object} input `{ title, summary?, days?, org? }`
   * @param {Object} actor {@link Alliance#actor}
   * @returns {Promise<Object>}
   */
  async propose (input, actor) {
    this._assertReady();
    input = input || {};
    const symbol = this._orgFor(actor, input.org);
    const key = this._signer(this.current, symbol);
    const title = text(input.title, LIMITS.title);
    if (title.length < 3) throw fail(400, 'A proposal needs a title.');
    const summary = String(input.summary === undefined || input.summary === null ? '' : input.summary).trim().slice(0, LIMITS.summary);
    const days = input.days === undefined || input.days === null || input.days === '' ? DEFAULT_DAYS : Number(input.days);
    if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) throw fail(400, `Voting stays open 1 to ${MAX_DAYS} days.`);
    const now = this.settings.now();
    const body = federation.proposalBody(this.current.id, {
      title,
      summary,
      proposer: key.pubkey,
      createdAt: this._iso(now),
      closesAt: this._iso(now + days * DAY_MS)
    });
    return this.ingest(federation.signFrame(body, key).frame, { by: actor.by, member: actor.member.id });
  }

  /**
   * A steward casts (or changes, while voting is open) their org's vote.
   * @param {string} id proposal id (or its first 12 characters)
   * @param {Object} input `{ choice, org? }`
   * @param {Object} actor {@link Alliance#actor}
   * @returns {Promise<Object>}
   */
  async vote (id, input, actor) {
    this._assertReady();
    input = input || {};
    const proposal = await this._proposal(id);
    if (!proposal) throw fail(404, 'No such proposal.');
    const choice = String(input.choice || '').toLowerCase();
    if (!federation.CHOICES.includes(choice)) throw fail(400, 'Vote yes, no, or abstain.');
    const symbol = this._orgFor(actor, input.org);
    const record = await this._federation(proposal.federationId);
    const key = this._signer(record, symbol);
    const previous = this._latestVote(proposal, key.pubkey.slice(2));
    const castAt = Math.max(this.settings.now(), previous ? Date.parse(previous.castAt) + 1 : 0);
    const body = federation.voteBody(record.id, { proposalId: proposal.id, choice, castAt: this._iso(castAt) });
    return this.ingest(federation.signFrame(body, key).frame, { by: actor.by, member: actor.member.id });
  }

  /** Each member's latest vote, and the counts. */
  async _memberCounts (proposal) {
    const counted = federation.memberTally(await this._resolvedMemberVotes(proposal));
    return { counts: { yes: counted.yes, no: counted.no, abstain: counted.abstain, total: counted.total }, latest: counted.latest };
  }

  _summary (proposal, record, members = { yes: 0, no: 0, abstain: 0, total: 0 }) {
    const counted = federation.tally(record.descriptor, proposal.body, proposal.votes, this.settings.now());
    const proposer = this._symbolFor(record, proposal.signer);
    return {
      id: proposal.id,
      shortId: proposal.id.slice(0, SHORT_ID),
      path: `${this.settings.basePath}/${proposal.id.slice(0, SHORT_ID)}`,
      federationId: record.id,
      title: proposal.body.title,
      proposer: proposer ? this._orgView(proposer) : null,
      by: proposal.by,
      createdAt: proposal.body.createdAt,
      closesAt: proposal.body.closesAt,
      status: counted.status,
      tally: { yes: counted.yes, no: counted.no, abstain: counted.abstain, waiting: counted.waiting, threshold: counted.threshold, orgs: counted.orgs },
      members
    };
  }

  /**
   * A proposal as served. Member votes show only the counted frame per
   * member, with no member id or account.
   * @param {Object} proposal
   * @param {string} [memberId] the member asking, for `you.memberVote`
   */
  async _view (proposal, memberId = null) {
    const record = await this._federation(proposal.federationId);
    const counted = federation.tally(record.descriptor, proposal.body, proposal.votes, this.settings.now());
    const latest = new Map();
    for (const vote of proposal.votes) latest.set(vote.signer, vote);
    const officerVotes = proposal.officerVotes || [];
    const members = await this._memberCounts(proposal);
    const mine = memberId ? members.latest.get(memberId) : null;
    const counts = Array.from(members.latest.values());
    const bridges = [];
    for (const bid of new Set(counts.map((vote) => vote.bridge).filter((bid) => bid && (!this.bridge || bid !== this.bridge.id)))) {
      const descriptor = await this.store.get(`/bridge/${bid}`);
      if (descriptor) bridges.push({ id: bid, descriptor });
    }
    return Object.assign(this._summary(proposal, record, members.counts), {
      summary: proposal.body.summary || '',
      federationPath: this._federationPath(record.id),
      current: !!this.current && record.id === this.current.id,
      organizations: record.organizations.map((org) => {
        const vote = latest.get(org.pubkey.slice(2));
        const view = Object.assign(this._orgView(org.symbol), {
          custody: org.custody,
          choice: counted.choices[org.pubkey.slice(2)] || null,
          castAt: vote ? vote.castAt : null,
          by: vote ? vote.by : null
        });
        if (org.federation) {
          const officers = federation.orgTally(org.federation.descriptor, officerVotes.filter((row) => row.org === org.symbol));
          view.federationId = org.federation.id;
          view.federationPath = this._federationPath(org.federation.id);
          view.officers = { threshold: officers.threshold, total: officers.total, yes: officers.yes, no: officers.no, abstain: officers.abstain, waiting: officers.waiting };
        }
        return view;
      }),
      votes: proposal.votes.map((vote) => ({
        org: this._symbolFor(record, vote.signer),
        choice: vote.choice,
        castAt: vote.castAt,
        by: vote.by,
        id: vote.frameId,
        frame: vote.frame,
        endorsements: vote.endorsements || []
      })),
      officerVotes: officerVotes.map((vote) => ({
        org: vote.org,
        choice: vote.choice,
        castAt: vote.castAt,
        by: vote.by,
        id: vote.frameId,
        frame: vote.frame
      })),
      memberVotes: counts.map((vote) => ({
        choice: vote.choice,
        castAt: vote.castAt,
        platform: vote.platform,
        signer: vote.signer,
        bridge: vote.bridge,
        id: vote.frameId,
        frame: vote.frame
      })),
      bridge: this._bridgeView(),
      bridges,
      you: { memberVote: mine ? { choice: mine.choice, castAt: mine.castAt, platform: mine.platform } : null },
      frame: proposal.frame,
      endorsements: proposal.endorsements || [],
      descriptor: record.descriptor,
      orgFederations: record.organizations.filter((org) => org.federation).map((org) => ({
        symbol: org.symbol,
        id: org.federation.id,
        path: this._federationPath(org.federation.id),
        descriptor: org.federation.descriptor
      }))
    });
  }

  /**
   * @param {string} id
   * @param {Object} [actor] {@link Alliance#actor}, for `you.memberVote`
   */
  async getProposal (id, actor = null) {
    const proposal = await this._proposal(id);
    if (!proposal) return null;
    const memberId = actor && actor.member ? ((await this._memberId(actor.member.id)) || actor.member.id) : null;
    return this._view(proposal, memberId);
  }

  /**
   * Newest first.
   * @returns {Promise<Array<Object>>}
   */
  async listProposals () {
    const out = [];
    const federations = new Map();
    for (const pid of await this._list('/index/proposals')) {
      const proposal = await this.store.get(`/proposal/${pid}`);
      if (!proposal) continue;
      if (!federations.has(proposal.federationId)) federations.set(proposal.federationId, await this._federation(proposal.federationId));
      out.push(this._summary(proposal, federations.get(proposal.federationId), (await this._memberCounts(proposal)).counts));
    }
    return out.reverse();
  }

  /**
   * The federation, its member orgs, who is asking, and every proposal.
   * @param {Object} [actor]
   * @returns {Promise<Object>}
   */
  async overview (actor = { member: null, orgs: [], officers: [] }) {
    const you = { signedIn: !!actor.member, organizations: actor.orgs || [], officers: actor.officers || [] };
    if (!this.current) return { name: this.roster ? this.roster.name : null, status: 'unconfigured', error: this.error, bridge: this._bridgeView(), you, proposals: [] };
    const record = this.current;
    return {
      name: record.name,
      status: 'ready',
      bridge: this._bridgeView(),
      federation: {
        id: record.id,
        path: this._federationPath(record.id),
        network: record.descriptor.network,
        threshold: record.descriptor.threshold,
        orgs: record.descriptor.validators.length,
        descriptor: record.descriptor,
        invite: record.invite,
        organizations: record.organizations.map((org) => Object.assign(this._orgView(org.symbol), {
          pubkey: org.pubkey,
          custody: org.custody,
          stewards: (this.roster.organizations.find((o) => o.symbol === org.symbol) || { stewards: [] }).stewards.length
        }, org.federation ? {
          federation: {
            id: org.federation.id,
            path: this._federationPath(org.federation.id),
            threshold: org.federation.descriptor.threshold,
            officers: org.federation.descriptor.validators.length,
            descriptor: org.federation.descriptor
          }
        } : {}))
      },
      you,
      proposals: await this.listProposals()
    };
  }

  _allianceSummary (record) {
    return {
      id: record.id,
      shortId: record.id.slice(0, SHORT_ID),
      path: this._federationPath(record.id),
      kind: 'alliance',
      name: record.name,
      symbol: null,
      network: record.descriptor.network,
      threshold: record.descriptor.threshold,
      members: record.descriptor.validators.length,
      current: !!this.current && record.id === this.current.id,
      createdAt: record.createdAt
    };
  }

  _orgFederationSummary (saved) {
    const org = this._orgView(saved.symbol);
    return {
      id: saved.id,
      shortId: saved.id.slice(0, SHORT_ID),
      path: this._federationPath(saved.id),
      kind: 'organization',
      name: org.name,
      symbol: saved.symbol,
      organization: org,
      network: saved.descriptor.network,
      threshold: saved.descriptor.threshold,
      members: saved.descriptor.validators.length,
      current: !!this.current && this.current.organizations.some((o) => o.federation && o.federation.id === saved.id),
      createdAt: saved.createdAt
    };
  }

  /** An alliance or org federation by id or unique prefix (at least 12 hex characters). */
  async _findFederation (id) {
    const wanted = String(id || '').toLowerCase();
    if (!/^[0-9a-f]{12,64}$/.test(wanted)) return null;
    const alliances = (await this._list('/index/federations')).filter((fid) => fid.startsWith(wanted));
    const orgs = (await this._list('/index/org-federations')).filter((fid) => fid.startsWith(wanted));
    if (alliances.length + orgs.length !== 1) return null;
    if (alliances.length) {
      const record = await this.store.get(`/federation/${alliances[0]}`);
      return record ? { kind: 'alliance', record } : null;
    }
    const record = await this.store.get(`/org-federation/${orgs[0]}`);
    return record ? { kind: 'organization', record } : null;
  }

  /**
   * Every alliance federation, then every org federation of officers; the
   * current ones first, newest first after that.
   * @returns {Promise<Array<Object>>}
   */
  async listFederations () {
    const out = [];
    for (const fid of (await this._list('/index/federations')).slice().reverse()) {
      const record = await this.store.get(`/federation/${fid}`);
      if (record) out.push(this._allianceSummary(record));
    }
    for (const fid of (await this._list('/index/org-federations')).slice().reverse()) {
      const saved = await this.store.get(`/org-federation/${fid}`);
      if (saved) out.push(this._orgFederationSummary(saved));
    }
    const rank = (row) => (row.current ? 0 : 1) * 2 + (row.kind === 'alliance' ? 0 : 1);
    return out.map((row, index) => [row, index])
      .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
      .map(([row]) => row);
  }

  /**
   * One federation: its descriptor and members, plus the alliance's invite
   * and proposals, or the alliances an org federation has decided for.
   * @param {string} id Federation id or unique prefix.
   * @returns {Promise<Object|null>}
   */
  async getFederation (id) {
    const found = await this._findFederation(id);
    if (!found) return null;
    const { record } = found;
    if (found.kind === 'alliance') {
      const proposals = (await this.listProposals()).filter((row) => row.federationId === record.id);
      return Object.assign(this._allianceSummary(record), {
        descriptor: record.descriptor,
        invite: record.invite,
        organizations: record.organizations.map((org) => Object.assign(this._orgView(org.symbol), {
          pubkey: org.pubkey,
          custody: org.custody
        }, org.federation ? {
          federation: {
            id: org.federation.id,
            shortId: org.federation.id.slice(0, SHORT_ID),
            path: this._federationPath(org.federation.id),
            threshold: org.federation.descriptor.threshold,
            officers: org.federation.descriptor.validators.length
          }
        } : {})),
        proposals
      });
    }
    const alliances = [];
    for (const fid of record.alliances) {
      const alliance = await this.store.get(`/federation/${fid}`);
      if (alliance) alliances.push(this._allianceSummary(alliance));
    }
    const officers = [];
    for (const pubkey of record.descriptor.validators) {
      officers.push({ pubkey, name: await this._officerName(pubkey.slice(2)) });
    }
    return Object.assign(this._orgFederationSummary(record), {
      descriptor: record.descriptor,
      officers,
      alliances: alliances.reverse()
    });
  }

  /**
   * Link-preview metadata for a federation page, or null.
   * @param {string} pathname
   * @returns {Promise<{ path: string, title: string, description: string }|null>}
   */
  async federationPage (pathname) {
    const base = String(this.settings.federationsPath).replace(/\/+$/, '').toLowerCase();
    const clean = String(pathname || '').replace(/\/+$/, '');
    if (clean.toLowerCase().indexOf(base + '/') !== 0) return null;
    const rest = clean.slice(base.length + 1);
    if (rest.includes('/')) return null;
    const found = await this._findFederation(rest);
    if (!found) return null;
    const info = found.kind === 'alliance' ? this._allianceSummary(found.record) : this._orgFederationSummary(found.record);
    const signers = found.kind === 'alliance' ? 'member orgs' : 'officers';
    return {
      path: clean,
      title: found.kind === 'alliance' ? `${info.name} federation` : `${info.name} officers`,
      description: `A Fabric federation: ${info.threshold} of ${info.members} ${signers} decide · ${info.network} · id ${info.shortId}.`
    };
  }

  /**
   * Link-preview metadata for a proposal page, or null.
   * @param {string} pathname
   * @returns {Promise<{ path: string, title: string, description: string }|null>}
   */
  async page (pathname) {
    const base = String(this.settings.basePath).replace(/\/+$/, '').toLowerCase();
    const clean = String(pathname || '').replace(/\/+$/, '');
    if (clean.toLowerCase().indexOf(base + '/') !== 0) return null;
    const rest = clean.slice(base.length + 1);
    if (rest.includes('/')) return null;
    const proposal = await this._proposal(rest);
    if (!proposal) return null;
    const record = await this._federation(proposal.federationId);
    const info = this._summary(proposal, record);
    const counts = `${info.tally.yes} yes, ${info.tally.no} no, ${info.tally.abstain} abstain of ${info.tally.orgs} orgs`;
    const status = info.status === 'open' ? `Open until ${info.closesAt.slice(0, 10)}` : info.status[0].toUpperCase() + info.status.slice(1);
    return { path: clean, title: info.title, description: `${record.name} vote · ${status} · ${counts} (${info.tally.threshold} yes to pass).` };
  }

  /**
   * Express middleware for `/services/alliance/*`.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      if (pathname !== BASE && !pathname.startsWith(BASE + '/')) return next();
      const method = String(req.method || 'GET').toUpperCase();
      const parts = pathname.slice(BASE.length).split('/').filter(Boolean);
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      Promise.resolve().then(async () => {
        const [collection, id, action] = parts;
        if (!parts.length && method === 'GET') return [200, await this.overview(await this.actor(req))];
        if (collection === 'proposals') {
          if (parts.length === 1) {
            if (method === 'GET') return [200, { proposals: await this.listProposals() }];
            if (method === 'POST') return [201, await this.propose(body, await this.actor(req))];
          } else if (parts.length === 2 && method === 'GET') {
            const proposal = await this.getProposal(id, await this.actor(req));
            if (!proposal) throw fail(404, 'No such proposal.');
            return [200, proposal];
          } else if (parts.length === 3 && action === 'votes' && method === 'POST') {
            return [200, await this.vote(id, body, await this.actor(req))];
          } else if (parts.length === 3 && action === 'member-votes' && method === 'POST') {
            return [200, await this.webMemberVote(id, body, req)];
          }
        }
        if (collection === 'bridge' && parts.length === 1 && method === 'GET') {
          if (!this.bridge) throw fail(503, 'Member votes are not set up right now.');
          return [200, Object.assign(this._bridgeView(), { attestation: bridgeAttestation.ATTESTATION_TYPE, vote: federation.MESSAGE_TYPES.memberVote })];
        }
        if (collection === 'federations' && method === 'GET') {
          if (parts.length === 1) return [200, { federations: await this.listFederations() }];
          if (parts.length === 2) {
            const found = await this.getFederation(id);
            if (!found) throw fail(404, 'No such federation.');
            return [200, found];
          }
        }
        if (collection === 'messages' && parts.length === 1 && method === 'POST') {
          this._assertReady();
          return [200, await this.ingest(body.frame)];
        }
        throw fail(parts.length > 3 ? 404 : 405, parts.length > 3 ? 'Not found' : 'Method not allowed');
      }).then(([status, payload]) => sendJson(res, status, payload), (error) => {
        if (res.headersSent) return;
        sendJson(res, error && error.status ? error.status : 500, { error: error && error.message ? error.message : 'Alliance request failed' });
      });
    };
  }
}

module.exports = Alliance;
module.exports.BASE = BASE;
