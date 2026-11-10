'use strict';

const assert = require('assert');
const orgDiscord = require('../functions/orgDiscord');

const GOON = '1190527980120850493';
const TRDE = '937681528790609970';

describe('org Discord status', function () {
  const roster = {
    organizations: [
      { symbol: 'G00N', guildId: GOON },
      { symbol: 'TRDE', guildId: TRDE },
      { symbol: 'INFN' }
    ]
  };
  const guilds = [{ id: GOON, name: 'G00N SQUAD' }];

  it('is linked only when the bot is in that org’s server', function () {
    assert.deepStrictEqual(orgDiscord.view(roster.organizations[0], guilds), { linked: true, name: 'G00N SQUAD' });
    assert.deepStrictEqual(orgDiscord.view(roster.organizations[1], guilds), { linked: false });
    assert.deepStrictEqual(orgDiscord.view(roster.organizations[2], guilds), { linked: false });
  });

  it('omits a snowflake used as the server name', function () {
    assert.deepStrictEqual(orgDiscord.view({ guildId: GOON }, [{ id: GOON, name: GOON }]), { linked: true });
  });

  it('reports each org without guild ids', function () {
    const rows = orgDiscord.report(roster, guilds);
    assert.deepStrictEqual(rows.map((row) => [row.symbol, row.discord.linked, row.discord.name || null]), [
      ['G00N', true, 'G00N SQUAD'],
      ['TRDE', false, null],
      ['INFN', false, null]
    ]);
    assert.ok(!JSON.stringify(rows).includes(GOON) && !JSON.stringify(rows).includes(TRDE));
  });
});
