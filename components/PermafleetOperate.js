'use strict';

const escapeHtml = require('../functions/escapeHtml');

// Drawn from the pinned #getting-started, #alliance, #embassy, #permafleet,
// #beacon, and #logistics posts on the G00N SQUAD Discord, plus public
// #alliance / #permafleet chat (the standing megaparty).

const DROP_IN = Object.freeze([
  ['Voice', 'Join <strong>PERMAFLEET</strong> voice on the G00N SQUAD Discord, or the public PERMAFLEET voice channel on any member org’s server. Both are open to the alliance — drop in and fly.'],
  ['In-game chat', 'Stay in the <code>PERMAFLEET</code> and <code>ALLIANCE</code> groups. That is how the quick reaction force finds you, and how you find them.'],
  ['The tag', 'Wear the <code>[PERMAFLEET]</code> tag whenever you expect safety.']
]);

const CONCURRENT = Object.freeze([
  ['Industry', 'Mining, salvage, hauling, and crafting — often on a member org’s Discord as well as G00N.'],
  ['Training and PvP', 'Friday Night Fights, 1v1s, and squadron practice. Hop into BRAVO or the training rooms when that is the night’s work.'],
  ['Security', 'The quick reaction force answers in the in-game <code>PERMAFLEET</code> group and in <strong>#beacon</strong>. Medical beacons get taken.'],
  ['Prospect rooms', 'Newer pilots gather in the Prospect lounges and <strong>[PG] LFG</strong> on G00N. Listen in and take a seat.']
]);

function renderStyles () {
  return `
      .pf-operate .pf-facts { margin-top: 0; }
      .pf-operate .pf-facts dd { font-weight: 500; color: var(--pf-muted); }
      .pf-operate .pf-facts dd strong { color: var(--pf-text); }
      .pf-operate .pf-facts dd a { font-weight: 700; color: var(--pf-signal); text-decoration: none; }
      .pf-operate .pf-facts dd a:hover { text-decoration: underline; }
      .pf-operate code { color: var(--pf-text); }
      .pf-operate > .pf-links { margin-top: 2rem; text-align: center; }`;
}

/**
 * How PERMAFLEET flies: the standing 24/7 megaparty for pilots.
 * @param {Object} props
 * @param {string} props.joinUrl G00N SQUAD / PERMAFLEET Discord invite.
 * @param {string} props.embassyUrl The #embassy channel.
 * @param {string} props.permafleetPath
 * @param {string} props.schedulePath
 * @param {string} props.squadronsPath
 * @param {string} props.onboardingPath
 * @returns {string}
 */
function renderHtml (props) {
  const external = (href, label) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  return `<main id="operate-page" class="pf-page pf-operate">
      <p class="pf-eyebrow">How we fly</p>
      <h1>How we operate</h1>
      <p class="pf-intro">PERMAFLEET is 24/7 friends to fly with. The megaparty is the standing public party — not a calendar slot — drawn from every member org, and it stays up around the clock.</p>
      <h2 id="operate-drop-in">Drop in</h2>
      <p class="pf-intro">You do not wait for a call. You join the party that is already running.</p>
      <dl class="pf-facts">
${DROP_IN.map(([term, value]) => `        <div><dt>${escapeHtml(term)}</dt><dd>${value}</dd></div>`).join('\n')}
      </dl>
      <h2 id="operate-concurrent">Several things at once</h2>
      <p class="pf-intro">At any hour you will usually find two or three jobs going — on G00N SQUAD or on a member org’s own Discord. Hop. Do not wait for a single voice channel to fill.</p>
      <dl class="pf-facts">
${CONCURRENT.map(([term, value]) => `        <div><dt>${escapeHtml(term)}</dt><dd>${value}</dd></div>`).join('\n')}
      </dl>
      <h2 id="operate-help">Need help</h2>
      <dl class="pf-facts">
        <div><dt>#beacon</dt><dd>Sound the alarm on G00N SQUAD. Member-org Discords <strong>Follow</strong> <strong>#beacon</strong> so a call reaches the alliance, not just one server.</dd></div>
        <div><dt>Quick reaction</dt><dd>Special Operators and the QRF answer in the in-game <code>PERMAFLEET</code> chat group. Report trouble right away, with as much detail as you can gather.</dd></div>
        <div><dt>Escorts</dt><dd>If you are hauling valuable cargo, ask for an escort <strong>before</strong> you leave. Emergency response is first-come, first-served with the ships that are up.</dd></div>
      </dl>
      <h2 id="operate-schedule">Scheduled ops</h2>
      <p class="pf-intro">The weekly board is extra: day themes, training, and named events. The megaparty does not wait for it. Show up on a regular basis and you will find a role.</p>
      <p class="pf-links"><a href="${escapeHtml(props.schedulePath)}">Weekly ops schedule &raquo;</a> · <a href="${escapeHtml(props.squadronsPath)}">Your path to membership &raquo;</a></p>
      <h2 id="operate-orgs">For org leaders</h2>
      <p class="pf-intro">Member orgs keep a public PERMAFLEET voice channel so anyone in the alliance can drop in. How an organization joins, and what we expect, is on onboarding.</p>
      <p class="pf-links"><a href="${escapeHtml(props.onboardingPath)}">Bring your org into the Protectorate &raquo;</a> · ${external(props.embassyUrl, 'Talk to us in #embassy &raquo;')}</p>
      <p class="pf-links">${external(props.joinUrl, 'Join the Discord &raquo;')} · <a href="${escapeHtml(props.permafleetPath)}">PERMAFLEET overview &raquo;</a></p>
    </main>`;
}

module.exports = {
  id: 'operate-page',
  styles: renderStyles,
  render: renderHtml
};
