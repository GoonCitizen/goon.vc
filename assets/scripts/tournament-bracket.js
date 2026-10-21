'use strict';

/**
 * <tournament-bracket> — self-contained tournament bracket.
 *
 * Seed the players, score each game, and winners advance on their own.
 * Single elimination, or double elimination with a grand-final reset; every
 * set is best of n.
 *
 * Attributes:
 *   heading        tournament name (default "Tournament")
 *   eyebrow        line above the title (default: the format and set length,
 *                  e.g. "DOUBLE ELIMINATION // BEST OF 3")
 *   description    intro paragraph (plain text)
 *   format         `single-elimination` (default) or `double-elimination`
 *   best-of        games per set: odd, 1–9 (default 1; even values round up)
 *   players        starting seeds, comma separated, best seed first
 *   storage-key    localStorage key for the bracket (default `tournament-bracket`;
 *                  `none` disables saving)
 *   src            URL of a saved tournament record; the bracket loads and
 *                  saves there instead of localStorage (see below)
 *   fonts          `none` skips loading Orbitron / Rajdhani / Share Tech Mono
 *
 * With `src`, the record is `GET src` →
 * `{ name, format, bestOf, players, slots, record, status, locked, startsAt, results }`
 * (`locked` once it has had a champion: the padlock in the top right asks
 * for the password, `POST src/unlock { password }`, and edits then carry it
 * in an `X-Tournament-Password` header, kept in memory only), and every
 * change answers with that record:
 * `PUT src/players { players }` (seeds, before the first game),
 * `POST src/players { name }` (a player or latecomer),
 * `POST src/games { match, side, players }`,
 * `POST src/forfeits { match, side, players }` (`side` dropped out: a DQ),
 * `POST src/undo { match }` (the last game, or the DQ).
 *
 * Emits `bracketchange` with `detail: { players, format, bestOf, slots, record }`,
 * `matchcomplete` with `detail: { match, winner, loser, score, forfeit }`, and
 * `complete` with `detail: { champion }`.
 *
 * In Node the bracket engine is exported (no element is defined).
 */
