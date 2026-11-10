'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Clips = require('../services/clips');
const { extractClips, snowflakeAt, plainCaption } = Clips;
const { normalizeSegments, buildRenderPlan, creditsSrt } = require('../functions/clipRenderPlan');

const GUILD = '1190527980120850493';
const CLIPS_CHANNEL = '1300000000000000001';
const CDN = 'https://cdn.discordapp.com/attachments';

function response (status, body, extra = {}) {
  const raw = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  return Object.assign({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => raw.toString(),
    arrayBuffer: async () => Buffer.from(raw)
  }, extra);
}

describe('clips', function () {
  describe('extractClips', function () {
    it('finds video and screenshot attachments, direct video embeds, and clip-host links', function () {
      const clips = extractClips({
        id: '900',
        content: 'two angles https://medal.tv/games/star-citizen/clips/abc?invite=x and https://youtu.be/xyz.',
        attachments: [
          { id: '901', filename: 'Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4', content_type: 'video/mp4', size: 1000, width: 1920, height: 1080, url: `${CDN}/1/901/a.mp4?ex=1` },
          { id: '902', filename: 'screenshot.png', content_type: 'image/png', url: `${CDN}/1/902/b.png` },
          { id: '903', filename: 'obs.mkv', url: `${CDN}/1/903/obs.mkv` },
          { id: '905', filename: 'ScreenShot0001.JPG', url: `${CDN}/1/905/d.jpg` },
          { id: '906', filename: 'lol.gif', content_type: 'image/gif', url: `${CDN}/1/906/e.gif` },
          { id: '907', filename: 'notes.txt', content_type: 'text/plain', url: `${CDN}/1/907/f.txt` }
        ],
        embeds: [
          { type: 'video', video: { url: `${CDN}/1/904/c.webm`, width: 1280, height: 720 } },
          { type: 'video', provider: { name: 'YouTube' }, video: { url: 'https://www.youtube.com/embed/xyz' } }
        ]
      });
      assert.deepStrictEqual(clips.map((c) => [c.id, c.kind, c.media, c.filename]), [
        ['901', 'attachment', 'video', 'Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4'],
        ['902', 'attachment', 'image', 'screenshot.png'],
        ['903', 'attachment', 'video', 'obs.mkv'],
        ['905', 'attachment', 'image', 'ScreenShot0001.JPG'],
        ['900-e0', 'embed', 'video', 'c.webm'],
        ['900-l0', 'link', 'video', null],
        ['900-l1', 'link', 'video', null]
      ]);
      assert.strictEqual(clips[5].url, 'https://medal.tv/games/star-citizen/clips/abc?invite=x');
      assert.strictEqual(clips[6].url, 'https://youtu.be/xyz');
    });

    it('makes captions readable without Discord ids', function () {
      const mentions = [{ id: '322940310567124992', username: 'jac', global_name: 'Jacuse', member: { nick: '[G00N] Jacuse' } }];
      assert.strictEqual(
        plainCaption('<@322940310567124992> wasn\'t me?? <@!555> <@&777> in <#888> <:o7:999> <t:1760918400:R>', mentions),
        '@[G00N] Jacuse wasn\'t me?? @someone @role in #channel :o7: 2025-10-20 00:00 UTC'
      );
    });

    it('turns a time into the first snowflake at or after it', function () {
      assert.strictEqual(snowflakeAt(1420070400000), '0');
      assert.strictEqual(snowflakeAt(1420070400001), String(1n << 22n));
    });
  });

  describe('render plan', function () {
    const clips = {
      a: { id: 'a', path: '/tmp/a.mp4', durationMs: 30000, hasAudio: true, author: 'Ace', channelName: 'clips', messageUrl: 'https://discord.com/channels/1/2/3', recording: { recordedAt: '2026-10-20T02:33:12.000Z', source: 'metadata', confidence: 'high' } },
      b: { id: 'b', path: '/tmp/b.mp4', durationMs: 10000, hasAudio: false, author: 'Bix', channelName: 'clips', recording: { recordedAt: '2026-10-20T02:33:20.000Z', source: 'filename', confidence: 'medium' }, override: { syncOffsetMs: -500 } }
    };

    it('checks segments against the clips', function () {
      assert.throws(() => normalizeSegments([{ clipId: 'zz', in: 0, out: 1 }], clips), /no such clip/);
      assert.throws(() => normalizeSegments([{ clipId: 'a', in: 5, out: 5 }], clips), /out must come after in/);
      assert.throws(() => normalizeSegments([{ clipId: 'a', in: 0, out: 31 }], clips), /past the end/);
      assert.throws(() => normalizeSegments([{ clipId: 'a', in: 0, out: 30 }], clips, { maxDurationMs: 10000 }), /limit is 10s/);
      assert.throws(() => normalizeSegments([{ clipId: 'a', in: 0, out: 1 }, { clipId: 'a', in: 1, out: 2 }], clips, { maxSegments: 1 }), /at most 1 segments/);
      assert.deepStrictEqual(normalizeSegments([{ clipId: 'a', in: 1.23456, out: 30.1, audio: 'mute' }], clips), [
        { clipId: 'a', in: 1.235, out: 30, audio: 'mute', volume: 1 }
      ]);
    });

    it('builds exact ffmpeg arguments, sources, and credits', function () {
      const segments = normalizeSegments([
        { clipId: 'a', in: 2, out: 6 },
        { clipId: 'b', in: 1, out: 3.5, volume: 0.5 }
      ], clips);
      const plan = buildRenderPlan({ id: 'p1', name: 'Hathor raid', revision: 3 }, segments, clips, { output: '/tmp/out.mp4', srtPath: '/tmp/out.srt', width: 1280, height: 720, fps: 30 });
      assert.strictEqual(plan.durationMs, 6500);
      assert.deepStrictEqual(plan.args.slice(0, 18), [
        '-y', '-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1',
        '-ss', '2', '-t', '4', '-i', '/tmp/a.mp4',
        '-ss', '1', '-t', '2.5', '-i', '/tmp/b.mp4'
      ]);
      const graph = plan.args[plan.args.indexOf('-filter_complex') + 1].split(';');
      assert.deepStrictEqual(graph, [
        '[0:v]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,trim=duration=4[v0]',
        '[0:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=4,asetpts=PTS-STARTPTS[a0]',
        '[1:v]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=30,format=yuv420p,trim=duration=2.5[v1]',
        'anullsrc=r=48000:cl=stereo,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=2.5,asetpts=PTS-STARTPTS[a1]',
        '[v0][a0][v1][a1]concat=n=2:v=1:a=1[vout][aout]'
      ]);
      assert.ok(plan.args.includes('2:s'), 'maps the credits subtitle input');
      assert.strictEqual(plan.args[plan.args.length - 1], '/tmp/out.mp4');
      assert.deepStrictEqual(plan.manifest.segments.map((row) => [row.at, row.duration, row.clip.author, row.recordedFrom]), [
        [0, 4, 'Ace', '2026-10-20T02:33:14.000Z'],
        [4, 2.5, 'Bix', '2026-10-20T02:33:20.500Z']
      ]);
      assert.deepStrictEqual(plan.manifest.authors, ['Ace', 'Bix']);
      assert.strictEqual(creditsSrt(plan.manifest).split('\n')[1], '00:00:00,000 --> 00:00:04,000');
      assert.ok(/Bix · #clips · 2026-10-20 02:33 UTC/.test(plan.srt));
    });

    it('holds a screenshot for its display time', function () {
      const all = Object.assign({
        s: { id: 's', media: 'image', path: '/tmp/s.png', durationMs: null, hasAudio: false, author: 'Cy', channelName: 'screenshots', recording: { recordedAt: '2026-10-20T02:33:30.000Z', source: 'posted', confidence: 'low' } }
      }, clips);
      assert.deepStrictEqual(normalizeSegments([{ clipId: 's', in: 3, out: 7.5, audio: 'mute', volume: 2 }], all), [
        { clipId: 's', in: 0, out: 4.5, audio: 'on', volume: 1 }
      ], 'starts at 0 and keeps only how long it shows');
      assert.throws(() => normalizeSegments([{ clipId: 's', in: 0, out: 61 }], all), /at most 60s/);
      assert.throws(() => normalizeSegments([{ clipId: 's', in: 0, out: 20 }], all, { maxStillMs: 10000 }), /at most 10s/);
      assert.throws(() => normalizeSegments([{ clipId: 's', in: 0, out: 0 }], all), /at least/);

      const segments = normalizeSegments([{ clipId: 'a', in: 2, out: 6 }, { clipId: 's', in: 0, out: 3 }], all);
      const plan = buildRenderPlan({ id: 'p2', name: 'Stills', revision: 1 }, segments, all, { output: '/tmp/out.mp4', width: 1280, height: 720, fps: 30 });
      assert.strictEqual(plan.durationMs, 7000);
      assert.deepStrictEqual(plan.args.slice(12, 21), ['-loop', '1', '-framerate', '30', '-t', '3', '-i', '/tmp/s.png', '-filter_complex']);
      const graph = plan.args[plan.args.indexOf('-filter_complex') + 1].split(';');
      assert.ok(graph[2].startsWith('[1:v]setpts=PTS-STARTPTS,scale=1280:720') && graph[2].endsWith('trim=duration=3[v1]'), graph[2]);
      assert.ok(graph[3].startsWith('anullsrc='), 'silent audio under the screenshot');
      const row = plan.manifest.segments[1];
      assert.deepStrictEqual([row.at, row.duration, row.clip.media, row.recordedFrom, row.recordedTo], [4, 3, 'image', '2026-10-20T02:33:30.000Z', '2026-10-20T02:33:30.000Z']);
    });
  });

  describe('Clips service', function () {
    this.timeout(20000);

    let root;
    let clips;
    let server;
    let port;
    let discordUp;
    let calls;
    let runs;
    let messages;
    let history;

    const M1 = snowflakeAt(Date.parse('2026-10-20T02:40:00Z'));
    const M2 = snowflakeAt(Date.parse('2026-10-20T02:41:00Z'));
    const M3 = snowflakeAt(Date.parse('2026-10-20T02:46:00Z'));
    const ATTACHMENT_URL = `${CDN}/${CLIPS_CHANNEL}/5001/Star_Citizen.mp4?ex=old`;
    const FRESH_URL = `${CDN}/${CLIPS_CHANNEL}/5001/Star_Citizen.mp4?ex=new`;

    function fetchStub (url, opts = {}) {
      calls.push(`${opts.method || 'GET'} ${url}`);
      if (url.startsWith('https://discord.com/api/v10/')) {
        assert.strictEqual(opts.headers.Authorization, 'Bot test-token');
        if (!discordUp) return Promise.reject(new Error('getaddrinfo ENOTFOUND discord.com'));
        const api = url.slice('https://discord.com/api/v10'.length);
        if (api.startsWith('/users/@me/guilds')) return Promise.resolve(response(200, [{ id: GUILD, name: 'G00N SQUAD' }]));
        if (api === `/guilds/${GUILD}/channels`) {
          return Promise.resolve(response(200, [
            { id: CLIPS_CHANNEL, type: 0, name: 'clips' },
            { id: '1300000000000000002', type: 0, name: 'general' },
            { id: '1300000000000000003', type: 0, name: 'eclipse-hunting' },
            { id: '1300000000000000004', type: 2, name: 'clips' }
          ]));
        }
        if (api === `/guilds/${GUILD}/threads/active`) return Promise.resolve(response(200, { threads: [] }));
        if (api.startsWith(`/channels/${CLIPS_CHANNEL}/threads/archived/public?`)) return Promise.resolve(response(200, { threads: [], has_more: false }));
        if (api.startsWith(`/channels/${CLIPS_CHANNEL}/messages?after=`)) return Promise.resolve(response(200, messages.splice(0)));
        if (api === `/guilds/${GUILD}/members/7001`) return Promise.resolve(response(200, { nick: '[G00N] Ace', user: { id: '7001', username: 'ace' } }));
        if (api === '/attachments/refresh-urls' && opts.method === 'POST') {
          const asked = JSON.parse(opts.body).attachment_urls;
          return Promise.resolve(response(200, { refreshed_urls: asked.map((original) => ({ original, refreshed: FRESH_URL })) }));
        }
        return Promise.resolve(response(404, { message: 'Unknown' }));
      }
      if (url === FRESH_URL) {
        assert.ok(!opts.headers || !opts.headers.Authorization, 'never sends the bot token to the CDN');
        return Promise.resolve(response(200, 'ORIGINAL-VIDEO-BYTES'));
      }
      return Promise.resolve(response(404, 'nope'));
    }

    async function fakeRun (command, args, opts = {}) {
      runs.push([command, args]);
      if (/^--?version$/.test(args[0])) return { code: 1, stdout: '', stderr: 'no versions in this test' };
      if (command === 'ffprobe') {
        assert.strictEqual(fs.readFileSync(args[args.length - 1], 'utf8'), 'ORIGINAL-VIDEO-BYTES');
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }],
            format: { duration: '30.0', tags: { creation_time: '2026-10-20T02:33:12.000000Z' } }
          })
        };
      }
      if (command === 'ffmpeg') {
        if (opts.onStdout) opts.onStdout('frame=10\nout_time_us=2000000\nprogress=continue\n');
        fs.writeFileSync(args[args.length - 1], 'FAKE-OUTPUT-' + path.basename(args[args.length - 1]));
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected command' };
    }

    function request (method, pathname, opts = {}) {
      return new Promise((resolve, reject) => {
        const payload = opts.body ? JSON.stringify(opts.body) : null;
        const req = http.request({
          hostname: '127.0.0.1',
          port,
          path: pathname,
          method,
          headers: Object.assign(
            { Accept: 'application/json' },
            opts.member === false ? {} : { 'x-test-member': 'Ace' },
            payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {},
            opts.headers || {}
          )
        }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            let json = null;
            try { json = JSON.parse(raw); } catch (_) { json = null; }
            resolve({ status: res.statusCode, headers: res.headers, raw, json });
          });
        });
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
      });
    }

    before(async function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-clips-'));
      calls = [];
      runs = [];
      discordUp = true;
      messages = [
        {
          id: M1,
          timestamp: '2026-10-20T02:40:00.000000+00:00',
          content: 'Hathor raid, my angle',
          author: { id: '7001', username: 'ace', global_name: 'Ace' },
          attachments: [{ id: '5001', filename: 'Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4', content_type: 'video/mp4', size: 20, url: ATTACHMENT_URL }]
        },
        {
          id: M2,
          timestamp: '2026-10-20T02:41:00.000000+00:00',
          content: 'other angle https://medal.tv/clips/xyz',
          author: { id: '7002', username: 'bix', global_name: 'Bix' },
          attachments: []
        },
        { id: M3, timestamp: '2026-10-20T02:46:00.000000+00:00', content: 'gg', author: { id: '7002', username: 'bix' }, attachments: [] }
      ];
      history = messages.slice();
      clips = new Clips({
        path: root,
        discord: {},
        refreshOnStart: false,
        ttlMs: 0,
        fetch: fetchStub,
        run: fakeRun,
        externalLinks: false,
        keepMasters: false,
        minFreeBytes: 0,
        ffmpegPath: 'ffmpeg',
        ffprobePath: 'ffprobe',
        resolveToken: () => ({ token: 'test-token', source: 'test' }),
        identify: (req) => req.headers['x-test-member'] || null
      });
      await clips.start();
      const middleware = clips.middleware();
      server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
          if (chunks.length) req.body = JSON.parse(Buffer.concat(chunks).toString());
          middleware(req, res, () => { res.statusCode = 418; res.end(); });
        });
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
    });

    after(async function () {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (clips) await clips.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('indexes clips from matching text channels only', async function () {
      const status = await clips.refresh();
      assert.strictEqual(status.channels, 1, 'only #clips (not #general, #eclipse-hunting, or the voice channel)');
      assert.strictEqual(status.added, 2);
      assert.ok(calls.some((c) => c.includes(`/channels/${CLIPS_CHANNEL}/messages?after=${snowflakeAt(Date.now() - 90 * 86400000).slice(0, 6)}`)), 'backfills 90 days');
      const clip = await clips.getClip('5001');
      assert.strictEqual(clip.author, '[G00N] Ace');
      assert.strictEqual(clip.messageUrl, `https://discord.com/channels/${GUILD}/${CLIPS_CHANNEL}/${M1}`);
      assert.strictEqual(clip.proxy.status, 'pending');
      const link = await clips.getClip(`${M2}-l0`);
      assert.strictEqual(link.proxy.status, 'skipped', 'links are sources only unless externalLinks is on');
    });

    it('builds a proxy and thumbnail sprite and dates the recording', async function () {
      await clips._processing;
      const clip = await clips.getClip('5001');
      assert.strictEqual(clip.proxy.status, 'ready', clip.proxy.error);
      assert.strictEqual(clip.durationMs, 30000);
      assert.strictEqual(clip.hasAudio, true);
      assert.deepStrictEqual(
        [clip.recording.recordedAt, clip.recording.source, clip.recording.confidence, clip.recording.offsetMinutes, clip.recording.zone, clip.recording.field],
        ['2026-10-20T02:33:12.020Z', 'filename', 'high', -300, 'metadata', 'creation_time'],
        'the file name dates it, the container tag gives the zone'
      );
      assert.deepStrictEqual(clip.timeTags, [{ field: 'creation_time', value: '2026-10-20T02:33:12.000Z' }]);
      assert.deepStrictEqual(await clips.store.get('/authors/7001').then((a) => a.offsetMinutes), -300, 'learns the uploader\'s zone');
      assert.ok(fs.existsSync(path.join(root, 'media', '5001.mp4')));
      assert.ok(fs.existsSync(path.join(root, 'media', '5001.jpg')));
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'tmp')), [], 'drops the original');
      const proxyArgs = runs.find(([cmd, args]) => cmd === 'ffmpeg' && args.includes('-crf'))[1];
      assert.ok(proxyArgs.includes('scale=-2:trunc(min(240\\,ih)/2)*2,fps=15'));
      const sprite = runs.find(([cmd, args]) => cmd === 'ffmpeg' && args.includes('-frames:v'))[1];
      assert.ok(sprite.includes('fps=0.500000:eof_action=pass,scale=120:68,tile=10x2'), sprite.join(' '));
      assert.deepStrictEqual(clip.proxy.thumbs, { every: 2, count: 15, columns: 10, rows: 2, width: 120, height: 68 });
    });

    it('reads the next page from the saved cursor', async function () {
      calls = [];
      await clips.refresh();
      assert.ok(calls.some((c) => c.endsWith(`/channels/${CLIPS_CHANNEL}/messages?after=${M3}&limit=100`)), calls.join('\n'));
    });

    it('reads a channel\'s whole history again on request, keeping what is stored', async function () {
      calls = [];
      clips.settings.backfillDays = 0;
      messages.push(Object.assign({}, history[0], { content: 'Hathor raid with <@7002>', mentions: [{ id: '7002', username: 'bix', global_name: 'Bix' }] }), ...history.slice(1));
      try {
        const status = await clips.refresh({ fromStart: true });
        assert.ok(calls.some((c) => c.endsWith(`/channels/${CLIPS_CHANNEL}/messages?after=0&limit=100`)), calls.join('\n'));
        assert.strictEqual(status.added, 0, 'no duplicates');
        assert.strictEqual((await clips.getClip('5001')).caption, 'Hathor raid with @Bix', 'an edited caption is picked up');
        assert.strictEqual((await clips.store.get(`/channels/${CLIPS_CHANNEL}`)).cursor, M3);
      } finally {
        clips.settings.backfillDays = 90;
      }
    });

    it('needs no sign-in, and names signed-in members on their changes', async function () {
      assert.strictEqual((await request('GET', '/services/clips', { member: false })).status, 200);
      assert.strictEqual((await request('GET', '/services/clips/5001/proxy', { member: false })).status, 200);
      const anonymous = await request('PATCH', '/services/clips/5001', { member: false, body: { syncOffsetMs: 100 } });
      assert.strictEqual(anonymous.status, 200, anonymous.raw);
      assert.strictEqual(anonymous.json.override.by, null);
      await request('PATCH', '/services/clips/5001', { member: false, body: { syncOffsetMs: 0 } });
      await clips._updateClip('5001', (record) => { record.log = []; });
    });

    it('lists clips and sessions without Discord user ids', async function () {
      const list = await request('GET', '/services/clips');
      assert.strictEqual(list.status, 200);
      assert.strictEqual(list.json.clips.length, 2);
      assert.strictEqual(list.json.status.ready, 1);
      assert.strictEqual(list.json.status.linksOnly, 1);
      assert.deepStrictEqual(list.json.channels.map((c) => c.name), ['clips']);
      assert.ok(!/"7001"|"7002"|authorId/.test(list.raw), 'no member ids');
      const sessions = await request('GET', '/services/clips/sessions');
      assert.strictEqual(sessions.json.sessions.length, 1, 'recorded 02:33 and posted 02:41: one session');
      const session = sessions.json.sessions[0];
      assert.deepStrictEqual(session.authors.slice().sort(), ['Bix', '[G00N] Ace'].sort());
      assert.strictEqual(session.clips.length, 2);
      assert.strictEqual(session.clips.find((c) => c.id === '5001').proxyUrl, '/services/clips/5001/proxy');
    });

    it('streams the proxy with byte ranges', async function () {
      const res = await request('GET', '/services/clips/5001/proxy', { headers: { Range: 'bytes=0-3' } });
      assert.strictEqual(res.status, 206);
      assert.strictEqual(res.raw, 'FAKE');
      assert.strictEqual(res.headers['content-range'], `bytes 0-3/${fs.statSync(path.join(root, 'media', '5001.mp4')).size}`);
      assert.strictEqual(res.headers['content-type'], 'video/mp4');
      const thumbs = await request('GET', '/services/clips/5001/thumbs');
      assert.strictEqual(thumbs.status, 200);
      assert.strictEqual(thumbs.headers['content-type'], 'image/jpeg');
      assert.strictEqual((await request('GET', `/services/clips/${M2}-l0/proxy`)).status, 404);
    });

    it('re-dates stored clips under the current rules without downloading', async function () {
      const before = await clips.getClip('5001');
      await clips._updateClip('5001', (record) => { record.recording = { recordedAt: '2026-10-20T02:33:12.000Z', source: 'metadata', confidence: 'high', offsetMinutes: -300, pattern: 'shadowplay' }; });
      runs = [];
      assert.strictEqual(await clips.redate(), 1);
      assert.deepStrictEqual((await clips.getClip('5001')).recording, before.recording);
      assert.deepStrictEqual(runs, [], 'nothing fetched or probed');
      assert.strictEqual(await clips.redate(), 0);
    });

    it('records manual recording times and sync nudges', async function () {
      const res = await request('PATCH', '/services/clips/5001', { body: { syncOffsetMs: 1500 } });
      assert.strictEqual(res.status, 200, res.raw);
      assert.strictEqual(res.json.recordedAt, '2026-10-20T02:33:13.520Z');
      assert.strictEqual(res.json.override.by, 'Ace');
      assert.strictEqual((await request('PATCH', '/services/clips/5001', { body: { syncOffsetMs: 3600000 } })).status, 400);
      const reset = await request('PATCH', '/services/clips/5001', { body: { syncOffsetMs: 0 } });
      assert.strictEqual(reset.json.override, null);
      assert.strictEqual((await clips.getClip('5001')).log.length, 2);
    });

    it('keeps projects with every revision', async function () {
      const created = await request('POST', '/services/clips/projects', { body: { name: 'Hathor raid', sessionId: 's-5001', segments: [{ clipId: '5001', in: 1, out: 5 }] } });
      assert.strictEqual(created.status, 201, created.raw);
      assert.strictEqual(created.json.revision, 1);
      assert.strictEqual(created.json.createdBy, 'Ace');
      const id = created.json.id;
      assert.strictEqual((await request('POST', '/services/clips/projects', { body: { name: 'Bad', segments: [{ clipId: `${M2}-l0`, in: 0, out: 1 }] } })).status, 400, 'only clips with a proxy');
      assert.strictEqual((await request('PATCH', `/services/clips/projects/${id}`, { body: { revision: 7, name: 'x y' } })).status, 409);
      assert.strictEqual((await request('PATCH', `/services/clips/projects/${id}`, { body: { segments: [{ clipId: '5001', in: 0, out: 99 }] } })).status, 400);
      const saved = await request('PATCH', `/services/clips/projects/${id}`, { body: { revision: 1, segments: [{ clipId: '5001', in: 2, out: 6, audio: 'mute' }] } });
      assert.strictEqual(saved.status, 200, saved.raw);
      assert.strictEqual(saved.json.revision, 2);
      assert.deepStrictEqual(saved.json.segments, [{ clipId: '5001', in: 2, out: 6, audio: 'mute', volume: 1 }]);
      assert.deepStrictEqual((await clips.store.get(`/projects/${id}/revisions/1`)).segments, [{ clipId: '5001', in: 1, out: 5, audio: 'on', volume: 1 }]);
      const list = await request('GET', '/services/clips/projects');
      assert.deepStrictEqual(list.json.projects.map((p) => [p.name, p.segments, p.durationMs]), [['Hathor raid', 1, 4000]]);
      assert.deepStrictEqual(await clips.page(`/clips/projects/${id}`), { path: `/clips/projects/${id}`, title: 'Hathor raid', description: 'A squad film from our Discord clips. 1 cut, 4 seconds.' });
      assert.strictEqual(await clips.page('/clips/projects/nope'), null);
    });

    it('renders the cut from the originals with a sources manifest', async function () {
      const [project] = (await request('GET', '/services/clips/projects')).json.projects;
      runs = [];
      const queued = await request('POST', `/services/clips/projects/${project.id}/renders`);
      assert.strictEqual(queued.status, 202, queued.raw);
      assert.strictEqual(queued.json.status, 'queued');
      assert.strictEqual(queued.json.revision, 2);
      await clips._renderChain;
      const render = await request('GET', `/services/clips/renders/${queued.json.id}`);
      assert.strictEqual(render.json.status, 'complete', render.json.error);
      assert.strictEqual(render.json.progress, 1);
      assert.strictEqual(render.json.fileUrl, `/services/clips/renders/${queued.json.id}/file`);
      const [, args] = runs.find(([cmd]) => cmd === 'ffmpeg');
      assert.deepStrictEqual(args.slice(6, 10), ['-ss', '2', '-t', '4']);
      assert.ok(args.some((arg) => /anullsrc/.test(arg)), 'the muted segment has silent audio');
      const file = await request('GET', `/services/clips/renders/${queued.json.id}/file`);
      assert.strictEqual(file.status, 200);
      assert.ok(/^FAKE-OUTPUT-/.test(file.raw));
      assert.ok(/attachment; filename="Hathor raid r2.mp4"/.test(file.headers['content-disposition']));
      const sources = await request('GET', `/services/clips/renders/${queued.json.id}/sources`);
      assert.strictEqual(sources.json.segments[0].clip.author, '[G00N] Ace');
      assert.strictEqual(sources.json.segments[0].clip.messageUrl, `https://discord.com/channels/${GUILD}/${CLIPS_CHANNEL}/${M1}`);
      assert.strictEqual(sources.json.segments[0].recordedFrom, '2026-10-20T02:33:14.020Z');
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'tmp')), [], 'drops the downloaded originals');
      const projectView = await request('GET', `/services/clips/projects/${project.id}`);
      assert.strictEqual(projectView.json.renders[0].id, queued.json.id);
      assert.strictEqual(projectView.json.log[projectView.json.log.length - 1].type, 'render');
      const again = await request('POST', `/services/clips/projects/${project.id}/renders`);
      assert.strictEqual(again.json.id, queued.json.id, 'the same revision is not rendered twice');
    });

    it('limits how many renders wait at once', async function () {
      const [project] = (await request('GET', '/services/clips/projects')).json.projects;
      clips.settings.maxQueuedRenders = 0;
      try {
        await request('PATCH', `/services/clips/projects/${project.id}`, { body: { notes: 'busy' } });
        const refused = await request('POST', `/services/clips/projects/${project.id}/renders`);
        assert.strictEqual(refused.status, 429);
      } finally {
        clips.settings.maxQueuedRenders = 3;
      }
    });

    it('records a failed render', async function () {
      const [project] = (await request('GET', '/services/clips/projects')).json.projects;
      discordUp = false;
      const queued = await request('POST', `/services/clips/projects/${project.id}/renders`);
      await clips._renderChain;
      const render = await request('GET', `/services/clips/renders/${queued.json.id}`);
      assert.strictEqual(render.json.status, 'failed');
      assert.ok(render.json.error);
      assert.strictEqual((await request('GET', `/services/clips/renders/${queued.json.id}/file`)).status, 409);
    });

    it('keeps serving stored clips while Discord is down', async function () {
      discordUp = false;
      await assert.rejects(clips.refresh(), /ENOTFOUND/);
      const list = await request('GET', '/services/clips');
      assert.strictEqual(list.json.clips.length, 2);
      discordUp = true;
    });

    it('queues stored link-only clips for import once links are on', async function () {
      assert.strictEqual(await clips.queueLinks(), 0);
      clips.settings.externalLinks = ['youtube.com'];
      assert.strictEqual(await clips.queueLinks(), 0, 'only the listed hosts');
      clips.settings.externalLinks = ['medal.tv'];
      try {
        assert.strictEqual(await clips.queueLinks(), 1);
        assert.strictEqual((await clips.getClip(`${M2}-l0`)).proxy.status, 'pending');
        assert.strictEqual(await clips.queueLinks(), 0);
      } finally {
        clips.settings.externalLinks = false;
      }
    });
  });

  describe('Clips thread sources', function () {
    this.timeout(20000);

    const VIDEOS = '1300000000000000010';
    const LIBRARY = '1300000000000000011';
    const MARKET = '1300000000000000012';
    const POST = '1300000000000000020';
    const ARCHIVED = '1300000000000000021';
    const SALE = '1300000000000000022';
    const M4 = snowflakeAt(Date.parse('2024-05-01T20:00:00Z'));
    const M5 = snowflakeAt(Date.parse('2024-06-01T20:00:00Z'));
    const M6 = snowflakeAt(Date.parse('2024-06-02T20:00:00Z'));
    let root;
    let clips;
    let calls;

    function fetchStub (url) {
      calls.push(url);
      const api = url.slice('https://discord.com/api/v10'.length);
      const ok = (json) => Promise.resolve(response(200, json));
      if (api.startsWith('/users/@me/guilds')) return ok([{ id: GUILD, name: 'G00N SQUAD' }]);
      if (api === `/guilds/${GUILD}/channels`) {
        return ok([
          { id: VIDEOS, type: 0, name: 'videos', last_message_id: M4 },
          { id: LIBRARY, type: 16, name: 'library' },
          { id: MARKET, type: 15, name: 'market' }
        ]);
      }
      if (api === `/guilds/${GUILD}/threads/active`) {
        return ok({ threads: [
          { id: POST, parent_id: LIBRARY, name: '[GSR] GOON RACING', last_message_id: M5 },
          { id: SALE, parent_id: MARKET, name: 'WTS' }
        ] });
      }
      if (api.startsWith(`/channels/${VIDEOS}/threads/archived/public?`)) {
        return ok({ threads: [{ id: ARCHIVED, parent_id: VIDEOS, name: 'Video Production', last_message_id: M6, thread_metadata: { archive_timestamp: '2024-06-02T00:00:00Z' } }], has_more: false });
      }
      if (api.startsWith(`/channels/${LIBRARY}/threads/archived/public?`)) return Promise.resolve(response(403, { message: 'Missing Access' }));
      if (api.startsWith(`/channels/${VIDEOS}/messages?after=`)) {
        return ok([{ id: M4, timestamp: '2024-05-01T20:00:00.000000+00:00', content: 'https://youtu.be/abc', author: { id: '7003' }, attachments: [] }]);
      }
      if (api.startsWith(`/channels/${POST}/messages?after=`)) {
        return ok([{ id: M5, timestamp: '2024-06-01T20:00:00.000000+00:00', content: 'race day https://medal.tv/games/star-citizen/clips/race1', author: { id: '7003' }, attachments: [] }]);
      }
      if (api.startsWith(`/channels/${ARCHIVED}/messages?after=`)) {
        return ok([{ id: M6, timestamp: '2024-06-02T20:00:00.000000+00:00', content: 'cutting this one tonight', author: { id: '7003' }, attachments: [] }]);
      }
      return Promise.resolve(response(404, { message: 'Unknown' }));
    }

    before(async function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-clips-threads-'));
      calls = [];
      clips = new Clips({
        path: root,
        discord: {},
        refreshOnStart: false,
        poll: false,
        backfillDays: 0,
        fetch: fetchStub,
        run: async () => ({ code: 1, stdout: '', stderr: 'no ffmpeg in this test' }),
        resolveToken: () => ({ token: 'test-token', source: 'test' })
      });
      await clips.start();
    });

    after(async function () {
      if (clips) await clips.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('reads video channels, media channel posts, and archived threads from the start', async function () {
      const status = await clips.refresh();
      assert.strictEqual(status.channels, 3, '#videos, its archived thread, and the #library post (not #market)');
      assert.strictEqual(status.added, 2);
      assert.strictEqual(status.error, null, 'a channel without access to its archived threads is not an error');
      assert.ok(calls.some((c) => c.endsWith(`/channels/${VIDEOS}/messages?after=0&limit=100`)), 'whole history');
      assert.ok(!calls.some((c) => c.includes(`/channels/${SALE}/`)), 'never reads unrelated forum posts');
      const post = await clips.getClip(`${M5}-l0`);
      assert.strictEqual(post.channelName, 'library');
      assert.strictEqual(post.threadName, '[GSR] GOON RACING');
      assert.strictEqual(post.messageUrl, `https://discord.com/channels/${GUILD}/${POST}/${M5}`);
      assert.strictEqual(clips.publicClip(post).thread, '[GSR] GOON RACING');
      const list = await clips.list();
      assert.deepStrictEqual(list.channels.map((c) => [c.name, c.clips]).sort(), [['library', 1], ['videos', 1]]);
    });

    it('downloads Medal clips by default and keeps other links as sources', async function () {
      assert.notStrictEqual((await clips.getClip(`${M5}-l0`)).proxy.status, 'skipped', 'Medal');
      assert.strictEqual((await clips.getClip(`${M4}-l0`)).proxy.status, 'skipped', 'YouTube');
    });

    it('skips channels and threads with nothing new', async function () {
      calls = [];
      await clips.refresh();
      assert.ok(!calls.some((c) => /\/messages\?/.test(c)), calls.join('\n'));
    });
  });

  describe('Clips proxy retries', function () {
    this.timeout(20000);

    let root;
    let clips;
    let installed;
    let version;
    let clock;

    function linkClip (id, proxy) {
      return { id, kind: 'link', url: `https://medal.tv/clips/${id}`, author: 'Ace', postedAt: '2026-10-20T02:40:00.000Z', proxy };
    }

    async function seed (records) {
      for (const record of records) {
        await clips.store.set(`/clips/${record.id}`, record);
        await clips._append('clips', record.id);
      }
    }

    before(async function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-clips-retry-'));
      installed = false;
      version = '2026.01.01';
      clock = Date.parse('2026-10-20T12:00:00Z');
      clips = new Clips({
        path: root,
        discord: {},
        poll: false,
        minFreeBytes: 0,
        now: () => clock,
        fetch: () => Promise.resolve(response(404, {})),
        run: async (command, args) => {
          if (!installed) throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' });
          if (/^--?version$/.test(args[0])) return { code: 0, stdout: `${command} ${version}\n`, stderr: '' };
          return { code: 1, stdout: '', stderr: 'ERROR: [medal] clip is private' };
        },
        resolveToken: () => ({ token: 'test-token', source: 'test' })
      });
      await clips.start();
    });

    after(async function () {
      if (clips) await clips.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('leaves clips queued without spending attempts while a tool is missing', async function () {
      await seed([linkClip('a', { status: 'pending', attempts: 0, error: null }), linkClip('b', { status: 'pending', attempts: 0, error: null })]);
      for (let i = 0; i < 4; i++) assert.strictEqual(await clips.processPending(), 0);
      for (const id of ['a', 'b']) assert.deepStrictEqual((await clips.getClip(id)).proxy, { status: 'pending', attempts: 0, error: null });
    });

    it('keeps building upload proxies while only yt-dlp is missing', async function () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-clips-noytdlp-'));
      const own = new Clips({
        path: dir,
        discord: {},
        poll: false,
        minFreeBytes: 0,
        fetch: () => Promise.resolve(response(404, {})),
        run: async (command) => {
          if (command === 'yt-dlp') throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
          return { code: 1, stdout: '', stderr: 'no such file' };
        },
        resolveToken: () => ({ token: 'test-token', source: 'test' })
      });
      await own.start();
      try {
        const upload = { id: 'u', kind: 'attachment', guildId: '1', channelId: '2', messageId: '3', attachmentId: '4', filename: 'clip.mp4', author: 'Ace', postedAt: '2026-10-20T02:41:00.000Z', proxy: { status: 'pending', attempts: 0, error: null } };
        for (const record of [linkClip('l1', { status: 'pending', attempts: 0, error: null }), upload, linkClip('l2', { status: 'pending', attempts: 0, error: null })]) {
          await own.store.set(`/clips/${record.id}`, record);
          await own._append('clips', record.id);
        }
        await own.processPending();
        assert.deepStrictEqual((await own.getClip('l1')).proxy, { status: 'pending', attempts: 0, error: null });
        assert.deepStrictEqual((await own.getClip('l2')).proxy, { status: 'pending', attempts: 0, error: null });
        assert.strictEqual((await own.getClip('u')).proxy.attempts, 1, 'the upload after the link was still tried');
      } finally {
        await own.stop();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('requeues clips that failed for a missing tool or codec, and every failure when asked', async function () {
      await seed([
        linkClip('c', { status: 'failed', attempts: 3, error: 'ffprobe is not installed' }),
        linkClip('d', { status: 'failed', attempts: 3, error: "ffmpeg exited 1: Unknown encoder 'libx264'" }),
        linkClip('e', { status: 'failed', attempts: 3, error: 'yt-dlp exited 1: ERROR: Video unavailable' })
      ]);
      assert.strictEqual(await clips.retryFailed(), 2);
      assert.deepStrictEqual((await clips.getClip('c')).proxy, { status: 'pending', attempts: 0, error: null });
      assert.strictEqual((await clips.getClip('d')).proxy.status, 'pending');
      assert.strictEqual((await clips.getClip('e')).proxy.status, 'failed');
      assert.strictEqual(await clips.retryFailed({ all: true }), 1);
      assert.strictEqual((await clips.getClip('e')).proxy.status, 'pending');
    });

    it('counts real failures once the tool is there', async function () {
      installed = true;
      await clips.processPending();
      const proxy = (await clips.getClip('a')).proxy;
      assert.strictEqual(proxy.attempts, 1);
      assert.match(proxy.error, /clip is private/);
    });

    it('requeues missing-tool failures and stored Medal links on start', async function () {
      await clips.store.set('/clips/c', linkClip('c', { status: 'failed', attempts: 3, error: 'ffmpeg is not installed' }));
      await seed([
        linkClip('f', { status: 'skipped', attempts: 0, error: null }),
        Object.assign(linkClip('g', { status: 'skipped', attempts: 0, error: null }), { url: 'https://youtu.be/abc' })
      ]);
      await clips.stop();
      await clips.start();
      assert.strictEqual((await clips.getClip('c')).proxy.status, 'pending');
      assert.strictEqual((await clips.getClip('f')).proxy.status, 'pending', 'Medal links are imported by default');
      assert.strictEqual((await clips.getClip('g')).proxy.status, 'skipped');
    });

    it('retries every failed clip once ffmpeg or yt-dlp is upgraded', async function () {
      await clips.retryAfterToolChange();
      const medal = 'yt-dlp exited 1: ERROR: [MedalTV] h: Could not find video information.';
      await clips.store.set('/clips/h', linkClip('h', { status: 'failed', attempts: 3, error: medal, failedAt: new Date(clock).toISOString() }));
      await clips._append('clips', 'h');
      assert.strictEqual(await clips.retryAfterToolChange(), 0, 'same versions');
      assert.strictEqual(await clips.retryFailed(), 0, 'not a missing tool');
      version = '2026.10.20';
      assert.strictEqual(await clips.retryAfterToolChange(), 1);
      assert.deepStrictEqual((await clips.getClip('h')).proxy, { status: 'pending', attempts: 0, error: null });
      assert.strictEqual((await clips.store.get('/tools'))['yt-dlp'], 'yt-dlp 2026.10.20');
    });

    it('retries failures a week old in the periodic pass', async function () {
      await clips.store.set('/clips/h', linkClip('h', { status: 'failed', attempts: 3, error: 'yt-dlp exited 1: HTTP Error 404', failedAt: new Date(clock - 8 * 24 * 3600 * 1000).toISOString() }));
      await clips.store.set('/clips/c', linkClip('c', { status: 'failed', attempts: 3, error: 'yt-dlp exited 1: HTTP Error 404', failedAt: new Date(clock - 3600 * 1000).toISOString() }));
      const pass = await clips.maintain();
      assert.strictEqual(pass.retried, 1);
      assert.strictEqual((await clips.getClip('c')).proxy.status, 'failed', 'failed an hour ago');
      await clips._processing;
      const h = (await clips.getClip('h')).proxy;
      assert.strictEqual(h.attempts, 1, 'tried again');
      assert.strictEqual(h.status, 'pending');
    });
  });

  describe('Clips screenshots', function () {
    this.timeout(20000);

    const SHOTS = '1300000000000000009';
    const POSTED = '2026-10-20T02:40:00.000000+00:00';
    const MESSAGE = snowflakeAt(Date.parse(POSTED));
    const VIDEO_URL = `${CDN}/${SHOTS}/8001/raid.mp4`;
    const IMAGE_URL = `${CDN}/${SHOTS}/8002/shot.png`;
    // A PNG whose tIME chunk (UTC) says it was saved at 02:38:40.
    const chunk = (type, data) => Buffer.concat([Buffer.from([0, 0, 0, data.length]), Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
    const PNG = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('tIME', Buffer.from([0x07, 0xea, 10, 20, 2, 38, 40])),
      chunk('IEND', Buffer.alloc(0))
    ]);
    let root;
    let clips;
    let runs;
    let server;
    let port;

    function fetchStub (url, opts = {}) {
      if (url.startsWith('https://discord.com/api/v10/')) {
        const api = url.slice('https://discord.com/api/v10'.length);
        if (api.startsWith('/users/@me/guilds')) return Promise.resolve(response(200, [{ id: GUILD, name: 'G00N SQUAD' }]));
        if (api === `/guilds/${GUILD}/channels`) return Promise.resolve(response(200, [{ id: SHOTS, type: 0, name: 'screenshots' }]));
        if (api === `/guilds/${GUILD}/threads/active`) return Promise.resolve(response(200, { threads: [] }));
        if (api.startsWith(`/channels/${SHOTS}/threads/archived/public?`)) return Promise.resolve(response(200, { threads: [], has_more: false }));
        if (api.startsWith(`/channels/${SHOTS}/messages?after=`)) {
          return Promise.resolve(response(200, api.includes(`after=${MESSAGE}`) ? [] : [{
            id: MESSAGE,
            timestamp: POSTED,
            content: 'raid and a screenshot',
            author: { id: '7003', username: 'cy', global_name: 'Cy' },
            attachments: [
              { id: '8001', filename: 'raid.mp4', content_type: 'video/mp4', url: VIDEO_URL },
              { id: '8002', filename: 'Star Citizen Screenshot 2026.10.19 - 21.38.40.12.png', content_type: 'image/png', width: 1920, height: 1080, url: IMAGE_URL }
            ]
          }]));
        }
        if (api === `/guilds/${GUILD}/members/7003`) return Promise.resolve(response(200, { user: { id: '7003', username: 'cy', global_name: 'Cy' } }));
        if (api === '/attachments/refresh-urls' && opts.method === 'POST') {
          const asked = JSON.parse(opts.body).attachment_urls;
          return Promise.resolve(response(200, { refreshed_urls: asked.map((original) => ({ original, refreshed: `${original}?ex=new` })) }));
        }
        return Promise.resolve(response(404, { message: 'Unknown' }));
      }
      if (url === `${VIDEO_URL}?ex=new`) return Promise.resolve(response(200, 'VIDEO'));
      if (url === `${IMAGE_URL}?ex=new`) return Promise.resolve(response(200, PNG));
      return Promise.resolve(response(404, 'nope'));
    }

    async function fakeRun (command, args) {
      runs.push([command, args]);
      const last = args[args.length - 1];
      if (/^--?version$/.test(args[0])) return { code: 1, stdout: '', stderr: 'no versions in this test' };
      if (command === 'ffprobe') {
        const image = fs.readFileSync(last).equals(PNG);
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify(image
            ? { streams: [{ codec_type: 'video', codec_name: 'png', width: 1920, height: 1080 }], format: { duration: '0.04' } }
            : { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }], format: { duration: '600.0' } })
        };
      }
      fs.writeFileSync(last, 'FAKE-' + path.basename(last));
      return { code: 0, stdout: '', stderr: '' };
    }

    before(async function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-clips-shots-'));
      runs = [];
      clips = new Clips({
        path: root,
        discord: {},
        refreshOnStart: false,
        ttlMs: 0,
        rescanEveryMs: 0,
        minFreeBytes: 0,
        externalLinks: false,
        stillSeconds: 8,
        fetch: fetchStub,
        run: fakeRun,
        resolveToken: () => ({ token: 'test-token', source: 'test' })
      });
      await clips.start();
      const middleware = clips.middleware();
      server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 418; res.end(); }));
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = server.address().port;
    });

    after(async function () {
      if (server) await new Promise((resolve) => server.close(resolve));
      if (clips) await clips.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    function get (pathname) {
      return new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port, path: pathname, headers: { Accept: 'application/json' } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: Buffer.concat(chunks).toString() }));
        }).on('error', reject);
      });
    }

    it('reads screenshots channels and builds a preview and a one-frame sprite', async function () {
      const status = await clips.refresh();
      assert.strictEqual(status.added, 2);
      await clips._processing;
      const shot = await clips.getClip('8002');
      assert.strictEqual(shot.media, 'image');
      assert.strictEqual(shot.proxy.status, 'ready', shot.proxy.error);
      assert.strictEqual(shot.durationMs, null);
      assert.strictEqual(shot.hasAudio, false);
      assert.deepStrictEqual(
        [shot.recording.recordedAt, shot.recording.source, shot.recording.pattern, shot.recording.offsetMinutes, shot.recording.zone, shot.recording.field],
        ['2026-10-20T02:38:40.120Z', 'filename', 'shadowplay', -300, 'metadata', 'png:tIME'],
        'the NVIDIA name dates it; the PNG tIME chunk gives the zone'
      );
      assert.deepStrictEqual(shot.timeTags, [{ field: 'png:tIME', value: '2026-10-20T02:38:40Z' }]);
      assert.deepStrictEqual(await clips.store.get('/authors/7003').then((a) => a.offsetMinutes), -300);
      assert.deepStrictEqual(shot.proxy.thumbs, { every: 1, count: 1, columns: 1, rows: 1, width: 120, height: 68 });
      assert.strictEqual(shot.master.file, '8002.png');
      assert.ok(fs.existsSync(path.join(root, 'media', '8002.preview.jpg')));
      assert.ok(fs.existsSync(path.join(root, 'media', '8002.jpg')));
      const ffmpeg = runs.filter(([command, args]) => command === 'ffmpeg' && args.some((arg) => arg.includes(`${path.sep}8002-`)));
      assert.strictEqual(ffmpeg.length, 2, 'a preview and a sprite, no video proxy');
      assert.ok(ffmpeg[0][1].includes('scale=-2:trunc(min(720\\,ih)/2)*2'), 'a preview at most 720p');
      assert.ok(ffmpeg[1][1].includes('scale=120:68'));
    });

    it('serves the screenshot with its display time, in the same session as the video', async function () {
      const list = JSON.parse((await get('/services/clips')).raw);
      assert.strictEqual(list.status.screenshots, 1);
      assert.deepStrictEqual(list.stills, { seconds: 8, maxSeconds: 60 });
      const shot = list.clips.find((c) => c.id === '8002');
      assert.deepStrictEqual([shot.media, shot.durationMs, shot.proxyUrl], ['image', 8000, '/services/clips/8002/proxy']);
      assert.strictEqual(list.clips.find((c) => c.id === '8001').media, 'video');
      const preview = await get('/services/clips/8002/proxy');
      assert.strictEqual(preview.status, 200);
      assert.strictEqual(preview.headers['content-type'], 'image/jpeg');
      assert.strictEqual(preview.raw, 'FAKE-preview.jpg');
      const [session] = JSON.parse((await get('/services/clips/sessions')).raw).sessions;
      assert.deepStrictEqual([session.clipCount, session.screenshotCount], [2, 1]);
      const entry = session.tracks[0].clips.find((c) => c.id === '8002');
      assert.strictEqual(entry.durationMs, 8000);
    });

    it('cuts a screenshot into a project and renders it as a held frame', async function () {
      const project = await clips.createProject({ name: 'Raid night', segments: [{ clipId: '8001', in: 0, out: 4 }, { clipId: '8002', in: 0, out: 6 }] });
      assert.deepStrictEqual(project.segments[1], { clipId: '8002', in: 0, out: 6, audio: 'on', volume: 1 });
      await assert.rejects(clips.createProject({ name: 'Too long', segments: [{ clipId: '8002', in: 0, out: 90 }] }), /at most 60s/);
      runs = [];
      const render = await clips.startRender(project.id);
      await clips._renderChain;
      assert.strictEqual((await clips.getRender(render.id)).status, 'complete');
      const [, args] = runs.find(([command]) => command === 'ffmpeg');
      const still = args.indexOf(path.join(root, 'masters', '8002.png'));
      assert.deepStrictEqual(args.slice(still - 7, still + 1), ['-loop', '1', '-framerate', '30', '-t', '6', '-i', path.join(root, 'masters', '8002.png')]);
    });
  });

  describe('Clips masters and rescans', function () {
    this.timeout(20000);

    const DAY = 24 * 60 * 60 * 1000;
    const UPLOAD = `${CDN}/${CLIPS_CHANNEL}/6001/raid.mp4`;
    let root;
    let clips;
    let clock;
    let offered;
    let runs;

    async function fakeRun (command, args) {
      runs.push([command, args]);
      const last = args[args.length - 1];
      if (/^--?version$/.test(args[0])) return { code: 0, stderr: '', stdout: `${command} 1.0\n` };
      if (command === 'yt-dlp' && args.includes('-J')) return { code: 0, stderr: '', stdout: JSON.stringify({ height: offered, requested_formats: [{ height: offered }, { height: null }] }) };
      if (command === 'yt-dlp') {
        const out = args[args.indexOf('-o') + 1];
        fs.writeFileSync(out, `LINK-${offered}`);
        // Medal's clip creation time, as yt-dlp reports it.
        if (args.includes('--write-info-json')) fs.writeFileSync(out.replace(/\.mp4$/, '.info.json'), JSON.stringify({ timestamp: Date.parse('2026-10-20T02:35:00Z') / 1000 }));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command === 'ffprobe') {
        const height = Number((/(\d+)$/.exec(fs.readFileSync(last, 'utf8')) || [])[1]) || 1080;
        return { code: 0, stderr: '', stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: Math.round(height * 16 / 9), height }], format: { duration: '12.0' } }) };
      }
      fs.writeFileSync(last, 'FAKE');
      return { code: 0, stdout: '', stderr: '' };
    }

    function fetchStub (url, opts = {}) {
      if (url.endsWith('/attachments/refresh-urls') && opts.method === 'POST') {
        return Promise.resolve(response(200, { refreshed_urls: [{ original: UPLOAD, refreshed: `${UPLOAD}?ex=new` }] }));
      }
      if (url === `${UPLOAD}?ex=new`) return Promise.resolve(response(200, 'UPLOAD-1080'));
      return Promise.resolve(response(404, {}));
    }

    function ready (id, extra) {
      return Object.assign({
        id,
        author: 'Ace',
        channelId: CLIPS_CHANNEL,
        messageId: '9001',
        postedAt: '2026-10-20T02:40:00.000Z',
        proxy: { status: 'ready', attempts: 0, error: null, height: 240 }
      }, extra);
    }

    before(async function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-clips-masters-'));
      clock = Date.parse('2026-10-20T12:00:00Z');
      offered = 720;
      runs = [];
      clips = new Clips({
        path: root,
        discord: {},
        poll: false,
        minFreeBytes: 0,
        fetch: fetchStub,
        run: fakeRun,
        now: () => clock,
        resolveToken: () => ({ token: 'test-token', source: 'test' })
      });
      await clips.start();
      for (const clip of [
        ready('6001', { kind: 'attachment', url: UPLOAD, filename: 'raid.mp4' }),
        ready('9002-l0', { kind: 'link', url: 'https://medal.tv/clips/abc' })
      ]) {
        await clips.store.set(`/clips/${clip.id}`, clip);
        await clips._append('clips', clip.id);
      }
    });

    after(async function () {
      if (clips) await clips.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('stores a master for downloads made before masters were kept', async function () {
      assert.deepStrictEqual(await clips.rescan({ limit: Infinity }), { checked: 2, stored: 2, upgraded: 0 });
      const upload = await clips.getClip('6001');
      assert.strictEqual(upload.master.height, 1080);
      assert.strictEqual(fs.readFileSync(path.join(root, 'masters', upload.master.file), 'utf8'), 'UPLOAD-1080');
      const link = await clips.getClip('9002-l0');
      assert.strictEqual(link.master.height, 720);
      assert.strictEqual(link.uploadedAt, '2026-10-20T02:35:00.000Z');
      assert.deepStrictEqual([link.recording.recordedAt, link.recording.source], ['2026-10-20T02:34:48.000Z', 'uploaded'], 'the host had it before the post');
      assert.deepStrictEqual(clips.publicClip(link).master, { width: 1280, height: 720 });
      assert.ok(!JSON.stringify(clips.publicClip(link)).includes(root), 'no server paths');
    });

    it('leaves stored uploads alone and rechecks links only after recheckAfterMs', async function () {
      runs = [];
      assert.deepStrictEqual(await clips.rescan({ limit: Infinity }), { checked: 0, stored: 0, upgraded: 0 });
      clock += 8 * DAY;
      assert.deepStrictEqual(await clips.rescan({ limit: Infinity }), { checked: 1, stored: 0, upgraded: 0 });
      assert.deepStrictEqual(runs.filter(([, args]) => !/version/.test(args[0])).map(([command, args]) => `${command} ${args.includes('-J') ? '-J' : 'download'}`), ['yt-dlp -J'], 'asks without downloading');
      assert.strictEqual((await clips.getClip('9002-l0')).master.checkedAt, new Date(clock).toISOString());
    });

    it('downloads a taller version when the host offers one', async function () {
      clock += 8 * DAY;
      offered = 1080;
      assert.deepStrictEqual(await clips.rescan({ limit: Infinity }), { checked: 1, stored: 0, upgraded: 1 });
      const link = await clips.getClip('9002-l0');
      assert.strictEqual(link.master.height, 1080);
      assert.strictEqual(link.height, 1080);
      assert.deepStrictEqual(fs.readdirSync(path.join(root, 'masters')).sort(), ['6001.mp4', '9002-l0.mp4']);
      assert.ok(runs.some(([command, args]) => command === 'yt-dlp' && args.includes('bv*[height<=1080]+ba/b[height<=1080]/b')));
    });

    it('renders from the stored masters without asking Discord or the host', async function () {
      runs = [];
      const project = await clips.createProject({ name: 'Raid night', segments: [{ clipId: '6001', in: 0, out: 4 }, { clipId: '9002-l0', in: 1, out: 3 }] });
      const render = await clips.startRender(project.id);
      await clips._renderChain;
      assert.strictEqual((await clips.getRender(render.id)).status, 'complete');
      const [, args] = runs.find(([command]) => command === 'ffmpeg');
      assert.ok(args.includes(path.join(root, 'masters', '6001.mp4')) && args.includes(path.join(root, 'masters', '9002-l0.mp4')));
      assert.ok(!runs.some(([command]) => command === 'yt-dlp'));
    });

    it('stores nothing new while the disk is short on space', async function () {
      clock += 8 * DAY;
      offered = 1440;
      clips.settings.minFreeBytes = Number.MAX_SAFE_INTEGER;
      try {
        assert.deepStrictEqual(await clips.rescan({ limit: Infinity }), { checked: 0, stored: 0, upgraded: 0 });
      } finally {
        clips.settings.minFreeBytes = 0;
      }
    });

    it('waits for disk space before downloading a clip', async function () {
      const pending = ready('6003', { kind: 'attachment', url: UPLOAD, filename: 'late.mp4', proxy: { status: 'pending', attempts: 0, error: null } });
      await clips.store.set('/clips/6003', pending);
      await clips._append('clips', '6003');
      const max = clips.settings.maxDownloadBytes;
      clips.settings.maxDownloadBytes = Number.MAX_SAFE_INTEGER;
      try {
        assert.strictEqual(await clips.processPending(), 0);
        assert.deepStrictEqual((await clips.getClip('6003')).proxy.attempts, 0, 'no attempt spent');
      } finally {
        clips.settings.maxDownloadBytes = max;
      }
      assert.strictEqual(await clips.processPending(), 1);
      assert.strictEqual((await clips.getClip('6003')).proxy.status, 'ready');
    });
  });

  describe('Clips stream announcements', function () {
    this.timeout(20000);

    const STREAMS = '1300000000000000030';
    const GENERAL = '1300000000000000031';
    const at = (iso) => ({ id: snowflakeAt(Date.parse(iso)), timestamp: iso.replace('Z', '000+00:00') });
    const STREAMCORD = { id: '1224890003667025973', username: 'Streamcord', bot: true };
    const MESSAGES = [
      Object.assign(at('2026-10-18T00:00:00.000Z'), { content: 'https://twitch.tv/ghost is live', author: STREAMCORD }),
      Object.assign(at('2026-10-20T01:05:00.000Z'), {
        content: '<@&1224891530313994365> **Neorion** is live!',
        author: STREAMCORD,
        embeds: [{ type: 'rich', url: 'https://www.twitch.tv/neorion', title: 'Night ops with the G00Ns', author: { name: 'Neorion', url: 'https://www.twitch.tv/neorion' } }]
      }),
      Object.assign(at('2026-10-20T02:00:00.000Z'), { content: 'catch the VOD https://www.twitch.tv/videos/555', author: { id: '7003', username: 'kersa' } }),
      Object.assign(at('2026-10-20T03:00:00.000Z'), { content: 'still going https://twitch.tv/neorion', author: STREAMCORD }),
      Object.assign(at('2026-10-20T04:00:00.000Z'), { content: 'lol https://www.twitch.tv/neorion/clip/FunnyClip-abc', author: { id: '7003', username: 'kersa' } }),
      Object.assign(at('2026-10-21T11:40:00.000Z'), {
        content: '**Neorion** is live!',
        author: STREAMCORD,
        embeds: [{ type: 'rich', url: 'https://www.twitch.tv/neorion', title: 'Mining', author: { name: 'Neorion' } }]
      })
    ];
    const ARCHIVES = (id) => `https://www.twitch.tv/${id}/videos?filter=archives&sort=time`;
    const row = (id, start, seconds, extra) => JSON.stringify(Object.assign({
      id: `v${id}`, timestamp: Date.parse(start) / 1000, duration: seconds, is_live: false, uploader: 'Neorion', uploader_id: 'neorion', title: 'Night ops with the G00Ns'
    }, extra));
    let root;
    let clips;
    let clock;
    let runs;
    let calls;
    let liveNow;

    async function fakeRun (command, args) {
      runs.push([command, args]);
      const last = args[args.length - 1];
      if (/^--?version$/.test(args[0])) return { code: 0, stderr: '', stdout: `${command} 1.0\n` };
      if (command === 'yt-dlp' && args.includes('--print')) {
        if (last === ARCHIVES('neorion')) {
          return { code: 0, stderr: '', stdout: [
            row(999, '2026-10-21T11:38:00Z', liveNow ? 1320 : 7200, { is_live: liveNow, title: 'Mining' }),
            row(888, '2026-10-20T01:02:00Z', 10800),
            row(777, '2026-10-18T20:00:00Z', 7200, { title: 'Bounties' })
          ].join('\n') + '\n' };
        }
        if (last === 'https://www.twitch.tv/videos/555') return { code: 0, stderr: '', stdout: row(555, '2026-10-19T22:00:00Z', 3600, { uploader: 'Kersa', uploader_id: 'kersa', title: 'Hauling' }) + '\n' };
        // A missing channel: yt-dlp prints nothing and fails.
        return { code: 1, stderr: 'ERROR: [twitch:videos] ghost: Channel does not exist', stdout: '' };
      }
      if (command === 'yt-dlp') {
        const out = args[args.indexOf('-o') + 1];
        fs.writeFileSync(out, `VOD ${last}`);
        fs.writeFileSync(out.replace(/\.mp4$/, '.info.json'), JSON.stringify({ timestamp: Date.parse('2026-10-20T01:02:00Z') / 1000, was_live: true }));
        return { code: 0, stdout: '', stderr: '' };
      }
      if (command === 'ffprobe') {
        const seconds = /videos\/555/.test(fs.readFileSync(last, 'utf8')) ? 3600 : 10800;
        return { code: 0, stderr: '', stdout: JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264', width: 1280, height: 720 }, { codec_type: 'audio' }], format: { duration: String(seconds) } }) };
      }
      fs.writeFileSync(last, 'FAKE');
      return { code: 0, stdout: '', stderr: '' };
    }

    function fetchStub (url) {
      calls.push(url);
      const api = url.slice('https://discord.com/api/v10'.length);
      const ok = (json) => Promise.resolve(response(200, json));
      if (api.startsWith('/users/@me/guilds')) return ok([{ id: GUILD, name: 'G00N SQUAD' }]);
      if (api === `/guilds/${GUILD}/channels`) {
        return ok([{ id: STREAMS, type: 0, name: '📺│streams' }, { id: GENERAL, type: 0, name: 'general' }]);
      }
      if (api === `/guilds/${GUILD}/threads/active`) return ok({ threads: [] });
      if (api.startsWith(`/channels/${STREAMS}/threads/archived/public?`)) return ok({ threads: [], has_more: false });
      if (api.startsWith(`/channels/${STREAMS}/messages?after=`)) return ok(MESSAGES);
      if (api.startsWith(`/guilds/${GUILD}/members/`)) return ok({ nick: 'Kersa', user: { id: '7003', username: 'kersa' } });
      return Promise.resolve(response(404, { message: 'Unknown' }));
    }

    const ytdlpLists = () => runs.filter(([command, args]) => command === 'yt-dlp' && args.includes('--print')).map(([, args]) => args[args.length - 1]);

    before(async function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-clips-streams-'));
      clock = Date.parse('2026-10-21T12:00:00Z');
      runs = [];
      calls = [];
      liveNow = true;
      clips = new Clips({
        path: root,
        discord: {},
        refreshOnStart: false,
        poll: false,
        backfillDays: 0,
        minFreeBytes: 0,
        streams: { maxDownloadBytes: 1024 },
        fetch: fetchStub,
        run: fakeRun,
        now: () => clock,
        resolveToken: () => ({ token: 'test-token', source: 'test' })
      });
      await clips.start();
    });

    after(async function () {
      if (clips) await clips.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('reads #streams for go-live announcements, not other channels', async function () {
      const status = await clips.refresh();
      assert.strictEqual(status.channels, 1);
      assert.strictEqual(status.added, 1, 'the Twitch clip link is a clip; the announcements are not');
      assert.ok(!calls.some((c) => c.includes(`/channels/${GENERAL}/`)));
      const announcements = await Promise.all((await clips._list('streams')).map((id) => clips.store.get(`/streams/${id}`)));
      assert.deepStrictEqual(announcements.map((a) => [a.login, a.vodId]), [
        ['ghost', null], ['neorion', null], [null, '555'], ['neorion', null], ['neorion', null]
      ]);
      assert.strictEqual(announcements[1].streamer, 'Neorion');
      await clips._processing;
    });

    it('collects each finished broadcast once, dated by when it went live, by the streamer', async function () {
      assert.deepStrictEqual(ytdlpLists().sort(), [ARCHIVES('ghost'), ARCHIVES('neorion'), 'https://www.twitch.tv/videos/555'].sort(), 'each channel listed once');
      const vod = await clips.getClip('twitch-v888');
      assert.deepStrictEqual([vod.author, vod.caption, vod.channelName, vod.postedAt], ['Neorion', 'Night ops with the G00Ns', '📺│streams', MESSAGES[1].timestamp]);
      assert.deepStrictEqual(vod.stream, { platform: 'twitch', channel: 'neorion', vodId: '888', announcement: `${MESSAGES[1].id}-neorion` });
      assert.deepStrictEqual([vod.recording.recordedAt, vod.recording.source, vod.recording.confidence], ['2026-10-20T01:02:00.000Z', 'broadcast', 'high']);
      assert.strictEqual(vod.uploadedAt, null, 'a VOD\'s host time is its start, not an upload');
      assert.deepStrictEqual([vod.proxy.status, vod.durationMs, vod.master.height], ['ready', 10800000, 720]);
      const download = runs.find(([command, args]) => command === 'yt-dlp' && args.includes('-o') && args.includes('https://www.twitch.tv/videos/888'))[1];
      assert.strictEqual(download[download.indexOf('-f') + 1], 'b[height<=720]/bv*[height<=720]+ba/b');
      assert.strictEqual(download[download.indexOf('--max-filesize') + 1], '1024');

      const direct = await clips.getClip('twitch-v555');
      assert.deepStrictEqual([direct.author, direct.recording.recordedAt, direct.recording.source], ['Kersa', '2026-10-19T22:00:00.000Z', 'broadcast']);
      assert.strictEqual(await clips.getClip('twitch-v999'), null, 'still live');
      assert.strictEqual(await clips.getClip('twitch-v777'), null, 'never announced');

      const byId = new Map();
      for (const id of await clips._list('streams')) byId.set(id, await clips.store.get(`/streams/${id}`));
      const status = (message, login) => byId.get(`${message.id}-${login}`);
      assert.deepStrictEqual([status(MESSAGES[1], 'neorion').status, status(MESSAGES[3], 'neorion').status], ['collected', 'collected']);
      assert.strictEqual(status(MESSAGES[3], 'neorion').clipId, 'twitch-v888', 'a re-announcement is the same broadcast');
      assert.deepStrictEqual([status(MESSAGES[5], 'neorion').status, status(MESSAGES[5], 'neorion').vodId], ['waiting', '999']);
      assert.deepStrictEqual([status(MESSAGES[0], 'ghost').status, status(MESSAGES[0], 'ghost').error], ['waiting', 'yt-dlp exited 1: ERROR: [twitch:videos] ghost: Channel does not exist']);

      const pub = clips.publicClip(vod);
      assert.deepStrictEqual(pub.stream, { platform: 'twitch', channel: 'neorion', url: 'https://www.twitch.tv/neorion' });
      assert.strictEqual(pub.linkUrl, 'https://www.twitch.tv/videos/888');
      const session = (await clips.sessions()).find((s) => s.clips.some((c) => c.id === 'twitch-v888'));
      assert.ok(session.tracks.some((track) => track.author === 'Neorion'));
      const list = await clips.list();
      assert.deepStrictEqual([list.status.vods, list.status.streams], [2, { waiting: 2, collected: 3, none: 0, missed: 0 }]);
    });

    it('checks again only after checkEveryMs, and collects a broadcast once it is over', async function () {
      runs = [];
      assert.strictEqual((await clips.collectStreams()).checked, 0);
      assert.deepStrictEqual(ytdlpLists(), []);
      clock = Date.parse('2026-10-21T14:30:00Z');
      liveNow = false;
      const result = await clips.collectStreams();
      assert.deepStrictEqual([result.collected, result.none], [1, 0]);
      const vod = await clips.getClip('twitch-v999');
      assert.deepStrictEqual([vod.caption, vod.durationMs, vod.recording.recordedAt, vod.proxy.status], ['Mining', 7200000, '2026-10-21T11:38:00.000Z', 'pending']);
    });

    it('gives up on announcements with no VOD, and on old ones', async function () {
      const ghost = `${MESSAGES[0].id}-ghost`;
      clips.settings.run = async (command, args) => (command === 'yt-dlp' && args.includes('--print') ? { code: 0, stdout: '', stderr: '' } : fakeRun(command, args));
      try {
        clock += 60 * 60 * 1000;
        assert.strictEqual((await clips.collectStreams()).none, 1, 'listed, and nothing fits');
        assert.strictEqual((await clips.store.get(`/streams/${ghost}`)).status, 'none');
        await clips.store.set('/streams/old', { id: 'old', login: 'neorion', announcedAt: '2026-08-01T00:00:00.000Z', status: 'waiting' });
        await clips._append('streams', 'old');
        assert.strictEqual((await clips.collectStreams()).missed, 1);
        assert.strictEqual((await clips.store.get('/streams/old')).status, 'missed');
      } finally {
        clips.settings.run = fakeRun;
      }
    });

    it('waits for disk space before downloading a VOD', async function () {
      clips.settings.streams.maxDownloadBytes = Number.MAX_SAFE_INTEGER;
      try {
        assert.strictEqual(await clips.processPending(), 0);
        assert.strictEqual((await clips.getClip('twitch-v999')).proxy.attempts, 0, 'no attempt spent');
      } finally {
        clips.settings.streams.maxDownloadBytes = 1024;
      }
      assert.strictEqual(await clips.processPending(), 1);
      assert.strictEqual((await clips.getClip('twitch-v999')).proxy.status, 'ready');
    });

    it('never rescans a stored VOD, and keeps its date on restart', async function () {
      runs = [];
      clock += 8 * 24 * 60 * 60 * 1000;
      const result = await clips.rescan({ limit: Infinity });
      assert.strictEqual(result.upgraded, 0);
      assert.ok(!runs.some(([command, args]) => command === 'yt-dlp' && /videos\/\d+$/.test(args[args.length - 1])), 'Twitch not asked again');
      assert.strictEqual(await clips.redate(), 0);
    });

    it('keeps VODs as links when downloads are off', async function () {
      clips.settings.streams.download = false;
      try {
        const id = await clips._addVod(
          { id: 'x', login: 'neorion', guildId: GUILD, channelId: STREAMS, channelName: 'streams', messageId: '1', messageUrl: 'u', announcedAt: '2026-10-22T00:05:00.000Z' },
          { id: '1234', startedAt: '2026-10-22T00:00:00.000Z', startMs: Date.parse('2026-10-22T00:00:00Z'), durationMs: 3600000, streamer: 'Neorion', channel: 'neorion', title: 'Late' }
        );
        assert.strictEqual((await clips.getClip(id)).proxy.status, 'skipped');
        assert.strictEqual(await clips.queueLinks(), 0);
        const pub = clips.publicClip(await clips.getClip(id));
        assert.deepStrictEqual([pub.durationMs, pub.recordedAt, pub.proxyUrl], [3600000, '2026-10-22T00:00:00.000Z', null], 'on the timeline at its real length');
      } finally {
        clips.settings.streams.download = true;
      }
    });
  });

  describe('Clips reclaim', function () {
    this.timeout(20000);
    let root;
    let clips;
    let logs;

    beforeEach(async function () {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'goonvc-clips-reclaim-'));
      logs = [];
      clips = new Clips({
        path: root,
        discord: {},
        poll: false,
        refreshOnStart: false,
        minFreeBytes: 0,
        log: (message) => logs.push(message),
        now: () => Date.parse('2026-11-09T12:00:00Z')
      });
      await clips.start();
    });

    afterEach(async function () {
      await clips.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('defaults minFreeRatio to 0 so a shared volume does not force master deletion', function () {
      assert.strictEqual(clips.settings.minFreeRatio, 0);
      assert.strictEqual(clips._freeTarget({ total: 2 * 1024 ** 4, free: 100 * 1024 ** 3 }), 0);
      clips.settings.minFreeBytes = 20 * 1024 ** 3;
      assert.strictEqual(clips._freeTarget({ total: 2 * 1024 ** 4, free: 100 * 1024 ** 3 }), 20 * 1024 ** 3);
    });

    it('keeps completed renders younger than renderKeepMs', async function () {
      const young = 'r-young';
      const old = 'r-old';
      for (const [id, at] of [[young, '2026-11-09T11:00:00.000Z'], [old, '2026-10-01T00:00:00.000Z']]) {
        fs.writeFileSync(path.join(clips.dirs.renders, `${id}.mp4`), id);
        await clips.store.set(`/renders/${id}`, { id, status: 'complete', completedAt: at });
        await clips._append('renders', id);
      }
      const dropped = await clips._dropOldRenders(1e9);
      assert.strictEqual(dropped.count, 1);
      assert.ok(fs.existsSync(path.join(clips.dirs.renders, `${young}.mp4`)));
      assert.ok(!fs.existsSync(path.join(clips.dirs.renders, `${old}.mp4`)));
    });

    it('logs the planned reclaim before deleting files', async function () {
      fs.writeFileSync(path.join(clips.dirs.masters, 'x.bin'), Buffer.alloc(100));
      clips.settings.maxBytes = 1;
      logs.length = 0;
      await clips.reclaim();
      assert.ok(logs.some((line) => /reclaiming/.test(line)));
    });
  });
});
