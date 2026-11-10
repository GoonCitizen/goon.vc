'use strict';

const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const Leaderboard = require('../services/leaderboard');
const { parseLeaderboard, findLeaderboardPin, displayName } = require('../functions/duelLeaderboard');

const CHANNEL = '1229937640116064276';
const GUILD = '1190527980120850493';
const PIN = [
  '# LEADERBOARD',
  '## Requesting a Duel',
  'For now, just post in this channel if you want a duel, or @-mention whomever you want to challenge.  **All are welcome.**',
  '### CURRENT CHAMPION: 1. <@101>',
  '2. <@102>',
  '3. @plain_handle',
  '4.  <@103> ',
  '4. <@104>',
  '6: <@!105>',
  '### Rules',
  '1. Best of 3.',
  '2. Witnessed by an **Officer**.'
].join('\n');

function textResponse (status, body) {
  return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
}

describe('duelLeaderboard', function () {
  it('reads ranks, ties, gaps, plain handles, and rules from the pinned message', function () {
    const parsed = parseLeaderboard(PIN);
    assert.strictEqual(parsed.title, 'LEADERBOARD');
    assert.deepStrictEqual(parsed.ladder, [
      { rank: 1, userId: '101', handle: null },
      { rank: 2, userId: '102', handle: null },
      { rank: 3, userId: null, handle: 'plain_handle' },
      { rank: 4, userId: '103', handle: null },
      { rank: 4, userId: '104', handle: null },
      { rank: 6, userId: '105', handle: null }
    ]);
    assert.deepStrictEqual(parsed.rules, ['Best of 3.', 'Witnessed by an Officer.']);
  });

  it('picks the pin titled LEADERBOARD', function () {
    const other = { id: '1', content: 'Welcome!\n1. <@9>\n2. <@8>\n3. <@7>\n4. <@6>\n5. <@5>\n6. <@4>\n7. <@3>' };
    const board = { id: '2', content: PIN };
    assert.strictEqual(findLeaderboardPin([other, board]), board);
    assert.strictEqual(findLeaderboardPin([{ id: '3', content: 'hi' }, other]), other, 'falls back to the most ranked lines');
    assert.strictEqual(findLeaderboardPin([{ id: '4', content: '' }]), null);
  });

  it('names members the way Discord shows them in the guild', function () {
    assert.strictEqual(displayName({ nick: '[G00N] Ace', user: { username: 'ace', global_name: 'Ace' } }), '[G00N] Ace');
    assert.strictEqual(displayName({ nick: null, user: { username: 'ace', global_name: 'Ace' } }), 'Ace');
    assert.strictEqual(displayName(null, { username: 'ace', global_name: null }), 'ace');
  });
});

describe('Leaderboard', function () {
  this.timeout(20000);

  let calls;
  let discordUp;
  let content;
  let dir;
  let board;

  function stubFetch (url, opts = {}) {
    calls.push(url);
    assert.strictEqual(opts.headers.Authorization, 'Bot test-token');
    if (!discordUp) return Promise.reject(new Error('getaddrinfo ENOTFOUND discord.com'));
    if (url === `https://discord.com/api/v10/channels/${CHANNEL}/pins`) {
      return Promise.resolve(textResponse(200, [
        { id: '50', content: 'Read the rules first.', mentions: [] },
        {
          id: '51',
          content,
          timestamp: '2024-04-19T06:19:59.236000+00:00',
          edited_timestamp: '2026-10-14T03:54:07.487000+00:00',
          mentions: [{ id: '101', username: 'ace', global_name: 'Ace' }, { id: '105', username: 'gone', global_name: 'Gone Pilot' }]
        }
      ]));
    }
    const member = /\/guilds\/(\d+)\/members\/(\d+)$/.exec(url);
    if (member) {
      assert.strictEqual(member[1], GUILD);
      const nicks = { 101: '[G00N] Ace', 102: null, 103: 'Third', 104: 'Fourth' };
      if (!(member[2] in nicks)) return Promise.resolve(textResponse(404, { message: 'Unknown Member' }));
      return Promise.resolve(textResponse(200, { nick: nicks[member[2]], user: { id: member[2], username: `user${member[2]}`, global_name: member[2] === '102' ? 'Second' : null } }));
    }
    return Promise.resolve(textResponse(404, { message: 'Unknown' }));
  }

  beforeEach(async function () {
    calls = [];
    discordUp = true;
    content = PIN;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-leaderboard-'));
    board = new Leaderboard({
      path: dir,
      discord: { guildId: GUILD },
      fetch: stubFetch,
      resolveToken: () => ({ token: 'test-token', source: 'test' }),
      refreshOnStart: false,
      ttlMs: 60000
    });
    await board.start();
  });

  afterEach(async function () {
    await board.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('syncs the pinned ladder with display names only', async function () {
    const data = await board.list();
    assert.strictEqual(data.champion, '[G00N] Ace');
    assert.deepStrictEqual(data.ladder, [
      { rank: 1, name: '[G00N] Ace' },
      { rank: 2, name: 'Second' },
      { rank: 3, name: 'plain_handle' },
      { rank: 4, name: 'Third' },
      { rank: 4, name: 'Fourth' },
      { rank: 6, name: 'Gone Pilot' }
    ]);
    assert.deepStrictEqual(data.rules, ['Best of 3.', 'Witnessed by an Officer.']);
    assert.strictEqual(data.updatedAt, '2026-10-14T03:54:07.487000+00:00');
    assert.strictEqual(data.channel.url, `https://discord.com/channels/${GUILD}/${CHANNEL}`);
    assert.ok(!/userId|"10[1-5]"/.test(JSON.stringify(data)), 'no Discord ids');
    assert.ok(!data.stale);
  });

  it('reuses resolved names instead of looking every pilot up again', async function () {
    await board.refresh();
    const lookups = calls.filter((u) => /\/members\//.test(u)).length;
    assert.ok(lookups >= 5);
    calls = [];
    await board.refresh();
    assert.deepStrictEqual(calls, [`https://discord.com/api/v10/channels/${CHANNEL}/pins`], 'only the pins are fetched again');
  });

  it('keeps serving the saved ladder while Discord is unreachable', async function () {
    await board.refresh();
    discordUp = false;
    await assert.rejects(board._refresh(), /ENOTFOUND/);
    const data = await board.list();
    assert.strictEqual(data.stale, true);
    assert.match(data.error, /ENOTFOUND/);
    assert.strictEqual(data.ladder.length, 6);
  });

  it('refuses a pin it cannot read rather than wiping the ladder', async function () {
    await board.refresh();
    content = '';
    await assert.rejects(board._refresh(), /No pinned leaderboard/);
    const data = await board.list();
    assert.strictEqual(data.stale, true);
    assert.strictEqual(data.ladder.length, 6);
  });

  it('serves GET /services/leaderboards/1v1 and nothing else', async function () {
    const call = (method, url) => new Promise((resolve) => {
      const res = { headers: {}, setHeader (k, v) { this.headers[k] = v; }, end: (body) => resolve({ status: res.statusCode, body }) };
      board.middleware()({ method, url }, res, () => resolve(null));
    });
    const ok = await call('GET', '/services/leaderboards/1v1');
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(JSON.parse(ok.body).ladder[0].name, '[G00N] Ace');
    assert.strictEqual((await call('POST', '/services/leaderboards/1v1')).status, 405);
    assert.strictEqual(await call('GET', '/services/leaderboards/other'), null);
  });
});
