'use strict';

const escapeHtml = require('../functions/escapeHtml');
const { DEFAULT_TIME_ZONE } = require('../functions/discordScheduledEvents');

const ELEMENT_SCRIPT = '/scripts/fabric-calendar.js';
const BOARD_PATH = '/services/events/schedule.svg';
const SUMMARY_PATH = '/services/events';

function renderEventsCss () {
  return `
      .events-page { display: none; margin: 0 auto; max-width: 1920px; padding: 1.5em 1em 3em; }
      .events-add-bot { padding-top: 2em; text-align: center; }
      .events-add-bot p { color: #999; font-size: 0.85em; margin: 0.6em 0 0; }`;
}

/**
 * The site's `<fabric-calendar>`: the live week board from the events service.
 * Every calendar on the site renders through here so they share one look,
 * one zone preference, and the stacked layout on narrow screens.
 * @param {Object} [opts]
 * @param {string} [opts.server] Pin one Discord server (no server picker).
 * @param {string} [opts.description] Replaces the board subtitle.
 * @param {boolean} [opts.syncUrl] Mirror server / zone in the query string.
 * @returns {string}
 */
function renderCalendar (opts = {}) {
  const attrs = [`board="${BOARD_PATH}"`];
  if (opts.server) attrs.push(`server="${escapeHtml(opts.server)}"`);
  else attrs.push(`src="${SUMMARY_PATH}"`);
  if (opts.description) attrs.push(`description="${escapeHtml(opts.description)}"`);
  attrs.push(
    `default-time-zone="${DEFAULT_TIME_ZONE}"`,
    'default-time-zone-label="Central (G00N SQUAD)"',
    'storage-key="goon.events.timeZone"'
  );
  if (opts.syncUrl) attrs.push('sync-url');
  return `<fabric-calendar\n        ${attrs.join('\n        ')}></fabric-calendar>`;
}

/**
 * The whole page is one `<fabric-calendar>` (assets/scripts/fabric-calendar.js);
 * its heading, description, and controls all live on the board.
 * @param {Object} props
 * @param {string} props.description Plain text.
 * @param {string} [props.inviteUrl] "Add to Discord" link (default: the redirect at /services/discord/invite).
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderEventsHtml (props) {
  return `<main id="events-page" class="events-page">
      ${renderCalendar({ description: props.description || '', syncUrl: true })}
      <footer>
        <div class="events-add-bot">
          <a class="goon-button" href="${escapeHtml(props.inviteUrl || '/services/discord/invite')}" target="_blank" rel="noopener">Add our bot to your Discord</a>
          <p>Your server’s scheduled events will show up on this calendar.</p>
        </div>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

/** Loads the element for every calendar on the page. */
function renderEventsScript () {
  return `<script src="${ELEMENT_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'events-page',
  styles: renderEventsCss,
  render: renderEventsHtml,
  calendar: renderCalendar,
  script: renderEventsScript
};
