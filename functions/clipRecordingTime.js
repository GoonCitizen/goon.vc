'use strict';

/**
 * When was a clip recorded? The original file name is the authority: the
 * recorder named the file when it started. A name re-recorded or trimmed
 * keeps the original's time beside the new one ("vlc-record-<when>-<original
 * name>"), so the earliest time in the name is the recording. Names hold local
 * wall time with no zone; the zone comes from (in order) the file's own
 * metadata (an EXIF / QuickTime offset, or a UTC tag that sits a whole zone
 * offset from a time in the name), the uploader's known offset, the offset
 * that ends the recording closest before the post, else `defaultTimeZone`.
 * Without a time in the name, the metadata dates the clip; without either, the
 * post (or the host's upload, when earlier) minus the clip's length.
 *
 * Metadata hints are `{ field, value }` with an ISO 8601 `value`: `Z` is a UTC
 * instant in an unknown zone, `±hh:mm` an instant in a known zone, and no
 * suffix a local wall time (see `functions/mediaTimeTags.js`).
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Real UTC offsets are whole quarter hours between -12:00 and +14:00.
const MIN_OFFSET = -12 * 60;
const MAX_OFFSET = 14 * 60;
const OFFSET_STEP = 15;
// Offsets zones actually use (whole hours plus the half and three-quarter hours in use),
// so a guess from the post time never lands on +00:45.
const ZONE_OFFSETS = Array.from({ length: 27 }, (_, i) => (i - 12) * 60)
  .concat([-570, -210, -150, 210, 270, 330, 345, 390, 525, 570, 630, 765, 825])
  .sort((a, b) => a - b);
// How much later than the post a recording may claim to start (clock skew).
const POST_SLACK_MS = 2 * MINUTE;
// A metadata time this far before the post is not believed (re-exports, 1904 epochs, …).
const MAX_METADATA_AGE_MS = 60 * 24 * HOUR;
// Past this gap between recording and post, the nearest offset says nothing about the zone.
const MAX_SOLVE_GAP_MS = 6 * HOUR;
// A UTC tag "agrees" with a name time when it is a zone offset away, give or take this.
const AGREE_MS = 90 * 1000;
// Clock differences between the stream host and Discord.
const BROADCAST_SLACK_MS = 10 * MINUTE;

const FILENAME_PATTERNS = [
  // VLC's Record button: "vlc-record-2024-10-30-14h42m26s-<the file it played>.mp4"
  { name: 'vlc', re: /vlc-record-(\d{4})-(\d{2})-(\d{2})-(\d{2})h(\d{2})m(\d{2})s/i, order: 'ymdhms' },
  // NVIDIA ShadowPlay / Instant Replay / screenshots: "Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4"
  // (Discord turns the spaces into underscores.)
  { name: 'shadowplay', re: /(\d{4})\.(\d{2})\.(\d{2})[ _]-[ _](\d{2})\.(\d{2})\.(\d{2})(?:\.(\d{2}))?/, order: 'ymdhms' },
  // Medal: "MedalTVStarCitizen20261019213312.mp4"
  { name: 'medal', re: /medal\w*?(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/i, order: 'ymdhms' },
  // Older Xbox Game Bar: "Star Citizen 10_19_2026 9_33_12 PM.mp4" — the date follows the Windows
  // locale, so "3_08_2026" may be March 8 or 3 August (`alternates`).
  { name: 'gamebar', re: /(\d{1,2})_(\d{1,2})_(\d{4})[ _](\d{1,2})_(\d{2})_(\d{2})[ _]?([AP]M)/i, order: 'mdyhms' },
  // OBS default and current Game Bar: "2026-10-19 21-33-12.mkv", "Star Citizen 2026-10-19 21-33-12.mp4"
  { name: 'obs', re: /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})-(\d{2})-(\d{2})/, order: 'ymdhms' },
  // Steam / phones / AMD ReLive: "clip_20261019_213312.mp4", "Replay_2026.10.19-21.33.mp4"
  { name: 'compact', re: /(?:^|\D)(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?!\d)/, order: 'ymdhms' },
  { name: 'relive', re: /(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})(?:\.(\d{2}))?/, order: 'ymdhms' },
  // Unix time in milliseconds (Twitch clip downloads): "twitch_1779068161192.mp4" — a UTC instant.
  { name: 'epoch', re: /(?:^|\D)(1\d{12})(?!\d)/, order: 'epochms' }
];

function toMs (value) {
  if (value === undefined || value === null || value === '') return NaN;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

function readStamp (pattern, m) {
  if (pattern.order === 'epochms') {
    const utcMs = Number(m[1]);
    const year = new Date(utcMs).getUTCFullYear();
    return year >= 2010 && year <= 2100 ? { pattern: pattern.name, utcMs } : null;
  }
  let year, month, day, hour, minute, second;
  let centis = 0;
  if (pattern.order === 'mdyhms') {
    [month, day, year, hour, minute, second] = m.slice(1, 7).map(Number);
    const pm = /pm/i.test(m[7]);
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (pm ? 12 : 0);
  } else {
    [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
    second = m[6] !== undefined ? Number(m[6]) : 0;
    centis = m[7] !== undefined ? Number(m[7]) : 0;
  }
  if (hour > 23 || minute > 59 || second > 59) return null;
  const at = (y, mo, d) => {
    if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const ms = Date.UTC(y, mo - 1, d, hour, minute, second, centis * 10);
    return new Date(ms).getUTCDate() === d ? ms : null;
  };
  const wallMs = at(year, month, day);
  const swapped = pattern.order === 'mdyhms' && month !== day ? at(year, day, month) : null;
  if (wallMs === null && swapped === null) return null;
  if (wallMs === null) return { pattern: pattern.name, wallMs: swapped };
  return swapped === null ? { pattern: pattern.name, wallMs } : { pattern: pattern.name, wallMs, alternates: [swapped] };
}

/**
 * Of a name time's readings, the one that ends closest before `boundMs`.
 * @private
 */
