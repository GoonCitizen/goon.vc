'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Key = require('@fabric/core/types/key');
const { stableStringify } = require('@fabric/core/functions/fabricCanonicalJson');
const Alliance = require('../services/alliance');
const federation = require('../functions/allianceFederation');
const bridgeAttestation = require('../functions/bridgeAttestation');

const SYMBOLS = ['G00N', 'INFN', 'TRDE', 'LCRP', 'DOUBLEDOGZ', '4MCONTRACT', 'AIMOS'];
const DAY = 24 * 60 * 60 * 1000;

function steward (symbol, n = 1) {
  return `discord:${100000 + SYMBOLS.indexOf(symbol) * 10 + n}`;
}

function member (symbol, n = 1) {
  return { id: `${symbol.toLowerCase()}${n}`.padEnd(16, '0').slice(0, 16), displayName: `${symbol} steward ${n}`, accounts: [{ key: steward(symbol, n) }] };
}

function roster (overrides = {}) {
  return Object.assign({
    name: 'PERMAFLEET',
    network: 'mainnet',
    publisher: 'G00N',
    organizations: SYMBOLS.map((symbol) => ({ symbol, stewards: [steward(symbol, 1), steward(symbol, 2)] }))
  }, overrides);
}

// INFN decides by its officers; everyone else by stewards.
function officerRoster (keys, extra = {}) {
  const json = roster();
  const infn = json.organizations.find((org) => org.symbol === 'INFN');
  infn.officers = keys.map((key, i) => (i % 2 ? key.pubkey : `fabric:${key.pubkey.slice(2)}`));
  Object.assign(infn, extra);
  return json;
}

function route (service, method, url, { body = {}, as = null } = {}) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader () {},
      end (payload) { resolve({ status: this.statusCode, body: JSON.parse(payload) }); }
    };
    service.middleware()({ method, url, path: url.split('?')[0], body, member: as }, res, () => resolve({ status: 'next' }));
  });
}

