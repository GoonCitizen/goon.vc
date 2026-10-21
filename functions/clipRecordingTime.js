'use strict';

/**
 * When was a clip recorded? Discord only knows when it was posted, so the
 * estimate comes from (in order) the container's `creation_time` tag, a
 * timestamp in the file name, or the post time minus the clip's length.
 * File-name timestamps are local time with no zone; the zone is the uploader's
 * known offset when we have one, else the offset that puts the recording
 * closest before the post, else `defaultTimeZone`.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// Real UTC offsets are whole quarter hours between -12:00 and +14:00.
const MIN_OFFSET = -12 * 60;
const MAX_OFFSET = 14 * 60;
const OFFSET_STEP = 15;
// How much later than the post a recording may claim to start (clock skew).
const POST_SLACK_MS = 2 * MINUTE;
// A metadata time this far before the post is not believed (re-exports, 1904 epochs, …).
const MAX_METADATA_AGE_MS = 60 * 24 * HOUR;
// Past this gap between recording and post, the nearest offset says nothing about the zone.
const MAX_SOLVE_GAP_MS = 6 * HOUR;

const FILENAME_PATTERNS = [
  // NVIDIA ShadowPlay / Instant Replay: "Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4"
  { name: 'shadowplay', re: /(\d{4})\.(\d{2})\.(\d{2}) - (\d{2})\.(\d{2})\.(\d{2})(?:\.(\d{2}))?/, order: 'ymdhms' },
  // Medal: "MedalTVStarCitizen20261019213312.mp4"
  { name: 'medal', re: /medal\w*?(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/i, order: 'ymdhms' },
  // Older Xbox Game Bar: "Star Citizen 10_19_2026 9_33_12 PM.mp4"
  { name: 'gamebar', re: /(\d{1,2})_(\d{1,2})_(\d{4}) (\d{1,2})_(\d{2})_(\d{2}) ?([AP]M)/i, order: 'mdyhms' },
  // OBS default and current Game Bar: "2026-10-19 21-33-12.mkv", "Star Citizen 2026-10-19 21-33-12.mp4"
  { name: 'obs', re: /(\d{4})-(\d{2})-(\d{2})[ _T](\d{2})-(\d{2})-(\d{2})/, order: 'ymdhms' },
  // Steam / phones / AMD ReLive: "clip_20261019_213312.mp4", "Replay_2026.10.19-21.33.mp4"
  { name: 'compact', re: /(?:^|\D)(\d{4})(\d{2})(\d{2})[_-](\d{2})(\d{2})(\d{2})(?!\d)/, order: 'ymdhms' },
  { name: 'relive', re: /(\d{4})\.(\d{2})\.(\d{2})-(\d{2})\.(\d{2})(?:\.(\d{2}))?/, order: 'ymdhms' }
];

function toMs (value) {
  if (value === undefined || value === null || value === '') return NaN;
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Local wall-clock time embedded in a file name.
 * @param {string} filename
 * @returns {{ pattern: string, wallMs: number }|null} `wallMs` is the wall time read as if it were UTC.
 */
function parseFilenameTime (filename) {
  const name = String(filename || '');
  for (const pattern of FILENAME_PATTERNS) {
    const m = pattern.re.exec(name);
    if (!m) continue;
    let year, month, day, hour, minute, second;
    let centis = 0;
    if (pattern.order === 'mdyhms') {
      [month, day, year, hour, minute, second] = m.slice(1, 7).map(Number);
      const pm = /pm/i.test(m[7]);
      if (hour < 1 || hour > 12) continue;
      hour = (hour % 12) + (pm ? 12 : 0);
    } else {
      [year, month, day, hour, minute] = m.slice(1, 6).map(Number);
      second = m[6] !== undefined ? Number(m[6]) : 0;
      centis = m[7] !== undefined ? Number(m[7]) : 0;
    }
    if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) continue;
    if (hour > 23 || minute > 59 || second > 59) continue;
    const wallMs = Date.UTC(year, month - 1, day, hour, minute, second, centis * 10);
    if (new Date(wallMs).getUTCDate() !== day) continue;
    return { pattern: pattern.name, wallMs };
  }
  return null;
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
  for (let offset = MIN_OFFSET; offset <= MAX_OFFSET; offset += OFFSET_STEP) {
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
 * Estimate when a clip started recording.
 * @param {Object} clip
 * @param {string} [clip.filename]
 * @param {string} [clip.creationTime] Container `creation_time` tag.
 * @param {string|number} clip.postedAt When the message was posted.
 * @param {number} [clip.durationMs]
 * @param {Object} [opts]
 * @param {number} [opts.knownOffsetMinutes] The uploader's UTC offset, learned from earlier clips.
 * @param {string} [opts.defaultTimeZone] Zone for file names that can't be solved.
 * @returns {{ recordedAt: string, source: string, confidence: string, offsetMinutes: number|null, pattern: string|null }}
 */
function estimateRecordingTime (clip = {}, opts = {}) {
  const postedMs = toMs(clip.postedAt);
  const durationMs = Math.max(0, Number(clip.durationMs) || 0);
  const named = parseFilenameTime(clip.filename);
  const result = (utcMs, source, confidence, offsetMinutes = null) => ({
    recordedAt: new Date(utcMs).toISOString(),
    source,
    confidence,
    offsetMinutes,
    pattern: named ? named.pattern : null
  });

  const metaMs = toMs(clip.creationTime);
  const metaOk = Number.isFinite(metaMs) && new Date(metaMs).getUTCFullYear() >= 2010 &&
    (!Number.isFinite(postedMs) || (metaMs <= postedMs + POST_SLACK_MS && postedMs - metaMs <= MAX_METADATA_AGE_MS));
  if (metaOk) {
    if (named) {
      // The file name agrees with the tag up to a real zone offset: both are right.
      const offset = Math.round((named.wallMs - metaMs) / MINUTE);
      const exact = Math.abs((named.wallMs - metaMs) - offset * MINUTE) <= 90 * 1000;
      if (exact && isZoneOffset(offset)) return result(metaMs, 'metadata', 'high', offset);
    }
    return result(metaMs, 'metadata', named ? 'medium' : 'high');
  }

  if (named) {
    const known = Number(opts.knownOffsetMinutes);
    if (opts.knownOffsetMinutes !== undefined && opts.knownOffsetMinutes !== null && isZoneOffset(known)) {
      return result(named.wallMs - known * MINUTE, 'filename', 'high', known);
    }
    if (Number.isFinite(postedMs)) {
      const solved = solveOffset(named.wallMs, postedMs, durationMs);
      if (solved && solved.gapMs <= MAX_SOLVE_GAP_MS) {
        return result(solved.utcMs, 'filename', 'medium', solved.offsetMinutes);
      }
    }
    const zoned = wallTimeInZone(named.wallMs, opts.defaultTimeZone || 'UTC');
    if (zoned) return result(zoned.utcMs, 'filename', 'low', zoned.offsetMinutes);
  }

  if (Number.isFinite(postedMs)) return result(postedMs - durationMs, 'posted', 'low');
  return result(Date.now(), 'unknown', 'low');
}

module.exports = {
  FILENAME_PATTERNS,
  parseFilenameTime,
  zoneOffsetMinutes,
  wallTimeInZone,
  solveOffset,
  isZoneOffset,
  estimateRecordingTime
};
