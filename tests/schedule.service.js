'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Commands = require('../services/commands');
const Schedule = require('../services/schedule');

const GUILD = '1190527980120850493';
const VOICE = '1236721094153732276';
const ROLE = '777777777777777777';
const KERSA = { id: '111111111111111111', username: 'kersa', globalName: 'Kersa' };
const RAT = { id: '222222222222222222', username: 'ratgrot', globalName: 'Rat' };
const NAMESAKE = { id: '444444444444444444', username: 'rat2', globalName: 'Rat' };
const PILOT = { id: '555555555555555555', username: 'pilot', globalName: 'Pilot' };
const REF = { id: '333333333333333333', username: 'ref', globalName: 'Referee' };
const START = Date.parse('2026-10-30T15:00:00.000Z');
const SNOWFLAKE = /\d{17,}/;

function cache (items) {
  const map = new Map(items.map((item) => [String(item.id || (item.user && item.user.id)), item]));
  return {
    get: (id) => map.get(String(id)) || null,
    values: () => map.values(),
    keys: () => map.keys()
  };
}

function guildMember (user, extra = {}) {
  return Object.assign({
    user: { id: user.id, username: user.username, global_name: user.globalName, bot: !!user.bot },
    nick: null
  }, extra);
}

function guildWith (members) {
  return {
    id: GUILD,
    name: 'G00N SQUAD',
    members: { cache: cache(members) },
    roles: { cache: cache([{ id: ROLE, name: 'Pilots' }]) }
  };
}

function interaction (opts = {}) {
  const call = {
    commandName: opts.name || null,
    customId: opts.customId || null,
    values: opts.values || null,
    guildId: opts.guildId === undefined ? GUILD : opts.guildId,
    guild: opts.guild || null,
    channelId: '424242424242424242',
    user: opts.user || REF,
    member: opts.member || { displayName: (opts.user || REF).globalName },
    channel: opts.channel || null,
    deferred: false,
    replies: [],
    updates: [],
    followUps: [],
    deferReply: async () => { call.deferred = true; },
    deferUpdate: async () => { call.deferredUpdate = true; },
    editReply: async (payload) => { call.replies.push(payload); },
    followUp: async (payload) => { call.followUps.push(payload); },
    reply: async (payload) => { call.replies.push(payload); },
    update: async (payload) => { call.updates.push(payload); },
    isAutocomplete: () => false,
    isButton: () => opts.customId != null && !Array.isArray(opts.values),
    isStringSelectMenu: () => Array.isArray(opts.values),
    isChatInputCommand: () => opts.customId == null && !Array.isArray(opts.values),
    options: {
      getSubcommand: () => (opts.subcommand === undefined ? 'open' : opts.subcommand),
      getString: (key) => (opts.strings && opts.strings[key] !== undefined ? opts.strings[key] : null),
      getInteger: (key) => (opts.integers && opts.integers[key] !== undefined ? opts.integers[key] : null),
      getRole: (key) => (opts.roles && opts.roles[key]) || null,
      getChannel: (key) => (opts.channels && opts.channels[key]) || null
    }
  };
  return call;
}

