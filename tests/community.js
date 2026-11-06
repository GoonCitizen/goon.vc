'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const Community = require('../services/community');
const Presence = require('../services/presence');

// The Scripts plugin ships with @fabric/doorman's next release; until the
// installed copy has it, run against the sibling checkout (`npm run link:doorman`).
const DOORMAN = process.env.FABRIC_DOORMAN || path.resolve(__dirname, '../../doorman');
const HAS_SCRIPTS = fs.existsSync(path.join(DOORMAN, 'services/scripts.js'));
const HAS_CAMPAIGNS = fs.existsSync(path.join(DOORMAN, 'services/campaigns.js'));
const doorman = (file) => require(path.join(DOORMAN, file));

const GUILD = '1190527980120850493';
const ADMIN = '111111111111111111';
const MEMBER = '222222222222222222';
const OWNER = '333333333333333333';
const CLIPS = '1190527980120850501';
const GENERAL = '1190527980120850502';
const VOICE = '1236721094153732276';
const BITS = Community.PERMISSIONS;

function permissions (...bits) {
  const mask = bits.reduce((sum, bit) => sum | bit, 0n);
  return { has: (bit) => (mask & bit) === bit };
}

const ALL = [BITS.ViewChannel, BITS.SendMessages, BITS.ReadMessageHistory];

/** A discord.js Guild with two text channels, a voice channel, and a category. */
function fakeGuild () {
  const me = { permissions: permissions(BITS.ViewChannel, BITS.SendMessages) };
  const category = { id: '1', type: 4, name: 'COMMUNITY', rawPosition: 0 };
  const channels = [
    { id: GENERAL, type: 0, name: 'general', rawPosition: 2, parent: category, permissionsFor: () => permissions(...ALL) },
    { id: CLIPS, type: 0, name: 'clips', rawPosition: 1, parent: category, permissionsFor: () => permissions(BITS.ViewChannel, BITS.SendMessages) },
    { id: VOICE, type: 2, name: 'PERMAFLEET', rawPosition: 3, parent: null, permissionsFor: () => permissions(...ALL) },
    category
  ];
  const roster = {
    [ADMIN]: { permissions: permissions(BITS.ManageGuild) },
    [MEMBER]: { permissions: permissions(BITS.ViewChannel) }
  };
  const guild = {
    id: GUILD,
    name: 'G00N SQUAD',
    ownerId: OWNER,
    fetched: [],
    channels: { cache: new Map(channels.map((channel) => [channel.id, channel])) },
    members: {
      me,
      fetch: async ({ user, force }) => {
        guild.fetched.push({ user, force });
        if (!roster[user]) throw new Error('Unknown Member');
        return roster[user];
      }
    }
  };
  return guild;
}

/** Stands in for the `@fabric/discord` client Operations runs (with its discord.js client). */
class FakeDiscord extends EventEmitter {
  constructor (guild) {
    super();
    this.botReady = true;
    this.voice = { active: {} };
    this.dms = [];
    this.posted = [];
    const raw = new EventEmitter();
    raw.guilds = { cache: new Map([[guild.id, guild]]) };
    raw.isReady = () => true;
    raw.users = {
      fetch: async (id) => ({
        send: async (payload) => {
          if (this.closed) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
          this.dms.push({ id, payload });
          return { id: `dm-${this.dms.length}` };
        }
      })
    };
    this.client = raw;
  }

  async postToChannel (channel, text) {
    this.posted.push({ channel, text });
    return {};
  }
}

class FakeOperations extends EventEmitter {
  constructor () {
    super();
    this.discord = null;
    this.gateway = { status: 'disabled', error: null };
  }

  connect (discord) {
    this.discord = discord;
    this.gateway = { status: 'connected', error: null };
    this.emit('gateway', discord);
    return discord;
  }
}

const AWAY = '666666666666666666';
const BYSTANDER = '777777777777777777';

/**
 * What services/alliance.js tells Community: ADMIN's Discord account is on
 * record as an officer of G00N, G00N's record also lists AWAY, an officer
 * with no goon.vc profile, and BYSTANDER is a server admin who isn't on
 * record for any org.
 */
function onRecord (service, { user = ADMIN, people = null } = {}) {
  return service.alliance({
    representing: async (key) => (key === `discord:${user}` ? [{ symbol: 'G00N', name: 'G00N SQUAD', officer: true }] : []),
    representatives: async (symbol) => (symbol === 'G00N'
      ? (people || [
          { name: 'Kersa', discord: [ADMIN], officer: true },
          { name: null, discord: [AWAY], officer: true }
        ])
      : [])
  });
}

