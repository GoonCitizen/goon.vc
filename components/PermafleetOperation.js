'use strict';

const escapeHtml = require('../functions/escapeHtml');

// Copy from the public RSI org page (robertsspaceindustries.com/orgs/PERMAFLEET)
// and its cover image. Trusted HTML.
const PILLARS = Object.freeze([
  {
    title: 'Learn to Play',
    body: 'Our experienced guides will help you learn the game, showing you tips and tricks to help you get ahead in the ’verse. Join up with other like-minded players and accomplish more than you ever could alone!'
  },
  {
    title: '24/7 Fleets',
    body: 'With members from all across the globe, PERMAFLEET maintains 24/7 security for its members. Our well-trained responders will make the best of any situation you encounter as a member.'
  },
  {
    title: 'Alliance Security',
    body: 'Membership in PERMAFLEET grants you protection by our partner orgs, including the infamous <span class="op-goon">GOON SQUAD</span>. Explore the ’verse with safety &amp; security by playing the game under our vigilant watch.'
  },
  {
    title: 'Industry &amp; Logistics',
    body: 'With dedicated industry and logistics, PERMAFLEET keeps its members supplied with the highest-quality goods and materials. Help with fleet orders by mining, salvaging, and more. Steady workload!'
  },
  {
    title: 'Weekly Events',
    body: 'Join us on weekly adventures during our scheduled events, from <strong>Boxing Night on the 890</strong> to <strong>spicy PvP fighter training</strong>.'
  }
]);

const CHARTER = 'The PERMAFLEET Protectorate consists of member organizations participating in an alliance, each expected to contribute resources towards the collective good. Cross-organization squadrons such as <strong>BRAVO SQUADRON</strong> and <strong>RAT SQUADRON</strong> each focus on a specific type of gameplay.';

const MEMBER_ORGS = Object.freeze([
  'G00N SQUAD',
  'Infinity Industries',
  'Legacy Corporation',
  'Trans-Galactic Trade',
  'DoubleDog Delivery, Inc.',
  '4M Contractors',
  'A.I.M.O.S.'
]);

