'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Bounties = require('../services/bounties');

function member (id, name, handle) {
  return {
    id,
    displayName: name,
    accounts: handle ? [{ platform: 'rsi', id: handle, via: 'bio' }] : []
  };
}

function route (service, method, url, { body = {}, as = null } = {}) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      setHeader () {},
      end (payload) { resolve({ status: this.statusCode, body: payload ? JSON.parse(payload) : null }); }
    };
    const [pathname, search] = url.split('?');
    service.middleware()({ method, url, path: pathname, query: Object.fromEntries(new URLSearchParams(search || '')), body, member: as }, res, () => resolve({ status: 'next' }));
  });
}

describe('bounty board service', function () {
  let dir;
  let board;
  const poster = member('a'.repeat(16), 'Poster', 'PosterHandle');
  const hunter = member('b'.repeat(16), 'Hunter', 'HunterHandle');
  const stranger = member('c'.repeat(16), 'Stranger', null);

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-bounties-'));
    board = new Bounties({
      path: dir,
      members: { async currentMember (req) { return req.member ? { member: req.member } : null; } }
    });
    await board.start();
  });

  afterEach(async function () {
    await board.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses aUEC and refuses bitcoin', function () {
    assert.strictEqual(Bounties.parseAuec('150000'), 150000);
    assert.strictEqual(Bounties.parseAuec('150,000 aUEC'), 150000);
    assert.strictEqual(Bounties.parseAuec('150k'), 150000);
    assert.strictEqual(Bounties.parseAuec('1.5m'), 1500000);
    assert.strictEqual(Bounties.parseAuec('0.001 BTC'), null);
    assert.strictEqual(Bounties.parseAuec('0'), null);
  });

  it('requires a linked RSI handle to post, and pays the hunter when the poster confirms the kill', async function () {
    const refused = await route(board, 'POST', '/services/bounties', {
      as: stranger,
      body: { target: 'BadGuy', reward: '150k' }
    });
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.error, /\/services\/rsi/);

    const posted = await route(board, 'POST', '/services/bounties', {
      as: poster,
      body: { target: 'BadGuy', reward: '150k', note: 'Flies a Gladius out of Seraphim.' }
    });
    assert.strictEqual(posted.status, 201);
    assert.strictEqual(posted.body.bounty.target, 'BadGuy');
    assert.strictEqual(posted.body.bounty.rewardAuec, 150000);
    assert.strictEqual(posted.body.bounty.reward, '150,000 aUEC');
    assert.strictEqual(posted.body.bounty.posterHandle, 'PosterHandle');
    assert.ok(!JSON.stringify(posted.body).includes(poster.id));

    const self = await route(board, 'POST', '/services/bounties', {
      as: poster,
      body: { target: 'posterhandle', reward: '1' }
    });
    assert.strictEqual(self.status, 400);

    const claimed = await route(board, 'POST', `/services/bounties/${posted.body.bounty.id}/claim`, { as: hunter });
    assert.strictEqual(claimed.status, 200);
    assert.strictEqual(claimed.body.bounty.status, 'claimed');
    assert.strictEqual(claimed.body.bounty.claimantHandle, 'HunterHandle');

    const paid = await route(board, 'POST', `/services/bounties/${posted.body.bounty.id}/confirm`, { as: poster });
    assert.strictEqual(paid.status, 200);
    assert.strictEqual(paid.body.bounty.status, 'paid');

    const list = await route(board, 'GET', '/services/bounties');
    assert.ok(list.body.bounties.some((bounty) => bounty.target === 'BadGuy' && bounty.status === 'paid'));
    assert.ok(!JSON.stringify(list.body).includes(hunter.id));
  });

  it('sends a turned-away claim back to the board', async function () {
    const posted = await board.create({ target: 'QuietPilot', reward: '2000' }, poster);
    await board.claim(posted.id, hunter);
    const open = await board.reject(posted.id, poster);
    assert.strictEqual(open.status, 'open');
    assert.strictEqual(open.claimantHandle, null);
    const again = await board.claim(posted.id, hunter);
    assert.strictEqual(again.status, 'claimed');
  });
});
