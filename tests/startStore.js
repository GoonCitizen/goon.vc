'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');

const SNOWFLAKE = '1300000000000000001';
const OTHER = '1300000000000000002';

describe('startStore', function () {
  this.timeout(10000);
  let dir;
  let store;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-store-'));
  });

  afterEach(async function () {
    if (store) await store.stop();
    store = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps Discord snowflakes as map keys, not array indexes', async function () {
    store = await startStore(new Store({ name: 'test', path: dir, persistent: true, verbosity: 1 }));
    await store.set(`/channels/${SNOWFLAKE}`, { id: SNOWFLAKE, cursor: '1' });
    await store.set(`/channels/${OTHER}`, { id: OTHER, cursor: '2' });
    await store.set('/clips/5001', { id: '5001' });
    await store.set('/clips/5001-l0', { id: '5001-l0' });
    assert.deepStrictEqual(await store.get(`/channels/${SNOWFLAKE}`), { id: SNOWFLAKE, cursor: '1' });
    assert.deepStrictEqual(await store.get(`/channels/${OTHER}`), { id: OTHER, cursor: '2' });
    assert.deepStrictEqual(await store.get('/clips/5001-l0'), { id: '5001-l0' });
  });

  it('still stores a leaf array under /index', async function () {
    store = await startStore(new Store({ name: 'test', path: dir, persistent: true, verbosity: 1 }));
    await store.set('/index/clips', ['5001', '5001-l0']);
    assert.deepStrictEqual(await store.get('/index/clips'), ['5001', '5001-l0']);
  });
});