describe('schedule service', function () {
  let dir;
  let now;
  let sent;
  let dms;
  let edits;
  let posts;
  let fetches;
  let fetchMode;
  let schedule;

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-schedule-'));
    now = START;
    sent = [];
    dms = [];
    edits = [];
    posts = [];
    fetches = [];
    fetchMode = 'ok';
    schedule = await new Schedule({
      path: dir,
      tick: false,
      now: () => now,
      timeZone: 'America/Chicago',
      discord: {},
      resolveToken: () => ({ token: 'bot-token', source: 'test' }),
      inviteUrl: async () => 'https://discord.com/oauth2/authorize?for=events',
      deliver: async (userId, message) => { dms.push({ userId, message }); },
      edit: async (channelId, messageId, message) => { edits.push({ channelId, messageId, message }); },
      post: async (channelId, message) => { posts.push({ channelId, message }); },
      fetch: async (url, opts = {}) => {
        fetches.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
        if (fetchMode === 'forbidden') {
          return { status: 403, text: async () => JSON.stringify({ message: 'Missing Permissions', code: 50013 }) };
        }
        if (fetchMode === 'unreadable') {
          return { status: 200, text: async () => { throw new Error('The operation was aborted due to timeout'); } };
        }
        const body = opts.body ? JSON.parse(opts.body) : {};
        return {
          status: 200,
          text: async () => JSON.stringify({
            id: '888888888888888888',
            guild_id: GUILD,
            name: body.name,
            description: body.description,
            scheduled_start_time: body.scheduled_start_time,
            scheduled_end_time: body.scheduled_end_time,
            entity_type: body.entity_type,
            channel_id: body.channel_id || null,
            entity_metadata: body.entity_metadata || null
          })
        };
      }
    }).start();
  });

  afterEach(async function () {
    if (schedule) await schedule.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function openInput (extra = {}) {
    return Object.assign({
      guildId: GUILD,
      guildName: 'G00N SQUAD',
      guild: guildWith([guildMember(KERSA), guildMember(RAT)]),
      channelId: '424242424242424242',
      creatorId: REF.id,
      creatorName: 'Referee',
      title: 'Friday Fights',
      people: 'Kersa, Rat',
      roles: [{ id: ROLE, name: 'Pilots' }],
      days: 2,
      times: '7pm',
      length: 2,
      closes: 'in 1 hour',
      zone: 'America/Chicago'
    }, extra);
  }

  it('is a server command with descriptions Discord will accept, only while scheduling runs', function () {
    const definition = Commands.DEFINITIONS.find((entry) => entry.name === 'schedule');
    assert.ok(definition.description.length <= 100, definition.description);
    assert.deepStrictEqual(definition.contexts, [0]);
    for (const option of definition.options) {
      assert.ok(option.description.length <= 100, option.description);
      for (const child of option.options || []) assert.ok(child.description.length <= 100, `${child.name}: ${child.description}`);
    }
    const idle = new Commands({ register: false });
    assert.ok(!idle.definitions.some((entry) => entry.name === 'schedule'));
    const live = new Commands({ register: false, schedule });
    assert.ok(live.definitions.some((entry) => entry.name === 'schedule'));
    const help = live.help(interaction({ name: 'help', strings: { command: 'schedule' }, guildId: null }));
    assert.match(help.content, /\/schedule open title/);
    assert.match(help.content, /https:\/\/goon\.vc\/events/);
  });

  it('posts a poll for named people and a role, then creates the event the opener picks', async function () {
    const commands = new Commands({ register: false, schedule, siteUrl: 'https://goon.vc' });
    const channel = {
      id: '424242424242424242',
      send: async (message) => {
        sent.push(message);
        return { id: '555', delete: async () => {} };
      }
    };
    const guild = guildWith([guildMember(KERSA), guildMember(RAT)]);
    const open = interaction({
      name: 'schedule',
      user: REF,
      member: { displayName: 'Referee' },
      guild,
      channel,
      strings: { title: 'Friday Fights', people: 'Kersa, Rat', times: '7pm', closes: 'in 1 hour', zone: 'America/Chicago' },
      integers: { days: 2, length: 2 },
      roles: { role: { id: ROLE, name: 'Pilots' } }
    });
    await commands.handle(open);
    assert.strictEqual(sent.length, 1);
    assert.deepStrictEqual(sent[0].allowedMentions, { parse: [] });
    assert.ok(!SNOWFLAKE.test(JSON.stringify({ content: sent[0].content, components: sent[0].components })), sent[0].content);
    assert.match(sent[0].content, /Friday Fights/);
    assert.match(sent[0].content, /Kersa/);
    assert.match(sent[0].content, /\*\*Pilots\*\*/);
    assert.strictEqual(sent[0].components[0].components[0].type, 3);
    assert.strictEqual(sent[0].components[0].components[0].options.length, 2);
    assert.match(open.replies[0].content, /I’ll message you/);
    assert.ok(!SNOWFLAKE.test(open.replies[0].content), open.replies[0].content);
    const pollId = sent[0].components[0].components[0].custom_id.split(':')[2];

    const outsider = interaction({
      name: null,
      customId: `sched:vote:${pollId}`,
      values: ['00'],
      user: REF,
      member: { displayName: 'Referee', roles: { cache: cache([]) } }
    });
    await commands.handle(outsider);
    assert.match(outsider.replies[0].content, /people and roles named/);
    assert.strictEqual(outsider.updates.length, 0);

    const kersa = interaction({
      customId: `sched:vote:${pollId}`,
      values: ['00', '01'],
      user: KERSA,
      member: { displayName: 'Kersa', roles: { cache: cache([]) } }
    });
    await commands.handle(kersa);
    assert.match(kersa.updates[0].content, /1\*\* person has answered|\*\*1\*\* person has answered/);

    const pilot = interaction({
      customId: `sched:vote:${pollId}`,
      values: ['00'],
      user: PILOT,
      member: { displayName: 'Pilot', roles: { cache: cache([{ id: ROLE, name: 'Pilots' }]) } }
    });
    await commands.handle(pilot);
    assert.match(pilot.updates[0].content, /\*\*2\*\* people have answered/);

    now = START + 2 * 60 * 60 * 1000;
    await schedule.sweep();
    assert.strictEqual(dms.length, 1);
    assert.strictEqual(dms[0].userId, REF.id);
    assert.match(dms[0].message.content, /Kersa/);
    assert.match(dms[0].message.content, /Pilot/);
    assert.match(dms[0].message.content, /Haven’t answered: Rat/);
    assert.ok(!SNOWFLAKE.test(dms[0].message.content), dms[0].message.content);
    assert.strictEqual(edits[0].messageId, '555');
    assert.deepStrictEqual(edits[0].message.components, []);
    const buttons = dms[0].message.components.flatMap((row) => row.components);
    assert.deepStrictEqual(buttons.map((button) => button.custom_id.split(':')[1]), ['pick', 'pick', 'skip']);

    const stolen = interaction({ customId: buttons[0].custom_id, user: KERSA, guildId: null });
    await commands.handle(stolen);
    assert.match(stolen.followUps[0].content, /Only the person who opened/);
    assert.strictEqual(fetches.length, 0);

    const pick = interaction({ customId: buttons[0].custom_id, user: REF, guildId: null });
    await commands.handle(pick);
    assert.strictEqual(fetches.length, 1);
    assert.match(fetches[0].url, new RegExp(`/guilds/${GUILD}/scheduled-events$`));
    assert.strictEqual(fetches[0].method, 'POST');
    assert.strictEqual(fetches[0].body.entity_type, 3);
    assert.strictEqual(fetches[0].body.privacy_level, 2);
    assert.deepStrictEqual(fetches[0].body.entity_metadata, { location: 'G00N SQUAD' });
    assert.strictEqual(fetches[0].body.channel_id, undefined);
    assert.strictEqual(fetches[0].body.scheduled_start_time, '2026-10-31T00:00:00.000Z');
    assert.match(fetches[0].body.description, /Can make it: Kersa, Pilot/);
    assert.ok(!SNOWFLAKE.test(fetches[0].body.description), fetches[0].body.description);
    assert.match(pick.replies[0].content, /https:\/\/discord\.com\/events\//);
    assert.match(pick.replies[0].content, /https:\/\/goon\.vc\/events/);
    assert.match(edits[1].message.content, /https:\/\/discord\.com\/events\//);

    const again = interaction({ customId: buttons[0].custom_id, user: REF, guildId: null });
    await commands.handle(again);
    assert.strictEqual(fetches.length, 1, 'picking twice does not create a second event');
    assert.match(again.replies[0].content, /discord\.com\/events/);
  });

  it('refuses an ambiguous name, a missing audience, and a fourth open poll', async function () {
    await assert.rejects(
      schedule.open(openInput({
        guild: guildWith([guildMember(RAT), guildMember(NAMESAKE)]),
        people: 'Rat',
        roles: []
      })),
      (error) => error.status === 400 && /@handle/.test(error.message)
    );
    await assert.rejects(
      schedule.open(openInput({ people: '', roles: [] })),
      (error) => error.status === 400 && /Name someone or pick a role/.test(error.message)
    );
    for (let n = 0; n < 3; n++) await schedule.open(openInput({ title: `Poll ${n}` }));
    await assert.rejects(schedule.open(openInput({ title: 'Poll 3' })), (error) => error.status === 400 && /3 open polls/.test(error.message));
  });

  it('creates a voice event, and keeps the choice when Discord refuses', async function () {
    const record = await schedule.open(openInput({
      voice: { id: VOICE, name: 'Ops', type: 2 },
      people: 'Kersa',
      roles: [],
      days: 1
    }));
    await schedule.vote(record.id, { userId: KERSA.id, name: 'Kersa', roleIds: [], slots: ['00'] });
    now = START + 2 * 60 * 60 * 1000;
    await schedule.sweep();
    const slot = dms[0].message.components[0].components[0].custom_id.split(':')[3];

    fetchMode = 'forbidden';
    await assert.rejects(schedule.pick(record.id, REF.id, slot), (error) => error.status === 403 && /authorize\?for=events/.test(error.message));
    assert.strictEqual((await schedule.store.get(`/polls/${record.id}`)).status, 'choosing');

    fetchMode = 'ok';
    const created = await schedule.pick(record.id, REF.id, slot);
    assert.strictEqual(created.status, 'scheduled');
    const voice = fetches.filter((call) => call.method === 'POST').pop();
    assert.strictEqual(voice.body.entity_type, 2);
    assert.strictEqual(voice.body.channel_id, VOICE);
    assert.strictEqual(voice.body.entity_metadata, undefined);
    assert.match(voice.body.description, /Channel: Ops/);
  });

  it('warns the opener when Discord may already have created the event', async function () {
    const record = await schedule.open(openInput({ people: 'Kersa', roles: [], days: 1 }));
    await schedule.vote(record.id, { userId: KERSA.id, name: 'Kersa', roleIds: [], slots: ['00'] });
    now = START + 2 * 60 * 60 * 1000;
    await schedule.sweep();
    const slot = dms[0].message.components[0].components[0].custom_id.split(':')[3];
    fetchMode = 'unreadable';
    await assert.rejects(
      schedule.pick(record.id, REF.id, slot),
      (error) => error.status === 502 && /already have created/.test(error.message)
    );
    assert.strictEqual((await schedule.store.get(`/polls/${record.id}`)).status, 'choosing');
  });

  it('falls back to the channel when the opener’s DMs are closed, and skip creates nothing', async function () {
    schedule.settings.deliver = async () => {
      throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
    };
    const record = await schedule.open(openInput({ people: 'Kersa', roles: [], days: 1 }));
    await schedule.vote(record.id, { userId: KERSA.id, name: 'Kersa', roleIds: [], slots: ['00'] });
    now = START + 2 * 60 * 60 * 1000;
    await schedule.sweep();
    assert.strictEqual(posts.length, 1);
    assert.match(posts[0].message.content, /couldn’t DM you/i);
    const commands = new Commands({ register: false, schedule, siteUrl: 'https://goon.vc' });
    const skip = posts[0].message.components.flatMap((row) => row.components).find((button) => button.custom_id.includes(':skip:'));
    const call = interaction({ customId: skip.custom_id, user: REF, guildId: null });
    await commands.handle(call);
    assert.match(call.replies[0].content, /no event/);
    assert.strictEqual(fetches.filter((entry) => entry.method === 'POST').length, 0);
    assert.strictEqual((await schedule.store.get(`/polls/${record.id}`)).status, 'cancelled');
  });

  it('drops the poll when the channel refuses the message, and points at the events invite', async function () {
    const commands = new Commands({ register: false, schedule, siteUrl: 'https://goon.vc' });
    const call = interaction({
      name: 'schedule',
      user: REF,
      guild: guildWith([guildMember(KERSA)]),
      channel: {
        id: '424242424242424242',
        send: async () => { throw Object.assign(new Error('Missing Permissions'), { code: 50013 }); }
      },
      strings: { title: 'Friday Fights', people: 'Kersa', closes: 'in 1 hour' },
      integers: { days: 1 }
    });
    await commands.handle(call);
    assert.match(call.replies[0].content, /authorize\?for=events/);
    assert.deepStrictEqual(((await schedule.store.get('/schedule/index')) || { ids: [] }).ids, []);
  });

  it('tells the opener when nobody answered, and only the opener can close it', async function () {
    const record = await schedule.open(openInput({ people: 'Kersa', roles: [], days: 1 }));
    await assert.rejects(schedule.close(record.id, KERSA.id, GUILD), (error) => error.status === 403);
    assert.strictEqual((await schedule.store.get(`/polls/${record.id}`)).status, 'open');
    now = START + 2 * 60 * 60 * 1000;
    const closed = await schedule.close(null, REF.id, GUILD);
    assert.strictEqual(closed.status, 'cancelled');
    assert.match(dms[0].message.content, /Nobody answered/);
    assert.deepStrictEqual(dms[0].message.components, []);
  });

  it('retries an offer that failed, without sending it twice', async function () {
    let fail = true;
    schedule.settings.deliver = async (userId, message) => {
      if (fail) throw new Error('socket');
      dms.push({ userId, message });
    };
    const record = await schedule.open(openInput({ people: 'Kersa', roles: [], days: 1 }));
    await schedule.vote(record.id, { userId: KERSA.id, name: 'Kersa', roleIds: [], slots: ['00'] });
    now = START + 2 * 60 * 60 * 1000;
    await schedule.sweep();
    assert.strictEqual(dms.length, 0);
    assert.strictEqual((await schedule.store.get(`/polls/${record.id}`)).offered, false);
    fail = false;
    await schedule.sweep();
    assert.strictEqual(dms.length, 1);
    await schedule.sweep();
    assert.strictEqual(dms.length, 1);
  });
});