function pickReading (stamp, boundMs) {
  if (!stamp.alternates || !Number.isFinite(boundMs)) return stamp;
  const latest = boundMs + POST_SLACK_MS + MAX_OFFSET * MINUTE;
  const best = [stamp.wallMs, ...stamp.alternates]
    .filter((ms) => ms <= latest)
    .sort((a, b) => b - a)[0];
  return { pattern: stamp.pattern, wallMs: best === undefined ? stamp.wallMs : best };
}

/**
 * Every time embedded in a file name, in the order they appear.
 * @param {string} filename
 * @returns {Array<{ pattern: string, wallMs?: number, utcMs?: number }>} `wallMs` is local wall time read as if it were UTC; `utcMs` a real instant.
 */
function parseFilenameTimes (filename) {
  const name = String(filename || '');
  const found = [];
  for (const pattern of FILENAME_PATTERNS) {
    const re = new RegExp(pattern.re.source, pattern.re.flags + 'g');
    let m;
    while ((m = re.exec(name))) {
      const start = m.index;
      const end = start + m[0].length;
      if (found.some((f) => start < f.end && end > f.start)) continue;
      const stamp = readStamp(pattern, m);
      if (stamp) found.push({ start, end, stamp });
    }
  }
  return found.sort((a, b) => a.start - b.start).map((f) => f.stamp);
}

/**
 * The original recording's time in a file name: the earliest wall time, else
 * the earliest Unix time.
 * @param {string} filename
 * @returns {{ pattern: string, wallMs?: number, utcMs?: number }|null}
 */
function parseFilenameTime (filename) {
  const stamps = parseFilenameTimes(filename);
  const walls = stamps.filter((s) => s.wallMs !== undefined);
  const pool = walls.length ? walls : stamps;
  if (!pool.length) return null;
  return pool.reduce((best, s) => ((s.wallMs ?? s.utcMs) < (best.wallMs ?? best.utcMs) ? s : best));
}

