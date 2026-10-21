'use strict';

/**
 * <melee-rotation-drill> — self-contained PERMAFLEET flight-training drill.
 *
 * Three ships fly a chase chain: the evader runs, the attacker hunts, the
 * shadow tails the attacker with guns cold. Splash the evader and everyone
 * moves up one role while the next pilot on deck joins the tail.
 *
 * Attributes:
 *   heading        drill title (default "Melee Rotation Drill")
 *   eyebrow        line above the title (default "PERMAFLEET // FLIGHT TRAINING")
 *   description    replaces the intro paragraph (plain text)
 *   pilots         starting callsigns, comma separated (3–8; default examples)
 *   storage-key    localStorage key for the visitor's roster (default `mrd.roster`;
 *                  `none` disables saving)
 *   auto-every     seconds between auto-splashes (default 7)
 *   fonts          `none` skips loading Orbitron / Rajdhani / Share Tech Mono
 *
 * Keys (while the drill is on screen, outside form fields): Space splashes, P pauses.
 * Emits `splash` with `detail: { splashed, chain, deck, splashes }` and
 * `rosterchange` with `detail: { roster }`.
 */
(function (root) {
  if (!root || typeof root.HTMLElement !== 'function' || !root.customElements) return;
  if (root.customElements.get('melee-rotation-drill')) return;

  const FONTS_HREF = 'https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Rajdhani:wght@400;500;600;700&family=Share+Tech+Mono&display=swap';
  const EXAMPLE = ['VIPER', 'KESTREL', 'NOMAD', 'RONIN', 'TALON'];
  const DEFAULT_STORAGE_KEY = 'mrd.roster';

  const STYLE = `
:host{
  color-scheme:dark;
  --ground:#04070a;--panel:#0a1016;--rail:#0e1720;--edge:#1b2c38;
  --cyan:#27e0ef;--amber:#ffb02e;--hostile:#ff4756;--clear:#3ddc97;
  --text:#c2d4dc;--bright:#eaf6f9;--dim:#6d838e;--faint:#3d525d;
  --display:'Orbitron',"Trebuchet MS",sans-serif;
  --body:'Rajdhani',"Segoe UI",sans-serif;
  --mono:'Share Tech Mono',ui-monospace,"Courier New",monospace;
  display:block;background:var(--ground);color:var(--text);font-family:var(--body);font-size:17px;line-height:1.5;text-align:left;
  font-variant-numeric:tabular-nums;
  background-image:linear-gradient(rgba(39,224,239,.026) 1px,transparent 1px),linear-gradient(90deg,rgba(39,224,239,.026) 1px,transparent 1px);
  background-size:52px 52px}
*{box-sizing:border-box}
.wrap{max-width:1180px;margin:0 auto;padding-inline:clamp(16px,3vw,28px);padding-block:28px 72px;display:grid;gap:22px}

.hdr{display:grid;gap:10px}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.22em;color:var(--cyan);text-transform:uppercase;display:flex;flex-wrap:wrap;gap:6px 14px;margin:0}
.eyebrow .sep{color:var(--faint)}
h1{font-family:var(--display);font-weight:900;font-size:clamp(25px,4.2vw,40px);letter-spacing:.03em;line-height:1.08;margin:0;color:var(--bright);text-wrap:balance}
.sub{color:var(--dim);max-width:68ch;margin:0;font-size:18px}
.sub b{color:var(--text);font-weight:600}

.stage{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:16px;align-items:stretch}
.main{display:grid;gap:12px;min-width:0;align-content:start}
.scope{position:relative;border:1px solid var(--edge);background:var(--ground);aspect-ratio:16/9;max-width:100%;overflow:hidden}
.scope canvas{display:block;width:100%;height:100%}
.scope::before{content:"";position:absolute;inset:0;pointer-events:none;z-index:2;
  background:repeating-linear-gradient(180deg,rgba(255,255,255,.018) 0 1px,transparent 1px 3px),
             radial-gradient(ellipse at center,transparent 62%,rgba(2,5,8,.42) 100%)}
.brk{position:absolute;width:18px;height:18px;border:2px solid var(--cyan);z-index:3;pointer-events:none}
.brk.tl{top:-1px;left:-1px;border-right:0;border-bottom:0}
.brk.tr{top:-1px;right:-1px;border-left:0;border-bottom:0}
.brk.bl{bottom:-1px;left:-1px;border-right:0;border-top:0}
.brk.br{bottom:-1px;right:-1px;border-left:0;border-top:0}

.comms{display:flex;gap:12px;align-items:baseline;border:1px solid var(--edge);background:var(--panel);padding:10px 14px;font-family:var(--mono);font-size:13.5px;min-height:44px}
.comms .tag{color:var(--amber);letter-spacing:.18em;font-size:11px;flex:none}
.comms .msg{color:var(--text);min-width:0;overflow-wrap:anywhere}
.comms .msg.flash{animation:msgin .5s ease-out}
@keyframes msgin{from{color:var(--bright);text-shadow:0 0 12px rgba(39,224,239,.8)}to{color:var(--text);text-shadow:none}}

.ctl{display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.btn{font-family:var(--display);font-weight:700;font-size:12px;letter-spacing:.14em;text-transform:uppercase;padding:0 18px;min-height:46px;border:1px solid var(--edge);background:var(--rail);color:var(--text);cursor:pointer;display:inline-flex;align-items:center;gap:10px;transition:border-color .15s,color .15s,background .15s}
.btn:hover{border-color:var(--cyan);color:var(--bright)}
.btn svg{width:15px;height:15px;flex:none}
.btn-primary{background:var(--cyan);border-color:var(--cyan);color:#021216}
.btn-primary:hover{background:#7df1fa;border-color:#7df1fa;color:#021216}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn kbd{font-family:var(--mono);font-size:10px;font-weight:400;letter-spacing:.08em;border:1px solid currentColor;padding:1px 5px;opacity:.65}
.switch{position:relative;display:inline-flex;align-items:center;gap:10px;font-family:var(--mono);font-size:12.5px;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);cursor:pointer;min-height:46px;padding-inline:6px}
.switch input{position:absolute;opacity:0;width:1px;height:1px}
.switch .trk{width:38px;height:20px;border:1px solid var(--edge);background:var(--rail);position:relative;flex:none;transition:border-color .15s}
.switch .trk::after{content:"";position:absolute;top:3px;left:3px;width:12px;height:12px;background:var(--faint);transition:transform .18s,background .18s}
.switch input:checked + .trk{border-color:var(--amber)}
.switch input:checked + .trk::after{transform:translateX(18px);background:var(--amber)}
.switch input:checked ~ .lbl{color:var(--amber)}
.switch input:focus-visible + .trk{outline:2px solid var(--cyan);outline-offset:3px}

.rail{display:grid;gap:12px;align-content:start;min-width:0}
.panel{border:1px solid var(--edge);background:var(--panel);padding:14px 16px}
.panel h2{font-family:var(--mono);font-weight:400;font-size:11px;letter-spacing:.2em;text-transform:uppercase;color:var(--dim);margin:0 0 10px}
ol.chain,ol.deck{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.slot{--c:var(--dim);display:flex;align-items:center;gap:10px;padding:9px 10px;background:var(--rail);border:1px solid var(--edge);min-width:0}
.slot .pip{width:9px;height:9px;background:var(--c);transform:rotate(45deg);flex:none;box-shadow:0 0 10px var(--c)}
.slot .cs{font-family:var(--mono);font-size:15px;color:var(--bright);letter-spacing:.06em;min-width:0;overflow-wrap:anywhere}
.slot .rb{margin-left:auto;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;color:var(--c);border:1px solid var(--c);padding:2px 7px;white-space:nowrap}
.slot.in{animation:slotin .55s cubic-bezier(.2,.8,.2,1) both}
@keyframes slotin{from{transform:translateY(14px);background:rgba(39,224,239,.16)}to{transform:none;background:var(--rail)}}
.deck .slot{background:transparent;border-style:dashed}
.deck .slot .cs{color:var(--text);font-size:14px}
.deck .slot .rb{border:0;padding:0;color:var(--dim)}
.deck .none{font-size:15px;color:var(--dim);line-height:1.4}
.stats{display:grid;gap:10px}
.stat{display:flex;justify-content:space-between;align-items:baseline;gap:12px}
.stat .k{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--dim)}
.stat .v{font-family:var(--mono);font-size:20px;color:var(--bright)}

.roles{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:1px;background:var(--edge);border:1px solid var(--edge)}
.role{--c:var(--dim);background:var(--panel);padding:18px 18px 20px;display:grid;gap:8px;align-content:start}
.role header{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.role .pip{width:10px;height:10px;background:var(--c);transform:rotate(45deg);flex:none}
.role h3{font-family:var(--display);font-weight:700;font-size:15px;letter-spacing:.14em;text-transform:uppercase;color:var(--bright);margin:0}
.role .gun{margin-left:auto;font-family:var(--mono);font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--c);border:1px solid var(--c);padding:2px 7px;white-space:nowrap}
.role .rule{margin:0;font-size:19px;font-weight:600;color:var(--text);line-height:1.3}
.role .next{margin:0;color:var(--dim);font-size:16px}
.role .next span{display:block;font-family:var(--mono);font-size:10.5px;letter-spacing:.18em;text-transform:uppercase;color:var(--faint);margin-bottom:2px}

.pilots{border:1px solid var(--edge);background:var(--panel);padding:18px;display:grid;gap:10px}
.pilots h2{font-family:var(--display);font-weight:700;font-size:14px;letter-spacing:.16em;text-transform:uppercase;color:var(--cyan);margin:0}
.pilots p{margin:0;color:var(--dim);font-size:16px;max-width:72ch}
.pilots .row{display:flex;flex-wrap:wrap;gap:10px}
.pilots input[type=text]{flex:1 1 320px;min-width:0;min-height:46px;background:var(--ground);border:1px solid var(--edge);color:var(--bright);font-family:var(--mono);font-size:15px;letter-spacing:.06em;padding:0 14px;text-transform:uppercase}
.pilots input[type=text]:focus{outline:none;border-color:var(--cyan)}
.pilots .err{color:var(--hostile);font-family:var(--mono);font-size:13px;min-height:1.2em}
.pilots .err.ok{color:var(--clear)}

:focus-visible{outline:2px solid var(--cyan);outline-offset:2px}

@media(min-width:561px){.role .rule{min-height:2.6em}}
@media(max-width:920px){
  .stage{grid-template-columns:1fr}
  .rail{grid-template-columns:repeat(2,minmax(0,1fr))}
  .rail .stats{grid-column:1/-1;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}
}
@media(max-width:560px){
  :host{font-size:16px}
  .scope{aspect-ratio:1/0.98}
  .rail{grid-template-columns:1fr}
  .rail .stats{grid-template-columns:1fr;gap:10px}
  .btn{flex:1 1 auto;justify-content:center}
  .btn kbd{display:none}
  .sub{font-size:17px}
  .pilots input[type=text]{font-size:13px;padding:0 10px}
}
@media(prefers-reduced-motion:reduce){
  .slot.in,.comms .msg.flash{animation:none}
}`;

  const TEMPLATE = `
<div class="wrap">
  <header class="hdr">
    <p class="eyebrow"><span id="eyebrow">PERMAFLEET // FLIGHT TRAINING</span><span class="sep">/</span><span>DRILL SCOPE</span></p>
    <h1 id="heading">Melee Rotation Drill</h1>
    <p class="sub" id="description">Three ships fly a chase chain: the <b>evader</b> runs, the <b>attacker</b> hunts, the <b>shadow</b> tails the attacker with guns cold. Splash the evader and everyone moves up one role while the next pilot on deck joins the tail.</p>
  </header>

  <div class="stage">
    <div class="main">
      <div class="scope" id="scopeBox">
        <canvas id="scope" role="img" aria-label="Animated tactical scope: three ships circle a weaving track in a chase chain. The evader leads, the attacker fires on it, and the shadow follows the attacker without firing."></canvas>
        <i class="brk tl"></i><i class="brk tr"></i><i class="brk bl"></i><i class="brk br"></i>
      </div>

      <div class="comms"><span class="tag">COMMS</span><span class="msg" id="comms" aria-live="polite"></span></div>

      <div class="ctl">
        <button class="btn btn-primary" id="splash" type="button">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="4.2"/><path d="M8 0v4M8 12v4M0 8h4M12 8h4"/></svg>
          Splash &amp; rotate <kbd>Space</kbd>
        </button>
        <button class="btn" id="play" type="button"></button>
        <button class="btn" id="speed" type="button" aria-label="Change flight speed">Speed 1&times;</button>
        <label class="switch"><input type="checkbox" id="auto"><span class="trk"></span><span class="lbl" id="autoLabel">Auto-splash every 7 s</span></label>
      </div>
    </div>

    <aside class="rail" aria-label="Drill status">
      <section class="panel">
        <h2>Current chain</h2>
        <ol class="chain" id="chain"></ol>
      </section>
      <section class="panel">
        <h2>On deck</h2>
        <ol class="deck" id="deck"></ol>
      </section>
      <section class="panel stats">
        <div class="stat"><span class="k">Splashes</span><span class="v" id="stSpl">00</span></div>
        <div class="stat"><span class="k">Evader survival</span><span class="v" id="stSur">00:00.0</span></div>
      </section>
    </aside>
  </div>

  <section class="roles" aria-label="Role briefings">
    <article class="role" style="--c:var(--cyan)">
      <header><i class="pip"></i><h3>Evader</h3><span class="gun">Defensive</span></header>
      <p class="rule">Don't get hit. Pure defense.</p>
      <p class="next"><span>On splash</span>Respawn and rejoin at the back of the deck.</p>
    </article>
    <article class="role" style="--c:var(--hostile)">
      <header><i class="pip"></i><h3>Attacker</h3><span class="gun">Weapons free</span></header>
      <p class="rule">Kill the evader. Weapons free.</p>
      <p class="next"><span>On splash</span>You are the new evader. Break and run &mdash; your shadow is now hunting you.</p>
    </article>
    <article class="role" style="--c:var(--amber)">
      <header><i class="pip"></i><h3>Shadow</h3><span class="gun">Hold fire</span></header>
      <p class="rule">Tail the attacker. Hold fire.</p>
      <p class="next"><span>On splash</span>You are the new attacker. Weapons free on the pilot you were tailing.</p>
    </article>
    <article class="role">
      <header><i class="pip"></i><h3>On deck</h3><span class="gun">Standby</span></header>
      <p class="rule">Hold outside the track. Watch the chain.</p>
      <p class="next"><span>On splash</span>Next up slots in behind the new attacker as shadow.</p>
    </article>
  </section>

  <section class="pilots" aria-labelledby="pilotsH">
    <h2 id="pilotsH">Pilots in rotation</h2>
    <p>These are example callsigns. Enter your own in rotation order, separated by commas &mdash; 3 to 8 pilots. The first three start as evader, attacker and shadow; the rest wait on deck. Saved in this browser only.</p>
    <div class="row">
      <input type="text" id="pilotInput" aria-label="Callsigns, comma separated" autocomplete="off" spellcheck="false" maxlength="140">
      <button class="btn" id="pilotApply" type="button">Set roster</button>
      <button class="btn" id="pilotReset" type="button">Load examples</button>
    </div>
    <div class="err" id="pilotErr" role="status"></div>
  </section>
</div>`;

  function loadFonts (doc) {
    if (!doc || !doc.head || doc.querySelector('link[data-melee-rotation-drill-fonts]')) return;
    const link = doc.createElement('link');
    link.rel = 'stylesheet';
    link.href = FONTS_HREF;
    link.setAttribute('data-melee-rotation-drill-fonts', '');
    doc.head.appendChild(link);
  }

  function parsePilots (str) {
    const seen = {};
    const out = [];
    String(str || '').split(/[,\n;]+/).forEach(function (x) {
      x = x.trim().toUpperCase().replace(/\s+/g, ' ').slice(0, 14);
      if (x && !seen[x]) { seen[x] = 1; out.push(x); }
    });
    return out;
  }

  /**
   * The drill engine: canvas scope, chain rotation, rail, and controls for one
   * element instance. Returns `{ start, stop }` for the animation loop.
   */
  function createDrill (host, shadow, options) {
    var TAU = Math.PI * 2;
    var ROLES = [{ name: 'EVADER', rgb: [39, 224, 239], css: 'var(--cyan)' }, { name: 'ATTACKER', rgb: [255, 71, 86], css: 'var(--hostile)' }, { name: 'SHADOW', rgb: [255, 176, 46], css: 'var(--amber)' }];
    var MONO = '"Share Tech Mono",ui-monospace,"Courier New",monospace';
    var DISP = 'Orbitron,"Trebuchet MS",sans-serif';
    var reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var $ = function (id) { return shadow.getElementById(id); };
    var lerp = function (a, b, u) { return a + (b - a) * u; };
    var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
    var eio = function (u) { return u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2; };
    var eo = function (u) { return 1 - Math.pow(1 - u, 3); };
    var rgba = function (c, a) { return 'rgba(' + (c[0] | 0) + ',' + (c[1] | 0) + ',' + (c[2] | 0) + ',' + a + ')'; };

    var cv = $('scope'), ctx = cv.getContext('2d');
    var W = 0, H = 0, DPR = 1, cx = 0, cy = 0, rx = 1, ry = 1, S = 1, gap = 0.075, narrow = false;
    var RING = 1.19;

    var roster = options.example.slice(), order = [], ships = [];
    var t = 0.30, simTime = 0, fxTime = 0, trailClock = 0;
    var playing = !reduce, auto = false, speedIdx = 1, SPEEDS = [0.5, 1, 2], LAP = 0.082, AUTO_EVERY = options.autoEvery;
    var rot = null, lock = 0, linkA = 0, splashes = 0, survival = 0, autoClock = 0, shake = 0, fireClock = 0.6, burstLeft = 0;
    var bolts = [], parts = [], rings = [], shards = [], callouts = [], hits = [], stars = [];
    for (var i = 0; i < 120; i++) stars.push({ x: Math.random(), y: Math.random(), r: Math.random() < 0.18 ? 1.4 : 0.9, a: 0.18 + Math.random() * 0.5, f: 0.4 + Math.random() * 1.6, p: Math.random() * TAU });

    function emit (type, detail) {
      host.dispatchEvent(new root.CustomEvent(type, { bubbles: true, composed: true, detail: detail }));
    }

    /* ---------- track geometry ---------- */
    function weave (T) { return 1 + 0.10 * Math.sin(TAU * 3 * T + 0.6) + 0.045 * Math.sin(TAU * 5 * T + 2.1); }
    function P (T, k) { var a = TAU * T, w = weave(T) * (k || 1); return { x: cx + rx * w * Math.cos(a), y: cy + ry * w * Math.sin(a), d: (Math.sin(a) + 1) / 2 }; }
    function heading (T, k) { var a = P(T - 0.002, k), b = P(T + 0.002, k); return Math.atan2(b.y - a.y, b.x - a.x); }
    function pose (s) {
      var T = t + s.off * gap;
      var k = s.k * (1 + s.amp * Math.sin(simTime * 4.2 - s.ph)), p = P(T, k);
      return { x: p.x, y: p.y, h: heading(T, k), s: S * (0.82 + 0.36 * p.d), d: p.d };
    }

    /* ---------- roster / ships ---------- */
    var JINK = [0.030, 0.014, 0], JPH = [0, 0.8, 1.6];
    function makeShip (pilot, slot) { return { pilot: pilot, off: -slot, k: 1, alpha: 1, rgb: ROLES[slot].rgb.slice(), role: slot, amp: JINK[slot], ph: JPH[slot], trail: [], seed: Math.random() * 10 }; }
    function setRoster (list, keepOrder) {
      roster = list.slice();
      if (!keepOrder || keepOrder.length !== roster.length) { order = roster.map(function (_, i) { return i; }); } else { order = keepOrder.slice(); }
      ships = [0, 1, 2].map(function (i) { return makeShip(order[i], i); });
      rot = null; lock = 0; survival = 0; autoClock = 0; bolts.length = 0;
      $('splash').disabled = false;
      updateRail(false);
      comms('Chain set. ' + nm(0) + ' evading · ' + nm(1) + ' weapons free · ' + nm(2) + ' shadowing.');
    }
    function nm (i) { return roster[order[i]]; }

    function splash () {
      if (rot || ships.length < 3) return;
      var ev = ships[0], pe = pose(ev), dead = order[0];
      explode(pe.x, pe.y, ev.rgb);
      callouts.push({ x: pe.x, y: pe.y, text: 'SPLASH', sub: roster[dead], age: 0 });
      order.push(order.shift());
      ships.shift();
      ships.forEach(function (s, i) { s.fromOff = s.off; s.toOff = -i; s.fromRgb = s.rgb.slice(); s.toRgb = ROLES[i].rgb; s.newRole = i; });
      rot = { time: 0, spawned: false };
      lock = 0; bolts.length = 0; hits.length = 0; splashes++; survival = 0; autoClock = 0; burstLeft = 0; fireClock = 0.5;
      if (!reduce) shake = 1;
      $('splash').disabled = true;
      updateRail(true);
      comms(roster[dead] + ' splashed. ' + nm(0) + ' now evading · ' + nm(1) + ' weapons free · ' + nm(2) + (roster.length > 3 ? ' joins as shadow.' : ' rejoins as shadow.'));
      emit('splash', {
        splashed: roster[dead],
        chain: [nm(0), nm(1), nm(2)],
        deck: order.slice(3).map(function (idx) { return roster[idx]; }),
        splashes: splashes
      });
    }
    function updateRot (dt) {
      rot.time += dt;
      var u = clamp((rot.time - 0.3) / 1.15, 0, 1), e = eio(u);
      for (var i = 0; i < 2; i++) {
        var s = ships[i];
        s.off = lerp(s.fromOff, s.toOff, e);
        s.rgb = [0, 1, 2].map(function (j) { return lerp(s.fromRgb[j], s.toRgb[j], e); });
        if (u > 0.5) s.role = s.newRole;
      }
      if (!rot.spawned && rot.time >= 0.4) { rot.spawned = true; var n = makeShip(order[2], 2); n.off = -3.3; n.k = 1.9; n.alpha = 0; n.entering = true; ships.push(n); }
      var ns = ships[2];
      if (ns && ns.entering) { var v = clamp((rot.time - 0.4) / 1.3, 0, 1), ev = eo(v); ns.off = lerp(-3.3, -2, ev); ns.k = lerp(1.9, 1, ev); ns.alpha = clamp(v * 3, 0, 1); }
      if (rot.time >= 1.75) {
        ships.forEach(function (s, i) { s.off = -i; s.k = 1; s.alpha = 1; s.role = i; s.rgb = ROLES[i].rgb.slice(); s.entering = false; });
        rot = null; $('splash').disabled = false;
      }
    }

    /* ---------- effects ---------- */
    function explode (x, y, rgb) {
      var n = reduce ? 10 : 46, i, a, v;
      for (i = 0; i < n; i++) {
        a = Math.random() * TAU; v = (60 + Math.random() * 300) * S;
        parts.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v * 0.8, age: 0, max: 0.5 + Math.random() * 0.9, w: 1.2 + Math.random() * 2.2, rgb: Math.random() < 0.35 ? [255, 240, 200] : Math.random() < 0.5 ? [255, 150, 60] : [255, 190, 70] });
      }
      if (!reduce) {
        for (i = 0; i < 9; i++) {
          a = Math.random() * TAU; v = (40 + Math.random() * 130) * S;
          shards.push({ x: x, y: y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 14, age: 0, max: 0.9 + Math.random() * 0.7, sz: (3 + Math.random() * 5) * S, rgb: rgb.slice() });
        }
      }
      rings.push({ x: x, y: y, age: 0, max: 0.8, r1: 120 * S, flat: true, rgb: [255, 190, 80] });
      rings.push({ x: x, y: y, age: 0, max: 0.6, r1: 84 * S, flat: false, rgb: [255, 240, 210] });
      rings.push({ x: x, y: y, age: -0.12, max: 0.9, r1: 170 * S, flat: true, rgb: [255, 120, 60] });
    }
    function spawnBolt () {
      var at = ships[1], ev = ships[0]; if (!at || !ev) return;
      var pa = pose(at), pe = pose(ev);
      var nx = pa.x + Math.cos(pa.h) * 15 * pa.s, ny = pa.y + Math.sin(pa.h) * 15 * pa.s;
      var lead = P(t + ev.off * gap + 0.012, ev.k), ang = Math.atan2(lead.y - ny, lead.x - nx) + (Math.random() - 0.5) * 0.10;
      var sp = 620 * S, dist = Math.hypot(pe.x - nx, pe.y - ny);
      bolts.push({ x: nx, y: ny, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, age: 0, max: dist / sp + 0.28, hitAt: Math.random() < 0.24 ? dist / sp * 0.96 : -1 });
      parts.push({ x: nx, y: ny, vx: Math.cos(ang) * 40, vy: Math.sin(ang) * 40, age: 0, max: 0.09, w: 3.2, rgb: [255, 220, 190] });
    }
    function stepFx (dt) {
      var i, p;
      for (i = parts.length - 1; i >= 0; i--) { p = parts[i]; p.age += dt; if (p.age >= p.max) { parts.splice(i, 1); continue; } var dr = Math.exp(-2.6 * dt); p.vx *= dr; p.vy *= dr; p.x += p.vx * dt; p.y += p.vy * dt; }
      for (i = shards.length - 1; i >= 0; i--) { p = shards[i]; p.age += dt; if (p.age >= p.max) { shards.splice(i, 1); continue; } var ds = Math.exp(-1.4 * dt); p.vx *= ds; p.vy *= ds; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt; }
      for (i = rings.length - 1; i >= 0; i--) { rings[i].age += dt; if (rings[i].age >= rings[i].max) rings.splice(i, 1); }
      for (i = callouts.length - 1; i >= 0; i--) { callouts[i].age += dt; if (callouts[i].age >= 1.2) callouts.splice(i, 1); }
      for (i = hits.length - 1; i >= 0; i--) { hits[i].age += dt; if (hits[i].age >= 0.3) hits.splice(i, 1); }
      shake *= Math.exp(-7 * dt);
    }

    /* ---------- simulation step ---------- */
    function step (dt) {
      fxTime += dt;
      var sp = SPEEDS[speedIdx];
      if (playing) { t = (t + LAP * sp * dt) % 1; simTime += dt * sp; if (!rot) survival += dt; }
      if (rot) updateRot(dt); else lock = Math.min(1, lock + dt / 0.7);
      linkA += ((rot ? 0 : 1) - linkA) * Math.min(1, dt * 6);
      ships.forEach(function (s) { var q = Math.min(1, dt * 2.5); s.amp += (JINK[s.role] - s.amp) * q; s.ph += (JPH[s.role] - s.ph) * q; });
      if (auto && playing && !rot) { autoClock += dt; if (autoClock >= AUTO_EVERY) splash(); }

      if (playing && !rot && lock >= 1) {
        fireClock -= dt;
        if (fireClock <= 0) {
          if (burstLeft > 0) { spawnBolt(); burstLeft--; fireClock = 0.075; } else { burstLeft = 5 + ((Math.random() * 3) | 0); fireClock = 0.4 + Math.random() * 0.55; }
        }
      }
      var i, b;
      if (playing) {
        for (i = bolts.length - 1; i >= 0; i--) {
          b = bolts[i]; b.age += dt; b.x += b.vx * dt; b.y += b.vy * dt;
          if (b.hitAt > 0 && b.age >= b.hitAt && ships[0]) { hits.push({ age: 0, ang: Math.atan2(-b.vy, -b.vx) }); bolts.splice(i, 1); continue; }
          if (b.age >= b.max) bolts.splice(i, 1);
        }
      }
      if (playing || rot) {
        trailClock += dt;
        ships.forEach(function (s) { var p = pose(s); s.trail.push({ x: p.x, y: p.y, c: trailClock }); while (s.trail.length && trailClock - s.trail[0].c > 1.25) s.trail.shift(); });
      }
      stepFx(dt);
    }

    /* ---------- drawing ---------- */
    function resize () {
      var r = cv.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return;
      W = r.width; H = r.height; DPR = Math.min(2, root.devicePixelRatio || 1);
      cv.width = Math.round(W * DPR); cv.height = Math.round(H * DPR);
      narrow = W < 560;
      cx = W / 2; cy = H * 0.535;
      rx = W * (narrow ? 0.335 : 0.34);
      ry = Math.min(H * 0.30, rx * (narrow ? 0.80 : 0.52));
      S = clamp(W / 880, 0.74, 1.12);
      gap = narrow ? 0.09 : 0.075;
      ships.forEach(function (s) { s.trail.length = 0; });
    }
    function text (str, x, y, font, color, align, ls) {
      ctx.font = font; ctx.fillStyle = color; ctx.textAlign = align || 'left';
      if ('letterSpacing' in ctx) ctx.letterSpacing = ls || '0px';
      ctx.fillText(str, x, y);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
    }
    function drawBackdrop () {
      var g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(W, H) * 0.7);
      g.addColorStop(0, '#08151d'); g.addColorStop(0.55, '#050b10'); g.addColorStop(1, '#04070a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
      var amb = reduce ? 0 : fxTime, i, s;
      for (i = 0; i < stars.length; i++) { s = stars[i]; ctx.fillStyle = 'rgba(190,225,240,' + (s.a * (0.62 + 0.38 * Math.sin(amb * s.f + s.p))).toFixed(3) + ')'; ctx.fillRect(s.x * W, s.y * H, s.r, s.r); }
    }
    function ell (f) { ctx.beginPath(); ctx.ellipse(cx, cy, rx * f, ry * f, 0, 0, TAU); }
    function drawScope () {
      var i, a, f0, f1;
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(39,224,239,0.10)';
      ctx.beginPath(); ctx.moveTo(cx - rx * RING, cy); ctx.lineTo(cx + rx * RING, cy); ctx.moveTo(cx, cy - ry * RING); ctx.lineTo(cx, cy + ry * RING); ctx.stroke();
      ctx.strokeStyle = 'rgba(39,224,239,0.11)'; ell(0.40); ctx.stroke(); ell(0.80); ctx.stroke();
      ctx.strokeStyle = 'rgba(39,224,239,0.34)'; ctx.lineWidth = 1.2; ell(RING); ctx.stroke();
      ctx.lineWidth = 1;
      for (i = 0; i < 72; i++) {
        a = i / 72 * TAU; var major = i % 9 === 0, mid = i % 3 === 0;
        f0 = RING; f1 = RING + (major ? 12 : mid ? 7 : 4) / rx;
        ctx.strokeStyle = major ? 'rgba(39,224,239,0.75)' : 'rgba(39,224,239,0.30)';
        ctx.beginPath(); ctx.moveTo(cx + rx * f0 * Math.cos(a), cy + ry * f0 * Math.sin(a)); ctx.lineTo(cx + rx * f1 * Math.cos(a), cy + ry * f1 * Math.sin(a)); ctx.stroke();
      }
      var bf = '10px ' + MONO, bc = 'rgba(109,131,142,0.95)';
      ctx.textBaseline = 'middle';
      text('000', cx, cy - ry * RING - 20, bf, bc, 'center', '1px');
      text('180', cx, cy + ry * RING + 21, bf, bc, 'center', '1px');
      if (!narrow) { text('090', cx + rx * RING + 17, cy - 10, bf, bc, 'left', '1px'); text('270', cx - rx * RING - 17, cy - 10, bf, bc, 'right', '1px'); }
      ctx.textBaseline = 'alphabetic';
      ctx.save(); ctx.translate(cx, cy); ctx.rotate(Math.PI / 4); ctx.strokeStyle = 'rgba(39,224,239,0.5)'; ctx.strokeRect(-3.5, -3.5, 7, 7); ctx.restore();
    }
    function sweepAngle () { return reduce ? 5.3 : (fxTime * 0.5) % TAU; }
    function drawSweep () {
      var ang = sweepAngle(), R = rx * RING;
      ctx.save(); ctx.translate(cx, cy); ctx.scale(1, ry / rx);
      if (ctx.createConicGradient) {
        var g = ctx.createConicGradient(ang, 0, 0);
        g.addColorStop(0, 'rgba(39,224,239,0)'); g.addColorStop(0.76, 'rgba(39,224,239,0)'); g.addColorStop(1, 'rgba(39,224,239,0.14)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = 'rgba(39,224,239,0.5)'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ang) * R, Math.sin(ang) * R); ctx.stroke();
      ctx.restore();
    }
    function drawTrack () {
      ctx.save(); ctx.setLineDash([2, 7]); ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(194,212,220,0.20)';
      ctx.beginPath(); for (var i = 0; i <= 160; i++) { var p = P(i / 160, 1); if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y); } ctx.stroke(); ctx.restore();
    }
    function drawLinks (ps) {
      if (ships.length < 3 || linkA < 0.02) return;
      var amb = reduce ? 0 : fxTime;
      ctx.save(); ctx.lineWidth = 1.2;
      ctx.setLineDash([7, 6]); ctx.lineDashOffset = -amb * 60; ctx.strokeStyle = rgba(ROLES[1].rgb, 0.42 * linkA * lock);
      ctx.beginPath(); ctx.moveTo(ps[1].x, ps[1].y); ctx.lineTo(ps[0].x, ps[0].y); ctx.stroke();
      ctx.setLineDash([3, 6]); ctx.lineDashOffset = -amb * 24; ctx.strokeStyle = rgba(ROLES[2].rgb, 0.6 * linkA);
      ctx.beginPath(); ctx.moveTo(ps[2].x, ps[2].y); ctx.lineTo(ps[1].x, ps[1].y); ctx.stroke();
      ctx.restore();
    }
    function drawTrails () {
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
      ships.forEach(function (s) {
        var tr = s.trail, n = tr.length; if (n < 2) return;
        for (var i = 1; i < n; i++) {
          var u = i / n; ctx.strokeStyle = rgba(s.rgb, (u * u * 0.8 * s.alpha).toFixed(3)); ctx.lineWidth = (0.6 + u * 2.6) * S;
          ctx.beginPath(); ctx.moveTo(tr[i - 1].x, tr[i - 1].y); ctx.lineTo(tr[i].x, tr[i].y); ctx.stroke();
        }
      });
      ctx.restore();
    }
    function hull () {
      ctx.beginPath(); ctx.moveTo(17, 0); ctx.lineTo(3, -3.6); ctx.lineTo(-5, -11.5); ctx.lineTo(-9.5, -10.5); ctx.lineTo(-7, -3.6); ctx.lineTo(-12, -3);
      ctx.lineTo(-12, 3); ctx.lineTo(-7, 3.6); ctx.lineTo(-9.5, 10.5); ctx.lineTo(-5, 11.5); ctx.lineTo(3, 3.6); ctx.closePath();
    }
    function drawShip (s, p) {
      var amb = reduce ? 0 : fxTime;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.h); ctx.scale(p.s, p.s); ctx.globalAlpha = s.alpha;
      var fl = 1 + 0.28 * Math.sin(amb * 42 + s.seed), L = 15 * fl * (playing || rot ? 1 : 0.55);
      var g = ctx.createLinearGradient(-12, 0, -12 - L, 0); g.addColorStop(0, 'rgba(255,255,255,0.95)'); g.addColorStop(0.35, rgba(s.rgb, 0.8)); g.addColorStop(1, rgba(s.rgb, 0));
      ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-12, -2.8); ctx.lineTo(-12 - L, 0); ctx.lineTo(-12, 2.8); ctx.closePath(); ctx.fill();
      ctx.globalCompositeOperation = 'source-over';
      ctx.shadowColor = rgba(s.rgb, 0.95); ctx.shadowBlur = 16 * DPR; ctx.fillStyle = rgba(s.rgb, 1); hull(); ctx.fill();
      ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
      ctx.fillStyle = 'rgba(4,7,10,0.6)'; ctx.beginPath(); ctx.moveTo(9, 0); ctx.lineTo(1, -2.2); ctx.lineTo(-5, 0); ctx.lineTo(1, 2.2); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)'; ctx.lineWidth = 0.8; hull(); ctx.stroke();
      ctx.restore();
    }
    function drawPing (s, p) {
      if (reduce) return;
      var sa = Math.atan2((p.y - cy) * rx / ry, p.x - cx), d = ((sweepAngle() - sa) % TAU + TAU) % TAU;
      if (d < 0.7) { var u = d / 0.7; ctx.strokeStyle = rgba(s.rgb, (0.5 * (1 - u) * s.alpha).toFixed(3)); ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(p.x, p.y, (16 + u * 26) * p.s, 0, TAU); ctx.stroke(); }
    }
    function drawReticle (ps) {
      if (ships.length < 2 || lock <= 0.01) return;
      var amb = reduce ? 0 : fxTime, p = ps[0], e = eo(lock), r = lerp(48, 21, e) * p.s, c = ROLES[1].rgb, i;
      var al = lock < 1 ? e * 0.9 : 0.72 + 0.28 * Math.sin(amb * 7);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(lock < 1 ? (1 - e) * 1.6 : 0); ctx.strokeStyle = rgba(c, al.toFixed(3)); ctx.lineWidth = 1.6;
      var k = 7 * p.s;
      for (i = 0; i < 4; i++) { ctx.rotate(Math.PI / 2); ctx.beginPath(); ctx.moveTo(r, r - k); ctx.lineTo(r, r); ctx.lineTo(r - k, r); ctx.stroke(); }
      ctx.restore();
      // The shadow's tracking arcs on the attacker.
      if (ships.length > 2 && linkA > 0.02) {
        var q = ps[1], ra = 19 * q.s, h = q.h;
        ctx.strokeStyle = rgba(ROLES[2].rgb, (0.7 * linkA).toFixed(3)); ctx.lineWidth = 1.3;
        ctx.beginPath(); ctx.arc(q.x, q.y, ra, h + Math.PI - 0.75, h + Math.PI + 0.75); ctx.stroke();
        ctx.beginPath(); ctx.arc(q.x, q.y, ra, h - 0.35, h + 0.35); ctx.stroke();
      }
    }
    function drawBolts () {
      ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.lineCap = 'round';
      bolts.forEach(function (b) {
        var sp = Math.hypot(b.vx, b.vy), ux = b.vx / sp, uy = b.vy / sp, len = 17 * S, fade = clamp((b.max - b.age) / 0.18, 0, 1);
        ctx.strokeStyle = 'rgba(255,90,60,' + (0.55 * fade).toFixed(3) + ')'; ctx.lineWidth = 4 * S; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - ux * len, b.y - uy * len); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,235,215,' + (0.95 * fade).toFixed(3) + ')'; ctx.lineWidth = 1.5 * S; ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - ux * len * 0.7, b.y - uy * len * 0.7); ctx.stroke();
      });
      ctx.restore();
    }
    function drawFx (ps) {
      var i, p, u;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      if (ps[0]) {
        hits.forEach(function (h) {
          u = h.age / 0.3; ctx.strokeStyle = rgba(ROLES[0].rgb, (0.95 * (1 - u)).toFixed(3)); ctx.lineWidth = 2.6 * (1 - u) + 0.6;
          ctx.beginPath(); ctx.arc(ps[0].x, ps[0].y, (18 + u * 7) * ps[0].s, h.ang - 0.8, h.ang + 0.8); ctx.stroke();
        });
      }
      rings.forEach(function (r) {
        if (r.age < 0) return; u = r.age / r.max; var rad = r.r1 * eo(u);
        ctx.strokeStyle = rgba(r.rgb, (0.9 * (1 - u) * (1 - u)).toFixed(3)); ctx.lineWidth = (r.flat ? 2.4 : 3.2) * (1 - u) + 0.4;
        ctx.beginPath(); ctx.ellipse(r.x, r.y, rad, r.flat ? rad * 0.42 : rad, 0, 0, TAU); ctx.stroke();
        if (!r.flat && u < 0.6) {
          var g = ctx.createRadialGradient(r.x, r.y, 0, r.x, r.y, rad * 1.2 + 1); g.addColorStop(0, 'rgba(255,255,240,' + (0.95 * (1 - u / 0.6)).toFixed(3) + ')'); g.addColorStop(0.4, 'rgba(255,160,70,' + (0.5 * (1 - u / 0.6)).toFixed(3) + ')'); g.addColorStop(1, 'rgba(255,90,40,0)');
          ctx.fillStyle = g; ctx.beginPath(); ctx.arc(r.x, r.y, rad * 1.2 + 1, 0, TAU); ctx.fill();
        }
      });
      ctx.lineCap = 'round';
      for (i = 0; i < parts.length; i++) {
        p = parts[i]; u = 1 - p.age / p.max; ctx.strokeStyle = rgba(p.rgb, (u * 0.95).toFixed(3)); ctx.lineWidth = p.w * S * (0.4 + u * 0.6);
        ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 0.035, p.y - p.vy * 0.035); ctx.stroke();
      }
      ctx.restore();
      for (i = 0; i < shards.length; i++) {
        p = shards[i]; u = 1 - p.age / p.max; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = rgba(p.rgb, (u * 0.9).toFixed(3));
        ctx.beginPath(); ctx.moveTo(p.sz, 0); ctx.lineTo(-p.sz * 0.6, -p.sz * 0.5); ctx.lineTo(-p.sz * 0.3, p.sz * 0.6); ctx.closePath(); ctx.fill(); ctx.restore();
      }
      callouts.forEach(function (c) {
        u = c.age / 1.2; var a = u < 0.12 ? u / 0.12 : 1 - clamp((u - 0.5) / 0.5, 0, 1), yy = c.y - 44 * S - eo(u) * 30;
        var xx = clamp(c.x, 70, W - 70);
        text(c.text, xx, yy, '900 ' + Math.round(17 * clamp(S, 0.85, 1.1)) + 'px ' + DISP, 'rgba(255,225,215,' + a.toFixed(3) + ')', 'center', '3px');
        text(c.sub + ' DOWN', xx, yy + 15, '11px ' + MONO, rgba(ROLES[1].rgb, a.toFixed(3)), 'center', '2px');
      });
    }
    function drawLabels (ps) {
      ships.forEach(function (s, i) {
        var p = ps[i], dx = (p.x - cx) / rx, dy = (p.y - cy) / ry, a = s.alpha;
        var nx = narrow ? -dx * 0.8 : dx * 0.62, ny = narrow ? -dy : dy, m = Math.hypot(nx, ny) || 1; nx /= m; ny /= m;
        if (a < 0.03) return;
        var name = roster[s.pilot], fs = narrow ? 11 : 12.5;
        ctx.font = fs + 'px ' + MONO; var tw = ctx.measureText(name).width + 8;
        var dist = 14 * p.s + 8 + Math.abs(nx) * (tw / 2) + Math.abs(ny) * 6;
        var lx = clamp(p.x + nx * dist, tw / 2 + 8, W - tw / 2 - 8), ly = p.y + ny * dist + (ny < -0.3 ? -4 : ny > 0.3 ? 6 : 1);
        text(name, lx, ly, fs + 'px ' + MONO, 'rgba(234,246,249,' + a.toFixed(3) + ')', 'center', '1px');
        text(ROLES[s.role].name, lx, ly + 11, '9px ' + MONO, rgba(s.rgb, (0.95 * a).toFixed(3)), 'center', '1.6px');
      });
      if (!narrow && ships.length > 1 && !rot && lock > 0.05) {
        var p0 = ps[0], ddx = cx - p0.x, ddy = cy - p0.y, mm = Math.hypot(ddx, ddy) || 1, rr = lerp(48, 21, eo(lock)) * p0.s + 9;
        var blink = lock < 1 ? (Math.sin(fxTime * 16) > 0 ? 1 : 0.35) : 1, right = ddx >= 0;
        text(lock < 1 ? 'ACQUIRING' : 'TGT LOCK', p0.x + (right ? rr : -rr), p0.y + 3 + ddy / mm * 12, '9px ' + MONO, rgba(ROLES[1].rgb, (0.9 * blink).toFixed(3)), right ? 'left' : 'right', '1.6px');
      }
    }
    function fmtClock (sec) { var m = Math.floor(sec / 60), s = sec - m * 60; return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); }
    function drawHud () {
      var pad = narrow ? 12 : 18, f11 = '11px ' + MONO, y1 = narrow ? 22 : 28;
      var title = String(options.heading || '').toUpperCase();
      text(narrow ? title : 'PERMAFLEET // ' + title, pad, y1, f11, 'rgba(150,200,214,0.95)', 'left', '1.6px');
      var st = rot ? 'ROTATING' : playing ? 'LIVE' : 'HOLD', sc = rot ? ROLES[1].rgb : playing ? [61, 220, 151] : ROLES[2].rgb;
      var blink = (st === 'LIVE' && !reduce) ? 0.55 + 0.45 * Math.sin(fxTime * 4) : 1;
      ctx.fillStyle = rgba(sc, blink.toFixed(3)); ctx.beginPath(); ctx.arc(pad + 4, y1 + 14, 3.2, 0, TAU); ctx.fill();
      text(st + (SPEEDS[speedIdx] !== 1 && !rot ? '  ' + SPEEDS[speedIdx] + '×' : ''), pad + 13, y1 + 18, f11, rgba(sc, 0.95), 'left', '1.6px');
      var deck = order.slice(3).map(function (i) { return roster[i]; }), ds;
      if (!deck.length) ds = 'ON DECK ▸ NONE';
      else if (narrow || deck.length > 3) ds = 'ON DECK ▸ ' + deck[0] + (deck.length > 1 ? ' +' + (deck.length - 1) : '');
      else ds = 'ON DECK ▸ ' + deck.join(' · ');
      text(ds, W - pad, y1, f11, 'rgba(255,176,46,0.85)', 'right', '1.2px');
      if (auto) text(playing ? 'AUTO SPLASH ' + Math.max(0, AUTO_EVERY - autoClock).toFixed(1) + 's' : 'AUTO SPLASH HELD', W - pad, y1 + 18, f11, 'rgba(255,176,46,0.6)', 'right', '1.2px');
      var yb = H - (narrow ? 12 : 16);
      text((narrow ? 'SPL ' : 'SPLASHES ') + (splashes < 10 ? '0' : '') + splashes, pad, yb, f11, 'rgba(150,200,214,0.95)', 'left', '1.6px');
      text((narrow ? 'SURV ' : 'EVADER SURVIVAL ') + fmtClock(survival), W - pad, yb, f11, 'rgba(39,224,239,0.9)', 'right', '1.2px');
    }
    function draw () {
      if (W < 2) return;
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
      drawBackdrop();
      ctx.save();
      if (shake > 0.02) ctx.translate((Math.random() - 0.5) * 10 * shake, (Math.random() - 0.5) * 10 * shake);
      drawScope(); drawSweep(); drawTrack();
      var ps = ships.map(pose);
      drawLinks(ps); drawTrails(); drawBolts();
      ships.forEach(function (s, i) { drawPing(s, ps[i]); });
      for (var i = ships.length - 1; i >= 0; i--) drawShip(ships[i], ps[i]);
      drawReticle(ps); drawFx(ps); drawLabels(ps);
      ctx.restore();
      drawHud();
    }

    /* ---------- rail + controls ---------- */
    function esc (s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function updateRail (animate) {
      $('chain').innerHTML = [0, 1, 2].map(function (i) {
        return '<li class="slot' + (animate ? ' in' : '') + '" style="--c:' + ROLES[i].css + ';animation-delay:' + (i * 70) + 'ms"><i class="pip"></i><span class="cs">' + esc(nm(i)) + '</span><span class="rb">' + ROLES[i].name + '</span></li>';
      }).join('');
      var deck = order.slice(3);
      $('deck').innerHTML = deck.length
        ? deck.map(function (idx, i) {
          return '<li class="slot' + (animate && i === deck.length - 1 ? ' in' : '') + '"><span class="cs">' + esc(roster[idx]) + '</span><span class="rb">' + (i === 0 ? 'NEXT UP' : '+' + (i + 1)) + '</span></li>';
        }).join('')
        : '<li class="none">No one waiting. With three pilots, the splashed evader rejoins straight away as shadow.</li>';
      $('stSpl').textContent = (splashes < 10 ? '0' : '') + splashes;
    }
    var lastClock = '';
    function updateClock () { var s = fmtClock(survival); if (s !== lastClock) { lastClock = s; $('stSur').textContent = s; } }
    function comms (msg) { var el = $('comms'); el.textContent = msg; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    var ICON_PAUSE = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><rect x="3" y="2" width="3.6" height="12"/><rect x="9.4" y="2" width="3.6" height="12"/></svg>';
    var ICON_PLAY = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M3.5 1.8v12.4L14 8z"/></svg>';
    function setPlayLabel () { $('play').innerHTML = (playing ? ICON_PAUSE + 'Pause' : ICON_PLAY + 'Play') + ' <kbd>P</kbd>'; }
    function togglePlay () { playing = !playing; setPlayLabel(); }

    function save () {
      if (!options.storageKey) return;
      try { root.localStorage.setItem(options.storageKey, JSON.stringify(roster)); } catch (e) { /* private mode */ }
    }
    function load () {
      if (!options.storageKey) return null;
      try {
        var v = JSON.parse(root.localStorage.getItem(options.storageKey) || 'null');
        if (Array.isArray(v)) { v = parsePilots(v.join(',')); if (v.length >= 3 && v.length <= 8) return v; }
      } catch (e) { /* ignore a corrupt entry */ }
      return null;
    }
    function note (msg, ok) { var e = $('pilotErr'); e.textContent = msg; e.className = 'err' + (ok ? ' ok' : ''); }
    function applyPilots () {
      var list = parsePilots($('pilotInput').value);
      if (list.length < 3) { note('Need at least 3 callsigns: a chain is evader, attacker and shadow. Add ' + (3 - list.length) + ' more.'); return; }
      if (list.length > 8) { note('That is ' + list.length + ' callsigns. Keep it to 8 so nobody waits too long on deck.'); return; }
      splashes = 0; setRoster(list); save(); $('pilotInput').value = list.join(', ');
      note('Roster set: ' + list.length + ' pilots, ' + (list.length - 3) + ' on deck.', true);
      emit('rosterchange', { roster: roster.slice() });
    }

    function onKey (e) {
      if (!host.isConnected || !host.getClientRects().length) return;
      var target = (e.composedPath && e.composedPath()[0]) || e.target;
      var tg = target && target.tagName;
      if (tg === 'INPUT' || tg === 'TEXTAREA' || tg === 'BUTTON' || tg === 'SELECT' || (target && target.isContentEditable) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.code === 'Space') { e.preventDefault(); splash(); } else if (e.key === 'p' || e.key === 'P') { togglePlay(); }
    }

    var list = load() || options.example;
    $('pilotInput').value = list.join(', ');
    setRoster(list);
    lock = 1; linkA = 1;
    setPlayLabel();
    $('autoLabel').textContent = 'Auto-splash every ' + AUTO_EVERY + ' s';

    $('splash').addEventListener('click', splash);
    $('play').addEventListener('click', togglePlay);
    $('speed').addEventListener('click', function () { speedIdx = (speedIdx + 1) % SPEEDS.length; this.innerHTML = 'Speed ' + SPEEDS[speedIdx] + '&times;'; });
    $('auto').addEventListener('change', function () { auto = this.checked; autoClock = 0; });
    auto = $('auto').checked;
    $('pilotApply').addEventListener('click', applyPilots);
    $('pilotInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') applyPilots(); });
    $('pilotReset').addEventListener('click', function () { $('pilotInput').value = options.example.join(', '); applyPilots(); });

    var resizeObserver = null;
    var frameId = 0;
    var last = 0;
    function frame (ts) {
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0; last = ts;
      step(dt); draw(); updateClock();
      frameId = root.requestAnimationFrame(frame);
    }

    return {
      start: function () {
        if (frameId) return;
        resize();
        if (root.ResizeObserver) {
          resizeObserver = new root.ResizeObserver(resize);
          resizeObserver.observe($('scopeBox'));
        } else {
          root.addEventListener('resize', resize);
        }
        if (root.document.fonts && root.document.fonts.ready) root.document.fonts.ready.then(function () { draw(); });
        root.document.addEventListener('keydown', onKey);
        last = 0;
        frameId = root.requestAnimationFrame(frame);
      },
      stop: function () {
        if (frameId) root.cancelAnimationFrame(frameId);
        frameId = 0;
        if (resizeObserver) resizeObserver.disconnect();
        else root.removeEventListener('resize', resize);
        resizeObserver = null;
        root.document.removeEventListener('keydown', onKey);
      }
    };
  }

  class MeleeRotationDrill extends root.HTMLElement {
    constructor () {
      super();
      this.attachShadow({ mode: 'open' });
      this.shadowRoot.innerHTML = `<style>${STYLE}</style>${TEMPLATE}`;
      this._drill = null;
    }

    connectedCallback () {
      if (this.getAttribute('fonts') !== 'none') loadFonts(this.ownerDocument);
      const $ = (id) => this.shadowRoot.getElementById(id);
      const heading = this.getAttribute('heading') || 'Melee Rotation Drill';
      $('heading').textContent = heading;
      if (this.hasAttribute('eyebrow')) $('eyebrow').textContent = this.getAttribute('eyebrow');
      if (this.hasAttribute('description')) $('description').textContent = this.getAttribute('description');

      if (!this._drill) {
        const pilots = parsePilots(this.getAttribute('pilots'));
        const storage = this.getAttribute('storage-key');
        const every = Number(this.getAttribute('auto-every'));
        this._drill = createDrill(this, this.shadowRoot, {
          heading,
          example: pilots.length >= 3 && pilots.length <= 8 ? pilots : EXAMPLE.slice(),
          storageKey: storage === 'none' ? null : (storage || DEFAULT_STORAGE_KEY),
          autoEvery: every > 0 ? every : 7
        });
      }

      // Pages often keep hidden views in the DOM; animate only while this one is shown.
      if (typeof root.IntersectionObserver === 'function') {
        this._visibilityObserver = new root.IntersectionObserver((entries) => {
          if (entries.some((entry) => entry.isIntersecting)) this._drill.start();
          else this._drill.stop();
        });
        this._visibilityObserver.observe(this);
      } else {
        this._drill.start();
      }
    }

    disconnectedCallback () {
      if (this._visibilityObserver) this._visibilityObserver.disconnect();
      this._visibilityObserver = null;
      if (this._drill) this._drill.stop();
    }
  }

  root.customElements.define('melee-rotation-drill', MeleeRotationDrill);
})(typeof window !== 'undefined' ? window : undefined);
