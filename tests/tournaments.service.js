'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Tournaments = require('../services/tournaments');
const engine = require('../assets/scripts/tournament-bracket');

const SATURDAY = {
  name: 'Saturday 1v1',
  format: 'double-elimination',
  bestOf: 3,
  timeZone: 'America/Chicago'
};

async function open (dir) {
  const service = new Tournaments({ path: dir });
  await service.start();
  return service;
}

function saturday (startsAt, players) {
  return Object.assign({}, SATURDAY, { startsAt, players });
}

/**
 * Play every open set through the service, picking each game's winner.
 */
async function playOut (service, slug, pick) {
  for (let guard = 0; guard < 200; guard++) {
    const record = await service.getTournament('saturday-1v1', slug);
    if (record.status === 'complete') return record;
    const view = engine.resolveBracket(engine.createBracket(record.slots, record.format), record.bestOf, record.record);
    const match = view.matches.find((m) => m.status === 'ready' || m.status === 'live');
    const side = pick(match);
    await service.recordGame('saturday-1v1', slug, { match: match.id, side, players: [match.a, match.b] });
  }
  throw new Error('never finished');
}

describe('tournaments service', function () {
  let dir;
  let service;

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-tournaments-'));
    service = await open(dir);
  });

  afterEach(async function () {
    if (service) await service.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates tournaments, grouped by name and dated in the creator’s zone', async function () {
    assert.deepStrictEqual(await service.listTournaments(), [], 'nothing is built in');

    const cup = await service.createTournament({
      name: 'Gladius Cup',
      summary: 'Gladius only.',
      format: 'single',
      bestOf: 4,
      startsAt: '2026-10-24T01:30:00Z',
      timeZone: 'America/New_York',
      players: ['VIPER', 'KESTREL', 'NOMAD']
    }, 'ChairmanPoW');
    assert.strictEqual(cup.id, 'gladius-cup/2026-10-23');
    assert.strictEqual(cup.seriesId, 'gladius-cup');
    assert.strictEqual(cup.format, 'single-elimination');
    assert.strictEqual(cup.bestOf, 5);
    assert.strictEqual(cup.summary, 'Gladius only.');
    assert.deepStrictEqual(cup.players, ['VIPER', 'KESTREL', 'NOMAD']);
    assert.strictEqual(cup.createdBy, 'ChairmanPoW');
    assert.strictEqual(cup.log[0].by, 'ChairmanPoW');

    const next = await service.createTournament({ name: 'gladius cup!', startsAt: '2026-10-31T01:30:00Z', timeZone: 'America/New_York' });
    assert.strictEqual(next.id, 'gladius-cup/2026-10-30', 'the same name joins the same series');
    const sameDay = await service.createTournament({ name: 'Gladius Cup', startsAt: '2026-10-31T03:00:00Z', timeZone: 'America/New_York' });
    assert.strictEqual(sameDay.slug, '2026-10-30-2');
    assert.deepStrictEqual((await service.listTournaments('gladius-cup')).map((entry) => entry.slug), ['2026-10-30-2', '2026-10-30', '2026-10-23']);

    await assert.rejects(service.createTournament({ name: 'x', startsAt: '2026-11-01T00:00:00Z' }), /needs a name/);
    await assert.rejects(service.createTournament({ name: 'No date' }), /start date and time/);
    await assert.rejects(service.createTournament({ name: 'Soon', startsAt: 'soon' }), /start date and time/);
    await assert.rejects(service.createTournament({ name: 'Bad zone', startsAt: '2026-11-01T00:00:00Z', timeZone: 'Mars/Olympus' }), /Unknown time zone/);
    assert.strictEqual((await service.listTournaments()).length, 3, 'rejected creations leave nothing behind');
  });

  it('records a tournament permanently: games, latecomers, and the final standings', async function () {
    const created = await service.createTournament(saturday('2026-10-18T01:00:00.000Z', ['VIPER', 'KESTREL', 'NOMAD', 'RONIN', 'TALON', 'WRAITH']), 'ChairmanPoW');
    assert.strictEqual(created.slug, '2026-10-17', 'the local date (8 PM Central)');
    assert.strictEqual(created.id, 'saturday-1v1/2026-10-17');
    assert.strictEqual(created.status, 'open');

    await service.addPlayer('saturday-1v1', created.slug, 'SPECTER');
    let record = await service.getTournament('saturday-1v1', created.slug);
    assert.strictEqual(record.entrants.length, 7);
    assert.strictEqual(record.entrants[6].late, false, 'joining before the first game is a normal entry');

    await service.setPlayers('saturday-1v1', created.slug, ['VIPER', 'KESTREL', 'NOMAD', 'RONIN', 'TALON', 'WRAITH']);
    const after = await service.recordGame('saturday-1v1', created.slug, { match: 'W1-2', side: 0, players: [3, 4] });
    assert.strictEqual(after.status, 'live');
    await assert.rejects(service.recordGame('saturday-1v1', created.slug, { match: 'W1-2', side: 0, players: [4, 3] }), /bracket changed/);
    await assert.rejects(service.setPlayers('saturday-1v1', created.slug, ['A', 'B']), /add latecomers instead/);

    const late = await service.addPlayer('saturday-1v1', created.slug, 'SPECTER');
    assert.strictEqual(late.entrants[6].late, true);
    assert.strictEqual(late.slots[5], 6, 'the latecomer takes an open first-round bye');
    await assert.rejects(service.addPlayer('saturday-1v1', created.slug, 'specter'), /already in the bracket/);

    await service.undoGame('saturday-1v1', created.slug, { match: 'W1-2' });
    record = await service.getTournament('saturday-1v1', created.slug);
    assert.deepStrictEqual(record.record['W1-2'].games, [], 'the game is taken back');
    assert.deepStrictEqual(record.log.filter((entry) => entry.type === 'game').length, 1, 'but stays in the log');

    const done = await playOut(service, created.slug, (m) => (m.a < m.b ? 0 : 1));
    assert.strictEqual(done.status, 'complete');
    assert.strictEqual(done.results.champion, 'VIPER');
    assert.strictEqual(done.results.runnerUp, 'KESTREL');
    assert.ok(done.results.completedAt);
    assert.strictEqual(done.log[done.log.length - 1].type, 'complete');
    await assert.rejects(service.recordGame('saturday-1v1', created.slug, { match: 'F1-1', side: 1 }), /final/);
    await assert.rejects(service.addPlayer('saturday-1v1', created.slug, 'LATE'), /final/);

    const [summary] = await service.listTournaments();
    assert.deepStrictEqual(summary.results.champion, 'VIPER');
    assert.strictEqual(summary.players, 7);

    await service.stop();
    service = await open(dir);
    const reopened = await service.getTournament('saturday-1v1', created.slug);
    assert.strictEqual(reopened.results.champion, 'VIPER', 'results survive a restart');
    assert.strictEqual((await service.listTournaments('saturday-1v1')).length, 1);
  });

  it('describes series and tournament pages for link previews', async function () {
    const first = await service.createTournament(saturday('2026-10-18T01:00:00Z', ['A', 'B']));
    await service.createTournament(saturday('2026-10-25T01:00:00Z'));
    await service.recordGame('saturday-1v1', first.slug, { match: 'W1-1', side: 0 });
    await service.recordGame('saturday-1v1', first.slug, { match: 'W1-1', side: 0 });
    await playOut(service, first.slug, () => 0);

    const page = await service.page('/tournaments/saturday-1v1/2026-10-17');
    assert.strictEqual(page.title, 'Saturday 1v1 — 2026-10-17');
    assert.match(page.description, /Sat, Oct 17, 2026, 8:00 PM CDT\. Champion: A; runner-up: B\. 2 players\./);
    const series = await service.page('/tournaments/Saturday-1v1');
    assert.strictEqual(series.title, 'Saturday 1v1');
    assert.strictEqual(series.description, '2 tournaments on record. Latest champion: A.');
    assert.strictEqual(await service.page('/tournaments/saturday-1v1/2020-01-01'), null);
    assert.strictEqual(await service.page('/tournaments/nope'), null);
    assert.strictEqual(await service.page('/drills/x'), null);
  });

  it('serializes concurrent writes', async function () {
    const created = await service.createTournament(saturday('2026-10-18T01:00:00Z'));
    const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    await Promise.all(names.map((name) => service.addPlayer('saturday-1v1', created.slug, name)));
    const record = await service.getTournament('saturday-1v1', created.slug);
    assert.deepStrictEqual(record.entrants.map((entrant) => entrant.name), names);
  });
});
