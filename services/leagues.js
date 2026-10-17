'use strict';

const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const elo = require('../functions/elo');
const { normalizeBestOf, parsePlayers } = require('../assets/scripts/tournament-bracket');

const BASE = '/services/leagues';
const LEAGUE_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const KINDS = ['perpetual', 'seasonal'];
const LIMITS = { name: 48, tagline: 120, summary: 600, season: 32, note: 140 };
const MAX_LEAGUES = 1000;
const MAX_PLAYERS = 500;
const MAX_DUELS = 20000;
const MAX_SEASONS = 200;
const OPEN_LEAGUE = {
  name: 'Open League',
  tagline: 'Any ship, any loadout.',
  summary: 'The standing duel ladder for everyone. Open rules: no ship class restrictions. Log every duel here and the ratings update.',
  kind: 'perpetual',
  bestOf: 3
};

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function text (value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function slugify (name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'league';
}

function integer (value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function optionalDate (value) {
  if (value === undefined || value === null || value === '') return null;
  const when = new Date(value);
  const year = when.getUTCFullYear();
  if (isNaN(when.getTime()) || year < 2000 || year > 2100) throw fail(400, 'That date is not valid.');
  return when.toISOString();
}

function current (league) {
  return league.seasons[league.seasons.length - 1];
}

function findPlayer (league, name) {
  const wanted = String(name || '').toLowerCase();
  return league.players.find((player) => player.name.toLowerCase() === wanted) || null;
}

function seasonDuels (league, number) {
  return league.duels.filter((duel) => duel.season === number);
}

function rateSeason (league, season) {
  return elo.rate(seasonDuels(league, season.number), {
    k: league.k,
    initialRating: league.initialRating,
    roster: league.players.map((player) => player.name)
  });
}

function summary (league) {
  const season = current(league);
  const { standings } = rateSeason(league, season);
  const leader = standings[0] ? { name: standings[0].name, rating: standings[0].rating } : null;
  return {
    id: league.id,
    name: league.name,
    tagline: league.tagline || '',
    kind: league.kind,
    bestOf: league.bestOf,
    season: { number: season.number, name: season.name },
    players: league.players.length,
    duels: league.duels.filter((duel) => !duel.voided).length,
    leader,
    updatedAt: league.updatedAt
  };
}

function publicLeague (league) {
  const changes = {};
  const seasons = league.seasons.map((season) => {
    const rated = rateSeason(league, season);
    Object.assign(changes, rated.changes);
    const open = !season.endedAt;
    return Object.assign({}, season, {
      status: open ? 'active' : 'complete',
      standings: open ? rated.standings : season.standings,
      waiting: open ? rated.waiting : [],
      duels: seasonDuels(league, season.number).filter((duel) => !duel.voided).length
    });
  });
  return Object.assign(summary(league), {
    summary: league.summary || '',
    k: league.k,
    initialRating: league.initialRating,
    createdAt: league.createdAt,
    createdBy: league.createdBy || null,
    players: league.players.map((player) => player.name),
    seasons,
    duels: league.duels.map((duel) => Object.assign({}, duel, { change: changes[duel.id] || null })),
    log: league.log
  });
}

/**
 * Duel leagues for goon.vc. A league is either **perpetual** (one rating
 * ladder forever) or **seasonal** (ratings restart each season; a finished
 * season's standings are frozen on record). Anyone logs a duel — winner,
 * loser, best of n, set score — and Elo ratings ({@link module:functions/elo})
 * are rebuilt from the season's duels. Nothing is deleted: a mistaken duel is
 * voided (and can be restored), and every change is in the league's log.
 * Everything lives in one `@fabric/core` {@link Store}.
 */
class Leagues {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string} [settings.basePath] Site path of the league pages (for link previews).
   * @param {Function} [settings.identify] `async (req) => displayName|null` for the change log.
   * @param {Array<Object>} [settings.defaults] Leagues created on start when their id is free (same shape as {@link Leagues#createLeague}).
   * @param {Function} [settings.now] Clock, injected for tests.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/leagues',
      basePath: '/leagues',
      identify: null,
      defaults: [OPEN_LEAGUE],
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.store = null;
    this._queue = Promise.resolve();
  }

  async start () {
    this.store = new Store({
      name: 'GOON.VC:leagues',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await startStore(this.store);
    for (const league of this.settings.defaults || []) {
      const ids = await this._index();
      if (!ids.includes(slugify(text(league.name, LIMITS.name)))) await this.createLeague(league);
    }
    return this;
  }

  async stop () {
    await this._queue.catch(() => {});
    if (this.store) await this.store.stop();
    return this;
  }

  _exclusive (task) {
    const run = this._queue.then(task, task);
    this._queue = run.catch(() => {});
    return run;
  }

  _iso () {
    return new Date(this.settings.now()).toISOString();
  }

  _entry (type, by, fields) {
    return Object.assign({ at: this._iso(), type }, fields, by ? { by } : {});
  }

  async _index () {
    const list = await this.store.get('/index/leagues');
    return Array.isArray(list) ? list : [];
  }

  async _get (id) {
    if (!LEAGUE_ID.test(String(id || ''))) return null;
    return this.store.get(`/league/${id}`);
  }

  async getLeague (id) {
    const league = await this._get(id);
    return league ? publicLeague(league) : null;
  }

  /**
   * Most recently active first.
   * @returns {Promise<Array<Object>>}
   */
  async listLeagues () {
    const out = [];
    for (const id of await this._index()) {
      const league = await this._get(id);
      if (league) out.push(summary(league));
    }
    return out.sort((x, y) => String(y.updatedAt).localeCompare(String(x.updatedAt)));
  }

  /**
   * @param {Object} input `{ name, tagline?, summary?, kind, bestOf?, k?, initialRating?, players?, season?: { name?, endsAt? } }`
   * @param {string} [by] Display name of whoever created it.
   * @returns {Promise<Object>} the league
   */
  createLeague (input, by) {
    return this._exclusive(async () => {
      input = input || {};
      const name = text(input.name, LIMITS.name);
      if (name.length < 2) throw fail(400, 'A league needs a name.');
      const kind = String(input.kind || '').toLowerCase();
      if (!KINDS.includes(kind)) throw fail(400, 'A league is either perpetual or seasonal.');
      const k = integer(input.k, elo.DEFAULT_K, 4, 100);
      if (k === null) throw fail(400, 'K must be between 4 and 100.');
      const initialRating = integer(input.initialRating, elo.DEFAULT_RATING, 100, 3000);
      if (initialRating === null) throw fail(400, 'The starting rating must be between 100 and 3000.');
      const players = parsePlayers(input.players || []);
      if (players.length > MAX_PLAYERS) throw fail(400, `The limit is ${MAX_PLAYERS} players.`);
      const seasonInput = input.season || {};
      const endsAt = kind === 'seasonal' ? optionalDate(seasonInput.endsAt) : null;
      const ids = await this._index();
      if (ids.length >= MAX_LEAGUES) throw fail(409, 'The league archive is full.');

      const base = slugify(name);
      let id = base;
      for (let n = 2; ids.includes(id); n++) id = `${base}-${n}`;
      const now = this._iso();
      const season = {
        number: 1,
        name: kind === 'seasonal' ? (text(seasonInput.name, LIMITS.season) || 'Season 1') : 'All time',
        startedAt: now,
        endsAt,
        endedAt: null
      };
      const league = {
        id,
        name,
        tagline: text(input.tagline, LIMITS.tagline),
        summary: text(input.summary, LIMITS.summary),
        kind,
        bestOf: normalizeBestOf(input.bestOf),
        k,
        initialRating,
        createdAt: now,
        createdBy: by || null,
        updatedAt: now,
        players: players.map((player) => ({ name: player, joinedAt: now })),
        seasons: [season],
        duels: [],
        log: [this._entry('create', by, { kind, players })]
      };
      await this.store.set(`/league/${id}`, league);
      await this.store.set('/index/leagues', ids.concat(id));
      return publicLeague(league);
    });
  }

  _change (id, change) {
    return this._exclusive(async () => {
      const stored = await this._get(id);
      if (!stored) throw fail(404, 'No such league.');
      const league = JSON.parse(JSON.stringify(stored));
      change(league);
      league.updatedAt = this._iso();
      await this.store.set(`/league/${league.id}`, league);
      return publicLeague(league);
    });
  }

  _join (league, name, by) {
    if (findPlayer(league, name)) return findPlayer(league, name).name;
    if (league.players.length >= MAX_PLAYERS) throw fail(409, `The limit is ${MAX_PLAYERS} players.`);
    league.players.push({ name, joinedAt: this._iso() });
    league.log.push(this._entry('join', by, { name }));
    return name;
  }

  /**
   * Edit the name, tagline, summary, or default set length.
   */
  updateLeague (id, input, by) {
    return this._change(id, (league) => {
      input = input || {};
      const fields = {};
      if (input.name !== undefined) {
        const name = text(input.name, LIMITS.name);
        if (name.length < 2) throw fail(400, 'A league needs a name.');
        fields.name = name;
      }
      if (input.tagline !== undefined) fields.tagline = text(input.tagline, LIMITS.tagline);
      if (input.summary !== undefined) fields.summary = text(input.summary, LIMITS.summary);
      if (input.bestOf !== undefined) fields.bestOf = normalizeBestOf(input.bestOf);
      const changed = Object.keys(fields).filter((key) => fields[key] !== league[key]);
      if (!changed.length) throw fail(400, 'Nothing to change.');
      changed.forEach((key) => { league[key] = fields[key]; });
      league.log.push(this._entry('update', by, { fields: changed }));
    });
  }

  addPlayer (id, name, by) {
    return this._change(id, (league) => {
      const player = parsePlayers([name])[0];
      if (!player) throw fail(400, 'A player needs a name.');
      if (findPlayer(league, player)) throw fail(409, `${findPlayer(league, player).name} is already in the league.`);
      this._join(league, player, by);
    });
  }

  /**
   * Log a duel in the current season: `{ winner, loser, bestOf, score: [won, lost], note? }`.
   * New names join the league. The winner of a best of n took (n + 1) / 2 games.
   */
  logDuel (id, input, by) {
    return this._change(id, (league) => {
      input = input || {};
      const season = current(league);
      if (season.endedAt) throw fail(409, 'This season is over; start the next one to log duels.');
      if (league.duels.length >= MAX_DUELS) throw fail(409, 'This league is full.');
      const [winnerName] = parsePlayers([input.winner]);
      const [loserName] = parsePlayers([input.loser]);
      if (!winnerName || !loserName) throw fail(400, 'A duel needs a winner and a loser.');
      if (winnerName.toLowerCase() === loserName.toLowerCase()) throw fail(400, 'A pilot cannot duel themselves.');
      const bestOf = normalizeBestOf(input.bestOf === undefined ? league.bestOf : input.bestOf);
      const need = (bestOf + 1) / 2;
      const score = Array.isArray(input.score) ? input.score.map(Number) : bestOf === 1 ? [1, 0] : null;
      if (!score) throw fail(400, `Give the set score for a best of ${bestOf}.`);
      if (score[0] !== need || !Number.isInteger(score[1]) || score[1] < 0 || score[1] >= need) {
        throw fail(400, `A best of ${bestOf} ends ${need}–0${need > 1 ? ` to ${need}–${need - 1}` : ''}.`);
      }
      const winner = this._join(league, winnerName, by);
      const loser = this._join(league, loserName, by);
      const duel = {
        id: `d${league.duels.length + 1}`,
        season: season.number,
        winner,
        loser,
        bestOf,
        score: [score[0], score[1]],
        note: text(input.note, LIMITS.note),
        loggedAt: this._iso()
      };
      if (by) duel.by = by;
      if (!duel.note) delete duel.note;
      league.duels.push(duel);
      league.log.push(this._entry('duel', by, { duel: duel.id, winner, loser, bestOf, score: duel.score }));
    });
  }

  _openDuel (league, duelId) {
    const duel = league.duels.find((entry) => entry.id === duelId);
    if (!duel) throw fail(404, 'No such duel.');
    const season = league.seasons.find((entry) => entry.number === duel.season);
    if (season && season.endedAt) throw fail(409, `${season.name} is over; its duels are final.`);
    return duel;
  }

  /**
   * Strike a duel from the ratings (it stays on record, marked void).
   */
  voidDuel (id, duelId, input, by) {
    return this._change(id, (league) => {
      const duel = this._openDuel(league, duelId);
      if (duel.voided) throw fail(409, 'That duel is already void.');
      const reason = text(input && input.reason, LIMITS.note);
      duel.voided = Object.assign({ at: this._iso() }, by ? { by } : {}, reason ? { reason } : {});
      league.log.push(this._entry('void', by, Object.assign({ duel: duel.id, winner: duel.winner, loser: duel.loser }, reason ? { reason } : {})));
    });
  }

  restoreDuel (id, duelId, by) {
    return this._change(id, (league) => {
      const duel = this._openDuel(league, duelId);
      if (!duel.voided) throw fail(409, 'That duel counts already.');
      delete duel.voided;
      league.log.push(this._entry('restore', by, { duel: duel.id, winner: duel.winner, loser: duel.loser }));
    });
  }

  /**
   * Seasonal leagues: close the current season (its standings are frozen)
   * and open the next, where everyone starts again at the starting rating.
   * `{ name?, endsAt? }` for the new season.
   */
  startSeason (id, input, by) {
    return this._change(id, (league) => {
      if (league.kind !== 'seasonal') throw fail(409, 'A perpetual league has no seasons.');
      if (league.seasons.length >= MAX_SEASONS) throw fail(409, 'This league has run out of seasons.');
      input = input || {};
      const endsAt = optionalDate(input.endsAt);
      const previous = current(league);
      const { standings } = rateSeason(league, previous);
      const now = this._iso();
      previous.endedAt = now;
      previous.standings = standings;
      previous.champion = standings[0] ? standings[0].name : null;
      league.log.push(this._entry('season-end', by, { season: previous.number, name: previous.name, champion: previous.champion }));
      const number = previous.number + 1;
      const season = { number, name: text(input.name, LIMITS.season) || `Season ${number}`, startedAt: now, endsAt, endedAt: null };
      league.seasons.push(season);
      league.log.push(this._entry('season-start', by, { season: number, name: season.name }));
    });
  }

  /**
   * Link-preview metadata for a league page, or null.
   * @param {string} pathname
   * @returns {Promise<{ path: string, title: string, description: string }|null>}
   */
  async page (pathname) {
    const base = String(this.settings.basePath).replace(/\/+$/, '').toLowerCase();
    const clean = String(pathname || '').replace(/\/+$/, '');
    if (clean.toLowerCase().indexOf(base + '/') !== 0) return null;
    const rest = clean.slice(base.length + 1);
    if (rest.includes('/')) return null;
    let id;
    try {
      id = decodeURIComponent(rest).toLowerCase();
    } catch (_) {
      return null;
    }
    const league = await this._get(id);
    if (!league) return null;
    const info = summary(league);
    const kind = league.kind === 'seasonal' ? `${info.season.name} of a seasonal league` : 'Perpetual league';
    const players = `${info.players} pilot${info.players === 1 ? '' : 's'}`;
    const leader = info.leader ? ` Leader: ${info.leader.name} (${info.leader.rating}).` : '';
    return { path: clean, title: league.name, description: `${kind} · ${players} · Elo-rated duels.${leader}` };
  }

  /**
   * Express middleware for `/services/leagues/*`.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      if (pathname !== BASE && !pathname.startsWith(BASE + '/')) return next();
      const method = String(req.method || 'GET').toUpperCase();
      const parts = pathname.slice(BASE.length).split('/').filter(Boolean);
      const body = (req.body && typeof req.body === 'object') ? req.body : {};
      Promise.resolve().then(async () => {
        const by = typeof this.settings.identify === 'function' && method !== 'GET'
          ? await Promise.resolve(this.settings.identify(req)).catch(() => null)
          : null;
        const [id, collection, itemId, action] = parts;
        if (!parts.length) {
          if (method === 'GET') return [200, { leagues: await this.listLeagues() }];
          if (method === 'POST') return [201, await this.createLeague(body, by)];
        } else if (parts.length === 1) {
          if (method === 'GET') {
            const league = await this.getLeague(id);
            if (!league) throw fail(404, 'No such league.');
            return [200, league];
          }
          if (method === 'PATCH') return [200, await this.updateLeague(id, body, by)];
        } else if (parts.length === 2) {
          if (collection === 'players' && method === 'POST') return [200, await this.addPlayer(id, body.name, by)];
          if (collection === 'duels' && method === 'POST') return [201, await this.logDuel(id, body, by)];
          if (collection === 'seasons' && method === 'POST') return [201, await this.startSeason(id, body, by)];
        } else if (parts.length === 4 && collection === 'duels' && method === 'POST') {
          if (action === 'void') return [200, await this.voidDuel(id, itemId, body, by)];
          if (action === 'restore') return [200, await this.restoreDuel(id, itemId, by)];
        }
        throw fail(parts.length > 4 ? 404 : 405, parts.length > 4 ? 'Not found' : 'Method not allowed');
      }).then(([status, payload]) => sendJson(res, status, payload), (error) => {
        if (res.headersSent) return;
        sendJson(res, error && error.status ? error.status : 500, { error: error && error.message ? error.message : 'League request failed' });
      });
    };
  }
}

module.exports = Leagues;
module.exports.OPEN_LEAGUE = OPEN_LEAGUE;
