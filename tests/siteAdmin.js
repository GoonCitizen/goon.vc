'use strict';

const assert = require('assert');
const Key = require('@fabric/core/types/key');
const Bech32 = require('@fabric/core/types/bech32');
const { fabricIdentityIdFromPubkeyHex } = require('@fabric/core/functions/fabricIdentitySchnorr');
const home = require('../contracts/goon-squad.json');
const { accountKey } = require('../functions/accountKey');
const { normalizeAdmins, fabricIdentityId, authIdentityIds, memberIsAdmin } = require('../functions/siteAdmin');

describe('site admins', function () {
  const key = new Key();
  const identityId = fabricIdentityIdFromPubkeyHex(key.pubkey);
  const xonly = accountKey('fabric', key.pubkey).id;

  it('records remaeus by Discord id and Fabric identity, not by a handle', function () {
    const decoded = Bech32.decode(home.admins[0].fabric);
    assert.strictEqual(decoded.prefix, 'id');
    assert.strictEqual(Buffer.from(decoded.content).length, 32);
    const admins = normalizeAdmins(home.admins);
    assert.deepStrictEqual(admins, [{
      name: 'remaeus',
      discord: '420222636954615808',
      fabric: 'id1yqr9kjh0h3mxrjnrhermxnetkpgsk2zgcj9es5hlqr5ft75hv9zq6s7hsu'
    }]);
    const named = {
      displayName: 'ChairmanPoW',
      accounts: [{ platform: 'rsi', id: 'ChairmanPoW', profile: { displayName: 'ChairmanPoW' } }]
    };
    assert.strictEqual(memberIsAdmin(named, home.admins), false);
    assert.strictEqual(memberIsAdmin({
      displayName: 'remaeus',
      accounts: [{ platform: 'discord', id: '420222636954615808' }]
    }, home.admins), true);
  });

  it('matches a Passport key by its compressed pubkey, not the other parity', function () {
    const account = { platform: 'fabric', id: xonly, profile: { pubkeyHex: key.pubkey } };
    assert.strictEqual(fabricIdentityId(account), identityId);
    assert.deepStrictEqual(authIdentityIds(account), [identityId]);
    assert.strictEqual(memberIsAdmin({ accounts: [account] }, [{ fabric: identityId }]), true);
    const flipped = (key.pubkey.startsWith('02') ? '03' : '02') + key.pubkey.slice(2);
    assert.strictEqual(memberIsAdmin({ accounts: [account] }, [{ fabric: fabricIdentityIdFromPubkeyHex(flipped) }]), false);
  });

  it('matches an x-only key by either parity, and does not invent an id to display', function () {
    const account = { platform: 'fabric', id: xonly, profile: {} };
    assert.strictEqual(fabricIdentityId(account), null);
    assert.ok(authIdentityIds(account).includes(identityId));
    assert.strictEqual(memberIsAdmin({ accounts: [account] }, [{ fabric: identityId }]), true);
    assert.strictEqual(memberIsAdmin({ accounts: [account] }, [{ fabric: 'id1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqx7k' }]), false);
  });

  it('ignores an admin record with neither a Discord id nor a Fabric identity', function () {
    assert.deepStrictEqual(normalizeAdmins([{ name: 'someone', also: ['ChairmanPoW'] }]), []);
    assert.strictEqual(memberIsAdmin({ accounts: [{ platform: 'discord', id: '1' }] }, []), false);
  });
});
