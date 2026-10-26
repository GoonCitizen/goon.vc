'use strict';

const escapeHtml = require('../functions/escapeHtml');

const PAGE_SCRIPT = '/scripts/members.js';

function renderStyles () {
  return `
      .members-page, .member-page { display: none; margin: 3em auto; max-width: 34em; padding: 0 1em; text-align: left; }
      .members-page h1, .member-page h1 { text-align: center; }
      .members-page [hidden], .member-page [hidden] { display: none !important; }
      .members-page section, .member-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; line-height: 1.45; margin: 1.5em 0; padding: 1em; }
      .members-page h2, .member-page h2 { font-size: 1.2em; margin-top: 0; }
      .members-status { min-height: 1.2em; overflow-wrap: anywhere; text-align: center; }
      .members-note { color: #999; text-align: center; }
      .members-list { display: flex; flex-direction: column; gap: 0.75em; list-style: none; margin: 0; padding: 0; }
      .members-card { align-items: center; border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; display: flex; gap: 0.75em; padding: 0.75em 1em; text-decoration: none; }
      .members-card:hover { background: rgba(255, 255, 255, 0.06); }
      .members-card img, .member-head img { border-radius: 50%; height: 48px; width: 48px; }
      .members-card small, .member-head small { color: #999; display: block; }
      .member-head { align-items: center; display: flex; flex-direction: column; gap: 0.4em; text-align: center; }
      .member-head h1 { margin: 0; }
      .member-head img { height: 96px; width: 96px; }
      .member-accounts { list-style: none; margin: 0; padding: 0; }
      .member-accounts li { align-items: center; border-top: 1px solid rgba(255, 255, 255, 0.12); display: flex; gap: 0.5em; justify-content: space-between; padding: 0.4em 0; }
      .member-accounts small { color: #999; display: block; }
      .member-accounts .goon-button { font-size: 0.8em; margin: 0; padding: 0.35em 0.8em; }
      .member-rename-form { align-items: center; display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; }
      .member-rename-form select { background: #111; border: 1px solid rgba(255, 255, 255, 0.4); border-radius: 4px; color: #fff; font: inherit; max-width: 100%; padding: 0.45em 0.6em; }
      .member-rename-form .goon-button { margin: 0; }
      .members-links { display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; margin-top: 1em; }`;
}

/**
 * `/members` and `/members/<id>`. The directory isn't open yet: the index
 * lists only the signed-in member, and a profile shows only to its own
 * member (`GET /services/members/directory`, `…/profiles/<id>`). On their
 * profile a member links more accounts (Discord, Passport, RSI) and unlinks
 * them; a profile holds one Discord account. Its display name is picked from
 * the names those accounts carry (`nameChoices`; RSI handle or citizen name,
 * Discord display name or username) with `PATCH …/profiles/<id>`.
 * @param {Object} props
 * @param {string} props.path Directory path; profiles are `<path>/<id>`.
 * @param {string} props.loginPath
 * @param {string} props.waitingPath
 * @param {string} props.rsiClaimPath
 * @returns {string}
 */
function renderHtml (props) {
  const signIn = `<p class="members-links"><a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign in</a></p>`;
  return `<main id="members-page" class="members-page" data-path="${escapeHtml(props.path)}">
      <h1>Members</h1>
      <p id="members-status" class="members-status" role="status"></p>
      <section id="members-signed-out" hidden>
        <p>Sign in to see your member profile.</p>
        ${signIn}
      </section>
      <ul id="members-list" class="members-list" aria-label="Members" hidden></ul>
      <p id="members-note" class="members-note" hidden><small>The member directory isn’t open yet. For now, this page shows only you.</small></p>
    </main>
    <main id="member-page" class="member-page" data-base="${escapeHtml(props.path)}" data-waiting="${escapeHtml(props.waitingPath)}">
      <p id="member-status" class="members-status" role="status"></p>
      <section id="member-signed-out" hidden>
        <h2>Member profile</h2>
        <p>Sign in to see your own profile.</p>
        ${signIn}
      </section>
      <section id="member-private" hidden>
        <h2>Member profile</h2>
        <p>Member profiles are private until the member directory opens. You can see your own.</p>
        <p class="members-links"><a class="goon-button" id="member-own-link" href="${escapeHtml(props.path)}">Your profile</a></p>
      </section>
      <div id="member-profile" hidden>
        <div class="member-head">
          <img id="member-avatar" alt="" hidden>
          <h1 id="member-name"></h1>
          <small id="member-since"></small>
        </div>
        <p id="member-review" class="members-note" hidden><a href="${escapeHtml(props.waitingPath)}"></a></p>
        <section id="member-rename">
          <h2>Display name</h2>
          <p>The name the Squad sees on goon.vc. Pick one from your RSI profile or your Discord account.</p>
          <p id="member-rename-form" class="member-rename-form">
            <select id="member-rename-choice" aria-label="Display name"></select>
            <button type="button" id="member-rename-save" class="goon-button" disabled>Save</button>
          </p>
          <p id="member-rename-none" hidden>Link your Discord account or <a href="${escapeHtml(props.rsiClaimPath)}">claim your RSI handle</a> to choose a display name.</p>
          <p id="member-rename-status" class="members-status" role="status"></p>
        </section>
        <section>
          <h2>Linked accounts</h2>
          <ul id="member-accounts" class="member-accounts"></ul>
          <p id="member-rsi-none" hidden>No RSI handle yet. <a href="${escapeHtml(props.rsiClaimPath)}">Claim your RSI profile »</a></p>
        </section>
        <section id="member-add">
          <h2>Add an account</h2>
          <p>Sign in to each account you own to add it here, so the Squad sees one of you wherever you play. A profile holds one Discord account.</p>
          <p id="member-add-status" class="members-status" role="status"></p>
          <p class="members-links">
            <button type="button" id="member-add-discord" class="goon-button" disabled>Link Discord</button>
            <button type="button" id="member-add-passport" class="goon-button" disabled>Link a Passport identity</button>
            <a class="goon-button" href="${escapeHtml(props.rsiClaimPath)}">Claim an RSI handle</a>
          </p>
          <p id="member-discord-held" class="members-note" hidden><small></small></p>
        </section>
        <p class="members-links">
          <a class="goon-button" href="${escapeHtml(props.loginPath)}">Sign-in page</a>
          <a class="goon-button" href="${escapeHtml(props.rsiClaimPath)}">RSI profile and hangar</a>
        </p>
        <p class="members-note"><small>Only you can see this page.</small></p>
      </div>
    </main>`;
}

function renderScript () {
  return `<script src="${PAGE_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'members-page',
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
