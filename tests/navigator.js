'use strict';

const assert = require('assert');

const { createNavigator } = require('../assets/tool-scripts/navigator.js');
const data = require('../assets/tool-scripts/navigator.json');

const GM = 1e9;

function drive (over) {
  return Object.assign({
    id: 'test',
    name: 'Test',
    fuelRate: 1e-6,
    disconnect: 0,
    standard: {
      speed: 1e9,
      spool: 10,
      cooldown: 5,
      a1: 1e12,
      a2: 1e12,
      engage: 0,
      calRate: 1000,
      calMin: 0,
      calMax: 0,
      calDelay: 0
    }
  }, over);
}

function place (id, system, x, extra) {
  return Object.assign({ id, name: id, system, kind: 'outpost', x, y: 0, z: 0, refuel: false, planet: null, moon: null }, extra);
}

function fixture (places, jumps) {
  return {
    systems: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
    jumps: jumps || [],
    places,
    drives: [drive()]
  };
}

describe('navigator', function () {
  const nav = createNavigator(data);
  const erebos = data.drives.find((item) => item.name === 'Erebos');
  const beacon = data.drives.find((item) => item.name === 'Beacon');
  const atlas = data.drives.find((item) => item.name === 'Atlas');

  it('matches the 4.10 acceleration curve for Erebos', function () {
    const curve = nav.accel(erebos);
    assert.ok(Math.abs(curve.time - 134.3) < 0.2, curve.time);
    assert.ok(Math.abs(curve.distance / GM - 39.55) < 0.05, curve.distance / GM);
    const ten = nav.quantumLeg(
      { x: 0, y: 0, z: 0 },
      { x: 10 * GM, y: 0, z: 0 },
      Object.assign({}, erebos, { disconnect: 0 })
    );
    assert.ok(ten.motion > erebos.t10 - 1 && ten.motion < erebos.t10 + 4, ten.motion);
  });

  it('reproduces the Gladius quantum range from the Beacon fuel rate', function () {
    const range = 32223415682;
    const burned = beacon.fuelRate * range / 1000;
    assert.ok(Math.abs(burned - 0.6) < 1e-9, burned);
  });

  it('uses the starmap distance from Hurston to ArcCorp', function () {
    const hurston = data.places.find((place) => place.name === 'Hurston' && place.kind === 'planet');
    const arccorp = data.places.find((place) => place.name === 'ArcCorp' && place.kind === 'planet');
    const meters = nav.distanceMeters(hurston, arccorp);
    assert.ok(Math.abs(meters / GM - 22.8828) < 0.001, meters / GM);
    const route = nav.plan({ from: hurston.id, to: arccorp.id, drive: atlas.id, fuel: 10, tank: 10 });
    assert.strictEqual(route.ok, true);
    assert.strictEqual(route.legs.filter((leg) => leg.kind === 'jump').length, 0);
    assert.ok(route.seconds > 0);
    assert.ok(route.fuel > 0);
  });

  it('flies a direct leg when the fuel aboard covers it', function () {
    const nav2 = createNavigator(fixture([
      place('o', 'a', 0),
      place('s', 'a', 0.5 * GM, { refuel: true }),
      place('d', 'a', GM)
    ]));
    const route = nav2.plan({ from: 'o', to: 'd', drive: 'test', fuel: 5, tank: 5 });
    assert.strictEqual(route.ok, true);
    assert.deepStrictEqual(route.legs.map((leg) => leg.kind), ['quantum']);
    assert.ok(Math.abs(route.fuel - 1) < 1e-6, route.fuel);
    assert.strictEqual(route.refuels, 0);
  });

  it('inserts a refuel when the tank can hop and the fuel aboard cannot', function () {
    const nav2 = createNavigator(fixture([
      place('o', 'a', 0),
      place('s', 'a', 0.5 * GM, { refuel: true, kind: 'station' }),
      place('d', 'a', 1.5 * GM)
    ]));
    const route = nav2.plan({ from: 'o', to: 'd', drive: 'test', fuel: 0.6, tank: 1 });
    assert.strictEqual(route.ok, true);
    assert.deepStrictEqual(route.legs.map((leg) => leg.kind), ['quantum', 'refuel', 'quantum']);
    assert.strictEqual(route.legs[1].place.id, 's');
    assert.ok(route.legs[1].loaded > 0);
    assert.strictEqual(route.legs[2].cooldown, 5);
    assert.ok(Math.abs(route.fuel - 1.5) < 1e-6, route.fuel);
  });

  it('refuels before leaving only when the place can and the trip needs it', function () {
    const nav2 = createNavigator(fixture([
      place('o', 'a', 0, { refuel: true, kind: 'station' }),
      place('d', 'a', GM)
    ]));
    const covered = nav2.plan({ from: 'o', to: 'd', drive: 'test', fuel: 5, tank: 10 });
    assert.deepStrictEqual(covered.legs.map((leg) => leg.kind), ['quantum']);
    const needed = nav2.plan({ from: 'o', to: 'd', drive: 'test', fuel: 0.2, tank: 1 });
    assert.deepStrictEqual(needed.legs.map((leg) => leg.kind), ['refuel', 'quantum']);
    assert.ok(Math.abs(needed.legs[0].loaded - 0.8) < 1e-6);
  });

  it('tops up where you are when that is faster than a short hop to another pad', function () {
    const nav2 = createNavigator(fixture([
      place('o', 'a', 0, { refuel: true, kind: 'station' }),
      place('s', 'a', 0.4 * GM, { refuel: true, kind: 'station' }),
      place('d', 'a', 2 * GM)
    ]));
    const route = nav2.plan({ from: 'o', to: 'd', drive: 'test', fuel: 0.5, tank: 2 });
    assert.deepStrictEqual(route.legs.map((leg) => leg.kind), ['refuel', 'quantum']);
    assert.strictEqual(route.legs[0].place.id, 'o');
  });

  it('refuses a hop the tank cannot make', function () {
    const nav2 = createNavigator(fixture([
      place('o', 'a', 0),
      place('d', 'a', GM)
    ]));
    const route = nav2.plan({ from: 'o', to: 'd', drive: 'test', fuel: 0.4, tank: 0.4 });
    assert.strictEqual(route.ok, false);
    assert.ok(Math.abs(route.direct.fuel - 1) < 1e-6);
  });

  it('crosses a jump and counts its fuel apart from the tunnel time', function () {
    const nav2 = createNavigator(fixture([
      place('o', 'a', 0),
      place('ga', 'a', GM, { kind: 'station' }),
      place('gb', 'b', 0, { kind: 'station' }),
      place('d', 'b', GM)
    ], [{
      id: 'a-b',
      name: 'A — B',
      systems: ['a', 'b'],
      gates: { a: 'ga', b: 'gb' },
      fuel: 0.2
    }]));
    const route = nav2.plan({ from: 'o', to: 'd', drive: 'test', fuel: 5, tank: 5 });
    assert.strictEqual(route.ok, true);
    assert.deepStrictEqual(route.legs.map((leg) => leg.kind), ['quantum', 'jump', 'quantum']);
    assert.strictEqual(route.legs[1].seconds, null);
    assert.ok(Math.abs(route.fuel - 2.2) < 1e-6, route.fuel);
    assert.ok(route.seconds > 0);
  });

  it('fills a services gate before a jump when the tank is not full', function () {
    const nav2 = createNavigator(fixture([
      place('ga', 'a', 0, { refuel: true, kind: 'station' }),
      place('gb', 'b', 0, { kind: 'station' }),
      place('d', 'b', GM)
    ], [{
      id: 'a-b',
      name: 'A — B',
      systems: ['a', 'b'],
      gates: { a: 'ga', b: 'gb' },
      fuel: 0.2
    }]));
    const route = nav2.plan({ from: 'ga', to: 'd', drive: 'test', fuel: 0.1, tank: 2 });
    assert.strictEqual(route.ok, true, JSON.stringify(route));
    assert.strictEqual(route.legs[0].kind, 'refuel');
    assert.strictEqual(route.legs[1].kind, 'jump');
    assert.ok(route.fuelLeft > 0);
  });

  it('routes Nyx to Stanton through Pyro', function () {
    const levski = data.places.find((place) => place.name === 'Levski');
    const lorville = data.places.find((place) => place.name === 'Lorville');
    const route = nav.plan({ from: levski.id, to: lorville.id, drive: atlas.id, fuel: 100, tank: 100 });
    assert.strictEqual(route.ok, true);
    const jumps = route.legs.filter((leg) => leg.kind === 'jump');
    assert.strictEqual(jumps.length, 2);
    assert.ok(jumps.every((leg) => leg.fuel === 0.24));
    assert.ok(jumps.every((leg) => leg.seconds == null));
  });
});
