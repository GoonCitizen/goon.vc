'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const redArmy = require('../functions/redArmy');
const RedArmy = require('../services/redArmy');
const contract = require('../contracts/red-army.json');
const alliance = require('../contracts/alliance.json');

const HOME = '1190527980120850493';
const SHELLBACKS = '635948860459450400';
const DIA = '1230782172944924722';
const FABRIC = '498359331692085259';
const NEORION = '814644536297914429';
const TRDE = '937681528790609970';
const MR_MEANER = 'discord:503419731286556703';
const BROCK = 'discord:171376528838361088';

const GUILDS = [
  { id: FABRIC, name: 'fabric' },
  { id: SHELLBACKS, name: 'SC Shellback' },
  { id: NEORION, name: "Neorion's server" },
  { id: HOME, name: 'G00N SQUAD' },
  { id: DIA, name: 'DIA' },
  { id: TRDE, name: 'Trans-Galactic' },
  { id: '111111111111111111', name: 'Random Org' }
];

const ORG_SYMBOLS = ['RR', 'SHELLBACKS', 'MB', 'BKEX', 'RINTAK', 'SCHOMIES'];

describe('RED ARMY', function () {
  const roster = redArmy.parseRoster(contract);

  it('records named orgs, Monkey Business, alliance friends, and DIA as a private Discord', function () {
    assert.strictEqual(roster.name, 'RED ARMY');
    assert.deepStrictEqual(roster.organizations.map((org) => org.symbol), ORG_SYMBOLS);
    const rr = roster.organizations[0];
    assert.strictEqual(rr.name, "Robert's Rejects");
    assert.strictEqual(rr.guildId, undefined);
    assert.deepStrictEqual(rr.officers, [{ account: MR_MEANER, name: 'mr_meaner' }]);
    const shellbacks = roster.organizations[1];
    assert.strictEqual(shellbacks.guildId, SHELLBACKS);
    assert.strictEqual(shellbacks.rsi, 'SHELLBACK');
    assert.deepStrictEqual(shellbacks.officers, [{ account: BROCK, name: 'Brock_85' }]);
    assert.ok(shellbacks.note.includes('not the SHELLBACK elite'));
    assert.strictEqual(roster.organizations[2].name, 'Monkey Business');
    assert.strictEqual(roster.organizations[2].guildId, undefined);
    assert.strictEqual(roster.organizations[3].name, 'BLACK EXODUS');
    assert.strictEqual(roster.organizations[4].rsi, 'RINTAK');
    assert.strictEqual(roster.organizations[5].rsi, 'SCHOMIES');
    assert.strictEqual(roster.servers.length, 1);
    assert.strictEqual(roster.servers[0].name, 'DIA');
    assert.strictEqual(roster.servers[0].guildId, DIA);
    assert.ok(roster.servers[0].note.includes('not linked to an RSI org'));
    assert.ok(!roster.organizations.some((org) => org.symbol === 'DIA' || /diabolica/i.test(org.name)));
    assert.ok(!alliance.organizations.some((org) => ORG_SYMBOLS.includes(org.symbol) || org.symbol === 'DIA'));
  });

  it('is linked only when the bot is in that org’s own server', function () {
    const listed = redArmy.report(roster, GUILDS, {
      homeGuildId: HOME,
      alliance
    });
    const bySymbol = Object.fromEntries(listed.organizations.map((org) => [org.symbol, org]));
    assert.deepStrictEqual(bySymbol.RR.discord, { linked: false });
    assert.deepStrictEqual(bySymbol.SHELLBACKS.discord, { linked: true, name: 'SC Shellback' });
    assert.deepStrictEqual(bySymbol.MB.discord, { linked: false });
    assert.deepStrictEqual(bySymbol.RR.officers, [{ name: 'mr_meaner' }]);
    assert.deepStrictEqual(bySymbol.SHELLBACKS.officers, [{ name: 'Brock_85' }]);
    assert.deepStrictEqual(bySymbol.SHELLBACKS.rsi, {
      symbol: 'SHELLBACK',
      url: 'https://robertsspaceindustries.com/orgs/SHELLBACK'
    });
    assert.deepStrictEqual(listed.servers.map((row) => [row.id, row.name, row.discord.linked, row.note || null]), [
      ['dia', 'DIA', true, 'Private Discord — not linked to an RSI org.'],
      ['random-org', 'Random Org', true, null]
    ]);
    assert.deepStrictEqual(listed.servers[0].discord, { linked: true, name: 'DIA' });
  });

  it('omits the home server, alliance guilds, and ignored Fabric-suite servers', function () {
    const listed = redArmy.report(roster, GUILDS, { homeGuildId: HOME, alliance });
    const names = listed.organizations.map((org) => org.name).concat(listed.servers.map((row) => row.name));
    assert.ok(!names.includes('G00N SQUAD'));
    assert.ok(!names.includes('Trans-Galactic'));
    assert.ok(!names.includes('fabric'));
    assert.ok(!names.includes("Neorion's server"));
    const body = JSON.stringify(listed);
    assert.ok(!body.includes(HOME) && !body.includes(SHELLBACKS) && !body.includes(DIA));
    assert.ok(!body.includes(FABRIC) && !body.includes(NEORION) && !body.includes(TRDE));
    assert.ok(!body.includes(MR_MEANER) && !body.includes(BROCK));
    assert.ok(!/\d{17,}/.test(body), 'no Discord ids');
  });

  it('refuses a roster without officer names', function () {
    assert.throws(() => redArmy.parseRoster({
      organizations: [{ symbol: 'RR', officers: ['discord:503419731286556703'] }]
    }), /officer is \{ account, name \}/);
  });

  it('serves the public list without guild ids', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'red-army-'));
    const file = path.join(dir, 'red-army.json');
    fs.writeFileSync(file, JSON.stringify(contract));
    const service = new RedArmy({
      file,
      homeGuildId: HOME,
      alliance,
      discordGuilds: GUILDS
    });
    await service.start();
    try {
      const listed = await service.report();
      assert.strictEqual(listed.organizations[0].symbol, 'RR');
      const got = await new Promise((resolve) => {
        const res = {
          headersSent: false,
          statusCode: 200,
          setHeader () {},
          end (payload) { resolve({ status: this.statusCode, body: JSON.parse(payload) }); }
        };
        service.middleware()({ method: 'GET', url: '/services/red-army', path: '/services/red-army' }, res, () => resolve({ status: 'next' }));
      });
      assert.strictEqual(got.status, 200);
      assert.deepStrictEqual(got.body.organizations.map((org) => org.symbol), ORG_SYMBOLS);
      assert.strictEqual(got.body.servers[0].name, 'DIA');
      assert.ok(!/\d{17,}/.test(JSON.stringify(got.body)));
    } finally {
      await service.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
