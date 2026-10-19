'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const Presence = require('../services/presence');

const GUILD = '1190527980120850493';
const VOICE = '1236721094153732276';

/** Stands in for the `@fabric/discord` client Operations runs. */
class FakeDiscord extends EventEmitter {
  constructor () {
    super();
    this.botReady = false;
    this.voice = { active: {} };
  }
}

/** Stands in for services/operations.js: owns the gateway, emits `gateway`. */
class FakeOperations extends EventEmitter {
  constructor () {
    super();
    this.discord = null;
    this.gateway = { status: 'disabled', error: null };
  }

  connect () {
    this.discord = new FakeDiscord();
    this.gateway = { status: 'connected', error: null };
    this.emit('gateway', this.discord);
    return this.discord;
  }
}

describe('Presence service (Doorman + IdleRPG)', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-presence-'));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('posts game announcements only to the configured announcement channel', async function () {
    const ANNOUNCE = '1560112808283086929';
    const operations = new FakeOperations();
    const presence = new Presence({ path: path.join(dir, 'store'), tickMs: 0, operations, announcements: [ANNOUNCE] });
    await presence.start();
    const discord = operations.connect();
    const posted = [];
    discord.postToChannel = async (channel, text) => { posted.push({ channel, text }); return {}; };

    discord.emit('voice', { guildId: GUILD, userId: '111111111111111111', oldChannelId: null, newChannelId: VOICE, channelName: 'PERMAFLEET' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(posted.length, 1);
    assert.strictEqual(posted[0].channel, ANNOUNCE);
    assert.ok(posted[0].text.startsWith('Welcome to IdleRPG'));
    assert.ok(!posted[0].text.includes('111111111111111111'), 'no member ids in public posts');
    assert.strictEqual(presence.adapter.canSend, false, 'commands are never answered');
    await presence.stop();
  });

  it('fights @fabric/rpg encounters and reports battles without ids', async function () {
    const ANNOUNCE = '1560112808283086929';
    const operations = new FakeOperations();
    const presence = new Presence({ path: path.join(dir, 'store'), tickMs: 0, luck: 1, operations, announcements: [ANNOUNCE] });
    await presence.start();
    const discord = operations.connect();
    const posted = [];
    discord.postToChannel = async (channel, text) => { posted.push({ channel, text }); return {}; };

    discord.emit('voice', { guildId: GUILD, userId: '111111111111111111', oldChannelId: null, newChannelId: VOICE, channelName: 'PERMAFLEET' });
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 30; i++) await presence.game.tick();
    await new Promise((resolve) => setImmediate(resolve));

    const report = await presence.report();
    assert.ok(report.battles.total > 0, 'battles fought');
    assert.strictEqual(report.kills, report.battles.won);
    assert.ok(report.slain.every((row) => typeof row.name === 'string' && row.count > 0));
    const board = await presence.players(10);
    assert.ok(board.players[0].kills > 0);
    assert.ok(posted.length > 1 && posted.every((p) => p.channel === ANNOUNCE));
    const everything = JSON.stringify([report, board, posted]);
    assert.ok(!everything.includes('111111111111111111'), 'no member ids');
    assert.ok(!everything.includes('discord/users'), 'no namespaced ids');
    await presence.stop();
  });

  it('attaches to the operations gateway and counts voice presence without ids', async function () {
    const operations = new FakeOperations();
    const presence = new Presence({ path: path.join(dir, 'store'), tickMs: 0, operations });
    await presence.start();
    assert.strictEqual(presence.doorman.http, null, 'no second HTTP server');
    assert.ok(presence.doorman.plugins.idlerpg);
    let report = await presence.report();
    assert.strictEqual(report.gateway.status, 'waiting');
    assert.strictEqual(report.presentNow, 0);

    const discord = operations.connect();
    assert.strictEqual(presence.gateway.status, 'attached');
    assert.ok(presence.doorman.services.discord, 'Doorman Discord adapter enabled');
    assert.strictEqual(presence.doorman.services.discord.owned, false, 'adapter attaches, never logs in');

    discord.emit('voice', { guildId: GUILD, userId: '111111111111111111', oldChannelId: null, newChannelId: VOICE, channelName: 'PERMAFLEET' });
    discord.emit('voice', { guildId: GUILD, userId: '222222222222222222', oldChannelId: null, newChannelId: VOICE, channelName: 'PERMAFLEET' });
    await new Promise((resolve) => setImmediate(resolve));
    await presence.game.tick();

    report = await presence.report();
    assert.strictEqual(report.presentNow, 2);
    assert.strictEqual(report.uniquePlayers, 2);
    assert.strictEqual(report.totalTicks, 1);
    assert.strictEqual(report.gateway.discord, 'connected');
    const body = JSON.stringify(report);
    assert.ok(!body.includes('111111111111111111'), 'no member ids');
    assert.ok(!body.includes('discord/users'), 'no namespaced ids');
    assert.strictEqual(report.history.length, 30);
    assert.strictEqual(report.history[29].players, 2, 'today bucket');

    const board = await presence.players(10);
    assert.strictEqual(board.count, 2);
    assert.strictEqual(board.players.length, 2);
    assert.deepStrictEqual(Object.keys(board.players[0]).sort(), ['experience', 'firstSeen', 'hours', 'kills', 'lastSeen', 'level', 'name', 'online', 'rank', 'ticks', 'wealth', 'weapon']);
    assert.strictEqual(board.players[0].rank, 1);
    assert.strictEqual(board.players[0].online, true);
    assert.ok(!JSON.stringify(board).includes('111111111111111111'), 'leaderboard carries no ids');

    discord.emit('voice', { guildId: GUILD, userId: '111111111111111111', oldChannelId: VOICE, newChannelId: null, channelName: 'PERMAFLEET' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual((await presence.report()).presentNow, 1);
    await presence.stop();

    // State survives a restart; nobody is assumed present until the gateway says so.
    const again = new Presence({ path: path.join(dir, 'store'), tickMs: 0, gateway: false });
    await again.start();
    const restored = await again.report();
    assert.strictEqual(restored.totalTicks, 1);
    assert.strictEqual(restored.uniquePlayers, 2);
    assert.strictEqual(restored.presentNow, 0);
    assert.strictEqual(restored.gateway.status, 'disabled');
    await again.stop();
  });

  it('pays voice presence only by default, and text only when configured', async function () {
    const TEXT = '1190527980120850496';
    assert.deepStrictEqual(Presence.gameSources('voice,text'), ['channel', 'text']);
    assert.deepStrictEqual(Presence.gameSources(['status', 'Voice']), ['channel']);

    for (const [sources, expected] of [[undefined, 1], [['voice', 'text'], 2]]) {
      const operations = new FakeOperations();
      const presence = new Presence({ path: path.join(dir, `store-${expected}`), tickMs: 0, operations, sources });
      await presence.start();
      const discord = operations.connect();
      discord.emit('activity', {
        type: 'DiscordMessage',
        actor: { ref: '333333333333333333', username: 'talker' },
        target: { ref: TEXT },
        object: { id: 'm1', content: 'o7' }
      });
      discord.emit('voice', { guildId: GUILD, userId: '111111111111111111', oldChannelId: null, newChannelId: VOICE, channelName: 'PERMAFLEET' });
      await new Promise((resolve) => setImmediate(resolve));
      await presence.game.tick();

      assert.strictEqual((await presence.report()).presentNow, expected);
      assert.strictEqual((await presence.players(10)).count, expected);
      await presence.stop();
    }
  });

  it('names leaderboard pilots from the Discord member cache', async function () {
    const store = path.join(dir, 'store');
    // A pilot saved before names were announced.
    const before = new Presence({ path: store, tickMs: 0, gateway: false });
    await before.start();
    await before.game._handleJoin({ user: 'discord/users/333333333333333333', channel: `discord/channels/${VOICE}` });
    await before.game.tick();
    assert.strictEqual((await before.players()).players[0].name, 'Unknown pilot');
    await before.stop();

    const members = new Map([
      ['111111111111111111', { nickname: 'Neorion', displayName: 'Neorion', user: { username: 'neorion' } }]
    ]);
    const guild = {
      id: GUILD,
      members: {
        cache: members,
        fetch: async (id) => {
          if (id === '333333333333333333') return { nickname: null, displayName: 'Wingman', user: { username: 'wingman' } };
          throw new Error('Unknown Member');
        }
      }
    };
    const operations = new FakeOperations();
    const presence = new Presence({ path: store, tickMs: 0, operations });
    await presence.start();
    const discord = operations.connect();
    discord.client = { guilds: { cache: new Map([[GUILD, guild]]) }, users: { cache: new Map() } };
    discord.emit('voice', { guildId: GUILD, userId: '111111111111111111', oldChannelId: null, newChannelId: VOICE, channelName: 'PERMAFLEET' });
    discord.botReady = true;
    discord.emit('ready');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await presence.game.tick();

    const names = (await presence.players()).players.map((player) => player.name).sort();
    assert.deepStrictEqual(names, ['Neorion', 'Wingman']);
    await presence.stop();
  });

  it('serves GET /services/idlerpg and rejects other methods', async function () {
    const presence = new Presence({ path: path.join(dir, 'store'), tickMs: 0, gateway: false });
    await presence.start();
    const middleware = presence.middleware();
    const call = (method, url) => new Promise((resolve) => {
      const res = {
        headers: {},
        setHeader (k, v) { this.headers[k] = v; },
        end (body) { resolve({ status: this.statusCode, body: body ? JSON.parse(body) : null }); }
      };
      middleware({ method, url, originalUrl: url }, res, () => resolve({ status: 'next' }));
    });
    const ok = await call('GET', '/services/idlerpg');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.body.presentNow, 0);
    assert.ok(ok.body.generatedAt);
    assert.strictEqual((await call('POST', '/services/idlerpg')).status, 405);
    const players = await call('GET', '/services/idlerpg/players?limit=5');
    assert.strictEqual(players.status, 200);
    assert.deepStrictEqual(players.body.players, []);
    assert.strictEqual((await call('GET', '/services/operations')).status, 'next');
    await presence.stop();
  });
});
