'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const welcome = require('../functions/welcome');
const recruiting = require('../functions/recruiting');

const GUILD = '1190527980120850493';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('Welcome DMs (join PERMAFLEET)', function () {
  const contract = welcome.load();

  it('invites members of the home server a day after they join, looking back 30 days', function () {
    assert.strictEqual(contract.guildId, GUILD);
    assert.deepStrictEqual(welcome.requirements(contract), { 'G00N SQUAD member': [GUILD] }, 'the @everyone role: members of the home server');
    const now = Date.parse('2026-10-25T12:00:00.000Z');
    assert.deepStrictEqual(welcome.joinedWindow(contract, now), { from: now - 30 * DAY, to: now - 24 * HOUR });
    const draft = welcome.draft(contract);
    assert.deepStrictEqual(draft.owner, { kind: 'staff' });
    assert.deepStrictEqual(draft.content, { type: 'script', script: 'permafleet-apply', text: contract.message });
    assert.deepStrictEqual(draft.filter.guilds, [GUILD]);
    assert.deepStrictEqual(draft.filter.platforms, ['discord']);
    assert.ok(contract.message.length <= 1800, 'fits a campaign message');
    assert.match(contract.message, /robertsspaceindustries\.com\/orgs\/PERMAFLEET/);
    assert.match(contract.message, /Prospect I\b/);
    assert.match(contract.message, /\*\*Start\*\*/);
  });

  it('skips alliance org members, Org Stewards, and anyone already in the PERMAFLEET program', function () {
    const roles = welcome.excludedRoles(contract);
    const names = Object.assign({}, ...Object.values(contract.exclude));
    for (const name of ['[INFN] INFINITY INDUSTRIES', '[TRDE] TRANS-GALACTIC', '[LCRP] LEGACY CORP', 'DOUBLEDOG DELIVERY, INC.', '[4M] 4M Contractors', '[AIM] A.I.M.O.S.', 'Risky Business', 'G00N SQUAD', 'ORG STEWARDS', 'PERMAFLEET', '[P] Prospect I', '[E1] Enlisted 1']) {
      assert.ok(roles.includes(names[name]), `${name} is excluded`);
    }
    assert.ok(!Object.keys(names).includes('PERMAFLEET GUESTS'), 'guests are who we want to bring in');
    assert.ok(roles.every((id) => /^\d{17,20}$/.test(id)), 'role ids are snowflakes');
    assert.strictEqual(new Set(roles).size, roles.length);
    assert.deepStrictEqual(welcome.draft(contract).filter.excludeRoles, roles);
    // Every alliance org in contracts/alliance.json has its Discord role here.
    const symbols = require('../contracts/alliance.json').organizations.map((org) => org.symbol);
    assert.strictEqual(Object.keys(contract.exclude.alliance).filter((name) => name !== 'ORG STEWARDS').length, symbols.length);
    // Prospect ranks are cumulative on Discord, so Prospect I covers everyone above it too.
    assert.notStrictEqual(names['[P] Prospect I'], recruiting.load().qualified.roles['[P4] Prospect IV']);
  });

  it('counts a member as welcomed by any welcome delivery but a cancelled one', function () {
    const campaigns = [
      { id: 'aaaaaaaaaaaa', title: contract.title },
      { id: 'bbbbbbbbbbbb', title: contract.title },
      { id: 'cccccccccccc', title: 'Check-in: very old (120+ days)' }
    ];
    const deliveries = {
      aaaaaaaaaaaa: { 'discord/users/1': { status: 'sent' }, 'discord/users/2': { status: 'closed' }, 'discord/users/3': { status: 'cancelled' } },
      bbbbbbbbbbbb: { 'discord/users/4': { status: 'pending' }, 'discord/users/5': { status: 'failed' } },
      cccccccccccc: { 'discord/users/6': { status: 'sent' } }
    };
    assert.deepStrictEqual([...welcome.reached(contract, campaigns, deliveries)].sort(), ['discord/users/1', 'discord/users/2', 'discord/users/4', 'discord/users/5']);
    assert.strictEqual(welcome.reached(contract, campaigns, undefined).size, 0);
  });

  it('offers a script that exists, runs only for members, and records the answers', function () {
    const file = path.join(__dirname, '../contracts/scripts', `${contract.script}.json`);
    const script = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(script.id, 'permafleet-apply');
    assert.deepStrictEqual(script.requires, [contract.requirement.name]);
    assert.deepStrictEqual(script.onComplete, [{ action: 'record' }]);
    assert.match(script.steps.rsi.say, /robertsspaceindustries\.com\/orgs\/PERMAFLEET/);
    assert.ok(script.steps.handle.input.pattern, 'the RSI handle is checked');
    assert.strictEqual(script.steps.notes.input.optional, true);
    for (const [id, step] of Object.entries(script.steps)) {
      assert.ok(step.next === null || script.steps[step.next], `${id} → ${step.next}`);
    }
  });
});
