'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Leagues = require('../services/leagues');
const elo = require('../functions/elo');
const createDiscordDirectory = require('../functions/discordDirectory');

function route (service, method, url) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      statusCode: 200,
      setHeader () {},
      end (body) { resolve({ status: this.statusCode, body: JSON.parse(body) }); }
    };
    service.middleware()({ method, url, path: url.split('?')[0], body: {} }, res, () => resolve({ status: 'next' }));
  });
}

describe('elo', function () {
  it('moves rating from the loser to the winner, more for an upset', function () {
    const even = elo.exchange(1000, 1000, 1, 32);
    assert.strictEqual(even, 16);
    assert.ok(elo.exchange(900, 1100, 1, 32) > even, 'an upset pays more');
    assert.ok(elo.exchange(1100, 900, 1, 32) < even, 'an expected win pays less');
    assert.ok(elo.exchange(1600, 800, 1, 32) > 0, 'a winner always gains');
  });

  it('weighs a duel by √(best of)', function () {
    assert.ok(Math.abs(elo.exchange(1000, 1000, 3, 32) - 16 * Math.sqrt(3)) < 1e-9);
    assert.ok(Math.abs(elo.exchange(1000, 1000, 5, 32) - 16 * Math.sqrt(5)) < 1e-9);
  });

  it('replays duels into ranked standings, skipping voided ones', function () {
    const { standings, waiting, changes } = elo.rate([
      { id: 'd1', winner: 'Ace', loser: 'Bolt', bestOf: 1, score: [1, 0] },
      { id: 'd2', winner: 'Ace', loser: 'Cid', bestOf: 3, score: [2, 1] },
      { id: 'd3', winner: 'Cid', loser: 'Ace', bestOf: 1, score: [1, 0], voided: { at: 'x' } }
    ], { k: 32, initialRating: 1000, roster: ['Ace', 'Bolt', 'Cid', 'Dee'] });
    const second = elo.exchange(1016, 1000, 3, 32);
    assert.deepStrictEqual(standings.map((p) => [p.name, p.rating, p.rank]), [
      ['Ace', Math.round(1016 + second), 1],
      ['Bolt', 984, 2],
      ['Cid', Math.round(1000 - second), 3]
    ]);
    assert.deepStrictEqual([standings[0].wins, standings[0].losses, standings[0].gamesWon, standings[0].gamesLost, standings[0].streak], [2, 0, 3, 1, 2]);
    assert.deepStrictEqual(waiting, ['Dee']);
    assert.deepStrictEqual(changes.d1, { winner: [1000, 1016], loser: [1000, 984], points: 16 });
    assert.ok(!changes.d3, 'a voided duel has no rating change');
  });

  it('gives equal ratings the same rank', function () {
    const { standings } = elo.rate([
      { id: 'd1', winner: 'Ace', loser: 'Bolt', bestOf: 1 },
      { id: 'd2', winner: 'Cid', loser: 'Dee', bestOf: 1 }
    ]);
    assert.deepStrictEqual(standings.map((p) => p.rank), [1, 1, 3, 3]);
  });
});

