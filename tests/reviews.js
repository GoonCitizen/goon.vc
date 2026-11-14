'use strict';

const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const Community = require('../services/community');
const Members = require('../services/members');
const Reviews = require('../services/reviews');

const DOORMAN = process.env.FABRIC_DOORMAN || path.resolve(__dirname, '../../doorman');
const HAS_SCRIPTS = fs.existsSync(path.join(DOORMAN, 'services/scripts.js'));
const doorman = (file) => require(path.join(DOORMAN, file));

const REVIEWER = '420222636954615808';
const MEMBER = '222222222222222222';

class FakeDiscord extends EventEmitter {
  constructor () {
    super();
    this.botReady = true;
    this.voice = { active: {} };
    this.dms = [];
    const raw = new EventEmitter();
    raw.guilds = { cache: new Map() };
    raw.isReady = () => true;
    raw.users = {
      fetch: async (id) => ({
        send: async (payload) => {
          if (this.closed) throw Object.assign(new Error('Cannot send messages to this user'), { code: 50007 });
          this.dms.push({ id, payload });
          return { id: `dm-${this.dms.length}` };
        }
      })
    };
    this.client = raw;
  }

  async postToChannel () {
    return {};
  }
}

class FakeOperations extends EventEmitter {
  constructor () {
    super();
    this.discord = null;
    this.gateway = { status: 'disabled', error: null };
  }

  connect (discord) {
    this.discord = discord;
    this.gateway = { status: 'connected', error: null };
    this.emit('gateway', discord);
    return discord;
  }
}

