'use strict';

const escapeHtml = require('../functions/escapeHtml');

const PERMAFLEET_RSI_URL = 'https://robertsspaceindustries.com/orgs/PERMAFLEET';

// Drawn from the pinned #getting-started, #alliance, #embassy, and #rules posts on the G00N SQUAD Discord.
const BENEFITS = Object.freeze([
  ['A seat on the Council', 'Your org joins PERMAFLEET’s Council of 12 and gets a profile on our Organizations page, linked to your RSI page.'],
  ['24/7 security', 'Special Operators and the quick reaction force answer in the in-game <code>PERMAFLEET</code> chat group and in <strong>#beacon</strong> on Discord.'],
  ['Events', 'Scrimmages, practices, parties, and the weekly ops. On patch days the whole alliance runs one party, with contract shares.'],
  ['Your own channel', 'A channel and role for your org in the PERMAFLEET section of the G00N SQUAD Discord, and recruiting threads in <strong>#recruiting</strong>.'],
  ['Escorts and industry', 'Miners, haulers, and crafters trade work across the alliance, and the squadrons fly escort.']
]);

// What every member organization keeps up; term is plain text, value trusted HTML ({squadronsPath} is filled in).
const EXPECTATIONS = Object.freeze([
  ['An #embassy channel', 'A text channel on your Discord where other orgs and alliance leadership can reach yours.'],
  ['A public PERMAFLEET voice channel', 'A voice channel on your Discord, open to every PERMAFLEET pilot, so anyone in the alliance can drop in and fly with you.'],
  ['The Prospect system', 'New members start at <strong>Prospect I</strong> and move up the Prospect ranks by showing up, attending scheduled events, and doing well at what they’re given. <a href="{squadronsPath}">How the ranks work &raquo;</a>']
]);

const RULES = Object.freeze([
  'No drama, no politics, no bullying.',
  'Set your Discord nickname to your in-game name.',
  'Wear the <code>[PERMAFLEET]</code> tag whenever you expect safety.',
  'Stay in the in-game <code>ALLIANCE</code> and <code>PERMAFLEET</code> chat groups.',
  'Report trouble in the ’verse right away, with as much detail as you can gather.',
  'Take grievances to <strong>#embassy</strong> on the G00N SQUAD Discord.'
]);

function renderStyles () {
  return `
      .pf-onboarding .pf-facts { margin-top: 0; }
      .pf-onboarding .pf-facts dd { font-weight: 500; color: var(--pf-muted); }
      .pf-onboarding .pf-facts dd strong { color: var(--pf-text); }
      .pf-onboarding .pf-facts dd a { font-weight: 700; color: var(--pf-signal); text-decoration: none; }
      .pf-onboarding .pf-facts dd a:hover { text-decoration: underline; }
      .pf-onboarding code, .pf-rules code { color: var(--pf-text); }
      .pf-rules {
        max-width: 38rem;
        margin: 0 auto;
        padding: 1rem 1.2rem 1rem 2.6rem;
        background: var(--pf-glass);
        border: 1px solid var(--pf-line);
        border-left: 3px solid var(--pf-cyan);
        line-height: 1.6;
      }
      .pf-rules strong { color: var(--pf-text); }
      .pf-onboarding-orgs { display: flex; flex-wrap: wrap; justify-content: center; gap: 0.5rem; margin: 0; padding: 0; list-style: none; }
      .pf-onboarding-orgs a {
        display: inline-block;
        padding: 0.3rem 0.7rem;
        border: 1px solid var(--pf-line);
        background: var(--pf-glass);
        font-weight: 700;
        letter-spacing: 0.08em;
        text-decoration: none;
      }
      .pf-onboarding-orgs a:hover { color: #fff; border-color: var(--pf-cyan); }
      .pf-onboarding > .pf-links { margin-top: 2rem; text-align: center; }`;
}

/**
 * How an organization joins the PERMAFLEET Protectorate.
 * @param {Object} props
 * @param {string} props.joinUrl G00N SQUAD Discord invite (home of #embassy).
 * @param {string} props.embassyUrl The #embassy channel.
 * @param {string} props.botInviteUrl Adds the site's bot to a Discord server.
 * @param {string} props.schedulePath
 * @param {string} props.squadronsPath
 * @param {string} props.organizationsPath
 * @param {Array<{ name: string, symbol: string, href: string }>} [props.memberOrgs]
 * @returns {string}
 */