function renderPermafleetCss (props) {
  const heroImage = props.heroImage;
  return `
      body.op-active { margin: 0; background: #050A18; }
      .op-page {
        --op-void: #050A18;
        --op-navy: #0A1228;
        --op-text: #E8F4FF;
        --op-muted: #8AA4B8;
        --op-accent: #8EBFD0;
        --op-line: rgba(142, 191, 208, 0.45);
        --op-cyan: #00D4FF;
        --op-cyan-soft: #7FE9FF;
        --op-signal: #78ECFF;
        --op-glass: rgba(5, 12, 28, 0.72);
        display: none;
        color: var(--op-text);
        font-family: "Rajdhani", sans-serif;
        font-weight: 500;
        -webkit-font-smoothing: antialiased;
      }
      .op-page *, .op-page *::before, .op-page *::after { box-sizing: border-box; }
      .op-page a { color: var(--op-accent); text-decoration: none; }
      .op-page a:hover { color: #fff; }
      .op-shell {
        position: relative;
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }
      .op-hero-bg {
        position: fixed;
        inset: 0;
        z-index: 0;
        background: var(--op-void) center/cover no-repeat;
        background-image: url(${JSON.stringify(heroImage)});
        transform: scale(1.06);
        animation: op-kenburns 28s ease-in-out infinite alternate;
      }
      .op-hero-scrim {
        position: fixed;
        inset: 0;
        z-index: 1;
        pointer-events: none;
        background:
          radial-gradient(ellipse 60% 55% at 50% 42%, rgba(5, 10, 24, 0.2) 0%, rgba(5, 10, 24, 0.62) 62%, rgba(5, 10, 24, 0.88) 100%),
          linear-gradient(180deg, rgba(5, 10, 24, 0.45) 0%, transparent 30%, transparent 68%, rgba(5, 10, 24, 0.82) 100%);
      }
      .op-particles {
        position: fixed;
        inset: 0;
        z-index: 2;
        width: 100%;
        height: 100%;
        pointer-events: none;
      }
      .op-nav {
        position: relative;
        z-index: 3;
        padding: 1rem 1.25rem 0;
        font-size: 0.9rem;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        text-align: center;
      }
      .op-content {
        position: relative;
        z-index: 3;
        flex: 1;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        padding: 2.5rem 1.25rem 1.5rem;
        text-align: center;
      }
      .op-brand {
        margin: 0;
        font-family: "Bungee", sans-serif;
        font-weight: 400;
        font-size: clamp(2.4rem, 7vw, 4.2rem);
        letter-spacing: 0.04em;
        line-height: 1.05;
        color: #fff;
        text-shadow: 0 0 24px rgba(142, 191, 208, 0.28), 0 2px 18px rgba(0, 0, 0, 0.65);
      }
      .op-brand sup { font-size: 0.35em; vertical-align: super; opacity: 0.7; }
      .op-tagline {
        margin: 0.85rem 0 0;
        max-width: 34rem;
        padding: 0 0.5rem;
        font-size: clamp(0.95rem, 2.4vw, 1.25rem);
        font-weight: 500;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: var(--op-muted);
        line-height: 1.35;
      }
      .op-panel {
        position: relative;
        margin-top: 1.75rem;
        width: min(100%, 26rem);
        padding: 1.35rem 1.1rem 1.5rem;
        background: var(--op-glass);
        border: 1px solid rgba(142, 191, 208, 0.28);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        box-shadow: 0 0 40px rgba(142, 191, 208, 0.06), inset 0 0 0 1px rgba(255, 255, 255, 0.03);
        text-align: center;
      }
      .op-panel::before, .op-panel::after, .op-panel-corners span {
        content: "";
        position: absolute;
        width: 14px;
        height: 14px;
        border-color: var(--op-accent);
        border-style: solid;
        pointer-events: none;
      }
      .op-panel::before { top: -1px; left: -1px; border-width: 2px 0 0 2px; }
      .op-panel::after { bottom: -1px; right: -1px; border-width: 0 2px 2px 0; }
      .op-panel-corners { position: absolute; inset: 0; pointer-events: none; }
      .op-panel-corners span:nth-child(1) { top: -1px; right: -1px; border-width: 2px 2px 0 0; }
      .op-panel-corners span:nth-child(2) { bottom: -1px; left: -1px; border-width: 0 0 2px 2px; }
      .op-panel-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.75rem;
        margin-bottom: 0.65rem;
        padding: 0 0.15rem;
      }
      .op-chip { font-size: 0.95rem; font-weight: 700; letter-spacing: 0.18em; color: var(--op-signal); }
      .op-voice-count {
        font-size: 0.95rem;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--op-text);
      }
      .op-voice-count strong { color: var(--op-signal); font-weight: 700; }
      .op-hairline {
        height: 1px;
        margin: 0 0 0.55rem;
        background: linear-gradient(90deg, transparent, var(--op-line), transparent);
        border: 0;
      }
      .op-voice-list {
        list-style: none;
        margin: 0 0 0.75rem;
        padding: 0;
        max-height: 16rem;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        align-items: center;
      }
      .op-voice-row {
        display: grid;
        grid-template-columns: 2rem minmax(0, 1fr);
        align-items: center;
        column-gap: 0.65rem;
        width: 15.5rem;
        max-width: 100%;
        margin: 0 auto;
        padding: 0.35rem 0.45rem;
        border-radius: 4px;
        text-align: left;
      }
      .op-voice-row:hover { background: rgba(255, 255, 255, 0.06); }
      .op-voice-row .op-avatar {
        width: 2rem;
        height: 2rem;
        border-radius: 50%;
        border: 1px solid rgba(142, 191, 208, 0.35);
        overflow: hidden;
        background: var(--op-navy);
      }
      .op-voice-row .op-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .op-voice-row .op-name {
        min-width: 0;
        max-width: 12rem;
        font-size: 0.98rem;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: #dcddde;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .op-empty { margin: 0.5rem 0 0.85rem; font-size: 0.95rem; letter-spacing: 0.04em; color: var(--op-muted); }
      .op-server-online {
        margin: 0.85rem 0 0;
        font-size: 0.8rem;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: rgba(138, 164, 184, 0.75);
      }
      .op-panel-cta { margin-top: 0.25rem; }
      .op-resource-link {
        margin: 1rem 0 0;
        font-size: 0.95rem;
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .op-resource-link a { border-bottom: 1px solid var(--op-line); padding-bottom: 0.1rem; }
      .op-resource-link a:hover { border-bottom-color: #fff; }
      .op-page a.op-cta {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 12rem;
        padding: 0.85rem 1.6rem;
        font-family: "Rajdhani", sans-serif;
        font-size: 1.15rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--op-void);
        background: linear-gradient(180deg, var(--op-cyan-soft) 0%, var(--op-cyan) 100%);
        border: 1px solid rgba(255, 255, 255, 0.25);
        box-shadow: 0 0 28px rgba(0, 212, 255, 0.4), 0 0 56px rgba(0, 212, 255, 0.22), 0 0 80px rgba(0, 212, 255, 0.12);
        transition: transform 0.2s ease, box-shadow 0.2s ease, filter 0.2s ease;
        animation: op-cta-pulse 2.8s ease-in-out infinite;
      }
      .op-page a.op-cta:hover {
        transform: translateY(-1px);
        filter: brightness(1.08);
        box-shadow: 0 0 36px rgba(0, 212, 255, 0.5), 0 0 70px rgba(0, 212, 255, 0.28), 0 0 100px rgba(0, 212, 255, 0.16);
        color: var(--op-void);
      }
      .op-eyebrow {
        margin: 0 0 0.6rem;
        font-size: 0.85rem;
        font-weight: 700;
        letter-spacing: 0.32em;
        text-transform: uppercase;
        color: var(--op-signal);
      }
      .op-intro {
        margin: 0.65rem 0 0;
        max-width: 34rem;
        padding: 0 0.5rem;
        font-size: 1.05rem;
        line-height: 1.45;
        color: var(--op-text);
      }
      .op-hotline {
        margin: 0.75rem 0 0;
        font-size: 0.9rem;
        letter-spacing: 0.04em;
        color: var(--op-muted);
      }
      .op-hotline strong { color: var(--op-signal); letter-spacing: 0.14em; text-transform: uppercase; }
      .op-pillars {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
        gap: 1rem;
        width: min(100%, 62rem);
        margin-top: 2.5rem;
        text-align: left;
      }
      .op-pillar, .op-charter {
        padding: 1.1rem 1.15rem 1.2rem;
        background: var(--op-glass);
        border: 1px solid rgba(142, 191, 208, 0.22);
        border-left: 3px solid var(--op-accent);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
      }
      .op-pillar h2, .op-charter h2 {
        margin: 0 0 0.5rem;
        font-family: "Bungee", sans-serif;
        font-weight: 400;
        font-size: 1.15rem;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #fff;
      }
      .op-pillar p, .op-charter p {
        margin: 0;
        font-size: 1rem;
        line-height: 1.45;
        color: var(--op-muted);
      }
      .op-pillar strong, .op-charter strong { color: var(--op-text); }
      .op-goon { color: #ff3b3b; font-weight: 700; }
      .op-charter {
        width: min(100%, 62rem);
        margin-top: 1rem;
        text-align: left;
      }
      .op-orgs {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        list-style: none;
        margin: 0.9rem 0 0;
        padding: 0;
      }
      .op-orgs li {
        padding: 0.25rem 0.6rem;
        border: 1px solid rgba(142, 191, 208, 0.35);
        font-size: 0.85rem;
        font-weight: 700;
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--op-text);
      }
      .op-orgs a { color: inherit; text-decoration: none; }
      .op-orgs a:hover { color: var(--op-signal); }
      .op-charter .op-resource-link { margin-top: 1rem; }
      .op-charter .op-laws { margin-top: 0.9rem; font-style: italic; }
      .op-footer {
        position: relative;
        z-index: 3;
        padding: 1rem 1.25rem 1.4rem;
        text-align: center;
        color: rgba(138, 164, 184, 0.65);
        font-size: 0.8rem;
        letter-spacing: 0.04em;
      }
      .op-footer code {
        display: inline-block;
        margin-bottom: 0.35rem;
        font-size: 0.72rem;
        word-break: break-all;
        color: rgba(138, 164, 184, 0.55);
      }
      @keyframes op-kenburns {
        from { transform: scale(1.04); }
        to { transform: scale(1.1); }
      }
      @keyframes op-cta-pulse {
        0%, 100% { box-shadow: 0 0 24px rgba(0, 212, 255, 0.35), 0 0 48px rgba(0, 212, 255, 0.18), 0 0 72px rgba(0, 212, 255, 0.1); }
        50% { box-shadow: 0 0 36px rgba(0, 212, 255, 0.5), 0 0 72px rgba(0, 212, 255, 0.28), 0 0 110px rgba(0, 212, 255, 0.16); }
      }
      @media (max-width: 480px) {
        .op-content { padding-top: 2rem; }
        .op-tagline { letter-spacing: 0.03em; max-width: 20rem; }
        .op-panel { padding: 1.15rem 0.85rem 1.25rem; }
        .op-voice-list { max-height: 14rem; }
      }
      @media (prefers-reduced-motion: reduce) {
        .op-hero-bg { animation: none; transform: scale(1.04); }
        .op-page a.op-cta { animation: none; }
      }`;
}

