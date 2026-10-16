'use strict';

const Store = require('@fabric/core/types/store');
const startStore = require('../functions/startStore');
const bracketEngine = require('../assets/scripts/tournament-bracket');

const {
  MAX_PLAYERS,
  normalizeFormat,
  normalizeBestOf,
  parsePlayers,
  drawSlots,
  createBracket,
  resolveBracket,
  hasGames,
  seatLatecomer,
  placements
} = bracketEngine;

const BASE = '/services/tournaments';
const SERIES_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;
const SLUG = /^\d{4}-\d{2}-\d{2}(?:-\d{1,3})?$/;
const MAX_TOURNAMENTS = 10000;
const LIMITS = { name: 48, tagline: 120, summary: 600 };

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
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '') || 'tournament';
}

function validTimeZone (zone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone }).format(0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Calendar date of `iso` in `timeZone`, as YYYY-MM-DD.
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
function localDate (iso, timeZone) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));
}

/**
 * Human date and time of `iso` in `timeZone`, for link previews.
 * @param {string} iso
 * @param {string} [timeZone]
 * @returns {string}
 */
function displayDate (iso, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: timeZone || 'UTC',
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short'
  }).format(new Date(iso));
}

function summary (tournament) {
  return {
    id: tournament.id,
    seriesId: tournament.seriesId,
    slug: tournament.slug,
    name: tournament.name,
    format: tournament.format,
    bestOf: tournament.bestOf,
    startsAt: tournament.startsAt,
    status: tournament.status,
    players: tournament.entrants.length,
    results: tournament.results || null
  };
}

function publicTournament (tournament) {
  return Object.assign(summary(tournament), {
    tagline: tournament.tagline || '',
    summary: tournament.summary || '',
    timeZone: tournament.timeZone || null,
    createdAt: tournament.createdAt,
    createdBy: tournament.createdBy || null,
    players: tournament.entrants.map((entrant) => entrant.name),
    entrants: tournament.entrants,
    slots: tournament.slots,
    record: tournament.record,
    log: tournament.log
  });
}

/**
 * Tournament records for goon.vc: anyone creates a tournament (name, format,
 * set length, start time, players), and every game, latecomer, and the final
 * standings are kept. Tournaments with the same name share a series id, so
 * each lives at `/tournaments/<series>/<YYYY-MM-DD>`. Nothing is ever
 * deleted, and a tournament locks once its champion is recorded.
 * Everything lives in one `@fabric/core` {@link Store}.
 */
