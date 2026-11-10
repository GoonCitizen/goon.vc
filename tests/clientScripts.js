'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const GoonSPA = require('../types/GoonSPA');

const SCRIPTS = path.join(__dirname, '../assets/scripts');

describe('compiled client scripts', function () {
  const clients = new GoonSPA({}).clientScripts();

  it('gives every client its own path under /scripts/', function () {
    const srcs = clients.map((client) => client.src);
    assert.ok(srcs.every((src) => /^\/scripts\/[a-z0-9-]+\.js$/.test(src)), srcs.join(', '));
    assert.strictEqual(new Set(srcs).size, srcs.length);
  });

  it('holds only compiled components in assets/scripts, each up to date (run `npm run build`)', function () {
    const compiled = new Map(clients.map((client) => [path.basename(client.src), client]));
    for (const name of fs.readdirSync(SCRIPTS)) {
      const client = compiled.get(name);
      assert.ok(client, `assets/scripts/${name} is not compiled from a component; define it in components/`);
      assert.strictEqual(fs.readFileSync(path.join(SCRIPTS, name), 'utf8'), client.compile(), `assets/scripts/${name} is stale; edit ${client.file}, then run npm run build`);
    }
    for (const name of compiled.keys()) assert.ok(fs.existsSync(path.join(SCRIPTS, name)), `assets/scripts/${name} is missing; run npm run build`);
  });

  it('the built index.html starts with a doctype (run `npm run build`)', function () {
    const index = fs.readFileSync(path.join(__dirname, '../assets/index.html'), 'utf8');
    assert.ok(/^<!doctype html>/i.test(index), 'quirks mode otherwise');
  });

  it('loads each client at its current version from the built index.html (run `npm run build`)', function () {
    const index = fs.readFileSync(path.join(__dirname, '../assets/index.html'), 'utf8');
    for (const client of clients) {
      assert.ok(/^[0-9a-f]{12}$/.test(client.version), client.file);
      assert.ok(index.includes(client.tag()), `assets/index.html does not load ${client.url}; run npm run build`);
    }
  });

  it('runs each client on a page without its markup', function () {
    for (const client of clients) {
      const document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
      const window = { document, location: { pathname: '/', search: '', hash: '' } };
      assert.doesNotThrow(() => vm.runInNewContext(client.compile(), { window, document }), client.file);
    }
  });
});