async function until (check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('timed out');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Reviews (waiting area DMs to reviewers)', function () {
  this.timeout(20000);
  let dir;
  let members;
  let community;
  let reviews;
  let discord;

  before(function () {
    if (!HAS_SCRIPTS) this.skip();
  });

  beforeEach(async function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-reviews-'));
    members = new Members({ path: path.join(dir, 'members'), review: true });
    await members.start();
    await members.memberFor(`discord:${REVIEWER}`, { create: true, via: 'oauth', displayName: 'Remaeus', profile: { username: 'remaeus' } });
    const operations = new FakeOperations();
    community = new Community({
      path: path.join(dir, 'community'),
      token: 'scripts-token',
      siteUrl: 'https://goon.vc',
      operations,
      Doorman: doorman('services/doorman'),
      Scripts: doorman('services/scripts'),
      DoormanDiscord: doorman('services/discord')
    });
    await community.start();
    reviews = new Reviews({ members, community, reviewers: [REVIEWER, 'not-an-id'] });
    await reviews.start();
    discord = operations.connect(new FakeDiscord());
  });

  afterEach(async function () {
    if (reviews) await reviews.stop();
    if (community) await community.stop();
    if (members) await members.stop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  async function newcomer (id, name, inGuild) {
    const member = await members.memberFor(`discord:${id}`, {
      create: true,
      via: 'oauth',
      displayName: name,
      inGuild,
      profile: { username: name.toLowerCase(), globalName: name }
    });
    return members.requestReview(member.id);
  }

  const toReviewer = () => discord.dms.filter((dm) => dm.id === REVIEWER);
  const last = () => toReviewer()[toReviewer().length - 1].payload;
  const controls = () => last().components.flatMap((row) => row.components);
  const button = (label) => controls().find((component) => component.label === label).custom_id;

  async function press (customId, extra = {}) {
    const before = discord.dms.length;
    discord.client.emit('interactionCreate', Object.assign({
      customId,
      user: { id: REVIEWER },
      message: { content: last().content },
      deferUpdate: async () => {},
      editReply: async () => {},
      followUp: async (payload) => { throw new Error(`refused: ${payload.content}`); }
    }, extra));
    await until(() => discord.dms.length > before);
  }

  it('shows one officer at a time, and approving one leaves the others waiting', async function () {
    assert.strictEqual(reviews.available, true);
    assert.deepStrictEqual(reviews.reviewers, [REVIEWER], 'ids only');
    await sleep(5);
    const alpha = await newcomer('100000000000000001', 'Alpha', true);
    const bravo = await newcomer('100000000000000002', 'Bravo', false);
    await sleep(60);
    assert.strictEqual(toReviewer().length, 0, 'a sign-in waiting for review DMs nobody by itself');
    assert.deepStrictEqual(await reviews.begin(REVIEWER), { pending: 2 });
    assert.strictEqual(toReviewer().length, 1);

    assert.ok(last().content.startsWith('Hi Remaeus!'), last().content);
    assert.ok(last().content.includes('**2** officers are waiting'), last().content);
    assert.ok(last().content.includes('100000000000000001'), 'the Discord id is on the card');
    assert.ok(last().content.includes('Alpha (@alpha)'));
    assert.ok(last().content.includes('In the G00N SQUAD Discord'));
    assert.ok(!controls().some((component) => component.options), 'one officer is three buttons, not a menu of everyone');
    assert.deepStrictEqual(controls().filter((component) => component.type === 2).map((component) => component.label), [
      'Approve', 'Turn away', 'Leave waiting', 'Skip', 'Cancel'
    ]);
    assert.ok((await members.pendingReviews()).every((member) => member.review.notifiedAt));

    await press(button('Approve'));
    assert.strictEqual(members.reviewOf(await members.getMember(alpha.id)).status, 'approved');
    assert.strictEqual((await members.getMember(alpha.id)).review.reviewedBy, `discord:${REVIEWER}`);
    assert.strictEqual(members.reviewOf(await members.getMember(bravo.id)).status, 'pending', 'approving one does not clear the rest');
    assert.ok(last().content.includes('Bravo (@bravo)'), last().content);
    assert.ok(last().content.includes('100000000000000002'));
    assert.ok(last().content.includes('Not in the G00N SQUAD Discord'));

    const charlie = await newcomer('100000000000000003', 'Charlie', true);
    await sleep(60);
    assert.ok(last().content.includes('Bravo (@bravo)'), 'a reviewer partway through is not interrupted');

    await press(button('Leave waiting'));
    assert.strictEqual(members.reviewOf(await members.getMember(bravo.id)).status, 'pending');
    assert.ok(last().content.includes('Charlie (@charlie)'), last().content);
    assert.strictEqual(members.reviewOf(await members.getMember(charlie.id)).status, 'pending');

    await press(button('Turn away'));
    assert.strictEqual(members.reviewOf(await members.getMember(charlie.id)).status, 'denied');
    assert.strictEqual(members.reviewOf(await members.getMember(bravo.id)).status, 'pending');
    assert.ok(last().content.includes('Turned away Charlie (@charlie).'), last().content);
    assert.ok(last().content.includes('1 officer still waiting'), last().content);
    assert.deepStrictEqual((await members.pendingReviews()).map((member) => member.id), [bravo.id]);

    const report = await reviews.report();
    assert.deepStrictEqual(report, { available: true, reviewers: 1, pending: 1 });
  });

  it('opens the list on demand for reviewers only', async function () {
    await assert.rejects(reviews.begin(MEMBER), (error) => error.status === 403);
    assert.deepStrictEqual(await reviews.begin(REVIEWER), { pending: 0 });
    assert.strictEqual(toReviewer().length, 0, 'nothing to send');

    await sleep(5);
    const alpha = await newcomer('100000000000000001', 'Alpha', true);
    assert.deepStrictEqual(await reviews.begin(REVIEWER, 'Eric'), { pending: 1 });
    assert.ok(last().content.startsWith('Hi Eric!'), last().content);
    assert.ok(last().content.includes('**1** officer is waiting'), last().content);
    assert.ok(last().content.includes('100000000000000001'));
    assert.ok((await members.getMember(alpha.id)).review.notifiedAt);
    await sleep(60);
    assert.strictEqual(toReviewer().length, 1, 'nothing more goes out by itself');

    await assert.rejects(community.beginScript(Reviews.SCRIPT, { user: `discord/users/${MEMBER}`, name: 'Member' }),
      (error) => error.status === 403, 'the script itself refuses non-reviewers');
  });

  it('refuses a reviewer removed before they confirm', async function () {
    await sleep(5);
    const alpha = await newcomer('100000000000000001', 'Alpha', true);
    await reviews.begin(REVIEWER);
    reviews.reviewers = [];
    await press(button('Approve'));
    assert.ok(/permission|reviewer/i.test(last().content), last().content);
    assert.strictEqual(members.reviewOf(await members.getMember(alpha.id)).status, 'pending');
  });

  it('stays off without reviews, scripts, or reviewers', async function () {
    const off = new Reviews({ members, community, reviewers: [] });
    await off.start();
    assert.strictEqual(off.available, false);
    await assert.rejects(off.begin(REVIEWER), (error) => error.status === 503);
    await off.stop();
  });
});
