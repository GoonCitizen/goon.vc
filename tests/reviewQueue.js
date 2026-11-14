'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Members = require('../services/members');
const { memberNeedsReview, officerSymbols } = require('../functions/reviewOfficers');

const REMAEUS = '420222636954615808';
const MEANER = '503419731286556703';

describe('review queue', function () {
  this.timeout(20000);

  it('treats alliance and RED ARMY officers as the people who need approval', function () {
    assert.deepStrictEqual(officerSymbols({ accounts: [{ platform: 'discord', id: REMAEUS }] }), ['G00N']);
    assert.deepStrictEqual(officerSymbols({ accounts: [{ platform: 'discord', id: MEANER }] }), ['RR']);
    assert.deepStrictEqual(officerSymbols({ accounts: [{ platform: 'discord', id: '111111111111111111' }] }), []);
    assert.strictEqual(memberNeedsReview({ accounts: [{ platform: 'discord', id: REMAEUS }] }), true);
    assert.strictEqual(memberNeedsReview({ accounts: [{ platform: 'rsi', id: 'ChairmanPoW' }] }), false);
  });

  it('approves everyone except officers, and approving one officer leaves the other waiting', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-review-queue-'));
    const members = new Members({
      path: dir,
      review: true,
      needsReview: (member) => memberNeedsReview(member)
    });
    try {
      await members.start();
      const officer = await members.memberFor(`discord:${REMAEUS}`, {
        create: true,
        via: 'oauth',
        displayName: 'Remaeus',
        profile: { username: 'remaeus' }
      });
      const friend = await members.memberFor('discord:111111111111111111', {
        create: true,
        via: 'oauth',
        displayName: 'Pilot',
        profile: { username: 'pilot' }
      });
      const queued = await members.requestReview(officer.id);
      const released = await members.requestReview(friend.id);
      assert.strictEqual(queued.review.status, 'pending');
      assert.strictEqual(released.review.status, 'approved');
      assert.strictEqual(released.review.auto, true);
      assert.deepStrictEqual((await members.pendingReviews()).map((member) => member.id), [officer.id]);

      const second = await members.memberFor(`discord:${MEANER}`, {
        create: true,
        via: 'oauth',
        displayName: 'Meaner',
        profile: { username: 'mr_meaner' }
      });
      await members.requestReview(second.id);
      const decided = await members.decideReview(officer.id, 'approved', { by: 'discord:1' });
      assert.strictEqual(decided.changed, true);
      assert.deepStrictEqual((await members.pendingReviews()).map((member) => member.displayName), ['Meaner']);

      const denied = await members.memberFor('discord:333333333333333333', {
        create: true,
        via: 'oauth',
        displayName: 'Denied',
        profile: { username: 'denied' }
      });
      denied.review = { status: 'denied', requestedAt: new Date().toISOString(), reviewedAt: new Date().toISOString() };
      await members.store.set(`/members/${denied.id}`, denied);
      const session = await members._createSession(denied.id, 'discord');
      const seen = await members.currentMember({ headers: { cookie: `goon.member=${session}` } });
      assert.strictEqual(seen.member.review.status, 'approved');
      assert.strictEqual(seen.member.review.auto, true);
    } finally {
      await members.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the rest of an older combined queue when one officer is approved', async function () {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-review-legacy-'));
    const members = new Members({ path: dir, review: true, needsReview: () => true });
    try {
      await members.start();
      const first = await members.memberFor('discord:111111111111111111', {
        create: true, via: 'oauth', displayName: 'One', profile: { username: 'one' }
      });
      const second = await members.memberFor('discord:222222222222222222', {
        create: true, via: 'oauth', displayName: 'Two', profile: { username: 'two' }
      });
      const at = new Date().toISOString();
      for (const member of [first, second]) {
        member.review = { status: 'pending', requestedAt: at };
        await members.store.set(`/members/${member.id}`, member);
      }
      await members.store.set('/reviews/pending', { [first.id]: at, [second.id]: at });
      assert.deepStrictEqual((await members.pendingReviews()).map((member) => member.displayName).sort(), ['One', 'Two']);
      await members.decideReview(first.id, 'approved', { by: 'discord:1' });
      assert.deepStrictEqual((await members.pendingReviews()).map((member) => member.displayName), ['Two']);
    } finally {
      await members.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