function renderPermafleetMainHtml (opts) {
  return `<main id="operation-permafleet" class="op-page">
      <div class="op-shell">
        <div class="op-hero-bg" aria-hidden="true"></div>
        <div class="op-hero-scrim" aria-hidden="true"></div>
        <canvas id="permafleet-particles" class="op-particles" aria-hidden="true"></canvas>
        <nav class="op-nav"><a href="/">&larr; Home</a> · <a href="${escapeHtml(opts.organizationsPath || '/organizations')}">Organizations</a></nav>
        <div class="op-content">
          <p class="op-eyebrow">The PERMAFLEET Protectorate</p>
          <h1 class="op-brand">${opts.heading}</h1>
          <p class="op-tagline">${opts.tagline}</p>
          <p class="op-intro">${opts.intro}</p>
          <section class="op-panel" aria-labelledby="permafleet-label">
            <div class="op-panel-corners" aria-hidden="true"><span></span><span></span></div>
            <div class="op-panel-head">
              <span class="op-chip" id="permafleet-label">PERMAFLEET</span>
              <span class="op-voice-count"><strong id="permafleet-voice-n">—</strong> in voice</span>
            </div>
            <hr class="op-hairline" />
            <ul class="op-voice-list" id="permafleet-voice-list" aria-live="polite"></ul>
            <p class="op-empty" id="permafleet-empty" hidden>Voice is clear — jump in</p>
            <div class="op-panel-cta">
              <a class="op-cta" id="permafleet-join" href="${escapeHtml(opts.inviteUrl)}" target="_blank" rel="noopener noreferrer">Join Permafleet</a>
            </div>
            <p class="op-server-online" id="permafleet-online"></p>
          </section>
          <p class="op-resource-link"><a href="${escapeHtml(opts.schedulePath)}">Weekly ops schedule &raquo;</a></p>
          <p class="op-hotline"><strong>Hotline:</strong> #embassy chat on the <a href="${escapeHtml(opts.hotlineUrl)}" target="_blank" rel="noopener noreferrer">GOON SQUAD Discord &raquo;</a></p>
          <section class="op-pillars" aria-label="What PERMAFLEET offers">
${PILLARS.map((p) => `            <article class="op-pillar"><h2>${p.title}</h2><p>${p.body}</p></article>`).join('\n')}
          </section>
          <section class="op-charter" aria-labelledby="permafleet-charter">
            <h2 id="permafleet-charter">Charter</h2>
            <p>${CHARTER}</p>
            <ul class="op-orgs">${(opts.memberOrgs || MEMBER_ORGS.map((name) => ({ name }))).map((org) => `<li>${org.href ? `<a href="${escapeHtml(org.href)}">${escapeHtml(org.name)}</a>` : escapeHtml(org.name)}</li>`).join('')}</ul>
            ${opts.organizationsPath ? `<p class="op-resource-link"><a href="${escapeHtml(opts.organizationsPath)}">Member organizations &raquo;</a></p>` : ''}
            <p class="op-laws">Members shall enjoy their freedoms.</p>
          </section>
        </div>
        <footer class="op-footer">
          <div><code>${opts.bitcoinAddress}</code></div>
          <div><small>${opts.copyright}</small></div>
        </footer>
      </div>
    </main>`;
}

