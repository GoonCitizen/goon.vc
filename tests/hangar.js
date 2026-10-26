'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseHangarExport, HangarExportError } = require('../functions/hangarExport');
const Members = require('../services/members');
const Hangar = require('../services/hangar');

// A Hangar Export (hangar.link) file in the add-on's own shape, with made-up
// pledge ids, prices, and dates: ship pledges, a package with no ship, an
// upgrade, a buyback, and things that must never be kept.
function pledge (hangar, fields) {
  return Object.assign({
    pledgeId: '31337000',
    cost: '$45.00 USD',
    configurationCost: '',
    currency: 'Store Credit',
    date: 'October 01, 2026',
    insuranceType: 'insNone',
    warbond: false,
    giftable: true,
    meltable: true,
    package: false,
    uec: '',
    pledgeType: 'ship',
    hangar,
    page: 1,
    pageOf: 1,
    alsoContains: [{ title: 'Self-Land Hangar' }],
    items: [],
    upgradeFrom: '',
    upgradeTo: '',
    buyback: false,
    buybackHref: ''
  }, fields);
}

function sample (hangar = 'Kersa') {
  return {
    type: 'hangarlink',
    version: 1,
    pledges: [
      pledge(hangar, {
        pledgeId: '31337001',
        name: 'Package - Mustang Alpha Starter Pack',
        contains: 'Mustang Alpha and 3 items',
        insuranceType: 'ins6',
        package: true,
        items: [
          { itemCustomName: 'Little Pony', kind: 'Ship', liner: 'Consolidated Outland (CNOU)', title: 'Mustang Alpha', slug: 'mustang-alpha' },
          { kind: 'Insurance', title: '6 Month Insurance' },
          { kind: undefined, title: 'Star Citizen Digital Download' },
          { kind: 'Credits', title: '1,000 UEC' }
        ]
      }),
      pledge(hangar, {
        pledgeId: '31337002',
        name: 'F7C Hornet Mk II',
        cost: '$175.00 USD',
        contains: 'F7A Hornet Mk II and 2 items',
        insuranceType: 'insLTI',
        warbond: true,
        items: [
          { itemCustomName: '', kind: 'Ship', liner: 'Anvil Aerospace (ANVL)', title: 'F7A Hornet Mk II', slug: 'f7a-hornet-mk-ii' },
          { kind: 'Insurance', title: 'Lifetime Insurance' },
          { kind: 'Skin', title: 'Hornet Mk II Paint' }
        ]
      }),
      pledge(hangar, {
        pledgeId: '31337003',
        name: 'Basher',
        contains: 'Basher and 2 items',
        insuranceType: 'ins120',
        items: [
          { itemCustomName: 'BASHER', kind: 'Ship', liner: 'Grey\'s Market (GREY)', title: 'Basher', slug: 'basher' },
          { kind: 'Insurance', title: '120 Month Insurance' }
        ]
      }),
      pledge(hangar, { pledgeId: '31337004', name: 'Alliance Aid Completion Package', contains: '3 items', items: [{ kind: 'FPS Equipment', title: 'Medical Gown' }, { kind: 'Hangar decoration', title: 'Trophy' }] }),
      pledge(hangar, {
        pledgeId: '31337005',
        name: 'Upgrade - Aurora MR to Avenger Titan',
        pledgeType: 'upgrade',
        upgradeFrom: 'aurora-mr',
        upgradeTo: 'avenger-titan',
        items: [{ kind: 'Ship', title: 'Avenger Titan' }]
      }),
      pledge(hangar, { pledgeId: '31337006', name: 'Carrack', buyback: true, buybackHref: '/pledge/buyback/31337006', items: [{ kind: 'Ship', title: 'Carrack', liner: 'Anvil Aerospace (ANVL)' }] })
    ]
  };
}

const SHIPS = [
  { model: 'Mustang Alpha', manufacturer: 'Consolidated Outland', name: 'Little Pony', lti: false, warbond: false },
  { model: 'F7A Hornet Mk II', manufacturer: 'Anvil Aerospace', name: null, lti: true, warbond: true },
  { model: 'Basher', manufacturer: 'Grey\'s Market', name: null, lti: false, warbond: false }
];

