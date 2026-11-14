'use strict';

/**
 * Mix per-speaker PCM into timed chunks. Join / subscribe / leave default to
 * `@fabric/discord` voice receive (`@discordjs/voice` lives there) and are
 * injectable so tests never load the native stack.
 */

const SAMPLE_RATE = 48000;
const CHANNELS = 2;
const BYTES_PER_SAMPLE = 2;
const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * BYTES_PER_SAMPLE;
const DEFAULTS = Object.freeze({
  chunkMs: 60 * 1000,
  silenceMs: 3 * 1000,
  idleMs: 5 * 60 * 1000,
  tickMs: 1000
});

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Mix `src` s16le PCM into `dest` starting at `offsetBytes`, clipping.
 * @param {Buffer} dest
 * @param {Buffer} src
 * @param {number} offsetBytes
 */
function mixInto (dest, src, offsetBytes) {
  if (!dest || !src || !src.length) return;
  if (src.byteOffset % 2 !== 0) src = Buffer.from(src);
  const destView = new Int16Array(dest.buffer, dest.byteOffset, Math.floor(dest.length / 2));
  const srcView = new Int16Array(src.buffer, src.byteOffset, Math.floor(src.length / 2));
  let start = Math.round(offsetBytes / 2);
  if (start < 0) {
    const skip = -start;
    if (skip >= srcView.length) return;
    for (let i = skip; i < srcView.length; i++) {
      const j = i - skip;
      const sum = destView[j] + srcView[i];
      destView[j] = sum > 32767 ? 32767 : (sum < -32768 ? -32768 : sum);
    }
    return;
  }
  for (let i = 0; i < srcView.length; i++) {
    const j = start + i;
    if (j >= destView.length) break;
    const sum = destView[j] + srcView[i];
    destView[j] = sum > 32767 ? 32767 : (sum < -32768 ? -32768 : sum);
  }
}

class VoiceMixer {
  /**
   * @param {Object} [opts]
   * @param {Function} [opts.now]
   * @param {number} [opts.chunkMs]
   * @param {number} [opts.silenceMs]
   */
  constructor (opts = {}) {
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    this.chunkMs = Number(opts.chunkMs) > 0 ? Number(opts.chunkMs) : DEFAULTS.chunkMs;
    this.silenceMs = Number(opts.silenceMs) > 0 ? Number(opts.silenceMs) : DEFAULTS.silenceMs;
    this.reset();
  }

  reset () {
    this.startedAt = null;
    this.lastPcmAt = null;
    this.pcm = null;
    this.speakers = new Map();
  }

  add (userId, name, pcm, at) {
    if (!pcm || !pcm.length) return;
    const when = at || this.now();
    if (!this.startedAt) {
      this.startedAt = when;
      this.pcm = Buffer.alloc(0);
    }
    const offset = Math.max(0, Math.round(((when - this.startedAt) / 1000) * BYTES_PER_SECOND));
    const aligned = offset - (offset % (CHANNELS * BYTES_PER_SAMPLE));
    const need = aligned + pcm.length;
    if (need > this.pcm.length) {
      const next = Buffer.alloc(need);
      this.pcm.copy(next);
      this.pcm = next;
    }
    mixInto(this.pcm, pcm, aligned);
    this.lastPcmAt = when;
    if (userId) this.speakers.set(String(userId), name || 'Unknown pilot');
  }

  hasAudio () {
    return Boolean(this.pcm && this.pcm.length);
  }

  silentFor (ms, at) {
    if (!this.lastPcmAt) return !this.startedAt;
    return (at || this.now()) - this.lastPcmAt >= ms;
  }

  overdue (at) {
    if (!this.startedAt) return false;
    return (at || this.now()) - this.startedAt >= this.chunkMs;
  }

  /**
   * @returns {Object|null} `{ pcm, startedAt, durationMs, speakers: [{ id, name }] }`
   */
  flush () {
    if (!this.hasAudio()) {
      this.reset();
      return null;
    }
    const durationMs = Math.max(1, Math.round((this.pcm.length / BYTES_PER_SECOND) * 1000));
    const speakers = Array.from(this.speakers.entries()).map(([id, name]) => ({ id, name }));
    const chunk = { pcm: this.pcm, startedAt: this.startedAt, durationMs, speakers };
    this.reset();
    return chunk;
  }
}

function voiceReceive () {
  return require('@fabric/discord/functions/voiceReceive');
}

async function defaultJoin (input) {
  return voiceReceive().joinVoiceReceive(input);
}

function defaultSubscribe (connection, userId) {
  return voiceReceive().subscribeVoiceReceive(connection, userId);
}

