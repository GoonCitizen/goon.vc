'use strict';

const assert = require('assert');
const { EventEmitter } = require('events');
const {
  BYTES_PER_SECOND,
  mixInto,
  VoiceMixer,
  DiscordVoiceCapture
} = require('../functions/discordVoiceCapture');

function pcm (samples, value = 1000) {
  const buf = Buffer.alloc(samples * 4);
  const view = new Int16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  view.fill(value);
  return buf;
}

describe('discordVoiceCapture', function () {
  it('mixes overlapping s16le streams with clipping', function () {
    const dest = pcm(2, 20000);
    mixInto(dest, pcm(2, 20000), 0);
    const view = new Int16Array(dest.buffer, dest.byteOffset, dest.length / 2);
    assert.ok(view.every((n) => n === 32767));
  });

  it('copies a PCM slice with an odd byte offset instead of throwing', function () {
    const dest = pcm(2, 0);
    const padded = Buffer.alloc(9);
    padded.writeInt16LE(1000, 1);
    padded.writeInt16LE(1000, 3);
    padded.writeInt16LE(1000, 5);
    padded.writeInt16LE(1000, 7);
    const src = padded.subarray(1, 9);
    assert.strictEqual(src.byteOffset % 2, 1);
    mixInto(dest, src, 0);
    const view = new Int16Array(dest.buffer, dest.byteOffset, dest.length / 2);
    assert.ok(view.every((n) => n === 1000));
  });

  it('chunks on duration and on silence, naming speakers', function () {
    let now = 1_000;
    const mixer = new VoiceMixer({ now: () => now, chunkMs: 1000, silenceMs: 200 });
    mixer.add('1', 'Ace', pcm(480), now);
    now += 150;
    mixer.add('2', 'Bix', pcm(480), now);
    assert.strictEqual(mixer.overdue(now), false);
    now += 1000;
    assert.ok(mixer.overdue(now));
    const chunk = mixer.flush();
    assert.ok(chunk.pcm.length > 0);
    assert.deepStrictEqual(chunk.speakers.map((row) => row.name), ['Ace', 'Bix']);
    assert.deepStrictEqual(chunk.speakers.map((row) => row.id), ['1', '2']);
    assert.ok(chunk.durationMs >= 1);
    assert.strictEqual(mixer.hasAudio(), false);

    now += 10;
    mixer.add('1', 'Ace', pcm(48), now);
    now += 250;
    assert.ok(mixer.silentFor(200, now));
    const quiet = mixer.flush();
    assert.ok(quiet.pcm.length);
    assert.strictEqual(quiet.speakers[0].name, 'Ace');
  });

  it('joins once, rotates chunks, idle-leaves when empty, and flushes on leave', async function () {
    const chunks = [];
    let now = 5_000;
    let left = 0;
    const capture = new DiscordVoiceCapture({
      now: () => now,
      chunkMs: 500,
      silenceMs: 50,
      idleMs: 30,
      tickMs: 10,
      join: async ({ channelId, guildId }) => ({ channelId, guildId, receiver: { speaking: new EventEmitter() } }),
      subscribe: () => new EventEmitter(),
      leave: () => { left += 1; },
      nameOf: (id) => (id === 'u1' ? 'Ace' : 'Unknown'),
      isBot: (id) => id === 'bot',
      onChunk: async (chunk) => { chunks.push(chunk); }
    });
    await capture.join({ guildId: 'g1', channelId: 'c1', channelName: 'PERMAFLEET', allowed: ['u1'] });
    assert.strictEqual(capture.connected, true);
    await assert.rejects(() => capture.join({ guildId: 'g1', channelId: 'c2' }), /Already listening in #PERMAFLEET/);

    capture.receive('bot', 'Bot', pcm(48), now);
    assert.strictEqual(capture.mixer.hasAudio(), false);
    capture.receive('u2', 'Bix', pcm(48), now);
    assert.strictEqual(capture.mixer.hasAudio(), false, 'speakers who have not opted in are not mixed');
    capture.receive('u1', 'Ace', pcm(48), now);
    now += 600;
    await capture._rotate();
    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].channelName, 'PERMAFLEET');
    assert.strictEqual(chunks[0].channelId, 'c1');
    assert.deepStrictEqual(chunks[0].speakers.map((row) => row.name), ['Ace']);
    assert.ok(chunks[0].pcm.length >= 48 * 4);
    assert.ok(BYTES_PER_SECOND > 0);

    capture.receive('u1', 'Ace', pcm(24), now);
    const last = await capture.leave();
    assert.strictEqual(left, 1);
    assert.strictEqual(capture.connected, false);
    assert.strictEqual(last.channel, 'PERMAFLEET');
    assert.strictEqual(chunks.length, 2, 'open chunk flushes on leave');
  });

  it('records a speaker only after they opt in, and drops them when they opt out', async function () {
    const capture = new DiscordVoiceCapture({
      join: async () => ({ receiver: { speaking: new EventEmitter() } }),
      subscribe: () => new EventEmitter(),
      leave: () => {}
    });
    await capture.join({ guildId: 'g1', channelId: 'c1', channelName: 'PERMAFLEET', allowed: ['host'] });
    assert.strictEqual(capture.allowed('host'), true);
    capture.receive('guest', 'Guest', pcm(48));
    assert.strictEqual(capture.mixer.hasAudio(), false);
    assert.strictEqual(capture.consent('guest', true), true);
    capture.receive('guest', 'Guest', pcm(48));
    assert.strictEqual(capture.mixer.hasAudio(), true);
    assert.strictEqual(capture.consent('guest', false), false);
    capture.mixer.reset();
    capture.receive('guest', 'Guest', pcm(48));
    assert.strictEqual(capture.mixer.hasAudio(), false);
    await capture.leave();
  });

  it('idle-leaves after the channel stays empty', async function () {
    let idle = 0;
    const capture = new DiscordVoiceCapture({
      idleMs: 20,
      join: async () => ({ receiver: null }),
      leave: () => {},
      onIdle: async () => { idle += 1; await capture.leave(); }
    });
    await capture.join({ guildId: 'g1', channelId: 'c1', channelName: 'Ops' });
    capture.setOccupancy(2);
    capture.setOccupancy(0);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.strictEqual(idle, 1);
    assert.strictEqual(capture.connected, false);
  });

  it('defaults join to @fabric/discord voice receive', async function () {
    const voiceReceive = require('@fabric/discord/functions/voiceReceive');
    const orig = voiceReceive.joinVoiceReceive;
    const adapter = () => {};
    let seen;
    voiceReceive.joinVoiceReceive = async (input) => {
      seen = input;
      return { ok: true };
    };
    try {
      const capture = new DiscordVoiceCapture({ leave: () => {} });
      await capture.join({ guildId: 'g1', channelId: 'c1', adapterCreator: adapter });
      assert.strictEqual(seen.guildId, 'g1');
      assert.strictEqual(seen.channelId, 'c1');
      assert.strictEqual(seen.adapterCreator, adapter);
      await capture.leave();
    } finally {
      voiceReceive.joinVoiceReceive = orig;
    }
  });
});
