'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Leagues = require('../services/leagues');
const elo = require('../functions/elo');

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
