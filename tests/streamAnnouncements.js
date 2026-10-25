'use strict';

const assert = require('assert');
const { readAnnouncement, readVod, pickVod, vodFinished } = require('../functions/streamAnnouncements');

const vod = (id, start, minutes, extra) => Object.assign(readVod({ id: `v${id}`, timestamp: Date.parse(start) / 1000, duration: minutes * 60 }), extra);

describe('streamAnnouncements', function () {
  describe('readAnnouncement', function () {
    it('reads a Streamcord go-live post: channel from the embed, streamer, and title', function () {
      const found = readAnnouncement({
        content: '<@&1224891530313994365> **Neorion** is live!',
        embeds: [{ type: 'rich', url: 'https://www.twitch.tv/Neorion', title: 'Night ops', author: { name: 'Neorion', url: 'https://www.twitch.tv/Neorion' } }],
        components: [{ components: [{ type: 2, style: 5, url: 'https://twitch.tv/neorion' }] }]
      });
      assert.deepStrictEqual(found, { channels: ['neorion'], vods: [], streamer: 'Neorion', title: 'Night ops' });
    });

    it('reads VOD links in every Twitch shape', function () {
      const found = readAnnouncement({ content: 'https://www.twitch.tv/videos/555 and https://m.twitch.tv/kersa/v/556?t=1h and https://twitch.tv/kersa/video/557' });
      assert.deepStrictEqual(found.vods, [{ id: '555', channel: null }, { id: '556', channel: 'kersa' }, { id: '557', channel: 'kersa' }]);
      assert.deepStrictEqual(found.channels, [], 'a channel linked through its VOD is not a go-live');
    });

    it('ignores clips, Twitch pages, other hosts, and posts without Twitch', function () {
      assert.strictEqual(readAnnouncement({ content: 'https://www.twitch.tv/neorion/clip/FunnyClip-abc https://clips.twitch.tv/Other' }), null);
      assert.strictEqual(readAnnouncement({ content: 'https://www.twitch.tv/directory/category/star-citizen https://twitch.tv/settings' }), null);
      assert.strictEqual(readAnnouncement({ content: 'live on https://youtube.com/@neorion/live' }), null);
      assert.strictEqual(readAnnouncement({ content: 'going live soon' }), null);
      assert.deepStrictEqual(readAnnouncement({ content: 'https://twitch.tv/neorion/videos?filter=archives' }).channels, ['neorion']);
    });
  });

  describe('readVod', function () {
    it('reads yt-dlp rows and drops unusable ones', function () {
      assert.deepStrictEqual(readVod({ id: 'v888', timestamp: 1790000000, duration: 10800.0, is_live: false, uploader: 'Neorion', uploader_id: 'Neorion', title: 'Night ops' }), {
        id: '888', startedAt: '2026-09-21T14:13:20.000Z', startMs: 1790000000000, durationMs: 10800000, live: false, streamer: 'Neorion', channel: 'neorion', title: 'Night ops'
      });
      assert.strictEqual(readVod({ id: 'v1', timestamp: null }), null);
      assert.strictEqual(readVod({ id: 'abc', timestamp: 1790000000 }), null);
      assert.strictEqual(readVod(null), null);
    });
  });

  describe('pickVod', function () {
    const vods = [
      vod(3, '2026-10-21T11:38:00Z', 22),
      vod(2, '2026-10-20T01:02:00Z', 180),
      vod(1, '2026-10-18T20:00:00Z', 120)
    ];

    it('finds the broadcast that was live when it was announced', function () {
      assert.strictEqual(pickVod(vods, Date.parse('2026-10-20T01:05:00Z')).id, '2');
      assert.strictEqual(pickVod(vods, Date.parse('2026-10-20T03:30:00Z')).id, '2', 're-announced mid-stream');
      assert.strictEqual(pickVod(vods, Date.parse('2026-10-20T00:55:00Z')).id, '2', 'Discord\'s clock a little ahead');
      assert.strictEqual(pickVod(vods, Date.parse('2026-10-21T11:40:00Z')).id, '3');
    });

    it('finds nothing for announcements between broadcasts', function () {
      assert.strictEqual(pickVod(vods, Date.parse('2026-10-19T12:00:00Z')), null);
      assert.strictEqual(pickVod([], Date.parse('2026-10-19T12:00:00Z')), null);
    });
  });

  describe('vodFinished', function () {
    it('waits while live and until the VOD stops growing', function () {
      const now = Date.parse('2026-10-20T05:00:00Z');
      assert.strictEqual(vodFinished(vod(2, '2026-10-20T01:02:00Z', 180), now, 30 * 60 * 1000), true);
      assert.strictEqual(vodFinished(vod(2, '2026-10-20T01:02:00Z', 180, { live: true }), now, 30 * 60 * 1000), false);
      assert.strictEqual(vodFinished(vod(2, '2026-10-20T01:02:00Z', 220), now, 30 * 60 * 1000), false, 'ended 18 minutes ago');
      assert.strictEqual(vodFinished(null, now, 0), false);
    });
  });
});
