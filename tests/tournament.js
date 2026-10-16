'use strict';

const assert = require('assert');
const Tournament = require('../assets/scripts/tournament-bracket.js');

/**
 * Score every ready set until none are left; `pick(match)` returns the winning side.
 * @returns {Object} the final resolved view
 */
function playOut (bracket, bestOf, record, pick) {
  for (let guard = 0; guard < 500; guard++) {
    const view = Tournament.resolveBracket(bracket, bestOf, record);
    const match = view.matches.find((m) => m.status === 'ready');
    if (!match) return view;
    const side = pick(match);
    record[match.id] = { players: [match.a, match.b], games: new Array(view.need).fill(side) };
  }
  throw new Error('bracket never finished');
}

const higherSeedWins = (m) => (m.a < m.b ? 0 : 1);

describe('tournament bracket engine', function () {
  it('normalizes formats and set lengths', function () {
    assert.strictEqual(Tournament.normalizeFormat('double'), Tournament.DOUBLE);
    assert.strictEqual(Tournament.normalizeFormat('nonsense'), Tournament.SINGLE);
    assert.strictEqual(Tournament.normalizeBestOf(3), 3);
    assert.strictEqual(Tournament.normalizeBestOf(4), 5);
    assert.strictEqual(Tournament.normalizeBestOf(0), 1);
    assert.strictEqual(Tournament.normalizeBestOf(99), 9);
    assert.strictEqual(Tournament.formatLabel('double-elimination', 3), 'Double elimination · Best of 3');
  });

  it('parses seeds in order without duplicates', function () {
    assert.deepStrictEqual(Tournament.parsePlayers('Viper, kestrel\nVIPER;  Nomad  Six '), ['Viper', 'kestrel', 'Nomad Six']);
  });

  it('pairs top seeds against bottom seeds', function () {
    assert.deepStrictEqual(Tournament.seedOrder(8), [0, 7, 3, 4, 1, 6, 2, 5]);
  });

  it('runs single elimination with byes for the top seeds', function () {
    const bracket = Tournament.createBracket(5, 'single-elimination');
    assert.strictEqual(bracket.size, 8);
    const first = Tournament.resolveBracket(bracket, 1, {});
    assert.strictEqual(first.matches.filter((m) => m.status === 'bye').length, 3);
    assert.strictEqual(first.byId['W1-1'].winner, 0, 'seed 1 gets a bye');
    const view = playOut(bracket, 1, {}, higherSeedWins);
    assert.strictEqual(view.champion, 0);
    assert.strictEqual(Tournament.roundName(bracket, view.byId['W3-1']), 'Final');
    assert.strictEqual(Tournament.roundName(bracket, view.byId['W2-1']), 'Semifinals');
  });

  it('needs a majority of games in a best-of-3 set', function () {
    const bracket = Tournament.createBracket(2, 'single-elimination');
    const record = { 'W1-1': { players: [0, 1], games: [1] } };
    let view = Tournament.resolveBracket(bracket, 3, record);
    assert.strictEqual(view.byId['W1-1'].status, 'live');
    assert.deepStrictEqual(view.byId['W1-1'].wins, [0, 1]);
    record['W1-1'].games.push(0);
    view = Tournament.resolveBracket(bracket, 3, record);
    assert.strictEqual(view.byId['W1-1'].status, 'live');
    record['W1-1'].games.push(1, 0);
    view = Tournament.resolveBracket(bracket, 3, record);
    assert.strictEqual(view.byId['W1-1'].status, 'done');
    assert.deepStrictEqual(view.byId['W1-1'].wins, [1, 2], 'games after the deciding one are ignored');
    assert.strictEqual(view.champion, 1);
  });

  it('runs double elimination: losers drop down and the winners champion needs one grand final', function () {
    const bracket = Tournament.createBracket(8, 'double-elimination');
    assert.strictEqual(bracket.matches.filter((m) => m.bracket === 'W').length, 7);
    assert.strictEqual(bracket.matches.filter((m) => m.bracket === 'L').length, 6);
    const view = playOut(bracket, 3, {}, higherSeedWins);
    assert.strictEqual(view.byId['F1-1'].a, 0);
    assert.strictEqual(view.byId['F1-1'].b, 1, 'seed 2 comes back through the losers bracket');
    assert.strictEqual(view.byId['F2-1'].status, 'skipped');
    assert.strictEqual(view.champion, 0);
    assert.strictEqual(Tournament.roundName(bracket, view.byId['L4-1']), 'Losers Final');
    assert.strictEqual(Tournament.roundName(bracket, view.byId['W3-1']), 'Winners Final');
  });

  it('resets the grand final when the losers bracket champion wins it', function () {
    const bracket = Tournament.createBracket(4, 'double-elimination');
    const record = {};
    let view = playOut(bracket, 3, record, (m) => (m.id === 'F1-1' ? 1 : higherSeedWins(m)));
    assert.strictEqual(view.byId['F1-1'].winner, 1);
    assert.strictEqual(view.byId['F2-1'].status, 'done', 'the reset is played');
    assert.strictEqual(view.champion, view.byId['F2-1'].winner);

    record['F2-1'] = { players: [0, 1], games: [1, 1] };
    view = Tournament.resolveBracket(bracket, 3, record);
    assert.strictEqual(view.champion, 1, 'losing twice eliminates the winners champion');
  });

  it('handles a two-player double elimination', function () {
    const bracket = Tournament.createBracket(2, 'double-elimination');
    const view = playOut(bracket, 1, {}, (m) => (m.id === 'W1-1' ? 0 : 1));
    assert.strictEqual(view.byId['F1-1'].b, 1, 'the loser of the only set is the losers champion');
    assert.strictEqual(view.byId['F2-1'].status, 'done');
    assert.strictEqual(view.champion, 1);
  });

  it('sets later results aside when an earlier result changes', function () {
    const bracket = Tournament.createBracket(4, 'single-elimination');
    const record = {};
    let view = playOut(bracket, 1, record, higherSeedWins);
    assert.strictEqual(view.champion, 0);
    record['W1-1'] = { players: [0, 3], games: [1] };
    view = Tournament.resolveBracket(bracket, 1, record);
    assert.strictEqual(view.byId['W2-1'].a, 3);
    assert.strictEqual(view.byId['W2-1'].status, 'ready', 'the final is replayed with the new finalist');
    assert.strictEqual(view.champion, undefined);
    record['W1-1'] = { players: [0, 3], games: [0] };
    view = Tournament.resolveBracket(bracket, 1, record);
    assert.strictEqual(view.champion, 0, 'restoring the result restores the final');
  });

  describe('latecomers', function () {
    const winnersSets = (view, player) => view.matches.filter((m) => m.bracket === 'W' && m.status === 'done' && (m.a === player || m.b === player)).length;

    function sixPlayers () {
      const slots = Tournament.drawSlots(6);
      assert.deepStrictEqual(slots, [0, null, 3, 4, 1, null, 2, 5], 'seeds 1 and 2 get byes');
      const record = { 'W1-2': { players: [3, 4], games: [0, 0] } };
      return { slots, format: Tournament.DOUBLE, bestOf: 3, record };
    }

    it('redraws the field before the first game', function () {
      const seat = Tournament.seatLatecomer({ slots: Tournament.drawSlots(3), format: Tournament.SINGLE, bestOf: 1, record: {} }, 4);
      assert.strictEqual(seat.redrawn, true);
      assert.deepStrictEqual(seat.slots, Tournament.drawSlots(4));
    });

    it('takes the lowest open bye and keeps every scored game', function () {
      const state = sixPlayers();
      const seat = Tournament.seatLatecomer(state, 7);
      assert.ifError(seat.error);
      assert.strictEqual(seat.slots[5], 6, 'the latecomer takes seed 2’s bye (the next seed number)');
      const view = Tournament.resolveBracket(Tournament.createBracket(seat.slots, state.format), state.bestOf, state.record);
      assert.strictEqual(view.byId['W1-2'].status, 'done', 'the scored set stands');
      assert.deepStrictEqual([view.byId['W1-3'].a, view.byId['W1-3'].b, view.byId['W1-3'].status], [1, 6, 'ready']);
    });

    it('makes the latecomer fight as many sets to the final as everyone else', function () {
      const state = sixPlayers();
      const seat = Tournament.seatLatecomer(state, 7);
      const bracket = Tournament.createBracket(seat.slots, state.format);
      const view = playOut(bracket, 3, Object.assign({}, state.record), (m) => (m.a === 6 ? 0 : m.b === 6 ? 1 : higherSeedWins(m)));
      assert.strictEqual(view.byId['W3-1'].winner, 6, 'the latecomer wins the winners bracket');
      assert.strictEqual(winnersSets(view, 6), bracket.rounds);
      assert.strictEqual(winnersSets(view, 3), 2, 'seed 4 played from the first round too');
      assert.strictEqual(view.champion, 6);
    });

    it('skips a bye once its player has played their next set', function () {
      const state = sixPlayers();
      state.record['W1-4'] = { players: [2, 5], games: [0, 0] };
      state.record['W2-2'] = { players: [1, 2], games: [0] };
      const seat = Tournament.seatLatecomer(state, 7);
      assert.ifError(seat.error);
      assert.strictEqual(seat.slots[5], null, 'seed 2 is already playing in round 2');
      assert.strictEqual(seat.slots[1], 6, 'the latecomer takes seed 1’s bye instead');

      state.record['W2-1'] = { players: [0, 3], games: [1] };
      const none = Tournament.seatLatecomer(state, 7);
      assert.match(none.error, /No open first-round seat/);
    });

    it('refuses when the bracket is full', function () {
      const state = { slots: Tournament.drawSlots(4), format: Tournament.SINGLE, bestOf: 1, record: { 'W1-1': { players: [0, 3], games: [0] } } };
      assert.match(Tournament.seatLatecomer(state, 5).error, /bracket is full/);
    });
  });

  it('reports final standings', function () {
    const single = Tournament.createBracket(4, 'single-elimination');
    assert.strictEqual(Tournament.placements(single, Tournament.resolveBracket(single, 1, {})), null);
    assert.deepStrictEqual(Tournament.placements(single, playOut(single, 1, {}, higherSeedWins)), { champion: 0, runnerUp: 1, third: null });

    const double = Tournament.createBracket(4, 'double-elimination');
    const reset = playOut(double, 1, {}, (m) => (m.bracket === 'F' ? 1 : higherSeedWins(m)));
    assert.deepStrictEqual(Tournament.placements(double, reset), { champion: 1, runnerUp: 0, third: 2 });
  });
});
