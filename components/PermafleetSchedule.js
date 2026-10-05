'use strict';

const escapeHtml = require('../functions/escapeHtml');
const { INK, WIDTH, HEIGHT } = require('../functions/scheduleGraphic');

function renderScheduleCss () {
  return `
      body.schedule-active { background: ${INK.bg}; }
      .schedule-page {
        display: none;
        margin: 0 auto;
        max-width: ${WIDTH}px;
        padding: 0 1em 2em;
        color: ${INK.ink};
        font-family: "Helvetica Neue", Helvetica, Arial, sans-serif;
      }
      .schedule-page a { color: ${INK.cream}; }
      .schedule-nav {
        font-family: "Bungee", sans-serif;
        letter-spacing: 0.06em;
        margin: 1em 0;
      }
      .schedule-board {
        display: block;
        width: 100%;
        height: auto;
        aspect-ratio: ${WIDTH} / ${HEIGHT};
        border: 1px solid ${INK.line};
        background: ${INK.bg};
      }
      .schedule-links { color: ${INK.muted}; font-size: 0.85rem; margin-top: 0.85em; }`;
}

/**
 * @param {Object} props
 * @param {string} props.title
 * @param {string} props.imageSrc Board SVG from `npm run build:schedule`.
 * @param {string} props.htmlSrc Full-size standalone board.
 * @param {string} props.operationPath
 * @param {string} props.joinUrl
 */
function renderScheduleMainHtml (props) {
  return `<main id="permafleet-schedule" class="schedule-page">
      <p class="schedule-nav"><a href="/">&larr; Home</a> · <a href="${escapeHtml(props.operationPath)}">PERMAFLEET</a> · <a href="${escapeHtml(props.joinUrl)}" rel="noopener noreferrer">Discord</a></p>
      <a href="${escapeHtml(props.htmlSrc)}"><img class="schedule-board" src="${escapeHtml(props.imageSrc)}" width="${WIDTH}" height="${HEIGHT}" alt="${escapeHtml(props.title)} weekly ops schedule" loading="lazy"></a>
      <p class="schedule-links">Generated from Discord scheduled events · Times in Central · <a href="${escapeHtml(props.htmlSrc)}">Full size</a> · <a href="${escapeHtml(props.imageSrc)}">SVG</a></p>
    </main>`;
}

module.exports = {
  id: 'permafleet-schedule',
  styles: renderScheduleCss,
  render: renderScheduleMainHtml
};