(function (root) {
  const SINGLE = 'single-elimination';
  const DOUBLE = 'double-elimination';
  const MAX_PLAYERS = 64;
  const MAX_BEST_OF = 9;
  const NAME_LENGTH = 24;
  const DEFAULT_STORAGE_KEY = 'tournament-bracket';
  const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap';

  /* ---------- engine ---------- */

  function normalizeFormat (value) {
    const v = String(value || '').trim().toLowerCase();
    return v === DOUBLE || v === 'double' ? DOUBLE : SINGLE;
  }

  function normalizeBestOf (value) {
    const n = Math.floor(Number(value));
    if (!(n >= 1)) return 1;
    return Math.min(n % 2 === 0 ? n + 1 : n, MAX_BEST_OF);
  }

  function formatLabel (format, bestOf) {
    const name = normalizeFormat(format) === DOUBLE ? 'Double elimination' : 'Single elimination';
    return `${name} · Best of ${normalizeBestOf(bestOf)}`;
  }

  function parsePlayers (value) {
    const list = Array.isArray(value) ? value : String(value || '').split(/[,\n;]+/);
    const seen = {};
    const out = [];
    list.forEach((raw) => {
      const name = String(raw).trim().replace(/\s+/g, ' ').slice(0, NAME_LENGTH);
      const key = name.toLowerCase();
      if (name && !seen[key]) { seen[key] = 1; out.push(name); }
    });
    return out;
  }

  /**
   * Standard seed order: 1v16, 8v9, 5v12, … so top seeds meet last.
   * @param {number} size power of two
   * @returns {number[]} zero-based seeds, paired in order
   */
  function seedOrder (size) {
    let order = [0];
    while (order.length < size) {
      const next = order.length * 2;
      order = order.reduce((out, seed) => out.concat([seed, next - 1 - seed]), []);
    }
    return order;
  }

  function bracketSize (count) {
    let size = 2;
    while (size < count) size *= 2;
    return size;
  }

  /**
   * First-round seats for a fresh draw: seat `p` holds a player index, or
   * `null` for a bye. Byes go to the top seeds.
   * @param {number} count
   * @returns {Array<number|null>}
   */
  function drawSlots (count) {
    return seedOrder(bracketSize(count)).map((seed) => seed < count ? seed : null);
  }

  /**
   * Match graph over first-round seats. Sources are `{ slot }`, `{ winner: id }`,
   * or `{ loser: id }`; matches are listed so every source comes first.
   * @param {Array<number|null>|number} slots seats from {@link drawSlots}, or a player count
   * @param {string} format
   * @returns {{ format: string, count: number, size: number, rounds: number, slots: Array<number|null>, matches: Object[] }}
   */
  function createBracket (slots, format) {
    format = normalizeFormat(format);
    if (!Array.isArray(slots)) slots = drawSlots(slots);
    const count = slots.filter((seat) => seat !== null && seat !== undefined).length;
    const size = slots.length;
    const rounds = Math.log2(size);
    const matches = [];
    const match = (bracket, round, index, sources, extra) => {
      const m = Object.assign({ id: `${bracket}${round}-${index + 1}`, bracket, round, index, sources }, extra);
      matches.push(m);
      return m;
    };

    const winners = [];
    for (let r = 1; r <= rounds; r++) {
      const list = [];
      for (let i = 0; i < size / Math.pow(2, r); i++) {
        list.push(match('W', r, i, r === 1
          ? [{ slot: 2 * i }, { slot: 2 * i + 1 }]
          : [{ winner: winners[r - 2][2 * i].id }, { winner: winners[r - 2][2 * i + 1].id }]));
      }
      winners.push(list);
    }
    const final = winners[rounds - 1][0];
    const base = { format, count, size, rounds, slots: slots.slice(), matches };
    if (format === SINGLE) return Object.assign(base, { final: final.id });

    const losers = [];
    if (rounds > 1) {
      let list = [];
      for (let i = 0; i < size / 4; i++) {
        list.push(match('L', 1, i, [{ loser: winners[0][2 * i].id }, { loser: winners[0][2 * i + 1].id }]));
      }
      losers.push(list);
      for (let k = 1; k < rounds; k++) {
        const drops = winners[k];
        // Alternate the drop-in order so first-round opponents don't meet again right away.
        list = losers[losers.length - 1].map((m, i) => match('L', losers.length + 1, i, [
          { winner: m.id },
          { loser: drops[k % 2 ? drops.length - 1 - i : i].id }
        ]));
        losers.push(list);
        if (k < rounds - 1) {
          const prev = list;
          list = [];
          for (let i = 0; i < prev.length / 2; i++) {
            list.push(match('L', losers.length + 1, i, [{ winner: prev[2 * i].id }, { winner: prev[2 * i + 1].id }]));
          }
          losers.push(list);
        }
      }
    }
    const lowerChampion = losers.length ? { winner: losers[losers.length - 1][0].id } : { loser: final.id };
    const grand = match('F', 1, 0, [{ winner: final.id }, lowerChampion]);
    const reset = match('F', 2, 0, [], { resetOf: grand.id });
    return Object.assign(base, { final: final.id, grandFinal: grand.id, reset: reset.id });
  }

  /**
   * Play the record forward through the bracket.
   *
   * Statuses: `pending` (waiting on a feeder), `ready`, `live`, `done`,
   * `bye` (one side empty), `void` (both empty), `skipped` (unneeded reset).
   * A saved set only counts while it still has the same two players, so
   * undoing an earlier result sets later ones aside instead of losing them.
   * A set with a `forfeit` side is `done` with no wins (a DQ): the other
   * side advances, and the games it holds are kept but not counted.
   *
   * @param {Object} bracket from {@link createBracket}
   * @param {number} bestOf
   * @param {Object<string, { players: number[], games: number[], forfeit: (number|undefined) }>} [record]
   *   per match: the two players (seed indexes), the winning side of each
   *   game, and the side that dropped out, if one did
   * @returns {{ matches: Object[], byId: Object<string, Object>, champion: (number|null|undefined), need: number }}
   */
  function resolveBracket (bracket, bestOf, record) {
    const need = (normalizeBestOf(bestOf) + 1) / 2;
    const saved = record || {};
    const byId = {};
    const value = (source) => {
      if (Object.prototype.hasOwnProperty.call(source, 'slot')) {
        const seat = bracket.slots[source.slot];
        return seat === undefined ? null : seat;
      }
      const feeder = byId[source.winner || source.loser];
      if (!feeder || feeder.winner === undefined) return undefined;
      return source.winner ? feeder.winner : feeder.loser;
    };

    const matches = bracket.matches.map((m) => {
      const s = { id: m.id, bracket: m.bracket, round: m.round, index: m.index, sources: m.sources, a: undefined, b: undefined, games: [], wins: [0, 0], winner: undefined, loser: undefined, forfeit: null, status: 'pending' };
      byId[m.id] = s;
      if (m.resetOf) {
        const grand = byId[m.resetOf];
        if (grand.status !== 'done') return s;
        if (grand.winner === grand.a) { s.status = 'skipped'; return s; }
        s.a = grand.a;
        s.b = grand.b;
      } else {
        s.a = value(m.sources[0]);
        s.b = value(m.sources[1]);
      }
      if (s.a === undefined || s.b === undefined) return s;
      if (s.a === null && s.b === null) {
        Object.assign(s, { status: 'void', winner: null, loser: null });
        return s;
      }
      if (s.a === null || s.b === null) {
        Object.assign(s, { status: 'bye', winner: s.a === null ? s.b : s.a, loser: null });
        return s;
      }
      const entry = saved[m.id];
      const same = entry && Array.isArray(entry.players) && entry.players[0] === s.a && entry.players[1] === s.b;
      if (same && isForfeit(entry.forfeit)) {
        const dropped = entry.forfeit;
        Object.assign(s, { status: 'done', forfeit: dropped, winner: dropped ? s.a : s.b, loser: dropped ? s.b : s.a });
        return s;
      }
      if (same && Array.isArray(entry.games)) {
        for (const side of entry.games) {
          if (s.wins[0] >= need || s.wins[1] >= need) break;
          if (side !== 0 && side !== 1) continue;
          s.wins[side]++;
          s.games.push(side);
        }
      }
      if (s.wins[0] >= need || s.wins[1] >= need) {
        const side = s.wins[0] >= need ? 0 : 1;
        Object.assign(s, { status: 'done', winner: side ? s.b : s.a, loser: side ? s.a : s.b });
      } else {
        s.status = s.games.length ? 'live' : 'ready';
      }
      return s;
    });

    let champion;
    if (bracket.format === SINGLE) {
      champion = byId[bracket.final].winner;
    } else {
      const reset = byId[bracket.reset];
      if (reset.status === 'skipped') champion = byId[bracket.grandFinal].winner;
      else if (reset.status === 'done') champion = reset.winner;
    }
    return { matches, byId, champion, need };
  }

  function isForfeit (side) {
    return side === 0 || side === 1;
  }

  /**
   * @param {Object} [record]
   * @returns {boolean} whether any game or DQ has been scored
   */
  function hasGames (record) {
    return Object.keys(record || {}).some((id) => {
      const entry = record[id];
      return entry && ((Array.isArray(entry.games) && entry.games.length > 0) || isForfeit(entry.forfeit));
    });
  }

  function keepsResults (before, after) {
    return before.matches.every((m) => {
      if (!m.games.length && m.forfeit === null) return true;
      const next = after.byId[m.id];
      return next && next.a === m.a && next.b === m.b && next.games.length === m.games.length && next.forfeit === m.forfeit;
    });
  }

  /**
   * Seat a latecomer (player index `count - 1`) on the bracket's lowest level.
   *
   * Before any game is scored the field is simply redrawn. After that, the
   * latecomer takes a first-round bye, which becomes a real set: they play the
   * same number of sets to reach the final as everyone else. A bye is only
   * open while nothing already scored depends on it.
   *
   * @param {{ slots: Array<number|null>, format: string, bestOf: number, record: Object }} state
   * @param {number} count players including the latecomer
   * @returns {{ slots: Array<number|null>, redrawn?: boolean, error?: string }}
   */
  function seatLatecomer (state, count) {
    if (count > MAX_PLAYERS) return { error: `The limit is ${MAX_PLAYERS} players.` };
    if (!hasGames(state.record)) return { slots: drawSlots(count), redrawn: true };
    const slots = state.slots;
    const before = resolveBracket(createBracket(slots, state.format), state.bestOf, state.record);
    const rank = seedOrder(slots.length);
    const open = slots
      .map((seat, position) => position)
      .filter((position) => slots[position] === null && slots[position ^ 1] !== null)
      .sort((x, y) => rank[x] - rank[y]);
    if (!open.length) {
      return { error: `The bracket is full (${slots.length} seats). A latecomer would have to skip a round or make someone fight an extra set.` };
    }
    for (const position of open) {
      const trial = slots.slice();
      trial[position] = count - 1;
      const after = resolveBracket(createBracket(trial, state.format), state.bestOf, state.record);
      if (keepsResults(before, after)) return { slots: trial };
    }
    return { error: 'No open first-round seat: every player with a bye has already played their next set.' };
  }

  /**
   * Final standings once the bracket has a champion.
   * @param {Object} bracket
   * @param {Object} view from {@link resolveBracket}
   * @returns {{ champion: number, runnerUp: (number|null), third: (number|null) }|null}
   */
  function placements (bracket, view) {
    if (view.champion === undefined || view.champion === null) return null;
    const other = (m) => m && m.status === 'done' ? (m.winner === m.a ? m.b : m.a) : null;
    if (bracket.format === SINGLE) {
      return { champion: view.champion, runnerUp: other(view.byId[bracket.final]), third: null };
    }
    const reset = view.byId[bracket.reset];
    const decider = reset.status === 'done' ? reset : view.byId[bracket.grandFinal];
    const lowerFinal = view.matches.filter((m) => m.bracket === 'L').pop();
    return {
      champion: view.champion,
      runnerUp: other(decider),
      third: lowerFinal && lowerFinal.status === 'done' ? lowerFinal.loser : null
    };
  }

  /**
   * @param {Object} bracket
   * @param {{ bracket: string, round: number }} match
   * @returns {string}
   */
  function roundName (bracket, match) {
    if (match.bracket === 'F') return match.round === 1 ? 'Grand Final' : 'Grand Final Reset';
    if (match.bracket === 'L') {
      const last = bracket.matches.reduce((max, m) => m.bracket === 'L' ? Math.max(max, m.round) : max, 0);
      return match.round === last ? 'Losers Final' : `Losers Round ${match.round}`;
    }
    const fromEnd = bracket.rounds - match.round;
    const prefix = bracket.format === DOUBLE ? 'Winners ' : '';
    if (fromEnd === 0) return `${prefix}Final`;
    if (fromEnd === 1) return `${prefix}Semifinals`;
    if (fromEnd === 2 && bracket.format === SINGLE) return 'Quarterfinals';
    return `${prefix}Round ${match.round}`;
  }

  const engine = {
    SINGLE,
    DOUBLE,
    MAX_PLAYERS,
    normalizeFormat,
    normalizeBestOf,
    formatLabel,
    parsePlayers,
    seedOrder,
    drawSlots,
    createBracket,
    resolveBracket,
    isForfeit,
    hasGames,
    seatLatecomer,
    placements,
    roundName
  };

  if (typeof module === 'object' && module && module.exports) module.exports = engine;
  if (root && !root.tournamentBracket) root.tournamentBracket = engine;
  if (!root || typeof root.HTMLElement !== 'function' || !root.customElements) return;
  if (root.customElements.get('tournament-bracket')) return;

  /* ---------- element ---------- */

  const STYLE = `
:host{
  color-scheme:dark;
  --ground:#04070a;--panel:#0a1016;--rail:#0e1720;--edge:#1b2c38;
  --cyan:#27e0ef;--amber:#ffb02e;--hostile:#ff4756;--clear:#3ddc97;
  --text:#c2d4dc;--bright:#eaf6f9;--dim:#6d838e;--faint:#3d525d;
  --display:'Orbitron',"Trebuchet MS",sans-serif;
  --body:'Rajdhani',"Segoe UI",sans-serif;
  --mono:'Share Tech Mono',ui-monospace,"Courier New",monospace;
  display:block;background:var(--ground);color:var(--text);font-family:var(--body);font-size:17px;line-height:1.5;text-align:left;
  font-variant-numeric:tabular-nums;
  background-image:linear-gradient(rgba(39,224,239,.026) 1px,transparent 1px),linear-gradient(90deg,rgba(39,224,239,.026) 1px,transparent 1px);
  background-size:52px 52px}
*{box-sizing:border-box}
.wrap{max-width:1180px;margin:0 auto;padding-inline:clamp(16px,3vw,28px);padding-block:28px 72px;display:grid;gap:22px}
.hdr{display:grid;gap:10px;position:relative}
.hdr.has-lock{padding-right:56px}
.lock{position:absolute;top:0;right:0;width:44px;height:44px;display:inline-flex;align-items:center;justify-content:center;background:var(--panel);border:1px solid var(--edge);color:var(--dim);cursor:pointer}
.lock:hover{color:var(--bright);border-color:var(--cyan)}
.lock.open{color:var(--amber);border-color:var(--amber)}
.unlock{border:1px solid var(--edge);background:var(--panel);padding:12px 14px;display:grid;gap:8px}
.unlock p{margin:0;color:var(--dim);font-size:16px}
.unlock input{flex:1 1 12em;min-height:44px;background:var(--ground);border:1px solid var(--edge);color:var(--bright);font-family:var(--mono);font-size:15px;padding:0 14px}
.unlock input:focus{outline:none;border-color:var(--cyan)}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.22em;color:var(--cyan);text-transform:uppercase;margin:0}
h1{font-family:var(--display);font-weight:900;font-size:clamp(25px,4.2vw,40px);letter-spacing:.03em;line-height:1.08;margin:0;color:var(--bright);text-wrap:balance}
.sub{color:var(--dim);max-width:68ch;margin:0;font-size:18px}
.sub:empty{display:none}
.meta{font-family:var(--mono);font-size:13.5px;letter-spacing:.06em;color:var(--text);margin:0}
.meta:empty{display:none}
[hidden]{display:none !important}
.setup input[type=text]{flex:1 1 14em;min-height:44px;background:var(--ground);border:1px solid var(--edge);color:var(--bright);font-family:var(--mono);font-size:15px;letter-spacing:.04em;padding:0 14px}
.setup input[type=text]:focus{outline:none;border-color:var(--cyan)}
.status{display:flex;gap:12px;align-items:baseline;border:1px solid var(--edge);background:var(--panel);padding:10px 14px;font-family:var(--mono);font-size:13.5px;min-height:44px}
.status .tag{color:var(--amber);letter-spacing:.18em;font-size:11px;flex:none}
.status.won{border-color:var(--clear)}
.status.won .tag,.status.won .msg{color:var(--clear)}
.section{display:grid;gap:10px}
.section h2{font-family:var(--display);font-weight:700;font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:var(--cyan);margin:0}
.rounds{display:flex;gap:18px;overflow-x:auto;padding-bottom:6px}
.round{display:grid;grid-template-rows:auto 1fr;gap:8px;flex:0 0 220px}
.sets{display:flex;flex-direction:column;justify-content:space-around;gap:12px}
.round h3{font-family:var(--mono);font-weight:400;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin:0}
.match{border:1px solid var(--edge);background:var(--panel);display:grid}
.match.live{border-color:var(--amber)}
.match.done{border-color:var(--faint)}
.match.bye{opacity:.55}
.mhead{display:flex;align-items:center;gap:8px;padding:4px 8px;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint)}
.mhead .state{margin-left:auto}
.match.live .mhead .state{color:var(--amber)}
.match.ready .mhead .state{color:var(--cyan)}
.undo{font:inherit;letter-spacing:inherit;text-transform:inherit;color:var(--dim);background:none;border:1px solid var(--edge);padding:0 6px;cursor:pointer}
.undo:hover{color:var(--bright);border-color:var(--cyan)}
.dq:hover{color:var(--hostile);border-color:var(--hostile)}
.match.picking{border-color:var(--hostile)}
.match.picking .mhead .state{color:var(--hostile)}
.side[data-forfeit]{cursor:pointer}
.side[data-forfeit]:hover{background:rgba(255,71,86,.12)}
.side[data-forfeit]:hover .name{color:var(--hostile)}
.side.dq .score{color:var(--hostile);font-size:12px;letter-spacing:.1em}
.side{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:8px;padding:7px 8px;border-top:1px solid var(--edge);background:var(--rail);min-width:0}
.side[data-play]{cursor:pointer}
.side[data-play]:hover{background:rgba(39,224,239,.08)}
.side:focus-visible{outline:2px solid var(--cyan);outline-offset:-2px}
.side .seed{font-family:var(--mono);font-size:11px;color:var(--faint);width:2.2em;flex:none}
.side .name{font-family:var(--mono);font-size:14.5px;color:var(--bright);letter-spacing:.04em;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side .score{margin-left:auto;font-family:var(--mono);font-size:15px;color:var(--text);flex:none}
.side.tbd .name,.side.empty .name{color:var(--dim)}
.side.win .name,.side.win .score{color:var(--clear)}
.side.lose .name{color:var(--dim);text-decoration:line-through}
.empty-board{color:var(--dim);margin:0}
.setup{border:1px solid var(--edge);background:var(--panel);padding:18px;display:grid;gap:10px}
.setup h2{font-family:var(--display);font-weight:700;font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:var(--cyan);margin:0}
.setup p{margin:0;color:var(--dim);font-size:16px;max-width:72ch}
.setup textarea{width:100%;min-height:8em;background:var(--ground);border:1px solid var(--edge);color:var(--bright);font-family:var(--mono);font-size:15px;letter-spacing:.04em;padding:10px 14px;resize:vertical}
.setup textarea:focus,.setup select:focus{outline:none;border-color:var(--cyan)}
.row{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center}
.row label{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--dim);display:inline-flex;align-items:center;gap:8px}
select{background:var(--ground);border:1px solid var(--edge);color:var(--bright);font-family:var(--mono);font-size:14px;min-height:40px;padding:0 10px}
.btn{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.14em;text-transform:uppercase;padding:0 18px;min-height:46px;border:1px solid var(--edge);background:var(--rail);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;gap:10px}
.btn:hover{border-color:var(--cyan);color:var(--bright)}
.btn-primary{background:var(--cyan);border-color:var(--cyan);color:#021216}
.btn-primary:hover{color:#021216;filter:brightness(1.1)}
.err{color:var(--hostile);font-family:var(--mono);font-size:13px;min-height:1.2em}
.err.ok{color:var(--clear)}
:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}
@media(max-width:560px){
  :host{font-size:16px}
  .round{flex-basis:190px}
  .btn{flex:1 1 auto;justify-content:center}
}`;

  const TEMPLATE = `
<div class="wrap">
  <header class="hdr" id="hdr">
    <p class="eyebrow" id="eyebrow"></p>
    <h1 id="heading">Tournament</h1>
    <p class="sub" id="description"></p>
    <p class="meta" id="meta"></p>
    <button class="lock" id="lock" type="button" hidden></button>
  </header>
  <form class="unlock" id="unlock" hidden>
    <p>This tournament is final. Enter the password to edit its results.</p>
    <div class="row">
      <input type="password" id="password" autocomplete="current-password" aria-label="Password">
      <button class="btn btn-primary" type="submit">Unlock</button>
      <button class="btn" type="button" id="unlockCancel">Cancel</button>
    </div>
    <p class="err" id="unlockErr" role="alert"></p>
  </form>
  <div class="status" id="status" role="status" aria-live="polite"><span class="tag" id="statusTag">BRACKET</span><span class="msg" id="statusMsg"></span></div>
  <div id="board"></div>
  <form class="setup" id="late" hidden>
    <h2>Latecomers</h2>
    <p>A latecomer takes an open first-round seat (a bye), so they play the same number of sets to reach the final as everyone else.</p>
    <div class="row">
      <input type="text" id="lateName" maxlength="${NAME_LENGTH}" autocomplete="off" spellcheck="false" aria-label="Latecomer name" placeholder="Name">
      <button class="btn" type="submit">Add latecomer</button>
    </div>
    <p class="err" id="lateErr" role="alert"></p>
  </form>
  <form class="setup" id="setup">
    <h2>Seeds</h2>
    <p>One name per line or comma separated, best seed first. When the field isn’t a power of two, the top seeds get byes. Tap a player in a set to score a game for them; if a player drops out, use the set’s DQ button and tap them: the set ends with no wins and their opponent advances.</p>
    <textarea id="players" spellcheck="false" autocomplete="off" aria-label="Players, best seed first" placeholder="VIPER&#10;KESTREL&#10;NOMAD&#10;RONIN"></textarea>
    <div class="row" id="formatRow">
      <label>Format <select id="format">
        <option value="${SINGLE}">Single elimination</option>
        <option value="${DOUBLE}">Double elimination</option>
      </select></label>
      <label>Sets <select id="bestOf">
        <option value="1">Best of 1</option>
        <option value="3">Best of 3</option>
        <option value="5">Best of 5</option>
        <option value="7">Best of 7</option>
        <option value="9">Best of 9</option>
      </select></label>
    </div>
    <div class="row">
      <button class="btn btn-primary" type="submit" id="drawBtn">Draw bracket</button>
      <button class="btn" type="button" id="shuffle">Shuffle seeds</button>
    </div>
    <p class="err" id="err" role="alert"></p>
  </form>
</div>`;

  const PADLOCK = (open) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="11" width="14" height="10" rx="1.5"/><path d="${open ? 'M8 11V7a4 4 0 0 1 7.6-1.7' : 'M8 11V7a4 4 0 0 1 8 0v4'}"/></svg>`;

  function loadFonts (doc) {
    if (!doc || !doc.head || doc.querySelector('link[data-tournament-bracket-fonts]')) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONTS_HREF;
    link.setAttribute('data-tournament-bracket-fonts', '');
    doc.head.appendChild(link);
  }

  function esc (s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function formatWhen (iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    try {
      return date.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
    } catch (e) {
      return date.toString();
    }
  }

  class TournamentBracket extends root.HTMLElement {
    constructor () {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style>${STYLE}</style>${TEMPLATE}`;
      this._state = null;
      this._view = null;
      this._bracket = null;
      this._src = null;
      this._busy = false;
      this._poll = null;
      this._picking = null;
      this._password = null;
    }

    connectedCallback () {
      if (this.getAttribute('fonts') !== 'none') loadFonts(this.ownerDocument);
      const $ = (id) => this.shadowRoot.getElementById(id);
      $('heading').textContent = this.getAttribute('heading') || 'Tournament';
      $('description').textContent = this.getAttribute('description') || '';
      if (this._state) return this._startPolling();

      this._src = (this.getAttribute('src') || '').replace(/\/+$/, '') || null;
      const storage = this.getAttribute('storage-key');
      this._storageKey = this._src || storage === 'none' ? null : (storage || DEFAULT_STORAGE_KEY);
      const players = parsePlayers(this.getAttribute('players')).slice(0, MAX_PLAYERS);
      this._state = this._load() || {
        players,
        format: normalizeFormat(this.getAttribute('format')),
        bestOf: normalizeBestOf(this.getAttribute('best-of')),
        slots: drawSlots(players.length),
        record: {}
      };
      $('players').value = this._state.players.join('\n');
      $('format').value = this._state.format;
      $('bestOf').value = String(this._state.bestOf);
      if (this._src) {
        $('formatRow').hidden = true;
        $('shuffle').hidden = true;
        $('drawBtn').textContent = 'Save seeds';
        $('players').disabled = true;
      }

      $('setup').addEventListener('submit', (event) => { event.preventDefault(); this._draw(); });
      $('late').addEventListener('submit', (event) => { event.preventDefault(); this._addLatecomer(); });
      $('lock').addEventListener('click', () => {
        if (this._password) {
          this._password = null;
          this._picking = null;
          this._render();
          return;
        }
        $('unlock').hidden = !$('unlock').hidden;
        if (!$('unlock').hidden) $('password').focus();
      });
      $('unlockCancel').addEventListener('click', () => {
        $('unlock').hidden = true;
        $('password').value = '';
        $('lock').focus();
      });
      $('unlock').addEventListener('submit', (event) => { event.preventDefault(); this._unlock(); });
      $('shuffle').addEventListener('click', () => {
        const list = parsePlayers($('players').value);
        for (let i = list.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [list[i], list[j]] = [list[j], list[i]];
        }
        $('players').value = list.join('\n');
      });
      $('board').addEventListener('click', (event) => {
        const target = event.target.closest('[data-play],[data-forfeit],[data-undo],[data-dq]');
        if (!target) return;
        if (target.hasAttribute('data-undo')) this._undo(target.getAttribute('data-undo'));
        else if (target.hasAttribute('data-dq')) this._pick(target.getAttribute('data-dq'));
        else if (target.hasAttribute('data-forfeit')) this._forfeit(target.getAttribute('data-forfeit'), Number(target.getAttribute('data-side')));
        else this._play(target.getAttribute('data-play'), Number(target.getAttribute('data-side')));
      });
      $('board').addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && this._picking) {
          const id = this._picking;
          this._pick(id);
          const button = this.shadowRoot.querySelector(`[data-dq="${id}"]`);
          if (button) button.focus();
          return;
        }
        const target = event.target.closest('[data-play],[data-forfeit]');
        if (!target || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        if (target.hasAttribute('data-forfeit')) return this._forfeit(target.getAttribute('data-forfeit'), Number(target.getAttribute('data-side')));
        const id = target.getAttribute('data-play');
        const side = target.getAttribute('data-side');
        Promise.resolve(this._play(id, Number(side))).then(() => {
          const again = this.shadowRoot.querySelector(`[data-play="${id}"][data-side="${side}"]`);
          if (again) again.focus();
        });
      });
      this._render();
      if (this._src) {
        this._fetchRecord().catch(() => {});
        this._startPolling();
      }
    }

    disconnectedCallback () {
      if (this._poll) root.clearInterval(this._poll);
      this._poll = null;
    }

    _startPolling () {
      if (!this._src || this._poll) return;
      this._poll = root.setInterval(() => {
        if (this._busy || this._locked || root.document.visibilityState === 'hidden') return;
        this._fetchRecord(true).catch(() => {});
      }, 15000);
    }

    get _locked () {
      return !!(this._state && this._state.locked && !this._password);
    }

    _load () {
      if (!this._storageKey) return null;
      try {
        const saved = JSON.parse(root.localStorage.getItem(this._storageKey) || 'null');
        if (!saved || !Array.isArray(saved.players)) return null;
        const players = parsePlayers(saved.players).slice(0, MAX_PLAYERS);
        const slots = Array.isArray(saved.slots) && saved.slots.filter((seat) => seat !== null).length === players.length
          ? saved.slots
          : drawSlots(players.length);
        return {
          players,
          format: normalizeFormat(saved.format),
          bestOf: normalizeBestOf(saved.bestOf),
          slots,
          record: saved.record && typeof saved.record === 'object' ? saved.record : {}
        };
      } catch (e) {
        return null;
      }
    }

    _save () {
      if (!this._storageKey) return;
      try { root.localStorage.setItem(this._storageKey, JSON.stringify(this._state)); } catch (e) { /* private mode */ }
    }

    _adopt (saved) {
      const players = Array.isArray(saved.players) ? saved.players.map(String) : [];
      this._state = {
        name: saved.name || null,
        players,
        format: normalizeFormat(saved.format),
        bestOf: normalizeBestOf(saved.bestOf),
        slots: Array.isArray(saved.slots) ? saved.slots : drawSlots(players.length),
        record: saved.record && typeof saved.record === 'object' ? saved.record : {},
        status: saved.status || 'open',
        locked: saved.locked === true || saved.status === 'complete',
        startsAt: saved.startsAt || null,
        results: saved.results || null
      };
      const textarea = this.shadowRoot.getElementById('players');
      if (this.shadowRoot.activeElement !== textarea) textarea.value = players.join('\n');
      textarea.disabled = false;
    }

    async _request (method, path, body) {
      const res = await root.fetch(this._src + path, {
        method,
        headers: Object.assign(
          { Accept: 'application/json' },
          body ? { 'Content-Type': 'application/json' } : {},
          this._password && method !== 'GET' ? { 'X-Tournament-Password': this._password } : {}
        ),
        body: body ? JSON.stringify(body) : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      if (!res.ok) {
        const error = new Error((data && data.error) || `Request failed (${res.status})`);
        error.status = res.status;
        throw error;
      }
      return data;
    }

    async _fetchRecord (quiet) {
      try {
        const saved = await this._request('GET', '');
        if (quiet && JSON.stringify(saved) === this._lastRecord) return;
        this._lastRecord = JSON.stringify(saved);
        this._adopt(saved);
        this._render();
      } catch (error) {
        if (!quiet) this._setStatus('ERROR', `Couldn’t load this tournament: ${error.message}`);
        throw error;
      }
    }

    async _send (method, path, body, noteId) {
      if (this._busy) return null;
      this._busy = true;
      try {
        const saved = await this._request(method, path, body);
        this._lastRecord = JSON.stringify(saved);
        this._adopt(saved);
        this._render();
        this._emit('bracketchange', JSON.parse(JSON.stringify(this._state)));
        return saved;
      } catch (error) {
        if (error.status === 401) {
          this._password = null;
          this._render();
          const $ = (id) => this.shadowRoot.getElementById(id);
          $('unlock').hidden = false;
          this._note(error.message, false, 'unlockErr');
          $('password').focus();
          return null;
        }
        this._note(error.message, false, noteId);
        if (error.status === 409) await this._fetchRecord(true).catch(() => {});
        return null;
      } finally {
        this._busy = false;
      }
    }

    async _unlock () {
      const $ = (id) => this.shadowRoot.getElementById(id);
      const password = $('password').value;
      if (!password) return this._note('Enter the password.', false, 'unlockErr');
      try {
        this._adopt(await this._request('POST', '/unlock', { password }));
      } catch (error) {
        return this._note(error.message, false, 'unlockErr');
      }
      this._password = password;
      $('password').value = '';
      $('unlock').hidden = true;
      this._note('', true, 'unlockErr');
      this._render();
    }

    _emit (type, detail) {
      this.dispatchEvent(new root.CustomEvent(type, { bubbles: true, composed: true, detail }));
    }

    _note (message, ok, id) {
      const el = this.shadowRoot.getElementById(id || 'err');
      el.textContent = message;
      el.className = 'err' + (ok ? ' ok' : '');
    }

    _setStatus (tag, message, won) {
      const $ = (id) => this.shadowRoot.getElementById(id);
      $('status').className = 'status' + (won ? ' won' : '');
      $('statusTag').textContent = tag;
      $('statusMsg').textContent = message;
    }

    async _draw () {
      const $ = (id) => this.shadowRoot.getElementById(id);
      const players = parsePlayers($('players').value);
      if (players.length > MAX_PLAYERS) return this._note(`That is ${players.length} players; the limit is ${MAX_PLAYERS}.`);
      if (this._src) {
        const saved = await this._send('PUT', '/players', { players });
        if (saved) this._note(`Seeds saved: ${saved.players.length} players.`, true);
        return;
      }
      if (players.length < 2) return this._note(`A bracket needs at least 2 players. Add ${2 - players.length} more.`);
      if (hasGames(this._state.record) && typeof root.confirm === 'function' && !root.confirm('Redraw the bracket? Every scored game will be cleared.')) return;
      this._state = { players, format: normalizeFormat($('format').value), bestOf: normalizeBestOf($('bestOf').value), slots: drawSlots(players.length), record: {} };
      $('players').value = players.join('\n');
      this._note(`Bracket drawn: ${players.length} players, ${formatLabel(this._state.format, this._state.bestOf).toLowerCase()}.`, true);
      this._commit();
    }

    async _addLatecomer () {
      const input = this.shadowRoot.getElementById('lateName');
      const name = parsePlayers(input.value)[0];
      if (!name) return this._note('Enter the latecomer’s name.', false, 'lateErr');
      if (this._state.players.some((player) => player.toLowerCase() === name.toLowerCase())) {
        return this._note(`${name} is already in the bracket.`, false, 'lateErr');
      }
      if (this._src) {
        const saved = await this._send('POST', '/players', { name }, 'lateErr');
        if (!saved) return;
      } else {
        const seat = seatLatecomer(this._state, this._state.players.length + 1);
        if (seat.error) return this._note(seat.error, false, 'lateErr');
        this._state.players.push(name);
        this._state.slots = seat.slots;
        this._commit();
      }
      input.value = '';
      this._note(`${name} joined the bracket.`, true, 'lateErr');
    }

    async _play (id, side) {
      const match = this._view && this._view.byId[id];
      if (this._locked || !match || (match.status !== 'ready' && match.status !== 'live') || (side !== 0 && side !== 1)) return;
      const champion = this._view.champion;
      const players = [match.a, match.b];
      if (this._src) {
        const games = match.games.concat(side);
        const next = Object.assign({}, this._state.record, { [id]: { players, games } });
        const outcome = resolveBracket(this._bracket, this._state.bestOf, next).champion;
        if (outcome !== undefined && outcome !== null && typeof root.confirm === 'function' &&
            !root.confirm(`Record ${this._state.players[outcome]} as champion? Results lock once the champion is recorded.`)) return;
        if (!await this._send('POST', '/games', { match: id, side, players })) return;
      } else {
        this._state.record[id] = { players, games: match.games.concat(side) };
        this._commit();
      }
      this._settled(id, champion);
    }

    _pick (id) {
      if (this._locked) return;
      this._picking = this._picking === id ? null : id;
      this._render();
      const first = this._picking && this.shadowRoot.querySelector(`[data-forfeit="${id}"]`);
      if (first) first.focus();
    }

    /**
     * Disqualify `side` from an open set: it ends with no wins and the other
     * player advances. Games already scored are kept for an undo.
     */
    async _forfeit (id, side) {
      const match = this._view && this._view.byId[id];
      this._picking = null;
      if (this._locked || !match || (match.status !== 'ready' && match.status !== 'live') || !isForfeit(side)) return this._render();
      const champion = this._view.champion;
      const players = [match.a, match.b];
      const dropped = this._state.players[side ? match.b : match.a];
      const other = this._state.players[side ? match.a : match.b];
      const entry = { players, games: match.games.slice(), forfeit: side };
      const outcome = resolveBracket(this._bracket, this._state.bestOf, Object.assign({}, this._state.record, { [id]: entry })).champion;
      const crowned = this._src && outcome !== undefined && outcome !== null
        ? ` ${this._state.players[outcome]} is recorded as champion; results lock.`
        : '';
      if (typeof root.confirm === 'function' && !root.confirm(`Disqualify ${dropped}? The set ends with no wins and ${other} advances.${crowned}`)) return this._render();
      if (this._src) {
        if (!await this._send('POST', '/forfeits', { match: id, side, players })) return this._render();
      } else {
        this._state.record[id] = entry;
        this._commit();
      }
      this._settled(id, champion);
    }

    _settled (id, champion) {
      const after = this._view.byId[id];
      if (after && after.status === 'done') {
        this._emit('matchcomplete', {
          match: id,
          winner: this._state.players[after.winner],
          loser: this._state.players[after.loser],
          score: after.wins.slice(),
          forfeit: after.forfeit !== null
        });
      }
      if (champion === undefined && this._view.champion !== undefined && this._view.champion !== null) {
        this._emit('complete', { champion: this._state.players[this._view.champion] });
      }
    }

    async _undo (id) {
      const match = this._view && this._view.byId[id];
      if (this._locked || !match || (!match.games.length && match.forfeit === null)) return;
      if (this._src) {
        await this._send('POST', '/undo', { match: id });
        return;
      }
      const games = match.forfeit !== null ? (this._state.record[id].games || []).slice() : match.games.slice(0, -1);
      this._state.record[id] = { players: [match.a, match.b], games };
      this._commit();
    }

    _commit () {
      this._save();
      this._render();
      this._emit('bracketchange', JSON.parse(JSON.stringify(this._state)));
    }

    _render () {
      const $ = (id) => this.shadowRoot.getElementById(id);
      const state = this._state;
      const locked = this._locked;
      if (!this.hasAttribute('eyebrow')) $('eyebrow').textContent = formatLabel(state.format, state.bestOf).replace(' · ', ' // ').toUpperCase();
      else $('eyebrow').textContent = this.getAttribute('eyebrow');
      if (!this.hasAttribute('heading') && state.name) $('heading').textContent = state.name;
      $('meta').textContent = state.startsAt ? formatWhen(state.startsAt) : '';
      const lockable = !!(this._src && state.locked);
      $('hdr').classList.toggle('has-lock', lockable);
      $('lock').hidden = !lockable;
      if (!lockable) $('unlock').hidden = true;
      $('lock').classList.toggle('open', !!this._password);
      $('lock').innerHTML = PADLOCK(!!this._password);
      $('lock').setAttribute('aria-label', this._password ? 'Lock editing again' : 'Unlock to edit this finished tournament');
      $('lock').title = this._password ? 'Unlocked: click to lock' : 'Locked: enter the password to edit';

      const played = hasGames(state.record);
      $('setup').hidden = locked || (this._src && played);
      $('late').hidden = locked || !played;

      if (state.players.length < 2) {
        this._bracket = null;
        this._view = null;
        $('board').innerHTML = `<p class="empty-board">${this._src ? 'Add at least two players below to draw the bracket.' : 'Enter the players below and draw the bracket.'}</p>`;
        this._setStatus('BRACKET', state.players.length ? `${state.players.length} player · waiting for seeds.` : 'Waiting for seeds.');
        return;
      }

      const bracket = createBracket(state.slots, state.format);
      const view = resolveBracket(bracket, state.bestOf, state.record);
      this._bracket = bracket;
      this._view = view;

      const number = {};
      let n = 0;
      view.matches.forEach((m) => { if (m.status !== 'void' && m.status !== 'skipped') number[m.id] = ++n; });
      const name = (index) => esc(state.players[index]);
      const sourceText = (source) => source.winner ? `Winner M${number[source.winner] || '?'}` : `Loser M${number[source.loser] || '?'}`;

      const open = (m) => !locked && (m.status === 'ready' || m.status === 'live');
      if (this._picking && !(view.byId[this._picking] && open(view.byId[this._picking]))) this._picking = null;

      const sideHtml = (m, side) => {
        const player = side ? m.b : m.a;
        const playable = open(m);
        const picking = playable && this._picking === m.id;
        let cls = 'side';
        let label;
        if (player === undefined) {
          cls += ' tbd';
          label = m.sources[side] ? sourceText(m.sources[side]) : 'If needed';
        } else if (player === null) {
          cls += ' empty';
          label = 'BYE';
        } else {
          label = name(player);
          if (m.status === 'done') cls += m.winner === player ? ' win' : ' lose';
          if (m.forfeit === side) cls += ' dq';
        }
        const seed = player !== undefined && player !== null ? `#${player + 1}` : '';
        const score = m.forfeit === side ? 'DQ' : m.status === 'live' || m.status === 'done' ? m.wins[side] : '';
        const play = picking
          ? ` data-forfeit="${m.id}" data-side="${side}" role="button" tabindex="0" aria-label="Disqualify ${label}"`
          : playable ? ` data-play="${m.id}" data-side="${side}" role="button" tabindex="0" aria-label="Score a game for ${label}"` : '';
        return `<div class="${cls}"${play}><span class="seed">${seed}</span><span class="name">${label}</span><span class="score">${score}</span></div>`;
      };

      const STATE_LABEL = { pending: 'Waiting', ready: 'Ready', live: 'Live', done: 'Final', bye: 'Bye' };
      const matchHtml = (m) => {
        const picking = this._picking === m.id;
        const undo = (m.games.length || m.forfeit !== null) && !locked && !picking
          ? `<button class="undo" type="button" data-undo="${m.id}" aria-label="${m.forfeit !== null ? 'Undo the DQ' : 'Undo the last game'} in M${number[m.id]}">Undo</button>`
          : '';
        const dq = open(m)
          ? `<button class="undo dq" type="button" data-dq="${m.id}" aria-pressed="${picking}" aria-label="${picking ? 'Cancel the DQ' : 'Disqualify a player'} in M${number[m.id]}">${picking ? 'Cancel' : 'DQ'}</button>`
          : '';
        const state = picking ? 'Who dropped?' : m.forfeit !== null ? 'DQ' : (STATE_LABEL[m.status] || '');
        return `<div class="match ${m.status}${picking ? ' picking' : ''}"><div class="mhead"><span>M${number[m.id]}</span>${undo}${dq}<span class="state">${state}</span></div>${sideHtml(m, 0)}${sideHtml(m, 1)}</div>`;
      };

      const section = (title, key) => {
        const rounds = {};
        view.matches.forEach((m) => {
          if (m.bracket !== key || m.status === 'void' || m.status === 'skipped') return;
          (rounds[m.round] = rounds[m.round] || []).push(m);
        });
        const columns = Object.keys(rounds).sort((x, y) => x - y).map((round) => {
          const list = rounds[round];
          return `<div class="round"><h3>${esc(roundName(bracket, list[0]))}</h3><div class="sets">${list.map(matchHtml).join('')}</div></div>`;
        }).join('');
        return columns ? `<section class="section"><h2>${title}</h2><div class="rounds">${columns}</div></section>` : '';
      };

      $('board').innerHTML = state.format === DOUBLE
        ? section('Winners bracket', 'W') + section('Losers bracket', 'L') + section('Grand final', 'F')
        : section('Bracket', 'W');

      if (view.champion !== undefined && view.champion !== null) {
        const recorded = state.locked && state.results && state.results.completedAt ? ` · recorded ${formatWhen(state.results.completedAt)}` : '';
        const editing = this._password ? ' · unlocked for editing' : '';
        this._setStatus('CHAMPION', state.players[view.champion] + recorded + editing, true);
        return;
      }
      const live = view.matches.filter((m) => m.status === 'live').length;
      const ready = view.matches.filter((m) => m.status === 'ready').length;
      const reset = state.format === DOUBLE && view.byId[bracket.reset].status !== 'pending' && view.byId[bracket.reset].status !== 'skipped';
      this._setStatus(state.locked ? 'REOPENED' : 'BRACKET', [
        state.locked ? 'Edited after it finished; the champion is recorded again once the bracket is decided' : null,
        `${state.players.length} players`,
        live ? `${live} live` : null,
        ready ? `${ready} ready to play` : null,
        reset ? 'Bracket reset: the grand final goes again' : null
      ].filter(Boolean).join(' · '));
    }
  }

  root.customElements.define('tournament-bracket', TournamentBracket);
})(typeof window !== 'undefined' ? window : undefined);
