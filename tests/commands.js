'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const Key = require('@fabric/core/types/key');
const Alliance = require('../services/alliance');
const Commands = require('../services/commands');
const Community = require('../services/community');
const Leagues = require('../services/leagues');
const Market = require('../services/market');
const Members = require('../services/members');
const Presence = require('../services/presence');
const elo = require('../functions/elo');
const GUILD = '1190527980120850493';
const VOICE = '1236721094153732276';
const KERSA = { id: '111111111111111111', username: 'kersa', globalName: 'Kersa' };
const REMAEUS = { id: '420222636954615808', username: 'remaeus', globalName: 'remaeus' };
const RATGROT = { id: '222222222222222222', username: 'ratgrot', globalName: 'Rat' };
const REF = { id: '333333333333333333', username: 'ref', globalName: 'Referee' };
const NAMESAKE = { id: '444444444444444444', username: 'rat2', globalName: 'Rat' };
const BOT = { id: '999999999999999999', username: 'sensemaker', bot: true };
const START = Date.parse('2026-10-20T20:00:00.000Z');
const OPEN_LEAGUE_LINK = '[Open League](<https://goon.vc/leagues/open-league>)';

/** Stands in for the `@fabric/discord` client Operations runs. */
class FakeDiscord extends EventEmitter {
  constructor (existing = []) {
    super();
    this.botReady = true;
    this.created = [];
    const commands = {
      fetch: async () => new Map(existing.map((command) => [command.name, command])),
      create: async (command) => { this.created.push(command.toJSON()); }
    };
    this.client = Object.assign(new EventEmitter(), { application: { commands } });
  }
}

function interaction ({ name, subcommand, users = {}, members = {}, strings = {}, roles = {}, integers = {}, attachments = {}, user = REF, member = null, guildId = GUILD, focused = null, customId = null, permissions = 0n }) {
  const replies = [];
  const updates = [];
  const followUps = [];
  const call = {
    commandName: name,
    customId,
    guildId,
    guild: guildId ? { id: guildId, name: 'G00N SQUAD' } : null,
    user,
    member: member || { displayName: user.globalName },
    memberPermissions: { has: (bit) => (permissions & bit) === bit },
    deferred: false,
    replies,
    updates,
    followUps,
    deferReply: async (payload) => { call.deferred = true; call.deferredWith = payload; },
    deferUpdate: async () => { call.deferredUpdate = true; },
    editReply: async (payload) => { replies.push(payload); },
    followUp: async (payload) => { followUps.push(payload); },
    isAutocomplete: () => focused !== null,
    isButton: () => customId !== null,
    isChatInputCommand: () => focused === null && customId === null,
    options: {
      getSubcommand: () => subcommand,
      getUser: (key) => users[key] || null,
      getMember: (key) => members[key] || null,
      getString: (key) => (strings[key] === undefined ? null : strings[key]),
      getRole: (key) => roles[key] || null,
      getInteger: (key) => (integers[key] === undefined ? null : integers[key]),
      getAttachment: (key) => attachments[key] || null,
      getFocused: () => focused
    },
    reply: async (payload) => { replies.push(payload); },
    update: async (payload) => { updates.push(payload); },
    respond: async (choices) => { replies.push(choices); }
  };
  return call;
}

/** Stands in for services/community.js: records the scripts it is asked to start. */
class FakeCommunity {
  constructor (refuse = null) {
    this.scripts = {};
    this.begun = [];
    this.refuse = refuse;
  }

  async beginScript (id, options) {
    if (this.refuse) throw this.refuse;
    this.begun.push({ id, options });
    return { id: 'abcdef012345', script: id, status: 'active', step: 'welcome' };
  }
}

const DOORMAN = process.env.FABRIC_DOORMAN || path.resolve(__dirname, '../../doorman');
const HAS_CAMPAIGNS = fs.existsSync(path.join(DOORMAN, 'services/campaigns.js'));
const PILOTS = { id: '777777777777777777', name: 'Pilots' };
const MUTED = { id: '888888888888888888', name: 'Muted' };

/** Stands in for services/community.js with a real Doorman Campaigns plugin. */
class CampaignCommunity extends FakeCommunity {
  constructor (campaigns, roster) {
    super();
    this.scripts = null;
    this.campaigns = campaigns;
    this.managers = new Set([KERSA.id]);
    this.checked = [];
    campaigns.audience('discord', async (filter, campaign) => (roster[campaign.owner.guildId] || [])
      .filter((person) => !filter.roles.length || filter.roles.some((role) => person.roles.includes(role)))
      .filter((person) => !filter.excludeRoles.some((role) => person.roles.includes(role)))
      .map((person) => ({ target: `discord/users/${person.id}`, name: person.name, source: campaign.owner.guildId, sourceName: 'G00N SQUAD' })));
    const host = Object.assign(new EventEmitter(), {
      started: async () => ({ definition: (id) => (id === 'welcome' ? { id } : null) }),
      whisper: async () => {}
    });
    campaigns.trust(host);
  }

  campaignScripts () {
    return [{ id: 'welcome', title: 'Welcome aboard' }];
  }

  async can (userId, guildId) {
    this.checked.push({ userId, guildId });
    return this.managers.has(userId);
  }
}

/** `/1v1` run by `caller`; returns the card and the proposal id on its buttons. */
async function report (commands, caller, { winner, loser, score = '2-1', names = {}, league, note }) {
  const call = interaction({
    name: '1v1',
    user: caller,
    member: names[caller.id] ? { displayName: names[caller.id] } : null,
    users: { winner, loser },
    members: {
      winner: names[winner.id] ? { displayName: names[winner.id] } : null,
      loser: names[loser.id] ? { displayName: names[loser.id] } : null
    },
    strings: Object.assign({ score }, league ? { league } : {}, note ? { note } : {})
  });
  await commands.handle(call);
  const card = call.replies[0];
  const buttons = card.components ? card.components[0].components : [];
  return { card, id: buttons.length ? buttons[0].custom_id.split(':')[2] : null };
}

/** A button press on a `/1v1` card. */
async function press (commands, user, action, id) {
  const call = interaction({ user, customId: `1v1:${action}:${id}` });
  await commands.handle(call);
  return call.updates[0] || call.replies[0];
}

