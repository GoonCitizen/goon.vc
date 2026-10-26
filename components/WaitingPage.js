'use strict';

const escapeHtml = require('../functions/escapeHtml');

const PAGE_SCRIPT = '/scripts/waiting.js';

function renderStyles () {
  return `
      .waiting-page { display: none; margin: 3em auto; max-width: 34em; padding: 0 1em; text-align: left; }
      .waiting-page h1 { text-align: center; }
      .waiting-page [hidden] { display: none !important; }
      .waiting-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; line-height: 1.45; margin: 1.5em 0; padding: 1em; }
      .waiting-page h2 { font-size: 1.2em; margin-top: 0; }
      .waiting-page .waiting-since { color: #999; }
      .waiting-status { min-height: 1.2em; overflow-wrap: anywhere; text-align: center; }
      .waiting-links { display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; margin-top: 1em; }`;
}

/**
 * The waiting area: members who signed in with Discord since reviews began
 * wait here until an alliance administrator approves them (services/reviews.js).
 * One section per review status, picked from `GET /services/members/session`.
 * @param {Object} props
 * @param {string} props.path
 * @param {string} props.loginPath
 * @param {string} props.joinUrl
 * @param {string} props.eventsPath
 * @param {string} props.squadronsPath
 * @param {string} props.rsiClaimPath
 * @returns {string}
 */
function renderHtml (props) {
  const join = `<a href="${escapeHtml(props.joinUrl)}">Join the G00N SQUAD Discord &raquo;</a>`;
  return `<main id="waiting-page" class="waiting-page" data-path="${escapeHtml(props.path)}">
      <h1>Waiting area</h1>
      <p id="waiting-status" class="waiting-status" role="status"></p>
      <section id="waiting-signed-out" hidden>
        <p>New members sign in with Discord, then wait here while an alliance administrator looks them over.</p>
        <p class="waiting-links"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign in</a></p>
      </section>
      <section id="waiting-pending" hidden>
        <h2>You’re in line</h2>
        <p>Thanks for signing in<span id="waiting-name"></span>. An alliance administrator reviews every new Discord sign-in and has been told you’re here. There’s nothing else to do: come back to this page to see the result.</p>
        <p class="waiting-since" id="waiting-since"></p>
        <p id="waiting-join" hidden>You’re not in our Discord yet; joining it helps. ${join}</p>
        <p class="waiting-links"><a href="${escapeHtml(props.eventsPath)}">Events</a> <a href="${escapeHtml(props.squadronsPath)}">PERMAFLEET squadrons</a></p>
      </section>
      <section id="waiting-approved" hidden>
        <h2>You’re approved</h2>
        <p>Welcome to G00N SQUAD. You can claim your Star Citizen handle next.</p>
        <p class="waiting-links"><a class="goon-button" href="${escapeHtml(props.rsiClaimPath)}">Claim your RSI profile</a> <a href="${escapeHtml(props.eventsPath)}">Events</a> <a href="/">Home</a></p>
      </section>
      <section id="waiting-denied" hidden>
        <h2>Not approved</h2>
        <p>An alliance administrator didn’t approve this sign-in. If you think that’s a mistake, ask in the G00N SQUAD Discord.</p>
        <p class="waiting-links">${join}</p>
      </section>
      <section id="waiting-none" hidden>
        <h2>Nothing to wait for yet</h2>
        <p>The waiting area is for Discord sign-ins. Link your Discord account on the login page to join it.</p>
        <p class="waiting-links"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Link Discord</a></p>
      </section>
      <section id="waiting-off" hidden>
        <h2>No waiting area right now</h2>
        <p>Sign-ins aren’t being reviewed, so you’re all set.</p>
        <p class="waiting-links"><a href="/">Home</a></p>
      </section>
    </main>`;
}

function renderScript () {
  return `<script src="${PAGE_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'waiting-page',
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
