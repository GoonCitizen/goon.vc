'use strict';

const assert = require('assert');
const alliance = require('../contracts/alliance.json');
const organizations = require('../contracts/organizations.json');
const { recordInvites, setupRows } = require('../functions/orgSetup');

const GOON = '1190527980120850493';

describe('organization setup', function () {
  const rows = setupRows({
    alliance,
    organizations,
    guilds: [{ id: GOON, name: 'G00N SQUAD' }],
    members: [{
      displayName: 'ConvergedGaming',
      accounts: [{ platform: 'discord', id: '511146587515256832', profile: { username: 'convergedgaming' } }]
    }]
  });
  const bySymbol = Object.fromEntries(rows.map((row) => [row.symbol, row]));

  it('keeps every shared invite and the server it opens', function () {
    assert.strictEqual(bySymbol.G00N.discord.invite, 'https://discord.gg/rDDUfZGdRN');
    assert.strictEqual(bySymbol.TRDE.discord.invite, 'https://discord.gg/GGMQYSf5S7');
    assert.strictEqual(bySymbol['4MCONTRACT'].discord.invite, 'https://discord.gg/4m-contractors');
    assert.strictEqual(bySymbol.IDBC.discord.invite, 'https://discord.gg/riskyb');
    assert.strictEqual(bySymbol.H0K.discord.invite, 'https://discord.gg/khans');
    assert.strictEqual(bySymbol.MB.discord.invite, 'https://discord.gg/SpaceMonkey');
    assert.strictEqual(bySymbol.H0K.discord.configured, true);
    assert.strictEqual(bySymbol.MB.discord.configured, true);
    assert.deepStrictEqual(recordInvites({ history: ['Discord Server:', 'https://discord.gg/4m-contractors'] }), ['https://discord.gg/4m-contractors']);
  });

  it('says which servers the bot is actually in', function () {
    assert.strictEqual(bySymbol.G00N.discord.bot, true);
    assert.strictEqual(bySymbol.G00N.discord.server, 'G00N SQUAD');
    assert.strictEqual(bySymbol.INFN.discord.bot, true);
    assert.deepStrictEqual(bySymbol.INFN.discord.shared.slice().sort(), ['DOUBLEDOGZ', 'G00N']);
    assert.strictEqual(bySymbol.TRDE.discord.bot, false);
    assert.strictEqual(bySymbol['4MCONTRACT'].discord.bot, false);
    assert.strictEqual(bySymbol.IDBC.discord.bot, false);
    assert.strictEqual(bySymbol.H0K.discord.bot, false);
    assert.strictEqual(bySymbol.MB.discord.bot, false);
    assert.strictEqual(bySymbol.LCRP.discord.configured, false);
    assert.strictEqual(bySymbol.LCRP.discord.invite, null);
    assert.strictEqual(bySymbol.OBSX.discord.configured, false);
    const unchecked = setupRows({ alliance, organizations });
    assert.strictEqual(unchecked.find((row) => row.symbol === 'G00N').discord.bot, null);
  });

  it('lists the officers on record, with a name when one is known', function () {
    assert.deepStrictEqual(bySymbol.G00N.officers.map((officer) => officer.account), [
      'discord:420222636954615808',
      'discord:191401936245882880',
      'discord:355141171095404554'
    ]);
    assert.strictEqual(bySymbol.INFN.officers[0].account, 'discord:214804563826311169');
    assert.strictEqual(bySymbol.INFN.officers.length, 8);
    assert.strictEqual(bySymbol.H0K.officers[0].account, 'discord:991362165586018324');
    assert.deepStrictEqual(bySymbol.OBSX.officers.map((officer) => officer.account), [
      'discord:1508231561454026993',
      'discord:123863917909901315',
      'discord:342965730779856896'
    ]);
    assert.deepStrictEqual(bySymbol.MB.officers.map((officer) => [officer.account, officer.name]), [
      ['discord:511146587515256832', 'ConvergedGaming'],
      ['discord:813203402543988757', null]
    ]);
    assert.deepStrictEqual(bySymbol.TRDE.officers.map((officer) => officer.account), [
      'discord:357882771227803668',
      'discord:280539499170234379',
      'discord:161858332712370176'
    ]);
    assert.deepStrictEqual(bySymbol.LCRP.officers.map((officer) => officer.account), [
      'discord:525468619782750209',
      'discord:1103845961043816548',
      'discord:161858332712370176'
    ]);
    assert.deepStrictEqual(bySymbol['4MCONTRACT'].officers.map((officer) => officer.account), [
      'discord:197877020451930112',
      'discord:758034681475104788',
      'discord:570746844817260565'
    ]);
    assert.deepStrictEqual(bySymbol.IDBC.officers.map((officer) => officer.account), [
      'discord:322940310567124992',
      'discord:292455599831121921'
    ]);
    assert.ok(!JSON.stringify(rows).includes(GOON), 'the view does not carry server ids');
  });
});
