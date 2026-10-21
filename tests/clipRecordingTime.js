'use strict';

const assert = require('assert');
const {
  parseFilenameTime,
  wallTimeInZone,
  estimateRecordingTime
} = require('../functions/clipRecordingTime');

const wall = (iso) => Date.parse(iso + 'Z');

describe('clipRecordingTime', function () {
  describe('parseFilenameTime', function () {
    it('reads the common recorder file names', function () {
      const cases = [
        ['Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4', 'shadowplay', '2026-10-19T21:33:12.020'],
        ['MedalTVStarCitizen20261019213312.mp4', 'medal', '2026-10-19T21:33:12'],
        ['Star Citizen 10_19_2026 9_33_12 PM.mp4', 'gamebar', '2026-10-19T21:33:12'],
        ['Star Citizen 10_19_2026 12_05_00 AM.mp4', 'gamebar', '2026-10-19T00:05:00'],
        ['2026-10-19 21-33-12.mkv', 'obs', '2026-10-19T21:33:12'],
        ['Star Citizen 2026-10-19 21-33-12.mp4', 'obs', '2026-10-19T21:33:12'],
        ['clip_20261019_213312.mp4', 'compact', '2026-10-19T21:33:12'],
        ['Replay_2026.10.19-21.33.mp4', 'relive', '2026-10-19T21:33:00']
      ];
      for (const [name, pattern, iso] of cases) {
        assert.deepStrictEqual(parseFilenameTime(name), { pattern, wallMs: wall(iso) }, name);
      }
    });

    it('ignores names without a real date', function () {
      assert.strictEqual(parseFilenameTime('gladius_vs_arrow.mp4'), null);
      assert.strictEqual(parseFilenameTime('2026-02-31 10-00-00.mp4'), null);
      assert.strictEqual(parseFilenameTime('1234567890123456.mp4'), null);
      assert.strictEqual(parseFilenameTime(undefined), null);
    });
  });

  describe('wallTimeInZone', function () {
    it('applies the zone offset in effect, including daylight time', function () {
      assert.deepStrictEqual(wallTimeInZone(wall('2026-10-19T21:00:00'), 'America/Chicago'), {
        utcMs: Date.parse('2026-10-20T02:00:00Z'),
        offsetMinutes: -300
      });
      assert.deepStrictEqual(wallTimeInZone(wall('2026-12-19T21:00:00'), 'America/Chicago'), {
        utcMs: Date.parse('2026-12-20T03:00:00Z'),
        offsetMinutes: -360
      });
    });
  });

  describe('estimateRecordingTime', function () {
    const postedAt = '2026-10-20T02:40:00.000Z';

    it('trusts the container creation time first', function () {
      const out = estimateRecordingTime({ creationTime: '2026-10-20T02:33:12Z', postedAt, durationMs: 60000 });
      assert.deepStrictEqual(out, { recordedAt: '2026-10-20T02:33:12.000Z', source: 'metadata', confidence: 'high', offsetMinutes: null, pattern: null });
    });

    it('learns the uploader offset when the file name agrees with the tag', function () {
      const out = estimateRecordingTime({
        filename: 'Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4',
        creationTime: '2026-10-20T02:33:12Z',
        postedAt,
        durationMs: 60000
      });
      assert.strictEqual(out.source, 'metadata');
      assert.strictEqual(out.confidence, 'high');
      assert.strictEqual(out.offsetMinutes, -300);
      assert.strictEqual(out.pattern, 'shadowplay');
    });

    it('ignores creation times that cannot be the recording (epoch, after the post, far before)', function () {
      for (const creationTime of ['1904-01-01T00:00:00Z', '2026-10-21T00:00:00Z', '2025-01-01T00:00:00Z']) {
        const out = estimateRecordingTime({ creationTime, postedAt, durationMs: 60000 });
        assert.strictEqual(out.source, 'posted', creationTime);
        assert.strictEqual(out.recordedAt, '2026-10-20T02:39:00.000Z');
        assert.strictEqual(out.confidence, 'low');
      }
    });

    it('uses a known offset for file-name times', function () {
      const out = estimateRecordingTime({ filename: '2026-10-19 21-33-12.mkv', postedAt: '2026-10-20T08:00:00Z', durationMs: 30000 }, { knownOffsetMinutes: -300 });
      assert.deepStrictEqual(out, { recordedAt: '2026-10-20T02:33:12.000Z', source: 'filename', confidence: 'high', offsetMinutes: -300, pattern: 'obs' });
    });

    it('solves the zone that ends the recording closest before the post', function () {
      const out = estimateRecordingTime({ filename: '2026-10-19 21-33-12.mkv', postedAt, durationMs: 120000 });
      assert.strictEqual(out.source, 'filename');
      assert.strictEqual(out.confidence, 'medium');
      assert.strictEqual(out.offsetMinutes, -300);
      assert.strictEqual(out.recordedAt, '2026-10-20T02:33:12.000Z');
    });

    it('falls back to the default zone when the post came much later', function () {
      const out = estimateRecordingTime({ filename: '2026-10-19 21-33-12.mkv', postedAt: '2026-10-25T00:00:00Z', durationMs: 120000 }, { defaultTimeZone: 'America/Chicago' });
      assert.strictEqual(out.source, 'filename');
      assert.strictEqual(out.confidence, 'low');
      assert.strictEqual(out.recordedAt, '2026-10-20T02:33:12.000Z');
    });

    it('falls back to the post time minus the clip length', function () {
      const out = estimateRecordingTime({ filename: 'gladius.mp4', postedAt, durationMs: 45000 });
      assert.deepStrictEqual(out, { recordedAt: '2026-10-20T02:39:15.000Z', source: 'posted', confidence: 'low', offsetMinutes: null, pattern: null });
    });
  });
});
