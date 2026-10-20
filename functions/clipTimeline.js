'use strict';

/**
 * Group clips into recording sessions: clips whose recordings overlap, or
 * start within `gapMs` of the session so far, belong together. Inside a
 * session every uploader gets a track (one point of view), and a track's
 * clips that overlap each other go on separate lanes.
 */

// A play session runs for hours with long stretches between clips; separate
// evenings are further apart than this.
const DEFAULT_GAP_MS = 2 * 60 * 60 * 1000;

/**
 * Start of a clip's recording in ms, after any manual override and sync nudge.
 * @param {Object} clip `{ recording: { recordedAt }, override?: { recordedAt?, syncOffsetMs? } }`
 * @returns {number} NaN when unknown
 */
function clipStartMs (clip) {
  const override = (clip && clip.override) || {};
  const base = Date.parse(override.recordedAt || (clip && clip.recording && clip.recording.recordedAt) || '');
  return base + (Number(override.syncOffsetMs) || 0);
}

function clipDurationMs (clip) {
  return Math.max(0, Number(clip && clip.durationMs) || 0);
}

/**
 * Place clips on lanes so no two clips on one lane overlap.
 * @param {Array<{ startMs: number, endMs: number }>} items sorted by start
 * @returns {number[]} lane index per item
 */
function assignLanes (items) {
  const laneEnds = [];
  return items.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.startMs);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMs);
    } else {
      laneEnds[lane] = item.endMs;
    }
    return lane;
  });
}

/**
 * @param {Array<Object>} clips Clip records (`id`, `author`, `durationMs`, `recording`, `override`).
 * @param {Object} [opts]
 * @param {number} [opts.gapMs] Largest silence inside one session.
 * @returns {Array<Object>} sessions, newest first
 */
function groupSessions (clips, opts = {}) {
  const gapMs = Number.isFinite(Number(opts.gapMs)) ? Math.max(0, Number(opts.gapMs)) : DEFAULT_GAP_MS;
  const timed = (clips || [])
    .map((clip) => {
      const startMs = clipStartMs(clip);
      return { clip, startMs, endMs: startMs + clipDurationMs(clip) };
    })
    .filter((item) => Number.isFinite(item.startMs))
    .sort((a, b) => (a.startMs - b.startMs) || String(a.clip.id).localeCompare(String(b.clip.id)));

  const groups = [];
  for (const item of timed) {
    const current = groups[groups.length - 1];
    if (current && item.startMs <= current.endMs + gapMs) {
      current.items.push(item);
      current.endMs = Math.max(current.endMs, item.endMs);
    } else {
      groups.push({ items: [item], startMs: item.startMs, endMs: item.endMs });
    }
  }

  return groups.map((group) => {
    const byAuthor = new Map();
    for (const item of group.items) {
      const author = (item.clip.author || 'Unknown pilot');
      if (!byAuthor.has(author)) byAuthor.set(author, []);
      byAuthor.get(author).push(item);
    }
    const tracks = Array.from(byAuthor.entries())
      .sort((a, b) => (b[1].length - a[1].length) || a[0].localeCompare(b[0]))
      .map(([author, items]) => {
        const lanes = assignLanes(items);
        return {
          author,
          lanes: lanes.length ? Math.max(...lanes) + 1 : 1,
          clips: items.map((item, index) => ({
            id: item.clip.id,
            lane: lanes[index],
            offsetMs: item.startMs - group.startMs,
            durationMs: item.endMs - item.startMs
          }))
        };
      });
    return {
      id: `s-${group.items[0].clip.id}`,
      startsAt: new Date(group.startMs).toISOString(),
      endsAt: new Date(group.endMs).toISOString(),
      durationMs: group.endMs - group.startMs,
      clipCount: group.items.length,
      authors: tracks.map((track) => track.author),
      channels: Array.from(new Set(group.items.map((item) => item.clip.channelName).filter(Boolean))),
      tracks
    };
  }).reverse();
}

module.exports = {
  DEFAULT_GAP_MS,
  clipStartMs,
  clipDurationMs,
  assignLanes,
  groupSessions
};
