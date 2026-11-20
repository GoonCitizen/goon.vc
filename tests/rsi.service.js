'use strict';

const assert = require('assert');
const RsiService = require('../services/rsi');

function call (pathname) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      headersSent: false,
      writableEnded: false,
      setHeader () {},
      writeHead (status) { this.statusCode = status; this.headersSent = true; },
      end (body) { this.writableEnded = true; resolve({ status: this.statusCode, body: body ? JSON.parse(body) : null }); }
    };
    new RsiService().middleware()({ method: 'GET', url: pathname, path: pathname }, res, () => resolve({ status: 'next' }));
  });
}

describe('GoonCitizen RSI interface on goon.vc', function () {
  it('lists the shared interfaces at /services/rsi and leaves other paths alone', async function () {
    const index = await call('/services/rsi');
    assert.strictEqual(index.status, 200);
    assert.strictEqual(index.body.service, 'rsi');
    assert.ok(index.body.interfaces.some((entry) => entry.path === '/services/rsi/citizens/:handle' && entry.type === 'RsiCitizen'));
    assert.deepStrictEqual(await call('/services/members/rsi'), { status: 'next' });
  });

  it('refuses a citizen handle RSI could not have, without calling RSI', async function () {
    const refused = await call('/services/rsi/citizens/no%20spaces');
    assert.strictEqual(refused.status, 400);
    assert.match(refused.body.error, /handle/);
  });
});
