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
    const service = community({ operations });
    await service.start();
    assert.strictEqual(service.gateway.status, 'waiting');
    const discord = operations.connect(new FakeDiscord(guild));
    assert.strictEqual(service.gateway.status, 'attached');
    assert.strictEqual(service.adapter.canSend, false, 'chat is never answered');
    assert.strictEqual(service.adapter.canWhisper, true);
    assert.deepStrictEqual(service.scripts.list().map((script) => script.id).sort(), [
      'goon-setup', 'permafleet-channel', 'permafleet-council', 'permafleet-embassy', 'permafleet-voice',
      'recruit-bravo-squadron', 'recruit-permafleet-officers', 'recruit-turtle-brigade'
    ]);
    assert.deepStrictEqual(service.campaignScripts(), [], 'scripts that need a permission or rank are never offered to /goon campaign');

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

    assert.ok(last().content.includes('Which org is joining PERMAFLEET?'));
    const answer = ids().find((id) => id.endsWith(':submit') || id.endsWith(':modal'));
    await press(answer.replace(/:modal$/, ':submit'), { fields: { getTextInputValue: () => 'PERMAFLEET' } });

    assert.ok(last().content.includes('Who are your Org Stewards'));
    const before = discord.dms.length;
    discord.emit('activity', {
      type: 'DiscordMessage',
      actor: { username: 'kersa', ref: ADMIN },
      object: { id: 'm1', content: 'Kersa, Ratgrot' },
      target: { ref: 'dm-channel', type: 'dm' }
    });
    await until(() => discord.dms.length > before);

    assert.ok(last().content.includes('Missing on **G00N SQUAD** right now: Read Message History.'), last().content);
    assert.ok(last().content.includes('https://goon.vc/services/discord/invite'));
    await press(ids()[0]);

    assert.ok(last().content.includes('- Features: Clip library, PERMAFLEET membership'), last().content);
    assert.ok(last().content.includes('- Calendar: n/a'));
    assert.ok(last().content.includes('- Clips channel: #clips'));
    assert.ok(last().content.includes('- Org Stewards: Kersa, Ratgrot'));
    await press(ids()[0]);
    assert.ok(last().content.startsWith('Saved.'), last().content);

    const result = service.scripts.results('goon-setup').find((entry) => entry.subject === GUILD);
    assert.deepStrictEqual(result.answers, {
      welcome: true,
      features: ['clips', 'permafleet'],
      clipsChannel: CLIPS,
      org: 'PERMAFLEET',
      stewards: 'Kersa, Ratgrot',
      permissions: true,
      summary: true
    });
    assert.strictEqual(result.context.guildName, 'G00N SQUAD');
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

    await presence.stop();
    await service.stop();
  });

  describe('PERMAFLEET channel scripts', function () {
    const BOT = '555555555555555555';
    const OFFICERS = '1190527980120850700';
    const STEWARDS = '1190527980120850701';
    const BOT_ROLE = '1190527980120850702';
    const ENOUGH = [BITS.ManageChannels, BITS.ViewChannel, BITS.SendMessages, BITS.ReadMessageHistory, BITS.Connect, BITS.Speak];

    /** fakeGuild plus roles, a bot that may or may not manage channels, and channels.create. */
    function channelGuild ({ grant = true } = {}) {
      const guild = fakeGuild();
      guild.members.me = { id: BOT, permissions: permissions(...(grant ? ENOUGH : [BITS.ViewChannel, BITS.SendMessages])) };
      guild.roles = {
        cache: new Map([
          [GUILD, { id: GUILD, name: '@everyone', position: 0 }],
          [STEWARDS, { id: STEWARDS, name: 'Org Stewards', position: 4 }],
          [OFFICERS, { id: OFFICERS, name: 'Officers', position: 5 }],
          [BOT_ROLE, { id: BOT_ROLE, name: 'goon.vc', position: 6, managed: true }]
        ])
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
      const service = community({ operations });
      await service.start();
      const discord = operations.connect(new FakeDiscord(guild));
      const begin = (script) => service.beginScript(script, {
        user: `discord/users/${ADMIN}`,
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
        { id: STEWARDS, label: 'Org Stewards' }
      ], 'highest first, never @everyone or a managed role');
      assert.deepStrictEqual(service.channelChoices({ guildId: GUILD }, require('../functions/allianceChannels').spec('council')).map((option) => option.id), ['new', CLIPS, GENERAL]);

      const session = await begin('permafleet-council');
      assert.ok(said().includes('private **#council** channel'), said());
      await service.scripts.answer(session.id, 'welcome', 'yes');
      await service.scripts.answer(session.id, 'channel', 'new');
      await service.scripts.answer(session.id, 'category', '1');
      assert.ok(said().includes('Who may see #council?'), said());
      await service.scripts.answer(session.id, 'roles', [OFFICERS, STEWARDS]);
      assert.ok(said().includes('- Who can see it: Officers, Org Stewards, and goon.vc\'s bot'), 'no permissions step when the bot has what it needs: ' + said());
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

    it('uses a channel the server already has instead of making a second one', async function () {
      const guild = channelGuild();
      const { service, begin, said } = await boot(guild);
      const voice = await begin('permafleet-voice');
      assert.deepStrictEqual(service.channelChoices({ guildId: GUILD }, require('../functions/allianceChannels').spec('voice')).map((option) => option.id), ['new', VOICE]);
      await service.scripts.answer(voice.id, 'welcome', 'yes');
      await service.scripts.answer(voice.id, 'channel', 'new');
      await service.scripts.answer(voice.id, 'category', 'skip');
      await service.scripts.answer(voice.id, 'summary', 'yes');
      assert.strictEqual(said(), `Using <#${VOICE}>; I left its permissions as they are. PERMAFLEET pilots can drop in any time. Run \`/goon voice\` again any time.`);

      const embassy = await begin('permafleet-embassy');
      await service.scripts.answer(embassy.id, 'welcome', 'yes');
      await service.scripts.answer(embassy.id, 'channel', GENERAL);
      assert.ok(said().includes('I\'ll use #general as #embassy'), said());
      await service.scripts.answer(embassy.id, 'existing', 'yes');
      assert.ok(said().startsWith(`Using <#${GENERAL}>;`), said());
      assert.strictEqual(guild.created.length, 0, 'nothing was created');
      await service.stop();
    });

    it('says what the bot lacks, with the invite that grants it, and creates nothing', async function () {
      const guild = channelGuild({ grant: false });
      const { service, begin, said } = await boot(guild);
      const session = await begin('permafleet-channel');
      await service.scripts.answer(session.id, 'welcome', 'yes');
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
      assert.strictEqual(Community.campaignsEnabled({ enabled: false, campaigns: { enabled: true }, Campaigns }), false);

      const Scripts = doorman('services/scripts');
      assert.deepStrictEqual(Community.gateway({ Scripts, Campaigns }), { intents: ['DirectMessages'], partials: ['Channel'] });
      assert.deepStrictEqual(Community.gateway({ Scripts, Campaigns, campaigns: { enabled: true } }), { intents: ['DirectMessages', 'GuildMembers'], partials: ['Channel'] });
      assert.deepStrictEqual(Community.gateway({ enabled: false, Scripts, Campaigns, campaigns: { enabled: true } }), { intents: [], partials: [] });
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
      assert.strictEqual((await campaigns.preview(draft.id)).reach, 2);
      await campaigns.schedule(draft.id, { by: 'Kersa' });
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
      await assert.rejects(campaigns.schedule(next.id), (error) => error.status === 429, 'one server campaign a day');

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
          await service.campaigns.schedule(saved.id);
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
