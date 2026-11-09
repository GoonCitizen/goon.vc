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

// One officer per org (so one officer decides), by Discord account.
function officerAccount (symbol) {
  return `discord:31415926535897932${SYMBOLS.indexOf(symbol)}`;
}

function member (symbol) {
  return { id: `${symbol.toLowerCase()}1`.padEnd(16, '0').slice(0, 16), displayName: `${symbol} officer`, accounts: [{ key: officerAccount(symbol) }] };
}

function roster (overrides = {}) {
  return Object.assign({
    name: 'PERMAFLEET',
    network: 'mainnet',
    publisher: 'G00N',
    organizations: SYMBOLS.map((symbol) => ({ symbol, officers: [officerAccount(symbol)] }))
  }, overrides);
}

// INFN has three officers, two of whom decide.
function officerRoster (accounts, extra = {}) {
  const json = roster();
  const infn = json.organizations.find((org) => org.symbol === 'INFN');
  infn.officers = accounts.slice();
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
  const accounts = ['discord:300000000000000001', 'discord:300000000000000002', 'discord:300000000000000003'];

  it('derives one stable, distinct key per org', function () {
    const a = federation.orgKey(xprv, 'G00N').pubkey;
    assert.strictEqual(federation.orgKey(xprv, 'G00N').pubkey, a);
    const all = SYMBOLS.map((symbol) => federation.orgKey(xprv, symbol).pubkey);
    assert.strictEqual(new Set(all).size, SYMBOLS.length);
    assert.notStrictEqual(federation.orgKey(new Key().xprv, 'G00N').pubkey, a);
  });

  it('derives one stable officer key per account, apart from member-vote keys', function () {
    const a = federation.officerKey(xprv, accounts[0]).pubkey;
    assert.strictEqual(federation.officerKey(xprv, accounts[0]).pubkey, a);
    assert.notStrictEqual(federation.officerKey(xprv, accounts[1]).pubkey, a);
    assert.notStrictEqual(federation.officerKey(new Key().xprv, accounts[0]).pubkey, a, 'only goon.vc’s key makes it');
    assert.notStrictEqual(bridgeAttestation.accountKey(xprv, accounts[0]).pubkey, a, 'a member vote can’t be matched to an officer signature');
    assert.throws(() => federation.officerKey(xprv, 'nope'), /invalid officer account/);
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

  it('signs field-encoded frames, as core peers take them, and still opens stored JSON frames', function () {
    const Message = require('@fabric/core/types/message');
    const key = new Key();
    const body = { contract: 'ab'.repeat(32), type: 'FederationVote', federationId: 'ab'.repeat(32), proposalId: 'p1', choice: 'yes', castAt: '2026-11-06T00:00:00.000Z' };
    const signed = federation.signFrame(body, key);
    const wire = Message.fromBuffer(Buffer.from(signed.frame, 'hex'));
    assert.strictEqual(Message.tryParseLegacyBody(wire).encoding, 'fields');
    const opened = federation.openFrame(signed.frame);
    assert.strictEqual(opened.signer, key.pubkey.slice(2));
    assert.deepStrictEqual(opened.body, body);

    const legacy = Message.fromVector(['CONTRACT_MESSAGE', JSON.stringify(body)]);
    legacy.signWithKey(key);
    assert.deepStrictEqual(federation.openFrame(legacy.toBuffer().toString('hex')).body, body);
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
  });

  it('leaves an org without officers out of the vote', function () {
    const parsed = federation.parseRoster(roster({ organizations: [{ symbol: 'G00N', officers: [] }] }));
    assert.deepStrictEqual(parsed.organizations, [{ symbol: 'G00N', pubkey: null, officers: [], threshold: null }]);
    assert.strictEqual(federation.validatorsFor(parsed, xprv)[0].custody, 'none');
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
    const withOfficers = (list, extra = {}) => federation.parseRoster(officerRoster(list, extra));
    const parsed = withOfficers(accounts);
    const infn = parsed.organizations.find((org) => org.symbol === 'INFN');
    assert.deepStrictEqual(infn.officers, accounts);
    const descriptor = federation.orgDescriptor(parsed, infn, xprv);
    assert.strictEqual(descriptor.type, 'FabricFederationDescriptor');
    assert.strictEqual(descriptor.threshold, 2);
    assert.deepStrictEqual(descriptor.validators.slice().sort(), accounts.map((a) => federation.officerKey(xprv, a).pubkey).sort());
    assert.strictEqual(descriptor.publisher, federation.officerKey(xprv, accounts[0]).pubkey);
    const validators = federation.validatorsFor(parsed, xprv);
    const entry = validators.find((v) => v.symbol === 'INFN');
    assert.strictEqual(entry.custody, 'officers');
    assert.strictEqual(entry.federation.id, federation.descriptorId(descriptor));
    assert.strictEqual(entry.pubkey, federation.orgKey(xprv, 'INFN', entry.federation.id).pubkey);
    assert.notStrictEqual(entry.pubkey, federation.orgKey(xprv, 'INFN').pubkey);
    const allianceId = federation.descriptorId(federation.allianceDescriptor(parsed, validators));
    const swapped = withOfficers([accounts[0], accounts[1], 'discord:300000000000000009']);
    const swappedValidators = federation.validatorsFor(swapped, xprv);
    assert.notStrictEqual(swappedValidators.find((v) => v.symbol === 'INFN').pubkey, entry.pubkey);
    assert.notStrictEqual(federation.descriptorId(federation.allianceDescriptor(swapped, swappedValidators)), allianceId);
    const stricter = withOfficers(accounts, { threshold: 3 });
    assert.strictEqual(federation.orgDescriptor(stricter, stricter.organizations.find((org) => org.symbol === 'INFN'), xprv).threshold, 3);
    assert.notStrictEqual(federation.validatorsFor(stricter, xprv).find((v) => v.symbol === 'INFN').pubkey, entry.pubkey);
  });

  it('refuses bad officer lists', function () {
    const bad = (org) => () => federation.parseRoster(roster({ organizations: [Object.assign({ symbol: 'G00N' }, org)] }));
    assert.throws(bad({ officers: [accounts[0]], pubkey: new Key().pubkey }), /not both/);
    assert.throws(bad({ officers: [accounts[0]], threshold: 2 }), /threshold/);
    assert.throws(bad({ officers: [accounts[0], ` ${accounts[0]} `] }), /twice/);
    assert.throws(bad({ threshold: 1 }), /threshold needs officers/);
    assert.throws(bad({ officers: [new Key().pubkey] }), /invalid officer account/);
    assert.throws(bad({ officers: 'discord:300000000000000001' }), /list of accounts/);
    assert.throws(bad({ officers: Array.from({ length: federation.MAX_OFFICERS + 1 }, (_, i) => `discord:4000000000000000${String(i).padStart(2, '0')}`) }), /at most/);
  });

  it('counts officers and checks the endorsements an org vote rests on', function () {
    const officers = accounts.map((account) => federation.officerKey(xprv, account));
    const parsed = federation.parseRoster(officerRoster(accounts));
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
  this.timeout(20000);
  let dir;
  let clock;
  let xprv;
  let service;
  const names = {};
  const members = {
    currentMember: async (req) => (req.member ? { member: req.member, via: 'discord' } : null),
    resolve: async (key) => (names[key] ? { displayName: names[key] } : null)
  };

  const post = (frame) => route(service, 'POST', '/services/alliance/messages', { body: { frame } });
  const overviewNow = async (as = null) => (await route(service, 'GET', '/services/alliance', { as })).body;
  const entryOf = (overview, symbol) => overview.federation.organizations.find((org) => org.symbol === symbol);
  const iso = () => new Date(clock).toISOString();

  // An org's officer proposes, signed in; goon.vc signs the officer and org proposals.
  function propose (symbol, title, { days = 7, summary = '', as = member(symbol) } = {}) {
    return route(service, 'POST', '/services/alliance/proposals', { body: { title, summary, days }, as });
  }

  // An org's (only) officer votes, which decides the org's vote.
  function vote (proposal, symbol, choice, as = member(symbol)) {
    clock += 1;
    return route(service, 'POST', `/services/alliance/proposals/${proposal.id}/votes`, { body: { choice }, as });
  }

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
    for (const symbol of SYMBOLS) names[officerAccount(symbol)] = `${symbol} officer`;
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
    assert.strictEqual(anon.body.federation.voting, 7);
    assert.deepStrictEqual(anon.body.you, { signedIn: false, officers: [] });
    const served = JSON.stringify(anon.body);
    assert.ok(!served.includes('discord:') && !SYMBOLS.some((symbol) => served.includes(officerAccount(symbol).slice(8))), 'no account ids');
    const invite = federation.openFrame(anon.body.federation.invite);
    assert.strictEqual(invite.body.type, 'FederationInvite');
    assert.strictEqual(invite.signer, anon.body.federation.descriptor.publisher.slice(2));
    const signed = await overviewNow(member('TRDE'));
    assert.deepStrictEqual([signed.you.signedIn, signed.you.officers.map((org) => org.symbol)], [true, ['TRDE']]);
    const rando = { id: 'aaaaaaaaaaaaaaaa', displayName: 'Rando', accounts: [{ key: 'discord:999999' }] };
    assert.deepStrictEqual((await overviewNow(rando)).you, { signedIn: true, officers: [] });
  });

  it('lets only signed-in officers on record propose and vote', async function () {
    const rando = { id: 'aaaaaaaaaaaaaaaa', displayName: 'Rando', accounts: [{ key: 'discord:999999' }] };
    const anon = await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Try' } });
    assert.strictEqual(anon.status, 401);
    const outsider = await propose('G00N', 'Try', { as: rando });
    assert.strictEqual(outsider.status, 403);
    assert.match(outsider.body.error, /officers on record/);
    assert.ok(!/key/i.test(outsider.body.error), 'no keys in the message');
    assert.strictEqual((await propose('G00N', '')).status, 400);
    assert.strictEqual((await propose('G00N', 'Too long', { days: 31 })).status, 400);
    const made = (await propose('G00N', 'Joint op')).body;
    const url = `/services/alliance/proposals/${made.id}/votes`;
    assert.strictEqual((await route(service, 'POST', url, { body: { choice: 'yes' } })).status, 401);
    assert.strictEqual((await route(service, 'POST', url, { body: { choice: 'yes' }, as: rando })).status, 403);
    assert.strictEqual((await vote(made, 'G00N', 'maybe')).status, 400);
    assert.strictEqual((await route(service, 'GET', `/services/alliance/proposals/${made.id}`)).body.tally.yes, 0);
  });

  it('takes a proposal from an officer, signed for the org', async function () {
    const made = await propose('INFN', 'Adopt the PERMAFLEET charter', { days: 3, summary: 'Text in #alliance.' });
    assert.strictEqual(made.status, 200, JSON.stringify(made.body));
    assert.strictEqual(made.body.proposer.symbol, 'INFN');
    assert.strictEqual(made.body.by, 'INFN officer');
    assert.strictEqual(made.body.status, 'open');
    assert.deepStrictEqual(made.body.you.signed, ['INFN']);
    assert.strictEqual(Date.parse(made.body.closesAt) - clock, 3 * DAY);
    const opened = federation.openFrame(made.body.frame);
    assert.strictEqual(opened.body.type, 'FederationProposal');
    assert.strictEqual(opened.signer, entryOf(await overviewNow(), 'INFN').pubkey.slice(2));
    assert.strictEqual(federation.openFrame(opened.body.endorsements[0]).signer, federation.officerKey(xprv, officerAccount('INFN')).pubkey.slice(2));
    assert.strictEqual(federation.proposalId(opened.body), made.body.id);
    const short = await route(service, 'GET', `/services/alliance/proposals/${made.body.shortId}`);
    assert.strictEqual(short.body.id, made.body.id);
    assert.ok(!('member' in short.body) && !JSON.stringify(short.body).includes('discord:'));
  });

  it('gives each org one vote, passes on a majority, then closes', async function () {
    const made = (await propose('G00N', 'Joint op on Saturday')).body;
    assert.strictEqual((await vote(made, 'G00N', 'yes')).status, 200);
    const changed = await vote(made, 'G00N', 'no');
    assert.strictEqual(changed.body.tally.yes, 0);
    assert.strictEqual(changed.body.tally.no, 1, 'a later officer vote changes the org vote, not adds one');
    assert.strictEqual(changed.body.votes.length, 2);
    assert.strictEqual(changed.body.organizations.find((org) => org.symbol === 'G00N').by, 'G00N officer');
    assert.deepStrictEqual(changed.body.you.signed, ['G00N']);
    assert.strictEqual(changed.body.you.memberVote.choice, 'no', 'an officer’s vote is also their member vote');
    await vote(made, 'G00N', 'yes');
    await vote(made, 'INFN', 'yes');
    await vote(made, 'TRDE', 'abstain');
    const third = await vote(made, 'LCRP', 'yes');
    assert.strictEqual(third.body.status, 'open');
    const passed = await vote(made, 'AIMOS', 'yes');
    assert.strictEqual(passed.body.status, 'passed');
    assert.deepStrictEqual([passed.body.tally.yes, passed.body.tally.waiting, passed.body.tally.threshold], [4, 2, 4]);
    assert.deepStrictEqual(passed.body.members, { yes: 4, no: 0, abstain: 1, total: 5 });
    const late = await vote(made, '4MCONTRACT', 'no');
    assert.strictEqual(late.status, 409);
    const overview = await overviewNow();
    for (const row of passed.body.votes) {
      const opened = federation.openFrame(row.frame);
      assert.strictEqual(opened.body.proposalId, made.id);
      assert.strictEqual(opened.signer, entryOf(overview, row.org).pubkey.slice(2));
    }
    const listed = await route(service, 'GET', '/services/alliance/proposals');
    assert.strictEqual(listed.body.proposals[0].status, 'passed');
  });

  it('fails a proposal that can no longer pass, and expires one at its deadline', async function () {
    const doomed = (await propose('G00N', 'Rename the fleet')).body;
    for (const symbol of ['G00N', 'INFN', 'TRDE']) await vote(doomed, symbol, 'no');
    const failed = await vote(doomed, 'LCRP', 'no');
    assert.strictEqual(failed.body.status, 'failed');
    const slow = (await propose('G00N', 'Slow one', { days: 1 })).body;
    clock += DAY + 1;
    assert.strictEqual((await route(service, 'GET', `/services/alliance/proposals/${slow.id}`)).body.status, 'expired');
    assert.strictEqual((await vote(slow, 'G00N', 'yes')).status, 409);
  });

  it('leaves an org without officers on record out until it has some', async function () {
    const rosterJson = roster();
    rosterJson.organizations.find((org) => org.symbol === 'LCRP').officers = [];
    await open(rosterJson);
    const overview = await overviewNow();
    assert.strictEqual(entryOf(overview, 'LCRP').custody, 'none');
    assert.strictEqual(overview.federation.voting, 6);
    assert.deepStrictEqual((await overviewNow(member('LCRP'))).you.officers, []);
    const made = (await propose('G00N', 'Joint op')).body;
    assert.strictEqual((await vote(made, 'LCRP', 'yes')).status, 403);
    const body = federation.voteBody(overview.federation.id, { proposalId: made.id, choice: 'yes', castAt: iso() });
    const refused = await post(federation.signFrame(body, federation.orgKey(xprv, 'LCRP')).frame);
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.error, /LCRP has no officers on record/);
    const proposal = federation.proposalBody(overview.federation.id, { title: 'Sneaky', summary: '', proposer: federation.orgKey(xprv, 'LCRP').pubkey, createdAt: iso(), closesAt: new Date(clock + DAY).toISOString() });
    assert.strictEqual((await post(federation.signFrame(proposal, federation.orgKey(xprv, 'LCRP')).frame)).status, 403);
  });

  it('accepts frames from an org that holds its own key and refuses forgeries', async function () {
    const own = new Key();
    const rosterJson = roster();
    const trde = rosterJson.organizations.find((org) => org.symbol === 'TRDE');
    delete trde.officers;
    trde.pubkey = own.pubkey;
    await open(rosterJson);
    const overview = await overviewNow();
    assert.strictEqual(entryOf(overview, 'TRDE').custody, 'own');
    const made = (await propose('G00N', 'Shared hangar')).body;
    const body = federation.voteBody(overview.federation.id, { proposalId: made.id, choice: 'yes', castAt: new Date(clock).toISOString() });
    const accepted = await post(federation.signFrame(body, own).frame);
    assert.strictEqual(accepted.status, 200);
    assert.strictEqual(accepted.body.organizations.find((org) => org.symbol === 'TRDE').choice, 'yes');
    clock += 1000;
    const no = federation.voteBody(overview.federation.id, { proposalId: made.id, choice: 'no', castAt: new Date(clock).toISOString() });
    assert.strictEqual((await post(federation.signFrame(no, own).frame)).body.tally.no, 1);
    const replay = await post(federation.signFrame(body, own).frame);
    assert.strictEqual(replay.body.organizations.find((org) => org.symbol === 'TRDE').choice, 'no', 'replaying an older vote changes nothing');
    const stale = federation.voteBody(overview.federation.id, { proposalId: made.id, choice: 'abstain', castAt: new Date(clock - 500).toISOString() });
    assert.strictEqual((await post(federation.signFrame(stale, own).frame)).status, 409);
    const forged = await post(federation.signFrame(body, new Key()).frame);
    assert.strictEqual(forged.status, 403);
    const tampered = federation.signFrame(body, own).frame.replace(/7965/, '6e6f');
    assert.ok([400, 403].includes((await post(tampered)).status));
  });

  it('starts a new federation when the roster changes, keeping old proposals with theirs', async function () {
    const first = (await overviewNow()).federation.id;
    const made = (await propose('G00N', 'Before the new org')).body;
    const newcomer = { id: 'eeeeeeeeeeeeeeee', displayName: 'Newcomer', accounts: [{ key: 'discord:500000000000000001' }] };
    const rosterJson = roster();
    rosterJson.organizations.push({ symbol: 'NEWORG', officers: ['discord:500000000000000001'] });
    await open(rosterJson);
    const now = await overviewNow();
    assert.notStrictEqual(now.federation.id, first);
    assert.strictEqual(now.federation.threshold, 5);
    const old = (await route(service, 'GET', `/services/alliance/proposals/${made.id}`)).body;
    assert.strictEqual(old.federationId, first);
    assert.strictEqual(old.current, false);
    assert.strictEqual(old.organizations.length, 7);
    assert.strictEqual((await vote(old, 'NEWORG', 'yes', newcomer)).status, 403, 'an org that joined later has no say on it');
    assert.strictEqual((await vote(old, 'G00N', 'yes')).status, 200);
  });

  it('turns itself off on a broken roster instead of failing the site', async function () {
    const errors = [];
    fs.writeFileSync(path.join(dir, 'broken.json'), JSON.stringify({ name: 'PERMAFLEET', network: 'mainnet', publisher: 'X', organizations: [] }));
    await service.stop();
    service = new Alliance({ path: path.join(dir, 'store2'), file: path.join(dir, 'broken.json'), xprv, members });
    service.on('error', (...parts) => errors.push(parts.join(' ')));
    await service.start();
    assert.strictEqual((await route(service, 'GET', '/services/alliance')).body.status, 'unconfigured');
    assert.strictEqual((await route(service, 'POST', '/services/alliance/messages', { body: { frame: '00' } })).status, 503);
    assert.ok(errors.length);
  });

  describe('an org of officers', function () {
    const accounts = ['discord:300000000000000001', 'discord:300000000000000002', 'discord:300000000000000003'];
    const officer = (i) => ({ id: `0ff1ce000000000${i}`, displayName: ['Ada', 'Bea', 'Cy'][i], accounts: [{ key: accounts[i] }] });
    let overview;
    let infn;

    const orgOf = (view) => view.organizations.find((org) => org.symbol === 'INFN');
    const officerVote = (i, proposal, choice, fields = {}) => {
      clock += 1000;
      return route(service, 'POST', `/services/alliance/proposals/${proposal.id}/votes`, { body: Object.assign({ choice }, fields), as: officer(i) });
    };

    beforeEach(async function () {
      names[accounts[0]] = 'Ada';
      await open(officerRoster(accounts));
      overview = await overviewNow();
      infn = entryOf(overview, 'INFN');
    });

    it('serves the org federation and who among the signed-in members is an officer', async function () {
      assert.strictEqual(infn.custody, 'officers');
      assert.deepStrictEqual([infn.federation.threshold, infn.federation.officers], [2, 3]);
      assert.strictEqual(federation.descriptorId(infn.federation.descriptor), infn.federation.id);
      assert.strictEqual(infn.pubkey, federation.orgKey(xprv, 'INFN', infn.federation.id).pubkey);
      assert.deepStrictEqual((await overviewNow(officer(0))).you.officers.map((org) => org.symbol), ['INFN']);
    });

    it('knows whom an account acts for through the accounts linked to it, and who is on record', async function () {
      const ada = { id: 'cccccccccccccccc', displayName: 'Ada', accounts: [{ key: 'discord:424242' }, { key: accounts[0] }] };
      const goon = { id: 'dddddddddddddddd', displayName: 'Gus', accounts: [{ key: 'discord:777777' }, { key: officerAccount('G00N') }] };
      const linked = { 'discord:424242': ada, [accounts[0]]: ada, 'discord:777777': goon, [officerAccount('G00N')]: goon };
      await open(officerRoster(accounts), { members: Object.assign({}, members, { resolve: async (key) => linked[key] || null }) });
      const brief = (orgs) => orgs.map((org) => [org.symbol, org.officer]);

      assert.deepStrictEqual(brief(await service.representing('discord:424242')), [['INFN', true]], 'an officer through the account on record linked to their Discord');
      assert.deepStrictEqual(brief(await service.representing(accounts[1])), [['INFN', true]], 'an officer on record without a goon.vc profile yet');
      assert.deepStrictEqual(brief(await service.representing('discord:777777')), [['G00N', true]]);
      assert.deepStrictEqual(await service.representing('discord:999999'), [], 'nobody else acts for an org');
      assert.deepStrictEqual(await service.representing(null), []);
      assert.deepStrictEqual((await service.actorFor('discord:424242')).officers, ['INFN']);

      assert.deepStrictEqual(await service.representatives('infn'), [
        { name: 'Ada', discord: ['300000000000000001', '424242'], officer: true },
        { name: null, discord: ['300000000000000002'], officer: true },
        { name: null, discord: ['300000000000000003'], officer: true }
      ]);
      assert.deepStrictEqual(await service.representatives('G00N'), [{ name: 'Gus', discord: ['314159265358979320', '777777'], officer: true }]);
      assert.deepStrictEqual(await service.representatives('NOPE'), []);
      const served = JSON.stringify((await route(service, 'GET', '/services/alliance', { as: ada })).body);
      assert.ok(!served.includes('424242') && !served.includes('300000000000000001'), 'the Discord ids stay inside goon.vc');
    });

    it('votes for the org once enough officers agree, and follows them when they change', async function () {
      const made = (await propose('G00N', 'Joint op')).body;
      let res = await officerVote(0, made, 'yes');
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(orgOf(res.body).choice, null, 'one officer of three is not enough');
      assert.deepStrictEqual(orgOf(res.body).officers, { threshold: 2, total: 3, yes: 1, no: 0, abstain: 0, waiting: 2 });
      assert.strictEqual(res.body.officerVotes[0].by, 'Ada');
      assert.deepStrictEqual(res.body.you.officers.map((row) => [row.symbol, row.choice]), [['INFN', 'yes']]);
      res = await officerVote(1, made, 'yes');
      assert.strictEqual(orgOf(res.body).choice, 'yes');
      assert.strictEqual(res.body.tally.yes, 1);
      const vote = res.body.votes.find((row) => row.org === 'INFN');
      const opened = federation.openFrame(vote.frame);
      assert.strictEqual(opened.signer, infn.pubkey.slice(2), 'goon.vc signs the org’s alliance vote');
      assert.strictEqual(opened.body.orgFederationId, infn.federation.id);
      assert.deepStrictEqual(opened.body.endorsements.map((frame) => federation.openFrame(frame).signer).sort(), accounts.slice(0, 2).map((a) => federation.officerKey(xprv, a).pubkey.slice(2)).sort());
      assert.strictEqual(vote.endorsements.length, 2);
      assert.match(vote.by, /Ada/);
      res = await officerVote(0, made, 'no');
      assert.strictEqual(orgOf(res.body).choice, 'yes', 'losing quorum keeps the last org vote');
      res = await officerVote(2, made, 'no');
      assert.strictEqual(orgOf(res.body).choice, 'no');
      assert.deepStrictEqual([res.body.tally.yes, res.body.tally.no], [0, 1]);
      assert.strictEqual(res.body.votes.filter((row) => row.org === 'INFN').length, 2);
      assert.strictEqual(res.body.officerVotes.length, 4);
      assert.deepStrictEqual(new Set(res.body.officerVotes.map((row) => row.officer)).size, 3);
      assert.deepStrictEqual(res.body.members, { yes: 1, no: 2, abstain: 0, total: 3 }, 'each officer’s latest vote is their member vote');
      assert.ok(!JSON.stringify(res.body).includes('discord:'), 'no account keys');
    });

    it('shows each officer’s vote only to that org’s officers', async function () {
      const made = (await propose('G00N', 'Joint op')).body;
      await officerVote(0, made, 'yes');
      await officerVote(1, made, 'yes');
      for (const as of [null, member('G00N'), { id: 'aaaaaaaaaaaaaaaa', displayName: 'Rando', accounts: [{ key: 'discord:999999' }] }]) {
        const seen = (await route(service, 'GET', `/services/alliance/proposals/${made.id}`, { as })).body;
        assert.deepStrictEqual(seen.officerVotes, []);
        assert.deepStrictEqual(orgOf(seen).officers, { threshold: 2, total: 3 });
        assert.strictEqual(orgOf(seen).choice, 'yes', 'the org’s vote is public');
        assert.strictEqual(seen.votes.find((row) => row.org === 'INFN').by, null);
        assert.ok(!JSON.stringify(seen).includes('Ada'));
      }
      const fellow = (await route(service, 'GET', `/services/alliance/proposals/${made.id}`, { as: officer(2) })).body;
      assert.deepStrictEqual(fellow.officerVotes.map((row) => [row.by, row.choice]), [['Ada', 'yes'], ['an officer', 'yes']]);
      assert.deepStrictEqual(fellow.you.officers.map((row) => [row.symbol, row.choice]), [['INFN', null]]);
    });

    it('refuses outsiders and mismatched org votes, and short endorsements', async function () {
      const made = (await propose('G00N', 'Shared hangar')).body;
      assert.strictEqual((await officerVote(0, made, 'yes', { org: 'TRDE' })).status, 403);
      assert.strictEqual((await route(service, 'POST', `/services/alliance/proposals/${'b'.repeat(64)}/votes`, { body: { choice: 'yes' }, as: officer(0) })).status, 404);
      const stranger = federation.signFrame(federation.officerVoteBody(infn.federation.id, {
        allianceFederationId: overview.federation.id, org: 'INFN', proposalId: made.id, choice: 'yes', castAt: iso()
      }), new Key()).frame;
      assert.strictEqual((await post(stranger)).status, 403);
      const signed = federation.signFrame(federation.officerVoteBody(infn.federation.id, {
        allianceFederationId: overview.federation.id, org: 'INFN', proposalId: made.id, choice: 'yes', castAt: iso()
      }), federation.officerKey(xprv, accounts[0])).frame;
      const short = federation.voteBody(overview.federation.id, {
        proposalId: made.id, choice: 'yes', castAt: iso(), orgFederationId: infn.federation.id, endorsements: [signed]
      });
      const forced = await post(federation.signFrame(short, federation.orgKey(xprv, 'INFN', infn.federation.id)).frame);
      assert.strictEqual(forced.status, 403);
      assert.match(forced.body.error, /needs 2 officers/);
    });

    it('wraps an officer proposal into the org proposal, once', async function () {
      const made = await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Adopt the charter', summary: 'Text in #alliance.', days: 3 }, as: officer(0) });
      assert.strictEqual(made.status, 200, JSON.stringify(made.body));
      assert.strictEqual(made.body.proposer.symbol, 'INFN');
      assert.strictEqual(made.body.by, 'Ada');
      assert.strictEqual(made.body.endorsements.length, 1);
      const opened = federation.openFrame(made.body.frame);
      assert.strictEqual(opened.signer, infn.pubkey.slice(2));
      assert.strictEqual(federation.openFrame(opened.body.endorsements[0]).signer, federation.officerKey(xprv, accounts[0]).pubkey.slice(2));
      assert.strictEqual((await post(made.body.endorsements[0].frame)).body.id, made.body.id, 'the same officer frame makes the same proposal');
      assert.strictEqual((await route(service, 'GET', '/services/alliance/proposals')).body.proposals.length, 1);
      assert.strictEqual(made.body.orgFederations.find((row) => row.symbol === 'INFN').id, infn.federation.id);
    });

    it('asks an officer of two orgs which one proposes, and signs for both when voting', async function () {
      const both = { id: 'b0th000000000000', displayName: 'Both', accounts: [{ key: accounts[0] }, { key: officerAccount('G00N') }] };
      const unsure = await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'Which org?' }, as: both });
      assert.strictEqual(unsure.status, 400);
      assert.match(unsure.body.error, /G00N and INFN|INFN and G00N/);
      const made = await route(service, 'POST', '/services/alliance/proposals', { body: { title: 'For G00N', org: 'G00N' }, as: both });
      assert.strictEqual(made.body.proposer.symbol, 'G00N');
      const voted = await route(service, 'POST', `/services/alliance/proposals/${made.body.id}/votes`, { body: { choice: 'yes' }, as: both });
      assert.deepStrictEqual(voted.body.you.signed.slice().sort(), ['G00N', 'INFN']);
      assert.strictEqual(orgOf(voted.body).officers.yes, 1);
      assert.strictEqual(voted.body.organizations.find((org) => org.symbol === 'G00N').choice, 'yes');
    });

    it('lists every alliance and org federation, current first, with their pages', async function () {
      const list = (await route(service, 'GET', '/services/alliance/federations')).body.federations;
      const current = list.filter((row) => row.current);
      assert.deepStrictEqual(current.map((row) => row.kind), ['alliance'].concat(SYMBOLS.map(() => 'organization')), 'current first');
      assert.deepStrictEqual(list.filter((row) => !row.current).map((row) => [row.kind, row.symbol]).sort(), [['alliance', null], ['organization', 'INFN']], 'the roster before INFN named three officers is retired');
      assert.strictEqual(list[0].id, overview.federation.id);
      assert.strictEqual(list[0].path, `/federations/${overview.federation.id.slice(0, 12)}`);
      assert.strictEqual(overview.federation.path, list[0].path);
      const infnRow = list.find((row) => row.id === infn.federation.id);
      assert.ok(infnRow.current);
      assert.strictEqual(infn.federation.path, infnRow.path);
      assert.deepStrictEqual([infnRow.symbol, infnRow.threshold, infnRow.members], ['INFN', 2, 3]);

      const alliance = (await route(service, 'GET', `/services/alliance/federations/${list[0].shortId}`)).body;
      assert.deepStrictEqual(alliance.descriptor, overview.federation.descriptor);
      assert.strictEqual(federation.openFrame(alliance.invite).body.type, 'FederationInvite');
      assert.strictEqual(alliance.organizations.find((org) => org.symbol === 'INFN').federation.path, infnRow.path);
      assert.deepStrictEqual(alliance.proposals, []);

      const org = (await route(service, 'GET', `/services/alliance/federations/${infn.federation.id}`)).body;
      assert.strictEqual(org.kind, 'organization');
      assert.deepStrictEqual(org.descriptor, infn.federation.descriptor);
      assert.strictEqual(org.officers.length, 3);
      assert.ok(org.officers.some((row) => row.name === 'Ada'));
      const names = org.officers.map((row) => row.name);
      assert.deepStrictEqual(names, names.slice().sort((x, y) => x.localeCompare(y)), 'in name order, not validator order');
      assert.deepStrictEqual(org.alliances.map((row) => row.id), [overview.federation.id]);
      assert.ok(!JSON.stringify(org).includes('discord:'), 'no account keys');

      await open(officerRoster(accounts.slice(0, 2)));
      const after = (await route(service, 'GET', '/services/alliance/federations')).body.federations;
      const infnAfter = after.filter((row) => row.symbol === 'INFN');
      assert.strictEqual(infnAfter.filter((row) => row.current).length, 1);
      assert.strictEqual(infnAfter.find((row) => row.id === infn.federation.id).current, false, 'new officers, new org federation; the old one is retired');
      assert.strictEqual((await route(service, 'GET', '/services/alliance/federations/000000000000')).status, 404);
      assert.strictEqual((await route(service, 'GET', '/services/alliance/federations/xyz')).status, 404);

      const meta = await service.federationPage(infnRow.path);
      assert.strictEqual(meta.title, `${infnRow.name} officers`);
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
      made = (await propose('G00N', 'Joint op on Saturday')).body;
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

    it('takes self-signed votes only from members', async function () {
      const ok = await post(selfVote(carolKey, 'abstain'));
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.deepStrictEqual(ok.body.members, { yes: 0, no: 0, abstain: 1, total: 1 });
      assert.strictEqual(ok.body.memberVotes[0].bridge, null);
      const stranger = await post(selfVote(new Key(), 'yes'));
      assert.strictEqual(stranger.status, 403);
      assert.ok(!/key/i.test(stranger.body.error), 'no keys in the message');
      const older = await post(selfVote(carolKey, 'yes', clock - 1000));
      assert.strictEqual(older.status, 409, 'an older vote cannot replay over a newer one');
      const changed = await post(selfVote(carolKey, 'yes', clock + 1000));
      assert.deepStrictEqual(changed.body.members, { yes: 1, no: 0, abstain: 0, total: 1 });
    });

    it('refuses attestations from another Bridge or for a different key', async function () {
      const view = await service.memberVote(made.id, { account: 'discord:200000000000000002', member: bob.id, choice: 'yes' });
      const attestation = federation.openFrame(view.memberVotes[0].frame).body.attestation;
      const intruder = new Key();
      const stolen = federation.signFrame(federation.memberVoteBody(made.federationId, {
        proposalId: made.id, choice: 'no', castAt: new Date(clock + 5).toISOString(), attestation
      }), intruder).frame;
      const refused = await post(stolen);
      assert.strictEqual(refused.status, 403);
      assert.match(refused.body.error, /not signed by the attested account/);
      const otherXprv = new Key().xprv;
      const other = bridgeAttestation.bridgeDescriptor({ name: 'Elsewhere', origin: 'https://example.com', platforms: ['discord'], pubkey: bridgeAttestation.bridgeKey(otherXprv).pubkey });
      const foreign = bridgeAttestation.attest(otherXprv, other, 'discord:200000000000000003', new Date(clock).toISOString());
      const foreignVote = federation.signFrame(federation.memberVoteBody(made.federationId, {
        proposalId: made.id, choice: 'no', castAt: new Date(clock).toISOString(), attestation: foreign.frame
      }), foreign.key).frame;
      const refusedForeign = await post(foreignVote);
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
    const made = (await propose('G00N', 'Adopt the charter')).body;
    const meta = await service.page(`/operations/PERMAFLEET/votes/${made.shortId}`);
    assert.strictEqual(meta.title, 'Adopt the charter');
    assert.match(meta.description, /0 yes, 0 no, 0 abstain of 7 orgs \(4 yes to pass\)/);
    assert.strictEqual(await service.page('/operations/PERMAFLEET/votes/000000000000'), null);
  });
});