/**
 * UTC offset of `timeZone` (minutes east of UTC) at the instant `utcMs`.
 * @param {string} timeZone
 * @param {number} utcMs
 * @returns {number|null}
 */
function zoneOffsetMinutes (timeZone, utcMs) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    }).formatToParts(new Date(utcMs));
    const get = (type) => Number((parts.find((p) => p.type === type) || {}).value);
    const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((wall - Math.floor(utcMs / 1000) * 1000) / MINUTE);
  } catch (_) {
    return null;
  }
}

/**
 * Read a zone-less wall time in `timeZone`.
 * @param {number} wallMs
 * @param {string} timeZone
 * @returns {{ utcMs: number, offsetMinutes: number }|null}
 */
function wallTimeInZone (wallMs, timeZone) {
  let offset = zoneOffsetMinutes(timeZone, wallMs);
  if (offset === null) return null;
  // Second pass settles DST edges where the guess crossed a transition.
  const again = zoneOffsetMinutes(timeZone, wallMs - offset * MINUTE);
  if (again !== null) offset = again;
  return { utcMs: wallMs - offset * MINUTE, offsetMinutes: offset };
}

/**
 * The UTC offset that ends the recording closest before the post.
 * @param {number} wallMs
 * @param {number} postedMs
 * @param {number} durationMs
 * @returns {{ utcMs: number, offsetMinutes: number, gapMs: number }|null}
 */
function solveOffset (wallMs, postedMs, durationMs) {
  let best = null;
  for (const offset of ZONE_OFFSETS) {
    const utcMs = wallMs - offset * MINUTE;
    const gapMs = postedMs - (utcMs + durationMs);
    if (gapMs < -POST_SLACK_MS) continue;
    if (!best || gapMs < best.gapMs) best = { utcMs, offsetMinutes: offset, gapMs };
  }
  return best;
}

/**
 * Is `offset` a plausible UTC offset (quarter hours, -12:00 … +14:00)?
 * @param {number} offset minutes
 * @returns {boolean}
 */
function isZoneOffset (offset) {
  return Number.isInteger(offset) && offset % OFFSET_STEP === 0 && offset >= MIN_OFFSET && offset <= MAX_OFFSET;
}

/**
 * The zone offset between a name's wall time and a UTC tag, when the tag marks
 * the start or the end of the recording (muxers stamp either).
 * @param {number} wallMs
 * @param {number} utcMs
 * @param {number} durationMs
 * @returns {number|null} minutes
 */
function agreeingOffset (wallMs, utcMs, durationMs) {
  for (const diff of [wallMs - utcMs, wallMs - (utcMs - durationMs)]) {
    const offset = Math.round(diff / (OFFSET_STEP * MINUTE)) * OFFSET_STEP;
    if (Math.abs(diff - offset * MINUTE) <= AGREE_MS && isZoneOffset(offset)) return offset;
  }
  return null;
}

/**
 * A metadata hint as an instant (with its zone, when named) or a wall time.
 * @param {{ field: string, value: string }} hint
 * @returns {{ field: string, utcMs?: number, offsetMinutes?: number|null, wallMs?: number }|null}
 */
function readHint (hint) {
  if (!hint || typeof hint.value !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})?$/.exec(hint.value.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi, s, frac = '0', zone] = m;
  const wallMs = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), Math.round(Number(`0.${frac}`) * 1000));
  if (!Number.isFinite(wallMs)) return null;
  if (!zone) return { field: hint.field, wallMs };
  if (zone === 'Z') return { field: hint.field, utcMs: wallMs, offsetMinutes: null };
  const sign = zone[0] === '-' ? -1 : 1;
  const offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)));
  return { field: hint.field, utcMs: wallMs - offset * MINUTE, offsetMinutes: offset };
}