/**
 * Live voice roster (Discord guild widget) + quantum-travel particle canvas.
 * Only started when the PERMAFLEET operation page is the active route.
 */
function renderPermafleetScript (opts) {
  return `<script type="text/javascript">
      (function () {
        var page = document.getElementById('operation-permafleet');
        if (!page || page.style.display === 'none' || !page.style.display) return;

        var GUILD_ID = ${JSON.stringify(String(opts.guildId))};
        var PERMAFLEET_ID = ${JSON.stringify(String(opts.channelId))};
        var PERMAFLEET_NAME = ${JSON.stringify(String(opts.channelName).toLowerCase())};
        var FALLBACK_INVITE = ${JSON.stringify(opts.inviteUrl)};
        var MAX_ROWS = 24;

        var voiceN = document.getElementById('permafleet-voice-n');
        var listEl = document.getElementById('permafleet-voice-list');
        var emptyEl = document.getElementById('permafleet-empty');
        var serverEl = document.getElementById('permafleet-online');
        var ctaEl = document.getElementById('permafleet-join');

        function resolveChannelId (channels) {
          if (!channels || !channels.length) return PERMAFLEET_ID;
          for (var i = 0; i < channels.length; i++) {
            if ((channels[i].name || '').toLowerCase() === PERMAFLEET_NAME) return String(channels[i].id);
          }
          return PERMAFLEET_ID;
        }

        function renderPanel (data) {
          var channelId = resolveChannelId(data.channels);
          var members = (data.members || []).filter(function (m) {
            return m.channel_id != null && String(m.channel_id) === channelId;
          });
          voiceN.textContent = String(members.length);
          listEl.innerHTML = '';
          emptyEl.hidden = members.length > 0;
          members.slice(0, MAX_ROWS).forEach(function (m) {
            var li = document.createElement('li');
            li.className = 'op-voice-row';
            var av = document.createElement('div');
            av.className = 'op-avatar';
            var img = document.createElement('img');
            img.src = m.avatar_url || '';
            img.alt = '';
            img.loading = 'lazy';
            av.appendChild(img);
            var name = document.createElement('span');
            name.className = 'op-name';
            name.textContent = m.username || 'Member';
            name.title = m.username || 'Member';
            li.appendChild(av);
            li.appendChild(name);
            listEl.appendChild(li);
          });
          if (typeof data.presence_count === 'number') {
            serverEl.textContent = data.presence_count + ' online on server';
          }
          ctaEl.href = data.instant_invite || FALLBACK_INVITE;
        }

        function renderFallback () {
          voiceN.textContent = '0';
          listEl.innerHTML = '';
          emptyEl.hidden = false;
          serverEl.textContent = '';
          ctaEl.href = FALLBACK_INVITE;
        }

        window.fetch('https://discord.com/api/guilds/' + GUILD_ID + '/widget.json')
          .then(function (res) {
            if (!res.ok) throw new Error('widget ' + res.status);
            return res.json();
          })
          .then(renderPanel)
          .catch(renderFallback);

        // QT particles: pause -> dive wave -> peel off -> pause
        var canvas = document.getElementById('permafleet-particles');
        var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!canvas || reduce || !canvas.getContext) return;

        var ctx = canvas.getContext('2d');
        var particles = [];
        var raf = 0;
        var running = true;
        var pointer = { x: 0, y: 0, ok: false };
        var coarsePointer = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        var phase = 'pause';
        var phaseUntil = 0;
        var target = { x: 0, y: 0 };
        var NEAR_R = 32;
        var DIVE_SPEED = 3.2;

        function isMobileLike () { return coarsePointer || window.innerWidth < 640 || !pointer.ok; }
        function pauseMs () { return 2000 + Math.random() * 2000; }
        function hunterBudget () { return window.innerWidth < 640 ? 6 : 10; }
        function countBudget () { return window.innerWidth < 640 ? 50 : 100; }

        function resize () {
          var dpr = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.floor(window.innerWidth * dpr);
          canvas.height = Math.floor(window.innerHeight * dpr);
          canvas.style.width = window.innerWidth + 'px';
          canvas.style.height = window.innerHeight + 'px';
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }

        function spawn (atEdge) {
          var cx = window.innerWidth * 0.5;
          var cy = window.innerHeight * 0.42;
          var maxR = Math.sqrt(cx * cx + cy * cy) + 80;
          return {
            angle: Math.random() * Math.PI * 2,
            dist: atEdge ? Math.random() * maxR * 0.85 : Math.random() * 40,
            speed: 0.35 + Math.random() * 1.1,
            width: 0.6 + Math.random() * 1.2,
            hue: Math.random() > 0.4 ? 'soft' : 'white',
            hunting: false,
            vx: 0,
            vy: 0
          };
        }

        function pickTarget () {
          var w = window.innerWidth;
          var h = window.innerHeight;
          if (!isMobileLike() && pointer.ok) {
            target.x = pointer.x;
            target.y = pointer.y;
            return;
          }
          var insetX = w * 0.12;
          var insetY = h * 0.15;
          target.x = insetX + Math.random() * (w - insetX * 2);
          target.y = insetY + Math.random() * (h - insetY * 2);
        }

        function startDive () {
          pickTarget();
          var need = hunterBudget();
          var picked = 0;
          var attempts = 0;
          while (picked < need && attempts < particles.length * 3) {
            attempts++;
            var p = particles[Math.floor(Math.random() * particles.length)];
            if (p.hunting) continue;
            p.hunting = true;
            picked++;
          }
          phase = 'dive';
        }

        function huntingCount () {
          var n = 0;
          for (var i = 0; i < particles.length; i++) if (particles[i].hunting) n++;
          return n;
        }

        function init () {
          particles = [];
          var n = countBudget();
          for (var i = 0; i < n; i++) particles.push(spawn(true));
          phase = 'pause';
          phaseUntil = performance.now() + pauseMs();
        }

        function tick (now) {
          if (!running) return;
          if (!now) now = performance.now();
          var w = window.innerWidth;
          var h = window.innerHeight;
          var cx = w * 0.5;
          var cy = h * 0.42;
          var maxR = Math.sqrt(cx * cx + Math.max(cy, h - cy) * Math.max(cy, h - cy)) + 40;

          if (phase === 'pause' && now >= phaseUntil) {
            startDive();
          } else if (phase === 'dive') {
            if (!isMobileLike() && pointer.ok) {
              target.x = pointer.x;
              target.y = pointer.y;
            }
            if (huntingCount() === 0) {
              phase = 'pause';
              phaseUntil = now + pauseMs();
            }
          }

          ctx.clearRect(0, 0, w, h);

          for (var i = 0; i < particles.length; i++) {
            var p = particles[i];
            var x = cx + Math.cos(p.angle) * p.dist;
            var y = cy + Math.sin(p.angle) * p.dist;
            var hunting = p.hunting;
            var trailX = 0;
            var trailY = 0;

            if (hunting) {
              var hx = target.x - x;
              var hy = target.y - y;
              var hdist = Math.sqrt(hx * hx + hy * hy) || 1;
              p.vx = (hx / hdist) * DIVE_SPEED;
              p.vy = (hy / hdist) * DIVE_SPEED;
              x += p.vx;
              y += p.vy;
              p.angle = Math.atan2(y - cy, x - cx);
              p.dist = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
              if (hdist < NEAR_R) {
                p.hunting = false;
                p.vx = 0;
                p.vy = 0;
                hunting = false;
              } else {
                trailX = -p.vx;
                trailY = -p.vy;
              }
            }

            if (!hunting) {
              p.dist += p.speed * (1 + p.dist * 0.012);
              x = cx + Math.cos(p.angle) * p.dist;
              y = cy + Math.sin(p.angle) * p.dist;
              if (p.dist > maxR) {
                particles[i] = spawn(false);
                p = particles[i];
                x = cx + Math.cos(p.angle) * p.dist;
                y = cy + Math.sin(p.angle) * p.dist;
              }
            }

            var len;
            var x2;
            var y2;
            var t = p.dist / maxR;
            var alpha = t < 0.08 ? t / 0.08 * 0.25 : (t > 0.85 ? (1 - t) / 0.15 * 0.45 : 0.18 + (1 - t) * 0.32);
            var lineW = p.width;

            if (hunting) {
              var speed = Math.sqrt(p.vx * p.vx + p.vy * p.vy) || DIVE_SPEED;
              len = 10 + speed * 4;
              x2 = x + (trailX / (speed || 1)) * len;
              y2 = y + (trailY / (speed || 1)) * len;
              alpha = Math.min(0.9, alpha + 0.4);
              lineW = p.width + 1.1;
            } else {
              len = 2 + p.dist * 0.035;
              x2 = cx + Math.cos(p.angle) * Math.max(0, p.dist - len);
              y2 = cy + Math.sin(p.angle) * Math.max(0, p.dist - len);
            }

            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x, y);
            ctx.strokeStyle = hunting
              ? 'rgba(210, 240, 250,' + alpha + ')'
              : (p.hue === 'soft' ? 'rgba(168, 208, 220,' + alpha + ')' : 'rgba(232, 244, 255,' + alpha + ')');
            ctx.lineWidth = lineW;
            ctx.stroke();
          }

          raf = window.requestAnimationFrame(tick);
        }

        function onPointer (e) {
          var point = e.touches && e.touches[0] ? e.touches[0] : e;
          pointer.x = point.clientX;
          pointer.y = point.clientY;
          pointer.ok = true;
        }

        resize();
        init();
        raf = window.requestAnimationFrame(tick);
        window.addEventListener('resize', function () { resize(); init(); });
        window.addEventListener('pointermove', onPointer, { passive: true });
        window.addEventListener('touchstart', onPointer, { passive: true });
        window.addEventListener('touchmove', onPointer, { passive: true });
        document.addEventListener('visibilitychange', function () {
          if (document.hidden) {
            running = false;
            window.cancelAnimationFrame(raf);
          } else {
            running = true;
            raf = window.requestAnimationFrame(tick);
          }
        });
      })();
    </script>`;
}

module.exports = {
  id: 'operation-permafleet',
  styles: renderPermafleetCss,
  render: renderPermafleetMainHtml,
  script: renderPermafleetScript
};
