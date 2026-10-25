'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const Key = require('@fabric/core/types/key');
const Alliance = require('../services/alliance');
const Commands = require('../services/commands');
const Leagues = require('../services/leagues');
const Members = require('../services/members');
const Presence = require('../services/presence');
const elo = require('../functions/elo');

const GUILD = '1190527980120850493';
const VOICE = '1236721094153732276';
const KERSA = { id: '111111111111111111', username: 'kersa', globalName: 'Kersa' };
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

function interaction ({ name, subcommand, users = {}, members = {}, strings = {}, roles = {}, integers = {}, user = REF, member = null, guildId = GUILD, focused = null, customId = null, permissions = 0n }) {
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
    assert.deepStrictEqual(discord.created.map((command) => command.name), ['1v1', 'vote']);
    assert.strictEqual(discord.client.listenerCount('interactionCreate'), 1);
    for (const definition of Commands.DEFINITIONS) {
      assert.deepStrictEqual(definition.contexts, [0], `/${definition.name} is for servers only`);
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
    assert.deepStrictEqual(fresh.created.map((command) => command.name), ['1v1', 'goon', 'vote']);
    const goon = fresh.created.find((command) => command.name === 'goon');
    assert.strictEqual(goon.default_member_permissions, '32', '/goon is for members who can manage the server');
    assert.deepStrictEqual(goon.options.map((option) => option.name), ['setup', 'council', 'embassy', 'permafleet', 'voice']);
    await withSetup.stop();
  });

  it('/goon council, embassy, permafleet, and voice start their channel scripts in the caller’s DMs', async function () {
    const community = new FakeCommunity();
    const commands = new Commands({ members, community, register: false });
    const council = interaction({ name: 'goon', subcommand: 'council', user: KERSA, member: { displayName: 'Kersa' }, permissions: 32n });
    await commands.handle(council);
    assert.strictEqual(council.replies[0].content, 'Check your DMs: I’ve sent the first step of setting up #council on **G00N SQUAD**.');
    for (const subcommand of ['embassy', 'permafleet', 'voice']) {
      await commands.handle(interaction({ name: 'goon', subcommand, user: KERSA, permissions: 32n }));
    }
    assert.deepStrictEqual(community.begun.map((entry) => entry.id), ['permafleet-council', 'permafleet-embassy', 'permafleet-channel', 'permafleet-voice']);
    assert.deepStrictEqual(community.begun[0].options.context, { guildId: GUILD, guildName: 'G00N SQUAD' });
    assert.strictEqual(community.begun[0].options.subject, GUILD);

    const refused = interaction({ name: 'goon', subcommand: 'voice', user: KERSA, permissions: 0n });
    await commands.handle(refused);
    assert.strictEqual(refused.replies[0].content, 'You need the Manage Server permission to set up goon.vc here.');
    const closed = interaction({ name: 'goon', subcommand: 'embassy', user: KERSA, permissions: 32n });
    await new Commands({ members, community: new FakeCommunity(Object.assign(new Error('Cannot send messages to this user'), { code: 50007 })), register: false }).handle(closed);
    assert.ok(closed.replies[0].content.endsWith('then run `/goon embassy` again.'), closed.replies[0].content);
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

  describe('/goon campaign', function () {
    const OTHER_GUILD = '1236721094153700000';
    let campaigns;
    let community;

    before(function () {
      if (!HAS_CAMPAIGNS) this.skip();
    });

    beforeEach(async function () {
      const Campaigns = require(path.join(DOORMAN, 'services/campaigns'));
      campaigns = await new Campaigns({ path: path.join(dir, 'campaigns'), intervalMs: 0, maxAudience: 3, now: () => clock }).start();
      const people = [
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
      assert.deepStrictEqual(goon(Object.assign(new FakeCommunity(), { campaigns })).options.map((option) => option.name), ['setup', 'council', 'embassy', 'permafleet', 'voice', 'campaign']);
      assert.strictEqual(goon(null), undefined);
      const campaign = goon(community).options[0];
      assert.ok(campaign.description.length <= 100);
      assert.ok(campaign.options.every((option) => option.description.length <= 100));
      assert.deepStrictEqual(campaign.options.map((option) => option.name), ['message', 'role', 'exclude_role', 'active_days', 'script', 'send_at']);
    });

    it('previews privately, then sends only when its author presses Send', async function () {
      const commands = new Commands({ members, community, register: false, now: () => clock });
      const call = await run(commands, { strings: { message: 'Fleet night Saturday!' }, roles: { role: PILOTS, exclude_role: MUTED } });
      assert.deepStrictEqual(call.deferredWith, { flags: 64 });
      const preview = call.replies[0];
      assert.strictEqual(preview.content, [
        '**Campaign preview** — G00N SQUAD',
        '> Fleet night Saturday!',
        `Reaches **2** members of <@&${PILOTS.id}>; skipping <@&${MUTED.id}>.`,
        'Goes out one DM every few seconds once you press Send. Every DM says it came from this server and has Stop buttons.'
      ].join('\n\n'));
      assert.deepStrictEqual(preview.allowedMentions, { parse: [] }, 'role mentions in the preview ping no one');
      const [send, cancel] = buttons(preview);
      assert.deepStrictEqual([send.label, cancel.label], ['Send', 'Cancel']);
      const id = send.custom_id.split(':')[2];
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

      const sent = await press(commands, send.custom_id);
      assert.strictEqual(sent.deferredUpdate, true);
      assert.deepStrictEqual(sent.replies[0], { allowedMentions: { parse: [] }, content: 'Sending to **2** members now, one every few seconds.', components: [] });
      assert.strictEqual(campaigns.campaign(id).status, 'sending');
      const again = await press(commands, cancel.custom_id);
      assert.strictEqual(again.replies[0].content, 'This campaign is already sending.');

      const next = await run(commands, { strings: { message: 'Again' } });
      assert.ok(/^This server sent a campaign recently; the next one can go out <t:\d+:R>\.$/.test(next.replies[0].content), next.replies[0].content);
      assert.strictEqual(campaigns.list().length, 1, 'no draft is saved while the server is cooling down');
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
      const id = schedule.custom_id.split(':')[2];
      assert.deepStrictEqual(campaigns.campaign(id).content, { type: 'script', script: 'welcome', text: 'Welcome!' });

      const elsewhere = await press(commands, schedule.custom_id, KERSA, GUILD);
      assert.strictEqual(elsewhere.followUps[0].content, 'This campaign is no longer here.', 'a campaign belongs to its server');
      const done = await press(commands, schedule.custom_id, KERSA, OTHER_GUILD);
      assert.strictEqual(done.replies[0].content, `Scheduled: **2** DMs go out <t:${at}:f> (<t:${at}:R>).`);
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
        organizations: [{ symbol: 'G00N', stewards: [`discord:${KERSA.id}`] }, { symbol: 'INFN', stewards: [] }, { symbol: 'TRDE', stewards: [] }]
      }));
      alliance = await new Alliance({ path: path.join(dir, 'alliance'), file, xprv: new Key().xprv, members, now: () => clock }).start();
      const kersa = await members.linkDiscord(KERSA, 'Kersa');
      proposal = await alliance.propose({ title: 'Adopt the charter' }, { member: kersa, by: 'Kersa', orgs: ['G00N'], officers: [] });
      await alliance.propose({ title: 'Closed already', days: 1 }, { member: kersa, by: 'Kersa', orgs: ['G00N'], officers: [] });
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
      await commands.handle(interaction({ name: 'vote', user: KERSA, strings: { proposal: proposal.shortId, choice: 'yes' } }));
      const view = await alliance.getProposal(proposal.id);
      assert.deepStrictEqual(view.members, { yes: 1, no: 1, abstain: 0, total: 2 });
      assert.strictEqual(view.tally.yes, 0, 'member votes do not count as org votes');
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
});
