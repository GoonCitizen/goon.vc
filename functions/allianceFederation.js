'use strict';

/**
 * @fileoverview The PERMAFLEET alliance as a named Fabric Federation: one
 * validator key per member organization, so each org has exactly one vote.
 *
 * The descriptor is `@fabric/core`'s `FabricFederationDescriptor` (version 1)
 * and its id is the SHA-256 of its canonical JSON, so Hub, GoonCitizen, and
 * Passport derive the same federation id. Core's `Federation.buildDescriptor`
 * is used when the installed core has it; otherwise the same descriptor is
 * built here.
 *
 * Proposals and votes are `CONTRACT_MESSAGE` bodies under the federation id
 * (`FederationProposal`, `FederationVote`), each a `Message` frame signed by
 * the org's validator key. Anyone holding the descriptor and the frames can
 * recount a vote.
 *
 * An org may instead be its own federation of officers (a nested multisig).
 * The roster names officers by account (`discord:<id>`); goon.vc holds one
 * hardened key per officer account and signs that officer's
 * `FederationProposal` / `FederationVote` frames under the org federation id
 * when they act while signed in. The org descriptor lists those officer keys
 * and its threshold, and the org's alliance frame carries the officer frames
 * as `endorsements`. The org's validator key is derived from the org
 * federation id, so changing officers or threshold makes a new alliance
 * federation.
 *
 * Members also vote, as advice beside the orgs' decision: a
 * `FederationMemberVote` signed by the key a Bridge holds for the member's
 * account (carrying the Bridge's attestation, see ./bridgeAttestation), or
 * by the member's own Fabric key.
 */

const crypto = require('crypto');
const Key = require('@fabric/core/types/key');
const { stableStringify } = require('@fabric/core/functions/fabricCanonicalJson');
const { fabricPubkey, parseAccountKey } = require('./accountKey');
const {
  DEFAULT_CSV_BLOCKS,
  DESCRIPTOR_TYPE,
  DESCRIPTOR_VERSION,
  NETWORKS,
  buildDescriptor,
  compressedPubkey,
  descriptorId,
  isValidator,
  openFrame,
  signFrame
} = require('./fabricFederation');

// Hardened child of goon.vc's key per org: m/7777'/1'/<symbol index>'.
const ORG_KEY_PATH = "m/7777'/1'";
// One officer account's key: m/7777'/5'/<a>'/<b>'.
const OFFICER_KEY_PATH = "m/7777'/5'";
const MESSAGE_TYPES = Object.freeze({
  invite: 'FederationInvite',
  proposal: 'FederationProposal',
  vote: 'FederationVote',
  memberVote: 'FederationMemberVote'
});
const CHOICES = Object.freeze(['yes', 'no', 'abstain']);
// Keeps an alliance frame carrying every officer's endorsement under core's 32 KiB body cap.
const MAX_OFFICERS = 16;
const SYMBOL_RE = /^[A-Z0-9_]{1,16}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