/**
 * Estimate when a clip started recording.
 * @param {Object} clip
 * @param {string} [clip.filename] The uploaded file's original name.
 * @param {Array<{ field: string, value: string }>} [clip.timeTags] Times the file's metadata states, most telling first.
 * @param {string} [clip.creationTime] Container `creation_time` tag (older records; read as a `creation_time` hint).
 * @param {string|number} clip.postedAt When the message was posted.
 * @param {string|number} [clip.uploadedAt] When the link's host says the video was uploaded.
 * @param {string|number} [clip.startedAt] When the host says a live broadcast began (a Twitch VOD's start); exact, so it dates the clip.
 * @param {number} [clip.durationMs]
 * @param {Object} [opts]
 * @param {number} [opts.knownOffsetMinutes] The uploader's UTC offset, learned from earlier clips.
 * @param {string} [opts.defaultTimeZone] Zone for wall times that can't be placed otherwise.
 * @returns {{ recordedAt: string, source: string, confidence: string, offsetMinutes: number|null, pattern: string|null, zone: string|null, field: string|null }}
 *   `source` is `broadcast`, `filename`, `metadata`, `uploaded`, or `posted`; `zone` says where the offset came from
 *   (`metadata`, `author`, `post`, `default`); `field` is the metadata field that dated the clip or set its zone.
 */
