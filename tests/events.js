'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Events = require('../services/events');

function textResponse (status, body) {
  return {
    status,
    headers: { get: () => null },
    text: async () => JSON.stringify(body)
  };
}

const GOON = '1190527980120850493';
const ALLY = '222222222222222222';
const LOCKED = '333333333333333333';

function discordEvent (id, guildId, name, start, extra = {}) {
  return Object.assign({
    id,
    guild_id: guildId,
    name,
    scheduled_start_time: start,
    entity_type: 2,
    status: 1,
    user_count: 3
  }, extra);
}

describe('Events', function () {
  this.timeout(20000);

  const calls = [];
  let discordUp = true;
  let allyUp = true;
  let events;
  let storePath;

  function stubFetch (url, opts = {}) {
    calls.push(url);
    assert.strictEqual(opts.headers.Authorization, 'Bot test-token');
    if (!discordUp) return Promise.reject(new Error('getaddrinfo ENOTFOUND discord.com'));
    if (url.startsWith('https://discord.com/api/v10/users/@me/guilds')) {
      return Promise.resolve(textResponse(200, [
        { id: GOON, name: 'G00N SQUAD', icon: 'abc' },
        { id: ALLY, name: 'Ally Org', icon: null },
        { id: LOCKED, name: 'Locked Server', icon: null }
      ]));
    }
    if (url === `https://discord.com/api/v10/guilds/${GOON}/scheduled-events?with_user_count=true`) {
      return Promise.resolve(textResponse(200, [
        discordEvent('11', GOON, 'FIGHTER FRIDAY', '2099-01-02T01:00:00+00:00', {
          recurrence_rule: { frequency: 2, interval: 1, by_weekday: [4] },
          image: 'cover'
        }),
        discordEvent('12', GOON, 'Old op', '2099-01-01T00:00:00+00:00', { status: 3 }),
        discordEvent('13', GOON, 'Mining now', '2099-01-03T00:00:00+00:00', { status: 2 }),
        discordEvent('14', GOON, 'Already over', '2000-01-01T00:00:00+00:00', { scheduled_end_time: '2000-01-01T02:00:00+00:00' })
      ]));
    }
    if (url === `https://discord.com/api/v10/guilds/${ALLY}/scheduled-events?with_user_count=true`) {
      if (!allyUp) return Promise.resolve(textResponse(429, { message: 'You are being rate limited.' }));
      return Promise.resolve(textResponse(200, [
        discordEvent('21', ALLY, 'Ally meetup', '2099-01-01T18:00:00+00:00', {
          entity_type: 3,
          entity_metadata: { location: 'Port Olisar' }
        })
      ]));
    }
    if (url === `https://discord.com/api/v10/guilds/${LOCKED}/scheduled-events?with_user_count=true`) {
      return Promise.resolve(textResponse(403, { message: 'Missing Access' }));
    }
    return Promise.resolve(textResponse(404, { message: 'Unknown' }));
  }

  before(async function () {
    storePath = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-events-'));
    events = new Events({
      path: storePath,
      fetch: stubFetch,
      resolveToken: () => ({ token: 'test-token', source: 'test' }),
      ttlMs: 60000
    });
    await events.start();
  });

  after(async function () {
    if (events) await events.stop();
    fs.rmSync(storePath, { recursive: true, force: true });
  });

  it('merges upcoming events from every guild the bot is in', async function () {
    const result = await events.list();
    assert.strictEqual(result.source, 'discord');
    assert.ok(!result.stale);
    assert.deepStrictEqual(result.events.map((e) => e.id), ['13', '21', '11']);

    const live = result.events[0];
    assert.strictEqual(live.status, 'active');
    const ally = result.events[1];
    assert.strictEqual(ally.guildName, 'Ally Org');
    assert.strictEqual(ally.location, 'Port Olisar');
    assert.strictEqual(ally.url, `https://discord.com/events/${ALLY}/21`);
    const friday = result.events[2];
    assert.strictEqual(friday.cadence, 'weekly Friday');
    assert.strictEqual(friday.guildIconUrl, `https://cdn.discordapp.com/icons/${GOON}/abc.png?size=64`);
    assert.strictEqual(friday.imageUrl, 'https://cdn.discordapp.com/guild-events/11/cover.png?size=512');

    const locked = result.guilds.find((g) => g.id === LOCKED);
    assert.strictEqual(locked.count, 0);
    assert.strictEqual(locked.error, 'Missing Access');
  });

  it('serves the stored copy while it is fresh', async function () {
    const before = calls.length;
    await events.list();
    assert.strictEqual(calls.length, before);
  });

  it('keeps a guild\'s saved events when only that guild fails', async function () {
    allyUp = false;
    try {
      const result = await events.list({ force: true });
      assert.ok(!result.stale);
      assert.deepStrictEqual(result.events.map((e) => e.id), ['13', '21', '11']);
      const ally = result.guilds.find((g) => g.id === ALLY);
      assert.ok(/rate limited/.test(ally.error));
      assert.strictEqual(ally.count, 1);
    } finally {
      allyUp = true;
    }
  });

  it('falls back to the stored copy, marked stale, when Discord is down', async function () {
    discordUp = false;
    try {
      const result = await events.list({ force: true });
      assert.strictEqual(result.stale, true);
      assert.ok(/ENOTFOUND/.test(result.error));
      assert.strictEqual(result.events.length, 3);
    } finally {
      discordUp = true;
    }
  });

  it('keeps the stored copy across restarts', async function () {
    await events.stop();
    events = new Events({
      path: storePath,
      fetch: () => Promise.reject(new Error('offline')),
      resolveToken: () => ({ token: 'test-token', source: 'test' }),
      ttlMs: 0
    });
    await events.start();
    const result = await events.list();
    assert.strictEqual(result.stale, true);
    assert.strictEqual(result.events.length, 3);
    const saved = await events.store.get(`/events/guilds/${ALLY}`);
    assert.deepStrictEqual(saved.events.map((e) => e.id), ['21']);
    assert.deepStrictEqual(await events.store.get('/events/guildIndex'), [GOON, ALLY, LOCKED]);
  });

  it('answers from disk without waiting on Discord when the copy is stale', async function () {
    await events.stop();
    let polls = 0;
    events = new Events({
      path: storePath,
      fetch: () => { polls++; return new Promise((resolve) => setTimeout(() => resolve(textResponse(503, { message: 'slow' })), 400)); },
      resolveToken: () => ({ token: 'test-token', source: 'test' }),
      ttlMs: 1,
      refreshIntervalMs: 0,
      refreshOnStart: false
    });
    await events.start();
    const started = Date.now();
    const result = await events.list();
    assert.ok(Date.now() - started < 200, 'served from disk');
    assert.strictEqual(result.stale, true);
    assert.strictEqual(result.events.length, 3);
    assert.strictEqual(polls, 1, 'background poll started');
  });

  it('uses the single-guild schedule snapshot before any fetch succeeds', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-events-snap-'));
    const snapshot = path.join(dir, 'scheduled-events.json');
    fs.writeFileSync(snapshot, JSON.stringify({
      guildId: GOON,
      fetchedAt: '2099-01-01T00:00:00.000Z',
      events: [{ id: '31', guildId: GOON, name: 'SUNDAY FUNDAY', scheduledStartTime: '2099-01-04T18:00:00+00:00', status: 1 }]
    }));
    const cold = new Events({
      path: path.join(dir, 'store'),
      snapshot,
      resolveToken: () => ({ token: null, source: null })
    });
    await cold.start();
    try {
      const result = await cold.list();
      assert.strictEqual(result.source, 'snapshot');
      assert.strictEqual(result.stale, true);
      assert.deepStrictEqual(result.events.map((e) => e.name), ['SUNDAY FUNDAY']);
      assert.strictEqual(result.events[0].guildName, 'G00N SQUAD');
    } finally {
      await cold.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
