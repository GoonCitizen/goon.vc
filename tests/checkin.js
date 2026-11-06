'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const checkin = require('../functions/checkin');

const GUILD = '1190527980120850493';
const DAY = 24 * 60 * 60 * 1000;

// Doorman's campaign filter from ../doorman (or FABRIC_DOORMAN), when it knows check-ins.
function doormanCampaign () {
  const file = path.join(process.env.FABRIC_DOORMAN || path.join(__dirname, '../../doorman'), 'types/campaign.js');
  try {
    return fs.readFileSync(file, 'utf8').includes('inactiveForDays') ? require(file) : null;
  } catch (_) {
    return null;
  }
}

describe('Check-in campaigns', function () {
  const contract = checkin.load();

  it('checks in with very old, then somewhat old, then getting old members of the home server', function () {
    assert.strictEqual(contract.guildId, GUILD);
    assert.deepStrictEqual(checkin.requirements(contract), { 'G00N SQUAD member': [GUILD] }, 'the @everyone role: members of the home server');
    const drafts = checkin.drafts(contract);
    assert.deepStrictEqual(drafts.map((entry) => entry.tier), ['very-old', 'somewhat-old', 'getting-old'], 'most inactive first');
    assert.deepStrictEqual(drafts.map((entry) => [entry.draft.filter.inactiveForDays, entry.draft.filter.activeWithinDays]), [
      [120, null],
      [60, 120],
      [30, 60]
    ], 'windows that meet without overlapping, nobody active in the last 30 days');
    for (const { draft } of drafts) {
      assert.ok(draft.title.startsWith(checkin.TITLE_PREFIX));
      assert.deepStrictEqual(draft.owner, { kind: 'staff' });
      assert.deepStrictEqual(draft.content, { type: 'script', script: 'checkin', text: draft.content.text });
      assert.deepStrictEqual(draft.filter.guilds, [GUILD]);
      assert.deepStrictEqual(draft.filter.platforms, ['discord']);
      assert.ok(draft.content.text.length <= 1800, `${draft.title} fits a campaign message`);
      assert.match(draft.content.text, /Start/);
    }
  });

  it('builds filters Doorman accepts', function () {
    const Campaign = doormanCampaign();
    if (!Campaign) this.skip();
    for (const { draft } of checkin.drafts(contract)) {
      const filter = Campaign.filter(Object.assign({ excludeCampaigns: [] }, draft.filter));
      assert.strictEqual(filter.inactiveForDays, draft.filter.inactiveForDays);
    }
  });

  it('offers a script that exists, runs only for members, and records the answers', function () {
    const file = path.join(__dirname, '../contracts/scripts', `${contract.script}.json`);
    const script = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(script.id, 'checkin');
    assert.deepStrictEqual(script.requires, [contract.requirement.name]);
    assert.deepStrictEqual(script.onComplete, [{ action: 'record' }]);
    assert.strictEqual(script.steps.notes.input.optional, true);
  });

  it('touches each member once per tier and never twice within the spacing', function () {
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    const ago = (days) => new Date(now - days * DAY).toISOString();
    const [veryOld, somewhatOld] = checkin.drafts(contract).map((entry) => entry.draft);
    const sentStats = { sent: 4 };
    const earlierSame = { id: 'aaaaaaaaaaaa', title: somewhatOld.title, status: 'sent', startedAt: ago(200), stats: sentStats };
    const recentOther = { id: 'bbbbbbbbbbbb', title: veryOld.title, status: 'sent', startedAt: ago(10), stats: sentStats };
    const oldOther = { id: 'cccccccccccc', title: veryOld.title, status: 'sent', startedAt: ago(45), stats: sentStats };
    const emptyRun = { id: 'dddddddddddd', title: somewhatOld.title, status: 'sent', startedAt: ago(5), stats: { sent: 0 } };
    const recruiting = { id: 'eeeeeeeeeeee', title: 'Recruiting: BRAVO SQUADRON', status: 'sent', startedAt: ago(1), stats: sentStats };
    const never = { id: 'ffffffffffff', title: somewhatOld.title, status: 'cancelled', startedAt: null, stats: { sent: 0 } };

    const fresh = checkin.plan(somewhatOld, [], { spacingDays: 30, now });
    assert.strictEqual(fresh.action, 'create');
    assert.deepStrictEqual(fresh.draft.filter.excludeCampaigns, []);

    const step = checkin.plan(somewhatOld, [earlierSame, recentOther, oldOther, emptyRun, recruiting, never], { spacingDays: 30, now });
    assert.strictEqual(step.action, 'create');
    assert.deepStrictEqual(step.draft.filter.excludeCampaigns, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'],
      'the same tier forever, other tiers within 30 days; not empty runs, never-started ones, or other campaigns');
    assert.strictEqual(step.draft.filter.inactiveForDays, 60, 'the tier filter is kept');

    const open = { id: '111111111111', title: somewhatOld.title, status: 'draft', startedAt: null };
    assert.strictEqual(checkin.plan(somewhatOld, [open], { now }).action, 'update');
    assert.strictEqual(checkin.plan(somewhatOld, [Object.assign({}, open, { status: 'scheduled' })], { now }).action, 'keep');
    assert.strictEqual(checkin.plan(somewhatOld, [Object.assign({}, open, { status: 'sending', startedAt: ago(0) })], { now }).action, 'busy');
  });

  it('keeps the exclusion list within the 50 a filter takes, same tier first', function () {
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    const [veryOld, somewhatOld] = checkin.drafts(contract).map((entry) => entry.draft);
    const runs = [];
    for (let i = 0; i < 49; i++) runs.push({ id: i.toString(16).padStart(12, '0'), title: somewhatOld.title, status: 'sent', startedAt: new Date(now - (100 + i) * DAY).toISOString(), stats: { sent: 1 } });
    runs.push({ id: 'aaaaaaaaaaa1', title: veryOld.title, status: 'sent', startedAt: new Date(now - 2 * DAY).toISOString(), stats: { sent: 1 } });
    runs.push({ id: 'aaaaaaaaaaa2', title: veryOld.title, status: 'sent', startedAt: new Date(now - 3 * DAY).toISOString(), stats: { sent: 1 } });
    const excluded = checkin.plan(somewhatOld, runs, { spacingDays: 30, now }).draft.filter.excludeCampaigns;
    assert.strictEqual(excluded.length, 50);
    assert.strictEqual(excluded[49], 'aaaaaaaaaaa1', 'the newest other-tier run fills the last place');
  });
});