function sha256 (text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseOfficers (symbol, org) {
  if (org.officers === undefined || org.officers === null || (Array.isArray(org.officers) && !org.officers.length)) {
    if (org.threshold !== undefined && org.threshold !== null) throw new Error(`${symbol}: threshold needs officers`);
    return { officers: [], threshold: null };
  }
  if (!Array.isArray(org.officers)) throw new Error(`${symbol}: officers must be a list of accounts`);
  if (org.pubkey) throw new Error(`${symbol}: an org has officers or its own pubkey, not both`);
  if (org.officers.length > MAX_OFFICERS) throw new Error(`${symbol}: at most ${MAX_OFFICERS} officers`);
  const officers = [];
  for (const value of org.officers) {
    const parsed = parseAccountKey(value);
    if (!parsed) throw new Error(`${symbol}: invalid officer account: ${value} (use discord:<id>)`);
    if (officers.includes(parsed.key)) throw new Error(`${symbol}: officer listed twice: ${value}`);
    officers.push(parsed.key);
  }
  let threshold = null;
  if (org.threshold !== undefined && org.threshold !== null) {
    threshold = Number(org.threshold);
    if (!Number.isInteger(threshold) || threshold < 1 || threshold > officers.length) {
      throw new Error(`${symbol}: threshold must be an integer from 1 to ${officers.length}`);
    }
  }
  return { officers, threshold };
}

/**
 * The alliance roster from `contracts/alliance.json`. Only an org's officers,
 * listed by account (`discord:<id>`), vote for it.
 * @param {Object} raw `{ name, network, publisher, csvBlocks?, organizations: [{ symbol, pubkey?, officers?, threshold?, guildId? }] }`
 * @returns {{ name: string, network, publisher, csvBlocks: number, organizations: Array<{ symbol: string, pubkey: string|null, officers: string[], threshold: number|null, guildId?: string }> }}
 */
function parseRoster (raw = {}) {
  const name = String(raw.name || '').trim();
  if (!name) throw new Error('alliance roster needs a name');
  const network = String(raw.network || '').trim().toLowerCase();
  if (!NETWORKS.includes(network)) throw new Error(`unknown network: ${raw.network}`);
  const organizations = [];
  for (const org of Array.isArray(raw.organizations) ? raw.organizations : []) {
    const symbol = String((org && org.symbol) || '').trim().toUpperCase();
    if (!SYMBOL_RE.test(symbol)) throw new Error(`invalid org symbol: ${org && org.symbol}`);
    if (organizations.some((o) => o.symbol === symbol)) throw new Error(`org listed twice: ${symbol}`);
    let pubkey = null;
    if (org.pubkey) {
      pubkey = compressedPubkey(org.pubkey);
      if (!pubkey) throw new Error(`${symbol}: pubkey must be a compressed secp256k1 key`);
    }
    const parsed = Object.assign({ symbol, pubkey }, parseOfficers(symbol, org));
    if (org.guildId !== undefined && org.guildId !== null && String(org.guildId).trim() !== '') {
      const guildId = String(org.guildId).trim();
      if (!/^\d{17,20}$/.test(guildId)) throw new Error(`${symbol}: guildId must be a Discord server id`);
      parsed.guildId = guildId;
    }
    organizations.push(parsed);
  }
  if (!organizations.length) throw new Error('alliance roster lists no organizations');
  const publisher = String(raw.publisher || '').trim().toUpperCase();
  if (!organizations.some((o) => o.symbol === publisher)) throw new Error('publisher must be one of the organizations');
  const csvBlocks = raw.csvBlocks != null ? Number(raw.csvBlocks) : DEFAULT_CSV_BLOCKS;
  return { name, network, publisher, csvBlocks, organizations };
}

/**
 * goon.vc's validator key for an org (hardened, so one org key never reveals
 * another). An org of officers gets a key per org federation, so its alliance
 * validator changes with its officers.
 * @param {string} xprv goon.vc's extended private key
 * @param {string} symbol
 * @param {string} [orgFederationId] the org's federation id, for an org of officers
 * @returns {Key}
 */
function orgKey (xprv, symbol, orgFederationId) {
  const seed = orgFederationId ? `PERMAFLEET:${symbol}:${orgFederationId}` : `PERMAFLEET:${symbol}`;
  const index = parseInt(sha256(seed).slice(0, 8), 16) & 0x7fffffff;
  return new Key({ xprv }).derive(`${ORG_KEY_PATH}/${index}'`);
}

/**
 * The key goon.vc signs with for one officer account: two hardened 31-bit
 * indexes from the account's hash, apart from the keys it holds for member
 * votes, so an officer's member vote can't be matched to their signature.
 * @param {string} xprv goon.vc's extended private key
 * @param {string} account `platform:id`
 * @returns {Key}
 */
function officerKey (xprv, account) {
  const parsed = parseAccountKey(account);
  if (!parsed) throw new Error('invalid officer account');
  const digest = sha256(`alliance-officer:${parsed.key}`);
  const a = parseInt(digest.slice(0, 8), 16) & 0x7fffffff;
  const b = parseInt(digest.slice(8, 16), 16) & 0x7fffffff;
  return new Key({ xprv }).derive(`${OFFICER_KEY_PATH}/${a}'/${b}'`);
}

/**
 * Threshold for a majority of the orgs.
 * @param {number} n
 * @returns {number}
 */
function majority (n) {
  return Math.floor(n / 2) + 1;
}

/**
 * An org's own federation of officers: the key goon.vc holds for each
 * officer account, a majority of them unless the roster sets `threshold`,
 * the alliance network, and the first listed officer as publisher.
 * @param {Object} roster {@link parseRoster} result
 * @param {Object} org one of `roster.organizations`, with officers
 * @param {string} xprv goon.vc's key
 * @returns {Object}
 */
function orgDescriptor (roster, org, xprv) {
  if (!org.officers || !org.officers.length) throw new Error(`${org.symbol} has no officers`);
  const pubkeys = org.officers.map((account) => officerKey(xprv, account).pubkey);
  return buildDescriptor({
    validators: pubkeys,
    threshold: org.threshold || majority(pubkeys.length),
    network: roster.network,
    publisher: pubkeys[0],
    csvBlocks: roster.csvBlocks
  });
}

/**
 * The alliance's validators: goon.vc's key for each org, unless the roster
 * gives the org's own pubkey. An org of officers gets goon.vc's key for its
 * org federation (`custody: 'officers'`), carried with that federation. An
 * org with neither has no officers on record (`custody: 'none'`): its seat
 * is counted, but nothing signs for it, so the org doesn't vote.
 * @param {Object} roster {@link parseRoster} result
 * @param {string|null} xprv goon.vc's key (null: only orgs with their own pubkey get one)
 * @returns {Array<{ symbol: string, pubkey: string, custody: string, key: Key|null, federation?: { id: string, descriptor: Object } }>}
 */
function validatorsFor (roster, xprv) {
  return roster.organizations.map((org) => {
    if (org.pubkey) return { symbol: org.symbol, pubkey: org.pubkey, custody: 'own', key: null };
    if (!xprv) throw new Error(`${org.symbol} has no pubkey and goon.vc has no key to derive one`);
    if (org.officers && org.officers.length) {
      const descriptor = orgDescriptor(roster, org, xprv);
      const id = descriptorId(descriptor);
      const key = orgKey(xprv, org.symbol, id);
      return { symbol: org.symbol, pubkey: key.pubkey, custody: 'officers', key, federation: { id, descriptor } };
    }
    const key = orgKey(xprv, org.symbol);
    return { symbol: org.symbol, pubkey: key.pubkey, custody: 'none', key };
  });
}

/**
 * Descriptor for a roster whose validators are known: one per org, majority threshold.
 * @param {Object} roster
 * @param {Array<{ symbol: string, pubkey: string }>} validators
 * @returns {Object}
 */
function allianceDescriptor (roster, validators) {
  const pubkeys = validators.map((v) => v.pubkey);
  if (new Set(pubkeys.map((pk) => pk.slice(2))).size !== pubkeys.length) throw new Error('two orgs share a validator key');
  return buildDescriptor({
    validators: pubkeys,
    threshold: majority(pubkeys.length),
    network: roster.network,
    publisher: validators.find((v) => v.symbol === roster.publisher).pubkey,
    csvBlocks: roster.csvBlocks
  });
}

/**
 * `FederationInvite` body (core `Federation.inviteMessage` shape), signed by the publisher.
 * @param {Object} descriptor
 * @param {string} name
 * @param {Array<{ symbol: string, pubkey: string }>} validators
 * @returns {Object}
 */
function inviteBody (descriptor, name, validators) {
  const id = descriptorId(descriptor);
  return {
    contract: id,
    type: MESSAGE_TYPES.invite,
    federationId: id,
    name,
    descriptor,
    members: descriptor.validators.map((pubkey) => {
      const v = validators.find((x) => x.pubkey === pubkey);
      return { pubkey, url: null, alias: v ? v.symbol : null };
    })
  };
}

/**
 * Proposal id: SHA-256 of the canonical proposal body.
 * @param {Object} body
 * @returns {string}
 */
function proposalId (body) {
  return sha256(stableStringify(body));
}

// An org of officers names its federation and carries the officer frames it rests on.
function withEndorsements (body, fields) {
  if (!fields.orgFederationId) return body;
  return Object.assign(body, { orgFederationId: fields.orgFederationId, endorsements: (fields.endorsements || []).slice() });
}

function proposalBody (federationId, fields) {
  return withEndorsements({
    contract: federationId,
    type: MESSAGE_TYPES.proposal,
    federationId,
    title: fields.title,
    summary: fields.summary,
    choices: CHOICES.slice(),
    proposer: fields.proposer,
    createdAt: fields.createdAt,
    closesAt: fields.closesAt
  }, fields);
}

function voteBody (federationId, fields) {
  return withEndorsements({
    contract: federationId,
    type: MESSAGE_TYPES.vote,
    federationId,
    proposalId: fields.proposalId,
    choice: fields.choice,
    castAt: fields.castAt
  }, fields);
}

/**
 * An officer's proposal, under their org's federation id.
 * @param {string} orgFederationId
 * @param {Object} fields `{ allianceFederationId, org, title, summary, proposer, createdAt, closesAt }`
 * @returns {Object}
 */
function officerProposalBody (orgFederationId, fields) {
  return {
    contract: orgFederationId,
    type: MESSAGE_TYPES.proposal,
    federationId: orgFederationId,
    allianceFederationId: fields.allianceFederationId,
    org: fields.org,
    title: fields.title,
    summary: fields.summary,
    choices: CHOICES.slice(),
    proposer: fields.proposer,
    createdAt: fields.createdAt,
    closesAt: fields.closesAt
  };
}

/**
 * An officer's vote for their org, under the org's federation id.
 * @param {string} orgFederationId
 * @param {Object} fields `{ allianceFederationId, org, proposalId, choice, castAt }`
 * @returns {Object}
 */
function officerVoteBody (orgFederationId, fields) {
  return {
    contract: orgFederationId,
    type: MESSAGE_TYPES.vote,
    federationId: orgFederationId,
    allianceFederationId: fields.allianceFederationId,
    org: fields.org,
    proposalId: fields.proposalId,
    choice: fields.choice,
    castAt: fields.castAt
  };
}

/**
 * A member's advisory vote, under the alliance federation id. Signed by the
 * key a Bridge holds for the member's account (with its `attestation`), or
 * by the member's own Fabric key (without one).
 * @param {string} federationId
 * @param {Object} fields `{ proposalId, choice, castAt, attestation? }`
 * @returns {Object}
 */
function memberVoteBody (federationId, fields) {
  const body = {
    contract: federationId,
    type: MESSAGE_TYPES.memberVote,
    federationId,
    proposalId: fields.proposalId,
    choice: fields.choice,
    castAt: fields.castAt
  };
  if (fields.attestation) body.attestation = fields.attestation;
  return body;
}

/**
 * Check a proposal or vote body for a federation; throws with the reason.
 * @param {Object} descriptor
 * @param {Object} body
 * @param {string} signer x-only
 * @param {Object<string, { symbol: string, descriptor: Object }>} [officerOrgs] org federations by
 *   the x-only validator key of each org of officers; their frames must carry enough endorsements
 * @returns {Array<{ id: string, signer: string, body: Object }>} the officer frames it rests on (none for other orgs)
 */
function verifyBody (descriptor, body, signer, officerOrgs = {}) {
  const id = descriptorId(descriptor);
  if (body.contract !== body.federationId) throw new Error('contract must be the federation id');
  if (body.federationId !== id) throw new Error('message is for another federation');
  if (!isValidator(descriptor, signer)) throw new Error('signer is not a member org');
  checkFields(body, signer);
  const org = officerOrgs[fabricPubkey(signer)];
  if (org) return verifyEndorsements(org.descriptor, body, org.symbol);
  if (body.endorsements !== undefined || body.orgFederationId !== undefined) throw new Error('only an org of officers carries endorsements');
  return [];
}

/**
 * Check an officer's proposal or vote under their org federation; throws with the reason.
 * @param {Object} orgDescriptor
 * @param {Object} body
 * @param {string} signer x-only
 */
function verifyOfficerBody (orgDescriptor, body, signer) {
  const id = descriptorId(orgDescriptor);
  if (body.contract !== body.federationId) throw new Error('contract must be the federation id');
  if (body.federationId !== id) throw new Error('message is for another org federation');
  if (!HASH_RE.test(String(body.allianceFederationId || ''))) throw new Error('officer message needs the alliance federation id');
  if (!SYMBOL_RE.test(String(body.org || ''))) throw new Error('officer message needs its org');
  if (!isValidator(orgDescriptor, signer)) throw new Error('signer is not an officer of this org');
  checkFields(body, signer);
}

const SAME_PROPOSAL = ['title', 'summary', 'createdAt', 'closesAt'];

/**
 * Check that an org's alliance frame rests on its officers: every endorsement
 * is a distinct officer's frame for the same proposal (or, for a proposal,
 * the same title, text, and window), with at least the org threshold of them
 * agreeing on a vote and at least one officer behind a proposal.
 * @param {Object} orgDescriptor
 * @param {Object} body the org's alliance proposal or vote body
 * @param {string} symbol the org
 * @returns {Array<{ id: string, signer: string, body: Object }>} the officer frames
 */
function verifyEndorsements (orgDescriptor, body, symbol) {
  if (body.orgFederationId !== descriptorId(orgDescriptor)) throw new Error(`${symbol} must name its org federation`);
  if (!Array.isArray(body.endorsements) || !body.endorsements.length) throw new Error(`${symbol} needs its officers' endorsements`);
  const seen = new Set();
  const opened = body.endorsements.map((frame) => {
    const endorsement = openFrame(frame);
    verifyOfficerBody(orgDescriptor, endorsement.body, endorsement.signer);
    const inner = endorsement.body;
    if (inner.org !== symbol) throw new Error('endorsement is for another org');
    if (inner.allianceFederationId !== body.federationId) throw new Error('endorsement is for another alliance federation');
    if (inner.type !== body.type) throw new Error('endorsement is a different kind of message');
    if (body.type === MESSAGE_TYPES.vote) {
      if (inner.proposalId !== body.proposalId) throw new Error('endorsement is for another proposal');
      if (inner.choice !== body.choice) throw new Error('endorsement is for another choice');
    } else if (SAME_PROPOSAL.some((field) => inner[field] !== body[field])) {
      throw new Error('endorsement is for another proposal');
    }
    if (seen.has(endorsement.signer)) throw new Error('an officer endorses twice');
    seen.add(endorsement.signer);
    return endorsement;
  });
  const needed = body.type === MESSAGE_TYPES.vote ? orgDescriptor.threshold : 1;
  if (opened.length < needed) throw new Error(`${symbol} needs ${needed} officers, has ${opened.length}`);
  return opened;
}

function checkFields (body, signer) {
  if (body.type === MESSAGE_TYPES.proposal) {
    if (fabricPubkey(body.proposer) !== signer) throw new Error('proposal is not signed by its proposer');
    if (typeof body.title !== 'string' || !body.title.trim()) throw new Error('proposal needs a title');
    if (stableStringify(body.choices) !== stableStringify(CHOICES)) throw new Error('proposal choices must be yes / no / abstain');
    const created = Date.parse(body.createdAt);
    const closes = Date.parse(body.closesAt);
    if (!Number.isFinite(created) || !Number.isFinite(closes) || closes <= created) throw new Error('proposal needs a voting window');
    return;
  }
  if (body.type === MESSAGE_TYPES.vote) {
    if (!HASH_RE.test(String(body.proposalId || ''))) throw new Error('vote needs a proposal id');
    if (!CHOICES.includes(body.choice)) throw new Error('vote must be yes, no, or abstain');
    if (!Number.isFinite(Date.parse(body.castAt))) throw new Error('vote needs a time');
    return;
  }
  throw new Error(`unknown message type: ${body.type}`);
}

/**
 * Check a member vote; throws with the reason. An attested vote must be
 * signed by the account key its Bridge attestation names.
 * @param {Object} descriptor alliance federation descriptor
 * @param {Object} bridgeDescriptor the Bridge this vote may be attested by
 * @param {Object} body
 * @param {string} signer x-only
 * @returns {{ attested: boolean, platform: string, attestation: Object|null }}
 */
function verifyMemberVote (descriptor, bridgeDescriptor, body, signer) {
  if (body.type !== MESSAGE_TYPES.memberVote) throw new Error('not a member vote');
  if (body.contract !== body.federationId) throw new Error('contract must be the federation id');
  if (body.federationId !== descriptorId(descriptor)) throw new Error('message is for another federation');
  if (!HASH_RE.test(String(body.proposalId || ''))) throw new Error('vote needs a proposal id');
  if (!CHOICES.includes(body.choice)) throw new Error('vote must be yes, no, or abstain');
  if (!Number.isFinite(Date.parse(body.castAt))) throw new Error('vote needs a time');
  if (body.attestation === undefined) return { attested: false, platform: 'fabric', attestation: null };
  if (!bridgeDescriptor) throw new Error('no Bridge to check the attestation against');
  const attestation = require('./bridgeAttestation').verifyAttestation(bridgeDescriptor, body.attestation);
  if (fabricPubkey(attestation.account) !== signer) throw new Error('vote is not signed by the attested account');
  return { attested: true, platform: attestation.platform, attestation };
}

/**
 * Count member votes: each member's latest choice.
 * @param {Array<{ member: string, choice: string }>} votes in the order they were accepted
 * @returns {{ yes: number, no: number, abstain: number, total: number, latest: Map<string, Object> }}
 */
function memberTally (votes) {
  const latest = new Map();
  for (const vote of votes) latest.set(vote.member, vote);
  const counts = { yes: 0, no: 0, abstain: 0 };
  for (const vote of latest.values()) counts[vote.choice] += 1;
  return Object.assign(counts, { total: latest.size, latest });
}

/**
 * Count a proposal: each org's latest vote, a majority of all orgs passes it.
 * @param {Object} descriptor
 * @param {Object} proposal proposal body
 * @param {Array<{ signer: string, choice: string }>} votes in the order they were accepted
 * @param {number} now ms
 * @returns {{ status: string, threshold: number, orgs: number, yes: number, no: number, abstain: number, waiting: number, choices: Object<string, string> }}
 */
function tally (descriptor, proposal, votes, now) {
  const choices = {};
  for (const vote of votes) {
    if (isValidator(descriptor, vote.signer)) choices[fabricPubkey(vote.signer)] = vote.choice;
  }
  const counted = Object.values(choices);
  const count = (choice) => counted.filter((c) => c === choice).length;
  const orgs = descriptor.validators.length;
  const yes = count('yes');
  const waiting = orgs - counted.length;
  let status = 'open';
  if (yes >= descriptor.threshold) status = 'passed';
  else if (yes + waiting < descriptor.threshold) status = 'failed';
  else if (now >= Date.parse(proposal.closesAt)) status = 'expired';
  return { status, threshold: descriptor.threshold, orgs, yes, no: count('no'), abstain: count('abstain'), waiting, choices };
}

/**
 * Count an org's officers: each officer's latest choice, and the choice that
 * reached the org threshold (the most recently backed one if a low threshold
 * lets two reach it).
 * @param {Object} orgDescriptor
 * @param {Array<{ signer: string, choice: string }>} votes in the order they were accepted
 * @returns {{ threshold: number, total: number, yes: number, no: number, abstain: number, waiting: number, choices: Object<string, string>, decided: string|null }}
 */
function orgTally (orgDescriptor, votes) {
  const latest = new Map();
  votes.forEach((vote, index) => {
    if (isValidator(orgDescriptor, vote.signer)) latest.set(fabricPubkey(vote.signer), { choice: vote.choice, index });
  });
  const counts = { yes: 0, no: 0, abstain: 0 };
  const lastIndex = {};
  const choices = {};
  for (const [signer, { choice, index }] of latest) {
    choices[signer] = choice;
    counts[choice] += 1;
    lastIndex[choice] = Math.max(lastIndex[choice] === undefined ? -1 : lastIndex[choice], index);
  }
  const reached = CHOICES.filter((choice) => counts[choice] >= orgDescriptor.threshold);
  reached.sort((a, b) => lastIndex[b] - lastIndex[a]);
  const total = orgDescriptor.validators.length;
  return Object.assign({ threshold: orgDescriptor.threshold, total }, counts, { waiting: total - latest.size, choices, decided: reached[0] || null });
}

module.exports = {
  CHOICES,
  DESCRIPTOR_TYPE,
  DESCRIPTOR_VERSION,
  MAX_OFFICERS,
  MESSAGE_TYPES,
  NETWORKS,
  OFFICER_KEY_PATH,
  ORG_KEY_PATH,
  allianceDescriptor,
  buildDescriptor,
  descriptorId,
  inviteBody,
  isValidator,
  majority,
  memberTally,
  memberVoteBody,
  officerKey,
  officerProposalBody,
  officerVoteBody,
  openFrame,
  orgDescriptor,
  orgKey,
  orgTally,
  parseRoster,
  proposalBody,
  proposalId,
  signFrame,
  tally,
  validatorsFor,
  verifyBody,
  verifyEndorsements,
  verifyMemberVote,
  verifyOfficerBody,
  voteBody
};
