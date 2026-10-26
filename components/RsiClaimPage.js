'use strict';

const escapeHtml = require('../functions/escapeHtml');

const API = '/services/members/rsi';
const FLEET_API = '/services/hangar';
const PAGE_SCRIPT = '/scripts/rsi-claim.js';
const RSI_PROFILE_EDIT = 'https://robertsspaceindustries.com/account/profile';

function renderStyles () {
  return `
      .rsi-page { display: none; margin: 3em auto; max-width: 34em; padding: 0 1em; text-align: left; }
      .rsi-page h1, .rsi-page h2 { text-align: center; }
      .rsi-page .rsi-intro { color: #bbb; line-height: 1.45; }
      .rsi-page section { border: 1px solid rgba(255, 255, 255, 0.25); border-radius: 8px; margin: 1.5em 0; padding: 1em; }
      .rsi-page [hidden] { display: none !important; }
      .rsi-page form { display: flex; flex-wrap: wrap; gap: 0.5em; }
      .rsi-page input[type="text"] { background: #222; border: 1px solid #777; border-radius: 6px; color: #fff; flex: 1 1 12em; font-size: 1em; padding: 0.45em 0.6em; }
      .rsi-page ol { line-height: 1.5; padding-left: 1.4em; }
      .rsi-code { align-items: center; display: flex; flex-wrap: wrap; gap: 0.75em; justify-content: center; margin: 1em 0; }
      .rsi-code code { background: #111; border: 1px dashed #aaa; border-radius: 6px; font-size: 1.4em; padding: 0.3em 0.7em; }
      .rsi-status { min-height: 1.2em; overflow-wrap: anywhere; text-align: center; }
      .rsi-claimed { list-style: none; margin: 0.5em 0 0; padding: 0; }
      .rsi-claimed li { border-top: 1px solid rgba(255, 255, 255, 0.12); padding: 0.4em 0; }
      .rsi-fleet table { border-collapse: collapse; width: 100%; }
      .rsi-fleet td, .rsi-fleet th { border-top: 1px solid rgba(255, 255, 255, 0.12); padding: 0.3em 0.4em; text-align: left; }
      .rsi-fleet td.num, .rsi-fleet th.num { text-align: right; }`;
}

/**
 * The RSI claim page: a member proves an RSI handle by putting a one-time
 * `g00n:` code in that citizen's public bio. `/rsi claim` on Discord sends a
 * private link that signs the member in here. Below it, the member fleet
 * totals from `/services/hangar` (no names).
 * @param {Object} props
 * @param {string} props.path
 * @param {string} props.loginPath
 * @param {string} props.joinUrl
 * @returns {string}
 */
function renderHtml (props) {
  return `<main id="rsi-page" class="rsi-page" data-path="${escapeHtml(props.path)}" data-api="${API}" data-fleet="${FLEET_API}">
      <h1>Claim your RSI profile</h1>
      <p class="rsi-intro">Link your Star Citizen handle to your G00N SQUAD profile. You prove it’s yours by putting a short code in your public RSI bio for a minute; then you can sync your hangar with <code>/hangar</code> on Discord.</p>
      <p id="rsi-status" class="rsi-status" role="status"></p>
      <section id="rsi-signed-out" hidden>
        <p>Run <code>/rsi claim</code> in the G00N SQUAD Discord (or in a DM with our bot). It replies with a private link that signs you in here.</p>
        <p>Or <a href="${escapeHtml(props.loginPath)}">log in</a> with Discord or Passport. Not in the Squad yet? <a href="${escapeHtml(props.joinUrl)}">Join the Discord &raquo;</a></p>
      </section>
      <section id="rsi-signed-in" hidden>
        <p id="rsi-member"></p>
        <div id="rsi-claimed-box" hidden>
          <strong>Claimed</strong>
          <ul id="rsi-claimed" class="rsi-claimed"></ul>
          <p><small>You can remove the code from your RSI bio now. To claim another handle, start again below.</small></p>
        </div>
        <form id="rsi-claim-form" autocomplete="off">
          <input type="text" id="rsi-handle" name="handle" aria-label="RSI handle" placeholder="Your RSI handle" maxlength="60" required>
          <button type="submit" class="goon-button">Get a code</button>
        </form>
        <div id="rsi-pending" hidden>
          <div class="rsi-code"><code id="rsi-code"></code><button type="button" id="rsi-copy" class="goon-button">Copy</button></div>
          <ol>
            <li>Open your <a href="${RSI_PROFILE_EDIT}" target="_blank" rel="noopener noreferrer">RSI profile settings</a>.</li>
            <li>Paste the code anywhere in your <strong>Short Bio</strong> and save.</li>
            <li>Come back and press Verify. We read your <a id="rsi-citizen" href="#" target="_blank" rel="noopener noreferrer">public citizen page</a> once.</li>
          </ol>
          <p style="text-align: center;"><button type="button" id="rsi-verify" class="goon-button">Verify</button></p>
          <p><small>The code is good for 24 hours.</small></p>
        </div>
      </section>
      <section id="rsi-fleet" class="rsi-fleet" hidden>
        <h2>Member fleet</h2>
        <p id="rsi-fleet-summary" class="rsi-intro"></p>
        <table><thead><tr><th>Ship</th><th class="num">Owned</th><th class="num">Members</th></tr></thead><tbody id="rsi-fleet-models"></tbody></table>
      </section>
    </main>`;
}

function renderScript () {
  return `<script src="${PAGE_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'rsi-page',
  API,
  styles: renderStyles,
  render: renderHtml,
  script: renderScript
};
