'use strict';

/**
 * @fileoverview Elo ratings for league duels. A duel is one result (winner 1,
 * loser 0) whose weight grows with the set length: K × √(best of), so a best
 * of 3 moves ratings about 1.7× a single game. Ratings are always rebuilt by
 * replaying a season's duels in the order they were logged, so voiding a duel
 * is just leaving it out. Pure; no I/O.
 */

const DEFAULT_K = 32;
const DEFAULT_RATING = 1000;

/**
 * Chance that a player rated `rating` beats one rated `opponent`.
 * @param {number} rating
 * @param {number} opponent
 * @returns {number}
 */
function expected (rating, opponent) {
  return 1 / (1 + Math.pow(10, (opponent - rating) / 400));
}

/**
 * @param {number} bestOf Odd set length.
 * @returns {number}
 */
function setWeight (bestOf) {
  return Math.sqrt(Math.max(1, Number(bestOf) || 1));
}

/**
 * Rating points the winner takes from the loser.
 * @param {number} winner Winner's rating before the duel.
 * @param {number} loser Loser's rating before the duel.
 * @param {number} bestOf
 * @param {number} [k]
 * @returns {number}
 */
function exchange (winner, loser, bestOf, k = DEFAULT_K) {
  return k * setWeight(bestOf) * (1 - expected(winner, loser));
}

function key (name) {
  return String(name).toLowerCase();
}

/**
 * Replay duels into standings.
 * @param {Array<{ id: string, winner: string, loser: string, bestOf: number, score: number[], voided?: Object }>} duels In logged order.
 * @param {Object} [opts]
 * @param {number} [opts.k]
 * @param {number} [opts.initialRating]
 * @param {string[]} [opts.roster] Players listed under `waiting` until their first duel.
 * @returns {{ standings: Array<Object>, waiting: string[], changes: Object<string, { winner: number[], loser: number[], points: number }> }}
 *   `changes[duelId]` holds each side's rating before → after (rounded) and the points exchanged.
 */
function rate (duels, opts = {}) {
  const k = Number(opts.k) > 0 ? Number(opts.k) : DEFAULT_K;
  const initial = Number.isFinite(Number(opts.initialRating)) ? Number(opts.initialRating) : DEFAULT_RATING;
  const players = new Map();
  const changes = {};
  const player = (name) => {
    if (!players.has(key(name))) {
      players.set(key(name), { name, rating: initial, peak: initial, wins: 0, losses: 0, gamesWon: 0, gamesLost: 0, streak: 0, lastDuelId: null });
    }
    return players.get(key(name));
  };
  for (const duel of duels || []) {
    if (!duel || duel.voided) continue;
    const winner = player(duel.winner);
    const loser = player(duel.loser);
    const points = exchange(winner.rating, loser.rating, duel.bestOf, k);
    const before = [winner.rating, loser.rating];
    winner.rating += points;
    loser.rating -= points;
    winner.peak = Math.max(winner.peak, winner.rating);
    winner.wins += 1;
    loser.losses += 1;
    const score = Array.isArray(duel.score) ? duel.score : [1, 0];
    winner.gamesWon += score[0] || 0;
    winner.gamesLost += score[1] || 0;
    loser.gamesWon += score[1] || 0;
    loser.gamesLost += score[0] || 0;
    winner.streak = winner.streak > 0 ? winner.streak + 1 : 1;
    loser.streak = loser.streak < 0 ? loser.streak - 1 : -1;
    winner.lastDuelId = loser.lastDuelId = duel.id;
    changes[duel.id] = {
      winner: [Math.round(before[0]), Math.round(winner.rating)],
      loser: [Math.round(before[1]), Math.round(loser.rating)],
      points: Math.round(points * 10) / 10
    };
  }
  const standings = Array.from(players.values())
    .map((p) => Object.assign({}, p, { rating: Math.round(p.rating), peak: Math.round(p.peak), duels: p.wins + p.losses }))
    .sort((a, b) => b.rating - a.rating || b.duels - a.duels || a.name.localeCompare(b.name));
  standings.forEach((p, i) => {
    p.rank = i > 0 && standings[i - 1].rating === p.rating ? standings[i - 1].rank : i + 1;
  });
  const waiting = (opts.roster || []).filter((name) => !players.has(key(name)));
  return { standings, waiting, changes };
}

module.exports = {
  DEFAULT_K,
  DEFAULT_RATING,
  expected,
  setWeight,
  exchange,
  rate
};
