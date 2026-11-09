'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const Store = require('@fabric/core/types/store');
const { matchesAnyChannel } = require('@fabric/discord/functions/channelMatcher');
const startStore = require('../functions/startStore');
const discordEvents = require('../functions/discordScheduledEvents');
const discordThreads = require('../functions/discordThreads');
const resolveDiscordToken = require('../functions/resolveDiscordToken');
const { displayName } = require('../functions/duelLeaderboard');
const { estimateRecordingTime } = require('../functions/clipRecordingTime');
const { containerTimeTags, imageTimeTags } = require('../functions/mediaTimeTags');
const { readAnnouncement, readVod, pickVod, vodFinished } = require('../functions/streamAnnouncements');
const { groupSessions, clipStartMs, isStill, DEFAULT_GAP_MS } = require('../functions/clipTimeline');
const { normalizeSegments, buildRenderPlan } = require('../functions/clipRenderPlan');

const BASE = '/services/clips';
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_EPOCH = 1420070400000n;
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
// Stills only: GIFs are reactions, not screenshots.
const IMAGE_TYPE = /^image\/(png|jpeg|webp)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp)$/i;
const LINK_RE = /https?:\/\/(?:www\.)?(?:medal\.tv\/(?:[^\s?#]*\/)?clips?\/\S+|youtube\.com\/(?:watch\?|shorts\/)\S+|youtu\.be\/\S+|streamable\.com\/\S+|clips\.twitch\.tv\/\S+|twitch\.tv\/\S+\/clip\/\S+)/gi;
// Text and announcement channels.
const TEXT_CHANNEL_TYPES = new Set([0, 5]);
// Forum and media channels hold their posts as threads.
const THREAD_ONLY_TYPES = new Set([15, 16]);
const MEDIA_CHANNEL = 16;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_SIZE = 100;
const MAX_ATTEMPTS = 3;
const MISSING_DEPENDENCY = /is not installed|Unknown encoder|Encoder not found|No such filter|Filter not found|Unrecognized option|Invalid encoder type/i;
const NAMES_TTL_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const LIMITS = { name: 80, notes: 2000, caption: 500 };
const DAY_MS = 24 * 60 * 60 * 1000;
// A live broadcast's VOD exists from its first minute, so by then a missing one is not coming.
const NO_VOD_AFTER_MS = 6 * 60 * 60 * 1000;
const VOD_FIELDS = '%(.{id,timestamp,duration,is_live,uploader,uploader_id,title})j';
const STREAM_DEFAULTS = {
  enabled: true,
  download: true,
  channels: ['/(^|[^a-z])streams?([^a-z]|$)/'],
  archives: 20,
  waitDays: 60,
  checkEveryMs: 30 * 60 * 1000,
  settleMs: 30 * 60 * 1000,
  maxSourceHeight: 720,
  maxDownloadBytes: 8 * 1024 * 1024 * 1024
};

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function text (value, max) {
  return String(value === undefined || value === null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * A message's text with Discord markup made readable: user mentions become
 * `@Name` (from the message's `mentions`), and no snowflake survives.
 * @param {string} content
 * @param {Array<Object>} [mentions] Discord `message.mentions` (users, with `member` in guilds).
 * @returns {string}
 */
function plainCaption (content, mentions) {
  const names = new Map();
  for (const user of mentions || []) {
    if (user && user.id) names.set(String(user.id), displayName(user.member || null, user));
  }
  return String(content === undefined || content === null ? '' : content)
    .replace(/<@!?(\d+)>/g, (match, id) => `@${names.get(id) || 'someone'}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#\d+>/g, '#channel')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (match, seconds) => {
      const d = new Date(Number(seconds) * 1000);
      return isNaN(d.getTime()) ? '' : `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    });
}

function errorMessage (res) {
  return (res.json && res.json.message) || res.error || `HTTP ${res.status}`;
}

/**
 * Smallest Discord snowflake at or after `ms`.
 * @param {number} ms
 * @returns {string}
 */
function snowflakeAt (ms) {
  return String((BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH) << 22n);
}

function laterSnowflake (a, b) {
  if (!a) return String(b);
  if (!b) return String(a);
  return BigInt(a) >= BigInt(b) ? String(a) : String(b);
}

function compareSnowflake (a, b) {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : (x > y ? 1 : 0);
}

function basename (url) {
  try {
    return decodeURIComponent(path.posix.basename(new URL(url).pathname)) || null;
  } catch (_) {
    return null;
  }
}

/**
 * Every clip one Discord message carries: video and screenshot attachments,
 * direct video embeds, and links to clip hosts (Medal, YouTube, Streamable,
 * Twitch).
 * @param {Object} message Discord message
 * @returns {Array<Object>} `{ id, kind, media, attachmentId, url, filename, contentType, size, width, height }`
 */
function extractClips (message) {
  const out = [];
  if (!message || !message.id) return out;
  for (const attachment of message.attachments || []) {
    const type = String(attachment.content_type || '');
    const filename = String(attachment.filename || '');
    const video = /^video\//i.test(type) || VIDEO_EXT.test(filename);
    const image = !video && (type ? IMAGE_TYPE.test(type) : IMAGE_EXT.test(filename));
    if (!video && !image) continue;
    out.push({
      id: String(attachment.id),
      kind: 'attachment',
      media: video ? 'video' : 'image',
      attachmentId: String(attachment.id),
      url: attachment.url || null,
      filename: attachment.filename || null,
      contentType: type || null,
      size: Number(attachment.size) || null,
      width: Number(attachment.width) || null,
      height: Number(attachment.height) || null
    });
  }
  (message.embeds || []).forEach((embed, index) => {
    if (!embed || embed.type !== 'video' || embed.provider || !embed.video || !embed.video.url) return;
    out.push({
      id: `${message.id}-e${index}`,
      kind: 'embed',
      media: 'video',
      attachmentId: null,
      url: embed.video.url,
      filename: basename(embed.video.url),
      contentType: null,
      size: null,
      width: Number(embed.video.width) || null,
      height: Number(embed.video.height) || null
    });
  });
  const links = String(message.content || '').match(LINK_RE) || [];
  Array.from(new Set(links.map((link) => link.replace(/[)>.,]+$/, '')))).forEach((url, index) => {
    out.push({ id: `${message.id}-l${index}`, kind: 'link', media: 'video', attachmentId: null, url, filename: null, contentType: null, size: null, width: null, height: null });
  });
  return out;
}

/**
 * Discord clip channels → a timeline of every clip, by when it was recorded.
 *
 * Polls every text channel the bot can see whose name matches `channels`
 * (Discord REST only), keeps each clip's source (guild, channel, message,
 * attachment), estimates when it was recorded, and stores a low-resolution
 * proxy and thumbnail sprite for storyboarding. Screenshots join the same
 * sessions, shown on the timeline for `stillSeconds`. Projects put ranges of
 * clips (and screenshots held for a while) in order. Go-live announcements
 * in stream channels are followed to their Twitch VODs, which join the
 * sessions as the streamer's track once the broadcast is over. Renders cut the film
 * from the full-resolution originals with ffmpeg. No sign-in needed: anyone may browse and
 * edit, and a signed-in member's display name goes on their changes.
 */
class Clips {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Root directory (Store, media, renders).
   * @param {Object} [settings.discord] settings.discord (token / secretsFile).
   * @param {Array<string>} [settings.channels] Channel matchers (id, exact name, or "/regex/"); threads under a matched channel are read too.
   * @param {(Array<string>|boolean)} [settings.externalLinks] Hosts whose clip links are downloaded with yt-dlp (default Medal); `true` for every clip host, `false` to keep links as sources only.
   * @param {boolean} [settings.mediaChannels] Also read every media channel, whatever its name.
   * @param {Object} [settings.streams] Go-live announcements → Twitch VODs: `enabled`, `download` (false keeps VODs as links),
   *   `channels` (matchers), `archives` (VODs listed per Twitch channel), `waitDays`, `checkEveryMs`, `settleMs`,
   *   `maxSourceHeight`, `maxDownloadBytes`.
   * @param {Array<string>} [settings.guilds] Only these guilds (default: every guild the bot is in).
   * @param {boolean} [settings.poll] Poll Discord and build proxies (false serves stored clips only).
   * @param {number} [settings.ttlMs] Poll interval.
   * @param {number} [settings.backfillDays] How far back a new channel is read (0 = its whole history).
   * @param {number} [settings.maxPages] Pages of 100 messages read per channel per poll.
   * @param {number} [settings.sessionGapMs] Largest silence inside one session.
   * @param {number} [settings.stillSeconds] How long a screenshot shows on the timeline (and when first added to a project).
   * @param {number} [settings.maxStillSeconds] Longest a screenshot may show in a project.
   * @param {number} [settings.stillHeight] Tallest screenshot preview served to the editor.
   * @param {boolean} [settings.keepMasters] Keep each clip's best download (up to `maxSourceHeight`) in `masters/` for renders.
   * @param {number} [settings.maxSourceHeight] Tallest source downloaded (default the 1080p render height).
   * @param {number} [settings.minFreeBytes] Free space kept on the disk: a download waits until its largest allowed
   *   size still leaves this much, and no master is kept below it. `0` turns the floor (and `minFreeRatio`) off.
   * @param {number} [settings.minFreeRatio] Also keep this fraction of the volume free (default 0.25). The larger
   *   of this and `minFreeBytes` wins. Masters that push past it are dropped (screenshots first, then clips, then VODs).
   * @param {number} [settings.maxBytes] Cap on `media/` + `masters/` + `renders/` + `tmp/` (0 = none).
   * @param {number} [settings.renderKeepMs] Completed renders older than this may be deleted when reclaiming space.
   * @param {number} [settings.rescanEveryMs] How often a rescan pass runs (0 = never; `rescan` still works).
   * @param {number} [settings.recheckAfterMs] How long before a link clip's source is checked for a better version again.
   * @param {number} [settings.rescanBatch] Clips checked per rescan pass.
   * @param {number} [settings.maxQueuedRenders] Renders waiting at once before new ones are refused.
   * @param {Function} [settings.identify] `async (req) => string|null` — the signed-in member's display name.
   * @param {Function} [settings.log] `(message) => void` progress while polling and building proxies.
   * @param {Function} [settings.run] `(command, args, { onStdout }) => Promise<{ code, stdout, stderr }>`, injected for tests.
   * @param {Function} [settings.fetch] Injected for tests; defaults to global fetch.
   * @param {Function} [settings.resolveToken] Injected for tests.
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      path: './stores/clips',
      basePath: '/clips',
      discord: {},
      channels: ['/(^|[^a-z])(clips?|videos?|screenshots?)([^a-z]|$)/'],
      mediaChannels: true,
      guilds: null,
      poll: true,
      refreshOnStart: true,
      ttlMs: 15 * 60 * 1000,
      backfillDays: 90,
      maxPages: 20,
      sessionGapMs: DEFAULT_GAP_MS,
      stillSeconds: 5,
      maxStillSeconds: 60,
      stillHeight: 720,
      defaultTimeZone: 'America/Chicago',
      externalLinks: ['medal.tv'],
      maxDownloadBytes: 1024 * 1024 * 1024,
      keepMasters: true,
      maxSourceHeight: 1080,
      minFreeBytes: 20 * 1024 * 1024 * 1024,
      minFreeRatio: 0.25,
      maxBytes: 0,
      renderKeepMs: 7 * DAY_MS,
      rescanEveryMs: 60 * 60 * 1000,
      recheckAfterMs: 7 * 24 * 60 * 60 * 1000,
      rescanBatch: 10,
      proxyHeight: 240,
      proxyFps: 15,
      thumbEverySec: 2,
      maxThumbs: 120,
      thumbHeight: 68,
      renderWidth: 1920,
      renderHeight: 1080,
      renderFps: 30,
      renderCredits: true,
      maxRenderSeconds: 600,
      maxSegments: 200,
      maxRenderSources: 40,
      maxQueuedRenders: 3,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      ytdlpPath: 'yt-dlp',
      identify: null,
      log: null,
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.settings.streams = Object.assign({}, STREAM_DEFAULTS,
      Object.fromEntries(Object.entries(settings.streams || {}).filter(([, value]) => value !== undefined)));
    this._resolveToken = this.settings.resolveToken || resolveDiscordToken;
    this.root = path.resolve(this.settings.path);
    this.dirs = {
      store: path.join(this.root, 'store'),
      media: path.join(this.root, 'media'),
      masters: path.join(this.root, 'masters'),
      renders: path.join(this.root, 'renders'),
      tmp: path.join(this.root, 'tmp')
    };
    this.store = null;
    this._queue = Promise.resolve();
    this._refreshing = null;
    this._processing = null;
    this._rescanning = null;
    this._renderChain = Promise.resolve();
    this._timer = null;
    this._rescanTimer = null;
    this._lastBackgroundAt = 0;
    this._usageCache = null;
    this._stopped = false;
  }

  async start () {
    for (const dir of Object.values(this.dirs)) await fsp.mkdir(dir, { recursive: true });
    this.store = new Store({ name: 'GOON.VC:clips', path: this.dirs.store, persistent: true, verbosity: 1 });
    await startStore(this.store);
    this._stopped = false;
    const swept = await this._sweepTmp();
    if (swept) this._log(`cleared ${swept} leftover file${swept === 1 ? '' : 's'} from clips tmp`);
    const reclaimed = await this.reclaim();
    if (reclaimed.bytes) {
      this._log(`reclaimed ${(reclaimed.bytes / 1e9).toFixed(1)} GB (${reclaimed.dropped.length} master${reclaimed.dropped.length === 1 ? '' : 's'}${reclaimed.renders ? `, ${reclaimed.renders} render${reclaimed.renders === 1 ? '' : 's'}` : ''})`);
    }
    const usage = await this.usage({ refresh: true });
    if (usage.used || usage.free != null) {
      const gb = (n) => n == null ? '?' : (n / 1073741824).toFixed(1);
      this._log(`clips storage ${gb(usage.used)} GB used, ${gb(usage.free)} GB free (keep ${gb(usage.target)} GB free)`);
    }
    for (const id of await this._list('renders')) {
      const render = await this.store.get(`/renders/${id}`);
      if (render && (render.status === 'queued' || render.status === 'running')) {
        await this._updateRender(id, { status: 'queued', progress: 0 });
        this._enqueueRender(id);
      }
    }
    await this.retryAfterToolChange();
    const requeued = await this.retryFailed();
    if (requeued) this._log(`queued ${requeued} clip${requeued === 1 ? '' : 's'} that failed for a missing tool or codec`);
    const links = await this.queueLinks();
    if (links) this._log(`queued ${links} link${links === 1 ? '' : 's'} for import with yt-dlp`);
    const redated = await this.redate();
    if (redated) this._log(`re-dated ${redated} clip${redated === 1 ? '' : 's'}`);
    if (this.settings.poll) {
      if (this.settings.refreshOnStart) this._refreshInBackground();
      if (this.settings.ttlMs > 0) {
        this._timer = setInterval(() => this._refreshInBackground(), this.settings.ttlMs);
        this._timer.unref();
      }
      if (this.settings.rescanEveryMs > 0) {
        this._rescanTimer = setInterval(() => this._rescanInBackground(), this.settings.rescanEveryMs);
        this._rescanTimer.unref();
      }
    }
    return this;
  }

  async stop () {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    if (this._rescanTimer) clearInterval(this._rescanTimer);
    this._timer = null;
    this._rescanTimer = null;
    if (this._refreshing) await this._refreshing.catch(() => {});
    if (this._processing) await this._processing.catch(() => {});
    if (this._rescanning) await this._rescanning.catch(() => {});
    await this._renderChain.catch(() => {});
    await this._queue.catch(() => {});
    if (this.store) await this.store.stop();
    return this;
  }

  _iso () {
    return new Date(this.settings.now()).toISOString();
  }

  _exclusive (task) {
    const run = this._queue.then(task, task);
    this._queue = run.catch(() => {});
    return run;
  }

  async _list (name) {
    const list = await this.store.get(`/index/${name}`);
    return Array.isArray(list) ? list : [];
  }

  async _append (name, id) {
    const list = await this._list(name);
    if (!list.includes(id)) await this.store.set(`/index/${name}`, list.concat(id));
  }

  _discordOpts () {
    return this.settings.fetch ? { fetch: this.settings.fetch } : {};
  }

  _fetch (...args) {
    return (this.settings.fetch || globalThis.fetch)(...args);
  }

  _log (message) {
    if (typeof this.settings.log === 'function') this.settings.log(message);
  }

  _token () {
    const auth = this._resolveToken(this.settings.discord);
    if (!auth || !auth.token) throw new Error('No Discord bot token configured');
    return auth.token;
  }

  // ---------------------------------------------------------------- polling

  _refresh () {
    if (!this._refreshing) {
      this._refreshing = this.refresh()
        .catch(async (error) => {
          if (this.store && !this._stopped) await this.store.set('/status', Object.assign({}, await this.store.get('/status'), { attemptedAt: this._iso(), error: error.message || String(error) }));
          throw error;
        })
        .finally(() => { this._refreshing = null; });
    }
    return this._refreshing;
  }

  _refreshInBackground (opts = {}) {
    const now = Date.now();
    if (opts.throttle && now - this._lastBackgroundAt < RETRY_MS) return;
    this._lastBackgroundAt = now;
    this._refresh().catch(() => {});
  }

  async _guilds (token) {
    if (Array.isArray(this.settings.guilds) && this.settings.guilds.length) {
      const out = [];
      for (const id of this.settings.guilds) {
        const res = await discordEvents.discordGet(`/guilds/${id}`, token, this._discordOpts());
        out.push({ id: String(id), name: res.status === 200 && res.json ? res.json.name || null : null });
      }
      return out;
    }
    const res = await discordEvents.discordGet('/users/@me/guilds?limit=200', token, this._discordOpts());
    if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(errorMessage(res));
    return res.json.map((guild) => ({ id: String(guild.id), name: guild.name || null }));
  }

  /**
   * Find the clip channels and read every new message in them.
   * @param {Object} [opts]
   * @param {boolean} [opts.fromStart] Read each channel again from the start of the
   *   backfill window (clips already stored are kept as they are).
   * @returns {Promise<Object>} poll summary
   */
  async refresh (opts = {}) {
    const token = this._token();
    const guilds = await this._guilds(token);
    let channels = 0;
    let added = 0;
    const errors = [];
    for (const guild of guilds) {
      const res = await discordEvents.discordGet(`/guilds/${guild.id}/channels`, token, this._discordOpts());
      if (res.status !== 200 || !Array.isArray(res.json)) {
        errors.push(`${guild.name || guild.id}: ${errorMessage(res)}`);
        continue;
      }
      const matched = res.json.filter((channel) => this._matchesChannel(channel));
      if (!matched.length) continue;
      const active = await this._activeThreads(token, guild);
      for (const channel of matched) {
        const streams = this._isStreamChannel(channel);
        const sources = TEXT_CHANNEL_TYPES.has(Number(channel.type)) ? [Object.assign({}, channel, { streams })] : [];
        try {
          const threads = (active.get(String(channel.id)) || []).concat(await this._archivedThreads(token, channel));
          const seen = new Set();
          for (const thread of threads) {
            if (seen.has(String(thread.id))) continue;
            seen.add(String(thread.id));
            sources.push(Object.assign({}, thread, { name: channel.name, thread: thread.name, streams }));
          }
        } catch (error) {
          errors.push(`#${channel.name} threads: ${error.message}`);
        }
        for (const source of sources) {
          channels += 1;
          const label = source.thread ? `#${source.name} › ${source.thread}` : `#${source.name}`;
          try {
            added += await this._pollChannel(token, guild, source, opts);
          } catch (error) {
            errors.push(`${label}: ${error.message}`);
            await this._exclusive(async () => {
              const state = await this.store.get(`/channels/${source.id}`);
              if (state) await this.store.set(`/channels/${source.id}`, Object.assign(state, { attemptedAt: this._iso(), error: error.message }));
            });
          }
        }
      }
    }
    const at = this._iso();
    const status = { polledAt: at, attemptedAt: at, channels, added, error: errors.length ? errors.join('; ') : null };
    await this.store.set('/status', status);
    this._processInBackground();
    return status;
  }

  _matchesChannel (channel) {
    const type = Number(channel.type);
    if (!TEXT_CHANNEL_TYPES.has(type) && !THREAD_ONLY_TYPES.has(type)) return false;
    if (type === MEDIA_CHANNEL && this.settings.mediaChannels) return true;
    return matchesAnyChannel(this.settings.channels, { id: String(channel.id), name: channel.name }) || this._isStreamChannel(channel);
  }

  /** A channel whose go-live announcements are followed to their VODs. */
  _isStreamChannel (channel) {
    const streams = this.settings.streams;
    if (!streams.enabled || !TEXT_CHANNEL_TYPES.has(Number(channel.type))) return false;
    return matchesAnyChannel(streams.channels || [], { id: String(channel.id), name: channel.name });
  }

  /** Active threads in the guild, by parent channel id. */
  _activeThreads (token, guild) {
    return discordThreads.activeThreads(token, guild.id, this._discordOpts());
  }

  /** Every archived public thread (forum / media posts included) under a channel. */
  _archivedThreads (token, channel) {
    return discordThreads.archivedThreads(token, channel.id, this._discordOpts());
  }

  _backfillCursor () {
    const days = Number(this.settings.backfillDays);
    if (!Number.isFinite(days) || days <= 0) return '0';
    return snowflakeAt(this.settings.now() - days * 24 * 60 * 60 * 1000);
  }

  async _pollChannel (token, guild, channel, opts = {}) {
    const key = `/channels/${channel.id}`;
    const saved = await this.store.get(key);
    const state = Object.assign({
      id: String(channel.id),
      guildId: guild.id,
      cursor: this._backfillCursor(),
      clips: 0
    }, saved || {}, { guildName: guild.name || (saved && saved.guildName) || null, name: channel.name, thread: channel.thread || null, streams: Boolean(channel.streams) });
    if (opts.fromStart) state.cursor = this._backfillCursor();
    else if (saved && channel.last_message_id && compareSnowflake(state.cursor, channel.last_message_id) >= 0) return 0;
    const label = channel.thread ? `#${channel.name} › ${channel.thread}` : `#${channel.name}`;
    let added = 0;
    let read = 0;
    for (let page = 0; page < this.settings.maxPages; page++) {
      const res = await discordEvents.discordGet(`/channels/${channel.id}/messages?after=${state.cursor}&limit=${PAGE_SIZE}`, token, this._discordOpts());
      if (res.status !== 200 || !Array.isArray(res.json)) throw new Error(errorMessage(res));
      const messages = res.json.slice().sort((a, b) => compareSnowflake(a.id, b.id));
      for (const message of messages) {
        added += await this._indexMessage(token, guild, state, message);
        state.cursor = laterSnowflake(state.cursor, message.id);
      }
      read += messages.length;
      if (messages.length) {
        const last = messages[messages.length - 1];
        this._log(`${label}: read ${read} messages (through ${String(last.timestamp || '').slice(0, 10)}), ${added} new clips`);
      }
      // Save as we go so an interrupted backfill picks up where it stopped.
      await this._exclusive(() => this.store.set(key, Object.assign({}, state, { clips: state.clips + added })));
      if (messages.length < PAGE_SIZE) break;
    }
    state.clips += added;
    state.polledAt = this._iso();
    state.attemptedAt = state.polledAt;
    state.error = null;
    await this._exclusive(() => this.store.set(key, state));
    return added;
  }

  async _indexMessage (token, guild, channel, message) {
    if (channel.streams) await this._recordAnnouncement(guild, channel, message);
    const found = extractClips(message);
    if (!found.length) return 0;
    const author = message.author || {};
    const name = author.id ? await this._name(guild.id, author, token) : null;
    const caption = text(plainCaption(message.content, message.mentions), LIMITS.caption);
    let added = 0;
    for (const item of found) {
      if (!ID.test(item.id)) continue;
      const created = await this._exclusive(async () => {
        const stored = await this.store.get(`/clips/${item.id}`);
        if (stored) {
          if (stored.caption !== caption) await this.store.set(`/clips/${item.id}`, Object.assign(stored, { caption }));
          return false;
        }
        const linkOnly = item.kind === 'link' && !this._importsLink(item);
        const clip = Object.assign({}, item, {
          guildId: guild.id,
          guildName: guild.name || channel.guildName || null,
          channelId: channel.id,
          channelName: channel.name,
          threadName: channel.thread || null,
          messageId: String(message.id),
          messageUrl: `https://discord.com/channels/${guild.id}/${channel.id}/${message.id}`,
          authorId: author.id ? String(author.id) : null,
          author: name || 'Unknown pilot',
          caption,
          postedAt: message.timestamp || null,
          durationMs: null,
          hasAudio: null,
          codec: null,
          creationTime: null,
          recording: estimateRecordingTime({ filename: item.filename, postedAt: message.timestamp, durationMs: 0 }, { defaultTimeZone: this.settings.defaultTimeZone }),
          override: null,
          proxy: { status: linkOnly ? 'skipped' : 'pending', attempts: 0, error: null },
          indexedAt: this._iso(),
          log: []
        });
        await this.store.set(`/clips/${clip.id}`, clip);
        await this._append('clips', clip.id);
        return true;
      });
      if (created) added += 1;
    }
    return added;
  }

  async _name (guildId, user, token) {
    const key = `/names/${guildId}/${user.id}`;
    const saved = await this.store.get(key);
    if (saved && saved.name && Date.now() - Date.parse(saved.fetchedAt || 0) < NAMES_TTL_MS) return saved.name;
    let name = null;
    const member = await discordEvents.discordGet(`/guilds/${guildId}/members/${user.id}`, token, this._discordOpts());
    if (member.status === 200 && member.json) name = displayName(member.json);
    if (!name) name = displayName(null, user);
    if (!name) return (saved && saved.name) || null;
    await this.store.set(key, { name, fetchedAt: new Date().toISOString() });
    return name;
  }

  // ---------------------------------------------------------------- streams

  /**
   * Save each Twitch channel or VOD a go-live announcement links, to be
   * matched to its broadcast by `collectStreams`.
   * @private
   */
  async _recordAnnouncement (guild, channel, message) {
    const found = readAnnouncement(message);
    if (!found) return 0;
    const base = {
      guildId: guild.id,
      guildName: guild.name || channel.guildName || null,
      channelId: channel.id,
      channelName: channel.name,
      threadName: channel.thread || null,
      messageId: String(message.id),
      messageUrl: `https://discord.com/channels/${guild.id}/${channel.id}/${message.id}`,
      announcedAt: message.timestamp || null,
      streamer: found.streamer ? text(found.streamer, LIMITS.name) : null,
      title: found.title ? text(found.title, LIMITS.caption) : null,
      status: 'waiting',
      vodId: null,
      clipId: null,
      checkedAt: null,
      error: null
    };
    // A linked VOD is looked up by itself; it may be older than a channel's newest `archives`.
    const entries = found.vods.map((vod) => Object.assign({}, base, { id: `${message.id}-v${vod.id}`, login: null, vodId: vod.id }))
      .concat(found.channels.map((login) => Object.assign({}, base, { id: `${message.id}-${login}`, login })));
    let added = 0;
    for (const entry of entries) {
      if (!ID.test(entry.id)) continue;
      const created = await this._exclusive(async () => {
        if (await this.store.get(`/streams/${entry.id}`)) return false;
        await this.store.set(`/streams/${entry.id}`, entry);
        await this._append('streams', entry.id);
        return true;
      });
      if (created) added += 1;
    }
    return added;
  }

  async _updateAnnouncement (id, fields) {
    return this._exclusive(async () => {
      const entry = await this.store.get(`/streams/${id}`);
      if (entry) await this.store.set(`/streams/${id}`, Object.assign(entry, fields));
    });
  }

  /**
   * Twitch VODs as yt-dlp lists them (a channel's past broadcasts, newest
   * first, or one VOD), without downloading.
   * @private
   */
  async _twitchVods (url, count) {
    const out = await this._run(this.settings.ytdlpPath, [
      '--no-warnings', '--ignore-no-formats-error', '--playlist-items', `1:${count}`, '--print', VOD_FIELDS, url
    ], { keepOutput: true });
    const vods = String(out.stdout || '').split('\n').map((line) => {
      try { return readVod(JSON.parse(line)); } catch (_) { return null; }
    }).filter(Boolean);
    if (out.code && !vods.length) throw new Error(`yt-dlp exited ${out.code}: ${String(out.stderr || '').trim().split('\n').slice(-2).join(' ')}`);
    return vods;
  }

  /**
   * Follow waiting go-live announcements to their broadcasts: once a
   * broadcast's VOD is over, it becomes a clip (dated by when the stream went
   * live, by the streamer) and is downloaded like one. An announcement with no
   * VOD after `NO_VOD_AFTER_MS` is `none` (past broadcasts off, or deleted);
   * one older than `waitDays` is `missed`. Each Twitch channel is listed once
   * a pass, and an announcement is checked at most every `checkEveryMs`.
   * @param {Object} [opts]
   * @param {boolean} [opts.force] Check every waiting announcement now.
   * @returns {Promise<{ checked: number, collected: number, waiting: number, none: number, missed: number }>}
   */
  async collectStreams (opts = {}) {
    const streams = this.settings.streams;
    const result = { checked: 0, collected: 0, waiting: 0, none: 0, missed: 0 };
    if (!streams.enabled) return result;
    const now = this.settings.now();
    const due = [];
    for (const id of await this._list('streams')) {
      const entry = await this.store.get(`/streams/${id}`);
      if (!entry || entry.status !== 'waiting') continue;
      const announcedMs = Date.parse(entry.announcedAt || '');
      if (!(now - announcedMs <= streams.waitDays * DAY_MS)) {
        await this._updateAnnouncement(id, { status: 'missed', checkedAt: this._iso() });
        result.missed += 1;
      } else if (!opts.force && now - Date.parse(entry.checkedAt || 0) < streams.checkEveryMs) {
        result.waiting += 1;
      } else {
        due.push(entry);
      }
    }
    const listings = new Map();
    for (const entry of due) {
      if (this._stopped) break;
      const key = entry.login || `v${entry.vodId}`;
      if (!listings.has(key)) {
        const url = entry.login ? `https://www.twitch.tv/${entry.login}/videos?filter=archives&sort=time` : `https://www.twitch.tv/videos/${entry.vodId}`;
        listings.set(key, this._twitchVods(url, entry.login ? streams.archives : 1).catch((error) => error));
      }
      const vods = await listings.get(key);
      if (vods instanceof Error) {
        if (vods.missingTool) {
          this._log(`${vods.message}: stream announcements wait until it is`);
          break;
        }
        await this._updateAnnouncement(entry.id, { checkedAt: this._iso(), error: vods.message });
        result.waiting += 1;
        continue;
      }
      result.checked += 1;
      const announcedMs = Date.parse(entry.announcedAt);
      const vod = entry.vodId ? vods.find((v) => v.id === entry.vodId) : pickVod(vods, announcedMs);
      if (vod && vodFinished(vod, now, streams.settleMs)) {
        const clipId = await this._addVod(entry, vod);
        await this._updateAnnouncement(entry.id, { status: 'collected', vodId: vod.id, clipId, checkedAt: this._iso(), error: null });
        result.collected += 1;
        this._log(`${entry.login || vod.channel}: VOD ${vod.id} (${Math.round(vod.durationMs / 60000)} min, live ${vod.startedAt}) from #${entry.channelName}`);
      } else if (vod || now - announcedMs <= NO_VOD_AFTER_MS) {
        await this._updateAnnouncement(entry.id, { vodId: vod ? vod.id : entry.vodId, checkedAt: this._iso(), error: null });
        result.waiting += 1;
      } else {
        await this._updateAnnouncement(entry.id, { status: 'none', checkedAt: this._iso(), error: null });
        result.none += 1;
      }
    }
    return result;
  }

  /**
   * The clip for a finished VOD (one per VOD, however often it was announced).
   * @private
   */
  async _addVod (entry, vod) {
    const id = `twitch-v${vod.id}`;
    await this._exclusive(async () => {
      if (await this.store.get(`/clips/${id}`)) return;
      const login = vod.channel || entry.login || null;
      const clip = {
        id,
        kind: 'link',
        media: 'video',
        attachmentId: null,
        url: `https://www.twitch.tv/videos/${vod.id}`,
        filename: null,
        contentType: null,
        size: null,
        width: null,
        height: null,
        stream: { platform: 'twitch', channel: login, vodId: vod.id, announcement: entry.id },
        startedAt: vod.startedAt,
        guildId: entry.guildId,
        guildName: entry.guildName,
        channelId: entry.channelId,
        channelName: entry.channelName,
        threadName: entry.threadName,
        messageId: entry.messageId,
        messageUrl: entry.messageUrl,
        authorId: null,
        author: text(vod.streamer || entry.streamer || login || 'Unknown streamer', LIMITS.name),
        caption: text(vod.title || entry.title || '', LIMITS.caption),
        postedAt: entry.announcedAt,
        durationMs: vod.durationMs || null,
        hasAudio: null,
        codec: null,
        creationTime: null,
        recording: estimateRecordingTime({ startedAt: vod.startedAt, postedAt: entry.announcedAt, durationMs: vod.durationMs }, { defaultTimeZone: this.settings.defaultTimeZone }),
        override: null,
        proxy: { status: this.settings.streams.download ? 'pending' : 'skipped', attempts: 0, error: null },
        indexedAt: this._iso(),
        log: []
      };
      await this.store.set(`/clips/${id}`, clip);
      await this._append('clips', id);
    });
    return id;
  }

  _maxDownloadBytes (clip) {
    return clip && clip.stream ? this.settings.streams.maxDownloadBytes : this.settings.maxDownloadBytes;
  }

  /**
   * Whether the clip's largest allowed download still leaves the free-space
   * target (`minFreeBytes` / `minFreeRatio`) and stays under `maxBytes`.
   * A clip that doesn't fit waits without spending an attempt.
   * @private
   */
  async _roomToDownload (clip) {
    try {
      const extra = this._maxDownloadBytes(clip);
      const disk = await this._disk();
      if (disk.free == null) return true;
      if (disk.free < this._freeTarget(disk) + extra) return false;
      if (this.settings.maxBytes) {
        const used = (await this.usage()).used;
        if (used + extra > this.settings.maxBytes) return false;
      }
      return true;
    } catch (_) {
      return true;
    }
  }

  /**
   * Volume size and unused bytes on the clips filesystem (`statfs`).
   * @returns {Promise<{ free: number|null, total: number|null }>}
   * @private
   */
  async _disk () {
    try {
      const disk = typeof this.settings.statfs === 'function'
        ? await this.settings.statfs(this.dirs.tmp)
        : await fsp.statfs(this.dirs.tmp);
      const bsize = Number(disk.bsize) || 0;
      return {
        free: Number(disk.bavail) * bsize,
        total: Number(disk.blocks) * bsize
      };
    } catch (_) {
      return { free: null, total: null };
    }
  }

  /**
   * Bytes that must stay free: `minFreeBytes`, or `minFreeRatio` of the
   * volume when that is larger. `minFreeBytes` 0 turns both off (tests).
   * @private
   */
  _freeTarget (disk) {
    const floor = Number(this.settings.minFreeBytes) || 0;
    if (!floor) return 0;
    const ratio = Number(this.settings.minFreeRatio) || 0;
    const fromRatio = disk && disk.total && ratio > 0 ? Math.ceil(disk.total * ratio) : 0;
    return Math.max(floor, fromRatio);
  }

  async _dirBytes (dir) {
    let total = 0;
    let entries = [];
    try {
      entries = await fsp.readdir(dir, { recursive: true, withFileTypes: true });
    } catch (_) {
      return 0;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const full = path.join(entry.parentPath || dir, entry.name);
      try { total += (await fsp.stat(full)).size; } catch (_) {}
    }
    return total;
  }

  /**
   * Bytes on disk for the clips tree plus volume free space.
   * @param {Object} [opts]
   * @param {boolean} [opts.refresh] Ignore the short cache.
   * @returns {Promise<Object>}
   */
  async usage (opts = {}) {
    const disk = await this._disk();
    const now = this.settings.now();
    if (!opts.refresh && this._usageCache && now - this._usageCache.at < 60 * 1000) {
      return Object.assign({}, this._usageCache, { free: disk.free, total: disk.total, target: this._freeTarget(disk) });
    }
    const media = await this._dirBytes(this.dirs.media);
    const masters = await this._dirBytes(this.dirs.masters);
    const renders = await this._dirBytes(this.dirs.renders);
    const tmp = await this._dirBytes(this.dirs.tmp);
    const used = media + masters + renders + tmp;
    this._usageCache = {
      at: now,
      used,
      free: disk.free,
      total: disk.total,
      target: this._freeTarget(disk),
      maxBytes: this.settings.maxBytes || 0,
      media,
      masters,
      renders,
      tmp
    };
    return Object.assign({}, this._usageCache);
  }

  _invalidateUsage () {
    this._usageCache = null;
  }

  /**
   * Remove leftover work directories from a crashed download or render.
   * Skipped while a download or render is running.
   * @returns {Promise<number>}
   * @private
   */
  async _sweepTmp () {
    if (this._processing) return 0;
    let names = [];
    try { names = await fsp.readdir(this.dirs.tmp); } catch (_) { return 0; }
    let n = 0;
    for (const name of names) {
      await fsp.rm(path.join(this.dirs.tmp, name), { recursive: true, force: true }).catch(() => {});
      n += 1;
    }
    if (n) this._invalidateUsage();
    return n;
  }

  /**
   * Drop a clip's stored original. Proxies stay so the library still plays.
   * @returns {Promise<number>} Bytes removed.
   * @private
   */
  async _dropMaster (clip) {
    const file = this._masterPath(clip);
    if (!file) return 0;
    let size = (clip.master && clip.master.bytes) || 0;
    try { size = (await fsp.stat(file)).size; } catch (_) {}
    await fsp.rm(file, { force: true }).catch(() => {});
    await this._updateClip(clip.id, (record) => {
      record.master = Object.assign({}, record.master, {
        file: null,
        bytes: null,
        storedAt: null,
        droppedAt: this._iso()
      });
    });
    return size;
  }

  async _dropOldRenders (needBytes) {
    if (!(needBytes > 0)) return { count: 0, bytes: 0 };
    const rows = [];
    for (const id of await this._list('renders')) {
      const render = await this.store.get(`/renders/${id}`);
      if (!render || render.status !== 'complete') continue;
      const file = path.join(this.dirs.renders, `${id}.mp4`);
      if (!fs.existsSync(file)) continue;
      rows.push({ id, at: render.completedAt || render.createdAt || '', file });
    }
    rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    let bytes = 0;
    let count = 0;
    const keepMs = this.settings.renderKeepMs || 0;
    const now = this.settings.now();
    for (const row of rows) {
      if (bytes >= needBytes) break;
      const age = now - Date.parse(row.at);
      if (keepMs && Number.isFinite(age) && age < keepMs && rows.length - count <= 1) continue;
      let size = 0;
      try { size = (await fsp.stat(row.file)).size; } catch (_) { continue; }
      await fsp.rm(row.file, { force: true }).catch(() => {});
      await fsp.rm(row.file.replace(/\.mp4$/, '.sources.json'), { force: true }).catch(() => {});
      bytes += size;
      count += 1;
    }
    return { count, bytes };
  }

  /**
   * Drop stored originals (and old renders) until the volume has the free-space
   * target and `maxBytes` is not exceeded. Screenshots go first — Discord still
   * has them — then ordinary clips, then VODs (Twitch deletes those in weeks).
   * @returns {Promise<{ swept: number, dropped: Array<string>, bytes: number, renders: number }>}
   */
  async reclaim () {
    const swept = this._processing ? 0 : await this._sweepTmp();
    const usage = await this.usage({ refresh: true });
    let need = 0;
    if (usage.free != null && usage.target && usage.free < usage.target) need = usage.target - usage.free;
    if (this.settings.maxBytes && usage.used > this.settings.maxBytes) {
      need = Math.max(need, usage.used - this.settings.maxBytes);
    }
    if (need <= 0) return { swept, dropped: [], bytes: 0, renders: 0 };

    const clips = [];
    for (const id of await this._list('clips')) {
      const clip = await this.store.get(`/clips/${id}`);
      if (clip && this._hasMaster(clip)) clips.push(clip);
    }
    const rank = (clip) => (isStill(clip) ? 0 : (clip.stream ? 2 : 1));
    clips.sort((a, b) => rank(a) - rank(b)
      || String((a.master && a.master.storedAt) || '').localeCompare(String((b.master && b.master.storedAt) || ''))
      || String(a.id).localeCompare(String(b.id)));

    const dropped = [];
    let bytes = 0;
    for (const clip of clips) {
      if (bytes >= need) break;
      const size = await this._dropMaster(clip);
      if (!size) continue;
      dropped.push(clip.id);
      bytes += size;
    }
    this._invalidateUsage();
    let renders = { count: 0, bytes: 0 };
    if (bytes < need) renders = await this._dropOldRenders(need - bytes);
    if (dropped.length || renders.count) this._invalidateUsage();
    return { swept, dropped, bytes: bytes + renders.bytes, renders: renders.count };
  }

  // ---------------------------------------------------------------- media

  /**
   * Run a command; resolves `{ code, stdout, stderr }`, rejects when it fails.
   * @private
   */
  _run (command, args, opts = {}) {
    const missing = (error) => {
      if (!error || error.code !== 'ENOENT') return error;
      const out = new Error(`${command} is not installed`);
      out.missingTool = command;
      return out;
    };
    if (this.settings.run) {
      return Promise.resolve().then(() => this.settings.run(command, args, opts)).catch((error) => { throw missing(error); }).then((out) => {
        if (out && out.code && !opts.keepOutput) throw new Error(`${path.basename(command)} exited ${out.code}: ${String(out.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
        return out || { code: 0, stdout: '', stderr: '' };
      });
    }
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        if (opts.onStdout) opts.onStdout(chunk.toString());
        else if (stdout.length < 4 * 1024 * 1024) stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-16 * 1024); });
      child.on('error', (error) => reject(missing(error)));
      child.on('close', (code) => {
        if (code && !opts.keepOutput) return reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
        resolve({ code, stdout, stderr });
      });
    });
  }

  async _download (url, dest) {
    const res = await this._fetch(url, { headers: { 'User-Agent': 'GoonVCClips/0.1' } });
    if (!res || !res.ok) throw new Error(`Download failed (HTTP ${res ? res.status : 0})`);
    const max = this.settings.maxDownloadBytes;
    const length = Number(res.headers && res.headers.get && res.headers.get('content-length'));
    if (length > max) throw new Error(`The clip is larger than ${Math.round(max / 1048576)} MB`);
    if (res.body && typeof res.body.getReader === 'function') {
      let seen = 0;
      const limit = new Transform({
        transform (chunk, encoding, done) {
          seen += chunk.length;
          if (seen > max) return done(new Error(`The clip is larger than ${Math.round(max / 1048576)} MB`));
          done(null, chunk);
        }
      });
      await pipeline(Readable.fromWeb(res.body), limit, fs.createWriteStream(dest));
      return dest;
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > max) throw new Error(`The clip is larger than ${Math.round(max / 1048576)} MB`);
    await fsp.writeFile(dest, buffer);
    return dest;
  }

  async _discordPost (apiPath, token, body) {
    const res = await this._fetch(DISCORD_API + apiPath, {
      method: 'POST',
      headers: {
        Authorization: 'Bot ' + token,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'GoonVCClips/0.1'
      },
      body: JSON.stringify(body)
    });
    let json = null;
    try { json = JSON.parse(await res.text()); } catch (_) { json = null; }
    return { status: res.status, json };
  }

  /**
   * Current CDN URLs for clips; Discord's signed attachment URLs expire, so
   * the stored one is only a hint. Asks `/attachments/refresh-urls`, then
   * re-reads the message for anything that didn't come back.
   * @param {Array<Object>} clips
   * @param {string} token
   * @returns {Promise<Map<string, string>>} clip id → URL
   */
  async _freshUrls (clips, token) {
    const urls = new Map();
    const refreshable = clips.filter((clip) => clip.kind !== 'link' && clip.url);
    for (let i = 0; i < refreshable.length; i += 50) {
      const batch = refreshable.slice(i, i + 50);
      const res = await this._discordPost('/attachments/refresh-urls', token, { attachment_urls: batch.map((clip) => clip.url) }).catch(() => null);
      const rows = res && res.status === 200 && res.json && Array.isArray(res.json.refreshed_urls) ? res.json.refreshed_urls : [];
      const byPath = new Map(rows.map((row) => [String(row.original || '').split('?')[0], row.refreshed]));
      for (const clip of batch) {
        const fresh = byPath.get(String(clip.url).split('?')[0]);
        if (fresh) urls.set(clip.id, fresh);
      }
    }
    for (const clip of clips) {
      if (urls.has(clip.id)) continue;
      if (clip.kind === 'link') {
        urls.set(clip.id, clip.url);
        continue;
      }
      const res = await discordEvents.discordGet(`/channels/${clip.channelId}/messages/${clip.messageId}`, token, this._discordOpts());
      if (res.status === 404) throw new Error(`The Discord message for ${clip.filename || clip.id} was deleted`);
      if (res.status !== 200 || !res.json) throw new Error(errorMessage(res));
      const match = extractClips(res.json).find((item) => item.id === clip.id);
      if (!match || !match.url) throw new Error(`The clip ${clip.filename || clip.id} is no longer on its message`);
      urls.set(clip.id, match.url);
    }
    return urls;
  }

  /**
   * Fetch a clip's full-resolution original to `dest` (yt-dlp for links).
   * @private
   */
  _ytdlpFormat (clip) {
    // Twitch serves sound and picture together, so a stream needs no merge.
    if (clip && clip.stream) {
      const h = this.settings.streams.maxSourceHeight;
      return `b[height<=${h}]/bv*[height<=${h}]+ba/b`;
    }
    const h = this.settings.maxSourceHeight;
    return `bv*[height<=${h}]+ba/b[height<=${h}]/b`;
  }

  async _fetchOriginal (clip, url, dest) {
    if (clip.kind === 'link') {
      const out = `${dest}.mp4`;
      const max = this._maxDownloadBytes(clip);
      await this._run(this.settings.ytdlpPath, [
        '--no-playlist', '--no-progress', '-f', this._ytdlpFormat(clip),
        '--merge-output-format', 'mp4', '--max-filesize', String(max),
        ...(clip.stream ? ['--concurrent-fragments', '4'] : []),
        '--write-info-json', '-o', out, url
      ]);
      if (fs.existsSync(out)) return out;
      // yt-dlp exits 0 without a file when the video is over --max-filesize, and may add an extension.
      const dir = path.dirname(out);
      const saved = fs.readdirSync(dir).find((name) => name.startsWith(path.basename(out)) && !/\.(part|ytdl|info\.json)$/.test(name));
      if (!saved) throw new Error(`yt-dlp saved nothing (over the ${Math.round(max / 1048576)} MB download limit?)`);
      return path.join(dir, saved);
    }
    return this._download(url, dest);
  }

  /**
   * When the link's host says it had the video (yt-dlp's `timestamp`: Medal's
   * clip creation, YouTube's upload), from the info JSON written beside `dest`.
   * @private
   */
  async _hostTimestamp (dest) {
    const dir = path.dirname(dest);
    const name = (await fsp.readdir(dir).catch(() => [])).find((file) => file.startsWith(path.basename(dest)) && file.endsWith('.info.json'));
    if (!name) return null;
    try {
      const info = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'));
      const seconds = Number(info.timestamp);
      return Number.isFinite(seconds) && seconds > 0 ? new Date(seconds * 1000).toISOString() : null;
    } catch (_) {
      return null;
    }
  }

  async _probe (file) {
    const { stdout } = await this._run(this.settings.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]);
    let info;
    try { info = JSON.parse(stdout); } catch (_) { throw new Error('ffprobe returned no metadata'); }
    const streams = Array.isArray(info.streams) ? info.streams : [];
    const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
    if (!video) throw new Error('The file has no video stream');
    const format = info.format || {};
    const seconds = Number(format.duration) || Number(video.duration) || 0;
    const tags = Object.assign({}, video.tags || {}, format.tags || {});
    return {
      durationMs: Math.round(seconds * 1000),
      width: Number(video.width) || null,
      height: Number(video.height) || null,
      codec: video.codec_name || null,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      creationTime: tags.creation_time || tags.CREATION_TIME || tags.date || null,
      timeTags: containerTimeTags(format.tags, video.tags)
    };
  }

  _mediaPath (id, ext) {
    return path.join(this.dirs.media, `${id}.${ext}`);
  }

  _masterPath (clip) {
    return clip.master && clip.master.file ? path.join(this.dirs.masters, path.basename(clip.master.file)) : null;
  }

  _hasMaster (clip) {
    const file = this._masterPath(clip);
    return Boolean(file && fs.existsSync(file));
  }

  async _roomForMasters () {
    if (!this.settings.minFreeBytes && !this.settings.maxBytes) return true;
    try {
      const disk = await this._disk();
      if (disk.free == null) return true;
      if (disk.free < this._freeTarget(disk)) return false;
      if (this.settings.maxBytes && (await this.usage()).used >= this.settings.maxBytes) return false;
      return true;
    } catch (_) {
      return true;
    }
  }

  /**
   * Move a downloaded original into `masters/`, replacing the clip's older
   * master. Returns the `master` record, or null when masters are off or the
   * disk is short on space.
   * @private
   */
  async _keepMaster (clip, original, probe) {
    if (!this.settings.keepMasters || !(await this._roomForMasters())) return null;
    const ext = path.extname(original) || (/^\.[a-z0-9]{2,4}$/i.test(path.extname(clip.filename || '')) ? path.extname(clip.filename).toLowerCase() : '.mp4');
    const file = `${clip.id}${ext}`;
    const dest = path.join(this.dirs.masters, file);
    const old = this._masterPath(clip);
    await fsp.rename(original, dest);
    if (old && old !== dest) await fsp.rm(old, { force: true }).catch(() => {});
    this._invalidateUsage();
    const at = this._iso();
    return {
      file,
      width: probe.width,
      height: probe.height,
      bytes: (await fsp.stat(dest)).size,
      storedAt: at,
      checkedAt: at,
      error: null
    };
  }

  /**
   * A clip's recording time from its name and what its file says (see
   * `functions/clipRecordingTime.js`). Learns the uploader's UTC offset when the
   * file's own metadata settles it, for their later clips.
   * @private
   * @param {Object} clip
   * @param {Object} file `{ timeTags, creationTime, uploadedAt, durationMs }`
   */
  async _dateRecording (clip, file) {
    const authorKey = clip.authorId ? `/authors/${clip.authorId}` : null;
    const author = authorKey ? await this.store.get(authorKey) : null;
    const recording = estimateRecordingTime({
      filename: clip.filename,
      timeTags: file.timeTags,
      creationTime: file.creationTime,
      uploadedAt: file.uploadedAt,
      startedAt: clip.startedAt,
      postedAt: clip.postedAt,
      durationMs: file.durationMs
    }, {
      knownOffsetMinutes: author ? author.offsetMinutes : undefined,
      defaultTimeZone: this.settings.defaultTimeZone
    });
    if (authorKey && recording.zone === 'metadata' && recording.confidence === 'high' && recording.offsetMinutes !== null &&
      (!author || author.offsetMinutes !== recording.offsetMinutes)) {
      await this.store.set(authorKey, { offsetMinutes: recording.offsetMinutes, learnedFrom: clip.id, at: this._iso() });
    }
    return recording;
  }

  /**
   * Proxy (low resolution, low frame rate) and thumbnail sprite for one clip;
   * for a screenshot, a preview image and a one-frame sprite.
   * @private
   */
  async _makeProxy (clip, url) {
    const work = path.join(this.dirs.tmp, `${clip.id}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(work, { recursive: true });
    try {
      const original = await this._fetchOriginal(clip, url, path.join(work, 'original'));
      const probe = await this._probe(original);
      if (isStill(clip)) {
        probe.durationMs = 0;
        probe.timeTags = imageTimeTags(await fsp.readFile(original)).concat(probe.timeTags);
      }
      // A VOD's host time is when it went live (`startedAt`), not an upload.
      probe.uploadedAt = clip.kind === 'link' && !clip.stream ? await this._hostTimestamp(path.join(work, 'original')) : null;
      const recording = await this._dateRecording(clip, probe);
      if (isStill(clip)) return await this._makeStill(clip, original, probe, recording, work);

      const h = this.settings.proxyHeight;
      const proxyPart = path.join(work, 'proxy.mp4');
      await this._run(this.settings.ffmpegPath, [
        '-y', '-hide_banner', '-nostdin', '-i', original,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-vf', `scale=-2:trunc(min(${h}\\,ih)/2)*2,fps=${this.settings.proxyFps}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '32', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '48k', '-ac', '2',
        '-movflags', '+faststart', proxyPart
      ]);

      const seconds = Math.max(0.1, probe.durationMs / 1000);
      const every = Math.max(this.settings.thumbEverySec, seconds / this.settings.maxThumbs);
      const count = Math.max(1, Math.min(this.settings.maxThumbs, Math.ceil(seconds / every)));
      const columns = Math.min(10, count);
      const rows = Math.ceil(count / columns);
      const th = this.settings.thumbHeight;
      const aspect = probe.width && probe.height ? probe.width / probe.height : 16 / 9;
      const tw = Math.max(2, Math.round((th * aspect) / 2) * 2);
      const spritePart = path.join(work, 'thumbs.jpg');
      await this._run(this.settings.ffmpegPath, [
        '-y', '-hide_banner', '-nostdin', '-i', proxyPart,
        // eof_action=pass: clips shorter than half a thumbnail interval still get a frame.
        '-vf', `fps=${(1 / every).toFixed(6)}:eof_action=pass,scale=${tw}:${th},tile=${columns}x${rows}`,
        '-frames:v', '1', '-q:v', '5', spritePart
      ]);

      await fsp.rename(proxyPart, this._mediaPath(clip.id, 'mp4'));
      await fsp.rename(spritePart, this._mediaPath(clip.id, 'jpg'));
      const bytes = (await fsp.stat(this._mediaPath(clip.id, 'mp4'))).size;
      const proxyHeight = probe.height ? Math.min(h, Math.floor(probe.height / 2) * 2) : h;
      const master = await this._keepMaster(clip, original, probe);
      return {
        ...(master ? { master } : {}),
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        hasAudio: probe.hasAudio,
        creationTime: probe.creationTime,
        timeTags: probe.timeTags,
        uploadedAt: probe.uploadedAt,
        recording,
        proxy: {
          status: 'ready',
          attempts: (clip.proxy && clip.proxy.attempts) || 0,
          error: null,
          height: proxyHeight,
          width: Math.round((proxyHeight * aspect) / 2) * 2,
          bytes,
          builtAt: this._iso(),
          thumbs: { every: Number(every.toFixed(3)), count, columns, rows, width: tw, height: th }
        }
      };
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * A screenshot's preview (at most `stillHeight` tall, served as its proxy)
   * and a one-frame thumbnail sprite, so it sits in a session like a clip.
   * @private
   */
  async _makeStill (clip, original, probe, recording, work) {
    const sh = this.settings.stillHeight;
    const previewPart = path.join(work, 'preview.jpg');
    await this._run(this.settings.ffmpegPath, [
      '-y', '-hide_banner', '-nostdin', '-i', original,
      '-vf', `scale=-2:trunc(min(${sh}\\,ih)/2)*2`,
      '-frames:v', '1', '-q:v', '3', previewPart
    ]);
    const th = this.settings.thumbHeight;
    const aspect = probe.width && probe.height ? probe.width / probe.height : 16 / 9;
    const tw = Math.max(2, Math.round((th * aspect) / 2) * 2);
    const spritePart = path.join(work, 'thumbs.jpg');
    await this._run(this.settings.ffmpegPath, [
      '-y', '-hide_banner', '-nostdin', '-i', original,
      '-vf', `scale=${tw}:${th}`,
      '-frames:v', '1', '-q:v', '5', spritePart
    ]);
    await fsp.rename(previewPart, this._mediaPath(clip.id, 'preview.jpg'));
    await fsp.rename(spritePart, this._mediaPath(clip.id, 'jpg'));
    const bytes = (await fsp.stat(this._mediaPath(clip.id, 'preview.jpg'))).size;
    const previewHeight = probe.height ? Math.min(sh, Math.floor(probe.height / 2) * 2) : sh;
    const master = await this._keepMaster(clip, original, probe);
    return {
      ...(master ? { master } : {}),
      durationMs: null,
      width: probe.width,
      height: probe.height,
      codec: probe.codec,
      hasAudio: false,
      creationTime: probe.creationTime,
      timeTags: probe.timeTags,
      uploadedAt: probe.uploadedAt,
      recording,
      proxy: {
        status: 'ready',
        attempts: (clip.proxy && clip.proxy.attempts) || 0,
        error: null,
        height: previewHeight,
        width: Math.round((previewHeight * aspect) / 2) * 2,
        bytes,
        builtAt: this._iso(),
        thumbs: { every: 1, count: 1, columns: 1, rows: 1, width: tw, height: th }
      }
    };
  }

  /**
   * Whether a link clip is downloaded (its host is in `externalLinks`).
   * @private
   */
  _importsLink (clip) {
    if (clip.stream) return Boolean(this.settings.streams.download);
    const hosts = this.settings.externalLinks;
    if (hosts === true) return true;
    if (!Array.isArray(hosts) || !hosts.length) return false;
    let host;
    try {
      host = new URL(clip.url).hostname.toLowerCase().replace(/^www\./, '');
    } catch (_) {
      return false;
    }
    return hosts.some((entry) => {
      const want = String(entry).toLowerCase().replace(/^www\./, '');
      return host === want || host.endsWith(`.${want}`);
    });
  }

  /**
   * Queue every stored link-only clip whose host is in `externalLinks` for a
   * proxy (downloaded with yt-dlp). `start` does this on every boot.
   * @returns {Promise<number>} clips queued
   */
  async queueLinks () {
    let queued = 0;
    for (const id of await this._list('clips')) {
      const clip = await this.store.get(`/clips/${id}`);
      if (!clip || clip.kind !== 'link' || !clip.proxy || clip.proxy.status !== 'skipped') continue;
      if (!this._importsLink(clip)) continue;
      await this._updateClip(id, (record) => { record.proxy = { status: 'pending', attempts: 0, error: null }; });
      queued += 1;
    }
    return queued;
  }

  /**
   * Date every stored clip again from what was saved about its file (name,
   * metadata times, the host's upload, length), oldest post first so
   * uploaders' zones are learned in order. `start` does this on every boot, so
   * stored clips follow the current rules without downloading anything again.
   * @returns {Promise<number>} clips whose estimate changed
   */
  async redate () {
    const clips = (await this._allClips())
      .filter((clip) => clip.recording)
      .sort((a, b) => String(a.postedAt || '').localeCompare(String(b.postedAt || '')));
    let changed = 0;
    for (const clip of clips) {
      const recording = await this._dateRecording(clip, {
        timeTags: clip.timeTags,
        creationTime: clip.creationTime,
        uploadedAt: clip.uploadedAt,
        durationMs: isStill(clip) ? 0 : clip.durationMs
      });
      if (JSON.stringify(recording) === JSON.stringify(clip.recording)) continue;
      await this._updateClip(clip.id, (record) => { record.recording = recording; });
      changed += 1;
    }
    return changed;
  }

  /**
   * Queue failed clips for another try. By default only the ones that failed
   * because the host was missing a tool or codec (ffmpeg, ffprobe, yt-dlp,
   * libx264, a filter), which `start` does on every boot; `olderThanMs` adds
   * failures at least that old, and `all` retries every failure.
   * @param {Object} [opts]
   * @param {boolean} [opts.all] retry every failed clip
   * @param {number} [opts.olderThanMs] also retry failures this old (or of unknown age)
   * @returns {Promise<number>} clips queued
   */
  async retryFailed (opts = {}) {
    const now = this.settings.now();
    let queued = 0;
    for (const id of await this._list('clips')) {
      const clip = await this.store.get(`/clips/${id}`);
      if (!clip || !clip.proxy || clip.proxy.status !== 'failed') continue;
      const failedAt = Date.parse(clip.proxy.failedAt || '');
      const stale = opts.olderThanMs > 0 && !(now - failedAt < opts.olderThanMs);
      if (!opts.all && !stale && !MISSING_DEPENDENCY.test(clip.proxy.error || '')) continue;
      await this._updateClip(id, (record) => { record.proxy = { status: 'pending', attempts: 0, error: null }; });
      queued += 1;
    }
    return queued;
  }

  async _toolVersions () {
    const versions = {};
    for (const [name, command, args] of [['ffmpeg', this.settings.ffmpegPath, ['-version']], ['yt-dlp', this.settings.ytdlpPath, ['--version']]]) {
      try {
        const { stdout } = await this._run(command, args);
        versions[name] = String(stdout || '').split('\n')[0].trim().slice(0, 120) || null;
      } catch (_) {
        versions[name] = null;
      }
    }
    return versions;
  }

  /**
   * Requeue every failed clip when ffmpeg or yt-dlp was installed or upgraded
   * since the last check: a new release often fixes what failed (yt-dlp's site
   * extractors break whenever a host changes its pages).
   * @returns {Promise<number>} clips queued
   */
  async retryAfterToolChange () {
    const versions = await this._toolVersions();
    const seen = await this.store.get('/tools');
    const changed = Object.keys(versions).filter((name) => versions[name] && (!seen || versions[name] !== seen[name]));
    if (!changed.length) return 0;
    const kept = Object.fromEntries(Object.entries(versions).filter(([, version]) => version));
    await this.store.set('/tools', Object.assign({}, seen, kept, { checkedAt: this._iso() }));
    const queued = await this.retryFailed({ all: true });
    if (queued) this._log(`queued ${queued} failed clip${queued === 1 ? '' : 's'}: ${changed.map((name) => `${name} is now ${versions[name]}`).join(', ')}`);
    return queued;
  }

  _processInBackground () {
    if (this._processing || this._stopped) return this._processing;
    this._processing = this.collectStreams()
      .catch((error) => this._log(`stream announcements: ${error.message || error}`))
      .then(() => this.processPending())
      .catch(() => {})
      .finally(() => { this._processing = null; });
    return this._processing;
  }

  /**
   * Build proxies for every clip still waiting for one, one at a time.
   * @returns {Promise<number>} proxies built
   */
  async processPending () {
    let built = 0;
    let token = null;
    const waiting = { clip: false, stream: false };
    let noLinks = false;
    const ids = await this._list('clips');
    let index = 0;
    for (const id of ids) {
      index += 1;
      if (this._stopped) break;
      const clip = await this.store.get(`/clips/${id}`);
      if (!clip || !clip.proxy || clip.proxy.status !== 'pending') continue;
      if (noLinks && clip.kind === 'link') continue;
      const kind = clip.stream ? 'stream' : 'clip';
      if (waiting[kind] || !(await this._roomToDownload(clip))) {
        if (!waiting[kind]) this._log(`${clip.stream ? 'VODs' : 'Clips'} wait for disk space: one may take ${Math.round(this._maxDownloadBytes(clip) / 1073741824)} GB on top of minFreeBytes (${Math.round(this.settings.minFreeBytes / 1073741824)} GB)`);
        waiting[kind] = true;
        continue;
      }
      try {
        if (!token) token = this._token();
        const urls = await this._freshUrls([clip], token);
        const made = await this._makeProxy(clip, urls.get(clip.id));
        await this._updateClip(id, (record) => Object.assign(record, made, { url: urls.get(clip.id) || record.url }));
        built += 1;
        const length = isStill(clip) ? 'screenshot' : `${Math.round(made.durationMs / 1000)}s`;
        this._log(`[${index}/${ids.length}] ${clip.author}: ${clip.filename || clip.id} (${length}, recorded ${made.recording.recordedAt} from ${made.recording.source})`);
      } catch (error) {
        if (error.missingTool && error.missingTool === this.settings.ytdlpPath && clip.kind === 'link') {
          // Only link clips need yt-dlp; uploads and embeds still get proxies.
          this._log(`${error.message}: link clips wait until it is (nothing marked failed)`);
          noLinks = true;
          continue;
        }
        if (error.missingTool) {
          this._log(`${error.message}: proxies wait until it is (nothing marked failed)`);
          break;
        }
        this._log(`[${index}/${ids.length}] ${clip.author}: ${clip.filename || clip.id} failed: ${error.message || error}`);
        await this._updateClip(id, (record) => {
          const attempts = ((record.proxy && record.proxy.attempts) || 0) + 1;
          record.proxy = Object.assign({}, record.proxy, {
            status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
            attempts,
            error: error.message || String(error),
            failedAt: attempts >= MAX_ATTEMPTS ? this._iso() : null
          });
        });
      }
    }
    return built;
  }

  /**
   * Tallest version a link's host offers now (within `maxSourceHeight`),
   * asked of yt-dlp without downloading.
   * @private
   */
  async _availableHeight (clip) {
    const { stdout } = await this._run(this.settings.ytdlpPath, ['--no-playlist', '--no-warnings', '-J', '-f', this._ytdlpFormat(clip), clip.url]);
    let info;
    try { info = JSON.parse(stdout); } catch (_) { throw new Error('yt-dlp returned no metadata'); }
    const heights = [info.height].concat((info.requested_formats || []).map((format) => format.height)).map(Number).filter((n) => n > 0);
    return heights.length ? Math.max(...heights) : null;
  }

  _rescanInBackground () {
    if (this._rescanning || this._processing || this._stopped) return this._rescanning;
    this._rescanning = this.maintain()
      .catch(() => {})
      .finally(() => { this._rescanning = null; });
    return this._rescanning;
  }

  /**
   * The periodic pass: retry failed clips (all of them after a tool upgrade,
   * otherwise those that failed `recheckAfterMs` ago), then `rescan`.
   * @returns {Promise<Object>} `{ retried, checked, stored, upgraded }`
   */
  async maintain () {
    const reclaimed = await this.reclaim();
    if (reclaimed.bytes) {
      this._log(`reclaimed ${(reclaimed.bytes / 1e9).toFixed(1)} GB of clip masters`);
    }
    const upgraded = await this.retryAfterToolChange();
    const stale = await this.retryFailed({ olderThanMs: this.settings.recheckAfterMs });
    if (stale) this._log(`queued ${stale} clip${stale === 1 ? '' : 's'} that failed over ${Math.round(this.settings.recheckAfterMs / 86400000)} days ago`);
    const retried = upgraded + stale;
    if (retried) {
      this._processInBackground();
      return { retried, checked: 0, stored: 0, upgraded: 0 };
    }
    return Object.assign({ retried: 0 }, await this.rescan());
  }

  /**
   * Keep the stored downloads at their best: store a master for ready clips
   * that have none (downloaded before masters were kept, or lost), and check
   * link clips not checked for `recheckAfterMs` for a taller version than the
   * stored one, downloading it (and rebuilding the proxy) when there is.
   * Attachments and embeds are fixed files, so once stored they are left alone.
   * @param {Object} [opts]
   * @param {number} [opts.limit] Clips checked this pass (default `rescanBatch`).
   * @returns {Promise<{ checked: number, stored: number, upgraded: number }>}
   */
  async rescan (opts = {}) {
    const limit = opts.limit === undefined ? this.settings.rescanBatch : opts.limit;
    const result = { checked: 0, stored: 0, upgraded: 0 };
    if (!this.settings.keepMasters) return result;
    const now = this.settings.now();
    let token = null;
    for (const id of await this._list('clips')) {
      if (this._stopped || result.checked >= limit) break;
      const clip = await this.store.get(`/clips/${id}`);
      if (!clip || !clip.proxy || clip.proxy.status !== 'ready') continue;
      const stored = this._hasMaster(clip);
      // A VOD never gets better, and Twitch deletes it in weeks.
      if (stored && (clip.kind !== 'link' || clip.stream)) continue;
      const checkedAt = Date.parse((clip.master && clip.master.checkedAt) || '');
      if (Number.isFinite(checkedAt) && now - checkedAt < this.settings.recheckAfterMs) continue;
      if (!(await this._roomToDownload(clip))) {
        this._log('rescan paused: a download would take the disk below minFreeBytes');
        break;
      }
      result.checked += 1;
      const label = `${clip.author}: ${clip.filename || clip.url || clip.id}`;
      try {
        if (stored) {
          const available = await this._availableHeight(clip);
          if (!available || available <= (clip.master.height || 0)) {
            await this._updateClip(id, (record) => { record.master = Object.assign({}, record.master, { checkedAt: this._iso(), error: null }); });
            continue;
          }
          this._log(`rescan ${label}: ${available}p is up (stored ${clip.master.height || '?'}p)`);
        }
        if (!token) token = this._token();
        const urls = await this._freshUrls([clip], token);
        const made = await this._makeProxy(clip, urls.get(clip.id));
        await this._updateClip(id, (record) => Object.assign(record, made, { url: urls.get(clip.id) || record.url }));
        if (!made.master) break;
        if (stored) result.upgraded += 1;
        else result.stored += 1;
        this._log(`rescan ${label}: stored ${made.master.height}p master`);
      } catch (error) {
        if (error.missingTool) {
          this._log(`${error.message}: rescan waits until it is`);
          break;
        }
        this._log(`rescan ${label} failed: ${error.message || error}`);
        await this._updateClip(id, (record) => {
          record.master = Object.assign({ file: null }, record.master, { checkedAt: this._iso(), error: error.message || String(error) });
        });
      }
    }
    return result;
  }

  async _updateClip (id, change) {
    return this._exclusive(async () => {
      const clip = await this.store.get(`/clips/${id}`);
      if (!clip) throw fail(404, 'No such clip.');
      const copy = JSON.parse(JSON.stringify(clip));
      change(copy);
      await this.store.set(`/clips/${id}`, copy);
      return copy;
    });
  }

  // ---------------------------------------------------------------- reads

  async _allClips () {
    const out = [];
    for (const id of await this._list('clips')) {
      const clip = await this.store.get(`/clips/${id}`);
      if (clip) out.push(clip);
    }
    return out;
  }

  /**
   * The public view of a clip (no Discord user ids, no expiring URLs). A
   * screenshot's `durationMs` is its display time on the timeline, and its
   * `proxyUrl` the preview image.
   * @param {Object} clip
   * @returns {Object}
   */
  publicClip (clip) {
    const start = clipStartMs(clip);
    const ready = clip.proxy && clip.proxy.status === 'ready';
    const still = isStill(clip);
    return {
      id: clip.id,
      kind: clip.kind,
      media: still ? 'image' : 'video',
      author: clip.author,
      guild: clip.guildName,
      channel: clip.channelName,
      thread: clip.threadName || null,
      messageUrl: clip.messageUrl,
      linkUrl: clip.kind === 'link' ? clip.url : null,
      stream: clip.stream ? { platform: clip.stream.platform, channel: clip.stream.channel, url: clip.stream.channel ? `https://www.twitch.tv/${clip.stream.channel}` : null } : null,
      caption: plainCaption(clip.caption),
      filename: clip.filename,
      postedAt: clip.postedAt,
      durationMs: still ? this._stillMs() : clip.durationMs,
      width: clip.width,
      height: clip.height,
      hasAudio: clip.hasAudio,
      master: this._hasMaster(clip) ? { width: clip.master.width, height: clip.master.height } : null,
      recordedAt: Number.isFinite(start) ? new Date(start).toISOString() : null,
      recording: clip.recording,
      override: clip.override,
      proxy: {
        status: clip.proxy ? clip.proxy.status : 'pending',
        error: clip.proxy ? clip.proxy.error : null,
        width: ready ? clip.proxy.width : null,
        height: ready ? clip.proxy.height : null,
        thumbs: ready ? clip.proxy.thumbs : null
      },
      proxyUrl: ready ? `${BASE}/${clip.id}/proxy` : null,
      thumbsUrl: ready ? `${BASE}/${clip.id}/thumbs` : null
    };
  }

  _stillMs () {
    return Math.round(Math.min(this.settings.stillSeconds, this.settings.maxStillSeconds) * 1000);
  }

  async list () {
    const clips = await this._allClips();
    // Threads count toward their parent channel.
    const byName = new Map();
    const seen = new Set();
    for (const clip of clips) {
      if (seen.has(clip.channelId)) continue;
      seen.add(clip.channelId);
      const state = await this.store.get(`/channels/${clip.channelId}`);
      if (!state) continue;
      const key = `${state.guildName}\n${state.name}`;
      const entry = byName.get(key) || { guild: state.guildName, name: state.name, clips: 0, polledAt: null, error: null };
      entry.clips += state.clips || 0;
      if (state.polledAt && (!entry.polledAt || state.polledAt > entry.polledAt)) entry.polledAt = state.polledAt;
      entry.error = entry.error || state.error || null;
      byName.set(key, entry);
    }
    const channels = Array.from(byName.values());
    const status = (await this.store.get('/status')) || {};
    const count = (status_) => clips.filter((clip) => clip.proxy && clip.proxy.status === status_).length;
    if (this.settings.poll && (!status.polledAt || Date.now() - Date.parse(status.polledAt) > this.settings.ttlMs)) {
      this._refreshInBackground({ throttle: true });
    }
    const streams = { waiting: 0, collected: 0, none: 0, missed: 0 };
    for (const id of await this._list('streams')) {
      const entry = await this.store.get(`/streams/${id}`);
      if (entry && Object.prototype.hasOwnProperty.call(streams, entry.status)) streams[entry.status] += 1;
    }
    const disk = await this.usage();
    return {
      polling: !!this.settings.poll,
      status: Object.assign({}, status, {
        ready: count('ready'),
        pending: count('pending'),
        failed: count('failed'),
        linksOnly: count('skipped'),
        screenshots: clips.filter(isStill).length,
        vods: clips.filter((clip) => clip.stream).length,
        streams,
        disk: {
          used: disk.used,
          free: disk.free,
          total: disk.total,
          target: disk.target,
          maxBytes: disk.maxBytes,
          media: disk.media,
          masters: disk.masters,
          renders: disk.renders,
          tmp: disk.tmp
        }
      }),
      stills: { seconds: this._stillMs() / 1000, maxSeconds: this.settings.maxStillSeconds },
      channels,
      clips: clips
        .sort((a, b) => String(b.postedAt).localeCompare(String(a.postedAt)))
        .map((clip) => this.publicClip(clip))
    };
  }

  /**
   * Clips grouped by recording time, newest session first, each with its clips.
   * @returns {Promise<Array<Object>>}
   */
  async sessions () {
    const clips = await this._allClips();
    const byId = new Map(clips.map((clip) => [clip.id, clip]));
    return groupSessions(clips, { gapMs: this.settings.sessionGapMs, stillMs: this._stillMs() }).map((session) => Object.assign(session, {
      clips: session.tracks.flatMap((track) => track.clips.map((entry) => this.publicClip(byId.get(entry.id))))
    }));
  }

  async getClip (id) {
    if (!ID.test(String(id || ''))) return null;
    return this.store.get(`/clips/${id}`);
  }

  /**
   * Correct a clip's recording time or nudge it into sync with the others.
   * @param {string} id
   * @param {Object} input `{ recordedAt?: string|null, syncOffsetMs?: number }`
   * @param {string} [by]
   */
  async setOverride (id, input = {}, by) {
    if (!await this.getClip(id)) throw fail(404, 'No such clip.');
    const fields = {};
    if (Object.prototype.hasOwnProperty.call(input, 'recordedAt')) {
      if (input.recordedAt === null || input.recordedAt === '') {
        fields.recordedAt = null;
      } else {
        const ms = Date.parse(input.recordedAt);
        if (!Number.isFinite(ms) || new Date(ms).getUTCFullYear() < 2010) throw fail(400, 'recordedAt must be a date and time.');
        fields.recordedAt = new Date(ms).toISOString();
      }
    }
    if (Object.prototype.hasOwnProperty.call(input, 'syncOffsetMs')) {
      const offset = Math.round(Number(input.syncOffsetMs));
      if (!Number.isFinite(offset) || Math.abs(offset) > 10 * 60 * 1000) throw fail(400, 'syncOffsetMs must be within ten minutes.');
      fields.syncOffsetMs = offset;
    }
    if (!Object.keys(fields).length) throw fail(400, 'Nothing to change: send recordedAt or syncOffsetMs.');
    const clip = await this._updateClip(id, (record) => {
      const override = Object.assign({ recordedAt: null, syncOffsetMs: 0 }, record.override || {}, fields, { by: by || null, at: this._iso() });
      record.override = override.recordedAt || override.syncOffsetMs ? override : null;
      record.log = (record.log || []).concat(Object.assign({ at: this._iso(), type: 'override' }, fields, by ? { by } : {}));
    });
    return this.publicClip(clip);
  }

  // ---------------------------------------------------------------- projects

  async getProject (id) {
    if (!ID.test(String(id || ''))) return null;
    return this.store.get(`/projects/${id}`);
  }

  async listProjects () {
    const out = [];
    for (const id of await this._list('projects')) {
      const project = await this.getProject(id);
      if (project) out.push(this._projectSummary(project));
    }
    return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  _projectSummary (project) {
    return {
      id: project.id,
      name: project.name,
      sessionId: project.sessionId || null,
      revision: project.revision,
      segments: project.segments.length,
      durationMs: Math.round(project.segments.reduce((sum, s) => sum + (s.out - s.in), 0) * 1000),
      createdAt: project.createdAt,
      createdBy: project.createdBy || null,
      updatedAt: project.updatedAt,
      updatedBy: project.updatedBy || null,
      renders: (project.renders || []).length
    };
  }

  async _playableClips () {
    const map = {};
    for (const clip of await this._allClips()) {
      if (clip.proxy && clip.proxy.status === 'ready' && (isStill(clip) || clip.durationMs > 0)) map[clip.id] = clip;
    }
    return map;
  }

  async _segments (segments) {
    const out = normalizeSegments(segments || [], await this._playableClips(), {
      maxSegments: this.settings.maxSegments,
      maxDurationMs: this.settings.maxRenderSeconds * 1000,
      maxStillMs: this.settings.maxStillSeconds * 1000
    });
    // A render downloads every distinct source, so their number is capped too.
    const sources = new Set(out.map((segment) => segment.clipId)).size;
    if (sources > this.settings.maxRenderSources) throw fail(400, `A project uses at most ${this.settings.maxRenderSources} different clips.`);
    return out;
  }

  async publicProject (project) {
    const renders = [];
    for (const id of (project.renders || []).slice(-20).reverse()) {
      const render = await this.store.get(`/renders/${id}`);
      if (render) renders.push(this._publicRender(render));
    }
    return Object.assign(this._projectSummary(project), {
      notes: project.notes || '',
      segments: project.segments,
      renders,
      log: project.log
    });
  }

  /**
   * @param {Object} input `{ name, sessionId?, notes?, segments? }`
   * @param {string} [by]
   */
  async createProject (input = {}, by) {
    const name = text(input.name, LIMITS.name);
    if (name.length < 2) throw fail(400, 'A project needs a name.');
    const segments = await this._segments(input.segments);
    return this._exclusive(async () => {
      let id;
      do { id = crypto.randomBytes(5).toString('hex'); } while (await this.store.get(`/projects/${id}`));
      const now = this._iso();
      const project = {
        id,
        name,
        sessionId: input.sessionId && ID.test(String(input.sessionId)) ? String(input.sessionId) : null,
        notes: text(input.notes, LIMITS.notes),
        segments,
        revision: 1,
        createdAt: now,
        createdBy: by || null,
        updatedAt: now,
        updatedBy: by || null,
        renders: [],
        log: [Object.assign({ at: now, type: 'create', revision: 1, segments: segments.length }, by ? { by } : {})]
      };
      await this.store.set(`/projects/${id}`, project);
      await this._append('projects', id);
      return this.publicProject(project);
    });
  }

  /**
   * Save a project. Each save is a new revision; the one it replaces is kept.
   * @param {string} id
   * @param {Object} input `{ revision?, name?, notes?, segments?, sessionId? }`
   * @param {string} [by]
   */
  async saveProject (id, input = {}, by) {
    const segments = input.segments !== undefined ? await this._segments(input.segments) : undefined;
    return this._exclusive(async () => {
      const project = await this.getProject(id);
      if (!project) throw fail(404, 'No such project.');
      if (input.revision !== undefined && Number(input.revision) !== project.revision) {
        throw fail(409, 'Someone else saved this project since you opened it; reload to see their changes.');
      }
      await this.store.set(`/projects/${id}/revisions/${project.revision}`, {
        revision: project.revision,
        name: project.name,
        notes: project.notes,
        segments: project.segments,
        savedAt: project.updatedAt,
        savedBy: project.updatedBy || null
      });
      const now = this._iso();
      const changed = [];
      if (input.name !== undefined) {
        const name = text(input.name, LIMITS.name);
        if (name.length < 2) throw fail(400, 'A project needs a name.');
        if (name !== project.name) changed.push('name');
        project.name = name;
      }
      if (input.notes !== undefined) {
        const notes = text(input.notes, LIMITS.notes);
        if (notes !== project.notes) changed.push('notes');
        project.notes = notes;
      }
      if (input.sessionId !== undefined) {
        project.sessionId = input.sessionId && ID.test(String(input.sessionId)) ? String(input.sessionId) : null;
      }
      if (segments) {
        changed.push('segments');
        project.segments = segments;
      }
      project.revision += 1;
      project.updatedAt = now;
      project.updatedBy = by || null;
      project.log.push(Object.assign({ at: now, type: 'save', revision: project.revision, changed, segments: project.segments.length }, by ? { by } : {}));
      await this.store.set(`/projects/${id}`, project);
      return this.publicProject(project);
    });
  }

  /**
   * Link-preview metadata for a project page.
   * @param {string} pathname
   * @returns {Promise<Object|null>}
   */
  async page (pathname) {
    const base = `${String(this.settings.basePath).replace(/\/+$/, '')}/projects/`.toLowerCase();
    const clean = String(pathname || '').replace(/\/+$/, '');
    if (clean.toLowerCase().indexOf(base) !== 0) return null;
    const project = await this.getProject(clean.slice(base.length));
    if (!project) return null;
    const summary = this._projectSummary(project);
    const cut = summary.segments
      ? `${summary.segments} cut${summary.segments === 1 ? '' : 's'}, ${Math.round(summary.durationMs / 1000)} seconds`
      : 'No cuts yet';
    return { path: clean, title: project.name, description: `A squad film from our Discord clips. ${cut}.` };
  }

  // ---------------------------------------------------------------- renders

  _publicRender (render) {
    const done = render.status === 'complete';
    return Object.assign({}, render, {
      fileUrl: done ? `${BASE}/renders/${render.id}/file` : null,
      sourcesUrl: done ? `${BASE}/renders/${render.id}/sources` : null
    });
  }

  async getRender (id) {
    if (!ID.test(String(id || ''))) return null;
    return this.store.get(`/renders/${id}`);
  }

  async listRenders () {
    const out = [];
    for (const id of (await this._list('renders')).slice(-50).reverse()) {
      const render = await this.getRender(id);
      if (render) out.push(this._publicRender(render));
    }
    return out;
  }

  async _updateRender (id, fields) {
    return this._exclusive(async () => {
      const render = await this.store.get(`/renders/${id}`);
      if (!render) return null;
      const next = Object.assign(render, fields);
      await this.store.set(`/renders/${id}`, next);
      return next;
    });
  }

  /**
   * Queue a render of the project's current revision.
   * @param {string} projectId
   * @param {string} [by]
   */
  async startRender (projectId, by) {
    const render = await this._exclusive(async () => {
      const project = await this.getProject(projectId);
      if (!project) throw fail(404, 'No such project.');
      if (!project.segments.length) throw fail(400, 'Add segments to the program before rendering.');
      const renders = [];
      for (const id of project.renders || []) {
        const existing = await this.store.get(`/renders/${id}`);
        if (existing) renders.push(existing);
      }
      const same = renders.reverse().find((r) => r.revision === project.revision && r.status !== 'failed');
      if (same) return Object.assign({ existing: true }, same);
      let waiting = 0;
      for (const id of await this._list('renders')) {
        const other = await this.store.get(`/renders/${id}`);
        if (other && (other.status === 'queued' || other.status === 'running')) waiting += 1;
      }
      if (waiting >= this.settings.maxQueuedRenders) throw fail(429, `${waiting} renders are already in line; try again when one finishes.`);
      const now = this._iso();
      const id = `${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
      const record = {
        id,
        projectId,
        projectName: project.name,
        revision: project.revision,
        segments: project.segments,
        status: 'queued',
        progress: 0,
        createdAt: now,
        createdBy: by || null,
        startedAt: null,
        completedAt: null,
        durationMs: Math.round(project.segments.reduce((sum, s) => sum + (s.out - s.in), 0) * 1000),
        bytes: null,
        error: null
      };
      await this.store.set(`/renders/${id}`, record);
      await this._append('renders', id);
      project.renders = (project.renders || []).concat(id);
      project.log.push(Object.assign({ at: now, type: 'render', revision: project.revision, render: id }, by ? { by } : {}));
      await this.store.set(`/projects/${projectId}`, project);
      return record;
    });
    if (render.existing) {
      delete render.existing;
      return this._publicRender(render);
    }
    this._enqueueRender(render.id);
    return this._publicRender(render);
  }

  _enqueueRender (id) {
    this._renderChain = this._renderChain.then(() => (this._stopped ? null : this._render(id))).catch(() => {});
  }

  async _render (id) {
    const render = await this.getRender(id);
    if (!render || render.status !== 'queued') return;
    await this._updateRender(id, { status: 'running', startedAt: this._iso(), progress: 0, error: null });
    const work = path.join(this.dirs.tmp, `render-${id}`);
    const part = path.join(this.dirs.renders, `${id}.part.mp4`);
    try {
      await fsp.mkdir(work, { recursive: true });
      const project = await this.getProject(render.projectId);
      if (!project) throw new Error('The project is gone');
      const ids = Array.from(new Set(render.segments.map((segment) => segment.clipId)));
      const clips = [];
      for (const clipId of ids) {
        const clip = await this.getClip(clipId);
        if (!clip) throw new Error(`Clip ${clipId} is gone`);
        clips.push(clip);
      }
      const remote = clips.filter((clip) => !this._hasMaster(clip));
      const urls = remote.length ? await this._freshUrls(remote, this._token()) : new Map();
      const byId = {};
      for (const clip of clips) {
        const file = this._hasMaster(clip) ? this._masterPath(clip) : await this._fetchOriginal(clip, urls.get(clip.id), path.join(work, clip.id));
        byId[clip.id] = Object.assign({}, clip, { path: file });
      }
      const srtPath = this.settings.renderCredits ? path.join(work, 'sources.srt') : undefined;
      const plan = buildRenderPlan({ id: project.id, name: render.projectName, revision: render.revision }, render.segments, byId, {
        output: part,
        srtPath,
        width: this.settings.renderWidth,
        height: this.settings.renderHeight,
        fps: this.settings.renderFps
      });
      if (srtPath) await fsp.writeFile(srtPath, plan.srt);
      let last = 0;
      let buffer = '';
      await this._run(this.settings.ffmpegPath, plan.args, {
        onStdout: (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop();
          for (const line of lines) {
            const m = /^out_time_(?:us|ms)=(\d+)/.exec(line.trim());
            if (!m || !plan.durationMs) continue;
            const progress = Math.min(0.99, Number(m[1]) / 1000 / plan.durationMs);
            if (Date.now() - last < 1000) continue;
            last = Date.now();
            this._updateRender(id, { progress: Number(progress.toFixed(3)) }).catch(() => {});
          }
        }
      });
      const output = path.join(this.dirs.renders, `${id}.mp4`);
      await fsp.rename(part, output);
      const completedAt = this._iso();
      await fsp.writeFile(path.join(this.dirs.renders, `${id}.sources.json`), JSON.stringify(Object.assign({
        render: { id, createdAt: render.createdAt, createdBy: render.createdBy, completedAt }
      }, plan.manifest), null, 2));
      const bytes = (await fsp.stat(output)).size;
      await this._updateRender(id, { status: 'complete', progress: 1, completedAt, bytes, durationMs: plan.durationMs });
    } catch (error) {
      await fsp.rm(part, { force: true }).catch(() => {});
      await this._updateRender(id, { status: 'failed', completedAt: this._iso(), error: error.message || String(error) });
    } finally {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ---------------------------------------------------------------- HTTP

  /**
   * Stream a file with HTTP Range support (video seeking).
   * @private
   */
  async _sendFile (req, res, file, type, extra = {}) {
    let stat;
    try {
      stat = await fsp.stat(file);
    } catch (_) {
      throw fail(404, 'Not found');
    }
    res.setHeader('Content-Type', type);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    for (const [name, value] of Object.entries(extra)) res.setHeader(name, value);
    let start = 0;
    let end = stat.size - 1;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(end, Number(range[2]));
      } else {
        start = Math.max(0, stat.size - Number(range[2]));
      }
      if (start > end || start >= stat.size) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.end();
      }
      res.statusCode = 206;
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
    } else {
      res.statusCode = 200;
    }
    res.setHeader('Content-Length', end - start + 1);
    if (String(req.method).toUpperCase() === 'HEAD') return res.end();
    await pipeline(fs.createReadStream(file, { start, end }), res);
  }

  async _route (req, res, method, parts, by) {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const read = method === 'GET' || method === 'HEAD';
    const [first, second, third] = parts;
    if (!parts.length && read) return [200, await this.list()];
    if (first === 'sessions' && parts.length === 1 && read) return [200, { sessions: await this.sessions() }];
    if (first === 'refresh' && parts.length === 1 && method === 'POST') {
      if (!this.settings.poll) throw fail(409, 'Polling Discord is turned off on this server.');
      this._refreshInBackground({ throttle: true });
      return [202, { refreshing: true }];
    }
    if (first === 'projects') {
      if (parts.length === 1) {
        if (read) return [200, { projects: await this.listProjects() }];
        if (method === 'POST') return [201, await this.createProject(body, by)];
      } else if (parts.length === 2) {
        if (read) {
          const project = await this.getProject(second);
          if (!project) throw fail(404, 'No such project.');
          return [200, await this.publicProject(project)];
        }
        if (method === 'PATCH' || method === 'PUT') return [200, await this.saveProject(second, body, by)];
      } else if (parts.length === 3 && third === 'renders') {
        if (method === 'POST') return [202, await this.startRender(second, by)];
        if (read) {
          const project = await this.getProject(second);
          if (!project) throw fail(404, 'No such project.');
          return [200, { renders: (await this.publicProject(project)).renders }];
        }
      }
      throw fail(parts.length > 3 ? 404 : 405, parts.length > 3 ? 'Not found' : 'Method not allowed');
    }
    if (first === 'renders') {
      if (parts.length === 1 && read) return [200, { renders: await this.listRenders() }];
      const render = parts.length > 1 ? await this.getRender(second) : null;
      if (parts.length > 1 && !render) throw fail(404, 'No such render.');
      if (parts.length === 2 && read) return [200, this._publicRender(render)];
      if (parts.length === 3 && read && render.status === 'complete') {
        if (third === 'file') {
          const name = `${render.projectName.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'clips'} r${render.revision}.mp4`;
          return { file: path.join(this.dirs.renders, `${render.id}.mp4`), type: 'video/mp4', headers: { 'Content-Disposition': `attachment; filename="${name}"` } };
        }
        if (third === 'sources') return { file: path.join(this.dirs.renders, `${render.id}.sources.json`), type: 'application/json' };
      }
      throw fail(parts.length === 3 && render && render.status !== 'complete' ? 409 : 404, parts.length === 3 && render && render.status !== 'complete' ? 'The render is not finished.' : 'Not found');
    }
    const clip = await this.getClip(first);
    if (!clip) throw fail(404, 'No such clip.');
    if (parts.length === 1) {
      if (read) return [200, this.publicClip(clip)];
      if (method === 'PATCH') return [200, await this.setOverride(first, body, by)];
    }
    if (parts.length === 2 && read && (second === 'proxy' || second === 'thumbs')) {
      if (!clip.proxy || clip.proxy.status !== 'ready') throw fail(404, 'This clip has no proxy yet.');
      if (second === 'thumbs') return { file: this._mediaPath(clip.id, 'jpg'), type: 'image/jpeg' };
      return isStill(clip)
        ? { file: this._mediaPath(clip.id, 'preview.jpg'), type: 'image/jpeg' }
        : { file: this._mediaPath(clip.id, 'mp4'), type: 'video/mp4' };
    }
    throw fail(parts.length > 2 ? 404 : 405, parts.length > 2 ? 'Not found' : 'Method not allowed');
  }

  /**
   * Express middleware for `/services/clips/*`. Open to everyone; changes carry
   * the signed-in member's display name when there is one.
   * @returns {Function}
   */
  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      if (pathname !== BASE && !pathname.startsWith(BASE + '/')) return next();
      const method = String(req.method || 'GET').toUpperCase();
      const parts = pathname.slice(BASE.length).split('/').filter(Boolean);
      Promise.resolve().then(async () => {
        const read = method === 'GET' || method === 'HEAD';
        const by = !read && typeof this.settings.identify === 'function'
          ? await Promise.resolve(this.settings.identify(req)).catch(() => null)
          : null;
        return this._route(req, res, method, parts, by || null);
      }).then((result) => {
        if (Array.isArray(result)) return sendJson(res, result[0], result[1]);
        return this._sendFile(req, res, result.file, result.type, result.headers);
      }).catch((error) => {
        if (res.headersSent) return res.destroy();
        sendJson(res, error && error.status ? error.status : 500, { error: error && error.message ? error.message : 'Clips request failed' });
      });
    };
  }
}

module.exports = Clips;
module.exports.BASE = BASE;
module.exports.extractClips = extractClips;
module.exports.plainCaption = plainCaption;
module.exports.snowflakeAt = snowflakeAt;