describe('alliance federation', function () {
  const xprv = new Key().xprv;

  it('derives one stable, distinct key per org', function () {
    const a = federation.orgKey(xprv, 'G00N').pubkey;
    assert.strictEqual(federation.orgKey(xprv, 'G00N').pubkey, a);
    const all = SYMBOLS.map((symbol) => federation.orgKey(xprv, symbol).pubkey);
    assert.strictEqual(new Set(all).size, SYMBOLS.length);
    assert.notStrictEqual(federation.orgKey(new Key().xprv, 'G00N').pubkey, a);
  });

  it('builds a core FabricFederationDescriptor with a majority threshold', function () {
    const parsed = federation.parseRoster(roster());
    const validators = federation.validatorsFor(parsed, xprv);
    const descriptor = federation.allianceDescriptor(parsed, validators);
    assert.strictEqual(descriptor.type, 'FabricFederationDescriptor');
    assert.strictEqual(descriptor.version, 1);
    assert.strictEqual(descriptor.threshold, 4);
    assert.strictEqual(descriptor.validators.length, 7);
    assert.deepStrictEqual(descriptor.validators, descriptor.validators.slice().sort());
    assert.strictEqual(descriptor.publisher, validators[0].pubkey);
    const id = crypto.createHash('sha256').update(stableStringify(descriptor), 'utf8').digest('hex');
    assert.strictEqual(federation.descriptorId(descriptor), id);
  });

  it('matches @fabric/core Federation.buildDescriptor where core has it', function () {
    const core = process.env.FABRIC_CORE || path.resolve(__dirname, '../../fabric-clean');
    let Federation;
    try {
      Federation = require(path.join(core, 'types/federation'));
    } catch (_) {
      return this.skip();
    }
    if (typeof Federation.buildDescriptor !== 'function') return this.skip();
    const parsed = federation.parseRoster(roster());
    const validators = federation.validatorsFor(parsed, xprv);
    const opts = { validators: validators.map((v) => v.pubkey).reverse(), threshold: 4, network: 'mainnet', publisher: validators[0].pubkey };
    const ours = federation.allianceDescriptor(parsed, validators);
    assert.deepStrictEqual(ours, Federation.buildDescriptor(opts));
    assert.strictEqual(federation.descriptorId(ours), Federation.descriptorId(Federation.buildDescriptor(opts)));
  });

  it('refuses rosters with bad symbols, duplicate orgs, or an outside publisher', function () {
    assert.throws(() => federation.parseRoster(roster({ publisher: 'NOPE' })), /publisher/);
    assert.throws(() => federation.parseRoster(roster({ organizations: [{ symbol: 'G00N' }, { symbol: 'g00n' }] })), /twice/);
    assert.throws(() => federation.parseRoster(roster({ organizations: [{ symbol: 'G00N', stewards: ['nope'] }] })), /steward/);
  });

  it('counts the latest vote per org and a majority of all orgs', function () {
    const parsed = federation.parseRoster(roster());
    const validators = federation.validatorsFor(parsed, xprv);
    const descriptor = federation.allianceDescriptor(parsed, validators);
    const x = (i) => validators[i].pubkey.slice(2);
    const proposal = { closesAt: new Date(10 * DAY).toISOString() };
    const votes = [{ signer: x(0), choice: 'no' }, { signer: x(0), choice: 'yes' }, { signer: x(1), choice: 'yes' }, { signer: x(2), choice: 'abstain' }];
    let counted = federation.tally(descriptor, proposal, votes, 0);
    assert.deepStrictEqual([counted.status, counted.yes, counted.abstain, counted.waiting], ['open', 2, 1, 4]);
    counted = federation.tally(descriptor, proposal, votes.concat({ signer: x(3), choice: 'yes' }, { signer: x(4), choice: 'yes' }), 0);
    assert.strictEqual(counted.status, 'passed');
    counted = federation.tally(descriptor, proposal, votes.concat({ signer: x(3), choice: 'no' }, { signer: x(4), choice: 'no' }), 0);
    assert.strictEqual(counted.status, 'open', '2 yes + 2 waiting can still reach 4');
    counted = federation.tally(descriptor, proposal, votes.concat({ signer: x(3), choice: 'no' }, { signer: x(4), choice: 'no' }, { signer: x(5), choice: 'no' }), 0);
    assert.strictEqual(counted.status, 'failed', '2 yes + 1 waiting cannot reach 4');
    assert.strictEqual(federation.tally(descriptor, proposal, votes, 11 * DAY).status, 'expired');
    assert.strictEqual(federation.tally(descriptor, proposal, [{ signer: new Key().pubkey.slice(2), choice: 'yes' }], 0).yes, 0, 'outsiders are not counted');
  });

  it('builds an org federation of officers and ties the org key to it', function () {
    const officers = [new Key(), new Key(), new Key()];
    const withOfficers = (keys, extra = {}) => federation.parseRoster(officerRoster(keys, extra));
    const parsed = withOfficers(officers);
    const infn = parsed.organizations.find((org) => org.symbol === 'INFN');
    const descriptor = federation.orgDescriptor(parsed, infn);
    assert.strictEqual(descriptor.type, 'FabricFederationDescriptor');
    assert.strictEqual(descriptor.threshold, 2);
    assert.deepStrictEqual(descriptor.validators.map((v) => v.slice(2)).sort(), officers.map((k) => k.pubkey.slice(2)).sort());
    const validators = federation.validatorsFor(parsed, xprv);
    const entry = validators.find((v) => v.symbol === 'INFN');
    assert.strictEqual(entry.custody, 'officers');
    assert.strictEqual(entry.federation.id, federation.descriptorId(descriptor));
    assert.strictEqual(entry.pubkey, federation.orgKey(xprv, 'INFN', entry.federation.id).pubkey);
    assert.notStrictEqual(entry.pubkey, federation.orgKey(xprv, 'INFN').pubkey);
    const allianceId = federation.descriptorId(federation.allianceDescriptor(parsed, validators));
    const swapped = withOfficers([officers[0], officers[1], new Key()]);
    const swappedValidators = federation.validatorsFor(swapped, xprv);
    assert.notStrictEqual(swappedValidators.find((v) => v.symbol === 'INFN').pubkey, entry.pubkey);
    assert.notStrictEqual(federation.descriptorId(federation.allianceDescriptor(swapped, swappedValidators)), allianceId);
    const stricter = withOfficers(officers, { threshold: 3 });
    assert.strictEqual(federation.orgDescriptor(stricter, stricter.organizations.find((org) => org.symbol === 'INFN')).threshold, 3);
    assert.notStrictEqual(federation.validatorsFor(stricter, xprv).find((v) => v.symbol === 'INFN').pubkey, entry.pubkey);
  });

  it('refuses bad officer lists', function () {
    const k = new Key();
    const bad = (org) => () => federation.parseRoster(roster({ organizations: [Object.assign({ symbol: 'G00N' }, org)] }));
    assert.throws(bad({ officers: [`fabric:${k.pubkey.slice(2)}`], pubkey: new Key().pubkey }), /not both/);
    assert.throws(bad({ officers: [k.pubkey], threshold: 2 }), /threshold/);
    assert.throws(bad({ officers: [k.pubkey, `fabric:${k.pubkey.slice(2)}`] }), /twice/);
    assert.throws(bad({ threshold: 1 }), /threshold needs officers/);
    assert.throws(bad({ officers: ['discord:123456789012345678'] }), /invalid officer/);
    assert.throws(bad({ officers: Array.from({ length: federation.MAX_OFFICERS + 1 }, () => new Key().pubkey) }), /at most/);
  });

  it('counts officers and checks the endorsements an org vote rests on', function () {
    const officers = [new Key(), new Key(), new Key()];
    const parsed = federation.parseRoster(officerRoster(officers));
    const validators = federation.validatorsFor(parsed, xprv);
    const alliance = federation.allianceDescriptor(parsed, validators);
    const allianceId = federation.descriptorId(alliance);
    const entry = validators.find((v) => v.symbol === 'INFN');
    const orgId = entry.federation.id;
    const proposalId = 'a'.repeat(64);
    const officerVote = (key, choice, org = 'INFN') => federation.signFrame(federation.officerVoteBody(orgId, {
      allianceFederationId: allianceId, org, proposalId, choice, castAt: new Date(0).toISOString()
    }), key).frame;
    const x = (key) => key.pubkey.slice(2);
    let counted = federation.orgTally(entry.federation.descriptor, [{ signer: x(officers[0]), choice: 'yes' }, { signer: x(officers[1]), choice: 'no' }]);
    assert.deepStrictEqual([counted.yes, counted.no, counted.waiting, counted.decided], [1, 1, 1, null]);
    counted = federation.orgTally(entry.federation.descriptor, [{ signer: x(officers[0]), choice: 'yes' }, { signer: x(officers[1]), choice: 'no' }, { signer: x(officers[1]), choice: 'yes' }]);
    assert.strictEqual(counted.decided, 'yes');
    assert.strictEqual(federation.orgTally(entry.federation.descriptor, [{ signer: x(new Key()), choice: 'yes' }]).yes, 0, 'outsiders are not counted');
    const outer = (endorsements, choice = 'yes') => federation.voteBody(allianceId, { proposalId, choice, castAt: new Date(0).toISOString(), orgFederationId: orgId, endorsements });
    const officerOrgs = { [entry.pubkey.slice(2)]: { symbol: 'INFN', descriptor: entry.federation.descriptor } };
    const signer = entry.pubkey.slice(2);
    const good = outer([officerVote(officers[0], 'yes'), officerVote(officers[2], 'yes')]);
    assert.strictEqual(federation.verifyBody(alliance, good, signer, officerOrgs).length, 2);
    assert.throws(() => federation.verifyBody(alliance, outer([officerVote(officers[0], 'yes')]), signer, officerOrgs), /needs 2 officers/);
    assert.throws(() => federation.verifyBody(alliance, outer([officerVote(officers[0], 'yes'), officerVote(officers[0], 'yes')]), signer, officerOrgs), /twice/);
    assert.throws(() => federation.verifyBody(alliance, outer([officerVote(officers[0], 'yes'), officerVote(officers[1], 'no')]), signer, officerOrgs), /another choice/);
    assert.throws(() => federation.verifyBody(alliance, outer([officerVote(officers[0], 'yes'), officerVote(new Key(), 'yes')]), signer, officerOrgs), /not an officer/);
    assert.throws(() => federation.verifyBody(alliance, outer([officerVote(officers[0], 'yes', 'TRDE'), officerVote(officers[1], 'yes', 'TRDE')]), signer, officerOrgs), /another org/);
    assert.throws(() => federation.verifyBody(alliance, good, signer, {}), /only an org of officers/);
  });

  describe('Bridge attestations and member votes', function () {
    const bridge = bridgeAttestation.bridgeDescriptor({ name: 'G00N SQUAD Discord', origin: 'https://goon.vc/', platforms: ['fabric', 'discord'], pubkey: bridgeAttestation.bridgeKey(xprv).pubkey });
    const parsed = federation.parseRoster(roster());
    const alliance = federation.allianceDescriptor(parsed, federation.validatorsFor(parsed, xprv));
    const allianceId = federation.descriptorId(alliance);
    const proposalId = 'b'.repeat(64);
    const at = new Date(0).toISOString();

    it('derives one stable key per account that does not reveal the account', function () {
      const a = bridgeAttestation.accountKey(xprv, 'discord:200000000000000001').pubkey;
      assert.strictEqual(bridgeAttestation.accountKey(xprv, 'discord:200000000000000001').pubkey, a);
      assert.notStrictEqual(bridgeAttestation.accountKey(xprv, 'discord:200000000000000002').pubkey, a);
      assert.notStrictEqual(bridgeAttestation.accountKey(new Key().xprv, 'discord:200000000000000001').pubkey, a, 'only goon.vc’s key makes it');
      assert.notStrictEqual(bridgeAttestation.accountKey(xprv, 'fabric:' + 'ab'.repeat(32)).pubkey, a);
      assert.throws(() => bridgeAttestation.accountKey(xprv, 'nope'), /invalid account/);
      assert.deepStrictEqual(bridge.platforms, ['discord', 'fabric']);
      assert.strictEqual(bridge.origin, 'https://goon.vc');
    });

    it('verifies attestations from this Bridge only', function () {
      const made = bridgeAttestation.attest(xprv, bridge, 'discord:200000000000000001', at);
      const checked = bridgeAttestation.verifyAttestation(bridge, made.frame);
      assert.deepStrictEqual([checked.platform, checked.account], ['discord', made.pubkey]);
      const body = federation.openFrame(made.frame).body;
      assert.ok(!JSON.stringify(body).includes('200000000000000001'), 'no account id in the attestation');
      assert.throws(() => bridgeAttestation.attest(xprv, bridgeAttestation.bridgeDescriptor(Object.assign({}, bridge, { platforms: ['fabric'] })), 'discord:200000000000000001', at), /does not attest discord/);
      const forged = federation.signFrame(body, new Key()).frame;
      assert.throws(() => bridgeAttestation.verifyAttestation(bridge, forged), /not signed by this Bridge/);
      const elsewhere = bridgeAttestation.bridgeDescriptor(Object.assign({}, bridge, { origin: 'https://example.com' }));
      assert.throws(() => bridgeAttestation.verifyAttestation(elsewhere, made.frame), /another Bridge/);
    });

    it('checks member votes: attested by the account key, or self-signed', function () {
      const made = bridgeAttestation.attest(xprv, bridge, 'discord:200000000000000001', at);
      const body = federation.memberVoteBody(allianceId, { proposalId, choice: 'yes', castAt: at, attestation: made.frame });
      const x = made.pubkey.slice(2);
      assert.deepStrictEqual(federation.verifyMemberVote(alliance, bridge, body, x).platform, 'discord');
      assert.throws(() => federation.verifyMemberVote(alliance, bridge, body, new Key().pubkey.slice(2)), /not signed by the attested account/);
      assert.throws(() => federation.verifyMemberVote(alliance, bridge, Object.assign({}, body, { federationId: 'c'.repeat(64), contract: 'c'.repeat(64) }), x), /another federation/);
      assert.throws(() => federation.verifyMemberVote(alliance, bridge, Object.assign({}, body, { choice: 'maybe' }), x), /yes, no, or abstain/);
      const own = federation.memberVoteBody(allianceId, { proposalId, choice: 'no', castAt: at });
      assert.deepStrictEqual(federation.verifyMemberVote(alliance, bridge, own, new Key().pubkey.slice(2)), { attested: false, platform: 'fabric', attestation: null });
    });

    it('counts the latest vote per member', function () {
      const counted = federation.memberTally([
        { member: 'a', choice: 'yes' }, { member: 'b', choice: 'no' }, { member: 'a', choice: 'abstain' }, { member: 'c', choice: 'yes' }
      ]);
      assert.deepStrictEqual([counted.yes, counted.no, counted.abstain, counted.total], [1, 1, 1, 3]);
    });
  });
});