async function until (check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

describe('Community service (shared Doorman + DM scripts)', function () {
  this.timeout(20000);
  let dir;

  before(function () {
    if (!HAS_SCRIPTS) this.skip();
  });

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-community-'));
  });

  afterEach(function () {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function community (settings = {}) {
    return new Community(Object.assign({
      path: path.join(dir, 'community'),
      token: 'scripts-token',
      siteUrl: 'https://goon.vc',
      Doorman: doorman('services/doorman'),
      Scripts: doorman('services/scripts'),
      DoormanDiscord: doorman('services/discord')
    }, settings));
  }

  it('lists a guild’s channels and features, and reads permissions fresh from Discord', async function () {
    const guild = fakeGuild();
    const service = community({ gateway: false });
    service.discord = new FakeDiscord(guild);
    assert.deepStrictEqual(service.channels({ guildId: GUILD }, [0, 5]), [
      { id: CLIPS, label: '#clips', description: 'Bot needs: Read Message History' },
      { id: GENERAL, label: '#general', description: 'COMMUNITY' }
    ]);
    assert.deepStrictEqual(service.channels({ guildId: GUILD }, [2, 13]), [{ id: VOICE, label: 'PERMAFLEET', description: null }]);
    assert.deepStrictEqual(service.channels({ guildId: 'elsewhere' }, [0]), []);
    assert.deepStrictEqual(service.guildContext(GUILD), {
      siteUrl: 'https://goon.vc',
      inviteUrl: 'https://goon.vc/services/discord/invite',
      botMissing: 'Read Message History'
    });

    const session = (user) => ({ user: `discord/users/${user}`, context: { guildId: GUILD } });
    assert.strictEqual(await service.authorize('ManageGuild', session(ADMIN)), true);
    assert.strictEqual(await service.authorize('ManageGuild', session(MEMBER)), false);
    assert.strictEqual(await service.authorize('ManageGuild', session('444444444444444444')), false);
    assert.strictEqual(await service.authorize('ManageGuild', session(OWNER)), true, 'the owner can always manage');
    assert.strictEqual(await service.authorize('Nonsense', session(ADMIN)), false);
    assert.ok(guild.fetched.every((entry) => entry.force === true), 'permissions come from Discord, not the cache');
  });

  it('walks an admin through goon-setup over DM and records the answers for their server', async function () {
    const guild = fakeGuild();
    const operations = new FakeOperations();
    const service = onRecord(community({ operations }));
    await service.start();
    assert.strictEqual(service.gateway.status, 'waiting');
    const discord = operations.connect(new FakeDiscord(guild));
    assert.strictEqual(service.gateway.status, 'attached');
    assert.strictEqual(service.adapter.canSend, false, 'chat is never answered');
    assert.strictEqual(service.adapter.canWhisper, true);
    assert.deepStrictEqual(service.scripts.list().map((script) => script.id).sort(), [
      'checkin', 'goon-setup', 'hangar-import', 'member-review', 'permafleet-apply', 'permafleet-channel', 'permafleet-council', 'permafleet-embassy', 'permafleet-roles', 'permafleet-voice',
      'recruit-bravo-squadron', 'recruit-permafleet-officers', 'recruit-turtle-brigade'
    ]);
    assert.deepStrictEqual(service.campaignScripts(), [{ id: 'hangar-import', title: 'Sync your hangar' }], 'scripts that need a permission or rank are never offered to /goon campaign');

    try {
      await service.beginScript('goon-setup', {
        user: `discord/users/${MEMBER}`,
        name: 'Member',
        context: { guildId: GUILD, guildName: 'G00N SQUAD' },
        subject: GUILD
      });
      assert.fail('members without Manage Server cannot start it');
    } catch (error) {
      assert.strictEqual(error.status, 403);
    }

    const session = await service.beginScript('goon-setup', {
      user: `discord/users/${ADMIN}`,
      name: 'Kersa',
      context: { guildId: GUILD, guildName: 'G00N SQUAD' },
      subject: GUILD
    });
    assert.strictEqual(session.step, 'welcome');
    const last = () => discord.dms[discord.dms.length - 1].payload;
    const ids = () => last().components.flatMap((row) => row.components.map((component) => component.custom_id));
    assert.ok(last().content.startsWith('Hi Kersa! Let\'s connect **G00N SQUAD** to goon.vc.'), last().content);

    const press = async (customId, extra = {}) => {
      const before = discord.dms.length;
      discord.client.emit('interactionCreate', Object.assign({
        customId,
        user: { id: ADMIN },
        message: { content: last().content },
        deferUpdate: async () => {},
        editReply: async () => {},
        followUp: async (payload) => { throw new Error(`refused: ${payload.content}`); }
      }, extra));
      await until(() => discord.dms.length > before);
    };

    await press(ids()[0]);
    assert.ok(last().content.includes('What should goon.vc do for **G00N SQUAD**?'));
    const features = last().components[0].components[0];
    assert.deepStrictEqual(features.options.map((option) => option.value), ['calendar', 'clips', 'idlerpg', 'permafleet']);
    await press(features.custom_id, { values: ['clips', 'permafleet'] });

    assert.ok(last().content.includes('Which channel do your members post clips in?'));
    assert.deepStrictEqual(last().components[0].components.map((button) => button.label), ['#clips', '#general']);
    await press(last().components[0].components[0].custom_id);

    assert.ok(last().content.includes('Which org is **G00N SQUAD** joining PERMAFLEET for?'), last().content);
    assert.ok(last().content.includes('- **G00N SQUAD**: Kersa, 1 not on goon.vc yet'), 'the officers on record, never typed in: ' + last().content);
    assert.deepStrictEqual(last().components[0].components.map((button) => button.label), ['G00N SQUAD [G00N]'], 'only the orgs the admin is on record for');
    await press(last().components[0].components[0].custom_id);

    assert.ok(last().content.startsWith('Here\'s where **G00N SQUAD** stands with PERMAFLEET today.'), last().content);
    assert.ok(last().content.includes('**Expected of every member org** (0 of 3)'), last().content);
    assert.ok(last().content.includes('⬜ #embassy, open to everyone: none yet. `/goon embassy` sets it up.'), last().content);
    assert.ok(last().content.includes('⬜ A PERMAFLEET voice channel, open to everyone: PERMAFLEET is there, but @everyone can’t Connect, Speak there.'), last().content);
    await press(ids()[0]);

    assert.ok(last().content.includes('**Recommended:** goon.vc\'s bot sets up everything a member org keeps'), last().content);
    assert.deepStrictEqual(last().components[0].components.map((button) => button.label), ['Set it all up (recommended)', 'I\'ll pick existing channels and roles'], 'creating comes first');
    await press(last().components[0].components[1].custom_id);

    assert.ok(last().content.includes('Missing on **G00N SQUAD** right now: Read Message History.'), last().content);
    assert.ok(last().content.includes('https://goon.vc/services/discord/invite'));
    await press(ids()[0]);

    assert.ok(last().content.includes('- Features: Clip library, PERMAFLEET membership'), last().content);
    assert.ok(last().content.includes('- Calendar: n/a'));
    assert.ok(last().content.includes('- Clips channel: #clips'));
    assert.ok(last().content.includes('- Org: G00N SQUAD [G00N]'), last().content);
    await press(ids()[0]);
    assert.ok(last().content.startsWith('Saved.\n\nOfficers on record for G00N SQUAD: Kersa, 1 not on goon.vc yet.'), last().content);

    const result = service.scripts.results('goon-setup').find((entry) => entry.subject === GUILD);
    assert.deepStrictEqual(result.answers, {
      welcome: true,
      features: ['clips', 'permafleet'],
      clipsChannel: CLIPS,
      org: 'G00N',
      compliance: true,
      build: 'existing',
      permissions: true,
      summary: true,
      officers: ['Kersa']
    });
    assert.strictEqual(result.context.guildName, 'G00N SQUAD');
    assert.deepStrictEqual(result.context.complianceChecks.map((entry) => [entry.id, entry.ok]), [
      ['embassy', false], ['voice', false], ['prospects', false], ['council', false], ['permafleet', false]
    ], 'the checklist the admin saw is recorded with the answers');
    assert.ok(guild.fetched.filter((entry) => entry.user === ADMIN).length >= 2, 'checked at start and again before recording');

    const report = JSON.stringify(await service.report());
    assert.ok(!report.includes(ADMIN), 'the report carries no user ids');
    await service.stop();
  });

  it('serves script definitions openly and results only with the token', async function () {
    const service = community({ gateway: false });
    await service.start();
    const handler = service.middleware();
    const call = (url, headers = {}) => new Promise((resolve) => {
      const res = {
        statusCode: 200,
        headers: {},
        setHeader (key, value) { this.headers[key] = value; },
        end (body) { resolve({ status: this.statusCode, body: body ? JSON.parse(body) : null }); }
      };
      handler({ method: 'GET', url, headers }, res, () => resolve({ status: 'next' }));
    });
    const list = await call('/services/doorman/scripts');
    assert.strictEqual(list.status, 200);
    assert.ok(JSON.stringify(list.body).includes('goon-setup'));
    assert.strictEqual((await call('/services/doorman/scripts/goon-setup/results')).status, 401);
    const results = await call('/services/doorman/scripts/goon-setup/results', { authorization: 'Bearer scripts-token' });
    assert.strictEqual(results.status, 200);
    assert.strictEqual((await call('/services/idlerpg')).status, 'next');
    await service.stop();
  });

  it('runs IdleRPG on the same Doorman and Discord adapter', async function () {
    const ANNOUNCE = '1560112808283086929';
    const guild = fakeGuild();
    const operations = new FakeOperations();
    const service = community({ operations });
    await service.start();
    const presence = new Presence({ path: path.join(dir, 'presence'), tickMs: 0, operations, community: service, announcements: [ANNOUNCE] });
    await presence.start();
    assert.strictEqual(presence.doorman, service.doorman, 'one Doorman');
    assert.ok(service.doorman.plugins.idlerpg && service.doorman.plugins.scripts);

    const discord = operations.connect(new FakeDiscord(guild));
    assert.strictEqual(presence.adapter, service.adapter, 'one Discord adapter');
    assert.deepStrictEqual(Object.keys(service.doorman.services), ['discord']);
    discord.emit('voice', { guildId: GUILD, userId: ADMIN, oldChannelId: null, newChannelId: VOICE, channelName: 'PERMAFLEET' });
    await until(() => discord.posted.length);
    assert.strictEqual(discord.posted[0].channel, ANNOUNCE);
    assert.ok(discord.posted[0].text.startsWith('Welcome to IdleRPG'));

    service.doorman.plugins.idlerpg.emit('whisper', { target: `discord/users/${ADMIN}`, object: { content: 'You got 10 credits' } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(discord.dms.length, 0, 'plugins other than scripts and campaigns never DM');

    await presence.stop();
    await service.stop();
  });

  describe('PERMAFLEET channel scripts', function () {
    const BOT = '555555555555555555';
    const OFFICERS = '1190527980120850700';
    // G00N SQUAD's own role for non-alliance org leaders; PERMAFLEET scripts never treat it specially.
    const STEWARDS = '1190527980120850701';
    const BOT_ROLE = '1190527980120850702';
    const ENOUGH = [BITS.ManageChannels, BITS.ManageRoles, BITS.ViewChannel, BITS.SendMessages, BITS.ReadMessageHistory, BITS.Connect, BITS.Speak];

    /**
     * fakeGuild plus roles, a bot that may or may not manage channels and
     * roles, channels.create, roles.create, and members who can be given roles.
     */
    function channelGuild ({ grant = true } = {}) {
      const guild = fakeGuild();
      guild.members.me = { id: BOT, permissions: permissions(...(grant ? ENOUGH : [BITS.ViewChannel, BITS.SendMessages])) };
      guild.roles = {
        cache: new Map([
          [GUILD, { id: GUILD, name: '@everyone', position: 0 }],
          [STEWARDS, { id: STEWARDS, name: 'ORG STEWARDS', position: 4 }],
          [OFFICERS, { id: OFFICERS, name: 'Officers', position: 5 }],
          [BOT_ROLE, { id: BOT_ROLE, name: 'goon.vc', position: 6, managed: true }]
        ])
      };
      guild.rolesCreated = [];
      guild.roles.create = async (options) => {
        guild.rolesCreated.push(options);
        const role = { id: String(7000 + guild.rolesCreated.length), name: options.name, position: 1 };
        guild.roles.cache.set(role.id, role);
        return role;
      };
      guild.given = [];
      const fetchMember = guild.members.fetch;
      guild.members.fetch = async (options) => {
        const member = await fetchMember(options);
        if (!member.roles) {
          member.roles = {
            cache: new Set(),
            add: async (role) => {
              guild.given.push({ user: options.user, role });
              member.roles.cache.add(role);
            }
          };
        }
        return member;
      };
      guild.created = [];
      guild.channels.create = async (options) => {
        guild.created.push(options);
        const channel = { id: String(9000 + guild.created.length), type: options.type, name: options.name, parent: null };
        guild.channels.cache.set(channel.id, channel);
        return channel;
      };
      return guild;
    }

    async function boot (guild) {
      const operations = new FakeOperations();
      const service = onRecord(community({ operations }));
      await service.start();
      const discord = operations.connect(new FakeDiscord(guild));
      const begin = (script, user = ADMIN) => service.beginScript(script, {
        user: `discord/users/${user}`,
        name: 'Kersa',
        context: { guildId: GUILD, guildName: 'G00N SQUAD' },
        subject: GUILD
      });
      const said = () => discord.dms[discord.dms.length - 1].payload.content;
      return { service, discord, begin, said };
    }

    it('builds private council and public channel overwrites, and knows a channel by its name', function () {
      const allianceChannels = require('../functions/allianceChannels');
      const view = BITS.ViewChannel;
      const talk = BITS.ViewChannel | BITS.SendMessages | BITS.ReadMessageHistory;
      assert.deepStrictEqual(allianceChannels.overwrites(allianceChannels.spec('council'), { everyone: GUILD, bot: BOT, roles: [OFFICERS] }), [
        { id: GUILD, type: 0, allow: 0n, deny: view },
        { id: OFFICERS, type: 0, allow: talk, deny: 0n },
        { id: BOT, type: 1, allow: talk, deny: 0n }
      ]);
      assert.deepStrictEqual(allianceChannels.overwrites(allianceChannels.spec('council'), { everyone: GUILD, bot: BOT, members: [ADMIN, BOT, ADMIN] }), [
        { id: GUILD, type: 0, allow: 0n, deny: view },
        { id: ADMIN, type: 1, allow: talk, deny: 0n },
        { id: BOT, type: 1, allow: talk, deny: 0n }
      ], 'officers by name, once each, and the bot once');
      assert.deepStrictEqual(allianceChannels.overwrites(allianceChannels.spec('voice'), { everyone: GUILD, bot: BOT, roles: [OFFICERS] }), [
        { id: GUILD, type: 0, allow: BITS.ViewChannel | BITS.Connect | BITS.Speak, deny: 0n }
      ]);
      assert.ok(allianceChannels.matches(allianceChannels.spec('embassy'), { type: 0, name: '🏛-embassy' }));
      assert.ok(!allianceChannels.matches(allianceChannels.spec('permafleet'), { type: 0, name: 'permafleet-officers-🚔' }));
      assert.ok(!allianceChannels.matches(allianceChannels.spec('voice'), { type: 0, name: 'permafleet' }), 'a text channel is not the voice channel');
    });

    it('creates a private #council for the picked roles and the bot, and records it', async function () {
      const guild = channelGuild();
      const { service, begin, said } = await boot(guild);
      assert.deepStrictEqual(service.roles({ guildId: GUILD }), [
        { id: OFFICERS, label: 'Officers' },
        { id: STEWARDS, label: 'ORG STEWARDS' }
      ], 'highest first, never @everyone or a managed role');
      assert.deepStrictEqual(service.councilAccessChoices({ guildId: GUILD }).map((option) => option.id), ['officers', OFFICERS, STEWARDS], 'the officers on record come first');
      assert.deepStrictEqual(service.channelChoices({ guildId: GUILD }, require('../functions/allianceChannels').spec('council')).map((option) => option.id), ['new', CLIPS, GENERAL]);

      const session = await begin('permafleet-council');
      assert.ok(said().includes('private **#council** channel'), said());
      await service.scripts.answer(session.id, 'welcome', 'yes');
      assert.ok(said().startsWith('Before I change anything, here\'s where **G00N SQUAD** stands with PERMAFLEET:'), said());
      assert.ok(said().includes('⬜ A private #council for your officers: none yet. `/goon council` sets it up.'), said());
      assert.ok(!/steward/i.test(said()), 'no steward role in the checklist: ' + said());
      assert.ok(said().includes('\n\nThis walkthrough takes care of #council.'), said());
      assert.strictEqual(guild.created.length, 0, 'the checklist comes before anything changes');
      await service.scripts.answer(session.id, 'compliance', 'yes');
      await service.scripts.answer(session.id, 'channel', 'new');
      await service.scripts.answer(session.id, 'category', '1');
      assert.ok(said().includes('Who may see #council?'), said());
      await service.scripts.answer(session.id, 'roles', [OFFICERS, STEWARDS]);
      assert.ok(said().includes('- Who can see it: Officers, ORG STEWARDS, and goon.vc\'s bot'), 'no permissions step when the bot has what it needs: ' + said());
      await service.scripts.answer(session.id, 'summary', 'yes');

      assert.strictEqual(guild.created.length, 1);
      const created = guild.created[0];
      assert.strictEqual(created.name, 'council');
      assert.strictEqual(created.type, 0);
      assert.strictEqual(created.parent, '1');
      assert.strictEqual(created.topic, 'Where our officers settle PERMAFLEET alliance votes.');
      assert.deepStrictEqual(created.permissionOverwrites.map((entry) => entry.id), [GUILD, OFFICERS, STEWARDS, BOT]);
      assert.ok(created.reason.includes('/goon council'));
      assert.strictEqual(said(), 'Created <#9001>. Your officers settle PERMAFLEET alliance votes there. Run `/goon council` again any time.');
      const result = service.scripts.results('permafleet-council').find((entry) => entry.subject === GUILD);
      assert.strictEqual(result.answers.channelId, '9001');
      assert.strictEqual(result.answers.created, true);
      await service.stop();
    });

    it('lets only an org’s officers on record act for it', async function () {
      const guild = channelGuild();
      const fetch = guild.members.fetch;
      guild.members.fetch = async (options) => (options.user === BYSTANDER
        ? { permissions: permissions(BITS.ManageGuild), roles: { cache: new Set() } }
        : fetch(options));
      const { service, begin, said } = await boot(guild);
      for (const user of [OWNER, BYSTANDER]) {
        for (const script of ['permafleet-council', 'permafleet-embassy', 'permafleet-channel', 'permafleet-voice', 'permafleet-roles']) {
          await assert.rejects(begin(script, user), (error) => {
            assert.strictEqual(error.status, 403);
            assert.ok(error.message.startsWith('Only the officers PERMAFLEET leadership has on record can act for a member org'), error.message);
            assert.ok(error.message.includes('#embassy'), 'says how to be put on record');
            assert.ok(!/key/i.test(error.message), 'no keys in the message');
            return true;
          }, `${script} refuses ${user === OWNER ? 'the server owner who isn’t on record' : 'a server admin who isn’t on record'}`);
        }
      }

      const setup = await begin('goon-setup', OWNER);
      await service.scripts.answer(setup.id, 'welcome', 'yes');
      assert.ok(said().includes('PERMAFLEET membership isn’t offered here. Only the officers'), said());
      const offered = discord => discord.dms[discord.dms.length - 1].payload.components
        .flatMap((row) => row.components)
        .flatMap((component) => (component.options || []).map((option) => option.label).concat(component.label || []));
      assert.ok(!offered(service.discord).some((label) => /PERMAFLEET/.test(label)), 'no PERMAFLEET feature for someone not on record');
      assert.strictEqual(guild.created.length + guild.rolesCreated.length, 0);
      await service.stop();
    });

    it('opens #council to the officers on record by name, with no role made or given', async function () {
      const guild = channelGuild();
      const { service, begin, said } = await boot(guild);

      const session = await begin('permafleet-council');
      await service.scripts.answer(session.id, 'welcome', 'yes');
      await service.scripts.answer(session.id, 'compliance', 'yes');
      await service.scripts.answer(session.id, 'channel', 'new');
      await service.scripts.answer(session.id, 'category', 'skip');
      assert.ok(said().includes('opens it to each officer PERMAFLEET leadership has on record who is on **G00N SQUAD** (Kersa, 1 not on goon.vc yet)'), said());
      assert.ok(!/steward/i.test(said()), said());
      await service.scripts.answer(session.id, 'roles', ['officers']);
      await service.scripts.answer(session.id, 'summary', 'yes');

      assert.strictEqual(guild.rolesCreated.length, 0, 'no role is made');
      assert.deepStrictEqual(guild.given, [], 'and none is given');
      assert.deepStrictEqual(guild.created[0].permissionOverwrites.map((entry) => [entry.id, entry.type]), [[GUILD, 0], [ADMIN, 1], [BOT, 1]], 'the officer on this server by name, nobody else');
      assert.ok(said().startsWith('Created <#9001>. Opened #council to your officers on record: Kersa. Not on this server: someone not on goon.vc yet; add them to #council once they join.'), said());
      await service.stop();
    });

    it('sets up the Prospect ranks with /goon roles', async function () {
      const guild = channelGuild();
      guild.roles.cache.set('7700', { id: '7700', name: '[P2] Prospect II', position: 1 });
      const { service, begin, said } = await boot(guild);
      const session = await begin('permafleet-roles');
      assert.ok(said().includes('for G00N SQUAD.'), said());
      await service.scripts.answer(session.id, 'welcome', 'yes');
      assert.ok(said().includes('This walkthrough takes care of the Prospect ranks.'), said());
      assert.ok(!/steward/i.test(said()), said());
      await service.scripts.answer(session.id, 'compliance', 'yes');
      assert.ok(said().includes('Missing right now: Prospect I, III, IV, V, VI.'), said());
      await service.scripts.answer(session.id, 'prospects', 'new');
      assert.ok(said().startsWith('Here\'s the plan for **G00N SQUAD**:'), 'no permissions step when the bot can manage roles: ' + said());
      await service.scripts.answer(session.id, 'summary', 'yes');

      assert.deepStrictEqual(guild.rolesCreated.map((role) => role.name), [
        '[P6] Prospect VI', '[P5] Prospect V', '[P4] Prospect IV', '[P3] Prospect III', '[P1] Prospect I'
      ], 'the highest rank first, since a new role lands at the bottom');
      assert.deepStrictEqual(guild.given, []);
      assert.ok(said().includes('Created [P1] Prospect I, [P3] Prospect III, [P4] Prospect IV, [P5] Prospect V, [P6] Prospect VI.'), said());
      const result = service.scripts.results('permafleet-roles').find((entry) => entry.subject === GUILD);
      assert.strictEqual(result.answers.prospectsCreated.length, 5);
      await service.stop();
    });

    it('sets up every PERMAFLEET channel and rank from goon-setup, keeping what the server has', async function () {
      const guild = channelGuild();
      const { service, begin, said } = await boot(guild);
      const session = await begin('goon-setup');
      await service.scripts.answer(session.id, 'welcome', 'yes');
      await service.scripts.answer(session.id, 'features', ['permafleet']);
      await service.scripts.answer(session.id, 'org', 'G00N');
      await service.scripts.answer(session.id, 'compliance', 'yes');
      await service.scripts.answer(session.id, 'build', 'create');
      assert.ok(said().startsWith('goon.vc\'s bot needs **View Channels**'), 'no setup permissions step when the bot has them: ' + said());
      await service.scripts.answer(session.id, 'permissions', 'yes');
      assert.ok(said().includes('- PERMAFLEET channels and roles: Set it all up (recommended)'), said());
      await service.scripts.answer(session.id, 'summary', 'yes');

      assert.deepStrictEqual(guild.rolesCreated.map((role) => role.name)[0], '[P6] Prospect VI');
      assert.strictEqual(guild.rolesCreated.length, 6, 'the six Prospect ranks and nothing else');
      assert.deepStrictEqual(guild.given, []);
      assert.deepStrictEqual(guild.created.map((channel) => [channel.name, channel.type, channel.parent || null]), [
        ['PERMAFLEET', 4, null],
        ['embassy', 0, '9001'],
        ['permafleet', 0, '9001'],
        ['council', 0, '9001']
      ], 'the voice channel it already had is kept');
      assert.deepStrictEqual(guild.created[3].permissionOverwrites.map((entry) => [entry.id, entry.type]), [[GUILD, 0], [ADMIN, 1], [BOT, 1]]);
      assert.ok(said().includes('Opened #council to your officers on record: Kersa.'), said());
      assert.ok(said().includes(`Created <#9002>, <#9003>, <#9004> under PERMAFLEET.\nKept <#${VOICE}>, which you already had, as they are.`), said());
      const result = service.scripts.results('goon-setup').find((entry) => entry.subject === GUILD);
      assert.deepStrictEqual(result.answers.setup, {
        channels: { embassy: '9002', voice: VOICE, permafleet: '9003', council: '9004' }
      });
      await service.stop();
    });

    it('refuses to set it all up without Manage Channels and Manage Roles, and changes nothing', async function () {
      const guild = channelGuild({ grant: false });
      const { service, begin, said } = await boot(guild);
      const session = await begin('goon-setup');
      await service.scripts.answer(session.id, 'welcome', 'yes');
      await service.scripts.answer(session.id, 'features', ['permafleet']);
      await service.scripts.answer(session.id, 'org', 'G00N');
      await service.scripts.answer(session.id, 'compliance', 'yes');
      await service.scripts.answer(session.id, 'build', 'create');
      assert.ok(said().includes('Missing on **G00N SQUAD** right now: Manage Channels, Read Message History, Connect, Speak, Manage Roles.'), said());
      assert.ok(said().includes('https://goon.vc/services/discord/invite?for=channels'));
      await service.scripts.answer(session.id, 'setupPermissions', 'yes');
      await service.scripts.answer(session.id, 'permissions', 'yes');
      await service.scripts.answer(session.id, 'summary', 'yes');
      assert.ok(said().startsWith('To set up PERMAFLEET, goon.vc’s bot needs Manage Channels, Read Message History, Connect, Speak, Manage Roles on **G00N SQUAD**.'), said());
      assert.strictEqual(guild.created.length + guild.rolesCreated.length, 0);
      assert.ok(!service.scripts.results('goon-setup').length, 'nothing recorded');
      await service.stop();
    });

    it('uses a channel the server already has instead of making a second one', async function () {
      const guild = channelGuild();
      const { service, begin, said } = await boot(guild);
      const voice = await begin('permafleet-voice');
      assert.deepStrictEqual(service.channelChoices({ guildId: GUILD }, require('../functions/allianceChannels').spec('voice')).map((option) => option.id), ['new', VOICE]);
      await service.scripts.answer(voice.id, 'welcome', 'yes');
      await service.scripts.answer(voice.id, 'compliance', 'yes');
      await service.scripts.answer(voice.id, 'channel', 'new');
      await service.scripts.answer(voice.id, 'category', 'skip');
      await service.scripts.answer(voice.id, 'summary', 'yes');
      assert.strictEqual(said(), `Using <#${VOICE}>; I left its permissions as they are. PERMAFLEET pilots can drop in any time. Run \`/goon voice\` again any time.`);

      const embassy = await begin('permafleet-embassy');
      await service.scripts.answer(embassy.id, 'welcome', 'yes');
      await service.scripts.answer(embassy.id, 'compliance', 'yes');
      await service.scripts.answer(embassy.id, 'channel', GENERAL);
      assert.ok(said().includes('I\'ll use #general as #embassy'), said());
      await service.scripts.answer(embassy.id, 'existing', 'yes');
      assert.ok(said().startsWith(`Using <#${GENERAL}>;`), said());
      assert.strictEqual(guild.created.length, 0, 'nothing was created');
      await service.stop();
    });

    /** channelGuild where every PERMAFLEET item checks out: real @everyone permissions per channel. */
    function compliantGuild () {
      const guild = channelGuild();
      const everyone = guild.roles.cache.get(GUILD);
      guild.roles.everyone = everyone;
      const forEveryone = (bits) => (target) => (target === everyone ? permissions(...bits) : permissions(...ENOUGH));
      const add = (id, type, name, bits) => guild.channels.cache.set(id, { id, type, name, rawPosition: 9, parent: null, permissionsFor: forEveryone(bits) });
      add('8001', 0, '🏛-embassy', ALL);
      add('8002', 0, 'council', []);
      add('8003', 0, 'permafleet', ALL);
      guild.channels.cache.get(VOICE).permissionsFor = forEveryone([BITS.ViewChannel, BITS.Connect, BITS.Speak]);
      for (const [index, name] of ['[P1] Prospect I', '[P2] Prospect II', '[P3] Prospect III'].entries()) {
        guild.roles.cache.set(`77${index}`, { id: `77${index}`, name, position: 1 });
      }
      return guild;
    }

    it('checks a server against what PERMAFLEET expects, reading @everyone’s permissions', function () {
      const allianceCompliance = require('../functions/allianceCompliance');
      const passing = allianceCompliance.check(compliantGuild());
      assert.deepStrictEqual(passing.checks.map((entry) => [entry.id, entry.ok, entry.detail]), [
        ['embassy', true, '#🏛-embassy'],
        ['voice', true, 'PERMAFLEET'],
        ['prospects', true, 'Prospect I, II, III'],
        ['council', true, '#council'],
        ['permafleet', true, '#permafleet']
      ], 'no steward role: PERMAFLEET goes by the officers on record');
      assert.deepStrictEqual([passing.required, passing.recommended], [{ passed: 3, total: 3 }, { passed: 2, total: 2 }]);
      assert.ok(!allianceCompliance.render(passing).includes('⬜'), allianceCompliance.render(passing));

      const failing = compliantGuild();
      const everyone = failing.roles.everyone;
      failing.channels.cache.get('8002').permissionsFor = (target) => (target === everyone ? permissions(BITS.ViewChannel) : permissions(...ENOUGH));
      failing.channels.cache.get('8001').permissionsFor = (target) => (target === everyone ? permissions(BITS.ViewChannel) : permissions(...ENOUGH));
      failing.roles.cache.delete('770');
      const report = allianceCompliance.check(failing);
      const byId = Object.fromEntries(report.checks.map((entry) => [entry.id, entry]));
      assert.strictEqual(byId.embassy.detail, '#🏛-embassy is there, but @everyone can’t Send Messages, Read Message History there');
      assert.strictEqual(byId.council.detail, '#council is there, but everyone on the server can see it');
      assert.strictEqual(byId.prospects.detail, 'Prospect II, III, but no Prospect I');
      assert.deepStrictEqual([report.required, report.recommended], [{ passed: 1, total: 3 }, { passed: 1, total: 2 }]);
      const text = allianceCompliance.render(report);
      assert.ok(text.includes('**Expected of every member org** (1 of 3)\n⬜ #embassy, open to everyone: #🏛-embassy is there'), text);
      assert.ok(text.includes('✅ A PERMAFLEET voice channel, open to everyone: PERMAFLEET.'), text);
      assert.ok(!/\d{15,}/.test(text), 'names only, never ids');
    });

    it('says when the script’s own item already checks out', async function () {
      const guild = compliantGuild();
      const { service, begin, said } = await boot(guild);
      const session = await begin('permafleet-embassy');
      await service.scripts.answer(session.id, 'welcome', 'yes');
      assert.ok(said().includes('**Expected of every member org** (3 of 3)'), said());
      assert.ok(said().includes('#embassy already checks out (#🏛-embassy). Continue to point it at a different channel, or Cancel to leave it.'), said());
      await service.stop();
    });

    it('says what the bot lacks, with the invite that grants it, and creates nothing', async function () {
      const guild = channelGuild({ grant: false });
      const { service, begin, said } = await boot(guild);
      const session = await begin('permafleet-channel');
      await service.scripts.answer(session.id, 'welcome', 'yes');
      await service.scripts.answer(session.id, 'compliance', 'yes');
      await service.scripts.answer(session.id, 'channel', 'new');
      await service.scripts.answer(session.id, 'category', 'skip');
      assert.ok(said().includes('Missing on **G00N SQUAD** right now: Manage Channels, Read Message History.'), said());
      assert.ok(said().includes('https://goon.vc/services/discord/invite?for=channels'));
      await service.scripts.answer(session.id, 'permissions', 'yes');
      await service.scripts.answer(session.id, 'summary', 'yes');
      assert.strictEqual(said(), 'To make #permafleet, goon.vc’s bot needs Manage Channels, Read Message History on **G00N SQUAD**. Grant them here: https://goon.vc/services/discord/invite?for=channels\nThen run `/goon permafleet` in your server to try again.');
      assert.strictEqual(guild.created.length, 0);
      assert.ok(!service.scripts.results('permafleet-channel').length, 'nothing recorded');
      await service.stop();
    });
  });

  describe('campaigns', function () {
    const PILOT = '1190527980120850600';
    const MUTED = '1190527980120850601';
    const OTHER_GUILD = '1236721094153700000';
    const BOT = '555555555555555555';
    const OUTSIDER = '666666666666666666';

    before(function () {
      if (!HAS_CAMPAIGNS) this.skip();
    });

    /** Gives a fake guild a member list (`members.fetch()` with no options). */
    function withMembers (guild, people) {
      const fetchOne = guild.members.fetch;
      guild.members.fetch = async (options) => {
        if (options) return fetchOne(options);
        return new Map(people.map((person) => [person.id, {
          id: person.id,
          displayName: person.name,
          user: { id: person.id, username: person.name.toLowerCase(), bot: person.bot === true },
          roles: { cache: new Map((person.roles || []).map((role) => [role, { id: role }])) }
        }]));
      };
      return guild;
    }

    function guilds () {
      const home = withMembers(fakeGuild(), [
        { id: ADMIN, name: 'Kersa', roles: [PILOT] },
        { id: MEMBER, name: 'Ratgrot', roles: [PILOT, MUTED] },
        { id: OWNER, name: 'Owner', roles: [] },
        { id: BOT, name: 'Bot', roles: [PILOT], bot: true }
      ]);
      const other = withMembers({ id: OTHER_GUILD, name: 'TRDE', members: {} }, [
        { id: OWNER, name: 'Owner', roles: [] },
        { id: OUTSIDER, name: 'Trader', roles: [] }
      ]);
      return { home, other };
    }

    function campaignCommunity (operations) {
      return community({
        operations,
        campaigns: { enabled: true, intervalMs: 0, path: path.join(dir, 'campaigns') },
        Campaigns: doorman('services/campaigns')
      });
    }

    it('is opt-in and asks for the Server Members intent only when on', function () {
      const Campaigns = doorman('services/campaigns');
      assert.deepStrictEqual(Community.CAMPAIGN_INTENTS, ['GuildMembers']);
      assert.strictEqual(Community.campaignsEnabled({ campaigns: { enabled: true }, Campaigns }), true);
      assert.strictEqual(Community.campaignsEnabled({ campaigns: { enabled: false }, Campaigns }), false);
      assert.strictEqual(Community.campaignsEnabled({ Campaigns }), false);
      assert.strictEqual(Community.campaignsEnabled({ campaigns: { enabled: true }, Campaigns: class OlderCampaigns {} }), false, 'only a Doorman that locks sends to a preview');
      assert.strictEqual(Community.campaignsEnabled({ enabled: false, campaigns: { enabled: true }, Campaigns }), false);

      const Scripts = doorman('services/scripts');
      assert.deepStrictEqual(Community.gateway({ Scripts, Campaigns }), { intents: ['DirectMessages'], partials: ['Channel'] });
      assert.deepStrictEqual(Community.gateway({ Scripts, Campaigns, campaigns: { enabled: true } }), { intents: ['DirectMessages', 'GuildMembers'], partials: ['Channel'] });
      assert.deepStrictEqual(Community.gateway({ enabled: false, Scripts, Campaigns, campaigns: { enabled: true } }), { intents: [], partials: [] });
    });

    it('stays off unless GOON_CAMPAIGNS=1: no plugin and no API', async function () {
      const { execFileSync } = require('child_process');
      const shipped = (value) => {
        const env = Object.assign({}, process.env);
        delete env.GOON_CAMPAIGNS;
        if (value !== undefined) env.GOON_CAMPAIGNS = value;
        const script = "process.stdout.write(JSON.stringify(require('./settings/local').community.campaigns.enabled))";
        return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.resolve(__dirname, '..'), env }).toString());
      };
      assert.strictEqual(shipped(undefined), false, 'off when unset');
      for (const value of ['0', 'true', 'yes', '']) assert.strictEqual(shipped(value), false, `off for GOON_CAMPAIGNS=${JSON.stringify(value)}`);
      assert.strictEqual(shipped('1'), true);

      const service = community({ gateway: false, Campaigns: doorman('services/campaigns') });
      await service.start();
      assert.strictEqual(service.campaigns, null);
      const res = { statusCode: 200, setHeader () {}, end () { throw new Error('the campaigns API answered'); } };
      const passed = await new Promise((resolve) => service.middleware()({ method: 'GET', url: '/services/doorman/campaigns', headers: { authorization: 'Bearer scripts-token' } }, res, () => resolve(true)));
      assert.strictEqual(passed, true, 'the campaigns API is not mounted');
      await service.stop();
    });

    it('finds members by server, role, and exclusions, never bots', async function () {
      const { home, other } = guilds();
      const service = community({ gateway: false });
      service.discord = new FakeDiscord(home);
      service.discord.client.guilds.cache.set(OTHER_GUILD, other);
      const { filter } = doorman('types/campaign');
      const staff = { owner: { kind: 'staff' } };
      const targets = async (input, campaign = staff) => (await service.discordAudience(filter(input), campaign))
        .map((person) => `${person.sourceName}:${person.name}`).sort();

      assert.deepStrictEqual(await targets({}), ['G00N SQUAD:Kersa', 'G00N SQUAD:Owner', 'G00N SQUAD:Ratgrot', 'TRDE:Owner', 'TRDE:Trader']);
      assert.deepStrictEqual(await targets({ roles: [PILOT], excludeRoles: [MUTED] }), ['G00N SQUAD:Kersa']);
      assert.deepStrictEqual(await targets({ excludeGuilds: [OTHER_GUILD] }), ['G00N SQUAD:Kersa', 'G00N SQUAD:Ratgrot']);
      assert.deepStrictEqual(await targets({ guilds: [OTHER_GUILD] }, { owner: { kind: 'guild', guildId: GUILD } }), ['G00N SQUAD:Kersa', 'G00N SQUAD:Owner', 'G00N SQUAD:Ratgrot'], 'a server campaign stays in its server');
      const [kersa] = await service.discordAudience(filter({ roles: [PILOT], excludeRoles: [MUTED] }), staff);
      assert.deepStrictEqual(kersa, { target: `discord/users/${ADMIN}`, name: 'Kersa', source: GUILD, sourceName: 'G00N SQUAD' });
    });

    it('DMs a server campaign with Stop buttons that stick, and serves the API with the token only', async function () {
      const { home } = guilds();
      const operations = new FakeOperations();
      const service = campaignCommunity(operations);
      await service.start();
      const discord = operations.connect(new FakeDiscord(home));
      assert.strictEqual(service.adapter.canWhisper, true);
      service.activity((target) => (target === `discord/users/${ADMIN}` ? new Date().toISOString() : null));

      const campaigns = service.campaigns;
      const owner = { kind: 'guild', guildId: GUILD, guildName: 'G00N SQUAD' };
      const draft = await campaigns.create({ content: { text: 'Fleet night Saturday!' }, filter: { roles: [PILOT] } }, { owner, by: 'Kersa' });
      await assert.rejects(campaigns.schedule(draft.id, { by: 'Kersa' }), (error) => error.status === 409, 'nothing sends without a preview');
      const shown = await campaigns.preview(draft.id);
      assert.strictEqual(shown.reach, 2);
      assert.deepStrictEqual(shown.recipients.map((recipient) => recipient.name).sort(), ['Kersa', 'Ratgrot']);
      await campaigns.schedule(draft.id, { preview: shown.id, by: 'Kersa' });
      while (await campaigns.tick());
      assert.strictEqual(campaigns.campaign(draft.id).status, 'sent');
      assert.deepStrictEqual(discord.dms.map((dm) => dm.id).sort(), [ADMIN, MEMBER].sort());
      const card = discord.dms[0].payload;
      assert.strictEqual(card.content, 'Fleet night Saturday!\n\n-# Sent by **G00N SQUAD** via goon.vc');
      assert.deepStrictEqual(card.components[0].components.map((button) => button.label), ['Stop messages from G00N SQUAD', 'Stop all']);
      assert.deepStrictEqual(card.allowedMentions, { parse: [] });

      const edits = [];
      discord.client.emit('interactionCreate', {
        customId: card.components[0].components[0].custom_id,
        user: { id: discord.dms[0].id },
        message: { content: card.content },
        deferUpdate: async () => {},
        editReply: async (payload) => { edits.push(payload); },
        followUp: async (payload) => { throw new Error(`refused: ${payload.content}`); }
      });
      await until(() => edits.length);
      assert.ok(edits[0].content.endsWith('**→ You won\'t get messages from G00N SQUAD again.**'), edits[0].content);
      assert.deepStrictEqual(edits[0].components, []);

      const next = await campaigns.create({ content: { text: 'Again' }, filter: { roles: [PILOT], activeWithinDays: 30 } }, { owner });
      const preview = await campaigns.preview(next.id);
      assert.strictEqual(preview.optedOut, 1);
      assert.strictEqual(preview.reach + preview.inactive, 1);
      await assert.rejects(campaigns.schedule(next.id, { preview: preview.id }), (error) => error.status === 429, 'one server campaign a day');

      const handler = service.middleware();
      const call = (url, headers = {}) => new Promise((resolve) => {
        const res = {
          statusCode: 200,
          setHeader () {},
          end (body) { resolve({ status: this.statusCode, body: body ? JSON.parse(body) : null }); }
        };
        handler({ method: 'GET', url, headers }, res, () => resolve({ status: 'next' }));
      });
      assert.strictEqual((await call('/services/doorman/campaigns')).status, 401);
      const list = await call('/services/doorman/campaigns', { authorization: 'Bearer scripts-token' });
      assert.strictEqual(list.body.campaigns.length, 2);
      assert.strictEqual((await call('/services/doorman/scripts')).status, 200, 'scripts are still served');
      assert.strictEqual((await call('/services/idlerpg')).status, 'next');

      const report = JSON.stringify(await service.report());
      assert.ok(report.includes('"campaigns":{"campaigns"'), report);
      assert.ok(!report.includes(ADMIN) && !report.includes(MEMBER), 'the report carries no user ids');
      await service.stop();
    });

    describe('recruiting', function () {
      const recruiting = require('../functions/recruiting');
      const contract = recruiting.load();
      const role = (name) => {
        const units = Object.assign({}, contract.qualified.roles, ...contract.units.map((unit) => unit.roles));
        return units[name] || { '[P3] Prospect III': '1234526030186938409', '[P5] Prospect V': '1234739862205366312', '[P6] Prospect VI': '1234738549450997831' }[name];
      };
      const P3 = role('[P3] Prospect III');
      const P4 = role('[P4] Prospect IV');
      const people = [
        { id: '700000000000000001', name: 'Fresh', roles: [P3, P4] },
        { id: '700000000000000002', name: 'Turtle', roles: [P3, P4, role('TURTLE BRIGADE')] },
        { id: '700000000000000003', name: 'Ace', roles: [P3, P4, role('ALPHA SQUADRON')] },
        { id: '700000000000000004', name: 'Officer', roles: [P3, P4, role('[O1] Officer 1')] },
        { id: '700000000000000005', name: 'Junior', roles: [P3] },
        { id: '700000000000000006', name: 'Veteran', roles: [P3, P4, role('[P5] Prospect V'), role('[P6] Prospect VI')] },
        { id: OWNER, name: 'Owner', roles: [] }
      ];

      /** The home server, whose members hold ladder roles (listed, or fetched one at a time, fresh). */
      function ladderGuild () {
        const guild = fakeGuild();
        const member = (person) => ({
          id: person.id,
          displayName: person.name,
          permissions: permissions(),
          user: { id: person.id, username: person.name.toLowerCase(), bot: false },
          roles: { cache: new Map(person.roles.map((id) => [id, { id }])) }
        });
        guild.members.fetch = async (options) => {
          if (!options) return new Map(people.map((person) => [person.id, member(person)]));
          guild.fetched.push(options);
          const person = people.find((entry) => entry.id === options.user);
          if (!person) throw new Error('Unknown Member');
          return member(person);
        };
        return guild;
      }

      async function started () {
        const operations = new FakeOperations();
        const service = campaignCommunity(operations);
        await service.start();
        const discord = operations.connect(new FakeDiscord(ladderGuild()));
        service.activity(() => new Date().toISOString());
        return { service, discord };
      }

      it('reaches Prospect IVs who are not already in the unit or above it', async function () {
        const { service } = await started();
        const reach = {};
        for (const { unit, draft } of recruiting.drafts(contract)) {
          const saved = await service.campaigns.create(draft, { owner: draft.owner, by: 'test' });
          const deliveries = (await service.campaigns._audience(service.campaigns.content.campaigns[saved.id])).recipients;
          reach[unit] = deliveries.map((entry) => entry.name).sort();
        }
        assert.deepStrictEqual(reach, {
          'turtle-brigade': ['Ace', 'Fresh', 'Officer', 'Veteran'],
          'bravo-squadron': ['Fresh', 'Officer', 'Turtle', 'Veteran'],
          'permafleet-officers': ['Ace', 'Fresh', 'Turtle', 'Veteran']
        });
        await service.stop();
      });

      it('checks the rank fresh from Discord, and the owner holds only their roles', async function () {
        const { service } = await started();
        const session = (user) => ({ user: `discord/users/${user}`, context: { guildId: GUILD } });
        assert.strictEqual(await service.authorize('[P4] Prospect IV', session('700000000000000001')), true);
        assert.strictEqual(await service.authorize('[P4] Prospect IV', session('700000000000000005')), false);
        assert.strictEqual(await service.authorize('[P4] Prospect IV', session(OWNER)), false);
        assert.strictEqual(await service.authorize('[P4] Prospect IV', { user: session(OWNER).user, context: {} }), false);
        await service.stop();
      });

      for (const unit of contract.units) {
        it(`DMs ${unit.name} recruiting with Start, then records the walk-through`, async function () {
          const { service, discord } = await started();
          const { draft } = recruiting.drafts(contract).find((entry) => entry.unit === unit.id);
          const saved = await service.campaigns.create(draft, { owner: draft.owner });
          await service.campaigns.schedule(saved.id, { preview: (await service.campaigns.preview(saved.id)).id });
          while (await service.campaigns.tick());
          const fresh = discord.dms.find((dm) => dm.id === '700000000000000001').payload;
          assert.ok(fresh.content.startsWith(unit.message), fresh.content);
          assert.ok(fresh.content.endsWith('-# Sent by **G00N SQUAD** via goon.vc'), fresh.content);
          assert.strictEqual(fresh.components[0].components[0].label, 'Start');

          const before = discord.dms.length;
          const answer = await service.campaigns.answer(saved.id, 'start', { user: 'discord/users/700000000000000001' });
          assert.strictEqual(answer.ok, true, answer.error);
          await until(() => discord.dms.length > before);

          const scripts = service.scripts;
          const active = () => Object.values(scripts.content.sessions).find((entry) => entry.script === unit.script && entry.status === 'active');
          let walked = 0;
          while (active() && walked++ < 30) {
            const current = active();
            const step = scripts.definition(unit.script).steps[current.step];
            const options = current.options[current.step] || [];
            const value = step.input.type === 'confirm' ? true
              : step.input.type === 'choice' ? (step.input.multiple ? [options[0].id, options[1].id] : options[0].id)
                : step.input.pattern ? 'Fresh_Pilot' : 'Flew with TRDE';
            const result = await scripts.answer(current.id, current.step, value, { user: 'discord/users/700000000000000001' });
            assert.strictEqual(result.ok, true, `${current.step}: ${result.error}`);
          }
          const texts = discord.dms.slice(before).map((dm) => dm.payload.content || '');
          assert.ok(texts.every((text) => !text.includes('{{')), 'every placeholder is filled');
          assert.ok(texts.some((text) => text.includes('RSI handle: Fresh_Pilot')), 'the summary shows the answers');
          assert.ok(texts[texts.length - 1].startsWith('Sent. PERMAFLEET leadership'), texts[texts.length - 1]);
          assert.ok(texts.some((text) => text.includes('https://goon.vc/operations/PERMAFLEET')), 'links fall back to goon.vc');

          const [result] = scripts.results(unit.script);
          assert.strictEqual(result.completedByName, 'Fresh');
          assert.strictEqual(result.answers.handle, 'Fresh_Pilot');
          assert.strictEqual(result.context.guildName, 'G00N SQUAD');

          const junior = await service.campaigns.answer(saved.id, 'start', { user: 'discord/users/700000000000000005' });
          assert.strictEqual(junior.ok, false, 'only members the campaign reached can start it');
          await service.stop();
        });
      }
    });

    describe('check-ins', function () {
      const checkin = require('../functions/checkin');
      const contract = checkin.load();
      const DAY = 24 * 60 * 60 * 1000;
      const people = [
        { id: '710000000000000001', name: 'Recent', days: 10 },
        { id: '710000000000000002', name: 'Drifting', days: 45 },
        { id: '710000000000000003', name: 'Away', days: 90 },
        { id: '710000000000000004', name: 'Gone', days: 200 },
        { id: '710000000000000005', name: 'Long gone', days: 400 },
        { id: '710000000000000006', name: 'Ghost', days: null }
      ];

      async function started () {
        const guild = fakeGuild();
        const member = (person) => ({
          id: person.id,
          displayName: person.name,
          permissions: permissions(),
          user: { id: person.id, username: person.name.toLowerCase().replace(/ /g, ''), bot: false },
          roles: { cache: new Map() }
        });
        guild.members.fetch = async (options) => {
          if (!options) return new Map(people.map((person) => [person.id, member(person)]));
          const person = people.find((entry) => entry.id === options.user);
          if (!person) throw new Error('Unknown Member');
          return member(person);
        };
        const operations = new FakeOperations();
        const service = campaignCommunity(operations);
        await service.start();
        const discord = operations.connect(new FakeDiscord(guild));
        service.activity((target) => {
          const person = people.find((entry) => `discord/users/${entry.id}` === target);
          return person && person.days !== null ? new Date(Date.now() - person.days * DAY).toISOString() : null;
        });
        return { service, discord };
      }

      it('checks in once per tier, most inactive first, never with the active or the never seen', async function () {
        const { service, discord } = await started();
        const { campaigns } = service;
        const order = {};
        for (const { tier, draft } of checkin.drafts(contract)) {
          const step = checkin.plan(draft, campaigns.list(), { spacingDays: contract.spacingDays });
          const saved = await campaigns.create(step.draft, { owner: step.draft.owner, by: 'test' });
          const before = discord.dms.length;
          await campaigns.schedule(saved.id, { preview: (await campaigns.preview(saved.id)).id });
          while (await campaigns.tick());
          order[tier] = discord.dms.slice(before).map((dm) => people.find((person) => person.id === dm.id).name);
        }
        assert.deepStrictEqual(order, {
          'very-old': ['Long gone', 'Gone'],
          'somewhat-old': ['Away'],
          'getting-old': ['Drifting']
        });
        assert.ok(discord.dms[0].payload.content.startsWith(contract.tiers[0].message));

        const { draft } = checkin.drafts(contract)[0];
        const again = checkin.plan(draft, campaigns.list(), { spacingDays: contract.spacingDays });
        const rerun = await campaigns.create(again.draft, { owner: again.draft.owner, by: 'test' });
        const preview = await campaigns.preview(rerun.id);
        assert.strictEqual(preview.reach, 0, 'a tier reaches a member once');
        assert.strictEqual(preview.excluded, 4, 'its own two, plus the two the other tiers just reached (spacing)');
        assert.strictEqual(preview.unseen, 1, 'Ghost has no activity on record');
        await service.stop();
      });

      it('runs the check-in script for members of the home server only, and records it', async function () {
        const { service, discord } = await started();
        const session = (guildId) => ({ user: 'discord/users/710000000000000004', context: { guildId } });
        assert.strictEqual(await service.authorize(contract.requirement.name, session(GUILD)), true);
        assert.strictEqual(await service.authorize(contract.requirement.name, session('999999999999999999')), false);
        assert.ok(!service.campaignScripts().some((script) => script.id === 'checkin'), '/goon campaign never offers it');

        const { draft } = checkin.drafts(contract)[0];
        const saved = await service.campaigns.create(draft, { owner: draft.owner });
        await service.campaigns.schedule(saved.id, { preview: (await service.campaigns.preview(saved.id)).id });
        while (await service.campaigns.tick());
        const before = discord.dms.length;
        const answer = await service.campaigns.answer(saved.id, 'start', { user: 'discord/users/710000000000000004' });
        assert.strictEqual(answer.ok, true, answer.error);
        await until(() => discord.dms.length > before);

        const scripts = service.scripts;
        const active = () => Object.values(scripts.content.sessions).find((entry) => entry.script === 'checkin' && entry.status === 'active');
        let walked = 0;
        while (active() && walked++ < 20) {
          const current = active();
          const step = scripts.definition('checkin').steps[current.step];
          const options = current.options[current.step] || [];
          const value = step.input.type === 'confirm' ? true
            : step.input.type === 'choice' ? (step.input.multiple ? [options[0].id, options[1].id] : options[0].id)
              : 'Back after the holidays';
          const result = await scripts.answer(current.id, current.step, value, { user: 'discord/users/710000000000000004' });
          assert.strictEqual(result.ok, true, `${current.step}: ${result.error}`);
        }
        const texts = discord.dms.slice(before).map((dm) => dm.payload.content || '');
        assert.ok(texts.every((text) => !text.includes('{{')), 'every placeholder is filled');
        assert.ok(texts.some((text) => text.includes('Notes: Back after the holidays')), 'the summary shows the answers');
        assert.ok(texts[texts.length - 1].startsWith('Thanks, that'), texts[texts.length - 1]);
        const [result] = scripts.results('checkin');
        assert.strictEqual(result.completedByName, 'Gone');
        assert.deepStrictEqual(result.answers.reach, 'yes');
        await service.stop();
      });

      describe('preview, then Send (services/checkins.js)', function () {
        const Checkins = require('../services/checkins');
        let clock;

        async function opened () {
          const { service, discord } = await started();
          clock = Date.now();
          const checkins = new Checkins({ path: path.join(dir, 'checkins'), community: service, now: () => clock });
          await checkins.start();
          const stop = async () => { await checkins.stop(); await service.stop(); };
          return { service, discord, checkins, stop };
        }

        it('the preview saves drafts, names every recipient, shows the questions, and sends nothing', async function () {
          const { service, discord, checkins, stop } = await opened();
          assert.ok(!('enabled' in checkins.status()), 'there is no switch: nothing goes out by itself');
          const preview = await checkins.preview();
          assert.ok(/^[0-9a-f]{8}$/.test(preview.id));
          assert.deepStrictEqual(preview.tiers.map((tier) => [tier.id, tier.status, tier.reach, tier.recipients]), [
            ['very-old', 'draft', 2, ['Long gone (@longgone)', 'Gone']],
            ['somewhat-old', 'draft', 1, ['Away']],
            ['getting-old', 'draft', 1, ['Drifting']]
          ]);
          assert.ok(preview.tiers.every((tier) => !('preview' in tier)), 'the Doorman preview ids stay inside');
          assert.strictEqual(preview.tiers[0].message, contract.tiers[0].message);
          assert.strictEqual(preview.script.id, 'checkin');
          assert.ok(preview.script.questions.length >= 3, 'every question, without the confirm step');
          assert.ok(preview.script.questions.some((question) => question.options.length > 0));
          assert.strictEqual(discord.dms.length, 0);
          assert.ok(service.campaigns.list().every((campaign) => campaign.status === 'draft'));

          const again = await checkins.preview();
          assert.notStrictEqual(again.id, preview.id);
          assert.strictEqual(service.campaigns.list().length, 3, 'previewing again reuses the drafts');
          while (await service.campaigns.tick());
          assert.strictEqual(discord.dms.length, 0, 'drafts never send by themselves');
          await stop();
        });

        it('Send reaches exactly the members previewed, most inactive first, once per tier', async function () {
          const { service, discord, checkins, stop } = await opened();
          const preview = await checkins.preview();
          const run = await checkins.send({ preview: preview.id, by: 'Kersa' });
          assert.deepStrictEqual(run.map((entry) => [entry.tier, entry.status, entry.reach]), [['very-old', 'sending', 2], ['somewhat-old', 'sending', 1], ['getting-old', 'sending', 1]]);
          await assert.rejects(checkins.send({ preview: preview.id }), (error) => error.status === 409, 'a preview sends once');
          while (await service.campaigns.tick());
          const name = (dm) => people.find((person) => person.id === dm.id).name;
          assert.deepStrictEqual(discord.dms.map(name), ['Long gone', 'Gone', 'Away', 'Drifting']);
          assert.deepStrictEqual(Object.keys(checkins.touched).sort(), ['710000000000000002', '710000000000000003', '710000000000000004', '710000000000000005']);

          const everyone = people.map((person) => ({ target: `discord/users/${person.id}` }));
          const veryOld = { title: checkin.title(contract.tiers[0]) };
          assert.deepStrictEqual(checkins.narrow(everyone, veryOld).map((person) => person.target.slice(-1)), ['1', '6'], 'reached members are dropped even without excludeCampaigns');
          assert.strictEqual(checkins.narrow(everyone, { title: 'Fleet night' }).length, people.length, 'other campaigns pass through');

          // A week on, Recent has gone quiet too: nothing goes out until someone previews and sends again.
          const recent = people[0];
          recent.days = 45;
          try {
            clock += 7 * 24 * 60 * 60 * 1000;
            while (await service.campaigns.tick());
            assert.strictEqual(discord.dms.length, 4);
            const next = await checkins.preview();
            assert.deepStrictEqual(next.tiers.map((tier) => [tier.id, tier.reach, tier.recipients]), [['very-old', 0, []], ['somewhat-old', 0, []], ['getting-old', 1, ['Recent']]]);
            const second = await checkins.send({ preview: next.id });
            assert.deepStrictEqual(second.map((entry) => [entry.tier, entry.reach]), [['very-old', 0], ['somewhat-old', 0], ['getting-old', 1]]);
            while (await service.campaigns.tick());
            assert.deepStrictEqual(discord.dms.slice(4).map(name), ['Recent']);
          } finally {
            recent.days = 10;
          }

          const json = JSON.stringify(checkins.status());
          assert.ok(!/\d{17,}/.test(json) && !json.includes('Recent') && !json.includes('Kersa'), json);
          await stop();
        });

        it('refuses an out-of-date preview, and leaves out members who stopped qualifying since', async function () {
          const { service, discord, checkins, stop } = await opened();
          const first = await checkins.preview();
          const second = await checkins.preview();
          await assert.rejects(checkins.send({ preview: first.id }), (error) => error.status === 409 && /\/goon checkins/.test(error.message));
          await assert.rejects(checkins.send({}), (error) => error.status === 409);
          assert.strictEqual(discord.dms.length, 0);

          const gone = people.find((person) => person.name === 'Gone');
          gone.days = 5;
          try {
            const run = await checkins.send({ preview: second.id });
            assert.deepStrictEqual(run[0], { tier: 'very-old', campaign: run[0].campaign, reach: 1, status: 'sending' });
            while (await service.campaigns.tick());
            assert.ok(!discord.dms.some((dm) => dm.id === gone.id), 'back in voice since the preview, so not sent');
          } finally {
            gone.days = 200;
          }
          await stop();
        });

        it('Stop cancels check-ins still going out, and a restart forgets the preview but not who was reached', async function () {
          const { service, discord, checkins } = await opened();
          await checkins.send({ preview: (await checkins.preview()).id, by: 'Kersa' });
          await service.campaigns.tick();
          const { cancelled } = await checkins.halt({ by: 'Kersa' });
          assert.strictEqual(cancelled, 3);
          while (await service.campaigns.tick());
          assert.strictEqual(discord.dms.length, 1, 'nothing more goes out');
          assert.ok(service.campaigns.list().every((campaign) => campaign.status === 'cancelled'));

          const shown = await checkins.preview();
          await checkins.stop();
          const again = new Checkins({ path: path.join(dir, 'checkins'), community: service, now: () => clock });
          await again.start();
          assert.ok(again.status().lastRunAt);
          assert.strictEqual(Object.keys(again.touched).length, 1);
          await assert.rejects(again.send({ preview: shown.id }), (error) => error.status === 409, 'preview again after a restart');
          await again.stop();
          await service.stop();
        });
      });
    });

    describe('welcome DMs (services/welcome.js)', function () {
      const Welcome = require('../services/welcome');
      const welcomeContract = require('../functions/welcome').load();
      const HOUR = 60 * 60 * 1000;
      const role = (name) => Object.assign({}, ...Object.values(welcomeContract.exclude))[name];
      const GUESTS = '1298538145410977944';
      const people = [
        { id: '720000000000000001', name: 'Newbie', hours: 3 * 24, roles: [] },
        { id: '720000000000000002', name: 'Fresh', hours: 2, roles: [] },
        { id: '720000000000000003', name: 'Oldtimer', hours: 90 * 24, roles: [] },
        { id: '720000000000000004', name: 'Ally', hours: 5 * 24, roles: [role('[INFN] INFINITY INDUSTRIES')] },
        { id: '720000000000000005', name: 'Prospect', hours: 10 * 24, roles: [role('PERMAFLEET'), role('[P] Prospect I')] },
        { id: '720000000000000006', name: 'Guest', hours: 20 * 24, roles: [GUESTS] },
        { id: '720000000000000007', name: 'Steward', hours: 4 * 24, roles: [role('ORG STEWARDS')] }
      ];
      let clock;

      async function started () {
        const joined = Date.now();
        const guild = fakeGuild();
        const member = (person) => ({
          id: person.id,
          displayName: person.name,
          joinedTimestamp: joined - person.hours * HOUR,
          permissions: permissions(),
          user: { id: person.id, username: person.name.toLowerCase(), bot: false },
          roles: { cache: new Map(person.roles.map((id) => [id, { id }])) }
        });
        guild.members.fetch = async (options) => {
          if (!options) return new Map(people.map((person) => [person.id, member(person)]));
          const person = people.find((entry) => entry.id === options.user);
          if (!person) throw new Error('Unknown Member');
          return member(person);
        };
        const operations = new FakeOperations();
        const service = campaignCommunity(operations);
        await service.start();
        const discord = operations.connect(new FakeDiscord(guild));
        clock = joined;
        const welcome = new Welcome({ path: path.join(dir, 'welcome'), community: service, now: () => clock });
        await welcome.start();
        const name = (dm) => people.find((person) => person.id === dm.id).name;
        return { service, discord, welcome, name, stop: async () => { await welcome.stop(); await service.stop(); } };
      }

      it('the preview saves a draft, names everyone it reaches, says who is skipped, and sends nothing', async function () {
        const { service, discord, welcome, stop } = await started();
        assert.ok(!('enabled' in welcome.status()), 'there is no switch: nothing goes out by itself');
        const preview = await welcome.preview();
        assert.strictEqual(preview.reach, 2, 'Newbie and Guest');
        assert.deepStrictEqual(preview.recipients.slice().sort(), ['Guest', 'Newbie']);
        assert.ok(!('preview' in preview), 'the Doorman preview id stays inside');
        assert.deepStrictEqual([preview.recent, preview.earlier, preview.welcomed], [1, 1, 0], 'Fresh joined too recently; Oldtimer before the window');
        assert.strictEqual(preview.message, welcomeContract.message);
        assert.ok(preview.roles.alliance.includes('[AIM] A.I.M.O.S.'));
        assert.strictEqual(preview.script.id, 'permafleet-apply');
        assert.ok(preview.script.questions.some((question) => /RSI handle/.test(question.say)));
        const again = await welcome.preview();
        assert.strictEqual(service.campaigns.list().length, 1, 'previewing again reuses the draft');
        await assert.rejects(welcome.send({ preview: preview.id }), (error) => error.status === 409 && /\/goon welcome/.test(error.message), 'only the latest preview sends');
        assert.notStrictEqual(again.id, preview.id);
        while (await service.campaigns.tick());
        assert.strictEqual(discord.dms.length, 0);
        await stop();
      });

      it('Send welcomes the members previewed, once; members due later wait for the next preview', async function () {
        const { service, discord, welcome, name, stop } = await started();
        const run = await welcome.send({ preview: (await welcome.preview()).id, by: 'Kersa' });
        assert.deepStrictEqual([run.status, run.reach], ['sending', 2]);
        while (await service.campaigns.tick());
        assert.deepStrictEqual(discord.dms.map(name).sort(), ['Guest', 'Newbie']);
        const card = discord.dms[0].payload;
        assert.ok(card.content.startsWith(welcomeContract.message), card.content);
        assert.strictEqual(card.components[0].components[0].label, 'Start');

        clock += 24 * HOUR;
        while (await service.campaigns.tick());
        assert.strictEqual(discord.dms.length, 2, 'Fresh is due now, but nothing goes out by itself');
        const next = await welcome.preview();
        assert.deepStrictEqual([next.reach, next.recipients], [1, ['Fresh']]);
        const second = await welcome.send({ preview: next.id });
        assert.deepStrictEqual([second.status, second.reach], ['sending', 1]);
        while (await service.campaigns.tick());
        assert.deepStrictEqual(discord.dms.slice(2).map(name), ['Fresh']);

        clock += HOUR;
        const third = await welcome.send({ preview: (await welcome.preview()).id });
        assert.deepStrictEqual([third.status, third.reach], ['draft', 0], 'nobody is welcomed twice');
        const json = JSON.stringify(welcome.status());
        assert.strictEqual(welcome.status().welcomed, 3);
        assert.ok(!/\d{17,}/.test(json) && !json.includes('Newbie') && !json.includes('Kersa'), json);
        await stop();
      });

      it('walks a new member through applying, and records it for leadership', async function () {
        const { service, discord, welcome, stop } = await started();
        await welcome.send({ preview: (await welcome.preview()).id, by: 'Kersa' });
        while (await service.campaigns.tick());
        const before = discord.dms.length;
        const campaign = service.campaigns.list().find((entry) => entry.title === welcomeContract.title && entry.status === 'sent');
        const answer = await service.campaigns.answer(campaign.id, 'start', { user: 'discord/users/720000000000000001' });
        assert.strictEqual(answer.ok, true, answer.error);
        await until(() => discord.dms.length > before);

        const scripts = service.scripts;
        const active = () => Object.values(scripts.content.sessions).find((entry) => entry.script === 'permafleet-apply' && entry.status === 'active');
        let walked = 0;
        while (active() && walked++ < 20) {
          const current = active();
          const step = scripts.definition('permafleet-apply').steps[current.step];
          const options = current.options[current.step] || [];
          const value = step.input.type === 'confirm' ? true
            : step.input.type === 'choice' ? (step.input.multiple ? [options[0].id, options[1].id] : options[0].id)
              : step.input.pattern ? 'New_Pilot' : 'A friend in voice';
          const result = await scripts.answer(current.id, current.step, value, { user: 'discord/users/720000000000000001' });
          assert.strictEqual(result.ok, true, `${current.step}: ${result.error}`);
        }
        const texts = discord.dms.slice(before).map((dm) => dm.payload.content || '');
        assert.ok(texts.every((text) => !text.includes('{{')), 'every placeholder is filled');
        assert.ok(texts.some((text) => text.includes('RSI handle: New_Pilot')), 'the summary shows the answers');
        assert.ok(texts[texts.length - 1].startsWith('Sent. Once leadership finds your RSI application'), texts[texts.length - 1]);
        const [result] = scripts.results('permafleet-apply');
        assert.strictEqual(result.completedByName, 'Newbie');
        assert.strictEqual(result.answers.handle, 'New_Pilot');
        assert.strictEqual(result.answers.rsi, 'applied');

        assert.strictEqual(await service.authorize(welcomeContract.requirement.name, { user: 'discord/users/720000000000000001', context: { guildId: '999999999999999999' } }), false, 'members of the home server only');
        assert.ok(!service.campaignScripts().some((script) => script.id === 'permafleet-apply'), '/goon campaign never offers it');
        await stop();
      });

      it('Stop cancels welcomes still going out, and those members are due again', async function () {
        const { service, discord, welcome, stop } = await started();
        await welcome.send({ preview: (await welcome.preview()).id, by: 'Kersa' });
        await service.campaigns.tick();
        const { cancelled } = await welcome.halt({ by: 'Kersa' });
        assert.strictEqual(cancelled, 1);
        while (await service.campaigns.tick());
        assert.strictEqual(discord.dms.length, 1, 'nothing more goes out');
        assert.strictEqual((await welcome.preview()).reach, 1, 'the cancelled one is due again');
        await stop();
      });
    });
  });

  it('keeps the Doorman host for plugins when DM scripts are off', async function () {
    assert.strictEqual(Community.enabled({ enabled: false }), false);
    const operations = new FakeOperations();
    const service = community({ enabled: false, operations });
    await service.start();
    assert.strictEqual(service.scripts, null);
    operations.connect(new FakeDiscord(fakeGuild()));
    assert.strictEqual(service.adapter.canWhisper, false);
    await assert.rejects(service.beginScript('goon-setup', {}), /Setup scripts are off/);
    await service.stop();
  });
});
