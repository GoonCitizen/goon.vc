'use strict';

const { INK, WIDTH } = require('../functions/scheduleGraphic');
const EventsPage = require('./EventsPage');

function renderScheduleCss () {
  return `
      body.schedule-active { background: ${INK.bg}; }
      .schedule-page {
        display: none;
        margin: 0 auto;
        max-width: ${WIDTH}px;
        padding: 1.5em 1em 2em;
        color: ${INK.ink};
      }`;
}

/**
 * The PERMAFLEET week board: the same `<fabric-calendar>` as /events, pinned
 * to the home Discord server (drawn with the PERMAFLEET brand). The element
 * script comes from `EventsPage.script()`.
 * @param {Object} props
 * @param {string} props.server Home Discord server id.
 */
function renderScheduleMainHtml (props) {
  return `<main id="permafleet-schedule" class="schedule-page">
      ${EventsPage.calendar({ server: props.server })}
    </main>`;
}

module.exports = {
  id: 'permafleet-schedule',
  styles: renderScheduleCss,
  render: renderScheduleMainHtml
};