function defaultLeave (connection) {
  return voiceReceive().leaveVoiceReceive(connection);
}

class DiscordVoiceCapture {
  /**
   * @param {Object} [settings]
   * @param {number} [settings.chunkMs]
   * @param {number} [settings.silenceMs]
   * @param {number} [settings.idleMs]
   * @param {number} [settings.tickMs]
   * @param {Function} [settings.now]
   * @param {Function} [settings.join] async ({ client, guildId, channelId, adapterCreator }) => connection
   * @param {Function} [settings.subscribe] (connection, userId) => pcm Stream
   * @param {Function} [settings.leave] (connection) => void
   * @param {Function} [settings.nameOf] (userId) => display name
   * @param {Function} [settings.isBot] (userId) => boolean
   * @param {Function} [settings.onChunk] async (chunk) => void
   * @param {Function} [settings.onIdle] async () => void
   * @param {Function} [settings.log]
   */
  constructor (settings = {}) {
    this.settings = Object.assign({}, DEFAULTS, Object.fromEntries(
      Object.entries(settings).filter(([, value]) => value !== undefined)
    ));
    this.now = typeof this.settings.now === 'function' ? this.settings.now : () => Date.now();
    this.mixer = new VoiceMixer({
      now: () => this.now(),
      chunkMs: this.settings.chunkMs,
      silenceMs: this.settings.silenceMs
    });
    this._join = this.settings.join || defaultJoin;
    this._subscribe = this.settings.subscribe || defaultSubscribe;
    this._leave = this.settings.leave || defaultLeave;
    this._nameOf = this.settings.nameOf || (() => 'Unknown pilot');
    this._isBot = this.settings.isBot || (() => false);
    this._onChunk = this.settings.onChunk || null;
    this._onIdle = this.settings.onIdle || null;
    this._connection = null;
    this._subscriptions = new Map();
    this._allowed = new Set();
    this._tick = null;
    this._idle = null;
    this.client = null;
    this.guildId = null;
    this.channelId = null;
    this.channelName = null;
    this.occupancy = 0;
  }

  get connected () {
    return Boolean(this.channelId);
  }

  /**
   * Connect receive-only. Refused while already in a channel.
   * @param {Object} input
   * @param {Object} [input.client] discord.js client (for speaking / member lookup)
   * @param {string} input.guildId
   * @param {string} input.channelId
   * @param {string} [input.channelName]
   * @param {Function} [input.adapterCreator]
   * @param {Array<string>} [input.allowed] speaker ids who already opted in (the listener)
   */
  async join (input = {}) {
    if (this.connected) {
      throw fail(409, `Already listening in #${this.channelName || 'voice'}.`);
    }
    const guildId = String(input.guildId || '');
    const channelId = String(input.channelId || '');
    if (!guildId || !channelId) throw fail(400, 'Need a voice channel to join.');
    this.client = input.client || null;
    this.guildId = guildId;
    this.channelId = channelId;
    this.channelName = input.channelName || null;
    this.occupancy = 0;
    this._allowed = new Set((input.allowed || []).map(String).filter(Boolean));
    this.mixer.reset();
    try {
      this._connection = await this._join({
        client: this.client,
        guildId,
        channelId,
        adapterCreator: input.adapterCreator
      });
    } catch (error) {
      this.guildId = null;
      this.channelId = null;
      this.channelName = null;
      this._connection = null;
      this._allowed = new Set();
      throw error.status ? error : fail(502, error && error.message ? error.message : 'Could not join that voice channel.');
    }
    this._listenSpeaking();
    this._armTick();
    return this.status();
  }

  /**
   * Flush the open chunk and disconnect. Safe when not connected.
   * @returns {Promise<Object|null>} last status, or null
   */
  async leave () {
    const status = this.connected ? this.status() : null;
    this._clearIdle();
    if (this._tick) {
      clearInterval(this._tick);
      this._tick = null;
    }
    this._stopSpeaking();
    await this._emitChunk(this.mixer.flush());
    try {
      this._leave(this._connection);
    } catch (_) { /* destroy is best-effort */ }
    this._connection = null;
    this._allowed = new Set();
    this.client = null;
    this.guildId = null;
    this.channelId = null;
    this.channelName = null;
    this.occupancy = 0;
    return status;
  }

  /**
   * Include or drop a speaker. Only opted-in people are mixed or subscribed.
   * @param {string} userId
   * @param {boolean} yes
   * @returns {boolean} whether they are included now
   */
  consent (userId, yes) {
    const id = String(userId || '');
    if (!id || !this.connected) return false;
    if (yes) {
      this._allowed.add(id);
      this._openSpeaker(id);
      return true;
    }
    this._allowed.delete(id);
    const stream = this._subscriptions.get(id);
    this._subscriptions.delete(id);
    try {
      if (stream && typeof stream.destroy === 'function') stream.destroy();
    } catch (_) { /* ignore */ }
    return false;
  }