describe('Discord directory', function () {
  const member = (id, username, extra) => Object.assign({ user: Object.assign({ id, username, global_name: null }, extra && extra.user) }, extra && extra.member);

  it('finds server members by handle or nickname without exposing ids', async function () {
    const asked = [];
    const directory = createDiscordDirectory({
      discord: { guildId: '42' },
      resolveToken: () => ({ token: 'test' }),
      fetch: async (url) => {
        asked.push(url);
        const body = [
          member('111', 'kersa', { member: { nick: 'Kersa | PF' } }),
          member('112', 'kersabot', { user: { bot: true } }),
          member('113', 'kersa2', { user: { global_name: 'Kersa Two' } })
        ];
        return { status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
      }
    });
    assert.deepStrictEqual(await directory.search('@Ker'), [
      { handle: 'kersa', name: 'Kersa | PF' },
      { handle: 'kersa2', name: 'Kersa Two' }
    ]);
    assert.ok(asked[0].includes('/guilds/42/members/search?query=Ker&limit=25'));
    await directory.search('ker');
    assert.strictEqual(asked.length, 1, 'repeat lookups are cached');
    assert.deepStrictEqual(await directory.resolve('@KERSA'), { id: '111', handle: 'kersa', name: 'Kersa | PF' });
    assert.strictEqual(await directory.resolve('@kersabot'), null, 'bots are left out');
    assert.strictEqual(await directory.resolve('@k'), null);
    assert.deepStrictEqual(await directory.search('k'), []);
    assert.strictEqual(createDiscordDirectory.normalizeHandle(' @Some.User_1 '), 'some.user_1');
  });

  it('also finds members the gateway has seen by display name', async function () {
    const cached = [
      { nickname: null, user: { id: '221', username: 'rk_77', globalName: 'Rat King' } },
      { nickname: 'Kersa | PF', user: { id: '111', username: 'kersa', globalName: 'Kersa' } },
      { nickname: null, user: { id: '999', username: 'kingbot', globalName: 'King Bot', bot: true } }
    ];
    const client = { guilds: { cache: new Map([['42', { members: { cache: new Map(cached.map((m) => [m.user.id, m])) } }]]) } };
    let asked = 0;
    const directory = createDiscordDirectory({
      discord: { guildId: '42' },
      gateway: () => client,
      resolveToken: () => ({ token: 'test' }),
      fetch: async (url) => {
        asked++;
        const query = new URL(url).searchParams.get('query').toLowerCase();
        const body = [member('333', 'kingfisher')].filter((m) => m.user.username.startsWith(query));
        return { status: 200, text: async () => JSON.stringify(body), headers: { get: () => null } };
      }
    });
    assert.deepStrictEqual(await directory.search('king'), [
      { handle: 'kingfisher', name: 'kingfisher' },
      { handle: 'rk_77', name: 'Rat King' }
    ], 'names that start with the text come first; bots never show');
    assert.deepStrictEqual(await directory.search('@rat k'), [{ handle: 'rk_77', name: 'Rat King' }]);
    assert.deepStrictEqual(await directory.resolve('@rk_77'), { id: '221', handle: 'rk_77', name: 'Rat King' });
    assert.strictEqual(asked, 2, 'a member the gateway knows resolves without asking Discord');

    const offline = createDiscordDirectory({ discord: { guildId: '42' }, gateway: () => client, resolveToken: () => ({ token: null }) });
    assert.deepStrictEqual(await offline.search('kersa'), [{ handle: 'kersa', name: 'Kersa | PF' }], 'seen members still show when Discord can’t be asked');
    await assert.rejects(offline.search('nobody'), (error) => error.status === 503);
  });

  it('fails as unavailable without a token or when Discord refuses', async function () {
    const none = createDiscordDirectory({ resolveToken: () => ({ token: null }) });
    await assert.rejects(none.search('kersa'), (error) => error.status === 503);
    const limited = createDiscordDirectory({
      resolveToken: () => ({ token: 'test' }),
      fetch: async () => ({ status: 429, text: async () => '{"retry_after":5}', headers: { get: () => null } })
    });
    await assert.rejects(limited.resolve('kersa'), (error) => error.status === 503);
  });
});

describe('leagues service', function () {
  let dir;
  let service;
  let clock;

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-leagues-'));
    clock = Date.parse('2026-10-16T20:00:00Z');
    service = new Leagues({ path: dir, defaults: [], now: () => (clock += 1000) });
    await service.start();
  });

  afterEach(async function () {
    if (service) await service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts with one open perpetual league, created once', async function () {
    await service.stop();
    service = new Leagues({ path: dir });
    await service.start();
    const [open] = await service.listLeagues();
    assert.strictEqual(open.id, 'open-league');
    assert.strictEqual(open.kind, 'perpetual');
    const league = await service.getLeague('open-league');
    assert.match(league.summary, /no ship class restrictions/);
    await service.logDuel('open-league', { winner: 'Ace', loser: 'Bolt', bestOf: 3, score: [2, 0] });
    await service.updateLeague('open-league', { name: 'G00N Open' });
    await service.stop();
    service = new Leagues({ path: dir });
    await service.start();
    const leagues = await service.listLeagues();
    assert.strictEqual(leagues.length, 1, 'a restart keeps the one league');
    assert.strictEqual(leagues[0].name, 'G00N Open');
    assert.strictEqual(leagues[0].duels, 1);
  });

  it('creates perpetual and seasonal leagues with unique ids', async function () {
    assert.deepStrictEqual(await service.listLeagues(), [], 'no defaults when none are configured');
    const ladder = await service.createLeague({ name: 'Gladius Ladder', kind: 'perpetual', players: ['Ace', 'ace', 'Bolt'] }, 'Neorion');
    assert.strictEqual(ladder.id, 'gladius-ladder');
    assert.deepStrictEqual(ladder.players, ['Ace', 'Bolt']);
    assert.strictEqual(ladder.k, 32);
    assert.strictEqual(ladder.initialRating, 1000);
    assert.strictEqual(ladder.seasons.length, 1);
    assert.strictEqual(ladder.createdBy, 'Neorion');
    const again = await service.createLeague({ name: 'Gladius Ladder', kind: 'seasonal', season: { name: 'Fall 2956', endsAt: '2026-12-31' } });
    assert.strictEqual(again.id, 'gladius-ladder-2');
    assert.strictEqual(again.seasons[0].name, 'Fall 2956');
    assert.strictEqual(again.seasons[0].endsAt, '2026-12-31T00:00:00.000Z');
    await assert.rejects(service.createLeague({ name: 'X', kind: 'perpetual' }), /needs a name/);
    await assert.rejects(service.createLeague({ name: 'Nope', kind: 'weekly' }), /perpetual or seasonal/);
    await assert.rejects(service.createLeague({ name: 'Nope', kind: 'perpetual', k: 1000 }), /K must be/);
    assert.strictEqual((await service.listLeagues()).length, 2);
  });

  it('logs duels, checks set scores, and updates ratings', async function () {
    await service.createLeague({ name: 'Arena', kind: 'perpetual', bestOf: 3 });
    await assert.rejects(service.logDuel('arena', { winner: 'Ace', loser: 'Bolt', bestOf: 3 }), /set score/);
    await assert.rejects(service.logDuel('arena', { winner: 'Ace', loser: 'Bolt', bestOf: 3, score: [2, 2] }), /ends 2–0 to 2–1/);
    await assert.rejects(service.logDuel('arena', { winner: 'Ace', loser: 'ace', bestOf: 1 }), /cannot duel themselves/);
    await assert.rejects(service.logDuel('nope', { winner: 'Ace', loser: 'Bolt' }), /No such league/);

    const first = await service.logDuel('arena', { winner: 'Ace', loser: 'Bolt', bestOf: 3, score: [2, 1], note: 'Arrows' }, 'Ref');
    assert.deepStrictEqual(first.players, ['Ace', 'Bolt'], 'new names join the league');
    const duel = first.duels[0];
    assert.strictEqual(duel.id, 'd1');
    assert.strictEqual(duel.by, 'Ref');
    assert.deepStrictEqual(duel.score, [2, 1]);
    const points = Math.round(16 * Math.sqrt(3));
    assert.deepStrictEqual(duel.change.winner, [1000, 1000 + points]);
    assert.deepStrictEqual(first.seasons[0].standings.map((p) => [p.name, p.rating]), [['Ace', 1000 + points], ['Bolt', 1000 - points]]);

    const second = await service.logDuel('arena', { winner: 'bolt', loser: 'ACE', bestOf: 1 });
    assert.deepStrictEqual([second.duels[1].winner, second.duels[1].loser], ['Bolt', 'Ace'], 'names match the roster');
    assert.deepStrictEqual(second.duels[1].score, [1, 0]);
    assert.strictEqual(second.leader.name, 'Ace');
    assert.deepStrictEqual(second.log.map((entry) => entry.type), ['create', 'join', 'join', 'duel', 'duel']);
  });

  it('voids and restores duels without deleting them', async function () {
    await service.createLeague({ name: 'Arena', kind: 'perpetual' });
    await service.logDuel('arena', { winner: 'Ace', loser: 'Bolt', bestOf: 1 });
    const voided = await service.voidDuel('arena', 'd1', { reason: 'Wrong winner' }, 'Ref');
    assert.strictEqual(voided.duels.length, 1, 'still on record');
    assert.strictEqual(voided.duels[0].voided.reason, 'Wrong winner');
    assert.strictEqual(voided.duels[0].change, null);
    assert.deepStrictEqual(voided.seasons[0].standings, []);
    assert.deepStrictEqual(voided.seasons[0].waiting, ['Ace', 'Bolt']);
    await assert.rejects(service.voidDuel('arena', 'd1'), /already void/);
    const restored = await service.restoreDuel('arena', 'd1');
    assert.strictEqual(restored.seasons[0].standings[0].name, 'Ace');
    await assert.rejects(service.voidDuel('arena', 'd9'), /No such duel/);
  });

  it('closes a season with frozen standings and starts everyone again', async function () {
    await service.createLeague({ name: 'Perma', kind: 'perpetual' });
    await assert.rejects(service.startSeason('perma', {}), /no seasons/);

    await service.createLeague({ name: 'Cup', kind: 'seasonal' });
    await service.logDuel('cup', { winner: 'Ace', loser: 'Bolt', bestOf: 1 });
    const next = await service.startSeason('cup', { name: 'Winter' }, 'Ref');
    assert.strictEqual(next.seasons.length, 2);
    const [one, two] = next.seasons;
    assert.strictEqual(one.status, 'complete');
    assert.strictEqual(one.champion, 'Ace');
    assert.deepStrictEqual(one.standings.map((p) => p.name), ['Ace', 'Bolt']);
    assert.strictEqual(two.name, 'Winter');
    assert.strictEqual(two.status, 'active');
    assert.deepStrictEqual(two.standings, [], 'ratings restart');
    assert.deepStrictEqual(two.waiting, ['Ace', 'Bolt']);
    await assert.rejects(service.voidDuel('cup', 'd1'), /Season 1 is over/);

    const logged = await service.logDuel('cup', { winner: 'Bolt', loser: 'Ace', bestOf: 1 });
    assert.strictEqual(logged.duels[1].season, 2);
    assert.strictEqual(logged.seasons[1].standings[0].name, 'Bolt');
    assert.strictEqual(logged.seasons[0].standings[0].name, 'Ace', 'past seasons stay as they ended');
  });

  it('edits league details and adds pilots, all logged', async function () {
    await service.createLeague({ name: 'Arena', kind: 'perpetual' });
    const edited = await service.updateLeague('arena', { tagline: 'Every Friday', bestOf: 5 }, 'Ref');
    assert.strictEqual(edited.tagline, 'Every Friday');
    assert.strictEqual(edited.bestOf, 5);
    await assert.rejects(service.updateLeague('arena', { tagline: 'Every Friday' }), /Nothing to change/);
    const added = await service.addPlayer('arena', 'Cid');
    assert.deepStrictEqual(added.players, ['Cid']);
    await assert.rejects(service.addPlayer('arena', 'cid'), /already in the league/);
    assert.deepStrictEqual(added.log.slice(1).map((entry) => entry.type), ['update', 'join']);
  });

  it('describes league pages for link previews', async function () {
    await service.createLeague({ name: 'Arena', kind: 'seasonal' });
    await service.logDuel('arena', { winner: 'Ace', loser: 'Bolt', bestOf: 1 });
    const page = await service.page('/leagues/Arena/');
    assert.strictEqual(page.title, 'Arena');
    assert.strictEqual(page.description, 'Season 1 of a seasonal league · 2 pilots · Elo-rated duels. Leader: Ace (1016).');
    assert.strictEqual(await service.page('/leagues/nope'), null);
    assert.strictEqual(await service.page('/leagues/arena/x'), null);
    assert.strictEqual(await service.page('/tournaments/arena'), null);
  });

  it('rates a tournament posted late in the order its sets were played', async function () {
    await service.createLeague({ name: 'Arena', kind: 'perpetual' });
    await service.logDuel('arena', { winner: 'Ace', loser: 'Bolt', bestOf: 1 });
    const league = await service.recordTournament('arena', {
      id: 'cup/2026-10-15',
      name: 'Cup',
      path: '/tournaments/cup/2026-10-15',
      complete: true,
      sets: [
        { match: 'W1-1', winner: 'Bolt', loser: 'Cid', bestOf: 1, score: [1, 0], playedAt: '2026-10-15T20:00:00.000Z' },
        { match: 'W2-1', winner: 'Bolt', loser: 'Ace', bestOf: 1, score: [1, 0], playedAt: '2026-10-15T21:00:00.000Z' }
      ]
    });
    assert.deepStrictEqual(league.duels.map((duel) => [duel.id, duel.playedAt]), [
      ['d2', '2026-10-15T20:00:00.000Z'],
      ['d3', '2026-10-15T21:00:00.000Z'],
      ['d1', league.duels[2].loggedAt]
    ], 'the tournament’s sets come before the duel logged after them');
    const ace = league.duels.find((duel) => duel.id === 'd1').change;
    assert.strictEqual(ace.winner[0], Math.round(1000 - elo.exchange(1016, 1000, 1, 32)), 'Ace had already lost the cup final when the later duel was rated');
    const replayed = elo.rate(league.duels, { k: league.k, initialRating: league.initialRating });
    assert.deepStrictEqual(league.seasons[0].standings.map((p) => [p.name, p.rating]), replayed.standings.map((p) => [p.name, p.rating]));
  });

  it('keeps a tournament’s duels in line with its results', async function () {
    await service.createLeague({ name: 'Arena', kind: 'perpetual' });
    const report = (final, extra) => Object.assign({
      id: 'cup/2026-10-15',
      name: 'Cup',
      path: '/tournaments/cup/2026-10-15',
      complete: true,
      sets: [
        { match: 'W1-1', winner: 'Bolt', loser: 'Cid', bestOf: 1, score: [1, 0], playedAt: '2026-10-15T20:00:00.000Z' },
        Object.assign({ match: 'W2-1', bestOf: 1, score: [1, 0], playedAt: '2026-10-15T21:00:00.000Z' }, final)
      ]
    }, extra);
    const live = (league) => league.duels.filter((duel) => !duel.voided).map((duel) => duel.id);

    let league = await service.recordTournament('arena', report({ winner: 'Bolt', loser: 'Ace' }));
    assert.deepStrictEqual(live(league), ['d1', 'd2']);
    const updatedAt = league.updatedAt;
    league = await service.recordTournament('arena', report({ winner: 'bolt', loser: 'ace' }));
    assert.strictEqual(league.updatedAt, updatedAt, 'the same results change nothing');

    league = await service.recordTournament('arena', report({ winner: 'Ace', loser: 'Bolt' }), 'ChairmanPoW');
    assert.deepStrictEqual(live(league), ['d1', 'd3'], 'an edited final voids the old duel and logs the new one');
    assert.strictEqual(league.duels.find((duel) => duel.id === 'd2').voided.tournament, true);
    let entry = league.log[league.log.length - 1];
    assert.deepStrictEqual([entry.type, entry.duels, entry.voided, entry.by], ['tournament', ['d3'], ['d2'], 'ChairmanPoW']);

    league = await service.recordTournament('arena', report(null, { complete: false, sets: [] }));
    assert.deepStrictEqual(live(league), [], 'a reopened tournament backs no duels');

    league = await service.recordTournament('arena', report({ winner: 'Bolt', loser: 'Ace' }));
    assert.deepStrictEqual(live(league), ['d1', 'd2'], 'its duels come back with its results');
    entry = league.log[league.log.length - 1];
    assert.deepStrictEqual([entry.duels, entry.restored], [[], ['d1', 'd2']]);
    assert.strictEqual(league.duels.length, 3, 'nothing is duplicated');

    await service.voidDuel('arena', 'd1', { reason: 'Wrong ship' });
    league = await service.recordTournament('arena', report({ winner: 'Bolt', loser: 'Ace' }));
    assert.deepStrictEqual(live(league), ['d2'], 'a duel voided by hand stays void');
    assert.strictEqual(league.duels.length, 3);

    league = await service.recordTournament('arena', report({ winner: 'Bolt', loser: 'Ace', playedAt: '2026-10-15T22:00:00.000Z' }));
    assert.strictEqual(league.duels.find((duel) => duel.id === 'd2').playedAt, '2026-10-15T22:00:00.000Z', 'a set’s date follows the tournament');
    assert.strictEqual(league.log[league.log.length - 1].type, 'void', 'redating is not a new log entry');
  });

  it('logs duels by Discord handle, placing players by their account', async function () {
    const server = [
      { id: '111', handle: 'kersa', name: 'Kersa | PF' },
      { id: '222', handle: 'ratgrot', name: 'Ace' },
      { id: '333', handle: 'newbie', name: 'Newbie' }
    ];
    const directory = {
      search: async (text) => server.filter((m) => m.handle.startsWith(text.replace(/^@/, ''))).map(({ handle, name }) => ({ handle, name })),
      resolve: async (value) => server.find((m) => m.handle === value.replace(/^@/, '').toLowerCase()) || null
    };
    await service.stop();
    service = new Leagues({ path: dir, defaults: [], directory, now: () => (clock += 1000) });
    await service.start();
    await service.createLeague({ name: 'Arena', kind: 'perpetual', players: ['Ace', 'Bolt'] });

    let league = await service.logDuel('arena', { winner: '@Kersa', loser: '@ratgrot', bestOf: 1 }, 'Ref');
    assert.deepStrictEqual(league.players, ['Ace', 'Bolt', 'Kersa | PF'], 'a handle claims the unlinked roster name it goes by, or joins');
    assert.deepStrictEqual([league.duels[0].winner, league.duels[0].loser], ['Kersa | PF', 'Ace']);
    assert.ok(league.log.some((entry) => entry.type === 'link' && entry.name === 'Ace'));
    assert.ok(!JSON.stringify(league).includes('discord:'), 'account links stay private');

    server[0].name = 'Kersa';
    league = await service.logDuel('arena', { winner: '@kersa', loser: 'Bolt', bestOf: 1 });
    assert.strictEqual(league.duels[1].winner, 'Kersa | PF', 'a renamed member keeps their place');
    await assert.rejects(service.logDuel('arena', { winner: '@kersa', loser: 'Kersa | PF', bestOf: 1 }), /cannot duel themselves/);
    await assert.rejects(service.logDuel('arena', { winner: '@newbie', loser: 'Bolt', bestOf: 3, score: [2, 2] }), /ends 2–0/);
    assert.deepStrictEqual((await service.getLeague('arena')).players, ['Ace', 'Bolt', 'Kersa | PF'], 'a refused duel joins nobody');

    league = await service.logDuel('arena', { winner: '@nobody', loser: '@Some Pilot', bestOf: 1 });
    assert.deepStrictEqual([league.duels[2].winner, league.duels[2].loser], ['nobody', 'Some Pilot'], 'anything else is taken as a name');
    server.push({ id: '444', handle: 'nobody', name: 'Nobody Special' });
    league = await service.logDuel('arena', { winner: '@nobody', loser: 'Bolt', bestOf: 1 });
    assert.strictEqual(league.duels[3].winner, 'nobody', 'once found, they claim the name their handle was logged under');
    assert.ok(league.log.some((entry) => entry.type === 'link' && entry.name === 'nobody'));

    const proposal = await service.proposeDuel('arena', {
      winner: { member: 'discord:222', name: 'Ratgrot', username: 'ratgrot' },
      loser: { member: 'discord:111', name: 'Kersa', username: 'kersa' },
      proposer: 'winner',
      score: [1, 0]
    });
    const confirmed = await service.confirmDuel(proposal.id, 'discord:111');
    assert.deepStrictEqual([confirmed.duel.winner, confirmed.duel.loser], ['Ace', 'Kersa | PF'], 'the same players as on Discord');

    const res = await route(service, 'GET', '/services/leagues/arena/handles?query=%40ke');
    assert.deepStrictEqual([res.status, res.body], [200, { handles: [{ handle: 'kersa', name: 'Kersa' }] }]);
    assert.strictEqual((await route(service, 'GET', '/services/leagues/nope/handles?query=ke')).status, 404);
  });

  it('takes handles as names when Discord lookup is unavailable', async function () {
    await service.createLeague({ name: 'Arena', kind: 'perpetual' });
    assert.strictEqual((await route(service, 'GET', '/services/leagues/arena/handles?query=ke')).status, 503);
    let league = await service.logDuel('arena', { winner: '@kersa', loser: 'Bolt', bestOf: 1 });
    assert.deepStrictEqual([league.duels[0].winner, league.duels[0].loser], ['kersa', 'Bolt']);

    await service.stop();
    const failing = { search: async () => { throw new Error('down'); }, resolve: async () => { throw new Error('down'); } };
    service = new Leagues({ path: dir, defaults: [], directory: failing, now: () => (clock += 1000) });
    await service.start();
    league = await service.logDuel('arena', { winner: '@kersa', loser: 'Bolt', bestOf: 1 });
    assert.strictEqual(league.duels[1].winner, 'kersa', 'a failed lookup does not stop the duel');
  });

  it('keeps leagues across restarts', async function () {
    await service.createLeague({ name: 'Arena', kind: 'perpetual' });
    await service.logDuel('arena', { winner: 'Ace', loser: 'Bolt', bestOf: 1 });
    await service.stop();
    service = new Leagues({ path: dir, defaults: [] });
    await service.start();
    const league = await service.getLeague('arena');
    assert.strictEqual(league.duels.length, 1);
    assert.strictEqual(league.leader.name, 'Ace');
  });
});