describe('Discord application commands', function () {
  this.timeout(20000);
  let dir;
  let clock;
  let leagues;
  let members;

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-commands-'));
    clock = START;
    members = await new Members({ path: path.join(dir, 'members') }).start();
    leagues = await new Leagues({ path: path.join(dir, 'leagues'), now: () => clock, members }).start();
  });

  afterEach(async function () {
    await leagues.stop();
    await members.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('registers only its own commands, skipping unchanged ones, on the shared gateway client', async function () {
    const operations = new EventEmitter();
    const unchanged = { name: 'idlerpg', equals: () => true };
    const others = { name: 'activate', equals: () => false };
    const commands = new Commands({ operations, leagues });
    await commands.start();
    const discord = new FakeDiscord([unchanged, others]);
    operations.emit('gateway', discord);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(discord.created.map((command) => command.name), ['1v1', 'vote', 'help']);
    assert.strictEqual(discord.client.listenerCount('interactionCreate'), 1);
    for (const definition of Commands.DEFINITIONS) {
      if (definition.name === 'rsi' || definition.name === 'hangar') assert.deepStrictEqual(definition.contexts, [0, 1], `/${definition.name} also runs in the bot’s DMs`);
      else if (definition.name === 'market' || definition.name === 'help') assert.deepStrictEqual(definition.contexts, [0, 1, 2], `/${definition.name} runs anywhere`);
      else assert.deepStrictEqual(definition.contexts, [0], `/${definition.name} is for servers only`);
      assert.ok(definition.description.length <= 100);
    }
    const score = Commands.DEFINITIONS.find((definition) => definition.name === '1v1').options.find((option) => option.name === 'score');
    assert.ok(score.choices.length <= 25);
    assert.ok(score.choices.some((choice) => choice.value === '2-1' && choice.name === '2–1 (best of 3)'));
    await commands.stop();
    assert.strictEqual(discord.client.listenerCount('interactionCreate'), 0);

    const withSetup = new Commands({ operations: new EventEmitter(), leagues, community: new FakeCommunity() });
    const fresh = new FakeDiscord([unchanged]);
    await withSetup.start();
    withSetup.settings.operations.emit('gateway', fresh);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepStrictEqual(fresh.created.map((command) => command.name), ['1v1', 'goon', 'vote', 'help']);
    const goon = fresh.created.find((command) => command.name === 'goon');
    assert.strictEqual(goon.default_member_permissions, '32', '/goon is for members who can manage the server');
    assert.deepStrictEqual(goon.options.map((option) => option.name), ['setup', 'council', 'embassy', 'permafleet', 'voice', 'roles']);
    await withSetup.stop();
  });

  it('/help explains the commands running right now, anywhere, privately, and links no one', async function () {
    const commands = new Commands({ members, leagues, community: new FakeCommunity(), siteUrl: 'https://goon.vc', register: false });
    const help = commands.definitions.find((definition) => definition.name === 'help');
    assert.deepStrictEqual(help.options[0].choices.map((choice) => choice.value), ['idlerpg', '1v1', 'goon', 'vote', 'rsi'], 'only what runs');

    const ask = async (strings = {}) => {
      const call = interaction({ name: 'help', user: KERSA, guildId: null, strings });
      await commands.handle(call);
      assert.strictEqual(call.replies.length, 1);
      assert.strictEqual(call.replies[0].flags, 64, 'private');
      assert.ok(call.replies[0].content.length <= 2000);
      return call.replies[0].content;
    };
    const all = await ask();
    const lines = all.split('\n');
    assert.strictEqual(lines[0], '**goon.vc commands**');
    assert.ok(lines.includes('**/idlerpg** profile · leaderboard · stats — The alliance idle game: time in voice earns XP.'), all);
    assert.ok(lines.includes('**/goon** setup · council · embassy · permafleet · voice · roles (server managers) — Connect this server to goon.vc.'), all);
    assert.ok(lines.some((line) => line.startsWith('**/1v1** — Report a 1v1 duel')), all);
    assert.ok(!/\/market|\/hangar|\*\*\/help/.test(all), 'nothing that isn’t running, and not itself');
    assert.ok(lines[lines.length - 1].includes('<https://goon.vc/>'));

    const duel = await ask({ command: '1v1' });
    assert.ok(duel.includes('`/1v1 winner loser score [league] [note]`'), duel);
    assert.ok(duel.includes('<https://goon.vc/leagues/open-league>'), duel);
    assert.ok(duel.endsWith('In servers with the goon.vc bot.'), duel);
    const goon = await ask({ command: '/goon' });
    assert.ok(goon.includes('`/goon setup` — Walk through connecting this server to goon.vc, in your DMs.'), goon);
    assert.ok(goon.endsWith('Needs Manage Server.'), goon);
    const vote = await ask({ command: 'vote' });
    assert.ok(vote.includes('<https://goon.vc/operations/PERMAFLEET/votes>') && !/key/i.test(vote), vote);
    assert.strictEqual(await ask({ command: 'market' }), '`/market` isn’t running right now. Run `/help` for the commands that are.');
    assert.strictEqual(await members.getMember(`discord:${KERSA.id}`), null, 'asking for help makes no profile');
  });

  it('/goon council, embassy, permafleet, voice, and roles start their scripts in the caller’s DMs', async function () {
    const community = new FakeCommunity();
    const commands = new Commands({ members, community, register: false });
    const council = interaction({ name: 'goon', subcommand: 'council', user: KERSA, member: { displayName: 'Kersa' }, permissions: 32n });
    await commands.handle(council);
    assert.strictEqual(council.replies[0].content, 'Check your DMs: I’ve sent the first step of setting up #council on **G00N SQUAD**.');
    for (const subcommand of ['embassy', 'permafleet', 'voice']) {
      await commands.handle(interaction({ name: 'goon', subcommand, user: KERSA, permissions: 32n }));
    }
    const roles = interaction({ name: 'goon', subcommand: 'roles', user: KERSA, permissions: 32n });
    await commands.handle(roles);
    assert.strictEqual(roles.replies[0].content, 'Check your DMs: I’ve sent the first step of setting up the Prospect ranks on **G00N SQUAD**.');
    assert.deepStrictEqual(community.begun.map((entry) => entry.id), ['permafleet-council', 'permafleet-embassy', 'permafleet-channel', 'permafleet-voice', 'permafleet-roles']);
    assert.deepStrictEqual(community.begun[0].options.context, { guildId: GUILD, guildName: 'G00N SQUAD' });
    assert.strictEqual(community.begun[0].options.subject, GUILD);

    const refused = interaction({ name: 'goon', subcommand: 'voice', user: KERSA, permissions: 0n });
    await commands.handle(refused);
    assert.strictEqual(refused.replies[0].content, 'You need the Manage Server permission to set up goon.vc here.');
    const closed = interaction({ name: 'goon', subcommand: 'embassy', user: KERSA, permissions: 32n });
    await new Commands({ members, community: new FakeCommunity(Object.assign(new Error('Cannot send messages to this user'), { code: 50007 })), register: false }).handle(closed);
    assert.ok(closed.replies[0].content.endsWith('then run `/goon embassy` again.'), closed.replies[0].content);
    const outsider = interaction({ name: 'goon', subcommand: 'council', user: KERSA, permissions: 32n });
    const refusal = Object.assign(new Error('Only the officers PERMAFLEET leadership has on record can act for a member org.'), { status: 403, refusal: true });
    await new Commands({ members, community: new FakeCommunity(refusal), register: false }).handle(outsider);
    assert.strictEqual(outsider.replies[0].content, refusal.message, 'someone not on record is told why, privately');
  });

  it('/goon setup starts the setup script in the caller’s DMs', async function () {
    const community = new FakeCommunity();
    const commands = new Commands({ members, community, register: false });
    const call = interaction({ name: 'goon', subcommand: 'setup', user: KERSA, member: { displayName: 'Kersa | PF' }, permissions: 32n });
    await commands.handle(call);
    assert.deepStrictEqual(call.deferredWith, { flags: 64 }, 'answered privately, after the DM is sent');
    assert.deepStrictEqual(call.replies[0], {
      allowedMentions: { parse: [] },
      content: 'Check your DMs: I’ve sent the first step of connecting **G00N SQUAD** to goon.vc.'
    });
    assert.deepStrictEqual(community.begun, [{
      id: 'goon-setup',
      options: {
        user: `discord/users/${KERSA.id}`,
        name: 'Kersa | PF',
        context: { guildId: GUILD, guildName: 'G00N SQUAD' },
        subject: GUILD
      }
    }]);
    assert.strictEqual((await members.getMember(`discord:${KERSA.id}`)).displayName, 'Kersa | PF');
  });

  it('/goon setup refuses members who cannot manage the server, and explains closed DMs', async function () {
    const community = new FakeCommunity();
    const commands = new Commands({ members, community, register: false });
    const refused = interaction({ name: 'goon', subcommand: 'setup', user: KERSA, permissions: 0n });
    await commands.handle(refused);
    assert.strictEqual(refused.replies[0].content, 'You need the Manage Server permission to set up goon.vc here.');
    assert.strictEqual(community.begun.length, 0);

    const closed = new Commands({ members, community: new FakeCommunity(Object.assign(new Error('Cannot send messages to this user'), { code: 50007 })), register: false });
    const call = interaction({ name: 'goon', subcommand: 'setup', user: KERSA, permissions: 32n });
    await closed.handle(call);
    assert.ok(call.replies[0].content.startsWith('I couldn’t send you a DM. Allow direct messages from server members'), call.replies[0].content);

    const scriptRefusal = new Commands({ members, community: new FakeCommunity(Object.assign(new Error('You need the ManageGuild permission for this.'), { status: 403 })), register: false });
    const stale = interaction({ name: 'goon', subcommand: 'setup', user: KERSA, permissions: 32n });
    await scriptRefusal.handle(stale);
    assert.strictEqual(stale.replies[0].content, 'You need the ManageGuild permission for this.');

    const off = interaction({ name: 'goon', subcommand: 'setup', user: KERSA, permissions: 32n });
    await new Commands({ members, register: false }).handle(off);
    assert.strictEqual(off.replies[0].content, 'Server setup is not running right now.');
  });

  describe('/goon review', function () {
    class FakeReviews {
      constructor (pending = 2, error = null) {
        this.available = true;
        this.pending = pending;
        this.error = error;
        this.begun = [];
      }

      isReviewer (id) {
        return id === KERSA.id;
      }

      async begin (id, name) {
        if (this.error) throw this.error;
        this.begun.push({ id, name });
        return { pending: this.pending };
      }
    }

    const run = async (commands, user = KERSA) => {
      const call = interaction({ name: 'goon', subcommand: 'review', user, member: { displayName: 'Kersa' }, permissions: 32n });
      await commands.handle(call);
      return call.replies[0].content;
    };

    it('is offered only while reviews run', function () {
      const names = (reviews) => new Commands({ reviews, register: false }).definitions
        .find((definition) => definition.name === 'goon').options.map((option) => option.name);
      assert.deepStrictEqual(names(new FakeReviews()), ['review']);
      assert.deepStrictEqual(names(() => new FakeReviews()), ['review'], 'or the service, looked up lazily');
      assert.ok(!new Commands({ reviews: Object.assign(new FakeReviews(), { available: false }), register: false }).definitions.some((definition) => definition.name === 'goon'));
    });

    it('DMs a reviewer everyone waiting, and refuses everyone else', async function () {
      const reviews = new FakeReviews();
      const commands = new Commands({ members, reviews, register: false });
      assert.strictEqual(await run(commands), 'Check your DMs: 2 sign-ins are waiting for review.');
      assert.deepStrictEqual(reviews.begun, [{ id: KERSA.id, name: 'Kersa' }]);
      reviews.pending = 1;
      assert.strictEqual(await run(commands), 'Check your DMs: 1 sign-in is waiting for review.');
      reviews.pending = 0;
      assert.strictEqual(await run(commands), 'Nobody is waiting for review right now.');
      assert.strictEqual(await run(commands, RATGROT), 'Only goon.vc’s sign-in reviewers can review sign-ins.');
      assert.strictEqual(reviews.begun.length, 3, 'the last call never reached it');

      const closed = new Commands({ members, reviews: new FakeReviews(1, Object.assign(new Error('Cannot send messages to this user'), { code: 50007 })), register: false });
      assert.ok((await run(closed)).endsWith('then run `/goon review` again.'));
      assert.strictEqual(await run(new Commands({ members, register: false })), 'Sign-in reviews are not running right now.');
    });
  });

  describe('/goon campaign', function () {
    const OTHER_GUILD = '1236721094153700000';
    let campaigns;
    let community;
    let people;

    before(function () {
      if (!HAS_CAMPAIGNS) this.skip();
    });

    beforeEach(async function () {
      const Campaigns = require(path.join(DOORMAN, 'services/campaigns'));
      campaigns = await new Campaigns({ path: path.join(dir, 'campaigns'), intervalMs: 0, maxAudience: 3, requirePreview: true, now: () => clock }).start();
      people = [
        { id: KERSA.id, name: 'Kersa', roles: [PILOTS.id] },
        { id: RATGROT.id, name: 'Rat', roles: [PILOTS.id, MUTED.id] },
        { id: NAMESAKE.id, name: 'Rat', roles: [PILOTS.id] },
        { id: REF.id, name: 'Referee', roles: [] }
      ];
      community = new CampaignCommunity(campaigns, { [GUILD]: people, [OTHER_GUILD]: people.slice(0, 2) });
    });

    afterEach(async function () {
      await campaigns.stop();
    });

    const run = async (commands, options = {}) => {
      const call = interaction(Object.assign({ name: 'goon', subcommand: 'campaign', user: KERSA, member: { displayName: 'Kersa | PF' }, permissions: 32n }, options));
      await commands.handle(call);
      return call;
    };
    const buttons = (reply) => (reply.components ? reply.components[0].components : []);
    const press = async (commands, customId, user = KERSA, guildId = GUILD) => {
      const call = interaction({ user, customId, guildId });
      await commands.handle(call);
      return call;
    };

    it('is offered only while campaigns run', function () {
      const goon = (value) => new Commands({ community: value, register: false }).definitions.find((definition) => definition.name === 'goon');
      assert.deepStrictEqual(goon(community).options.map((option) => option.name), ['campaign']);
      assert.deepStrictEqual(goon(Object.assign(new FakeCommunity(), { campaigns })).options.map((option) => option.name), ['setup', 'council', 'embassy', 'permafleet', 'voice', 'roles', 'campaign']);
      assert.strictEqual(goon(null), undefined);
      const campaign = goon(community).options[0];
      assert.ok(campaign.description.length <= 100);
      assert.ok(campaign.options.every((option) => option.description.length <= 100));
      assert.deepStrictEqual(campaign.options.map((option) => option.name), ['message', 'role', 'exclude_role', 'active_days', 'script', 'send_at']);
    });

    it('previews privately with every recipient by name, then sends only to them when its author presses Send', async function () {
      const commands = new Commands({ members, community, register: false, now: () => clock });
      const call = await run(commands, { strings: { message: 'Fleet night Saturday!' }, roles: { role: PILOTS, exclude_role: MUTED } });
      assert.deepStrictEqual(call.deferredWith, { flags: 64 });
      const preview = call.replies[0];
      assert.strictEqual(preview.content, [
        '**Campaign preview** — G00N SQUAD',
        '> Fleet night Saturday!',
        `Reaches **2** members of <@&${PILOTS.id}>; skipping <@&${MUTED.id}>.`,
        'Goes out to the members listed below, one DM every few seconds, once you press Send. Every DM says it came from this server and has Stop buttons.'
      ].join('\n\n'));
      assert.deepStrictEqual(preview.embeds, [{ title: 'Goes to 2 members', description: 'Kersa, Rat.' }]);
      assert.deepStrictEqual(preview.allowedMentions, { parse: [] }, 'role mentions in the preview ping no one');
      const [send, cancel] = buttons(preview);
      assert.deepStrictEqual([send.label, cancel.label], ['Send', 'Cancel']);
      const [, , id, previewId] = send.custom_id.split(':');
      assert.deepStrictEqual(preview.files.map((file) => [file.name, file.attachment.toString('utf8')]), [['recipients.txt', `Campaign: ${campaigns.campaign(id).title} (2)\n1. Kersa\n2. Rat\n`]]);
      assert.ok(/^[0-9a-f]{8}$/.test(previewId), send.custom_id);
      assert.strictEqual(campaigns.campaign(id).status, 'draft');
      assert.deepStrictEqual(campaigns.campaign(id).owner, { kind: 'guild', guildId: GUILD, guildName: 'G00N SQUAD' });
      assert.strictEqual(campaigns.campaign(id).createdBy, 'Kersa | PF');

      const stranger = await press(commands, send.custom_id, REF);
      assert.strictEqual(stranger.followUps[0].content, 'Only whoever ran the command can send this campaign.');
      community.managers.delete(KERSA.id);
      const demoted = await press(commands, send.custom_id);
      assert.strictEqual(demoted.followUps[0].content, 'You need the Manage Server permission to send a campaign here.');
      assert.deepStrictEqual(community.checked.pop(), { userId: KERSA.id, guildId: GUILD }, 'checked fresh on Send');
      community.managers.add(KERSA.id);
      const bare = await press(commands, `campaign:send:${id}`);
      assert.ok(bare.followUps[0].content.startsWith('This preview is out of date, so nothing was sent.'), 'Send needs the preview it was shown on');
      assert.strictEqual(campaigns.campaign(id).status, 'draft');

      people.push({ id: '999999999999999999', name: 'Late', roles: [PILOTS.id] });
      const sent = await press(commands, send.custom_id);
      assert.strictEqual(sent.deferredUpdate, true);
      assert.deepStrictEqual(sent.replies[0], { allowedMentions: { parse: [] }, content: 'Sending to **2** of the members you previewed now, one every few seconds.', embeds: [], attachments: [], components: [] });
      assert.strictEqual(campaigns.campaign(id).status, 'sending');
      assert.strictEqual(campaigns.campaign(id).stats.targeted, 2, 'someone who joined after the preview is not sent to');
      const again = await press(commands, cancel.custom_id);
      assert.strictEqual(again.replies[0].content, 'This campaign is already sending.');

      const next = await run(commands, { strings: { message: 'Again' } });
      assert.ok(/^This server sent a campaign recently; the next one can go out <t:\d+:R>\.$/.test(next.replies[0].content), next.replies[0].content);
      assert.strictEqual(campaigns.list().length, 1, 'no draft is saved while the server is cooling down');
    });

    it('refuses a Send button from an older preview of the same campaign', async function () {
      const commands = new Commands({ members, community, register: false, now: () => clock });
      const call = await run(commands, { strings: { message: 'Fleet night' }, roles: { role: PILOTS } });
      const [send] = buttons(call.replies[0]);
      const id = send.custom_id.split(':')[2];
      const fresh = await campaigns.preview(id);
      const stale = await press(commands, send.custom_id);
      assert.strictEqual(stale.followUps[0].content, 'This preview is out of date, so nothing was sent. Run `/goon campaign` again to see who it reaches now.');
      assert.strictEqual(campaigns.campaign(id).status, 'draft');
      const sent = await press(commands, `campaign:send:${id}:${fresh.id}`);
      assert.ok(sent.replies[0].content.startsWith('Sending to **3**'), sent.replies[0].content);
    });

    it('schedules for later, offers a conversation, and cancels', async function () {
      const commands = new Commands({ members, community, register: false, now: () => clock });
      const call = await run(commands, { guildId: OTHER_GUILD, strings: { message: 'Welcome!', script: 'welcome', send_at: 'in 2 hours' } });
      const preview = call.replies[0];
      const at = Math.floor((clock + 2 * 60 * 60 * 1000) / 1000);
      assert.ok(preview.content.includes('Reaches **2** members of **G00N SQUAD**.'), preview.content);
      assert.ok(preview.content.includes('Offers **Welcome aboard** behind a Start button.'));
      assert.ok(preview.content.includes(`Goes out <t:${at}:f> (<t:${at}:R>)`));
      const [schedule] = buttons(preview);
      assert.strictEqual(schedule.custom_id.split(':').slice(0, 2).join(':'), 'campaign:schedule');
      assert.strictEqual(schedule.custom_id.split(':')[3], String(at));
      assert.ok(/^[0-9a-f]{8}$/.test(schedule.custom_id.split(':')[4]), 'Schedule carries the preview id');
      const id = schedule.custom_id.split(':')[2];
      assert.deepStrictEqual(campaigns.campaign(id).content, { type: 'script', script: 'welcome', text: 'Welcome!' });

      const elsewhere = await press(commands, schedule.custom_id, KERSA, GUILD);
      assert.strictEqual(elsewhere.followUps[0].content, 'This campaign is no longer here.', 'a campaign belongs to its server');
      const done = await press(commands, schedule.custom_id, KERSA, OTHER_GUILD);
      assert.strictEqual(done.replies[0].content, `Scheduled: **2** DMs go out <t:${at}:f> (<t:${at}:R>), to the members you previewed.`);
      assert.strictEqual(campaigns.campaign(id).status, 'scheduled');

      const draft = await run(commands, { strings: { message: 'Never mind' }, roles: { role: PILOTS } });
      const cancel = buttons(draft.replies[0]).find((button) => button.label === 'Cancel');
      const cancelled = await press(commands, cancel.custom_id);
      assert.strictEqual(cancelled.replies[0].content, 'Cancelled. Nothing was sent.');
      assert.strictEqual(campaigns.campaign(cancel.custom_id.split(':')[2]).status, 'cancelled');

      const choices = interaction({ name: 'goon', focused: 'wel' });
      await commands.handle(choices);
      assert.deepStrictEqual(choices.replies[0], [{ name: 'Welcome aboard', value: 'welcome' }]);
    });

    it('does not send unless remaeus initiates it', async function () {
      community.maySendCampaign = (userId) => userId === REMAEUS.id;
      community.managers.add(REMAEUS.id);
      const commands = new Commands({ members, community, register: false, now: () => clock });
      const kersa = await run(commands, { strings: { message: 'Fleet night' }, roles: { role: PILOTS } });
      assert.ok(kersa.replies[0].content.includes(Community.CAMPAIGN_SEND_REFUSAL), kersa.replies[0].content);
      assert.deepStrictEqual(buttons(kersa.replies[0]).map((button) => button.label), ['Cancel']);
      const draft = campaigns.campaign(campaigns.list()[0].id);
      const sneak = await press(commands, `campaign:send:${draft.id}:${draft.preview.id}`);
      assert.strictEqual(sneak.followUps[0].content, Community.CAMPAIGN_SEND_REFUSAL);
      assert.strictEqual(campaigns.campaign(draft.id).status, 'draft');

      const rem = await run(commands, { user: REMAEUS, member: { displayName: 'remaeus' }, strings: { message: 'From remaeus' }, roles: { role: PILOTS } });
      const [send] = buttons(rem.replies[0]);
      assert.strictEqual(send.label, 'Send');
      const sent = await press(commands, send.custom_id, REMAEUS);
      assert.ok(sent.replies[0].content.startsWith('Sending to'), sent.replies[0].content);
    });

    it('refuses non-managers, unknown conversations, bad times, and audiences over the cap', async function () {
      const commands = new Commands({ members, community, register: false, now: () => clock });
      const refused = await run(commands, { permissions: 0n, strings: { message: 'Hi' } });
      assert.strictEqual(refused.replies[0].content, 'You need the Manage Server permission to send a campaign here.');
      const unknown = await run(commands, { strings: { message: 'Hi', script: 'nope' } });
      assert.strictEqual(unknown.replies[0].content, 'There is no conversation called `nope`. Pick one from the list.');
      const late = await run(commands, { strings: { message: 'Hi', send_at: 'in 40 days' } });
      assert.strictEqual(late.replies[0].content, 'Campaigns can be scheduled up to 30 days ahead.');
      const garbled = await run(commands, { strings: { message: 'Hi', send_at: 'soonish' } });
      assert.ok(garbled.replies[0].content.startsWith('I couldn’t read `send_at`.'));
      assert.strictEqual(campaigns.list().length, 0);

      const everyone = await run(commands, { strings: { message: 'Hi all' } });
      assert.ok(everyone.replies[0].content.includes('Reaches **4** members of **G00N SQUAD**.'), everyone.replies[0].content);
      assert.ok(everyone.replies[0].content.includes('That is more than the **3** a server campaign may reach. Narrow it with a role.'));
      assert.deepStrictEqual(buttons(everyone.replies[0]).map((button) => button.label), ['Cancel']);

      const off = await run(new Commands({ members, community: new FakeCommunity(), register: false }), { strings: { message: 'Hi' } });
      assert.strictEqual(off.replies[0].content, 'Campaigns are not running right now.');
    });

    it('reads send_at as a delay or a date', function () {
      const { parseSendAt } = Commands;
      assert.strictEqual(parseSendAt('', START), null);
      assert.strictEqual(parseSendAt('now', START), null);
      assert.strictEqual(parseSendAt('in 90 minutes', START), START + 90 * 60 * 1000);
      assert.strictEqual(parseSendAt('in 2d', START), START + 2 * 24 * 60 * 60 * 1000);
      assert.strictEqual(parseSendAt('2026-10-21T18:00:00Z', START), Date.parse('2026-10-21T18:00:00Z'));
      assert.strictEqual(parseSendAt('2026-10-01T18:00:00Z', START), null, 'a past time sends now');
      assert.throws(() => parseSendAt('in 31 days', START), /30 days/);
      assert.throws(() => parseSendAt('tomorrowish', START), /couldn’t read/);
    });
  });

  describe('/goon checkins', function () {
    /** Stands in for services/checkins.js. */
    class FakeCheckins {
      constructor () {
        this.available = true;
        this.guildId = GUILD;
        this.sending = 0;
        this.shown = null;
        this.contract = { tiers: [{ id: 'very-old', name: 'Very old' }, { id: 'getting-old', name: 'Getting old' }] };
        this.changes = [];
      }

      status () {
        return { available: true, lastRunAt: null, lastRun: [], sending: this.sending, error: null };
      }

      async preview () {
        this.shown = this.shown ? 'bbbbbbbb' : 'aaaaaaaa';
        return {
          id: this.shown,
          status: this.status(),
          tiers: [
            { id: 'very-old', name: 'Very old', message: 'Hey {{name}}, it’s been a while.', status: 'draft', reach: 3, excluded: 2, optedOut: 1, recipients: ['Kersa (@kersa)', 'Rat_Grot', 'Neo'] },
            { id: 'getting-old', name: 'Getting old', message: 'Missed you lately!', status: 'draft', reach: 0, recipients: [] }
          ],
          script: { id: 'checkin', title: 'Checking in', questions: [{ say: 'What kept you away?', options: ['Work', 'Other games'], optional: true }, { say: 'Anything else?', options: [], optional: false }] }
        };
      }

      async send ({ preview, by }) {
        if (preview !== this.shown) throw Object.assign(new Error('This preview is out of date. Run `/goon checkins` again to see who it reaches now.'), { status: 409 });
        this.changes.push({ send: preview, by });
        this.shown = null;
        this.sending = 1;
        return [{ tier: 'very-old', reach: 3, status: 'sending' }, { tier: 'getting-old', reach: 0, status: 'draft' }];
      }

      async halt ({ by }) {
        this.changes.push({ halt: true, by });
        this.sending = 0;
        return { cancelled: 1 };
      }
    }

    const run = async (commands, options = {}) => {
      const call = interaction(Object.assign({ name: 'goon', subcommand: 'checkins', user: KERSA, member: { displayName: 'Kersa' }, permissions: 32n }, options));
      await commands.handle(call);
      return call;
    };
    const press = async (commands, customId, user = KERSA, guildId = GUILD) => {
      const call = interaction({ user, customId, guildId, member: { displayName: 'Kersa' } });
      await commands.handle(call);
      return call;
    };

    it('is offered only while check-ins can run', function () {
      const names = (checkins) => {
        const goon = new Commands({ community: { campaigns: {} }, checkins, register: false }).definitions.find((definition) => definition.name === 'goon');
        return goon.options.map((option) => option.name);
      };
      assert.deepStrictEqual(names(new FakeCheckins()), ['campaign', 'checkins']);
      assert.deepStrictEqual(names(Object.assign(new FakeCheckins(), { available: false })), ['campaign']);
      assert.deepStrictEqual(names(null), ['campaign']);
    });

    it('previews every recipient by name, and sends only that preview when Send is pressed', async function () {
      const checkins = new FakeCheckins();
      const community = { campaigns: {}, can: async (userId) => userId === KERSA.id };
      const commands = new Commands({ members, community, checkins, register: false });
      const call = await run(commands);
      assert.deepStrictEqual(call.deferredWith, { flags: 64 });
      const preview = call.replies[0];
      assert.ok(preview.content.startsWith('**Check-ins preview.** Nothing has been sent.\n\nSend DMs the **3** members named below, most inactive first'), preview.content);
      assert.deepStrictEqual(preview.embeds.map((embed) => embed.title), ['Very old', 'Getting old', 'Start opens: Checking in']);
      assert.ok(preview.embeds[0].description.startsWith('Reaches **3** members; skipping 2 already reached, 1 opted out.\n\n**To:** Kersa (@kersa), Rat\\_Grot, Neo.\n\n> Hey {{name}}'), preview.embeds[0].description);
      assert.ok(preview.embeds[1].description.startsWith('Reaches **0** members.\n\n> Missed you'), preview.embeds[1].description);
      assert.strictEqual(preview.embeds[2].description, '1. What kept you away? *(optional)*\n   Work · Other games\n\n2. Anything else?');
      assert.deepStrictEqual(preview.files.map((file) => [file.name, file.attachment.toString('utf8')]), [['recipients.txt', 'Very old (3)\n1. Kersa (@kersa)\n2. Rat_Grot\n3. Neo\n']]);
      assert.deepStrictEqual(preview.components[0].components.map((button) => [button.label, button.custom_id]), [['Send to 3 members', 'checkins:send:aaaaaaaa'], ['Cancel', 'checkins:cancel']]);
      assert.strictEqual(checkins.changes.length, 0, 'nothing is sent from the preview');

      const stranger = await press(commands, 'checkins:send:aaaaaaaa', REF);
      assert.strictEqual(stranger.followUps[0].content, 'You need the Manage Server permission to manage check-ins.');
      const fresh = await run(commands);
      const stale = await press(commands, 'checkins:send:aaaaaaaa');
      assert.strictEqual(stale.followUps[0].content, 'This preview is out of date. Run `/goon checkins` again to see who it reaches now.');
      assert.strictEqual(checkins.changes.length, 0);

      const sent = await press(commands, fresh.replies[0].components[0].components[0].custom_id);
      assert.strictEqual(sent.deferredUpdate, true);
      assert.strictEqual(sent.replies[0].content, 'Going out now to the members you previewed, most inactive first, one DM every few seconds:\n• Very old: **3**\n• Getting old: nobody\n\nNothing more goes out until someone runs `/goon checkins` and presses Send again.');
      assert.deepStrictEqual([sent.replies[0].embeds, sent.replies[0].attachments, sent.replies[0].components], [[], [], []]);
      assert.deepStrictEqual(checkins.changes, [{ send: 'bbbbbbbb', by: 'Kersa' }]);

      const again = await run(commands);
      assert.ok(again.replies[0].content.includes('1 earlier check-in is still going out; Stop cancels what hasn’t been sent yet.'), again.replies[0].content);
      assert.deepStrictEqual(again.replies[0].components[0].components.map((button) => button.custom_id), ['checkins:send:aaaaaaaa', 'checkins:stop', 'checkins:cancel']);
      const stopped = await press(commands, 'checkins:stop');
      assert.strictEqual(stopped.replies[0].content, 'Stopped. 1 check-in that hadn’t gone out yet won’t be sent.');
      const cancelled = await press(commands, 'checkins:cancel');
      assert.strictEqual(cancelled.replies[0].content, 'Cancelled. Nothing was sent.');
      assert.strictEqual(checkins.changes.filter((change) => change.send).length, 1);
    });

    it('is for managers of the home server only', async function () {
      const checkins = new FakeCheckins();
      const commands = new Commands({ members, community: { campaigns: {}, can: async () => true }, checkins, register: false });
      const refused = await run(commands, { permissions: 0n });
      assert.strictEqual(refused.replies[0].content, 'You need the Manage Server permission to manage check-ins.');
      const elsewhere = await run(commands, { guildId: '1236721094153700000' });
      assert.strictEqual(elsewhere.replies[0].content, 'Check-ins are run from the G00N SQUAD server.');
      const pressed = await press(commands, 'checkins:send:aaaaaaaa', KERSA, '1236721094153700000');
      assert.strictEqual(pressed.followUps[0].content, 'Check-ins are run from the G00N SQUAD server.');
      assert.strictEqual(checkins.changes.length, 0);
      const off = await run(new Commands({ members, community: { campaigns: {} }, register: false }));
      assert.strictEqual(off.replies[0].content, 'Check-ins are not running right now.');
    });
  });

  describe('/goon welcome', function () {
    /** Stands in for services/welcome.js. */
    class FakeWelcome {
      constructor () {
        this.available = true;
        this.guildId = GUILD;
        this.sending = 0;
        this.shown = null;
        this.changes = [];
      }

      status () {
        return { available: true, delayHours: 24, windowDays: 30, sending: this.sending };
      }

      async preview () {
        this.shown = 'cccccccc';
        return {
          id: this.shown,
          status: this.status(),
          message: '**Welcome to G00N SQUAD!**\nApply to PERMAFLEET.',
          reach: 2,
          recipients: ['Newbie (@newbie)', 'Fresh'],
          recent: 2,
          welcomed: 5,
          optedOut: 0,
          roles: { alliance: ['[TRDE] TRANS-GALACTIC', 'ORG STEWARDS'], permafleet: ['PERMAFLEET', '[P] Prospect I'] },
          script: { id: 'permafleet-apply', title: 'Join PERMAFLEET', questions: [{ say: 'What’s your RSI handle?', options: [], optional: false }] }
        };
      }

      async send ({ preview, by }) {
        if (preview !== this.shown) throw Object.assign(new Error('This preview is out of date. Run `/goon welcome` again to see who it reaches now.'), { status: 409 });
        this.changes.push({ send: preview, by });
        this.shown = null;
        this.sending = 1;
        return { campaign: 'abcdefabcdef', reach: 2, status: 'sending' };
      }

      async halt ({ by }) {
        this.changes.push({ halt: true, by });
        this.sending = 0;
        return { cancelled: 4 };
      }
    }

    const run = async (commands, options = {}) => {
      const call = interaction(Object.assign({ name: 'goon', subcommand: 'welcome', user: KERSA, member: { displayName: 'Kersa' }, permissions: 32n }, options));
      await commands.handle(call);
      return call;
    };
    const press = async (commands, customId, user = KERSA, guildId = GUILD) => {
      const call = interaction({ user, customId, guildId, member: { displayName: 'Kersa' } });
      await commands.handle(call);
      return call;
    };

    it('is offered only while welcome DMs can run', function () {
      const names = (welcome) => new Commands({ community: { campaigns: {} }, welcome, register: false }).definitions
        .find((definition) => definition.name === 'goon').options.map((option) => option.name);
      assert.deepStrictEqual(names(new FakeWelcome()), ['campaign', 'welcome']);
      assert.deepStrictEqual(names(Object.assign(new FakeWelcome(), { available: false })), ['campaign']);
      const goon = new Commands({ community: { campaigns: {} }, welcome: new FakeWelcome(), register: false }).definitions.find((definition) => definition.name === 'goon');
      assert.ok(goon.options.find((option) => option.name === 'welcome').description.length <= 100);
    });

    it('previews the DM and everyone it reaches by name, then sends only that preview for managers of the home server', async function () {
      const welcome = new FakeWelcome();
      const community = { campaigns: {}, can: async (userId) => userId === KERSA.id };
      const commands = new Commands({ members, community, welcome, register: false });
      const call = await run(commands);
      const preview = call.replies[0];
      assert.ok(preview.content.startsWith('**Welcome DM preview.** Nothing has been sent.\n\nSend DMs this to the **2** members named below'), preview.content);
      assert.ok(preview.content.includes('Members with any of these roles never get it: \\[TRDE\\] TRANS-GALACTIC, ORG STEWARDS, PERMAFLEET, \\[P\\] Prospect I.'), preview.content);
      assert.deepStrictEqual(preview.embeds.map((embed) => embed.title), ['The welcome DM', 'Start opens: Join PERMAFLEET']);
      assert.ok(preview.embeds[0].description.startsWith('Reaches **2** members who joined in the last 30 days; skipping 2 joined under 24 hours ago (due later), 5 already welcomed.\n\n**To:** Newbie (@newbie), Fresh.\n\n> **Welcome to G00N SQUAD!**'), preview.embeds[0].description);
      assert.deepStrictEqual(preview.files.map((file) => file.attachment.toString('utf8')), ['Welcome: join PERMAFLEET (2)\n1. Newbie (@newbie)\n2. Fresh\n']);
      assert.deepStrictEqual(preview.components[0].components.map((button) => [button.label, button.custom_id]), [['Send to 2 members', 'welcome:send:cccccccc'], ['Cancel', 'welcome:cancel']]);
      assert.strictEqual(welcome.changes.length, 0, 'nothing is sent from the preview');

      const stranger = await press(commands, 'welcome:send:cccccccc', REF);
      assert.strictEqual(stranger.followUps[0].content, 'You need the Manage Server permission to manage welcome DMs.');
      const elsewhere = await press(commands, 'welcome:send:cccccccc', KERSA, '1236721094153700000');
      assert.strictEqual(elsewhere.followUps[0].content, 'Welcome DMs are run from the G00N SQUAD server.');
      const forged = await press(commands, 'welcome:send:dddddddd');
      assert.ok(forged.followUps[0].content.startsWith('This preview is out of date.'));
      const sent = await press(commands, 'welcome:send:cccccccc');
      assert.strictEqual(sent.replies[0].content, 'Sending to **2** of the members you previewed now, one DM every few seconds. Nothing more goes out until someone runs `/goon welcome` and presses Send again.');
      assert.deepStrictEqual(welcome.changes, [{ send: 'cccccccc', by: 'Kersa' }]);

      const again = await run(commands);
      assert.deepStrictEqual(again.replies[0].components[0].components.map((button) => button.custom_id), ['welcome:send:cccccccc', 'welcome:stop', 'welcome:cancel']);
      const stopped = await press(commands, 'welcome:stop');
      assert.strictEqual(stopped.replies[0].content, 'Stopped. 4 welcome DMs that hadn’t gone out yet won’t be sent.');

      const refused = await run(commands, { permissions: 0n });
      assert.strictEqual(refused.replies[0].content, 'You need the Manage Server permission to manage welcome DMs.');
      const missing = await run(new Commands({ members, community, register: false }));
      assert.strictEqual(missing.replies[0].content, 'Welcome DMs are not running right now.');
    });
  });

  it('/1v1 posts a card for the opponent, logs the duel once they confirm, and links both players', async function () {
    const commands = new Commands({ leagues, members, register: false });
    const names = { [KERSA.id]: 'Kersa | PF' };
    const { card, id } = await report(commands, KERSA, { winner: KERSA, loser: RATGROT, names, note: 'Gladius vs Arrow' });
    assert.ok(card.content.startsWith(`<@${RATGROT.id}>, **Kersa \\| PF** says they beat you 2–1 (best of 3) in the ${OPEN_LEAGUE_LINK}.\n> Gladius vs Arrow\nConfirm to log it.`), card.content);
    assert.deepStrictEqual(card.allowedMentions, { users: [RATGROT.id] }, 'only the opponent is pinged');
    assert.deepStrictEqual(card.components[0].components.map((button) => [button.label, button.custom_id]), [
      ['Confirm', `1v1:confirm:${id}`],
      ['Decline', `1v1:decline:${id}`]
    ]);
    assert.ok(!card.flags);
    assert.strictEqual((await leagues.getLeague(Leagues.OPEN_LEAGUE_ID)).duels.length, 0, 'nothing counts before the opponent confirms');
    const caller = await members.getMember(`discord:${KERSA.id}`);
    assert.deepStrictEqual([caller.displayName, caller.accounts[0].profile.username, caller.accounts[0].via, caller.lastLoginAt], ['Kersa | PF', 'kersa', 'command', null]);
    assert.strictEqual(await members.getMember(`discord:${RATGROT.id}`), null);

    clock += 60 * 60 * 1000;
    assert.deepStrictEqual(await press(commands, REF, 'confirm', id), { content: 'Only Rat can confirm this duel.', flags: 64, allowedMentions: { parse: [] } });
    assert.strictEqual((await press(commands, KERSA, 'confirm', id)).content, 'Waiting for Rat to confirm.');

    const confirmed = await press(commands, RATGROT, 'confirm', id);
    const gain = Math.round(elo.exchange(1000, 1000, 3, 32));
    assert.deepStrictEqual(confirmed, {
      allowedMentions: { parse: [] },
      components: [],
      content: `**Kersa \\| PF** beat **Rat** 2–1 (best of 3) in the ${OPEN_LEAGUE_LINK}. Confirmed by Rat.\nKersa \\| PF 1000 → ${1000 + gain} · Rat 1000 → ${1000 - gain}\n> Gladius vs Arrow`
    });
    const league = await leagues.getLeague(Leagues.OPEN_LEAGUE_ID);
    const duel = league.duels[0];
    assert.deepStrictEqual(
      [duel.winner, duel.loser, duel.score, duel.by, duel.confirmedBy, duel.playedAt, duel.loggedAt],
      ['Kersa | PF', 'Rat', [2, 1], 'Kersa | PF', 'Rat', new Date(START).toISOString(), new Date(clock).toISOString()]
    );
    assert.ok(!JSON.stringify(league).includes(KERSA.id) && !JSON.stringify(league).includes('discord:'), 'no Discord ids or member links in public');
    assert.strictEqual((await members.getMember(`discord:${RATGROT.id}`)).displayName, 'Rat');

    const again = await press(commands, RATGROT, 'confirm', id);
    assert.ok(again.content.startsWith('**Kersa \\| PF** beat **Rat** 2–1'), 'a settled card just shows its outcome');
    assert.strictEqual((await leagues.getLeague(Leagues.OPEN_LEAGUE_ID)).duels.length, 1);
  });

  it('/1v1 finds players by their Discord account, claims typed names, and keeps namesakes apart', async function () {
    await leagues.addPlayer(Leagues.OPEN_LEAGUE_ID, 'Rat');
    const commands = new Commands({ leagues, members, register: false });
    const first = await report(commands, KERSA, { winner: KERSA, loser: RATGROT, names: { [KERSA.id]: 'Kersa | PF' } });
    await press(commands, RATGROT, 'confirm', first.id);

    const renamed = { [KERSA.id]: 'K', [NAMESAKE.id]: 'Rat' };
    const second = await report(commands, KERSA, { winner: KERSA, loser: NAMESAKE, score: '1-0', names: renamed });
    const confirmed = await press(commands, NAMESAKE, 'confirm', second.id);
    assert.ok(confirmed.content.startsWith('**Kersa \\| PF** beat **Rat (rat2)** 1–0 (best of 1)'), confirmed.content);

    const third = await report(commands, RATGROT, { winner: RATGROT, loser: KERSA, score: '1-0', names: renamed });
    const thirdCard = await press(commands, KERSA, 'confirm', third.id);
    assert.ok(thirdCard.content.startsWith('**Rat** beat **Kersa \\| PF**'), thirdCard.content);

    const league = await leagues.getLeague(Leagues.OPEN_LEAGUE_ID);
    assert.deepStrictEqual(league.players, ['Rat', 'Kersa | PF', 'Rat (rat2)']);
    assert.ok(league.log.some((entry) => entry.type === 'link' && entry.name === 'Rat'), 'the typed name was claimed, not duplicated');
  });

  it('/1v1 keeps roster links on the member through pre-account ids and merges', async function () {
    await leagues.addPlayer(Leagues.OPEN_LEAGUE_ID, 'Old Rat');
    await members.store.set(`/members/discord:${RATGROT.id}`, { id: `discord:${RATGROT.id}`, createdAt: '2026-01-01T00:00:00.000Z', provider: 'discord', discord: { id: RATGROT.id, username: 'ratgrot' }, displayName: 'Old Rat' });
    const raw = await leagues.store.get(`/league/${Leagues.OPEN_LEAGUE_ID}`);
    raw.players.find((player) => player.name === 'Old Rat').member = `discord:${RATGROT.id}`;
    await leagues.store.set(`/league/${Leagues.OPEN_LEAGUE_ID}`, raw);
    await leagues.relinkMembers();
    const rat = await members.resolve(`discord:${RATGROT.id}`);
    assert.strictEqual((await leagues.store.get(`/league/${Leagues.OPEN_LEAGUE_ID}`)).players[0].member, rat.id, 'pre-account links move to the member');

    const commands = new Commands({ leagues, members, register: false });
    const { id } = await report(commands, KERSA, { winner: KERSA, loser: RATGROT, names: { [KERSA.id]: 'Kersa | PF', [RATGROT.id]: 'Rat' } });
    assert.ok((await press(commands, RATGROT, 'confirm', id)).content.startsWith('**Kersa \\| PF** beat **Old Rat**'));

    const desktop = `fabric:${'ab'.repeat(32)}`;
    const keyholder = await members.memberFor(desktop, { create: true, via: 'passport', displayName: 'Desktop Kersa' });
    await leagues.addPlayer(Leagues.OPEN_LEAGUE_ID, 'Desktop Kersa');
    const league = await leagues.store.get(`/league/${Leagues.OPEN_LEAGUE_ID}`);
    league.players.find((player) => player.name === 'Desktop Kersa').member = keyholder.id;
    await leagues.store.set(`/league/${Leagues.OPEN_LEAGUE_ID}`, league);

    const kersa = await members.resolve(`discord:${KERSA.id}`);
    const { member, merged } = await members.link(keyholder.id, `discord:${KERSA.id}`, { via: 'oauth' });
    assert.ok(merged);
    assert.strictEqual(member.id, kersa.id, 'the older member survives');
    await leagues.relinkMembers();
    const after = await leagues.store.get(`/league/${Leagues.OPEN_LEAGUE_ID}`);
    assert.deepStrictEqual(after.players.map((player) => [player.name, player.member || null]), [
      ['Old Rat', rat.id],
      ['Kersa | PF', kersa.id],
      ['Desktop Kersa', null]
    ]);
    assert.deepStrictEqual(after.log.filter((entry) => entry.type === 'merge').map((entry) => [entry.name, entry.other]), [['Kersa | PF', 'Desktop Kersa']]);
  });

  it('/1v1 cards close without logging when declined, withdrawn, or expired', async function () {
    const commands = new Commands({ leagues, members, register: false });
    const names = { [KERSA.id]: 'Kersa', [RATGROT.id]: 'Rat' };
    const claim = `~~Kersa beat Rat 1–0 (best of 1)~~ in the ${OPEN_LEAGUE_LINK}`;

    const declined = await report(commands, RATGROT, { winner: KERSA, loser: RATGROT, score: '1-0', names });
    assert.ok(declined.card.content.startsWith(`<@${KERSA.id}>, **Rat** says you beat them 1–0 (best of 1)`), declined.card.content);
    assert.strictEqual((await press(commands, REF, 'decline', declined.id)).content, 'Only Kersa or Rat can decline this duel.');
    assert.strictEqual((await press(commands, KERSA, 'decline', declined.id)).content, `${claim}: declined by Kersa, so it was not logged.`);

    const withdrawn = await report(commands, RATGROT, { winner: KERSA, loser: RATGROT, score: '1-0', names });
    assert.strictEqual((await press(commands, RATGROT, 'decline', withdrawn.id)).content, `${claim}: withdrawn by Rat, so it was not logged.`);

    const expired = await report(commands, RATGROT, { winner: KERSA, loser: RATGROT, score: '1-0', names });
    clock += 8 * 24 * 60 * 60 * 1000;
    assert.strictEqual((await press(commands, KERSA, 'confirm', expired.id)).content, `${claim}: expired before Kersa confirmed it, so it was not logged.`);

    assert.strictEqual((await leagues.getLeague(Leagues.OPEN_LEAGUE_ID)).duels.length, 0);
    assert.strictEqual(await members.getMember(`discord:${KERSA.id}`), null, 'declining links nobody');
  });

  it('/1v1 refuses bots, self-duels, other people’s duels, and unknown leagues privately', async function () {
    const commands = new Commands({ leagues, members, register: false });
    const cases = [
      [KERSA, { winner: KERSA, loser: BOT }, {}, 'Bots don’t duel.'],
      [KERSA, { winner: KERSA, loser: KERSA }, {}, 'A pilot cannot duel themselves.'],
      [REF, { winner: KERSA, loser: RATGROT }, {}, 'You can only log a duel you fought. Ask Kersa or Rat to run `/1v1`; the other one confirms it.'],
      [KERSA, { winner: KERSA, loser: RATGROT }, { league: 'nope' }, 'There is no league `nope`. Pick one from the list.']
    ];
    for (const [user, users, strings, message] of cases) {
      const call = interaction({ name: '1v1', user, users, strings: Object.assign({ score: '1-0' }, strings) });
      await commands.handle(call);
      assert.strictEqual(call.replies[0].content, message);
      assert.strictEqual(call.replies[0].flags, 64);
    }
    const outside = interaction({ name: '1v1', user: KERSA, users: { winner: KERSA, loser: RATGROT }, strings: { score: '1-0' }, guildId: null });
    await commands.handle(outside);
    assert.strictEqual(outside.replies[0].content, 'Use this in a server.');
    assert.strictEqual((await members.getMember(`discord:${REF.id}`)).displayName, 'Referee', 'running a command creates the caller’s profile');
    assert.strictEqual(await members.getMember(`discord:${RATGROT.id}`), null, 'naming someone does not');
  });

  it('/1v1 offers leagues by name and logs to the one picked', async function () {
    await leagues.createLeague({ name: 'Gladius Cup League', kind: 'seasonal', bestOf: 1 });
    const commands = new Commands({ leagues, members, register: false });
    const complete = interaction({ name: '1v1', focused: 'glad' });
    await commands.handle(complete);
    assert.deepStrictEqual(complete.replies[0], [{ name: 'Gladius Cup League', value: 'gladius-cup-league' }]);
    const { card, id } = await report(commands, RATGROT, { winner: RATGROT, loser: KERSA, score: '1-0', league: 'gladius-cup-league' });
    assert.ok(card.content.includes('[Gladius Cup League](<https://goon.vc/leagues/gladius-cup-league>)'), card.content);
    await press(commands, KERSA, 'confirm', id);
    assert.strictEqual((await leagues.getLeague('gladius-cup-league')).duels.length, 1);
    assert.strictEqual((await leagues.getLeague(Leagues.OPEN_LEAGUE_ID)).duels.length, 0);
  });

  describe('/vote', function () {
    let alliance;
    let proposal;

    beforeEach(async function () {
      const file = path.join(dir, 'alliance.json');
      fs.writeFileSync(file, JSON.stringify({
        name: 'PERMAFLEET',
        network: 'mainnet',
        publisher: 'G00N',
        organizations: [{ symbol: 'G00N', officers: [`discord:${KERSA.id}`] }, { symbol: 'INFN' }, { symbol: 'TRDE' }]
      }));
      alliance = await new Alliance({ path: path.join(dir, 'alliance'), file, xprv: new Key().xprv, members, now: () => clock }).start();
      await members.linkDiscord(KERSA, 'Kersa');
      const kersa = await alliance.actorFor(`discord:${KERSA.id}`);
      proposal = await alliance.propose({ title: 'Adopt the charter', days: 7 }, kersa);
      await alliance.propose({ title: 'Closed already', days: 1 }, kersa);
    });

    afterEach(async function () {
      await alliance.stop();
    });

    it('is registered for every server', function () {
      const vote = Commands.DEFINITIONS.find((definition) => definition.name === 'vote');
      assert.ok(vote, '/vote is defined');
      assert.ok(!('default_member_permissions' in vote), 'any member may vote');
      assert.deepStrictEqual(vote.options.map((option) => [option.name, !!option.required, !!option.autocomplete]), [['proposal', true, true], ['choice', true, false]]);
      assert.deepStrictEqual(vote.options[1].choices.map((choice) => choice.value), ['yes', 'no', 'abstain']);
    });

    it('offers open proposals by title or id', async function () {
      const commands = new Commands({ members, alliance: () => alliance, register: false });
      const byTitle = interaction({ name: 'vote', focused: 'charter' });
      await commands.handle(byTitle);
      assert.deepStrictEqual(byTitle.replies[0], [{ name: 'Adopt the charter', value: proposal.shortId }]);
      clock += 2 * 24 * 60 * 60 * 1000;
      const byId = interaction({ name: 'vote', focused: '' });
      await commands.handle(byId);
      assert.deepStrictEqual(byId.replies[0].map((choice) => choice.name), ['Adopt the charter'], 'expired proposals are not offered');
    });

    it('records the caller’s vote privately, once per member, and links them', async function () {
      const commands = new Commands({ members, alliance: () => alliance, register: false });
      const call = interaction({ name: 'vote', user: RATGROT, strings: { proposal: proposal.shortId, choice: 'yes' } });
      await commands.handle(call);
      const reply = call.replies[0];
      assert.strictEqual(reply.flags, 64);
      assert.deepStrictEqual(reply.allowedMentions, { parse: [] });
      assert.ok(reply.content.startsWith('Recorded your **yes** on **Adopt the charter**.'), reply.content);
      assert.ok(reply.content.includes('Members: 1 yes, 0 no, 0 abstain (advisory).'), reply.content);
      assert.ok(reply.content.includes('Orgs: 0 of 2 yes needed'), reply.content);
      assert.ok(reply.content.includes(`(<https://goon.vc/operations/PERMAFLEET/votes/${proposal.shortId}>)`), reply.content);
      assert.ok(!reply.content.includes(RATGROT.id));
      assert.strictEqual((await members.getMember(`discord:${RATGROT.id}`)).displayName, 'Rat', 'the voter gets a goon.vc profile');

      const again = interaction({ name: 'vote', user: RATGROT, strings: { proposal: proposal.shortId, choice: 'no' } });
      await commands.handle(again);
      assert.ok(again.replies[0].content.includes('Members: 0 yes, 1 no, 0 abstain'), again.replies[0].content);
      assert.ok(!again.replies[0].content.includes('as an officer'));
      const view = await alliance.getProposal(proposal.id);
      assert.deepStrictEqual(view.members, { yes: 0, no: 1, abstain: 0, total: 1 });
      assert.strictEqual(view.tally.yes + view.tally.no, 0, 'member votes do not count as org votes');
    });

    it('signs for the org when an officer on record votes, and counts their member vote', async function () {
      const commands = new Commands({ members, alliance: () => alliance, register: false });
      const call = interaction({ name: 'vote', user: KERSA, strings: { proposal: proposal.shortId, choice: 'yes' } });
      await commands.handle(call);
      const reply = call.replies[0].content;
      assert.match(reply, /Signed for \*\*.+\*\* as an officer: 1 of 1 officers needed agree\. .+ votes \*\*yes\*\*\./);
      assert.ok(reply.includes('Members: 1 yes, 0 no, 0 abstain (advisory).'), reply);
      assert.ok(reply.includes('Orgs: 1 of 2 yes needed'), reply);
      assert.ok(!/key/i.test(reply) && !reply.includes(KERSA.id), reply);
      const view = await alliance.getProposal(proposal.id);
      assert.strictEqual(view.tally.yes, 1);
      assert.deepStrictEqual(view.members, { yes: 1, no: 0, abstain: 0, total: 1 });
    });

    it('refuses bots, unknown or closed proposals, and an alliance that is not set up', async function () {
      const commands = new Commands({ members, alliance: () => alliance, register: false });
      const ask = async (options) => {
        const call = interaction(Object.assign({ name: 'vote' }, options));
        await commands.handle(call);
        return call.replies[0].content;
      };
      assert.strictEqual(await ask({ user: BOT, strings: { proposal: proposal.shortId, choice: 'yes' } }), 'Bots don’t vote.');
      assert.strictEqual(await ask({ strings: { proposal: 'charter', choice: 'yes' } }), 'Pick the proposal from the list.');
      assert.strictEqual(await ask({ strings: { proposal: '000000000000', choice: 'yes' } }), 'No such proposal.');
      clock += 2 * 24 * 60 * 60 * 1000;
      const closed = (await alliance.listProposals()).find((row) => row.title === 'Closed already');
      assert.match(await ask({ strings: { proposal: closed.shortId, choice: 'yes' } }), /closed \(expired\)/);
      const off = new Commands({ members, register: false });
      const call = interaction({ name: 'vote', strings: { proposal: proposal.shortId, choice: 'yes' } });
      await off.handle(call);
      assert.strictEqual(call.replies[0].content, 'Alliance votes are not set up right now.');
    });
  });

  it('/idlerpg creates a goon.vc profile for whoever checks', async function () {
    const commands = new Commands({ members, register: false });
    const call = interaction({ name: 'idlerpg', subcommand: 'stats', user: KERSA, member: { displayName: 'Kersa | PF' } });
    await commands.handle(call);
    assert.strictEqual(call.replies[0].content, 'IdleRPG is not running right now.');
    const member = await members.getMember(`discord:${KERSA.id}`);
    assert.deepStrictEqual([member.accounts[0].key, member.displayName, member.accounts[0].profile.username, member.lastLoginAt], [`discord:${KERSA.id}`, 'Kersa | PF', 'kersa', null]);
    await members.store.set(`/members/${member.id}`, Object.assign({}, member, { displayName: 'Kersa' }));
    await commands.handle(interaction({ name: 'idlerpg', subcommand: 'leaderboard', user: KERSA, member: { displayName: 'K' } }));
    assert.strictEqual((await members.getMember(`discord:${KERSA.id}`)).displayName, 'Kersa', 'an existing display name is kept');
  });

  it('/idlerpg shows profiles, the leaderboard, and stats without member ids', async function () {
    const presence = await new Presence({ path: path.join(dir, 'presence'), tickMs: 0, gateway: false }).start();
    try {
      const user = `discord/users/${KERSA.id}`;
      await presence.game._registerUser({ id: user, name: 'Kersa' });
      await presence.game._handleJoin({ user, channel: `discord/channels/${VOICE}` });
      await presence.game.tick();
      const commands = new Commands({ presence, leagues, register: false });

      const mine = interaction({ name: 'idlerpg', subcommand: 'profile', user: KERSA });
      await commands.handle(mine);
      const profile = await presence.discordPlayer(KERSA.id);
      assert.ok(mine.replies[0].content.startsWith(`**Kersa** — level ${profile.level}, rank 1 of 1`), mine.replies[0].content);
      assert.ok(mine.replies[0].content.includes(`(<https://goon.vc/services/idlerpg/players/${profile.id}>)`));
      assert.ok(!mine.replies[0].content.includes(KERSA.id));

      const theirs = interaction({ name: 'idlerpg', subcommand: 'profile', users: { pilot: RATGROT }, members: { pilot: { displayName: 'Rat' } }, user: KERSA });
      await commands.handle(theirs);
      assert.strictEqual(theirs.replies[0].content, 'Rat hasn’t played yet. Time in a voice channel earns XP.');
      assert.strictEqual(theirs.replies[0].flags, 64);

      const top = interaction({ name: 'idlerpg', subcommand: 'leaderboard' });
      await commands.handle(top);
      assert.ok(top.replies[0].content.includes('1. **Kersa** — level'), top.replies[0].content);

      const stats = interaction({ name: 'idlerpg', subcommand: 'stats' });
      await commands.handle(stats);
      assert.ok(stats.replies[0].content.startsWith('**IdleRPG**\n1 pilot present now · 1 player'), stats.replies[0].content);
      for (const call of [top, stats]) assert.deepStrictEqual(call.replies[0].allowedMentions, { parse: [] });
    } finally {
      await presence.stop();
    }
  });

  describe('/market', function () {
    let market;
    let commands;

    beforeEach(async function () {
      market = await new Market({
        path: path.join(dir, 'market'),
        members,
        sync: false,
        rateUrl: null,
        tickMs: 0,
        resolveToken: () => null,
        now: () => clock
      }).start();
      market.rate = { usdPerBtc: 80000, at: new Date(START).toISOString(), stale: false };
      commands = new Commands({ leagues, members, market: () => market, register: false });
    });

    afterEach(async function () {
      await market.stop();
    });

    it('is registered only while the Market runs, installable on a member’s own account', function () {
      assert.ok(!new Commands({ register: false }).definitions.some((definition) => definition.name === 'market'));
      const definition = commands.definitions.find((entry) => entry.name === 'market');
      assert.deepStrictEqual(definition.integration_types, [0, 1], 'server install and user install');
      assert.deepStrictEqual(definition.contexts, [0, 1, 2], 'servers, the bot’s DMs, and group DMs');
      assert.deepStrictEqual(definition.options.map((option) => option.name), ['search', 'sell', 'mine', 'edit', 'buy']);
      for (const option of definition.options) assert.ok(option.description.length <= 100);
    });

    it('lists, finds, and edits from a DM, linking the caller', async function () {
      const sell = interaction({
        name: 'market',
        subcommand: 'sell',
        user: KERSA,
        guildId: null,
        strings: { item: 'Carrack Expedition', price: '0.0125 BTC', kind: 'Ship', insurance: 'LTI' },
        integers: { qty: 1 },
        attachments: { image: { url: 'https://cdn.discordapp.com/ephemeral-attachments/1/2/carrack.png', contentType: 'image/png' } }
      });
      sell.member = null;
      await commands.handle(sell);
      assert.ok(sell.deferred, 'deferred: the forum post can take a moment');
      const reply = sell.replies[0];
      assert.ok(reply.content.startsWith('Listed **Carrack Expedition** for 0.0125 BTC'), reply.content);
      assert.ok(reply.content.includes('link your escrow key (Passport) at <https://goon.vc/services/market/mine>'), reply.content);
      assert.deepStrictEqual(reply.allowedMentions, { parse: [] });
      const [listing] = market.search({});
      assert.strictEqual(listing.seller.name, 'Kersa');
      assert.strictEqual(listing.insurance, 'LTI');
      assert.strictEqual(listing.priceSats, 1250000);
      const kersa = await members.getMember(`discord:${KERSA.id}`);
      assert.ok(kersa, 'running /market creates the caller’s profile');

      const search = interaction({ name: 'market', subcommand: 'search', user: RATGROT, guildId: null, strings: { query: 'carrack' } });
      await commands.handle(search);
      assert.ok(search.replies[0].content.includes(`**[Carrack Expedition](<https://goon.vc/services/market/listings/${listing.id}>)** — 0.0125 BTC`), search.replies[0].content);
      assert.ok(!search.replies[0].content.includes(KERSA.id), 'no Discord ids');

      const theirs = interaction({ name: 'market', subcommand: 'edit', user: RATGROT, guildId: null, focused: '' });
      await commands.handle(theirs);
      assert.deepStrictEqual(theirs.replies[0], [], 'edit offers only your own listings');
      const own = interaction({ name: 'market', subcommand: 'edit', user: KERSA, guildId: null, focused: 'carr' });
      await commands.handle(own);
      assert.deepStrictEqual(own.replies[0], [{ name: 'Carrack Expedition — 0.0125 BTC (Available)', value: listing.id }]);

      const refused = interaction({ name: 'market', subcommand: 'edit', user: RATGROT, guildId: null, strings: { listing: listing.id, price: '1 BTC' } });
      await commands.handle(refused);
      assert.strictEqual(refused.replies[0].content, 'Only the seller can change this listing.');
      const edit = interaction({ name: 'market', subcommand: 'edit', user: KERSA, strings: { listing: listing.id, price: '1m sats', status: 'reserved' } });
      await commands.handle(edit);
      assert.ok(edit.replies[0].content.startsWith('Updated **[Carrack Expedition]'), edit.replies[0].content);
      assert.strictEqual(market.listings.get(listing.id).priceSats, 1000000);
      assert.strictEqual(market.listings.get(listing.id).status, 'reserved');

      const mine = interaction({ name: 'market', subcommand: 'mine', user: KERSA, guildId: null });
      await commands.handle(mine);
      assert.ok(mine.replies[0].content.includes(`\`${listing.id}\``), mine.replies[0].content);
      assert.ok(mine.replies[0].content.endsWith('[Manage on goon.vc](<https://goon.vc/services/market/mine>)'));
    });

    it('answers Buy with escrow on a forum post with where to open the order', async function () {
      const kersa = await members.linkDiscord(KERSA, 'Kersa');
      const listing = await market.create({ title: 'Idris-P', price: '0.02 BTC' }, kersa);
      const button = `market:buy:${listing.id}`;

      const discordOnly = interaction({ user: RATGROT, customId: button });
      await commands.handle(discordOnly);
      assert.strictEqual(discordOnly.replies[0].flags, undefined, 'deferred privately, then edited');
      assert.deepStrictEqual(discordOnly.deferredWith, { flags: 64 });
      assert.ok(discordOnly.replies[0].content.includes('Escrow needs your escrow key'), discordOnly.replies[0].content);

      const rat = await members.getMember(`discord:${RATGROT.id}`);
      const identity = `fabric:${new Key().pubkey.slice(2)}`;
      await members.link(rat.id, identity, { via: 'passport' });
      const identityOnly = interaction({ user: RATGROT, customId: button, guildId: null });
      await commands.handle(identityOnly);
      assert.ok(identityOnly.replies[0].content.includes('Escrow needs your escrow key'), 'an identity key is not an escrow key');
      await members.setEscrowKey(rat.id, identity, { pubkey: new Key().pubkey, network: 'regtest' });
      const ready = interaction({ user: RATGROT, customId: button, guildId: null });
      await commands.handle(ready);
      assert.ok(ready.replies[0].content.includes(`Open the escrow order at <https://goon.vc/services/market/listings/${listing.id}#buy>`), ready.replies[0].content);

      const own = interaction({ user: KERSA, customId: button });
      await commands.handle(own);
      assert.ok(own.replies[0].content.endsWith('is your own listing.'), own.replies[0].content);

      const complete = interaction({ name: 'market', subcommand: 'buy', user: RATGROT, focused: 'idr' });
      await commands.handle(complete);
      assert.deepStrictEqual(complete.replies[0], [{ name: 'Idris-P — 0.02 BTC', value: listing.id }]);

      const missing = interaction({ name: 'market', subcommand: 'buy', user: RATGROT, strings: { listing: 'nope' } });
      await commands.handle(missing);
      assert.strictEqual(missing.replies[0].content, 'That listing isn’t on the Market. Pick one from the list.');

      const off = new Commands({ members, market: () => null, register: false });
      const stopped = interaction({ user: RATGROT, customId: button });
      await off.handle(stopped);
      assert.strictEqual(stopped.replies[0].content, 'The Market is not running right now.');
    });
  });

  describe('/rsi and /hangar', function () {
    const HANGAR_FILE = 'https://cdn.discordapp.com/attachments/1/2/hangar.json';
    let hangar;
    let files;

    const exportFor = (handle) => ({
      type: 'hangarlink',
      version: 1,
      pledges: [{ name: 'Gladius', cost: '$90.00 USD', pledgeType: 'ship', hangar: handle, insuranceType: 'ins6', items: [{ kind: 'Ship', title: 'Gladius', liner: 'Aegis Dynamics (AEGS)' }] }]
    });
    const fetchFile = async (url) => {
      const body = files.get(url);
      return body === undefined ? { ok: false, status: 404, text: async () => '' } : { ok: true, status: 200, text: async () => body };
    };
    const attachment = (overrides = {}) => Object.assign({ url: HANGAR_FILE, name: 'hangar.json', contentType: 'application/json; charset=utf-8', size: 512 }, overrides);
    const claimButton = (reply) => reply.components && reply.components[0].components[0];

    beforeEach(async function () {
      files = new Map();
      hangar = await new (require('../services/hangar'))({ path: path.join(dir, 'hangar'), members }).start();
    });

    afterEach(async function () {
      await hangar.stop();
    });

    it('registers /rsi with members, and /hangar guide only while scripts run', function () {
      const names = (settings) => new Commands(Object.assign({ register: false }, settings)).definitions.map((definition) => definition.name);
      assert.ok(!names({}).includes('rsi'));
      assert.ok(names({ members }).includes('rsi'));
      assert.ok(!names({ members }).includes('hangar'), '/hangar needs the hangar service');
      const subcommands = (settings) => new Commands(Object.assign({ register: false, members, hangar }, settings)).definitions
        .find((definition) => definition.name === 'hangar').options.map((option) => option.name);
      assert.deepStrictEqual(subcommands({}), ['import', 'status']);
      assert.deepStrictEqual(subcommands({ community: new FakeCommunity() }), ['guide', 'import', 'status']);
      const definition = Commands.DEFINITIONS.find((entry) => entry.name === 'hangar');
      const file = definition.options.find((option) => option.name === 'import').options.find((option) => option.name === 'file');
      assert.deepStrictEqual([file.type, file.required], [11, true], 'an attachment');
    });

    it('/rsi claim answers privately with a one-time sign-in link', async function () {
      const commands = new Commands({ members, siteUrl: 'https://goon.vc', register: false });
      const call = interaction({ name: 'rsi', subcommand: 'claim', user: KERSA, guildId: null });
      await commands.handle(call);
      assert.deepStrictEqual(call.deferredWith, { flags: 64 });
      const reply = call.replies[0];
      assert.ok(reply.content.startsWith('Open this link to claim your RSI handle on goon.vc'), reply.content);
      assert.match(reply.content, /works once, and expires in 30 minutes/);
      const button = claimButton(reply);
      assert.deepStrictEqual([button.type, button.style, button.label], [2, 5, 'Claim on goon.vc']);
      assert.match(button.url, /\/rsi\/claim\?t=[0-9a-f]{64}$/);
      const member = await members.getMember(`discord:${KERSA.id}`);
      assert.ok(member, 'running it links the caller’s Discord');

      await members.link(member.id, 'rsi:Kersa', { via: 'bio' });
      const again = interaction({ name: 'rsi', subcommand: 'claim', user: KERSA });
      await commands.handle(again);
      assert.ok(again.replies[0].content.startsWith('You’ve claimed **Kersa** on goon.vc.'), again.replies[0].content);
      assert.notStrictEqual(claimButton(again.replies[0]).url, button.url, 'a fresh link each time');
    });

    it('/hangar guide starts the walkthrough in DMs, with a claim link while no handle is claimed', async function () {
      const community = new FakeCommunity();
      const commands = new Commands({ members, community, hangar, register: false });
      const call = interaction({ name: 'hangar', subcommand: 'guide', user: KERSA, member: { displayName: 'Kersa' } });
      await commands.handle(call);
      assert.deepStrictEqual(community.begun, [{ id: 'hangar-import', options: { user: `discord/users/${KERSA.id}`, name: 'Kersa', context: { rsiHandle: null } } }]);
      assert.ok(call.replies[0].content.startsWith('Check your DMs'), call.replies[0].content);
      assert.ok(claimButton(call.replies[0]), 'with a claim link');

      const member = await members.getMember(`discord:${KERSA.id}`);
      await members.link(member.id, 'rsi:Kersa', { via: 'bio' });
      const claimed = interaction({ name: 'hangar', subcommand: 'guide', user: KERSA });
      await commands.handle(claimed);
      assert.deepStrictEqual(community.begun[1].options.context, { rsiHandle: 'Kersa' });
      assert.ok(!claimed.replies[0].components, 'no link once claimed');

      const closed = interaction({ name: 'hangar', subcommand: 'guide', user: KERSA });
      await new Commands({ members, hangar, community: new FakeCommunity(Object.assign(new Error('Cannot send messages to this user'), { code: 50007 })), register: false }).handle(closed);
      assert.ok(closed.replies[0].content.startsWith('I couldn’t send you a DM.'), closed.replies[0].content);
    });

    it('/hangar import syncs a claimed handle’s export and refuses everything else', async function () {
      const commands = new Commands({ members, hangar, siteUrl: 'https://goon.vc', fetch: fetchFile, register: false });
      const run = async (file) => {
        const call = interaction({ name: 'hangar', subcommand: 'import', user: KERSA, attachments: file ? { file } : {} });
        await commands.handle(call);
        return call.replies[0];
      };
      assert.strictEqual((await run(null)).content, 'Attach the .json file Hangar Export saved.');
      assert.match((await run(attachment({ name: 'hangar.csv', contentType: 'text/csv' }))).content, /not the CSV/);
      assert.match((await run(attachment({ size: 6 * 1024 * 1024 }))).content, /over 5 MB/);
      assert.match((await run(attachment())).content, /couldn’t download that file/);
      files.set(HANGAR_FILE, '{ not json');
      assert.match((await run(attachment())).content, /couldn’t read that file as JSON/);
      files.set(HANGAR_FILE, JSON.stringify({ pledges: [] }));
      assert.match((await run(attachment())).content, /isn’t a Hangar Export/);
      files.set(HANGAR_FILE, JSON.stringify(exportFor(undefined)));
      const nobody = await run(attachment());
      assert.ok(nobody.content.startsWith('Claim your RSI handle on goon.vc first, then run `/hangar import` again.'), nobody.content);
      assert.ok(claimButton(nobody), 'with a claim link');

      files.set(HANGAR_FILE, JSON.stringify(exportFor('Kersa')));
      const unclaimed = await run(attachment());
      assert.ok(unclaimed.content.startsWith('That export is for **Kersa**, which you haven’t claimed on goon.vc.'), unclaimed.content);
      assert.ok(claimButton(unclaimed), 'with a claim link');
      assert.strictEqual((await hangar.report()).ships, 0);

      const member = await members.getMember(`discord:${KERSA.id}`);
      await members.link(member.id, 'rsi:Kersa', { via: 'bio' });
      const synced = await run(attachment());
      assert.strictEqual(synced.content.split('\n')[0], 'Synced 1 ship (1 model) for **Kersa**.');
      assert.ok(synced.content.includes('<https://goon.vc/rsi>'), synced.content);
      assert.deepStrictEqual((await hangar.report()).models, [{ model: 'Gladius', manufacturer: 'Aegis Dynamics', count: 1, owners: 1 }]);

      files.set(HANGAR_FILE, JSON.stringify(exportFor('SomeoneElse')));
      assert.ok((await run(attachment())).content.startsWith('That export is for **SomeoneElse**'), 'another member’s hangar is refused');
      assert.strictEqual((await hangar.report()).ships, 1);
    });

    it('/hangar status reports the last import', async function () {
      const commands = new Commands({ members, hangar, fetch: fetchFile, register: false });
      const status = async () => {
        const call = interaction({ name: 'hangar', subcommand: 'status', user: KERSA });
        await commands.handle(call);
        return call.replies[0].content;
      };
      assert.match(await status(), /^Nothing synced yet\. Claim your RSI handle with `\/rsi claim`/);
      const member = await members.getMember(`discord:${KERSA.id}`);
      await members.link(member.id, 'rsi:Kersa', { via: 'bio' });
      assert.match(await status(), /^Nothing synced yet\. Run `\/hangar guide`/);
      await hangar.importExport(member.id, exportFor('Kersa'));
      assert.match(await status(), /^\*\*Kersa\*\*: 1 ship \(1 model\), synced <t:\d+:R>\.\nRun `\/hangar import`/);
      await members.unlink(member.id, 'rsi:Kersa');
      assert.match(await status(), /aren’t in the fleet totals/);

      const off = interaction({ name: 'hangar', subcommand: 'status', user: KERSA });
      await new Commands({ members, register: false }).handle(off);
      assert.strictEqual(off.replies[0].content, 'Hangar sync is not running right now.');
    });
  });
});