  allowed (userId) {
    return this._allowed.has(String(userId || ''));
  }

  /**
   * PCM from a speaker (tests, or the live subscribe path).
   * @param {string} userId
   * @param {string} name
   * @param {Buffer} pcm
   * @param {number} [at]
   */
  receive (userId, name, pcm, at) {
    if (!this.connected) return;
    if (this._isBot(userId)) return;
    if (!this.allowed(userId)) return;
    this.mixer.add(userId, name || this._nameOf(userId), pcm, at);
    if (this.occupancy > 0) this._clearIdle();
  }

  /**
   * Non-bot members still in the channel (the bot itself does not count).
   * Empty starts the idle leave timer.
   * @param {number} count
   */
  setOccupancy (count) {
    this.occupancy = Math.max(0, Number(count) || 0);
    if (!this.connected) return;
    if (this.occupancy > 0) this._clearIdle();
    else this._armIdle();
  }

  status () {
    if (!this.connected) return { listening: false, channel: null, guildId: null, channelId: null };
    return {
      listening: true,
      channel: this.channelName,
      guildId: this.guildId,
      channelId: this.channelId
    };
  }

  _listenSpeaking () {
    const receiver = this._connection && this._connection.receiver;
    if (!receiver || !receiver.speaking || typeof receiver.speaking.on !== 'function') return;
    this._onSpeaking = (userId) => this._openSpeaker(userId);
    receiver.speaking.on('start', this._onSpeaking);
  }

  _stopSpeaking () {
    const receiver = this._connection && this._connection.receiver;
    if (receiver && receiver.speaking && this._onSpeaking) {
      receiver.speaking.off('start', this._onSpeaking);
    }
    this._onSpeaking = null;
    for (const stream of this._subscriptions.values()) {
      try {
        if (stream && typeof stream.destroy === 'function') stream.destroy();
      } catch (_) { /* ignore */ }
    }
    this._subscriptions.clear();
  }

  _openSpeaker (userId) {
    if (!this.connected || this._isBot(userId) || !this.allowed(userId) || this._subscriptions.has(userId)) return;
    let stream;
    try {
      stream = this._subscribe(this._connection, userId);
    } catch (_) {
      return;
    }
    if (!stream) return;
    this._subscriptions.set(userId, stream);
    const name = this._nameOf(userId);
    const onData = (pcm) => this.receive(userId, name, pcm);
    const onEnd = () => {
      this._subscriptions.delete(userId);
      if (stream && typeof stream.off === 'function') {
        stream.off('data', onData);
        stream.off('end', onEnd);
        stream.off('close', onEnd);
      }
    };
    if (typeof stream.on === 'function') {
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('close', onEnd);
    }
  }

  _armTick () {
    if (this._tick) clearInterval(this._tick);
    const ms = Number(this.settings.tickMs) > 0 ? Number(this.settings.tickMs) : DEFAULTS.tickMs;
    this._tick = setInterval(() => {
      this._rotate().catch(() => {});
    }, ms);
    if (typeof this._tick.unref === 'function') this._tick.unref();
  }

  async _rotate () {
    if (!this.connected) return;
    const at = this.now();
    if (this.mixer.overdue(at) || (this.mixer.hasAudio() && this.mixer.silentFor(this.mixer.silenceMs, at))) {
      await this._emitChunk(this.mixer.flush());
    }
  }

  async _emitChunk (chunk) {
    if (!chunk || typeof this._onChunk !== 'function') return;
    await this._onChunk(Object.assign({}, chunk, {
      guildId: this.guildId,
      channelId: this.channelId,
      channelName: this.channelName
    }));
  }

  _armIdle () {
    if (this._idle || !this.connected) return;
    const ms = Number(this.settings.idleMs) > 0 ? Number(this.settings.idleMs) : DEFAULTS.idleMs;
    this._idle = setTimeout(() => {
      this._idle = null;
      const stop = typeof this._onIdle === 'function' ? this._onIdle() : this.leave();
      Promise.resolve(stop).catch(() => {});
    }, ms);
    if (typeof this._idle.unref === 'function') this._idle.unref();
  }

  _clearIdle () {
    if (this._idle) {
      clearTimeout(this._idle);
      this._idle = null;
    }
  }
}

module.exports = {
  SAMPLE_RATE,
  CHANNELS,
  BYTES_PER_SECOND,
  DEFAULTS,
  mixInto,
  VoiceMixer,
  DiscordVoiceCapture
};