describe('Alliance service', function () {
  let dir;
  let clock;
  let xprv;
  let service;
  const names = {};
  const members = {
    currentMember: async (req) => (req.member ? { member: req.member } : null),
    resolve: async (key) => (names[key] ? { displayName: names[key] } : null)
  };

  async function open (rosterJson, extra = {}) {
    if (service) await service.stop();
    fs.writeFileSync(path.join(dir, 'alliance.json'), JSON.stringify(rosterJson));
    service = new Alliance(Object.assign({
      path: path.join(dir, 'store'),
      file: path.join(dir, 'alliance.json'),
      xprv,
      members,
      now: () => clock
    }, extra));
    await service.start();
    return service;
  }

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goon-alliance-'));
    clock = Date.parse('2026-10-25T12:00:00Z');
    xprv = new Key().xprv;
    service = null;
    await open(roster());
  });

  afterEach(async function () {
    if (service) await service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the federation, its orgs, and who is asking, without account ids', async function () {
    const anon = await route(service, 'GET', '/services/alliance');
    assert.strictEqual(anon.status, 200);
    assert.strictEqual(anon.body.status, 'ready');
    assert.strictEqual(anon.body.federation.threshold, 4);
    assert.strictEqual(anon.body.federation.organizations.length, 7);
    assert.strictEqual(anon.body.federation.organizations[0].stewards, 2);
    assert.deepStrictEqual(anon.body.you, { signedIn: false, organizations: [], officers: [] });
    assert.ok(!JSON.stringify(anon.body).includes('discord:'), 'no steward account keys');
    const invite = federation.openFrame(anon.body.federation.invite);
    assert.strictEqual(invite.body.type, 'FederationInvite');
    assert.strictEqual(invite.signer, anon.body.federation.descriptor.publisher.slice(2));
    const signed = await route(service, 'GET', '/services/alliance', { as: member('TRDE') });
    assert.deepStrictEqual(signed.body.you, { signedIn: true, organizations: ['TRDE'], officers: [] });
  });

  it('lets only stewards propose, signed with their org key', async function () {
    const body = { title: 'Adopt the PERMAFLEET charter', summary: 'Text in #alliance.', days: 3 };
    assert.strictEqual((await route(service, 'POST', '/services/alliance/proposals', { body })).status, 401);
    const outsider = { id: 'aaaaaaaaaaaaaaaa', displayName: 'Rando', accounts: [{ key: 'discord:999999' }] };
    assert.strictEqual((await route(service, 'POST', '/services/alliance/proposals', { body, as: outsider })).status, 403);
    const made = await route(service, 'POST', '/services/alliance/proposals', { body, as: member('INFN') });
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.proposer.symbol, 'INFN');
    assert.strictEqual(made.body.by, 'INFN steward 1');
    assert.strictEqual(made.body.status, 'open');
    assert.strictEqual(Date.parse(made.body.closesAt) - clock, 3 * DAY);
    const opened = federation.openFrame(made.body.frame);
    assert.strictEqual(opened.body.type, 'FederationProposal');
    assert.strictEqual(opened.signer, federation.orgKey(xprv, 'INFN').pubkey.slice(2));
    assert.strictEqual(federation.proposalId(opened.body), made.body.id);
    const short = await route(service, 'GET', `/services/alliance/proposals/${made.body.shortId}`);
    assert.strictEqual(short.body.id, made.body.id);
    assert.ok(!('member' in short.body) && !JSON.stringify(short.body).includes('discord:'));
  });

  it('gives each org one vote, passes on a majority, then closes', async function () {
    const made = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Joint op on Saturday' }, as: member('G00N') })).body;
    const vote = (symbol, choice, n = 1) => route(service, 'POST', `/services/alliance/proposals/${made.id}/votes`, { body: { choice }, as: member(symbol, n) });
    assert.strictEqual((await vote('G00N', 'yes')).status, 200);
    const changed = await vote('G00N', 'no', 2);
    assert.strictEqual(changed.body.tally.yes, 0);
    assert.strictEqual(changed.body.tally.no, 1, 'a second steward changes the org vote, not adds one');
    assert.strictEqual(changed.body.votes.length, 2);
    assert.strictEqual(changed.body.organizations.find((org) => org.symbol === 'G00N').by, 'G00N steward 2');
    assert.strictEqual((await vote('G00N', 'maybe')).status, 400);
    await vote('G00N', 'yes');
    await vote('INFN', 'yes');
    await vote('TRDE', 'abstain');
    const third = await vote('LCRP', 'yes');
    assert.strictEqual(third.body.status, 'open');
    const passed = await vote('AIMOS', 'yes');
    assert.strictEqual(passed.body.status, 'passed');
    assert.deepStrictEqual([passed.body.tally.yes, passed.body.tally.waiting, passed.body.tally.threshold], [4, 2, 4]);
    const late = await vote('4MCONTRACT', 'no');
    assert.strictEqual(late.status, 409);
    for (const row of passed.body.votes) {
      const opened = federation.openFrame(row.frame);
      assert.strictEqual(opened.body.proposalId, made.id);
      assert.strictEqual(opened.signer, federation.orgKey(xprv, row.org).pubkey.slice(2));
    }
    const listed = await route(service, 'GET', '/services/alliance/proposals');
    assert.strictEqual(listed.body.proposals[0].status, 'passed');
  });

  it('fails a proposal that can no longer pass, and expires one at its deadline', async function () {
    const doomed = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Rename the fleet' }, as: member('G00N') })).body;
    for (const symbol of ['G00N', 'INFN', 'TRDE']) await route(service, 'POST', `/services/alliance/proposals/${doomed.id}/votes`, { body: { choice: 'no' }, as: member(symbol) });
    const failed = await route(service, 'POST', `/services/alliance/proposals/${doomed.id}/votes`, { body: { choice: 'no' }, as: member('LCRP') });
    assert.strictEqual(failed.body.status, 'failed');
    const slow = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Slow one', days: 1 }, as: member('G00N') })).body;
    clock += DAY + 1;
    assert.strictEqual((await route(service, 'GET', `/services/alliance/proposals/${slow.id}`)).body.status, 'expired');
    assert.strictEqual((await route(service, 'POST', `/services/alliance/proposals/${slow.id}/votes`, { body: { choice: 'yes' }, as: member('G00N') })).status, 409);
  });

  it('accepts frames from an org that holds its own key and refuses forgeries', async function () {
    const own = new Key();
    const rosterJson = roster();
    rosterJson.organizations.find((org) => org.symbol === 'TRDE').pubkey = own.pubkey;
    await open(rosterJson);
    const overview = (await route(service, 'GET', '/services/alliance')).body;
    assert.strictEqual(overview.federation.organizations.find((org) => org.symbol === 'TRDE').custody, 'own');
    const made = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Shared hangar' }, as: member('G00N') })).body;
    const refused = await route(service, 'POST', `/services/alliance/proposals/${made.id}/votes`, { body: { choice: 'yes' }, as: member('TRDE') });
    assert.strictEqual(refused.status, 409);
    const body = federation.voteBody(overview.federation.id, { proposalId: made.id, choice: 'yes', castAt: new Date(clock).toISOString() });
    const accepted = await route(service, 'POST', '/services/alliance/messages', { body: { frame: federation.signFrame(body, own).frame } });
    assert.strictEqual(accepted.status, 200);
    assert.strictEqual(accepted.body.organizations.find((org) => org.symbol === 'TRDE').choice, 'yes');
    clock += 1000;
    const no = federation.voteBody(overview.federation.id, { proposalId: made.id, choice: 'no', castAt: new Date(clock).toISOString() });
    assert.strictEqual((await route(service, 'POST', '/services/alliance/messages', { body: { frame: federation.signFrame(no, own).frame } })).body.tally.no, 1);
    const replay = await route(service, 'POST', '/services/alliance/messages', { body: { frame: federation.signFrame(body, own).frame } });
    assert.strictEqual(replay.body.organizations.find((org) => org.symbol === 'TRDE').choice, 'no', 'replaying an older vote changes nothing');
    const stale = federation.voteBody(overview.federation.id, { proposalId: made.id, choice: 'abstain', castAt: new Date(clock - 500).toISOString() });
    assert.strictEqual((await route(service, 'POST', '/services/alliance/messages', { body: { frame: federation.signFrame(stale, own).frame } })).status, 409);
    const forged = await route(service, 'POST', '/services/alliance/messages', { body: { frame: federation.signFrame(body, new Key()).frame } });
    assert.strictEqual(forged.status, 403);
    const tampered = federation.signFrame(body, own).frame.replace(/7965/, '6e6f');
    assert.ok([400, 403].includes((await route(service, 'POST', '/services/alliance/messages', { body: { frame: tampered } })).status));
  });

  it('starts a new federation when the roster changes, keeping old proposals with theirs', async function () {
    const first = (await route(service, 'GET', '/services/alliance')).body.federation.id;
    const made = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Before the new org' }, as: member('G00N') })).body;
    const rosterJson = roster();
    rosterJson.organizations.push({ symbol: 'NEWORG', stewards: ['discord:555555'] });
    await open(rosterJson);
    const now = (await route(service, 'GET', '/services/alliance')).body;
    assert.notStrictEqual(now.federation.id, first);
    assert.strictEqual(now.federation.threshold, 5);
    const old = (await route(service, 'GET', `/services/alliance/proposals/${made.id}`)).body;
    assert.strictEqual(old.federationId, first);
    assert.strictEqual(old.current, false);
    assert.strictEqual(old.organizations.length, 7);
    const newcomer = { id: 'bbbbbbbbbbbbbbbb', displayName: 'New', accounts: [{ key: 'discord:555555' }] };
    assert.strictEqual((await route(service, 'POST', `/services/alliance/proposals/${made.id}/votes`, { body: { choice: 'yes' }, as: newcomer })).status, 403);
    assert.strictEqual((await route(service, 'POST', `/services/alliance/proposals/${made.id}/votes`, { body: { choice: 'yes' }, as: member('G00N') })).status, 200);
  });

  it('turns itself off on a broken roster instead of failing the site', async function () {
    const errors = [];
    fs.writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ name: 'PERMAFLEET', network: 'mainnet', publisher: 'X', organizations: [] }));
    await service.stop();
    service = new Alliance({ path: path.join(dir, 'store2'), file: path.join(dir, 'broken.json'), xprv, members });
    service.on('error', (...parts) => errors.push(parts.join(' ')));
    await service.start();
    assert.strictEqual((await route(service, 'GET', '/services/alliance')).body.status, 'unconfigured');
    assert.strictEqual((await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'x' }, as: member('G00N') })).status, 503);
    assert.ok(errors.length);
  });

  describe('an org of officers', function () {
    let officers;
    let overview;
    let infn;

    const post = (frame) => route(service, 'POST', '/services/alliance/messages', { body: { frame } });
    const iso = () => new Date(clock).toISOString();
    const officerVote = (key, proposal, choice, fields = {}) => federation.signFrame(federation.officerVoteBody(infn.federation.id, Object.assign({
      allianceFederationId: overview.federation.id, org: 'INFN', proposalId: proposal.id, choice, castAt: iso()
    }, fields)), key).frame;

    beforeEach(async function () {
      officers = [new Key(), new Key(), new Key()];
      names[`fabric:${officers[0].pubkey.slice(2)}`] = 'Ada';
      await open(officerRoster(officers));
      overview = (await route(service, 'GET', '/services/alliance')).body;
      infn = overview.federation.organizations.find((org) => org.symbol === 'INFN');
    });

    it('serves the org federation and who among the signed-in members is an officer', async function () {
      assert.strictEqual(infn.custody, 'officers');
      assert.deepStrictEqual([infn.federation.threshold, infn.federation.officers], [2, 3]);
      assert.strictEqual(federation.descriptorId(infn.federation.descriptor), infn.federation.id);
      assert.strictEqual(infn.pubkey, federation.orgKey(xprv, 'INFN', infn.federation.id).pubkey);
      const officer = { id: 'cccccccccccccccc', displayName: 'Ada', accounts: [{ key: `fabric:${officers[0].pubkey.slice(2)}` }] };
      assert.deepStrictEqual((await route(service, 'GET', '/services/alliance', { as: officer })).body.you.officers, ['INFN']);
    });

    it('votes for the org once enough officers agree, and follows them when they change', async function () {
      const made = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Joint op' }, as: member('G00N') })).body;
      const orgOf = (view) => view.organizations.find((org) => org.symbol === 'INFN');
      let res = await post(officerVote(officers[0], made, 'yes'));
      assert.strictEqual(res.status, 200);
      assert.strictEqual(orgOf(res.body).choice, null, 'one officer of three is not enough');
      assert.deepStrictEqual(orgOf(res.body).officers, { threshold: 2, total: 3, yes: 1, no: 0, abstain: 0, waiting: 2 });
      assert.strictEqual(res.body.officerVotes[0].by, 'Ada');
      clock += 1000;
      res = await post(officerVote(officers[1], made, 'yes'));
      assert.strictEqual(orgOf(res.body).choice, 'yes');
      assert.strictEqual(res.body.tally.yes, 1);
      const vote = res.body.votes.find((row) => row.org === 'INFN');
      const opened = federation.openFrame(vote.frame);
      assert.strictEqual(opened.signer, infn.pubkey.slice(2), 'the org key signs the alliance vote');
      assert.strictEqual(opened.body.orgFederationId, infn.federation.id);
      assert.deepStrictEqual(opened.body.endorsements.map((frame) => federation.openFrame(frame).signer).sort(), [officers[0], officers[1]].map((k) => k.pubkey.slice(2)).sort());
      assert.strictEqual(vote.endorsements.length, 2);
      assert.match(vote.by, /Ada/);
      clock += 1000;
      res = await post(officerVote(officers[0], made, 'no'));
      assert.strictEqual(orgOf(res.body).choice, 'yes', 'losing quorum keeps the last org vote');
      clock += 1000;
      res = await post(officerVote(officers[2], made, 'no'));
      assert.strictEqual(orgOf(res.body).choice, 'no');
      assert.deepStrictEqual([res.body.tally.yes, res.body.tally.no], [0, 1]);
      assert.strictEqual(res.body.votes.filter((row) => row.org === 'INFN').length, 2);
      assert.strictEqual(res.body.officerVotes.length, 4);
      assert.ok(!JSON.stringify(res.body).includes('discord:'), 'no steward account keys');
      assert.strictEqual((await post(officerVote(officers[2], made, 'yes', { castAt: new Date(clock - 500).toISOString() }))).status, 409, 'an older officer vote cannot replace a newer one');
    });

    it('refuses outsiders, mismatched frames, short endorsements, and steward buttons', async function () {
      const made = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Shared hangar' }, as: member('G00N') })).body;
      assert.strictEqual((await post(officerVote(new Key(), made, 'yes'))).status, 403);
      assert.strictEqual((await post(officerVote(officers[0], made, 'yes', { org: 'TRDE' }))).status, 403);
      assert.strictEqual((await post(officerVote(officers[0], made, 'yes', { proposalId: 'b'.repeat(64) }))).status, 404);
      assert.strictEqual((await post(officerVote(officers[0], made, 'yes', { allianceFederationId: 'c'.repeat(64) }))).status, 404);
      const short = federation.voteBody(overview.federation.id, {
        proposalId: made.id, choice: 'yes', castAt: iso(), orgFederationId: infn.federation.id, endorsements: [officerVote(officers[0], made, 'yes')]
      });
      const forced = await post(federation.signFrame(short, federation.orgKey(xprv, 'INFN', infn.federation.id)).frame);
      assert.strictEqual(forced.status, 403);
      assert.match(forced.body.error, /needs 2 officers/);
      const steward = await route(service, 'POST', `/services/alliance/proposals/${made.id}/votes`, { body: { choice: 'yes' }, as: member('INFN') });
      assert.strictEqual(steward.status, 409);
      assert.match(steward.body.error, /officers/);
      assert.strictEqual((await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Steward try' }, as: member('INFN') })).status, 409);
    });

    it('wraps an officer proposal into the org proposal, once', async function () {
      const body = federation.officerProposalBody(infn.federation.id, {
        allianceFederationId: overview.federation.id,
        org: 'INFN',
        title: 'Adopt the charter',
        summary: 'Text in #alliance.',
        proposer: officers[0].pubkey,
        createdAt: iso(),
        closesAt: new Date(clock + 3 * DAY).toISOString()
      });
      const frame = federation.signFrame(body, officers[0]).frame;
      const made = await post(frame);
      assert.strictEqual(made.status, 200);
      assert.strictEqual(made.body.proposer.symbol, 'INFN');
      assert.strictEqual(made.body.by, 'Ada');
      assert.strictEqual(made.body.endorsements.length, 1);
      const opened = federation.openFrame(made.body.frame);
      assert.strictEqual(opened.signer, infn.pubkey.slice(2));
      assert.strictEqual(federation.openFrame(opened.body.endorsements[0]).signer, officers[0].pubkey.slice(2));
      assert.strictEqual((await post(frame)).body.id, made.body.id);
      assert.strictEqual((await route(service, 'GET', '/services/alliance/proposals')).body.proposals.length, 1);
      assert.strictEqual(made.body.orgFederations[0].id, infn.federation.id);
      const outsider = federation.signFrame(Object.assign({}, body, { proposer: new Key().pubkey }), new Key()).frame;
      assert.strictEqual((await post(outsider)).status, 403);
    });

    it('lists every alliance and org federation, current first, with their pages', async function () {
      const list = (await route(service, 'GET', '/services/alliance/federations')).body.federations;
      assert.deepStrictEqual(list.map((row) => [row.kind, row.current]), [['alliance', true], ['organization', true], ['alliance', false]], 'the roster before INFN named officers is retired');
      assert.strictEqual(list[0].id, overview.federation.id);
      assert.strictEqual(list[0].path, `/federations/${overview.federation.id.slice(0, 12)}`);
      assert.strictEqual(overview.federation.path, list[0].path);
      assert.strictEqual(list[1].id, infn.federation.id);
      assert.strictEqual(infn.federation.path, list[1].path);
      assert.deepStrictEqual([list[1].symbol, list[1].threshold, list[1].members], ['INFN', 2, 3]);

      const alliance = (await route(service, 'GET', `/services/alliance/federations/${list[0].shortId}`)).body;
      assert.deepStrictEqual(alliance.descriptor, overview.federation.descriptor);
      assert.strictEqual(federation.openFrame(alliance.invite).body.type, 'FederationInvite');
      assert.strictEqual(alliance.organizations.find((org) => org.symbol === 'INFN').federation.path, list[1].path);
      assert.deepStrictEqual(alliance.proposals, []);

      const org = (await route(service, 'GET', `/services/alliance/federations/${infn.federation.id}`)).body;
      assert.strictEqual(org.kind, 'organization');
      assert.deepStrictEqual(org.descriptor, infn.federation.descriptor);
      assert.deepStrictEqual(org.officers.map((row) => row.pubkey), infn.federation.descriptor.validators);
      assert.ok(org.officers.some((row) => row.name === 'Ada'));
      assert.deepStrictEqual(org.alliances.map((row) => row.id), [overview.federation.id]);
      assert.ok(!JSON.stringify(org).includes('discord:'), 'no steward account keys');

      await open(officerRoster(officers.slice(0, 2)));
      const after = (await route(service, 'GET', '/services/alliance/federations')).body.federations;
      assert.deepStrictEqual(after.filter((row) => row.kind === 'organization').map((row) => row.current), [true, false], 'new officers, new org federation; the old one is retired');
      assert.strictEqual((await route(service, 'GET', '/services/alliance/federations/000000000000')).status, 404);
      assert.strictEqual((await route(service, 'GET', '/services/alliance/federations/xyz')).status, 404);

      const meta = await service.federationPage(list[1].path);
      assert.strictEqual(meta.title, `${list[1].name} officers`);
      assert.match(meta.description, /2 of 3 officers decide/);
      assert.strictEqual((await service.federationPage(list[0].path)).title, 'PERMAFLEET federation');
      assert.strictEqual(await service.federationPage('/federations/000000000000'), null);
    });
  });

  describe('member votes', function () {
    const alice = { id: 'a11ce00000000000', displayName: 'Alice', accounts: [{ key: 'discord:200000000000000001' }] };
    const bob = { id: 'b0b0000000000000', displayName: 'Bob', accounts: [{ key: 'discord:200000000000000002' }] };
    const carolKey = new Key();
    const carol = { id: 'ca40100000000000', displayName: 'Carol', accounts: [{ key: `fabric:${carolKey.pubkey.slice(2)}` }] };
    const directory = [alice, bob, carol];
    const people = {
      currentMember: async (req) => (req.member ? { member: req.member, via: req.member.via || null } : null),
      resolve: async (key) => directory.find((m) => m.id === key || m.accounts.some((a) => a.key === key)) || null
    };
    let made;

    beforeEach(async function () {
      alice.accounts = [{ key: 'discord:200000000000000001' }];
      await open(roster(), { members: people });
      made = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Joint op on Saturday' }, as: member('G00N') })).body;
    });

    const selfVote = (key, choice, castAt = clock) => federation.signFrame(federation.memberVoteBody(made.federationId, {
      proposalId: made.id, choice, castAt: new Date(castAt).toISOString()
    }), key).frame;

    it('counts one vote per member across their linked accounts, advisory only', async function () {
      let view = await service.memberVote(made.id, { account: 'discord:200000000000000001', member: alice.id, choice: 'yes' });
      assert.deepStrictEqual(view.members, { yes: 1, no: 0, abstain: 0, total: 1 });
      assert.deepStrictEqual(view.you.memberVote && view.you.memberVote.choice, 'yes');
      assert.strictEqual(view.you.replaced, null);
      assert.strictEqual(view.tally.yes, 0, 'members do not cast org votes');
      alice.accounts.push({ key: 'fabric:' + 'ab'.repeat(32) });
      view = await service.memberVote(made.id, { account: 'fabric:' + 'ab'.repeat(32), member: alice.id, choice: 'no' });
      assert.deepStrictEqual(view.members, { yes: 0, no: 1, abstain: 0, total: 1 }, 'her later vote from another account replaces the first');
      assert.deepStrictEqual(view.you.replaced, { choice: 'yes', otherAccount: true });
      assert.strictEqual(view.memberVotes.length, 1, 'only the counted frame is listed');
      view = await service.memberVote(made.id, { account: 'discord:200000000000000002', member: bob.id, choice: 'yes' });
      assert.deepStrictEqual(view.members, { yes: 1, no: 1, abstain: 0, total: 2 });
      const listed = (await route(service, 'GET', '/services/alliance/proposals')).body.proposals[0];
      assert.deepStrictEqual(listed.members, { yes: 1, no: 1, abstain: 0, total: 2 });

      for (const row of view.memberVotes) {
        const opened = federation.openFrame(row.frame);
        assert.strictEqual(opened.signer, row.signer);
        const checked = federation.verifyMemberVote(made.descriptor, view.bridge.descriptor, opened.body, opened.signer);
        assert.strictEqual(checked.attested, true);
      }
      const json = JSON.stringify((await route(service, 'GET', `/services/alliance/proposals/${made.id}`)).body);
      assert.ok(!json.includes('discord:') && !json.includes('200000000000000001'), 'no account ids');
      assert.ok(!json.includes(alice.id) && !json.includes(bob.id), 'no member ids');
      assert.ok(!json.includes('Alice') && !json.includes('Bob'), 'no member names');
    });

    it('signs with one stable key per account, attested once by the Bridge', async function () {
      const first = await service.memberVote(made.id, { account: 'discord:200000000000000001', member: alice.id, choice: 'yes' });
      const signer = first.memberVotes[0].signer;
      assert.strictEqual(signer, bridgeAttestation.accountKey(xprv, 'discord:200000000000000001').pubkey.slice(2));
      const bridge = await route(service, 'GET', '/services/alliance/bridge');
      assert.strictEqual(bridge.status, 200);
      assert.deepStrictEqual(bridge.body.descriptor.platforms, ['discord', 'fabric']);
      assert.strictEqual(bridge.body.descriptor.pubkey, bridgeAttestation.bridgeKey(xprv).pubkey);
      assert.strictEqual((await route(service, 'GET', '/services/alliance')).body.bridge.id, bridge.body.id);
      await open(roster(), { members: people });
      assert.strictEqual(service.bridge.id, bridge.body.id, 'the same Bridge after a restart');
      const later = await service.memberVote(made.id, { account: 'discord:200000000000000001', member: alice.id, choice: 'no' });
      assert.strictEqual(later.memberVotes[0].signer, signer, 'the same account key every time');
      const a = federation.openFrame(first.memberVotes[0].frame).body.attestation;
      const b = federation.openFrame(later.memberVotes[0].frame).body.attestation;
      assert.strictEqual(a, b, 'attested once');
    });

    it('takes self-signed votes only from Fabric keys a member holds', async function () {
      const ok = await route(service, 'POST', '/services/alliance/messages', { body: { frame: selfVote(carolKey, 'abstain') } });
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.deepStrictEqual(ok.body.members, { yes: 0, no: 0, abstain: 1, total: 1 });
      assert.strictEqual(ok.body.memberVotes[0].bridge, null);
      const stranger = await route(service, 'POST', '/services/alliance/messages', { body: { frame: selfVote(new Key(), 'yes') } });
      assert.strictEqual(stranger.status, 403);
      const older = await route(service, 'POST', '/services/alliance/messages', { body: { frame: selfVote(carolKey, 'yes', clock - 1000) } });
      assert.strictEqual(older.status, 409, 'an older vote cannot replay over a newer one');
      const changed = await route(service, 'POST', '/services/alliance/messages', { body: { frame: selfVote(carolKey, 'yes', clock + 1000) } });
      assert.deepStrictEqual(changed.body.members, { yes: 1, no: 0, abstain: 0, total: 1 });
    });

    it('refuses attestations from another Bridge or for a different key', async function () {
      const view = await service.memberVote(made.id, { account: 'discord:200000000000000002', member: bob.id, choice: 'yes' });
      const attestation = federation.openFrame(view.memberVotes[0].frame).body.attestation;
      const intruder = new Key();
      const stolen = federation.signFrame(federation.memberVoteBody(made.federationId, {
        proposalId: made.id, choice: 'no', castAt: new Date(clock + 5).toISOString(), attestation
      }), intruder).frame;
      const refused = await route(service, 'POST', '/services/alliance/messages', { body: { frame: stolen } });
      assert.strictEqual(refused.status, 403);
      assert.match(refused.body.error, /not signed by the attested account/);
      const otherXprv = new Key().xprv;
      const other = bridgeAttestation.bridgeDescriptor({ name: 'Elsewhere', origin: 'https://example.com', platforms: ['discord'], pubkey: bridgeAttestation.bridgeKey(otherXprv).pubkey });
      const foreign = bridgeAttestation.attest(otherXprv, other, 'discord:200000000000000003', new Date(clock).toISOString());
      const foreignVote = federation.signFrame(federation.memberVoteBody(made.federationId, {
        proposalId: made.id, choice: 'no', castAt: new Date(clock).toISOString(), attestation: foreign.frame
      }), foreign.key).frame;
      const refusedForeign = await route(service, 'POST', '/services/alliance/messages', { body: { frame: foreignVote } });
      assert.strictEqual(refusedForeign.status, 403);
      assert.match(refusedForeign.body.error, /not signed by this Bridge/);
    });

    it('votes from the web as the signed-in member, only while the proposal is open', async function () {
      const url = `/services/alliance/proposals/${made.shortId}/member-votes`;
      assert.strictEqual((await route(service, 'POST', url, { body: { choice: 'yes' } })).status, 401);
      const cast = await route(service, 'POST', url, { body: { choice: 'yes' }, as: bob });
      assert.strictEqual(cast.status, 200);
      assert.strictEqual(cast.body.memberVotes[0].platform, 'discord');
      assert.strictEqual((await route(service, 'POST', url, { body: { choice: 'maybe' }, as: bob })).status, 400);
      const mine = await route(service, 'GET', `/services/alliance/proposals/${made.shortId}`, { as: bob });
      assert.deepStrictEqual(mine.body.you.memberVote.choice, 'yes');
      assert.strictEqual((await route(service, 'GET', `/services/alliance/proposals/${made.shortId}`)).body.you.memberVote, null);
      clock += 8 * DAY;
      const closed = await route(service, 'POST', url, { body: { choice: 'no' }, as: bob });
      assert.strictEqual(closed.status, 409);
    });
  });

  it('describes proposal pages for link previews', async function () {
    const made = (await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Adopt the charter' }, as: member('G00N') })).body;
    const meta = await service.page(`/operations/PERMAFLEET/votes/${made.shortId}`);
    assert.strictEqual(meta.title, 'Adopt the charter');
    assert.match(meta.description, /0 yes, 0 no, 0 abstain of 7 orgs \(4 yes to pass\)/);
    assert.strictEqual(await service.page('/operations/PERMAFLEET/votes/000000000000'), null);
  });
});
