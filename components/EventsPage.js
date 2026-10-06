'use strict';

const escapeHtml = require('../functions/escapeHtml');
const { DEFAULT_TIME_ZONE } = require('../functions/discordScheduledEvents');

const ELEMENT_SCRIPT = '/scripts/fabric-calendar.js';

function renderEventsCss () {
  return `
      .events-page { display: none; margin: 0 auto; max-width: 1920px; padding: 1.5em 1em 3em; }`;
}

/**
 * The whole page is one `<fabric-calendar>` (assets/scripts/fabric-calendar.js);
 * its heading, description, and controls all live on the board.
 * @param {Object} props
 * @param {string} props.description Plain text.
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 */
function renderEventsHtml (props) {
  return `<main id="events-page" class="events-page">
      <fabric-calendar
        board="/services/events/schedule.svg"
        src="/services/events"
        description="${escapeHtml(props.description || '')}"
        default-time-zone="${DEFAULT_TIME_ZONE}"
        default-time-zone-label="Central (G00N SQUAD)"
        storage-key="goon.events.timeZone"
        sync-url></fabric-calendar>
      <footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

function renderEventsScript () {
  return `<script src="${ELEMENT_SCRIPT}" defer></script>`;
}

module.exports = {
  id: 'events-page',
  styles: renderEventsCss,
  render: renderEventsHtml,
  script: renderEventsScript
};
