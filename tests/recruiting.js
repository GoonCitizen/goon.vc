'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const recruiting = require('../functions/recruiting');

const PROSPECT_IV = '1234739335312703548';

describe('Recruiting campaigns', function () {
  const contract = recruiting.load();

  it('recruits TURTLE BRIGADE, BRAVO SQUADRON, and PERMAFLEET OFFICERS from Prospect IV', function () {
    assert.strictEqual(contract.guildId, '1190527980120850493');
    assert.deepStrictEqual(recruiting.requirements(contract), { '[P4] Prospect IV': [PROSPECT_IV] });
    const drafts = recruiting.drafts(contract);
    assert.deepStrictEqual(drafts.map((entry) => entry.unit), ['turtle-brigade', 'bravo-squadron', 'permafleet-officers']);
    for (const { draft } of drafts) {
      assert.deepStrictEqual(draft.owner, { kind: 'staff' });
      assert.strictEqual(draft.content.type, 'script');
      assert.deepStrictEqual(draft.filter.guilds, ['1190527980120850493'], 'the home server only');
      assert.deepStrictEqual(draft.filter.roles, [PROSPECT_IV]);
      assert.ok(!draft.filter.excludeRoles.includes(PROSPECT_IV));
      assert.ok(draft.content.text.length <= 1800, `${draft.title} fits a campaign message`);
      assert.ok(!/selected at|promoted to/i.test(draft.content.text), 'Prospect IV makes a member eligible, never selected');
    }
    const byUnit = Object.fromEntries(drafts.map((entry) => [entry.unit, entry.draft]));
    assert.ok(byUnit['turtle-brigade'].filter.excludeRoles.includes('1518976133515837521'), 'SHELLBACK already passed TURTLE BRIGADE');
    assert.ok(byUnit['bravo-squadron'].filter.excludeRoles.includes('1205021280747651112'), 'ALPHA SQUADRON already passed BRAVO');
    assert.ok(byUnit['permafleet-officers'].filter.excludeRoles.includes('1234740074546204733'), 'Lieutenants are already officers');
  });

  it('offers a script that exists and requires the qualifying rank', function () {
    for (const unit of contract.units) {
      const file = path.join(__dirname, '../contracts/scripts', `${unit.script}.json`);
      const script = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(script.id, unit.script);
      assert.deepStrictEqual(script.requires, [contract.qualified.name]);
      assert.deepStrictEqual(script.onComplete, [{ action: 'record' }]);
    }
  });

  it('creates, updates, or leaves a campaign, skipping members earlier ones reached', function () {
    const { draft } = recruiting.drafts(contract)[0];
    const old = { id: 'aaaaaaaaaaaa', title: draft.title, status: 'sent', startedAt: '2026-09-01T00:00:00.000Z' };
    const older = { id: 'bbbbbbbbbbbb', title: draft.title, status: 'cancelled', startedAt: '2026-08-01T00:00:00.000Z' };
    const abandoned = { id: 'cccccccccccc', title: draft.title, status: 'cancelled', startedAt: null };
    const other = { id: 'dddddddddddd', title: 'Recruiting: RAT SQUADRON', status: 'sent', startedAt: '2026-10-01T00:00:00.000Z' };

    const fresh = recruiting.plan(draft, []);
    assert.strictEqual(fresh.action, 'create');
    assert.deepStrictEqual(fresh.draft.filter.excludeCampaigns, []);

    const again = recruiting.plan(draft, [older, old, abandoned, other]);
    assert.strictEqual(again.action, 'create');
    assert.deepStrictEqual(again.draft.filter.excludeCampaigns, ['aaaaaaaaaaaa', 'bbbbbbbbbbbb'], 'newest first, never-started and other units left out');

    const open = { id: 'eeeeeeeeeeee', title: draft.title, status: 'draft', startedAt: null };
    assert.deepStrictEqual(recruiting.plan(draft, [old, open]).action, 'update');
    assert.strictEqual(recruiting.plan(draft, [old, open]).id, 'eeeeeeeeeeee');
    assert.strictEqual(recruiting.plan(draft, [Object.assign({}, open, { status: 'scheduled' })]).action, 'keep');
    assert.strictEqual(recruiting.plan(draft, [open, Object.assign({}, old, { status: 'sending' })]).action, 'busy');
  });
});
