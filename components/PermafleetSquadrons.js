'use strict';

const escapeHtml = require('../functions/escapeHtml');

// role / body / entry / leadsTo are trusted HTML.
const SQUADRONS = Object.freeze(require('../contracts/squadrons.json').squadrons
  .map(({ id, tier, name, role, body, entry, leadsTo, next }) => Object.freeze({ id, tier, name, role, body, entry, leadsTo, next })));

const PERMAFLEET_RSI_URL = 'https://robertsspaceindustries.com/orgs/PERMAFLEET';

function squadronPath (squadron, basePath) {
  return `${String(basePath || '').replace(/\/+$/, '')}/${squadron.id}`;
}

function plainText (html) {
  return String(html || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

function findSquadron (id) {
  return SQUADRONS.find((s) => s.id === id) || null;
}

function renderStyles () {
  return `
      .pf-page {
        --pf-void: #050A18;
        --pf-text: #E8F4FF;
        --pf-muted: #8AA4B8;
        --pf-accent: #8EBFD0;
        --pf-cyan: #00D4FF;
        --pf-cyan-soft: #7FE9FF;
        --pf-signal: #78ECFF;
        --pf-glass: rgba(10, 18, 40, 0.72);
        --pf-line: rgba(142, 191, 208, 0.22);
        display: none;
        max-width: 62rem;
        margin: 0 auto;
        padding: 1.75rem 1rem 3rem;
        color: var(--pf-text);
        text-align: left;
      }
      .pf-page *, .pf-page *::before, .pf-page *::after { box-sizing: border-box; }
      .pf-page a { color: var(--pf-accent); }
      .pf-page a:hover { color: #fff; }
      .pf-page h1, .pf-page h2 { margin: 0; font-weight: 400; letter-spacing: 0.04em; text-transform: uppercase; color: #fff; text-align: center; }
      .pf-page h1 { font-size: clamp(1.6rem, 4.5vw, 2.3rem); }
      .pf-page h2 { margin-top: 2.25rem; font-size: 1.2rem; scroll-margin-top: 5rem; }
      .pf-eyebrow { margin: 0 0 0.4rem; text-align: center; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; color: var(--pf-signal); }
      .pf-intro { margin: 0.6rem auto 1.25rem; max-width: 38rem; text-align: center; color: var(--pf-muted); line-height: 1.45; }
      .pf-path {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: 1rem;
        margin: 0;
        padding: 0;
        list-style: none;
        counter-reset: pf-path;
      }
      .pf-path li {
        position: relative;
        padding: 2.6rem 1.1rem 1.1rem;
        background: var(--pf-glass);
        border: 1px solid var(--pf-line);
        border-top: 3px solid var(--pf-cyan);
        counter-increment: pf-path;
      }
      .pf-path li::before {
        content: counter(pf-path, decimal-leading-zero);
        position: absolute;
        top: 0.7rem;
        left: 1.1rem;
        font-family: "Bungee", sans-serif;
        font-size: 1.2rem;
        color: var(--pf-cyan);
      }
      .pf-path h3 { margin: 0 0 0.4rem; font-family: "Rajdhani", sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #fff; }
      .pf-path p, .pf-squadron p { margin: 0; line-height: 1.45; color: var(--pf-muted); }
      .pf-path strong, .pf-squadron strong, .pf-lede strong { color: var(--pf-text); }
      .pf-page .pf-links { margin-top: 0.6rem; font-weight: 700; }
      .pf-links a { color: var(--pf-signal); text-decoration: none; }
      .pf-links a:hover { text-decoration: underline; }
      .pf-squadron-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 1rem; }
      .pf-squadron {
        display: flex;
        flex-direction: column;
        padding: 1.1rem 1.15rem 1.2rem;
        background: var(--pf-glass);
        border: 1px solid var(--pf-line);
        border-left: 3px solid var(--pf-accent);
        scroll-margin-top: 5rem;
      }
      .pf-squadron-elite { border-left-color: #ff3b3b; }
      .pf-page .pf-squadron-entry {
        align-self: flex-start;
        margin: 0 0 0.6rem;
        padding: 0.15rem 0.5rem;
        border: 1px solid rgba(142, 191, 208, 0.35);
        font-size: 0.72rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--pf-text);
      }
      .pf-page .pf-squadron-elite .pf-squadron-entry { border-color: rgba(255, 59, 59, 0.6); color: #ff8a8a; }
      .pf-squadron h3 { margin: 0; font-size: 1.1rem; letter-spacing: 0.04em; }
      .pf-squadron h3 a { color: #fff; text-decoration: none; }
      .pf-squadron h3 a:hover { color: var(--pf-signal); }
      .pf-page .pf-squadron-role { margin: 0.2rem 0 0.55rem; font-size: 0.8rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--pf-signal); }
      .pf-squadron .pf-squadron-next { margin-top: auto; padding-top: 0.75rem; color: var(--pf-text); font-weight: 600; }
      .pf-squadron-next span { margin-right: 0.35rem; font-size: 0.75rem; letter-spacing: 0.16em; text-transform: uppercase; color: var(--pf-signal); }
      .pf-squadron-page h1 { text-align: left; }
      .pf-squadron-page .pf-eyebrow, .pf-squadron-page .pf-squadron-role { text-align: left; }
      .pf-squadron-page .page-back { text-align: left; }
      .pf-lede { margin: 0.9rem 0 0; max-width: 42rem; font-size: 1.1rem; line-height: 1.5; color: var(--pf-text); }
      .pf-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 1rem; margin: 1.5rem 0 0; }
      .pf-facts div { padding: 0.85rem 1rem; background: var(--pf-glass); border: 1px solid var(--pf-line); border-left: 3px solid var(--pf-accent); }
      .pf-facts dt { font-size: 0.75rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; color: var(--pf-signal); }
      .pf-facts dd { margin: 0.3rem 0 0; font-weight: 600; line-height: 1.4; }
      .pf-squadron-page .pf-links { margin-top: 1.5rem; }
      .pf-application {
        margin-top: 1.75rem;
        padding: 1.25rem 1.2rem 1.4rem;
        background: var(--pf-glass);
        border: 1px solid var(--pf-line);
        border-left: 3px solid var(--pf-cyan);
        scroll-margin-top: 5rem;
      }
      .pf-page .pf-application h2 { margin: 0 0 0.5rem; text-align: left; font-family: "Rajdhani", sans-serif; font-size: 1rem; font-weight: 700; letter-spacing: 0.16em; }
      .pf-application > p { margin: 0 0 0.9rem; max-width: 36rem; line-height: 1.45; color: var(--pf-muted); }
      .squadron-form { display: grid; gap: 0.85rem; max-width: 36rem; }
      .squadron-field { display: grid; gap: 0.35rem; font-weight: 600; color: var(--pf-text); }
      .squadron-field em { color: #ff3b3b; font-style: normal; }
      .squadron-field input, .squadron-field textarea {
        width: 100%;
        padding: 0.6rem 0.7rem;
        font: inherit;
        font-weight: 500;
        color: var(--pf-text);
        background: rgba(5, 10, 24, 0.75);
        border: 1px solid rgba(142, 191, 208, 0.35);
        border-radius: 4px;
      }
      .squadron-field input:focus, .squadron-field textarea:focus { outline: 2px solid var(--pf-cyan); outline-offset: 1px; }
      .squadron-field textarea { resize: vertical; }
      .squadron-submit {
        justify-self: start;
        padding: 0.7rem 1.4rem;
        font-family: "Rajdhani", sans-serif;
        font-size: 1.05rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--pf-void);
        background: linear-gradient(180deg, var(--pf-cyan-soft) 0%, var(--pf-cyan) 100%);
        border: 1px solid rgba(255, 255, 255, 0.25);
        cursor: pointer;
      }
      .squadron-submit:disabled { cursor: default; opacity: 0.6; }
      .squadron-status { margin: 0; min-height: 1.2em; color: var(--pf-signal); font-weight: 600; }
      .squadron-fallback { margin: 0; font-size: 0.85rem; color: var(--pf-muted); }
      @media (max-width: 900px) {
        .pf-path { grid-template-columns: repeat(2, 1fr); }
      }
      @media (max-width: 480px) {
        .pf-path { grid-template-columns: 1fr; }
      }`;
}

function renderCard (squadron, props) {
  const path = escapeHtml(squadronPath(squadron, props.basePath));
  const next = squadron.next && findSquadron(squadron.next);
  const leadsTo = next
    ? `<a href="${escapeHtml(squadronPath(next, props.basePath))}">${squadron.leadsTo}</a>`
    : squadron.leadsTo;
  return `        <article class="pf-squadron${squadron.tier === 'elite' ? ' pf-squadron-elite' : ''}" id="${squadron.id}">
          <p class="pf-squadron-entry">${squadron.entry || ''}</p>
          <h3><a href="${path}">${squadron.name}</a></h3>
          <p class="pf-squadron-role">${squadron.role}</p>
          <p>${squadron.body}</p>${squadron.leadsTo ? `
          <p class="pf-squadron-next"><span>Leads to</span> ${leadsTo}</p>` : ''}
          <p class="pf-links"><a href="${path}">About ${squadron.name} &raquo;</a></p>
        </article>`;
}

function applyPath (basePath) {
  return `${String(basePath || '').replace(/\/+$/, '')}#squadron-apply`;
}

function renderNextSteps (props) {
  const apply = props.applicationHtml
    ? `<a href="${escapeHtml(applyPath(props.basePath))}">Apply for a squadron &raquo;</a> · `
    : '';
  return `<p class="pf-links">${apply}Not in PERMAFLEET yet? <a href="${escapeHtml(props.inviteUrl)}" target="_blank" rel="noopener noreferrer">Join on Discord &raquo;</a></p>`;
}

/**
 * The path to membership and the cross-org squadron lineup.
 * @param {Object} props
 * @param {string} props.basePath Squadrons index path.
 * @param {string} props.inviteUrl PERMAFLEET Discord invite.
 * @param {string} props.schedulePath
 * @param {string} [props.applicationHtml] The one application form for every squadron.
 * @returns {string}
 */
function renderIndexHtml (props) {
  const entry = SQUADRONS.filter((s) => s.tier !== 'elite');
  const elite = SQUADRONS.filter((s) => s.tier === 'elite');
  return `<main id="squadrons-page" class="pf-page">
      <p class="pf-eyebrow">Cross-org squadrons</p>
      <h1>Your path to membership</h1>
      <p class="pf-intro">Every PERMAFLEET member org flies in the same squadrons. Here’s how you get from your first flight to a seat in one.</p>
      <ol class="pf-path">
        <li>
          <h3>Join PERMAFLEET</h3>
          <p>Hop into the Discord and apply to the PERMAFLEET org on RSI. You start at <strong>Prospect I</strong>.</p>
          <p class="pf-links"><a href="${escapeHtml(props.inviteUrl)}" target="_blank" rel="noopener noreferrer">Discord &raquo;</a> · <a href="${PERMAFLEET_RSI_URL}" target="_blank" rel="noopener noreferrer" title="Opens the RSI org page; choose “Join us now!” there">Apply on RSI &raquo;</a></p>
        </li>
        <li>
          <h3>Fly with the fleet</h3>
          <p>Show up for weekly ops. Leadership promotes Prospects up the ranks.</p>
          <p class="pf-links"><a href="${escapeHtml(props.schedulePath)}">Weekly ops schedule &raquo;</a></p>
        </li>
        <li>
          <h3>Get selected</h3>
          <p>${props.applicationHtml ? 'Apply for a squadron. ' : ''}Leadership selects Prospects for a cross-org squadron or officer training.</p>
          <p class="pf-links">${props.applicationHtml ? '<a href="#squadron-apply">Apply &darr;</a> · ' : ''}<a href="#squadron-picks">See the squadrons &darr;</a></p>
        </li>
        <li>
          <h3>Make the elite</h3>
          <p>Perform and you go further: the top of BRAVO SQUADRON make <strong>ALPHA SQUADRON</strong>, and the best of TURTLE BRIGADE make <strong>SHELLBACK</strong>.</p>${elite.length ? `
          <p class="pf-links"><a href="#squadron-elite">Elite units &darr;</a></p>` : ''}
        </li>
      </ol>
      <h2 id="squadron-picks">Pick your squadron</h2>
      <p class="pf-intro">Each squadron focuses on one kind of gameplay.</p>
      <div class="pf-squadron-grid">
${entry.map((s) => renderCard(s, props)).join('\n')}
      </div>${props.applicationHtml ? `
      <section class="pf-application" id="squadron-apply" aria-labelledby="squadron-apply-heading">
        <h2 id="squadron-apply-heading">Apply for a squadron</h2>
        <p>One application covers every squadron. It’s also required to join G00N SQUAD, even if you already fly with PERMAFLEET.</p>
        ${props.applicationHtml}
      </section>` : ''}${elite.length ? `
      <h2 id="squadron-elite">Earned by performance</h2>
      <p class="pf-intro">Elite units aren’t applied for. Leadership selects the best pilots from each squadron.</p>
      <div class="pf-squadron-grid">
${elite.map((s) => renderCard(s, props)).join('\n')}
      </div>` : ''}
    </main>`;
}

/**
 * One squadron's page.
 * @param {Object} squadron Entry from {@link SQUADRONS}.
 * @param {Object} props
 * @param {string} props.basePath Squadrons index path.
 * @param {string} props.inviteUrl
 * @param {string} props.title Site title, for the document title.
 * @param {string} [props.applicationHtml] Present when the index carries the squadron application.
 * @returns {string}
 */
function renderSquadronHtml (squadron, props) {
  const link = (s) => `<a href="${escapeHtml(squadronPath(s, props.basePath))}">${s.name}</a>`;
  const next = squadron.next && findSquadron(squadron.next);
  const from = SQUADRONS.filter((s) => s.next === squadron.id);
  const facts = [
    ['How you get in', squadron.entry],
    from.length ? ['Drawn from', from.map(link).join(', ')] : null,
    squadron.leadsTo ? ['Leads to', next ? `<a href="${escapeHtml(squadronPath(next, props.basePath))}">${squadron.leadsTo}</a>` : squadron.leadsTo] : null
  ].filter((fact) => fact && fact[1]);
  return `<main id="squadron-${squadron.id}" class="pf-page pf-squadron-page" data-path="${escapeHtml(squadronPath(squadron, props.basePath))}" data-title="${escapeHtml(`${plainText(squadron.name)} — ${props.title}`)}">
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Path to membership</a></p>
      <p class="pf-eyebrow">${squadron.tier === 'elite' ? 'Elite squadron' : 'Cross-org squadron'}</p>
      <h1>${squadron.name}</h1>
      <p class="pf-squadron-role">${squadron.role}</p>
      <p class="pf-lede">${squadron.body}</p>
      <dl class="pf-facts">
${facts.map(([term, value]) => `        <div><dt>${term}</dt><dd>${value}</dd></div>`).join('\n')}
      </dl>
      ${renderNextSteps(props)}
    </main>`;
}

/**
 * Link-preview fields for the index and each squadron page.
 * @param {string} basePath
 * @returns {Array<{ path: string, name: string, description: string }>}
 */
function pageEntries (basePath) {
  return SQUADRONS.map((s) => ({
    path: squadronPath(s, basePath),
    name: plainText(s.name),
    description: `${plainText(s.role)}. ${plainText(s.body)}`
  }));
}

module.exports = {
  id: 'squadrons-page',
  SQUADRONS,
  squadronPath,
  applyPath,
  pageEntries,
  styles: renderStyles,
  render: renderIndexHtml,
  renderSquadron: renderSquadronHtml
};
