'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const Operations = require('../services/operations');

const GUILD = '1190527980120850493';
const ALPHA_VOICE = '1205020182226010152';
const ALPHA_TEXT = '1298475903780782240';

class FakeDiscord extends EventEmitter {
  constructor (settings) {
    super();
    this.settings = settings;
    this.voice = { active: {} };
    FakeDiscord.last = this;
  }

  async start () {
    setImmediate(() => this.emit('ready'));
    return this;
  }

  async stop () { return this; }
}

describe('Operations metrics service', function () {
  let dir;

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-operations-'));
  });

  afterEach(function () {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('connects with non-privileged intents and reports counts only', async function () {
    const file = path.join(dir, 'operations.json');
    fs.writeFileSync(file, JSON.stringify({
      guildId: GUILD,
      operations: [
        { id: 'permafleet', name: 'PERMAFLEET', path: '/operations/PERMAFLEET', metrics: [{ plugin: 'voice', channels: ['1236721094153732276'] }] },
        {
          id: 'alpha-squadron',
          name: 'ALPHA SQUADRON',
          metrics: [{ plugin: 'voice', channels: [ALPHA_VOICE] }, { plugin: 'messages', channels: [ALPHA_TEXT] }]
        },
        { id: 'quiet', name: 'QUIET', metrics: ['voice'] }
      ]
    }));
    const ops = new Operations({
      path: path.join(dir, 'store'),
      file,
      Discord: FakeDiscord,
      resolveToken: () => ({ token: 'test-token', source: 'test' }),
      tickMs: 0,
      flushMs: 10
    });
    await ops.start();
    await ops._gatewayStarting;
    const discord = FakeDiscord.last;
    await new Promise((resolve) => discord.once('ready', resolve));
    await ops.pipeline.dispatch('noop');
    assert.strictEqual(discord.settings.autoCommands, false);
    const { GatewayIntentBits } = require('discord.js');
    assert.ok(!discord.settings.intents.includes(GatewayIntentBits.MessageContent));
    assert.ok(!discord.settings.intents.includes(GatewayIntentBits.GuildMembers));
    assert.ok(discord.settings.intents.includes(GatewayIntentBits.GuildVoiceStates));

    discord.emit('voice', { guildId: GUILD, userId: '111111111111111111', oldChannelId: null, newChannelId: ALPHA_VOICE, channelName: 'ALPHA SQUADRON' });
    discord.emit('activity', { type: 'DiscordMessage', actor: { ref: '111111111111111111' }, object: { content: 'hello there' }, target: { ref: ALPHA_TEXT } });
    await new Promise((resolve) => setImmediate(resolve));

    const report = await ops.report();
    assert.strictEqual(report.gateway.status, 'connected');
    assert.strictEqual(report.operations[0].id, 'alpha-squadron', 'most active first');
    assert.deepStrictEqual(report.operations.slice(1).map((op) => op.id), ['permafleet', 'quiet'], 'ties keep contract order');
    const alpha = report.operations.find((op) => op.id === 'alpha-squadron');
    assert.strictEqual(alpha.path, '/operations/PERMAFLEET#alpha-squadron');
    assert.strictEqual(alpha.metrics.voice.live, 1);
    assert.strictEqual(alpha.metrics.voice.last7Days.sessions, 1);
    assert.strictEqual(alpha.metrics.messages.last7Days.messages, 1);
    const body = JSON.stringify(report);
    assert.ok(!body.includes('111111111111111111'), 'no member ids');
    assert.ok(!body.includes('hello there'), 'no message content');
    await ops.stop();
  });

  it('ranks by live voice, then voice hours, then messages', function () {
    const op = (id, live, hours, messages) => ({
      id,
      metrics: {
        voice: { live, last7Days: { hours } },
        messages: { last7Days: { messages } }
      }
    });
    const ranked = [
      op('quiet', 0, 0, 0),
      op('chatty', 0, 0, 50),
      op('flown', 0, 12, 0),
      op('live', 2, 0, 0),
      { id: 'text-only', metrics: { messages: { last7Days: { messages: 5 } } } }
    ].sort(Operations.byActivity).map((o) => o.id);
    assert.deepStrictEqual(ranked, ['live', 'flown', 'chatty', 'text-only', 'quiet']);
  });

  it('serves stored metrics without a bot token', async function () {
    const ops = new Operations({ path: dir, resolveToken: () => ({ token: null, source: null }), tickMs: 0 });
    await ops.start();
    await ops._gatewayStarting;
    const report = await ops.report();
    assert.strictEqual(report.gateway.status, 'no-token');
    assert.deepStrictEqual(report.operations.map((op) => op.id), ['permafleet'], 'the published contract lists only PERMAFLEET');
    await ops.stop();
  });
});