class Tournaments {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Store directory.
   * @param {string} [settings.basePath] Site path of the tournaments pages (for link previews).
   * @param {Function} [settings.identify] `async (req) => displayName|null` for the change log.
   * @param {Function} [settings.now] Clock, injected for tests.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/tournaments',
      basePath: '/tournaments',
      identify: null,
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.store = null;
    this._queue = Promise.resolve();
  }

  async start () {
    this.store = new Store({
      name: 'GOON.VC:tournaments',
      path: this.settings.path,
      persistent: true,
      verbosity: 1
    });
    await startStore(this.store);
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

  async _index () {
    const list = await this.store.get('/index/tournaments');
    return Array.isArray(list) ? list : [];
  }

  async getTournament (seriesId, slug) {
    if (!SERIES_ID.test(String(seriesId || '')) || !SLUG.test(String(slug || ''))) return null;
    return this.store.get(`/tournament/${seriesId}/${slug}`);
  }

  /**
   * Newest first by start time.
   * @param {string} [seriesId] Only tournaments of this series.
   * @returns {Promise<Array<Object>>}
   */
  async listTournaments (seriesId) {
    const out = [];
    for (const id of await this._index()) {
      const [owner, slug] = id.split('/');
      if (seriesId && owner !== seriesId) continue;
      const tournament = await this.getTournament(owner, slug);
      if (tournament) out.push(summary(tournament));
    }
    return out.sort((x, y) => String(y.startsAt).localeCompare(String(x.startsAt)));
  }

  /**
   * @param {Object} input `{ name, tagline?, summary?, format, bestOf, startsAt, timeZone?, players? }`
   * @param {string} [by] Display name of whoever created it.
   * @returns {Promise<Object>} the tournament record
   */
  createTournament (input, by) {
    return this._exclusive(async () => {
      input = input || {};
      const name = text(input.name, LIMITS.name);
      if (name.length < 2) throw fail(400, 'A tournament needs a name.');
      const when = new Date(input.startsAt);
      const year = when.getUTCFullYear();
      if (isNaN(when.getTime()) || year < 2000 || year > 2100) throw fail(400, 'A tournament needs a start date and time.');
      const timeZone = input.timeZone ? String(input.timeZone).trim() : 'UTC';
      if (!validTimeZone(timeZone)) throw fail(400, `Unknown time zone: ${timeZone}`);
      const players = parsePlayers(input.players || []);
      if (players.length > MAX_PLAYERS) throw fail(400, `The limit is ${MAX_PLAYERS} players.`);
      const ids = await this._index();
      if (ids.length >= MAX_TOURNAMENTS) throw fail(409, 'The tournament archive is full.');

      const seriesId = slugify(name);
      const startsAt = when.toISOString();
      const day = localDate(startsAt, timeZone);
      let slug = day;
      for (let n = 2; ids.includes(`${seriesId}/${slug}`); n++) slug = `${day}-${n}`;

      const now = this._iso();
      const tournament = {
        id: `${seriesId}/${slug}`,
        seriesId,
        slug,
        name,
        tagline: text(input.tagline, LIMITS.tagline),
        summary: text(input.summary, LIMITS.summary),
        format: normalizeFormat(input.format),
        bestOf: normalizeBestOf(input.bestOf),
        timeZone,
        startsAt,
        createdAt: now,
        createdBy: by || null,
        status: 'open',
        entrants: players.map((player) => ({ name: player, joinedAt: now, late: false })),
        slots: drawSlots(players.length),
        record: {},
        results: null,
        log: [this._entry('create', by, { startsAt, players })]
      };
      await this._save(tournament);
      await this.store.set('/index/tournaments', ids.concat(tournament.id));
      return publicTournament(tournament);
    });
  }

  _entry (type, by, fields) {
    return Object.assign({ at: this._iso(), type }, fields, by ? { by } : {});
  }

  async _save (tournament) {
    await this.store.set(`/tournament/${tournament.seriesId}/${tournament.slug}`, tournament);
  }

  _change (seriesId, slug, change) {
    return this._exclusive(async () => {
      const stored = await this.getTournament(seriesId, slug);
      if (!stored) throw fail(404, 'No such tournament.');
      if (stored.status === 'complete') throw fail(409, 'This tournament is final; its results are on record.');
      const tournament = JSON.parse(JSON.stringify(stored));
      change(tournament);
      await this._save(tournament);
      return publicTournament(tournament);
    });
  }

  /**
   * Replace the seeds; only before the first game.
   */
  setPlayers (seriesId, slug, players, by) {
    return this._change(seriesId, slug, (tournament) => {
      if (hasGames(tournament.record)) throw fail(409, 'Games have been scored; add latecomers instead.');
      const list = parsePlayers(Array.isArray(players) ? players : []);
      if (list.length > MAX_PLAYERS) throw fail(400, `The limit is ${MAX_PLAYERS} players.`);
      const now = this._iso();
      const known = Object.fromEntries(tournament.entrants.map((entrant) => [entrant.name.toLowerCase(), entrant]));
      tournament.entrants = list.map((name) => known[name.toLowerCase()] || { name, joinedAt: now, late: false });
      tournament.slots = drawSlots(list.length);
      tournament.record = {};
      tournament.log.push(this._entry('seeds', by, { players: list }));
    });
  }

  /**
   * Add one player. After the first game they are a latecomer and take an
   * open first-round seat ({@link seatLatecomer}).
   */
  addPlayer (seriesId, slug, name, by) {
    return this._change(seriesId, slug, (tournament) => {
      const player = parsePlayers([name])[0];
      if (!player) throw fail(400, 'A player needs a name.');
      if (tournament.entrants.some((entrant) => entrant.name.toLowerCase() === player.toLowerCase())) {
        throw fail(409, `${player} is already in the bracket.`);
      }
      const late = hasGames(tournament.record);
      const seat = seatLatecomer(tournament, tournament.entrants.length + 1);
      if (seat.error) throw fail(409, seat.error);
      tournament.entrants.push({ name: player, joinedAt: this._iso(), late });
      tournament.slots = seat.slots;
      tournament.log.push(this._entry('join', by, { name: player, late }));
    });
  }

  _view (tournament) {
    const bracket = createBracket(tournament.slots, tournament.format);
    return { bracket, view: resolveBracket(bracket, tournament.bestOf, tournament.record) };
  }

  /**
   * Score one game: `{ match, side, players }`, where `players` is the pair
   * the scorer saw, so a stale bracket can't score the wrong set.
   */
  recordGame (seriesId, slug, input, by) {
    return this._change(seriesId, slug, (tournament) => {
      const names = tournament.entrants.map((entrant) => entrant.name);
      const { view } = this._view(tournament);
      const match = view.byId[input && input.match];
      if (!match) throw fail(404, 'No such set.');
      if (match.status !== 'ready' && match.status !== 'live') throw fail(409, 'That set is not open.');
      const side = Number(input.side);
      if (side !== 0 && side !== 1) throw fail(400, 'side must be 0 or 1.');
      const seen = Array.isArray(input.players) ? input.players : null;
      if (seen && (seen[0] !== match.a || seen[1] !== match.b)) throw fail(409, 'The bracket changed; reload and try again.');

      tournament.record[match.id] = { players: [match.a, match.b], games: match.games.concat(side) };
      tournament.log.push(this._entry('game', by, { match: match.id, winner: names[side ? match.b : match.a], players: [names[match.a], names[match.b]] }));

      const after = this._view(tournament);
      const set = after.view.byId[match.id];
      if (set.status === 'done') {
        tournament.log.push(this._entry('set', by, { match: match.id, winner: names[set.winner], loser: names[set.loser], score: set.wins.slice() }));
      }
      const standings = placements(after.bracket, after.view);
      if (standings) {
        const at = this._iso();
        const name = (index) => index === null || index === undefined ? null : names[index];
        tournament.status = 'complete';
        tournament.results = { champion: name(standings.champion), runnerUp: name(standings.runnerUp), third: name(standings.third), completedAt: at };
        tournament.log.push(this._entry('complete', by, { champion: tournament.results.champion }));
      } else {
        tournament.status = 'live';
      }
    });
  }

  /**
   * Take back the last game of a set (logged; the game stays in the log).
   */
  undoGame (seriesId, slug, input, by) {
    return this._change(seriesId, slug, (tournament) => {
      const names = tournament.entrants.map((entrant) => entrant.name);
      const { view } = this._view(tournament);
      const match = view.byId[input && input.match];
      if (!match || !match.games.length) throw fail(409, 'That set has no games to undo.');
      const last = match.games[match.games.length - 1];
      tournament.record[match.id] = { players: [match.a, match.b], games: match.games.slice(0, -1) };
      tournament.log.push(this._entry('undo', by, { match: match.id, winner: names[last ? match.b : match.a] }));
      tournament.status = hasGames(tournament.record) ? 'live' : 'open';
    });
  }

  /**
   * Link-preview metadata for a series or tournament page, or null.
   * @param {string} pathname
   * @returns {Promise<{ path: string, title: string, description: string }|null>}
   */
  async page (pathname) {
    const base = String(this.settings.basePath).replace(/\/+$/, '').toLowerCase();
    const clean = String(pathname || '').replace(/\/+$/, '');
    if (clean.toLowerCase().indexOf(base + '/') !== 0) return null;
    const parts = clean.slice(base.length + 1).split('/');
    let seriesId;
    let slug;
    try {
      seriesId = decodeURIComponent(parts[0] || '').toLowerCase();
      slug = parts[1] === undefined ? null : decodeURIComponent(parts[1]);
    } catch (_) {
      return null;
    }
    if (parts.length > 2) return null;
    if (slug === null) {
      const list = await this.listTournaments(seriesId);
      if (!list.length) return null;
      const champion = list.find((entry) => entry.results && entry.results.champion);
      const count = `${list.length} tournament${list.length === 1 ? '' : 's'} on record.`;
      return { path: clean, title: list[0].name, description: champion ? `${count} Latest champion: ${champion.results.champion}.` : count };
    }
    const tournament = await this.getTournament(seriesId, slug);
    if (!tournament) return null;
    const when = displayDate(tournament.startsAt, tournament.timeZone);
    const players = `${tournament.entrants.length} player${tournament.entrants.length === 1 ? '' : 's'}`;
    const results = tournament.results;
    const description = results
      ? `${when}. Champion: ${results.champion}${results.runnerUp ? `; runner-up: ${results.runnerUp}` : ''}. ${players}.`
      : `${when}. ${players} so far.`;
    return { path: clean, title: `${tournament.name} — ${localDate(tournament.startsAt, tournament.timeZone)}`, description };
  }

  /**
   * Express middleware for `/services/tournaments/*`.
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
        const [seriesId, slug, action] = parts;
        if (!parts.length) {
          if (method === 'GET') return [200, { tournaments: await this.listTournaments() }];
          if (method === 'POST') return [201, await this.createTournament(body, by)];
        } else if (parts.length === 1) {
          if (method === 'GET') {
            const tournaments = await this.listTournaments(seriesId);
            if (!tournaments.length) throw fail(404, 'No such tournament.');
            return [200, { tournaments }];
          }
        } else if (parts.length === 2) {
          if (method === 'GET') {
            const tournament = await this.getTournament(seriesId, slug);
            if (!tournament) throw fail(404, 'No such tournament.');
            return [200, publicTournament(tournament)];
          }
        } else if (parts.length === 3) {
          if (action === 'players' && method === 'PUT') return [200, await this.setPlayers(seriesId, slug, body.players, by)];
          if (action === 'players' && method === 'POST') return [200, await this.addPlayer(seriesId, slug, body.name, by)];
          if (action === 'games' && method === 'POST') return [200, await this.recordGame(seriesId, slug, body, by)];
          if (action === 'undo' && method === 'POST') return [200, await this.undoGame(seriesId, slug, body, by)];
        }
        throw fail(parts.length > 3 ? 404 : 405, parts.length > 3 ? 'Not found' : 'Method not allowed');
      }).then(([status, payload]) => sendJson(res, status, payload), (error) => {
        if (res.headersSent) return;
        sendJson(res, error && error.status ? error.status : 500, { error: error && error.message ? error.message : 'Tournament request failed' });
      });
    };
  }
}

module.exports = Tournaments;
module.exports.localDate = localDate;
module.exports.displayDate = displayDate;
