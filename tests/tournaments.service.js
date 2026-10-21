'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Tournaments = require('../services/tournaments');
const Leagues = require('../services/leagues');
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

  it('posts a finished tournament’s sets to a league once, in the order they finished', async function () {
    await service.stop();
    const posted = [];
    const leagueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-tournament-league-'));
    const leagues = new Leagues({ path: leagueDir });
    await leagues.start();
    service = new Tournaments({
      path: dir,
      onResults: async (report, by) => {
        posted.push(report);
        await leagues.recordTournament(Leagues.OPEN_LEAGUE_ID, report, by);
      }
    });
    await service.start();
    try {
      const created = await service.createTournament(Object.assign(saturday('2026-10-25T01:00:00.000Z', ['VIPER', 'KESTREL', 'NOMAD']), { format: 'single-elimination' }));
      const games = {};
      // Every set goes 2–1: the second-listed pilot takes game one.
      const done = await playOut(service, created.slug, (m) => {
        games[m.id] = (games[m.id] || 0) + 1;
        return games[m.id] === 1 ? 1 : 0;
      });
      assert.strictEqual(done.results.champion, 'VIPER');
      assert.strictEqual(posted.length, 1, 'posted when the champion is recorded');

      const report = service.report(done);
      assert.strictEqual(report.path, `/tournaments/saturday-1v1/${created.slug}`);
      assert.deepStrictEqual(report.sets.map((set) => [set.winner, set.loser, set.bestOf, set.score]), [
        ['KESTREL', 'NOMAD', 3, [2, 1]],
        ['VIPER', 'KESTREL', 3, [2, 1]]
      ], 'byes are not duels');
      assert.deepStrictEqual(posted[0], report);

      let league = await leagues.getLeague(Leagues.OPEN_LEAGUE_ID);
      assert.deepStrictEqual(league.duels.map((duel) => [duel.winner, duel.loser, duel.score, duel.source.tournament, duel.source.path]), [
        ['KESTREL', 'NOMAD', [2, 1], report.id, report.path],
        ['VIPER', 'KESTREL', [2, 1], report.id, report.path]
      ]);
      assert.deepStrictEqual(league.players, ['KESTREL', 'NOMAD', 'VIPER']);
      assert.strictEqual(league.seasons[0].standings[0].name, 'VIPER');
      const entry = league.log[league.log.length - 1];
      assert.deepStrictEqual([entry.type, entry.name, entry.duels], ['tournament', 'Saturday 1v1', ['d1', 'd2']]);

      const updatedAt = league.updatedAt;
      league = await leagues.recordTournament(Leagues.OPEN_LEAGUE_ID, (await service.resultReports())[0]);
      assert.strictEqual(league.duels.length, 2, 'posting again adds nothing');
      assert.strictEqual(league.updatedAt, updatedAt);
    } finally {
      await leagues.stop();
      fs.rmSync(leagueDir, { recursive: true, force: true });
    }
  });

  it('disqualifies a player who drops out, and never posts the DQ as a duel', async function () {
    await service.stop();
    const reports = [];
    service = new Tournaments({ path: dir, onResults: (report, by) => reports.push([report, by]) });
    await service.start();
    const created = await service.createTournament(Object.assign(saturday('2026-10-25T01:00:00.000Z', ['VIPER', 'KESTREL', 'NOMAD', 'RONIN']), { format: 'single-elimination' }));
    const slug = created.slug;

    await service.recordGame('saturday-1v1', slug, { match: 'W1-1', side: 1, players: [0, 3] });
    await assert.rejects(service.recordForfeit('saturday-1v1', slug, { match: 'W1-1', side: 2 }), /side must be 0 or 1/);
    await assert.rejects(service.recordForfeit('saturday-1v1', slug, { match: 'W1-1', side: 1, players: [3, 0] }), /bracket changed/);
    let record = await service.recordForfeit('saturday-1v1', slug, { match: 'W1-1', side: 1, players: [0, 3] }, 'ChairmanPoW');
    assert.deepStrictEqual(record.record['W1-1'], { players: [0, 3], games: [1], forfeit: 1 });
    const entry = record.log[record.log.length - 1];
    assert.deepStrictEqual([entry.type, entry.player, entry.winner, entry.by], ['forfeit', 'RONIN', 'VIPER', 'ChairmanPoW']);
    assert.ok(!record.log.some((line) => line.type === 'set'), 'a DQ is not a set result');
    await assert.rejects(service.recordForfeit('saturday-1v1', slug, { match: 'W1-1', side: 0 }), /not open/);

    record = await service.undoGame('saturday-1v1', slug, { match: 'W1-1' });
    assert.deepStrictEqual(record.record['W1-1'], { players: [0, 3], games: [1] }, 'undo takes back the DQ and keeps the game');
    assert.strictEqual(record.log[record.log.length - 1].forfeit, 'RONIN');
    await service.recordForfeit('saturday-1v1', slug, { match: 'W1-1', side: 1 });

    for (let i = 0; i < 2; i++) await service.recordGame('saturday-1v1', slug, { match: 'W1-2', side: 0 });
    const done = await service.recordForfeit('saturday-1v1', slug, { match: 'W2-1', side: 1 }, 'ChairmanPoW');
    assert.strictEqual(done.status, 'complete');
    assert.deepStrictEqual([done.results.champion, done.results.runnerUp], ['VIPER', 'KESTREL']);
    assert.strictEqual(reports.length, 1);
    assert.deepStrictEqual(reports[0][0].sets.map((set) => [set.winner, set.loser, set.score]), [['KESTREL', 'NOMAD', [2, 0]]], 'only the set actually played is a duel');
    assert.strictEqual(reports[0][1], 'ChairmanPoW');
  });

  it('locks a finished tournament: only the password edits it, and the league follows its results', async function () {
    await service.stop();
    const leagueDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-tournament-lock-'));
    const leagues = new Leagues({ path: leagueDir });
    await leagues.start();
    service = new Tournaments({
      path: dir,
      password: 'hunter2',
      onResults: (report, by) => leagues.recordTournament(Leagues.OPEN_LEAGUE_ID, report, by)
    });
    await service.start();
    const duels = async () => (await leagues.getLeague(Leagues.OPEN_LEAGUE_ID)).duels.filter((duel) => !duel.voided).map((duel) => [duel.winner, duel.loser]);
    try {
      const created = await service.createTournament(Object.assign(saturday('2026-10-25T01:00:00.000Z', ['VIPER', 'KESTREL']), { format: 'single-elimination', bestOf: 1 }));
      const slug = created.slug;
      const done = await service.recordGame('saturday-1v1', slug, { match: 'W1-1', side: 0 });
      assert.deepStrictEqual([done.status, done.locked, done.results.champion], ['complete', true, 'VIPER']);
      assert.deepStrictEqual(await duels(), [['VIPER', 'KESTREL']]);

      const refused = (status) => (error) => error.status === status;
      await assert.rejects(service.undoGame('saturday-1v1', slug, { match: 'W1-1' }), refused(401));
      await assert.rejects(service.undoGame('saturday-1v1', slug, { match: 'W1-1' }, null, 'hunter3'), refused(401));
      await assert.rejects(service.unlock('saturday-1v1', slug, 'hunter3'), /Wrong password/);
      assert.strictEqual((await service.unlock('saturday-1v1', slug, 'hunter2')).locked, true);

      const reopened = await service.undoGame('saturday-1v1', slug, { match: 'W1-1' }, 'ChairmanPoW', 'hunter2');
      assert.deepStrictEqual([reopened.status, reopened.locked, reopened.results], ['open', true, null], 'its only game was taken back');
      const entry = reopened.log[reopened.log.length - 1];
      assert.deepStrictEqual([entry.type, entry.champion, entry.by], ['reopen', 'VIPER', 'ChairmanPoW']);
      assert.deepStrictEqual(await duels(), [], 'a reopened tournament takes its duels back');
      await assert.rejects(service.recordGame('saturday-1v1', slug, { match: 'W1-1', side: 1 }), refused(401), 'still locked while reopened');

      const again = await service.recordGame('saturday-1v1', slug, { match: 'W1-1', side: 1 }, 'ChairmanPoW', 'hunter2');
      assert.deepStrictEqual([again.status, again.results.champion], ['complete', 'KESTREL']);
      assert.deepStrictEqual(await duels(), [['KESTREL', 'VIPER']], 'the league has the corrected result');
    } finally {
      await leagues.stop();
      fs.rmSync(leagueDir, { recursive: true, force: true });
    }
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
