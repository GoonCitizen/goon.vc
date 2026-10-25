'use strict';

const assert = require('assert');
const {
  parseFilenameTime,
  parseFilenameTimes,
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

    it('reads names as Discord stores them, spaces turned into underscores', function () {
      assert.deepStrictEqual(parseFilenameTime('Squadron_42_-_Star_Citizen_Screenshot_2026.08.29_-_19.46.05.59.png'), { pattern: 'shadowplay', wallMs: wall('2026-08-29T19:46:05.590') });
      assert.deepStrictEqual(parseFilenameTime('Star_Citizen_10_19_2026_9_33_12_PM.mp4'), { pattern: 'gamebar', wallMs: wall('2026-10-19T21:33:12') });
      assert.deepStrictEqual(parseFilenameTime('Star_Citizen_2024-05-11_20-31-14.mp4'), { pattern: 'obs', wallMs: wall('2024-05-11T20:31:14') });
    });

    it('takes the original recording from a re-recorded name: the earliest time in it', function () {
      const name = 'vlc-record-2024-11-11-16h42m02s-vlc-record-2024-11-11-16h40m15s-Squadron_42_-_Star_Citizen_2024.11.10_-_16.42.24.01.mp4-.mp4-.mp4';
      assert.deepStrictEqual(parseFilenameTimes(name).map((s) => s.pattern), ['vlc', 'vlc', 'shadowplay']);
      assert.deepStrictEqual(parseFilenameTime(name), { pattern: 'shadowplay', wallMs: wall('2024-11-10T16:42:24.010') });
    });

    it('reads Unix milliseconds as a UTC instant', function () {
      assert.deepStrictEqual(parseFilenameTime('twitch_1779068161192.mp4'), { pattern: 'epoch', utcMs: 1779068161192 });
    });

    it('keeps both readings of a Game Bar date when day and month could swap', function () {
      const stamp = parseFilenameTimes('Star_Citizen_3_08_2026_7_52_23_PM.png')[0];
      assert.strictEqual(stamp.wallMs, wall('2026-03-08T19:52:23'));
      assert.deepStrictEqual(stamp.alternates, [wall('2026-08-03T19:52:23')]);
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
    const shadowplay = 'Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4';

    it('dates a clip without a time in its name by its metadata', function () {
      const out = estimateRecordingTime({ creationTime: '2026-10-20T02:33:12Z', postedAt, durationMs: 60000 });
      assert.deepStrictEqual(out, { recordedAt: '2026-10-20T02:33:12.000Z', source: 'metadata', confidence: 'high', offsetMinutes: null, pattern: null, zone: null, field: 'creation_time' });
    });

    it('prefers the file name, taking its zone from a metadata time that agrees', function () {
      const out = estimateRecordingTime({ filename: shadowplay, creationTime: '2026-10-20T02:33:12Z', postedAt, durationMs: 60000 });
      assert.deepStrictEqual(out, { recordedAt: '2026-10-20T02:33:12.020Z', source: 'filename', confidence: 'high', offsetMinutes: -300, pattern: 'shadowplay', zone: 'metadata', field: 'creation_time' });
    });

    it('agrees with a tag stamped when the recording ended', function () {
      const out = estimateRecordingTime({ filename: shadowplay, timeTags: [{ field: 'creation_time', value: '2026-10-20T02:34:12Z' }], postedAt, durationMs: 60000 });
      assert.deepStrictEqual([out.recordedAt, out.offsetMinutes, out.zone], ['2026-10-20T02:33:12.020Z', -300, 'metadata']);
    });

    it('keeps the file name when the metadata disagrees (a re-export stamps its own time)', function () {
      const out = estimateRecordingTime({ filename: shadowplay, creationTime: '2026-10-20T02:38:00Z', postedAt, durationMs: 60000 });
      assert.deepStrictEqual([out.recordedAt, out.source, out.confidence, out.zone], ['2026-10-20T02:33:12.020Z', 'filename', 'medium', 'post']);
    });

    it('dates a VLC re-recording by the original name, zoned by the re-record time and its tag', function () {
      const out = estimateRecordingTime({
        filename: 'vlc-record-2024-10-30-14h42m26s-Squadron_42_-_Star_Citizen_2024.10.30_-_14.40.26.06.DVR.mp4-.mp4',
        creationTime: '2024-10-30T01:43:18.000000Z',
        postedAt: '2024-10-30T02:51:21.694Z',
        durationMs: 51484
      });
      assert.deepStrictEqual([out.recordedAt, out.source, out.confidence, out.offsetMinutes, out.pattern, out.zone], ['2024-10-30T01:40:26.060Z', 'filename', 'high', 780, 'shadowplay', 'metadata']);
    });

    it('takes the zone an EXIF or QuickTime time names', function () {
      const named = estimateRecordingTime({ filename: shadowplay, timeTags: [{ field: 'exif:DateTimeOriginal', value: '2026-10-19T21:33:12.020-05:00' }], postedAt });
      assert.deepStrictEqual([named.recordedAt, named.source, named.confidence, named.offsetMinutes, named.field], ['2026-10-20T02:33:12.020Z', 'filename', 'high', -300, 'exif:DateTimeOriginal']);
      const bare = estimateRecordingTime({ filename: 'IMG_0412.jpg', timeTags: [{ field: 'exif:DateTimeOriginal', value: '2026-10-19T21:33:12-05:00' }], postedAt });
      assert.deepStrictEqual([bare.recordedAt, bare.source, bare.confidence, bare.offsetMinutes, bare.zone], ['2026-10-20T02:33:12.000Z', 'metadata', 'high', -300, 'metadata']);
    });

    it('places a metadata wall time like a file name time', function () {
      const out = estimateRecordingTime({ filename: 'IMG_0412.jpg', timeTags: [{ field: 'exif:DateTimeOriginal', value: '2026-10-19T21:33:12' }], postedAt }, { knownOffsetMinutes: -300 });
      assert.deepStrictEqual([out.recordedAt, out.source, out.confidence, out.zone, out.field], ['2026-10-20T02:33:12.000Z', 'metadata', 'high', 'author', 'exif:DateTimeOriginal']);
    });

    it('dates Unix-millisecond names exactly', function () {
      const out = estimateRecordingTime({ filename: 'twitch_1779068161192.mp4', postedAt: '2026-05-18T01:37:12.263Z', durationMs: 20016 });
      assert.deepStrictEqual([out.recordedAt, out.source, out.confidence, out.pattern], ['2026-05-18T01:36:01.192Z', 'filename', 'high', 'epoch']);
    });

    it('reads a swappable Game Bar date the way that fits the post', function () {
      const out = estimateRecordingTime({ filename: 'Star_Citizen_3_08_2026_8_12_43_AM.png', postedAt: '2026-08-03T07:28:45.960Z' });
      assert.deepStrictEqual([out.recordedAt, out.offsetMinutes], ['2026-08-03T07:12:43.000Z', 60]);
    });

    it('ignores metadata times that cannot be the recording (epoch, after the post, far before)', function () {
      for (const creationTime of ['1904-01-01T00:00:00Z', '2026-10-21T00:00:00Z', '2025-01-01T00:00:00Z']) {
        const out = estimateRecordingTime({ creationTime, postedAt, durationMs: 60000 });
        assert.strictEqual(out.source, 'posted', creationTime);
        assert.strictEqual(out.recordedAt, '2026-10-20T02:39:00.000Z');
        assert.strictEqual(out.confidence, 'low');
      }
    });

    it('uses a known offset for file-name times', function () {
      const out = estimateRecordingTime({ filename: '2026-10-19 21-33-12.mkv', postedAt: '2026-10-20T08:00:00Z', durationMs: 30000 }, { knownOffsetMinutes: -300 });
      assert.deepStrictEqual(out, { recordedAt: '2026-10-20T02:33:12.000Z', source: 'filename', confidence: 'high', offsetMinutes: -300, pattern: 'obs', zone: 'author', field: null });
    });

    it('solves the real zone that ends the recording closest before the post', function () {
      const out = estimateRecordingTime({ filename: '2026-10-19 21-33-12.mkv', postedAt, durationMs: 120000 });
      assert.deepStrictEqual([out.source, out.confidence, out.offsetMinutes, out.zone, out.recordedAt], ['filename', 'medium', -300, 'post', '2026-10-20T02:33:12.000Z']);
      const early = estimateRecordingTime({ filename: '2026-10-19 21-33-12.mkv', postedAt: '2026-10-20T02:20:00Z' });
      assert.strictEqual(early.offsetMinutes, -240, 'a zone in use, not -04:45');
    });

    it('bounds the recording by the host\'s upload when it came before the post', function () {
      const out = estimateRecordingTime({ postedAt, uploadedAt: '2026-10-20T02:30:00Z', durationMs: 60000 });
      assert.deepStrictEqual([out.recordedAt, out.source, out.confidence], ['2026-10-20T02:29:00.000Z', 'uploaded', 'low']);
    });

    it('falls back to the default zone when the post came much later', function () {
      const out = estimateRecordingTime({ filename: '2026-10-19 21-33-12.mkv', postedAt: '2026-10-25T00:00:00Z', durationMs: 120000 }, { defaultTimeZone: 'America/Chicago' });
      assert.deepStrictEqual([out.source, out.confidence, out.zone, out.recordedAt], ['filename', 'low', 'default', '2026-10-20T02:33:12.000Z']);
    });

    it('falls back to the post time minus the clip length', function () {
      const out = estimateRecordingTime({ filename: 'gladius.mp4', postedAt, durationMs: 45000 });
      assert.deepStrictEqual(out, { recordedAt: '2026-10-20T02:39:15.000Z', source: 'posted', confidence: 'low', offsetMinutes: null, pattern: null, zone: null, field: null });
    });

    it('dates a broadcast by when it went live, whatever else it carries', function () {
      const out = estimateRecordingTime({ filename: 'Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4', startedAt: '2026-10-20T01:02:00Z', postedAt, durationMs: 3 * 3600000 });
      assert.deepStrictEqual(out, { recordedAt: '2026-10-20T01:02:00.000Z', source: 'broadcast', confidence: 'high', offsetMinutes: null, pattern: null, zone: null, field: 'startedAt' });
    });

    it('ignores a broadcast start well after the post', function () {
      const out = estimateRecordingTime({ startedAt: '2026-10-20T04:00:00Z', postedAt, durationMs: 45000 });
      assert.strictEqual(out.source, 'posted');
    });
  });
});