describe('Hangar Export files', function () {
  it('reads the account and every ship, keeping no prices, pledge ids, upgrades, or buybacks', function () {
    const parsed = parseHangarExport(sample());
    assert.strictEqual(parsed.hangar, 'Kersa');
    assert.deepStrictEqual(parsed.ships, SHIPS, 'the ship item, not the pledge name; a custom name only when it differs');
    assert.strictEqual(parsed.models, 3);
    const kept = JSON.stringify(parsed);
    for (const dropped of ['$', '31337', 'Carrack', 'Avenger', 'Aurora', 'Digital Download', 'Starter Pack', 'F7C', 'Self-Land', 'Medical', 'October']) {
      assert.ok(!kept.includes(dropped), `${dropped} is not kept`);
    }
  });

  it('takes an export that names no account', function () {
    const parsed = parseHangarExport(sample(''));
    assert.strictEqual(parsed.hangar, null);
    assert.strictEqual(parsed.ships.length, 3);
  });

  it('refuses files that are not one account’s Hangar Export', function () {
    const refuses = (data, code) => assert.throws(() => parseHangarExport(data), (error) => {
      assert.ok(error instanceof HangarExportError);
      assert.strictEqual(error.status, 400);
      assert.strictEqual(error.code, code);
      return true;
    });
    refuses(null, 'NOT_AN_EXPORT');
    refuses('Kersa', 'NOT_AN_EXPORT');
    refuses({ pledges: sample().pledges }, 'NOT_AN_EXPORT');
    refuses([{ ship_code: 'ANVL_Hornet_F7A_Mk2', ship_name: 'F7A Hornet Mk II' }], 'NOT_AN_EXPORT');
    const mixed = sample();
    mixed.pledges[1].hangar = 'Other';
    refuses(mixed, 'HANGARS');
    refuses({ type: 'hangarlink', version: 1, pledges: sample().pledges.slice(3) }, 'NO_SHIPS');
  });
});

