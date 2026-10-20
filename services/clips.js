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
const resolveDiscordToken = require('../functions/resolveDiscordToken');
const { displayName } = require('../functions/duelLeaderboard');
const { estimateRecordingTime } = require('../functions/clipRecordingTime');
const { groupSessions, clipStartMs, DEFAULT_GAP_MS } = require('../functions/clipTimeline');
const { normalizeSegments, buildRenderPlan } = require('../functions/clipRenderPlan');

const BASE = '/services/clips';
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_EPOCH = 1420070400000n;
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi)$/i;
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
 * Every clip one Discord message carries: video attachments, direct video
 * embeds, and links to clip hosts (Medal, YouTube, Streamable, Twitch).
 * @param {Object} message Discord message
 * @returns {Array<Object>} `{ id, kind, attachmentId, url, filename, contentType, size, width, height }`
 */
function extractClips (message) {
  const out = [];
  if (!message || !message.id) return out;
  for (const attachment of message.attachments || []) {
    const type = String(attachment.content_type || '');
    if (!/^video\//i.test(type) && !VIDEO_EXT.test(String(attachment.filename || ''))) continue;
    out.push({
      id: String(attachment.id),
      kind: 'attachment',
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
    out.push({ id: `${message.id}-l${index}`, kind: 'link', attachmentId: null, url, filename: null, contentType: null, size: null, width: null, height: null });
  });
  return out;
}

/**
 * Discord clip channels → a timeline of every clip, by when it was recorded.
 *
 * Polls every text channel the bot can see whose name matches `channels`
 * (Discord REST only), keeps each clip's source (guild, channel, message,
 * attachment), estimates when it was recorded, and stores a low-resolution
 * proxy and thumbnail sprite for storyboarding. Projects put ranges of clips
 * in order; renders fetch the full-resolution originals from Discord again
 * and cut the film with ffmpeg. No sign-in needed: anyone may browse and
 * edit, and a signed-in member's display name goes on their changes.
 */
class Clips {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.path] Root directory (Store, media, renders).
   * @param {Object} [settings.discord] settings.discord (token / secretsFile).
   * @param {Array<string>} [settings.channels] Channel matchers (id, exact name, or "/regex/"); threads under a matched channel are read too.
   * @param {boolean} [settings.mediaChannels] Also read every media channel, whatever its name.
   * @param {Array<string>} [settings.guilds] Only these guilds (default: every guild the bot is in).
   * @param {boolean} [settings.poll] Poll Discord and build proxies (false serves stored clips only).
   * @param {number} [settings.ttlMs] Poll interval.
   * @param {number} [settings.backfillDays] How far back a new channel is read (0 = its whole history).
   * @param {number} [settings.maxPages] Pages of 100 messages read per channel per poll.
   * @param {number} [settings.sessionGapMs] Largest silence inside one session.
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
      channels: ['/(^|[^a-z])(clips?|videos?)([^a-z]|$)/'],
      mediaChannels: true,
      guilds: null,
      poll: true,
      refreshOnStart: true,
      ttlMs: 15 * 60 * 1000,
      backfillDays: 90,
      maxPages: 20,
      sessionGapMs: DEFAULT_GAP_MS,
      defaultTimeZone: 'America/Chicago',
      externalLinks: false,
      maxDownloadBytes: 1024 * 1024 * 1024,
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
      maxQueuedRenders: 3,
      ffmpegPath: 'ffmpeg',
      ffprobePath: 'ffprobe',
      ytdlpPath: 'yt-dlp',
      identify: null,
      log: null,
      now: () => Date.now()
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this._resolveToken = this.settings.resolveToken || resolveDiscordToken;
    this.root = path.resolve(this.settings.path);
    this.dirs = {
      store: path.join(this.root, 'store'),
      media: path.join(this.root, 'media'),
      renders: path.join(this.root, 'renders'),
      tmp: path.join(this.root, 'tmp')
    };
    this.store = null;
    this._queue = Promise.resolve();
    this._refreshing = null;
    this._processing = null;
    this._renderChain = Promise.resolve();
    this._timer = null;
    this._lastBackgroundAt = 0;
    this._stopped = false;
  }

  async start () {
    for (const dir of Object.values(this.dirs)) await fsp.mkdir(dir, { recursive: true });
    this.store = new Store({ name: 'GOON.VC:clips', path: this.dirs.store, persistent: true, verbosity: 1 });
    await startStore(this.store);
    this._stopped = false;
    for (const id of await this._list('renders')) {
      const render = await this.store.get(`/renders/${id}`);
      if (render && (render.status === 'queued' || render.status === 'running')) {
        await this._updateRender(id, { status: 'queued', progress: 0 });
        this._enqueueRender(id);
      }
    }
    const requeued = await this.retryFailed();
    if (requeued) this._log(`queued ${requeued} clip${requeued === 1 ? '' : 's'} that failed for a missing tool or codec`);
    if (this.settings.poll) {
      if (this.settings.refreshOnStart) this._refreshInBackground();
      if (this.settings.ttlMs > 0) {
        this._timer = setInterval(() => this._refreshInBackground(), this.settings.ttlMs);
        this._timer.unref();
      }
    }
    return this;
  }

  async stop () {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
    if (this._refreshing) await this._refreshing.catch(() => {});
    if (this._processing) await this._processing.catch(() => {});
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
        const sources = TEXT_CHANNEL_TYPES.has(Number(channel.type)) ? [channel] : [];
        try {
          const threads = (active.get(String(channel.id)) || []).concat(await this._archivedThreads(token, channel));
          const seen = new Set();
          for (const thread of threads) {
            if (seen.has(String(thread.id))) continue;
            seen.add(String(thread.id));
            sources.push(Object.assign({}, thread, { name: channel.name, thread: thread.name }));
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
    return matchesAnyChannel(this.settings.channels, { id: String(channel.id), name: channel.name });
  }

  /** Active threads in the guild, by parent channel id. */
  async _activeThreads (token, guild) {
    const byParent = new Map();
    const res = await discordEvents.discordGet(`/guilds/${guild.id}/threads/active`, token, this._discordOpts());
    if (res.status !== 200 || !res.json || !Array.isArray(res.json.threads)) return byParent;
    for (const thread of res.json.threads) {
      const parent = String(thread.parent_id || '');
      if (!byParent.has(parent)) byParent.set(parent, []);
      byParent.get(parent).push(thread);
    }
    return byParent;
  }

  /** Every archived public thread (forum / media posts included) under a channel. */
  async _archivedThreads (token, channel) {
    const threads = [];
    let before = null;
    for (let page = 0; page < 1000; page++) {
      const query = `limit=${PAGE_SIZE}${before ? `&before=${encodeURIComponent(before)}` : ''}`;
      const res = await discordEvents.discordGet(`/channels/${channel.id}/threads/archived/public?${query}`, token, this._discordOpts());
      // No Read Message History on the parent: no archived threads to read.
      if (res.status === 403) break;
      if (res.status !== 200 || !res.json || !Array.isArray(res.json.threads)) throw new Error(errorMessage(res));
      threads.push(...res.json.threads);
      const last = res.json.threads[res.json.threads.length - 1];
      if (!res.json.has_more || !last || !last.thread_metadata) break;
      before = last.thread_metadata.archive_timestamp;
    }
    return threads;
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
    }, saved || {}, { guildName: guild.name || (saved && saved.guildName) || null, name: channel.name, thread: channel.thread || null });
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
        const linkOnly = item.kind === 'link' && !this.settings.externalLinks;
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
        if (out && out.code) throw new Error(`${path.basename(command)} exited ${out.code}: ${String(out.stderr || '').trim().split('\n').slice(-3).join(' ')}`);
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
        if (code) return reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`));
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
  async _fetchOriginal (clip, url, dest) {
    if (clip.kind === 'link') {
      const out = `${dest}.mp4`;
      await this._run(this.settings.ytdlpPath, [
        '--no-playlist', '--no-progress', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
        '--merge-output-format', 'mp4', '--max-filesize', String(this.settings.maxDownloadBytes),
        '-o', out, url
      ]);
      if (fs.existsSync(out)) return out;
      // yt-dlp exits 0 without a file when the video is over --max-filesize, and may add an extension.
      const dir = path.dirname(out);
      const saved = fs.readdirSync(dir).find((name) => name.startsWith(path.basename(out)) && !/\.(part|ytdl)$/.test(name));
      if (!saved) throw new Error(`yt-dlp saved nothing (over the ${Math.round(this.settings.maxDownloadBytes / 1048576)} MB download limit?)`);
      return path.join(dir, saved);
    }
    return this._download(url, dest);
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
      creationTime: tags.creation_time || tags.CREATION_TIME || tags.date || null
    };
  }

  _mediaPath (id, ext) {
    return path.join(this.dirs.media, `${id}.${ext}`);
  }

  /**
   * Proxy (low resolution, low frame rate) and thumbnail sprite for one clip.
   * @private
   */
  async _makeProxy (clip, url) {
    const work = path.join(this.dirs.tmp, `${clip.id}-${crypto.randomBytes(4).toString('hex')}`);
    await fsp.mkdir(work, { recursive: true });
    try {
      const original = await this._fetchOriginal(clip, url, path.join(work, 'original'));
      const probe = await this._probe(original);
      const authorKey = clip.authorId ? `/authors/${clip.authorId}` : null;
      const author = authorKey ? await this.store.get(authorKey) : null;
      const recording = estimateRecordingTime({
        filename: clip.filename,
        creationTime: probe.creationTime,
        postedAt: clip.postedAt,
        durationMs: probe.durationMs
      }, {
        knownOffsetMinutes: author ? author.offsetMinutes : undefined,
        defaultTimeZone: this.settings.defaultTimeZone
      });
      if (authorKey && recording.source === 'metadata' && recording.confidence === 'high' && recording.offsetMinutes !== null) {
        await this.store.set(authorKey, { offsetMinutes: recording.offsetMinutes, learnedFrom: clip.id, at: this._iso() });
      }

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
      return {
        durationMs: probe.durationMs,
        width: probe.width,
        height: probe.height,
        codec: probe.codec,
        hasAudio: probe.hasAudio,
        creationTime: probe.creationTime,
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
   * Queue every link-only clip for a proxy (downloaded with yt-dlp). Needs
   * `externalLinks`.
   * @returns {Promise<number>} clips queued
   */
  async queueLinks () {
    if (!this.settings.externalLinks) throw new Error('Importing links needs externalLinks');
    let queued = 0;
    for (const id of await this._list('clips')) {
      const clip = await this.store.get(`/clips/${id}`);
      if (!clip || clip.kind !== 'link' || !clip.proxy || clip.proxy.status !== 'skipped') continue;
      await this._updateClip(id, (record) => { record.proxy = { status: 'pending', attempts: 0, error: null }; });
      queued += 1;
    }
    return queued;
  }

  /**
   * Queue failed clips for another try. By default only the ones that failed
   * because the host was missing a tool or codec (ffmpeg, ffprobe, yt-dlp,
   * libx264, a filter), which `start` does on every boot; `all` retries every
   * failure.
   * @param {Object} [opts]
   * @param {boolean} [opts.all] retry every failed clip
   * @returns {Promise<number>} clips queued
   */
  async retryFailed (opts = {}) {
    let queued = 0;
    for (const id of await this._list('clips')) {
      const clip = await this.store.get(`/clips/${id}`);
      if (!clip || !clip.proxy || clip.proxy.status !== 'failed') continue;
      if (!opts.all && !MISSING_DEPENDENCY.test(clip.proxy.error || '')) continue;
      await this._updateClip(id, (record) => { record.proxy = { status: 'pending', attempts: 0, error: null }; });
      queued += 1;
    }
    return queued;
  }

  _processInBackground () {
    if (this._processing || this._stopped) return this._processing;
    this._processing = this.processPending()
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
    const ids = await this._list('clips');
    let index = 0;
    for (const id of ids) {
      index += 1;
      if (this._stopped) break;
      const clip = await this.store.get(`/clips/${id}`);
      if (!clip || !clip.proxy || clip.proxy.status !== 'pending') continue;
      try {
        if (!token) token = this._token();
        const urls = await this._freshUrls([clip], token);
        const made = await this._makeProxy(clip, urls.get(clip.id));
        await this._updateClip(id, (record) => Object.assign(record, made, { url: urls.get(clip.id) || record.url }));
        built += 1;
        this._log(`[${index}/${ids.length}] ${clip.author}: ${clip.filename || clip.id} (${Math.round(made.durationMs / 1000)}s, recorded ${made.recording.recordedAt} from ${made.recording.source})`);
      } catch (error) {
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
            error: error.message || String(error)
          });
        });
      }
    }
    return built;
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
   * The public view of a clip (no Discord user ids, no expiring URLs).
   * @param {Object} clip
   * @returns {Object}
   */
  publicClip (clip) {
    const start = clipStartMs(clip);
    const ready = clip.proxy && clip.proxy.status === 'ready';
    return {
      id: clip.id,
      kind: clip.kind,
      author: clip.author,
      guild: clip.guildName,
      channel: clip.channelName,
      thread: clip.threadName || null,
      messageUrl: clip.messageUrl,
      linkUrl: clip.kind === 'link' ? clip.url : null,
      caption: plainCaption(clip.caption),
      filename: clip.filename,
      postedAt: clip.postedAt,
      durationMs: clip.durationMs,
      width: clip.width,
      height: clip.height,
      hasAudio: clip.hasAudio,
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
    return {
      polling: !!this.settings.poll,
      status: Object.assign({}, status, { ready: count('ready'), pending: count('pending'), failed: count('failed'), linksOnly: count('skipped') }),
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
    return groupSessions(clips, { gapMs: this.settings.sessionGapMs }).map((session) => Object.assign(session, {
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
      if (clip.proxy && clip.proxy.status === 'ready' && clip.durationMs > 0) map[clip.id] = clip;
    }
    return map;
  }

  async _segments (segments) {
    return normalizeSegments(segments || [], await this._playableClips(), {
      maxSegments: this.settings.maxSegments,
      maxDurationMs: this.settings.maxRenderSeconds * 1000
    });
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
      const token = this._token();
      const urls = await this._freshUrls(clips, token);
      const byId = {};
      for (const clip of clips) {
        const file = await this._fetchOriginal(clip, urls.get(clip.id), path.join(work, clip.id));
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
      return second === 'proxy'
        ? { file: this._mediaPath(clip.id, 'mp4'), type: 'video/mp4' }
        : { file: this._mediaPath(clip.id, 'jpg'), type: 'image/jpeg' };
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
