'use strict';

/**
 * Turn a clips project (an ordered list of segments, each a range of one
 * clip, or a screenshot held for a while) into ffmpeg arguments for the
 * final cut, plus the sources manifest that says where every second of the
 * film came from. Pure: no files or processes are touched here.
 */

const DEFAULTS = Object.freeze({
  width: 1920,
  height: 1080,
  fps: 30,
  crf: 20,
  preset: 'veryfast',
  audioBitrate: '160k',
  maxSegments: 200,
  maxDurationMs: 10 * 60 * 1000,
  maxStillMs: 60 * 1000
});
// A segment may run this far past the clip's probed length (rounding in the editor).
const END_TOLERANCE_S = 0.25;
const MIN_SEGMENT_S = 0.1;

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function seconds (value) {
  return Number(value.toFixed(3));
}

function isStill (clip) {
  return Boolean(clip && clip.media === 'image');
}

function isAudio (clip) {
  return Boolean(clip && clip.media === 'audio');
}

function rangeOf (segment, clip, index, maxStillMs) {
  if (isStill(clip)) {
    const hold = Number(segment.out) - (Number(segment.in) || 0);
    if (!Number.isFinite(hold)) throw fail(400, `Segment ${index + 1}: out must be a number of seconds.`);
    if (hold < MIN_SEGMENT_S) throw fail(400, `Segment ${index + 1}: a screenshot shows for at least ${MIN_SEGMENT_S}s.`);
    if (hold * 1000 > maxStillMs) throw fail(400, `Segment ${index + 1}: a screenshot shows for at most ${Math.round(maxStillMs / 1000)}s.`);
    return { in: 0, out: seconds(hold) };
  }
  const length = (Number(clip.durationMs) || 0) / 1000;
  const start = Number(segment.in);
  let end = Number(segment.out);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw fail(400, `Segment ${index + 1}: in and out must be numbers of seconds.`);
  if (length > 0 && end > length + END_TOLERANCE_S) throw fail(400, `Segment ${index + 1}: out is past the end of the clip.`);
  if (length > 0) end = Math.min(end, length);
  if (start < 0 || end - start < MIN_SEGMENT_S) throw fail(400, `Segment ${index + 1}: out must come after in.`);
  return { in: seconds(start), out: seconds(end) };
}

/**
 * Picture-concat length, or the last overlay's end when the project is voice-only.
 * Overlay segments (`at`) sit on the film timeline and do not add to the concat.
 * @param {Array<Object>} segments normalized segments
 * @returns {number} seconds
 */
function programDurationSeconds (segments) {
  let picture = 0;
  let overlayEnd = 0;
  let hasPicture = false;
  for (const segment of segments || []) {
    const duration = seconds(segment.out - segment.in);
    if (segment.at !== undefined && segment.at !== null) {
      overlayEnd = Math.max(overlayEnd, Number(segment.at) + duration);
    } else {
      hasPicture = true;
      picture += duration;
    }
  }
  return hasPicture ? picture : overlayEnd;
}

/**
 * Check and normalize a project's segments against the clips they use. A
 * screenshot's segment always starts at 0 and its out is how long it shows.
 * Audio clips (`media: 'audio'`) are overlays: `at` is seconds on the film
 * timeline (default 0) and they do not add picture to the concat.
 * @param {Array<Object>} segments `{ clipId, in, out, audio?, volume?, at? }` (seconds into the clip)
 * @param {Object<string, Object>} clipsById Clip records with `durationMs` (or `media: 'image'` / `'audio'`).
 * @param {Object} [limits] `{ maxSegments, maxDurationMs, maxStillMs }`
 * @returns {Array<{ clipId: string, in: number, out: number, audio: string, volume: number, at?: number }>}
 */
function normalizeSegments (segments, clipsById, limits = {}) {
  const maxSegments = limits.maxSegments || DEFAULTS.maxSegments;
  const maxDurationMs = limits.maxDurationMs || DEFAULTS.maxDurationMs;
  const maxStillMs = limits.maxStillMs || DEFAULTS.maxStillMs;
  if (!Array.isArray(segments)) throw fail(400, 'segments must be a list.');
  if (segments.length > maxSegments) throw fail(400, `A project holds at most ${maxSegments} segments.`);
  const out = segments.map((segment, index) => {
    const clipId = String((segment && segment.clipId) || '');
    const clip = clipsById[clipId];
    if (!clip) throw fail(400, `Segment ${index + 1}: no such clip.`);
    const range = rangeOf(segment, clip, index, maxStillMs);
    if (isStill(clip)) return { clipId, in: range.in, out: range.out, audio: 'on', volume: 1 };
    const volume = segment.volume === undefined || segment.volume === null ? 1 : Number(segment.volume);
    if (!Number.isFinite(volume) || volume < 0 || volume > 4) throw fail(400, `Segment ${index + 1}: volume must be between 0 and 4.`);
    const row = {
      clipId,
      in: range.in,
      out: range.out,
      audio: segment.audio === 'mute' ? 'mute' : 'on',
      volume: seconds(volume)
    };
    if (isAudio(clip)) {
      const at = segment.at === undefined || segment.at === null ? 0 : Number(segment.at);
      if (!Number.isFinite(at) || at < 0) throw fail(400, `Segment ${index + 1}: at must be a number of seconds.`);
      row.at = seconds(at);
    }
    return row;
  });
  const totalMs = programDurationSeconds(out) * 1000;
  if (totalMs > maxDurationMs) throw fail(400, `The cut is ${Math.round(totalMs / 1000)}s; the limit is ${Math.round(maxDurationMs / 1000)}s.`);
  return out;
}