function estimateRecordingTime (clip = {}, opts = {}) {
  const postedMs = toMs(clip.postedAt);
  const uploadedMs = toMs(clip.uploadedAt);
  const durationMs = Math.max(0, Number(clip.durationMs) || 0);
  const useUpload = Number.isFinite(uploadedMs) && new Date(uploadedMs).getUTCFullYear() >= 2010 &&
    (!Number.isFinite(postedMs) || (uploadedMs < postedMs && postedMs - uploadedMs <= MAX_METADATA_AGE_MS));
  // The recording ended before it was posted, and before its host had it.
  const boundMs = useUpload ? uploadedMs : postedMs;
  const bounded = Number.isFinite(boundMs);

  const plausibleInstant = (ms) => Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= 2010 &&
    (!bounded || (ms <= boundMs + POST_SLACK_MS && boundMs - ms <= MAX_METADATA_AGE_MS));
  const plausibleWall = (ms) => Number.isFinite(ms) && new Date(ms).getUTCFullYear() >= 2010 &&
    (!bounded || (ms <= boundMs + POST_SLACK_MS + MAX_OFFSET * MINUTE && boundMs - ms <= MAX_METADATA_AGE_MS - MIN_OFFSET * MINUTE));
  const endsInTime = (utcMs) => !bounded || utcMs + durationMs <= boundMs + POST_SLACK_MS;

  const stamps = parseFilenameTimes(clip.filename).map((s) => pickReading(s, boundMs));
  const walls = stamps.filter((s) => s.wallMs !== undefined);
  const named = walls.length ? walls.reduce((a, b) => (b.wallMs < a.wallMs ? b : a)) : null;
  const epochs = stamps.filter((s) => s.utcMs !== undefined && plausibleInstant(s.utcMs));

  const rawHints = Array.isArray(clip.timeTags) ? clip.timeTags.slice() : [];
  if (clip.creationTime && !rawHints.some((h) => h && h.field === 'creation_time')) {
    const at = toMs(clip.creationTime);
    if (Number.isFinite(at)) rawHints.push({ field: 'creation_time', value: new Date(at).toISOString() });
  }
  const hints = rawHints.map(readHint).filter((h) => h && (h.utcMs !== undefined ? plausibleInstant(h.utcMs) : plausibleWall(h.wallMs)));
  const instants = hints.filter((h) => h.utcMs !== undefined)
    .concat(epochs.map((s) => ({ field: 'filename', utcMs: s.utcMs, offsetMinutes: null })));

  const result = (utcMs, source, confidence, extra = {}) => ({
    recordedAt: new Date(utcMs).toISOString(),
    source,
    confidence,
    offsetMinutes: extra.offsetMinutes ?? null,
    pattern: extra.pattern ?? null,
    zone: extra.zone ?? null,
    field: extra.field ?? null
  });

  // A local wall time with no zone from the file itself.
  const placeWall = (wallMs, source, extra) => {
    const known = Number(opts.knownOffsetMinutes);
    if (opts.knownOffsetMinutes !== undefined && opts.knownOffsetMinutes !== null && isZoneOffset(known)) {
      return result(wallMs - known * MINUTE, source, 'high', { ...extra, offsetMinutes: known, zone: 'author' });
    }
    if (bounded) {
      const solved = solveOffset(wallMs, boundMs, durationMs);
      if (solved && solved.gapMs <= MAX_SOLVE_GAP_MS) {
        return result(solved.utcMs, source, 'medium', { ...extra, offsetMinutes: solved.offsetMinutes, zone: 'post' });
      }
    }
    const zoned = wallTimeInZone(wallMs, opts.defaultTimeZone || 'UTC');
    if (zoned) return result(zoned.utcMs, source, 'low', { ...extra, offsetMinutes: zoned.offsetMinutes, zone: 'default' });
    return null;
  };

  // A stream is announced once it is live, so its start comes before the post.
  const startedMs = toMs(clip.startedAt);
  if (Number.isFinite(startedMs) && new Date(startedMs).getUTCFullYear() >= 2010 &&
    (!Number.isFinite(postedMs) || (startedMs <= postedMs + BROADCAST_SLACK_MS && postedMs - startedMs <= MAX_METADATA_AGE_MS))) {
    return result(startedMs, 'broadcast', 'high', { field: 'startedAt' });
  }

  if (named) {
    const extra = { pattern: named.pattern };
    for (const hint of instants) {
      if (hint.offsetMinutes !== null && isZoneOffset(hint.offsetMinutes)) {
        const utcMs = named.wallMs - hint.offsetMinutes * MINUTE;
        if (!endsInTime(utcMs)) continue;
        const agrees = walls.some((w) => Math.abs((w.wallMs - hint.offsetMinutes * MINUTE) - hint.utcMs) <= AGREE_MS + durationMs);
        return result(utcMs, 'filename', agrees ? 'high' : 'medium', { ...extra, offsetMinutes: hint.offsetMinutes, zone: 'metadata', field: hint.field });
      }
      for (const w of walls) {
        const offset = agreeingOffset(w.wallMs, hint.utcMs, durationMs);
        if (offset === null || !endsInTime(named.wallMs - offset * MINUTE)) continue;
        return result(named.wallMs - offset * MINUTE, 'filename', 'high', { ...extra, offsetMinutes: offset, zone: 'metadata', field: hint.field });
      }
    }
    const placed = placeWall(named.wallMs, 'filename', extra);
    if (placed) return placed;
  }

  if (epochs.length) {
    const first = epochs.reduce((a, b) => (b.utcMs < a.utcMs ? b : a));
    return result(first.utcMs, 'filename', 'high', { pattern: first.pattern });
  }
  const instant = hints.find((h) => h.utcMs !== undefined);
  if (instant) {
    return result(instant.utcMs, 'metadata', 'high', {
      offsetMinutes: instant.offsetMinutes,
      zone: instant.offsetMinutes !== null ? 'metadata' : null,
      field: instant.field
    });
  }
  const wall = hints.find((h) => h.wallMs !== undefined);
  if (wall) {
    const placed = placeWall(wall.wallMs, 'metadata', { field: wall.field });
    if (placed) return placed;
  }

  if (bounded) return result(boundMs - durationMs, useUpload ? 'uploaded' : 'posted', 'low');
  return result(Date.now(), 'unknown', 'low');
}

module.exports = {
  FILENAME_PATTERNS,
  parseFilenameTimes,
  parseFilenameTime,
  zoneOffsetMinutes,
  wallTimeInZone,
  solveOffset,
  isZoneOffset,
  agreeingOffset,
  readHint,
  estimateRecordingTime
};