function renderHtml (props) {
  const external = (href, label, title) => `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHtml(title)}"` : ''}>${label}</a>`;
  const orgs = props.memberOrgs || [];
  return `<main id="onboarding-page" class="pf-page pf-onboarding">
      <p class="pf-eyebrow">For organization leaders</p>
      <h1>Bring your org into the Protectorate</h1>
      <p class="pf-intro">PERMAFLEET is an alliance of organizations, together known as the Protectorate. Member orgs keep their own name, leaders, and gameplay, and fly under one tag with a 24/7 quick reaction force behind them.</p>
      <ol class="pf-path">
        <li>
          <h3>Open an embassy</h3>
          <p>Org leaders start in <strong>#embassy</strong> on the G00N SQUAD Discord. Tell alliance leadership who you are, what you fly, and who speaks for your org.</p>
          <p class="pf-links">${external(props.joinUrl, 'Join the Discord &raquo;')} · ${external(props.embassyUrl, 'Open #embassy &raquo;')}</p>
        </li>
        <li>
          <h3>Tag your pilots</h3>
          <p>Every pilot joins the <code>[PERMAFLEET]</code> org on RSI before undocking. Many of our operators shoot first and ask questions later; the tag is how they know you’re ours.</p>
          <p class="pf-links">${external(PERMAFLEET_RSI_URL, 'Apply on RSI &raquo;', 'Opens the RSI org page; choose “Join us now!” there')}</p>
        </li>
        <li>
          <h3>Name your stewards</h3>
          <p>Pick the officers who speak for your org. They get the <strong>Org Steward</strong> role and a direct line to alliance leadership. Tell us when your stewards change.</p>
        </li>
        <li>
          <h3>Set up your Discord</h3>
          <p>Open an <strong>#embassy</strong> channel and a public <strong>PERMAFLEET</strong> voice channel on your server, then add our bot so leadership can put your events on the alliance schedule.</p>
          <p>Our bot can make them for you: run <code>/goon embassy</code> and <code>/goon voice</code> in your server. <code>/goon council</code> adds a private <strong>#council</strong> where your officers settle alliance votes, and <code>/goon permafleet</code> a <strong>#permafleet</strong> channel for alliance talk.</p>
          <p class="pf-links">${external(props.botInviteUrl, 'Add our bot &raquo;')} · <a href="${escapeHtml(props.schedulePath)}">Weekly schedule &raquo;</a></p>
        </li>
      </ol>
      <h2 id="onboarding-expectations">What we expect</h2>
      <p class="pf-intro">Every member organization keeps these up.</p>
      <dl class="pf-facts">
${EXPECTATIONS.map(([term, value]) => `        <div><dt>${escapeHtml(term)}</dt><dd>${value.replace('{squadronsPath}', escapeHtml(props.squadronsPath))}</dd></div>`).join('\n')}
      </dl>
      <h2 id="onboarding-benefits">What your org gets</h2>
      <dl class="pf-facts">
${BENEFITS.map(([term, value]) => `        <div><dt>${term}</dt><dd>${value}</dd></div>`).join('\n')}
        <div><dt>Squadrons</dt><dd>Prospects from every member org can be selected for the cross-org squadrons. <a href="${escapeHtml(props.squadronsPath)}">The path to membership &raquo;</a></dd></div>
      </dl>
      <h2 id="onboarding-rules">Ground rules</h2>
      <ul class="pf-rules">
${RULES.map((rule) => `        <li>${rule}</li>`).join('\n')}
      </ul>${orgs.length ? `
      <h2 id="onboarding-members">Already in the Protectorate</h2>
      <p class="pf-intro">You’ll be flying with these orgs.</p>
      <ul class="pf-onboarding-orgs" aria-label="Member organizations">
${orgs.map((org) => `        <li><a href="${escapeHtml(org.href)}">[${escapeHtml(org.symbol)}] ${escapeHtml(org.name)}</a></li>`).join('\n')}
      </ul>` : ''}
      <p class="pf-links">Ready? ${external(props.embassyUrl, 'Talk to us in #embassy &raquo;')} · <a href="${escapeHtml(props.organizationsPath)}">Member organizations &raquo;</a></p>
    </main>`;
}

module.exports = {
  id: 'onboarding-page',
  styles: renderStyles,
  render: renderHtml
};