function clipStartIso (clip) {
  const override = clip.override || {};
  const base = Date.parse(override.recordedAt || (clip.recording && clip.recording.recordedAt) || '');
  if (!Number.isFinite(base)) return null;
  return new Date(base + (Number(override.syncOffsetMs) || 0)).toISOString();
}

/**
 * Where each segment of the cut came from.
 * @param {Object} project `{ id, name, revision }`
 * @param {Array<Object>} segments normalized segments
 * @param {Object<string, Object>} clipsById
 * @returns {Object}
 */
function clipMedia (clip) {
  if (isStill(clip)) return 'image';
  if (isAudio(clip)) return 'audio';
  return 'video';
}

function sourcesManifest (project, segments, clipsById) {
  let pictureAt = 0;
  const rows = segments.map((segment, index) => {
    const clip = clipsById[segment.clipId];
    const still = isStill(clip);
    const overlay = isAudio(clip);
    const duration = seconds(segment.out - segment.in);
    const start = clipStartIso(clip);
    const shift = (s) => (start ? new Date(Date.parse(start) + s * 1000).toISOString() : null);
    const at = overlay ? seconds(Number(segment.at) || 0) : seconds(pictureAt);
    const row = {
      index,
      at,
      duration,
      in: segment.in,
      out: segment.out,
      audio: segment.audio,
      overlay: overlay || undefined,
      recordedFrom: shift(segment.in),
      recordedTo: still ? shift(0) : shift(segment.out),
      clip: {
        id: clip.id,
        media: clipMedia(clip),
        author: clip.author || null,
        guild: clip.guildName || null,
        channel: clip.channelName || null,
        filename: clip.filename || null,
        postedAt: clip.postedAt || null,
        messageUrl: clip.messageUrl || null,
        recordedAt: start,
        recordedAtSource: clip.override && clip.override.recordedAt ? 'manual' : (clip.recording && clip.recording.source) || null,
        confidence: clip.override && clip.override.recordedAt ? 'manual' : (clip.recording && clip.recording.confidence) || null
      }
    };
    if (!overlay) pictureAt += duration;
    return row;
  });
  return {
    project: { id: project.id, name: project.name, revision: project.revision || 0 },
    duration: seconds(programDurationSeconds(segments)),
    authors: Array.from(new Set(rows.map((row) => row.clip.author).filter(Boolean))),
    segments: rows
  };
}

