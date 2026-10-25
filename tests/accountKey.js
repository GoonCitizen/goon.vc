'use strict';

const assert = require('assert');
const { accountKey, parseAccountKey, fabricPubkey } = require('../functions/accountKey');

const X = 'ab'.repeat(32);

describe('accountKey', function () {
  it('keeps Fabric pubkeys as lowercase x-only hex', function () {
    assert.strictEqual(fabricPubkey('02' + X.toUpperCase()), X);
    assert.strictEqual(fabricPubkey('0x03' + X), X);
    assert.strictEqual(fabricPubkey(X), X);
    assert.strictEqual(fabricPubkey('04' + X), null);
    assert.strictEqual(fabricPubkey('02ab'), null);
    assert.deepStrictEqual(accountKey('fabric', '02' + X), { platform: 'fabric', id: X, key: `fabric:${X}` });
  });

  it('accepts Discord snowflakes only', function () {
    assert.strictEqual(accountKey('discord', '123456789012345678').key, 'discord:123456789012345678');
    assert.strictEqual(accountKey('discord', 'goon'), null);
    assert.strictEqual(accountKey('Discord', ' 12345 ').key, 'discord:12345');
  });

  it('takes other platforms as they come', function () {
    assert.deepStrictEqual(parseAccountKey('slack:T01/U02'), null);
    assert.deepStrictEqual(parseAccountKey('slack:T01-U02'), { platform: 'slack', id: 'T01-U02', key: 'slack:T01-U02' });
    assert.strictEqual(parseAccountKey('rsi:Goon_Pilot').key, 'rsi:Goon_Pilot');
    assert.strictEqual(parseAccountKey('1bad:x'), null);
    assert.strictEqual(parseAccountKey('nocolon'), null);
    assert.strictEqual(parseAccountKey('slack:'), null);
    assert.strictEqual(parseAccountKey(`fabric:02${X}`).key, `fabric:${X}`);
  });
});
