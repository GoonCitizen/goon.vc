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
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return Object.assign({
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => raw,
    arrayBuffer: async () => Buffer.from(raw)
  }, extra);
}

describe('clips', function () {
  describe('extractClips', function () {
    it('finds video attachments, direct video embeds, and clip-host links', function () {
      const clips = extractClips({
        id: '900',
        content: 'two angles https://medal.tv/games/star-citizen/clips/abc?invite=x and https://youtu.be/xyz.',
        attachments: [
          { id: '901', filename: 'Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4', content_type: 'video/mp4', size: 1000, width: 1920, height: 1080, url: `${CDN}/1/901/a.mp4?ex=1` },
          { id: '902', filename: 'screenshot.png', content_type: 'image/png', url: `${CDN}/1/902/b.png` },
          { id: '903', filename: 'obs.mkv', url: `${CDN}/1/903/obs.mkv` }
        ],
        embeds: [
          { type: 'video', video: { url: `${CDN}/1/904/c.webm`, width: 1280, height: 720 } },
          { type: 'video', provider: { name: 'YouTube' }, video: { url: 'https://www.youtube.com/embed/xyz' } }
        ]
      });
      assert.deepStrictEqual(clips.map((c) => [c.id, c.kind, c.filename]), [
        ['901', 'attachment', 'Star Citizen 2026.10.19 - 21.33.12.02.DVR.mp4'],
        ['903', 'attachment', 'obs.mkv'],
        ['900-e0', 'embed', 'c.webm'],
        ['900-l0', 'link', null],
        ['900-l1', 'link', null]
      ]);
      assert.strictEqual(clips[3].url, 'https://medal.tv/games/star-citizen/clips/abc?invite=x');
      assert.strictEqual(clips[4].url, 'https://youtu.be/xyz');
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
      assert.deepStrictEqual([clip.recording.recordedAt, clip.recording.source, clip.recording.confidence, clip.recording.offsetMinutes], ['2026-10-20T02:33:12.000Z', 'metadata', 'high', -300]);
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

    it('records manual recording times and sync nudges', async function () {
      const res = await request('PATCH', '/services/clips/5001', { body: { syncOffsetMs: 1500 } });
      assert.strictEqual(res.status, 200, res.raw);
      assert.strictEqual(res.json.recordedAt, '2026-10-20T02:33:13.500Z');
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
      assert.strictEqual(sources.json.segments[0].recordedFrom, '2026-10-20T02:33:14.000Z');
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
      clips = new Clips({
        path: root,
        discord: {},
        poll: false,
        fetch: () => Promise.resolve(response(404, {})),
        run: async () => {
          if (!installed) throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
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
      if (command === 'yt-dlp' && args.includes('-J')) return { code: 0, stderr: '', stdout: JSON.stringify({ height: offered, requested_formats: [{ height: offered }, { height: null }] }) };
      if (command === 'yt-dlp') {
        fs.writeFileSync(args[args.indexOf('-o') + 1], `LINK-${offered}`);
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
      assert.deepStrictEqual(clips.publicClip(link).master, { width: 1280, height: 720 });
      assert.ok(!JSON.stringify(clips.publicClip(link)).includes(root), 'no server paths');
    });

    it('leaves stored uploads alone and rechecks links only after recheckAfterMs', async function () {
      runs = [];
      assert.deepStrictEqual(await clips.rescan({ limit: Infinity }), { checked: 0, stored: 0, upgraded: 0 });
      clock += 8 * DAY;
      assert.deepStrictEqual(await clips.rescan({ limit: Infinity }), { checked: 1, stored: 0, upgraded: 0 });
      assert.deepStrictEqual(runs.map(([command, args]) => `${command} ${args.includes('-J') ? '-J' : 'download'}`), ['yt-dlp -J'], 'asks without downloading');
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
  });
});