describe('Hangar', function () {
  this.timeout(20000);

  let root;
  let members;
  let hangar;
  let now;

  function call (pathname, headers = {}) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        headers: {},
        headersSent: false,
        setHeader (name, value) { this.headers[name.toLowerCase()] = value; },
        end (body) { this.headersSent = true; resolve({ status: this.statusCode, json: body ? JSON.parse(body) : null }); }
      };
      hangar.middleware()({ method: 'GET', url: pathname, headers }, res, () => resolve({ status: 'next' }));
    });
  }

  before(async function () {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-hangar-'));
    now = Date.parse('2026-10-21T12:00:00Z');
    members = new Members({ path: path.join(root, 'members') });
    await members.start();
    hangar = new Hangar({ path: path.join(root, 'hangar'), members, token: 'leadership-token', now: () => now });
    await hangar.start();
  });

  after(async function () {
    if (hangar) await hangar.stop();
    if (members) await members.stop();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('takes an export only for a handle the member has claimed', async function () {
    const member = await members.linkDiscord({ id: '710000000000000001', username: 'kersa' }, 'Kersa');
    await assert.rejects(hangar.importExport(member.id, sample()), (error) => {
      assert.deepStrictEqual([error.code, error.handle, error.status], ['UNCLAIMED', 'Kersa', 403]);
      return true;
    });
    await members.link(member.id, 'rsi:Other', { via: 'bio' });
    await assert.rejects(hangar.importExport(member.id, sample()), { code: 'UNCLAIMED' }, 'another handle is no help');
    await assert.rejects(hangar.importExport(member.id, { type: 'hangarlink', version: 1, pledges: [] }), { code: 'NO_SHIPS' });
    assert.strictEqual(await hangar.status(member.id), null);

    await members.link(member.id, 'rsi:Kersa', { via: 'bio' });
    const result = await hangar.importExport(member.id, sample('KERSA'));
    assert.deepStrictEqual(result, { handle: 'Kersa', ships: 3, models: 3, importedAt: '2026-10-21T12:00:00.000Z' });
    assert.deepStrictEqual(await hangar.status(member.id), { handle: 'Kersa', importedAt: '2026-10-21T12:00:00.000Z', ships: 3, models: 3, counted: true });
  });

  it('files an export that names no account under the member’s only claimed handle', async function () {
    const member = await members.linkDiscord({ id: '710000000000000003', username: 'quiet' }, 'Quiet');
    await assert.rejects(hangar.importExport(member.id, sample('')), (error) => {
      assert.deepStrictEqual([error.code, error.handle, error.status], ['UNCLAIMED', null, 403]);
      return true;
    });
    await members.link(member.id, 'rsi:QuietOne', { via: 'bio' });
    await members.link(member.id, 'rsi:QuietTwo', { via: 'bio' });
    await assert.rejects(hangar.importExport(member.id, sample('')), (error) => {
      assert.deepStrictEqual([error.code, error.status], ['WHICH_HANDLE', 400]);
      assert.match(error.message, /QuietOne, QuietTwo/);
      return true;
    });
    await members.unlink(member.id, 'rsi:QuietTwo');
    assert.strictEqual((await hangar.importExport(member.id, sample(''))).handle, 'QuietOne');
    await members.unlink(member.id, 'rsi:QuietOne');
    assert.strictEqual(await hangar.report().then((report) => report.members), 1, 'uncounted once the handle is gone');
  });

  it('serves fleet totals without names, handles, or ids', async function () {
    const res = await call('/services/hangar');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json, {
      members: 1,
      ships: 3,
      models: [
        { model: 'Basher', manufacturer: 'Grey\'s Market', count: 1, owners: 1 },
        { model: 'F7A Hornet Mk II', manufacturer: 'Anvil Aerospace', count: 1, owners: 1 },
        { model: 'Mustang Alpha', manufacturer: 'Consolidated Outland', count: 1, owners: 1 }
      ],
      updatedAt: '2026-10-21T12:00:00.000Z'
    });
    assert.ok(!/Kersa|Little Pony|7100/.test(JSON.stringify(res.json)));
    assert.strictEqual((await call('/services/other')).status, 'next');
  });

  it('lists hangars per member only behind the token', async function () {
    assert.strictEqual((await call('/services/hangar/members')).status, 404);
    assert.strictEqual((await call('/services/hangar/members', { authorization: 'Bearer wrong' })).status, 404);
    const res = await call('/services/hangar/members', { authorization: 'Bearer leadership-token' });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.hangars.map((entry) => [entry.displayName, entry.handle, entry.ships.length]), [['Kersa', 'Kersa', 3]]);
    assert.ok(!JSON.stringify(res.json).includes('710000000000000001'), 'no Discord ids');
  });

  it('replaces the ships on every import', async function () {
    const member = await members.memberFor('discord:710000000000000001');
    now += 60 * 60 * 1000;
    const smaller = sample();
    smaller.pledges = smaller.pledges.slice(0, 1);
    assert.strictEqual((await hangar.importExport(member.id, smaller)).ships, 1);
    const report = await hangar.report();
    assert.deepStrictEqual([report.ships, report.models.map((row) => row.model)], [1, ['Mustang Alpha']]);
    const record = await hangar.store.get(`/hangars/${member.id}`);
    assert.deepStrictEqual(record.handles.kersa.history.map((entry) => entry.count), [3, 1]);
    await hangar.importExport(member.id, sample());
  });

  it('counts a hangar only while its member holds the handle', async function () {
    const member = await members.memberFor('discord:710000000000000001');
    await members.unlink(member.id, 'rsi:Kersa');
    assert.strictEqual((await hangar.report()).ships, 0);
    assert.strictEqual((await hangar.status(member.id)).counted, false);
    await members.link(member.id, 'rsi:Kersa', { via: 'bio' });
    assert.strictEqual((await hangar.report()).ships, 3);
  });

  it('moves hangars to the surviving member on a merge', async function () {
    const older = await members.memberFor('discord:710000000000000001');
    const newer = await members.memberFor(`fabric:${'cd'.repeat(32)}`, { create: true, via: 'passport' });
    await members.link(newer.id, 'rsi:AltPilot', { via: 'bio' });
    now += 60 * 60 * 1000;
    await hangar.importExport(newer.id, sample('AltPilot'));
    assert.strictEqual((await hangar.report()).members, 2);

    await members.link(newer.id, 'discord:710000000000000001');
    await hangar._queue;
    const survivor = await members.resolve(newer.id);
    assert.strictEqual(survivor.id, older.id);
    const record = await hangar.store.get(`/hangars/${older.id}`);
    assert.deepStrictEqual(Object.keys(record.handles).sort(), ['altpilot', 'kersa']);
    assert.ok(!((await hangar.store.get(`/hangars/${newer.id}`)) || {}).handles, 'nothing left under the merged-away id');
    const report = await hangar.report();
    assert.deepStrictEqual([report.members, report.ships], [1, 6]);
    assert.strictEqual((await hangar.status(newer.id)).handle, 'AltPilot', 'the merged-away id still finds the latest import');
  });

  it('keeps hangars across a restart', async function () {
    await hangar.stop();
    hangar = new Hangar({ path: path.join(root, 'hangar'), members, token: 'leadership-token', now: () => now });
    await hangar.start();
    assert.strictEqual((await hangar.report()).ships, 6);
  });
});
