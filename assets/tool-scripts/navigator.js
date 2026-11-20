'use strict';

// Quantum navigator. Distances are starmap meters. Travel time is the
// two-stage standard-jump curve from the Star Citizen Wiki's 4.10 notes
// (constant accel to engage speed, then linear accel to cruise, mirrored
// on the way out). Fuel in SCU is fuelRate * meters / 1000, which matches
// the ship ranges the same API publishes.
(function (factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof document !== 'undefined') api.mount();
})(function () {
  const EPS = 1e-6;

  function distanceMeters (a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    const dz = a.z - b.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  function profile (jump) {
    const V = jump.speed;
    let Ve = jump.engage || 0;
    const a1 = jump.a1 || 0;
    const a2 = jump.a2 || 0;
    let T1 = 0;
    if (!(Ve > 0) || !(a1 > 0)) Ve = 0;
    else T1 = Ve / a1;
    let T2 = 0;
    if (V > Ve && (a1 + a2) > 0) T2 = 2 * (V - Ve) / (a1 + a2);
    const D1 = 0.5 * a1 * T1 * T1;
    const D2 = T2 ? (0.5 * a1 * T2 * T2 + ((a2 - a1) * T2 * T2) / 6 + Ve * T2) : 0;
    return { T: T1 + T2, D: D1 + D2, V, a1, a2, Ve, T1, T2, D1 };
  }

  function distanceAt (t, p) {
    if (!(t > 0)) return 0;
    if (t <= p.T1) return 0.5 * p.a1 * t * t;
    const tau = Math.min(t, p.T) - p.T1;
    const cubic = p.T2 ? ((p.a2 - p.a1) * tau * tau * tau) / (6 * p.T2) : 0;
    return p.D1 + p.Ve * tau + 0.5 * p.a1 * tau * tau + cubic;
  }

  function motionSeconds (meters, jump) {
    const p = profile(jump);
    if (!(meters > 0) || !(p.V > 0)) return 0;
    if (meters >= 2 * p.D) return 2 * p.T + (meters - 2 * p.D) / p.V;
    const target = meters / 2;
    let lo = 0;
    let hi = p.T;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (distanceAt(mid, p) < target) lo = mid;
      else hi = mid;
    }
    return 2 * hi;
  }

  function calibrationSeconds (meters, jump) {
    const rate = jump.calRate;
    const delay = jump.calDelay || 0;
    if (!(rate > 0)) return delay;
    const gate = Math.min(Math.max(meters, jump.calMin || 0), jump.calMax || 0);
    return delay + gate / rate;
  }

  function makeHeap () {
    const a = [];
    function up (i) {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (a[p].time <= a[i].time) break;
        const t = a[p]; a[p] = a[i]; a[i] = t;
        i = p;
      }
    }
    function down (i) {
      for (;;) {
        let s = i;
        const l = i * 2 + 1;
        const r = l + 1;
        if (l < a.length && a[l].time < a[s].time) s = l;
        if (r < a.length && a[r].time < a[s].time) s = r;
        if (s === i) break;
        const t = a[s]; a[s] = a[i]; a[i] = t;
        i = s;
      }
    }
    return {
      push (item) { a.push(item); up(a.length - 1); },
      pop () {
        if (!a.length) return null;
        const top = a[0];
        const last = a.pop();
        if (a.length) { a[0] = last; down(0); }
        return top;
      },
      get size () { return a.length; }
    };
  }

  function createNavigator (data) {
    const places = new Map((data.places || []).map((place) => [place.id, place]));
    const drives = new Map((data.drives || []).map((drive) => [drive.id, drive]));

    function quantumLeg (from, to, drive) {
      const separation = distanceMeters(from, to);
      const drop = drive.disconnect || 0;
      const traveled = Math.max(0, separation - drop);
      const jump = drive.standard;
      const moving = traveled > 1;
      const motion = moving ? motionSeconds(traveled, jump) : 0;
      const calibration = moving ? calibrationSeconds(separation, jump) : 0;
      const spool = moving ? (jump.spool || 0) : 0;
      const fuel = drive.fuelRate * traveled / 1000;
      return {
        kind: 'quantum',
        from,
        to,
        separation,
        traveled,
        spool,
        calibration,
        motion,
        cooldown: 0,
        seconds: spool + calibration + motion,
        fuel
      };
    }

    function accel (drive) {
      const p = profile(drive.standard);
      return { time: p.T, distance: p.D };
    }

    function jumpBetween (a, b) {
      return (data.jumps || []).find((jump) => jump.systems.includes(a) && jump.systems.includes(b)) || null;
    }

    function systemRoute (a, b) {
      if (a === b) return [a];
      const queue = [[a]];
      const seen = new Set([a]);
      while (queue.length) {
        const path = queue.shift();
        const here = path[path.length - 1];
        for (const jump of data.jumps || []) {
          if (!jump.systems.includes(here)) continue;
          const next = jump.systems[0] === here ? jump.systems[1] : jump.systems[0];
          if (seen.has(next)) continue;
          const longer = path.concat(next);
          if (next === b) return longer;
          seen.add(next);
          queue.push(longer);
        }
      }
      return null;
    }

    function gateToward (system, other) {
      const route = systemRoute(system, other);
      if (!route || route.length < 2) return null;
      const jump = jumpBetween(route[0], route[1]);
      return jump ? places.get(jump.gates[system]) || null : null;
    }

    // One system's quantum legs. Refuel stops are places with vehicle
    // services. The tank is filled on arrival. The place you start from is
    // filled only when the trip cannot be done on what's already aboard.
    function planSegment (opts) {
      const from = opts.from;
      const to = opts.to;
      const drive = opts.drive;
      const tank = opts.tank;
      const reserve = opts.reserve || 0;
      if (from.system !== to.system) return { ok: false, reason: 'system', from, to };

      function search (fuel, lead) {
        if (from.id === to.id) {
          if (fuel + EPS < reserve) return { ok: false, reason: 'reserve', need: reserve, have: fuel, from, to };
          const legs = lead ? [{ kind: 'refuel', place: from, loaded: tank - opts.fuel }] : [];
          return { ok: true, legs, fuelLeft: fuel };
        }
        const stops = (data.places || []).filter((place) => place.refuel && place.system === from.system && place.id !== from.id && place.id !== to.id);
        const candidates = stops.concat([to]);
        const best = new Map();
        const prev = new Map();
        const heap = makeHeap();
        function relax (item) {
          const known = best.get(item.key);
          if (known != null && known <= item.time + 1e-9) return;
          best.set(item.key, item.time);
          if (item.step) prev.set(item.key, item.step);
          heap.push(item);
        }
        if (lead) relax({ key: 'pad', time: 0, at: from.id, fuel: tank });
        else relax({ key: 'start', time: 0, at: from.id, fuel });

        while (heap.size) {
          const cur = heap.pop();
          if (cur.time > best.get(cur.key) + 1e-6) continue;
          if (cur.key === 'end') {
            const legs = [];
            if (lead) legs.push({ kind: 'refuel', place: from, loaded: Math.max(0, tank - opts.fuel) });
            const steps = [];
            let key = 'end';
            for (let guard = 0; key !== 'start' && key !== 'pad' && guard < 1000; guard++) {
              const step = prev.get(key);
              if (!step) return { ok: false, reason: 'path', from, to };
              steps.push(step);
              key = step.via;
            }
            steps.reverse();
            for (const step of steps) {
              legs.push(step.leg);
              if (step.refuelAfter) {
                legs.push({ kind: 'refuel', place: step.refuelAfter, loaded: Math.max(0, tank - step.fuelBeforeRefuel) });
              }
            }
            return { ok: true, legs, fuelLeft: steps[steps.length - 1].fuelLeft };
          }
          const here = places.get(cur.at);
          const hot = cur.key.startsWith('full:');
          for (const next of candidates) {
            if (next.id === here.id) continue;
            const flown = quantumLeg(here, next, drive);
            if (flown.fuel > cur.fuel + EPS) continue;
            const arrival = cur.fuel - flown.fuel;
            const cooldown = hot ? (drive.standard.cooldown || 0) : 0;
            const stored = Object.assign({}, flown, { cooldown, seconds: flown.seconds + cooldown });
            const time = cur.time + stored.seconds;
            if (next.id === to.id) {
              if (arrival + EPS < reserve) continue;
              relax({
                key: 'end',
                time,
                at: to.id,
                fuel: arrival,
                step: { via: cur.key, leg: stored, refuelAfter: null, fuelBeforeRefuel: arrival, fuelLeft: arrival }
              });
            } else {
              relax({
                key: 'full:' + next.id,
                time,
                at: next.id,
                fuel: tank,
                step: { via: cur.key, leg: stored, refuelAfter: next, fuelBeforeRefuel: arrival, fuelLeft: tank }
              });
            }
          }
        }
        return { ok: false, reason: 'range', from, to, direct: quantumLeg(from, to, drive), have: fuel, tank };
      }

      function elapsed (result) {
        return result.legs.reduce((sum, leg) => sum + (leg.seconds || 0), 0);
      }
      const first = search(opts.fuel, false);
      if (!(from.refuel && opts.fuel + EPS < tank)) return first;
      const second = search(tank, true);
      if (second.ok && (!first.ok || elapsed(second) < elapsed(first) - 1e-6)) return second;
      return first;
    }

    function summarize (legs, fuelLeft) {
      let seconds = 0;
      let fuel = 0;
      let distance = 0;
      let traveled = 0;
      let refuels = 0;
      let loaded = 0;
      legs.forEach((leg) => {
        if (leg.kind === 'quantum') {
          seconds += leg.seconds;
          fuel += leg.fuel;
          distance += leg.separation;
          traveled += leg.traveled;
        } else if (leg.kind === 'jump') {
          fuel += leg.fuel;
        } else if (leg.kind === 'refuel') {
          refuels += 1;
          loaded += leg.loaded || 0;
        }
      });
      return { ok: true, legs, seconds, fuel, loaded, distance, traveled, refuels, fuelLeft };
    }

    function plan (opts) {
      const from = places.get(opts.from);
      const to = places.get(opts.to);
      const drive = drives.get(opts.drive);
      if (!from || !to || !drive) return { ok: false, reason: 'missing' };
      let fuel = Number(opts.fuel);
      let tank = Number(opts.tank);
      if (!Number.isFinite(fuel) || fuel < 0) fuel = 0;
      if (!Number.isFinite(tank) || tank < fuel) tank = fuel;
      const systems = systemRoute(from.system, to.system);
      if (!systems) return { ok: false, reason: 'no-jump', from, to };

      function run (index, cursor, fuelLeft) {
        if (index >= systems.length - 1) {
          return planSegment({ from: cursor, to, drive, fuel: fuelLeft, tank, reserve: 0 });
        }
        const jump = jumpBetween(systems[index], systems[index + 1]);
        const depart = places.get(jump.gates[systems[index]]);
        const arrive = places.get(jump.gates[systems[index + 1]]);
        const reserve = depart.refuel ? 0 : jump.fuel;
        const seg = planSegment({ from: cursor, to: depart, drive, fuel: fuelLeft, tank, reserve });
        if (!seg.ok) return seg;
        let fuelAt = seg.fuelLeft;
        const legs = seg.legs.slice();
        if (depart.refuel && fuelAt + EPS < tank) {
          legs.push({ kind: 'refuel', place: depart, loaded: tank - fuelAt });
          fuelAt = tank;
        }
        if (fuelAt + EPS < jump.fuel) {
          return { ok: false, reason: 'jump', need: jump.fuel, have: fuelAt, place: depart, tank };
        }
        legs.push({ kind: 'jump', name: jump.name, from: depart, to: arrive, fuel: jump.fuel, seconds: null });
        const rest = run(index + 1, arrive, fuelAt - jump.fuel);
        if (!rest.ok) return rest;
        return { ok: true, legs: legs.concat(rest.legs), fuelLeft: rest.fuelLeft };
      }

      const result = run(0, from, fuel);
      if (!result.ok) return result;
      return summarize(result.legs, result.fuelLeft);
    }

    return {
      data,
      places,
      drives,
      plan,
      quantumLeg,
      accel,
      distanceMeters,
      systemRoute,
      jumpBetween,
      gateToward
    };
  }

  function mount () {
    const root = document.getElementById('tool-navigator');
    if (!root || root.getAttribute('data-ready')) return;
    root.setAttribute('data-ready', '1');
    const status = root.querySelector('#nav-status');
    fetch('/tool-scripts/navigator.json')
      .then((res) => {
        if (!res.ok) throw new Error('starmap');
        return res.json();
      })
      .then((data) => start(root, createNavigator(data)))
      .catch(() => {
        if (status) status.textContent = 'The starmap data did not load.';
      });
  }

  const KIND = {
    planet: 'Planet',
    moon: 'Moon',
    landing: 'Landing zone',
    outpost: 'Outpost',
    station: 'Station',
    nav: 'Nav point'
  };

  function esc (value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatDistance (meters) {
    if (!(meters > 0)) return '0 m';
    const gm = meters / 1e9;
    if (gm >= 10) return gm.toFixed(1) + ' Gm';
    if (gm >= 0.1) return gm.toFixed(2) + ' Gm';
    const km = meters / 1000;
    if (km >= 100) return Math.round(km).toLocaleString() + ' km';
    if (km >= 1) return km.toFixed(1) + ' km';
    return Math.round(meters).toLocaleString() + ' m';
  }

  function formatTime (seconds) {
    if (seconds == null || !isFinite(seconds)) return '—';
    if (seconds > 0 && seconds < 1) return '<1s';
    const whole = Math.round(seconds);
    const h = Math.floor(whole / 3600);
    const m = Math.floor((whole % 3600) / 60);
    const s = whole % 60;
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + String(s).padStart(2, '0') + 's';
    return s + 's';
  }

  function formatScu (n) {
    if (!isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 10) return n.toFixed(1) + ' SCU';
    if (abs >= 1) return n.toFixed(2) + ' SCU';
    return n.toFixed(3) + ' SCU';
  }

  function systemName (nav, id) {
    const system = (nav.data.systems || []).find((item) => item.id === id);
    return system ? system.name : id;
  }

  function placeLabel (nav, place) {
    if (!place) return '';
    const parent = place.moon ? nav.places.get(place.moon) : (place.planet && place.planet !== place.id ? nav.places.get(place.planet) : null);
    const bits = [place.name];
    if (parent && parent.name !== place.name) bits.push(parent.name);
    bits.push(systemName(nav, place.system));
    return bits.join(' · ');
  }

  function readParams () {
    const q = new URLSearchParams(window.location.search);
    return {
      fromSystem: q.get('from') || 'stanton',
      toSystem: q.get('to') || 'pyro',
      fromPlace: q.get('fromPlace') || '',
      toPlace: q.get('toPlace') || '',
      drive: q.get('drive') || 'atlas',
      ship: q.get('ship') || '',
      fuel: q.get('fuel'),
      tank: q.get('tank')
    };
  }

  function start (root, nav) {
    const params = readParams();
    const state = {
      from: { system: params.fromSystem, place: params.fromPlace, planet: '', moon: '', q: '' },
      to: { system: params.toSystem, place: params.toPlace, planet: '', moon: '', q: '' },
      drive: nav.drives.has(params.drive) ? params.drive : 'atlas',
      ship: params.ship,
      fuel: params.fuel == null || params.fuel === '' ? 1 : Number(params.fuel),
      tank: params.tank == null || params.tank === '' ? 1 : Number(params.tank)
    };
    ['from', 'to'].forEach((end) => {
      const place = nav.places.get(state[end].place);
      if (!place || place.system !== state[end].system) {
        state[end].place = '';
        return;
      }
      state[end].planet = place.kind === 'planet' ? place.id : (place.planet || '');
      state[end].moon = place.kind === 'moon' ? place.id : (place.moon || '');
    });
    const ship = (nav.data.ships || []).find((item) => item.slug === state.ship);
    if (ship && params.fuel == null) {
      state.fuel = ship.fuel;
      state.tank = ship.fuel;
    }

    const status = root.querySelector('#nav-status');
    if (status) status.hidden = true;
    const app = root.querySelector('#nav-app');
    app.hidden = false;
    const version = root.querySelector('#nav-version');
    if (version) version.textContent = nav.data.version + ', retrieved ' + nav.data.retrieved;

    fillDrive(root, nav, state);
    fillShips(root, nav, state);
    root.querySelector('#nav-fuel').value = String(state.fuel);
    root.querySelector('#nav-tank').value = String(state.tank);
    ['from', 'to'].forEach((end) => {
      root.querySelector('#nav-' + end).innerHTML = endShell(end);
      root.querySelector('#nav-' + end + '-q').value = '';
    });

    function syncUrl () {
      const q = new URLSearchParams();
      q.set('from', state.from.system);
      q.set('to', state.to.system);
      if (state.from.place) q.set('fromPlace', state.from.place);
      if (state.to.place) q.set('toPlace', state.to.place);
      q.set('drive', state.drive);
      if (state.ship) q.set('ship', state.ship);
      q.set('fuel', String(state.fuel));
      q.set('tank', String(state.tank));
      const path = window.location.pathname + '?' + q.toString();
      window.history.replaceState(null, '', path);
    }

    function fuelNow () {
      const fuel = Number(state.fuel);
      return Number.isFinite(fuel) && fuel > 0 ? fuel : 0;
    }

    function tankNow () {
      const tank = Number(state.tank);
      const fuel = fuelNow();
      if (!Number.isFinite(tank) || tank < fuel) return fuel;
      return tank;
    }

    function draw () {
      drawEnd('from');
      drawEnd('to');
      drawDriveStats();
      drawOut();
      syncUrl();
    }

    root.addEventListener('click', (event) => {
      const button = event.target.closest('[data-act]');
      if (!button || !root.contains(button)) return;
      const end = button.getAttribute('data-end');
      const act = button.getAttribute('data-act');
      const id = button.getAttribute('data-id');
      const side = state[end];
      if (!side) return;
      if (act === 'system') {
        side.system = id;
        side.place = '';
        side.planet = '';
        side.moon = '';
        side.q = '';
        const input = root.querySelector('#nav-' + end + '-q');
        if (input) input.value = '';
      } else if (act === 'planet') {
        side.planet = id;
        side.moon = '';
        side.place = id;
      } else if (act === 'moon') {
        side.moon = id;
        side.place = id;
        const moon = nav.places.get(id);
        if (moon && moon.planet) side.planet = moon.planet;
      } else if (act === 'place') {
        const place = nav.places.get(id);
        if (!place) return;
        side.place = id;
        side.system = place.system;
        side.planet = place.kind === 'planet' ? place.id : (place.planet || '');
        side.moon = place.kind === 'moon' ? place.id : (place.moon || '');
      } else if (act === 'clear') {
        side.place = '';
      }
      draw();
    });

    root.querySelector('#nav-drive').addEventListener('change', (event) => {
      state.drive = event.target.value;
      draw();
    });
    root.querySelector('#nav-fuel').addEventListener('input', (event) => {
      state.fuel = Number(event.target.value);
      draw();
    });
    root.querySelector('#nav-tank').addEventListener('input', (event) => {
      state.tank = Number(event.target.value);
      draw();
    });
    root.querySelector('#nav-ship').addEventListener('change', (event) => {
      const picked = (nav.data.ships || []).find((item) => item.slug === event.target.value || item.name === event.target.value);
      state.ship = picked ? picked.slug : '';
      if (picked) {
        state.fuel = picked.fuel;
        state.tank = picked.fuel;
        root.querySelector('#nav-fuel').value = String(picked.fuel);
        root.querySelector('#nav-tank').value = String(picked.tank || picked.fuel);
      }
      draw();
    });
    ['from', 'to'].forEach((end) => {
      root.querySelector('#nav-' + end + '-q').addEventListener('input', (event) => {
        state[end].q = event.target.value;
        drawResults(end);
      });
    });

    draw();

    function drawEnd (end) {
      const side = state[end];
      const box = root.querySelector('#nav-' + end + '-systems');
      box.innerHTML = (nav.data.systems || []).map((system) => {
        const on = system.id === side.system ? ' aria-pressed="true"' : ' aria-pressed="false"';
        return '<button type="button" data-act="system" data-end="' + end + '" data-id="' + esc(system.id) + '"' + on + '>' + esc(system.name) + '</button>';
      }).join('');
      const place = nav.places.get(side.place);
      const picked = root.querySelector('#nav-' + end + '-picked');
      picked.innerHTML = place
        ? '<span>' + esc(placeLabel(nav, place)) + '</span> <button type="button" class="text" data-act="clear" data-end="' + end + '">Clear</button>'
        : '<span class="mute">No place yet. The route uses the jump, or the planet you pick below.</span>';
      drawResults(end);
      drawBrowse(end);
    }

    function drawResults (end) {
      const side = state[end];
      const q = (side.q || '').trim().toLowerCase();
      const box = root.querySelector('#nav-' + end + '-results');
      if (q.length < 2) {
        box.hidden = true;
        box.innerHTML = '';
        return;
      }
      const hits = [];
      for (const place of nav.data.places) {
        if (place.system !== side.system) continue;
        if (place.name.toLowerCase().indexOf(q) === -1) continue;
        hits.push(place);
        if (hits.length === 12) break;
      }
      box.hidden = !hits.length;
      box.innerHTML = hits.map((place) => '<button type="button" data-act="place" data-end="' + end + '" data-id="' + esc(place.id) + '"><b>' + esc(place.name) + '</b><small>' + esc(KIND[place.kind] || place.kind) + (place.refuel ? ' · refuel' : '') + '</small></button>').join('')
        || '';
      if (!hits.length) {
        box.hidden = false;
        box.innerHTML = '<p class="mute">Nothing in ' + esc(systemName(nav, side.system)) + ' matches.</p>';
      }
    }

    function drawBrowse (end) {
      const side = state[end];
      const box = root.querySelector('#nav-' + end + '-browse');
      const planets = nav.data.places.filter((place) => place.system === side.system && place.kind === 'planet');
      const around = nav.data.places.filter((place) => place.system === side.system && !place.planet && place.kind !== 'planet' && place.kind !== 'moon');
      let html = '<h3>Planets</h3><div class="picks">' + planets.map((place) => pickButton(end, 'planet', place)).join('') + '</div>';
      if (side.planet) {
        const planet = nav.places.get(side.planet);
        const moons = nav.data.places.filter((place) => place.kind === 'moon' && place.planet === side.planet);
        const onPlanet = nav.data.places.filter((place) => place.planet === side.planet && !place.moon && place.kind !== 'planet' && place.kind !== 'moon');
        html += '<h3>' + esc(planet ? planet.name : 'Planet') + '</h3>';
        if (moons.length) html += '<div class="picks">' + moons.map((place) => pickButton(end, 'moon', place)).join('') + '</div>';
        html += scrollList(end, onPlanet);
      }
      if (side.moon) {
        const moon = nav.places.get(side.moon);
        const onMoon = nav.data.places.filter((place) => place.moon === side.moon && place.kind !== 'moon');
        html += '<h3>' + esc(moon ? moon.name : 'Moon') + '</h3>' + scrollList(end, onMoon);
      }
      if (around.length) {
        html += '<h3>In the system</h3><div class="picks">' + around.map((place) => pickButton(end, 'place', place)).join('') + '</div>';
      }
      box.innerHTML = html;
    }

    function pickButton (end, act, place) {
      const on = state[end].place === place.id ? ' aria-pressed="true"' : ' aria-pressed="false"';
      return '<button type="button" data-act="' + act + '" data-end="' + end + '" data-id="' + esc(place.id) + '"' + on + '>' + esc(place.name) + '</button>';
    }

    function scrollList (end, places) {
      if (!places.length) return '<p class="mute">No points here.</p>';
      return '<div class="scroll">' + places.map((place) => {
        const on = state[end].place === place.id ? ' aria-pressed="true"' : ' aria-pressed="false"';
        return '<button type="button" data-act="place" data-end="' + end + '" data-id="' + esc(place.id) + '"' + on + '><b>' + esc(place.name) + '</b><small>' + esc(KIND[place.kind] || '') + (place.refuel ? ' · refuel' : '') + '</small></button>';
      }).join('') + '</div>';
    }

    function drawDriveStats () {
      const drive = nav.drives.get(state.drive);
      const box = root.querySelector('#nav-drive-stats');
      if (!drive) {
        box.textContent = '';
        return;
      }
      const perGm = drive.fuelRate * 1e9 / 1000;
      const range = perGm > 0 ? tankNow() / perGm : 0;
      box.textContent = Math.round(drive.standard.speed / 1e6) + ' Mm/s · spool ' + drive.standard.spool + 's · cooldown ' + drive.standard.cooldown + 's · ' + formatScu(perGm) + '/Gm · this tank reaches ' + formatDistance(range * 1e9);
    }

    function drawOut () {
      const box = root.querySelector('#nav-out');
      const drive = nav.drives.get(state.drive);
      const fromPlace = nav.places.get(state.from.place);
      const toPlace = nav.places.get(state.to.place);
      if (!fromPlace && !toPlace) {
        box.innerHTML = state.from.system === state.to.system
          ? sameSystemCard(drive)
          : jumpCard(drive);
        return;
      }
      if (state.from.system === state.to.system && (!fromPlace || !toPlace)) {
        box.innerHTML = '<section class="result"><p>Pick the other place in ' + esc(systemName(nav, state.from.system)) + '.</p></section>';
        return;
      }
      const from = fromPlace || nav.gateToward(state.from.system, state.to.system);
      const to = toPlace || nav.gateToward(state.to.system, state.from.system);
      if (!from || !to || !drive) {
        box.innerHTML = '<p class="mute">Pick a place on each side. Those two systems are not connected by a jump in this snapshot.</p>';
        return;
      }
      const route = nav.plan({ from: from.id, to: to.id, drive: drive.id, fuel: fuelNow(), tank: tankNow() });
      let html = routeCard(route, from, to, !fromPlace, !toPlace);
      if (!toPlace) html += planetBoard('Arrive', state.to.system, from, drive);
      if (!fromPlace) html += planetBoard('Leave', state.from.system, to, drive);
      box.innerHTML = html;
    }

    function jumpCard (drive) {
      const path = nav.systemRoute(state.from.system, state.to.system);
      if (!path) return '<p>No jump in this snapshot connects ' + esc(systemName(nav, state.from.system)) + ' and ' + esc(systemName(nav, state.to.system)) + '.</p>';
      const hops = [];
      for (let i = 0; i < path.length - 1; i++) {
        const jump = nav.jumpBetween(path[i], path[i + 1]);
        const depart = nav.places.get(jump.gates[path[i]]);
        const arrive = nav.places.get(jump.gates[path[i + 1]]);
        hops.push('<li><b>' + esc(jump.name) + '</b> · ' + esc(depart.name) + ' to ' + esc(arrive.name) + ' · jump fuel ' + esc(formatScu(jump.fuel)) + '</li>');
      }
      return '<section class="result"><h2>' + esc(systemName(nav, state.from.system)) + ' → ' + esc(systemName(nav, state.to.system)) + '</h2>'
        + '<p>System transit is the jump. The tunnel duration is not in the starmap data, so it is not in the times below. Pick a planet, then a point, to add the quantum legs.</p>'
        + '<ul class="hops">' + hops.join('') + '</ul>'
        + planetBoard('Time to the jump', state.from.system, nav.gateToward(state.from.system, state.to.system), drive)
        + '</section>';
    }

    function sameSystemCard (drive) {
      const planets = nav.data.places.filter((place) => place.system === state.from.system && place.kind === 'planet');
      let head = '<tr><th>From \\ to</th>' + planets.map((place) => '<th>' + esc(place.name) + '</th>').join('') + '</tr>';
      const rows = planets.map((from) => {
        const cells = planets.map((to) => {
          if (from.id === to.id) return '<td class="mute">—</td>';
          const leg = nav.quantumLeg(from, to, drive);
          const fits = leg.fuel <= fuelNow() + 1e-6 ? '' : (leg.fuel <= tankNow() + 1e-6 ? ' class="stop"' : ' class="over"');
          return '<td' + fits + '>' + esc(formatDistance(leg.separation)) + '<br>' + esc(formatTime(leg.seconds)) + '<br>' + esc(formatScu(leg.fuel)) + '</td>';
        }).join('');
        return '<tr><th>' + esc(from.name) + '</th>' + cells + '</tr>';
      }).join('');
      return '<section class="result"><h2>' + esc(systemName(nav, state.from.system)) + '</h2>'
        + '<p>Planet to planet, center to center, on the drive and fuel above. A marked cell needs a refuel or a larger tank. Pick a planet to open its moons and points.</p>'
        + '<div class="scroll-x"><table class="grid"><thead>' + head + '</thead><tbody>' + rows + '</tbody></table></div></section>';
    }

    function planetBoard (title, system, target, drive) {
      if (!target || !drive) return '';
      const planets = nav.data.places.filter((place) => place.system === system && place.kind === 'planet');
      const end = system === state.from.system ? 'from' : 'to';
      const rows = planets.map((place) => {
        const route = nav.plan({
          from: end === 'from' ? place.id : target.id,
          to: end === 'from' ? target.id : place.id,
          drive: drive.id,
          fuel: fuelNow(),
          tank: tankNow()
        });
        const same = place.system === target.system;
        const leg = same ? nav.quantumLeg(place, target, drive) : null;
        const time = route.ok ? formatTime(route.seconds) : '—';
        const stops = route.ok ? (route.refuels ? route.refuels + ' refuel' + (route.refuels === 1 ? '' : 's') : 'direct') : 'will not fit';
        const distance = route.ok ? formatDistance(route.distance) : (leg ? formatDistance(leg.separation) : '—');
        const shownFuel = route.ok ? formatScu(route.fuel) : (leg ? formatScu(leg.fuel) : '—');
        return '<tr><td><button type="button" class="text" data-act="planet" data-end="' + end + '" data-id="' + esc(place.id) + '">' + esc(place.name) + '</button></td><td>' + esc(distance) + '</td><td>' + esc(time) + '</td><td>' + esc(shownFuel) + '</td><td>' + esc(stops) + '</td></tr>';
      }).join('');
      return '<h3>' + esc(title) + '</h3><div class="scroll-x"><table><thead><tr><th>Planet</th><th>Distance</th><th>Time</th><th>Fuel</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>';
    }

    function routeCard (route, from, to, fromImplied, toImplied) {
      const via = (fromImplied ? 'Jump gate · ' : '') + placeLabel(nav, from);
      const dest = (toImplied ? 'Jump gate · ' : '') + placeLabel(nav, to);
      if (!route.ok) {
        const hop = route.from && route.to ? route.from.name + ' to ' + route.to.name : '';
        const need = route.direct ? formatScu(route.direct.fuel) : (route.need != null ? formatScu(route.need) : '');
        const why = route.reason === 'jump'
          ? 'The jump needs ' + need + '.'
          : (hop && need ? hop + ' is ' + need + ' in one burn, and no chain of stops fits in the tank.' : 'No chain of stops fits in the tank.');
        return '<section class="result"><h2>' + esc(from.name) + ' → ' + esc(to.name) + '</h2>'
          + '<p class="over">No route. ' + esc(why) + ' You have ' + esc(formatScu(fuelNow())) + ' aboard and the tank holds ' + esc(formatScu(tankNow())) + '. A stop is only counted where the starmap lists vehicle services.</p></section>';
      }
      const jumps = route.legs.filter((leg) => leg.kind === 'jump').length;
      let html = '<section class="result"><h2>' + esc(from.name) + ' → ' + esc(to.name) + '</h2>';
      html += '<dl class="metrics"><div><dt>Quantum time</dt><dd>' + esc(formatTime(route.seconds)) + '</dd></div>';
      html += '<div><dt>Distance</dt><dd>' + esc(formatDistance(route.distance)) + '</dd></div>';
      html += '<div><dt>Fuel burned</dt><dd>' + esc(formatScu(route.fuel)) + '</dd></div>';
      html += '<div><dt>Refuels</dt><dd>' + route.refuels + '</dd></div></dl>';
      html += '<p class="mute">' + esc(via) + ' → ' + esc(dest) + '. You arrive with ' + esc(formatScu(route.fuelLeft)) + '.';
      if (jumps) html += ' Jump tunnels are extra; their duration is not in the total.';
      html += '</p><ol class="legs">';
      route.legs.forEach((leg) => {
        if (leg.kind === 'refuel') {
          html += '<li class="refuel">Refuel at ' + esc(leg.place.name) + ' · take on ' + esc(formatScu(leg.loaded)) + '</li>';
        } else if (leg.kind === 'jump') {
          html += '<li class="jump">Jump · ' + esc(leg.name) + ' · ' + esc(leg.from.name) + ' to ' + esc(leg.to.name) + ' · ' + esc(formatScu(leg.fuel)) + ' · tunnel not timed</li>';
        } else {
          const parts = [];
          if (leg.cooldown) parts.push('cooldown ' + formatTime(leg.cooldown));
          parts.push('spool ' + formatTime(leg.spool));
          parts.push('calibration ' + formatTime(leg.calibration));
          parts.push('burn ' + formatTime(leg.motion));
          html += '<li><b>' + esc(leg.from.name) + ' → ' + esc(leg.to.name) + '</b> · ' + esc(formatDistance(leg.separation)) + ' · ' + esc(formatTime(leg.seconds)) + ' · ' + esc(formatScu(leg.fuel)) + '<br><small>' + esc(parts.join(' · ')) + '</small></li>';
        }
      });
      html += '</ol></section>';
      return html;
    }
  }

  function endShell (end) {
    const title = end === 'from' ? 'From' : 'To';
    return '<h2>' + title + '</h2><div class="systems" id="nav-' + end + '-systems"></div>'
      + '<label class="search">Search this system <input id="nav-' + end + '-q" type="search" autocomplete="off" spellcheck="false" placeholder="Lorville, Everus, Hurston"></label>'
      + '<div class="results" id="nav-' + end + '-results" hidden></div>'
      + '<p class="picked" id="nav-' + end + '-picked"></p>'
      + '<div class="browse" id="nav-' + end + '-browse"></div>';
  }

  function fillDrive (root, nav, state) {
    const select = root.querySelector('#nav-drive');
    const bySize = new Map();
    nav.data.drives.forEach((drive) => {
      if (!bySize.has(drive.size)) bySize.set(drive.size, []);
      bySize.get(drive.size).push(drive);
    });
    select.innerHTML = Array.from(bySize.keys()).sort((a, b) => a - b).map((size) => {
      const options = bySize.get(size).map((drive) => '<option value="' + esc(drive.id) + '"' + (drive.id === state.drive ? ' selected' : '') + '>' + esc(drive.name) + ' · ' + esc(drive.grade) + ' · ' + esc(drive.role) + '</option>').join('');
      return '<optgroup label="Size ' + size + '">' + options + '</optgroup>';
    }).join('');
  }

  function fillShips (root, nav, state) {
    const list = root.querySelector('#nav-ships');
    const seen = new Set();
    const options = [];
    (nav.data.ships || []).forEach((ship) => {
      const key = ship.name + '|' + ship.fuel;
      if (seen.has(key)) return;
      seen.add(key);
      options.push(ship);
    });
    list.innerHTML = options.map((ship) => '<option value="' + esc(ship.name) + '"></option>').join('');
    const current = (nav.data.ships || []).find((ship) => ship.slug === state.ship);
    root.querySelector('#nav-ship').value = current ? current.name : '';
  }

  return { createNavigator, mount };
});
