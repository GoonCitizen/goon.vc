'use strict';

const assert = require('assert');
const alliance = require('../contracts/alliance.json');
const home = require('../contracts/goon-squad.json');
const settings = require('../settings/local');
const allianceChannels = require('../functions/allianceChannels');
const allianceRoles = require('../functions/allianceRoles');

const REMAEUS = 'discord:420222636954615808';
const KERSA = 'discord:191401936245882880';
const THEJOHNRAM = 'discord:355141171095404554';

describe('G00N SQUAD home Discord', function () {
  it('lists remaeus, kersa, and thejohnram as G00N officers', function () {
    const goon = alliance.organizations.find((org) => org.symbol === 'G00N');
    assert.ok(goon);
    assert.deepStrictEqual(goon.officers, [REMAEUS, KERSA, THEJOHNRAM]);
  });

  it('pins the live #clips, #embassy, PERMAFLEET voice, and Prospect ranks', function () {
    assert.strictEqual(home.guildId, '1190527980120850493');
    assert.strictEqual(home.channels.clips.id, '1502724643084304424');
    assert.strictEqual(home.channels.embassy.id, '1205022843402977310');
    assert.strictEqual(home.channels.voice.id, '1236721094153732276');
    assert.strictEqual(home.roles['[P] Prospect I'], '1234735430587514970');
    assert.strictEqual(home.roles['[P4] Prospect IV'], '1234739335312703548');
    assert.strictEqual(home.roles.PERMAFLEET, '1298457632431931413');
    assert.ok(settings.clips.channels.includes(home.channels.clips.id));
    assert.ok(settings.clips.channels.includes(home.channels.videos.id));
    assert.ok(settings.clips.channels.includes(home.channels.screenshots.id));
    assert.ok(settings.clips.streams.channels.includes(home.channels.streams.id));
    assert.deepStrictEqual(home.campaignSenders, ['420222636954615808']);
    assert.deepStrictEqual(settings.community.campaigns.senders, ['420222636954615808']);
    assert.strictEqual(allianceChannels.homeChannelId('embassy', home.guildId), home.channels.embassy.id);
    assert.strictEqual(allianceChannels.homeChannelId('voice', home.guildId), home.channels.voice.id);
    assert.strictEqual(allianceChannels.homeChannelId('embassy', '99'), null);
  });

  it('counts G00N Prospect ranks by the pinned ids even when renamed', function () {
    const cache = new Map([
      [home.roles['[P] Prospect I'], { id: home.roles['[P] Prospect I'], name: 'New joiners' }],
      [home.roles['[P2] Prospect II'], { id: home.roles['[P2] Prospect II'], name: '[P2] Prospect II' }]
    ]);
    cache.values = cache.values.bind(cache);
    const guild = { id: home.guildId, roles: { cache } };
    assert.deepStrictEqual(allianceRoles.missingProspects(guild).map((entry) => entry.rank), [3, 4, 5, 6]);
    assert.strictEqual(allianceRoles.homeProspectRank(home.roles['[P] Prospect I']), 1);
    assert.strictEqual(allianceRoles.homeProspectRank(home.roles.PERMAFLEET), null);
  });
});
