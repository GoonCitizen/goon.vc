'use strict';

const assert = require('assert');
const { groupSessions, clipStartMs, assignLanes } = require('../functions/clipTimeline');

const T0 = Date.parse('2026-10-20T02:00:00Z');
const MIN = 60 * 1000;

function clip (id, author, startMin, lengthMin, extra) {
  return Object.assign({
    id,
    author,
    channelName: 'clips',
    durationMs: lengthMin * MIN,
    recording: { recordedAt: new Date(T0 + startMin * MIN).toISOString() }
  }, extra || {});
}

describe('clipTimeline', function () {
  it('applies overrides and sync nudges to the start', function () {
    assert.strictEqual(clipStartMs(clip('1', 'Ace', 0, 1)), T0);
    assert.strictEqual(clipStartMs(clip('1', 'Ace', 0, 1, { override: { syncOffsetMs: -1500 } })), T0 - 1500);
    assert.strictEqual(clipStartMs(clip('1', 'Ace', 0, 1, { override: { recordedAt: '2026-10-20T03:00:00Z', syncOffsetMs: 500 } })), T0 + 60 * MIN + 500);
    assert.ok(Number.isNaN(clipStartMs({ id: 'x' })));
  });

  it('puts overlapping clips on separate lanes', function () {
    assert.deepStrictEqual(assignLanes([
      { startMs: 0, endMs: 10 },
      { startMs: 5, endMs: 8 },
      { startMs: 9, endMs: 12 },
      { startMs: 10, endMs: 11 }
    ]), [0, 1, 1, 0]);
  });

  it('groups by recording time with a gap, newest session first', function () {
    const sessions = groupSessions([
      clip('a', 'Ace', 0, 2),
      clip('b', 'Bix', 1, 3),
      clip('c', 'Ace', 12, 1), // 8 minutes after b ends: same session
      clip('d', 'Cy', 40, 1), // 27 minutes later: new session
      { id: 'e', author: 'Nobody', durationMs: MIN } // no recording time: left out
    ], { gapMs: 10 * MIN });
    assert.strictEqual(sessions.length, 2);
    assert.deepStrictEqual(sessions.map((s) => s.id), ['s-d', 's-a']);
    const first = sessions[1];
    assert.strictEqual(first.startsAt, '2026-10-20T02:00:00.000Z');
    assert.strictEqual(first.endsAt, '2026-10-20T02:13:00.000Z');
    assert.strictEqual(first.clipCount, 3);
    assert.deepStrictEqual(first.authors, ['Ace', 'Bix']);
    assert.deepStrictEqual(first.tracks[0], {
      author: 'Ace',
      lanes: 1,
      clips: [
        { id: 'a', lane: 0, offsetMs: 0, durationMs: 2 * MIN },
        { id: 'c', lane: 0, offsetMs: 12 * MIN, durationMs: MIN }
      ]
    });
    assert.deepStrictEqual(first.tracks[1].clips, [{ id: 'b', lane: 0, offsetMs: MIN, durationMs: 3 * MIN }]);
    assert.deepStrictEqual(first.channels, ['clips']);
  });

  it('splits sessions when the gap is smaller', function () {
    const sessions = groupSessions([clip('a', 'Ace', 0, 2), clip('c', 'Ace', 12, 1)], { gapMs: 5 * MIN });
    assert.strictEqual(sessions.length, 2);
  });

  it('keeps a multi-hour play session together by default, but not separate evenings', function () {
    const sessions = groupSessions([
      clip('a', 'Ace', 0, 2),
      clip('b', 'Bix', 70, 1),
      clip('c', 'Ace', 180, 3),
      clip('d', 'Ace', 290, 1),
      clip('e', 'Bix', 24 * 60, 1)
    ]);
    assert.deepStrictEqual(sessions.map((s) => s.clipCount), [1, 4], 'newest first');
    assert.strictEqual(sessions[1].durationMs, 291 * MIN);
  });

  it('stacks one pilot\'s overlapping clips on lanes', function () {
    const [session] = groupSessions([clip('a', 'Ace', 0, 5), clip('b', 'Ace', 2, 1)]);
    assert.strictEqual(session.tracks[0].lanes, 2);
    assert.deepStrictEqual(session.tracks[0].clips.map((c) => c.lane), [0, 1]);
  });
});