function srtTime (s) {
  const ms = Math.round(s * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/**
 * One subtitle cue per segment naming its pilot, channel, and recording time.
 * @param {Object} manifest {@link sourcesManifest}
 * @returns {string}
 */
function creditsSrt (manifest) {
  return manifest.segments.map((row, index) => {
    const when = row.recordedFrom ? `${row.recordedFrom.slice(0, 16).replace('T', ' ')} UTC` : null;
    const line = [row.clip.author, row.clip.channel ? `#${row.clip.channel}` : null, when].filter(Boolean).join(' · ');
    return `${index + 1}\n${srtTime(row.at)} --> ${srtTime(row.at + row.duration)}\n${line}\n`;
  }).join('\n');
}

/**
 * ffmpeg arguments for the cut. Each segment is its own input, seeked with
 * `-ss`/`-t` (a screenshot is looped for its `-t`), scaled and padded to one
 * frame size, and concatenated.
 * @param {Object} project `{ id, name, revision }`
 * @param {Array<Object>} segments normalized segments
 * @param {Object<string, Object>} clipsById Clip records with `path` (local original) and `hasAudio`.
 * @param {Object} opts `{ output, srtPath?, width?, height?, fps?, crf?, preset?, audioBitrate? }`
 * @returns {{ args: string[], durationMs: number, manifest: Object, srt: string|null }}
 */
function buildRenderPlan (project, segments, clipsById, opts = {}) {
  const o = Object.assign({}, DEFAULTS, Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)));
  if (!o.output) throw fail(500, 'No output path for the render.');
  if (!segments.length) throw fail(400, 'The project has no segments to render.');
  const W = Math.round(o.width / 2) * 2;
  const H = Math.round(o.height / 2) * 2;
  const manifest = sourcesManifest(project, segments, clipsById);
  const pictures = [];
  const overlays = [];
  segments.forEach((segment) => {
    const clip = clipsById[segment.clipId];
    if (!clip.path) throw fail(500, `Clip ${clip.id} has no local file.`);
    if (isAudio(clip)) overlays.push({ segment, clip });
    else pictures.push({ segment, clip });
  });
  const film = seconds(programDurationSeconds(segments));
  const args = ['-y', '-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1'];
  const graph = [];
  const pairs = [];
  let input = 0;
  pictures.forEach((row) => {
    const k = input++;
    const segment = row.segment;
    const clip = row.clip;
    const d = seconds(segment.out - segment.in);
    if (isStill(clip)) args.push('-loop', '1', '-framerate', String(o.fps), '-t', String(d), '-i', clip.path);
    else args.push('-ss', String(segment.in), '-t', String(d), '-i', clip.path);
    graph.push(`[${k}:v]setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${o.fps},format=yuv420p,trim=duration=${d}[v${k}]`);
    const tail = `aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${d},asetpts=PTS-STARTPTS`;
    if (clip.hasAudio && !isStill(clip) && segment.audio !== 'mute') {
      const gain = segment.volume !== 1 ? `,volume=${segment.volume}` : '';
      graph.push(`[${k}:a]asetpts=PTS-STARTPTS,aresample=48000${gain},${tail}[a${k}]`);
    } else {
      graph.push(`anullsrc=r=48000:cl=stereo,${tail}[a${k}]`);
    }
    pairs.push(`[v${k}][a${k}]`);
  });
  const overlayInputs = overlays.map((row) => {
    const k = input++;
    const d = seconds(row.segment.out - row.segment.in);
    args.push('-ss', String(row.segment.in), '-t', String(d), '-i', row.clip.path);
    return { k, segment: row.segment, clip: row.clip, d };
  });
  if (!pictures.length) {
    graph.push(`color=c=black:s=${W}x${H}:r=${o.fps}:d=${film},format=yuv420p,setsar=1[vout]`);
    graph.push(`anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${film},asetpts=PTS-STARTPTS[aout]`);
  } else {
    graph.push(`${pairs.join('')}concat=n=${pictures.length}:v=1:a=1[vout][aout]`);
  }
  const mix = ['[aout]'];
  overlayInputs.forEach((entry, i) => {
    if (entry.segment.audio === 'mute') return;
    const delay = Math.max(0, Math.round((Number(entry.segment.at) || 0) * 1000));
    const gain = entry.segment.volume !== 1 ? `,volume=${entry.segment.volume}` : '';
    graph.push(`[${entry.k}:a]asetpts=PTS-STARTPTS,aresample=48000${gain},adelay=${delay}:all=1,` +
      `aformat=sample_fmts=fltp:channel_layouts=stereo[ov${i}]`);
    mix.push(`[ov${i}]`);
  });
  if (mix.length > 1) {
    graph.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:dropout_transition=0[amixed]`);
  }
  const audioMap = mix.length > 1 ? '[amixed]' : '[aout]';
  const srt = o.srtPath ? creditsSrt(manifest) : null;
  if (o.srtPath) args.push('-i', o.srtPath);
  args.push('-filter_complex', graph.join(';'), '-map', '[vout]', '-map', audioMap);
  if (o.srtPath) args.push('-map', `${input}:s`, '-c:s', 'mov_text', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:0', 'title=Sources');
  const comment = ('Sources: ' + manifest.segments.map((row) => [row.clip.author, row.clip.messageUrl].filter(Boolean).join(' ')).join('; ')).slice(0, 2000);
  args.push(
    '-c:v', 'libx264', '-preset', o.preset, '-crf', String(o.crf), '-pix_fmt', 'yuv420p', '-r', String(o.fps),
    '-c:a', 'aac', '-b:a', o.audioBitrate, '-ar', '48000',
    '-movflags', '+faststart',
    '-metadata', `title=${project.name || 'Clips'}`,
    '-metadata', `comment=${comment}`,
    o.output
  );
  return { args, durationMs: Math.round(manifest.duration * 1000), manifest, srt };
}

module.exports = {
  DEFAULTS,
  isAudio,
  normalizeSegments,
  programDurationSeconds,
  sourcesManifest,
  creditsSrt,
  buildRenderPlan
};
