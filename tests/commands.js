'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
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

function interaction ({ name, subcommand, users = {}, members = {}, strings = {}, user = REF, member = null, guildId = GUILD, focused = null, customId = null }) {
  const replies = [];
  const updates = [];
  return {
    commandName: name,
    customId,
    guildId,
    user,
    member: member || { displayName: user.globalName },
    replies,
    updates,
    isAutocomplete: () => focused !== null,
    isButton: () => customId !== null,
    isChatInputCommand: () => focused === null && customId === null,
    options: {
      getSubcommand: () => subcommand,
      getUser: (key) => users[key] || null,
      getMember: (key) => members[key] || null,
      getString: (key) => (strings[key] === undefined ? null : strings[key]),
      getFocused: () => focused
    },
    reply: async (payload) => { replies.push(payload); },
    update: async (payload) => { updates.push(payload); },
    respond: async (choices) => { replies.push(choices); }
  };
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
    leagues = await new Leagues({ path: path.join(dir, 'leagues'), now: () => clock }).start();
    members = await new Members({ path: path.join(dir, 'members') }).start();
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
    assert.deepStrictEqual(discord.created.map((command) => command.name), ['1v1']);
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
    assert.deepStrictEqual([caller.displayName, caller.discord.username, caller.lastLoginAt], ['Kersa | PF', 'kersa', undefined]);
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
    assert.ok((await press(commands, KERSA, 'confirm', third.id)).content.startsWith('**Rat** beat **Kersa \\| PF**'));

    const league = await leagues.getLeague(Leagues.OPEN_LEAGUE_ID);
    assert.deepStrictEqual(league.players, ['Rat', 'Kersa | PF', 'Rat (rat2)']);
    assert.ok(league.log.some((entry) => entry.type === 'link' && entry.name === 'Rat'), 'the typed name was claimed, not duplicated');
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

  it('/idlerpg creates a goon.vc profile for whoever checks', async function () {
    const commands = new Commands({ members, register: false });
    const call = interaction({ name: 'idlerpg', subcommand: 'stats', user: KERSA, member: { displayName: 'Kersa | PF' } });
    await commands.handle(call);
    assert.strictEqual(call.replies[0].content, 'IdleRPG is not running right now.');
    const member = await members.getMember(`discord:${KERSA.id}`);
    assert.deepStrictEqual([member.provider, member.displayName, member.discord.username, member.lastLoginAt], ['discord', 'Kersa | PF', 'kersa', undefined]);
    await members.store.set(`/members/discord:${KERSA.id}`, Object.assign({}, member, { displayName: 'Kersa' }));
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
