'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');
const Activity = require('../services/activity');

const GUILD = '1190527980120850493';
const DAY = 24 * 60 * 60 * 1000;
const EPOCH = 1420070400000n;
const NOW = Date.now();

let sequence = 0n;
function snowflake (ms) {
  sequence += 1n;
  return String(((BigInt(Math.floor(ms)) - EPOCH) << 22n) + (sequence % 4096n));
}

function message (author, daysAgo, extra = {}) {
  return Object.assign({ id: snowflake(NOW - daysAgo * DAY), type: 0, author: { id: author } }, extra);
}

function textResponse (status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

describe('Activity', function () {
  this.timeout(20000);

  let dir;
  let activity;
  let calls;
  let messages;

  function fakeDiscord (url) {
    calls.push(url);
    const { pathname, searchParams } = new URL(url);
    const route = pathname.replace('/api/v10', '');
    if (route === `/guilds/${GUILD}/channels`) {
      return textResponse(200, [
        { id: '10', type: 4, name: 'Text Channels' },
        { id: '11', type: 0, name: 'general' },
        { id: '12', type: 2, name: 'PERMAFLEET' },
        { id: '13', type: 15, name: 'clips' },
        { id: '14', type: 0, name: 'officers' }
      ]);
    }
    if (route === `/guilds/${GUILD}/threads/active`) return textResponse(200, { threads: [] });
    const archived = /^\/channels\/(\d+)\/threads\/archived\/public$/.exec(route);
    if (archived) {
      if (archived[1] === '14') return textResponse(403, { message: 'Missing Access' });
      const threads = archived[1] === '13'
        ? [{ id: '20', type: 11, name: 'my clip', thread_metadata: { archive_timestamp: new Date(NOW - 2 * DAY).toISOString() } }]
        : [];
      return textResponse(200, { threads, has_more: false });
    }
    const read = /^\/channels\/(\d+)\/messages$/.exec(route);
    if (read) {
      if (read[1] === '14') return textResponse(403, { message: 'Missing Access' });
      const all = (messages[read[1]] || []).slice().sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? 1 : -1));
      const limit = Number(searchParams.get('limit'));
      const before = searchParams.get('before');
      const after = searchParams.get('after');
      if (after) return textResponse(200, all.filter((m) => BigInt(m.id) > BigInt(after)).reverse().slice(0, limit).reverse());
      if (before) return textResponse(200, all.filter((m) => BigInt(m.id) < BigInt(before)).slice(0, limit));
      return textResponse(200, all.slice(0, limit));
    }
    return textResponse(404, { message: 'Unknown' });
  }

  function build () {
    return new Activity({
      path: dir,
      discord: { guildId: GUILD },
      refreshOnStart: false,
      ttlMs: 0,
      fetch: async (url) => fakeDiscord(url),
      resolveToken: () => ({ token: 'test-token', source: 'test' })
    });
  }

  beforeEach(async function () {
    calls = [];
    const general = [];
    // 250 posts: three pages back to the start of the channel.
    for (let i = 0; i < 248; i++) general.push(message('300000000000000001', 400 - i));
    general.push(message('300000000000000002', 70));
    general.push(message('300000000000000009', 1, { author: { id: '300000000000000009', bot: true } }));
    general.push(message('300000000000000008', 1, { webhook_id: '5' }));
    general.push(message('300000000000000007', 1, { type: 7 })); // joined the server
    messages = {
      11: general,
      12: [message('300000000000000002', 90)],
      20: [message('300000000000000003', 5)]
    };
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-activity-'));
    activity = build();
    await activity.start();
  });

  afterEach(async function () {
    await activity.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads every readable channel and public thread back to its start, people only', async function () {
    const status = await activity.sync();
    const days = (target) => Math.round((NOW - Date.parse(activity.lastPosted(target))) / DAY);
    assert.strictEqual(days('discord/users/300000000000000001'), 153, 'the newest of 248 posts across three pages');
    assert.strictEqual(days('300000000000000002'), 70, 'the later of a text post and a voice chat post');
    assert.strictEqual(days('discord/users/300000000000000003'), 5, 'a post in an archived forum thread');
    for (const skipped of ['300000000000000009', '300000000000000008', '300000000000000007']) {
      assert.strictEqual(activity.lastPosted(skipped), null, 'bots, webhooks, and join notices are not posts');
    }
    assert.strictEqual(activity.lastPosted('nobody'), null);
    assert.strictEqual(status.members, 3);
    assert.deepStrictEqual(status.channels, { tracked: 4, complete: 3, unreadable: 1 });
    assert.strictEqual(status.backfilled, true);
    assert.ok(status.syncedAt);
    assert.strictEqual(calls.filter((url) => url.includes('/channels/11/messages')).length, 3);
  });

  it('reads only what is new on the next pass, and skips unreadable channels for a day', async function () {
    await activity.sync();
    messages[11].push(message('300000000000000004', 0));
    calls = [];
    await activity.sync();
    const general = calls.filter((url) => url.includes('/channels/11/messages'));
    assert.strictEqual(general.length, 1);
    assert.ok(general[0].includes('after='), 'only messages after the newest one read');
    assert.ok(!calls.some((url) => url.includes('/channels/14/messages')), 'an unreadable channel waits a day');
    assert.ok(activity.lastPosted('300000000000000004'));
  });

  it('notes new posts from the gateway in the home server only, and keeps them across restarts', async function () {
    const operations = new EventEmitter();
    await activity.stop();
    activity = new Activity({ path: dir, discord: { guildId: GUILD }, sync: false, operations });
    await activity.start();
    const client = new EventEmitter();
    operations.emit('gateway', { client });
    const at = NOW - 1000;
    client.emit('messageCreate', { id: snowflake(at), guildId: GUILD, type: 0, createdTimestamp: at, author: { id: '300000000000000005' } });
    client.emit('messageCreate', { id: snowflake(at), guildId: '999', type: 0, createdTimestamp: at, author: { id: '300000000000000006' } });
    client.emit('messageCreate', { id: snowflake(at), guildId: GUILD, type: 0, createdTimestamp: at, author: { id: '300000000000000009', bot: true } });
    assert.strictEqual(Date.parse(activity.lastPosted('300000000000000005')), at);
    assert.strictEqual(activity.lastPosted('300000000000000006'), null);
    assert.strictEqual(activity.lastPosted('300000000000000009'), null);
    assert.strictEqual(client.listenerCount('messageCreate'), 1);

    await activity.stop();
    assert.strictEqual(client.listenerCount('messageCreate'), 0);
    activity = build();
    await activity.start();
    assert.strictEqual(Date.parse(activity.lastPosted('300000000000000005')), at);
  });

  it('serves aggregate counts at GET /services/activity, never ids', async function () {
    await activity.sync();
    const handler = activity.middleware();
    const call = (method, url) => new Promise((resolve) => {
      const res = {
        headers: {},
        setHeader (key, value) { this.headers[key] = value; },
        end (body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); }
      };
      handler({ method, url, originalUrl: url, path: url }, res, () => resolve(null));
    });
    const res = await call('GET', '/services/activity');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.members, 3);
    assert.strictEqual(res.body.backfilled, true);
    assert.ok(res.body.syncedAt);
    assert.ok(!/3000000000000000/.test(JSON.stringify(res.body)), 'no member ids');
    assert.strictEqual((await call('POST', '/services/activity')).status, 405);
    assert.strictEqual(await call('GET', '/services/activity/members'), null);
  });

  it('records a failed pass without losing the last good one', async function () {
    await activity.sync();
    activity._resolveToken = () => ({ token: null });
    await assert.rejects(activity.sync(), /No Discord bot token/);
    const saved = await activity.store.get('/activity/status');
    assert.ok(saved.syncedAt);
    assert.match(saved.error, /No Discord bot token/);
  });
});
