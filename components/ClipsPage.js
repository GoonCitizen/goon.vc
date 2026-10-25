'use strict';

const escapeHtml = require('../functions/escapeHtml');

const API = '/services/clips';
const LIBRARY_SCRIPT = '/scripts/clip-library.js';
const EDITOR_SCRIPT = '/scripts/clip-timeline-editor.js';

function trimBase (basePath) {
  return String(basePath).replace(/\/+$/, '');
}

/**
 * The timeline page path under the clips base path.
 * @param {string} basePath
 * @returns {string}
 */
function timelinePath (basePath) {
  return `${trimBase(basePath)}/timeline`;
}

function renderClipsCss () {
  return `
      .clips-page, .clip-timeline-page, .clip-project-page { display: none; margin: 0 auto; max-width: 1280px; padding: 0 1em 3em; text-align: left; }
      .clips-page > h1, .clips-page > .operations-intro, .clip-timeline-page > h1, .clip-project-page > h1 { text-align: center; }
      .clips-page clip-library, .clip-timeline-page clip-timeline-editor, .clip-project-page clip-timeline-editor { margin-top: 1.5em; }`;
}

function renderFooter (props) {
  return `<footer>
        <div style="padding-top: 2em;"><a class="footer-login-button" href="${escapeHtml(props.loginPath)}">${props.loginLabel}</a></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>`;
}

function dataAttributes (props) {
  return `data-api="${API}" data-base="${escapeHtml(props.basePath)}" data-timeline="${escapeHtml(timelinePath(props.basePath))}" data-login="${escapeHtml(props.loginPath)}"`;
}

/**
 * The clip library: every clip from the Discord clip channels as cards grouped
 * into recording sessions, with the project list.
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.intro Trusted HTML.
 * @param {string} props.basePath
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.copyright Trusted HTML.
 * @returns {string}
 */
function renderIndexHtml (props) {
  return `<main id="clips-page" class="clips-page" ${dataAttributes(props)}>
      <h1>${props.heading}</h1>
      <p class="operations-intro">${props.intro}</p>
      <clip-library></clip-library>
      ${renderFooter(props)}
    </main>`;
}

/**
 * One session's clips on the recording-time timeline (`<basePath>/timeline`,
 * `?session=<id>` or `?clip=<id>`).
 * @param {Object} props Same as {@link renderIndexHtml}.
 * @returns {string}
 */
function renderTimelineHtml (props) {
  return `<main id="clip-timeline-page" class="clip-timeline-page" ${dataAttributes(props)}>
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Clip library</a></p>
      <clip-timeline-editor></clip-timeline-editor>
      ${renderFooter(props)}
    </main>`;
}

/**
 * One page for every project under `<basePath>/projects/<id>`.
 * @param {Object} props Same as {@link renderIndexHtml}.
 * @returns {string}
 */
function renderProjectHtml (props) {
  return `<main id="clip-project-page" class="clip-project-page" ${dataAttributes(props)}>
      <p class="page-back"><a href="${escapeHtml(props.basePath)}">&larr; Clip library</a></p>
      <clip-timeline-editor></clip-timeline-editor>
      ${renderFooter(props)}
    </main>`;
}

/**
 * Point the element on the active clips page at the API. Other routes never
 * set `src`, so they never call the clips service.
 * @param {Object} props
 * @param {string} props.basePath
 * @returns {string}
 */
function renderClipsScript (props) {
  return `<script src="${LIBRARY_SCRIPT}" defer></script>
    <script src="${EDITOR_SCRIPT}" defer></script>
    <script type="text/javascript">
      (function () {
        var base = ${JSON.stringify(trimBase(props.basePath))};
        var path = (window.location.pathname || '/').replace(/\\/+$/, '');
        var lower = path.toLowerCase();
        var prefix = base.toLowerCase() + '/projects/';
        var params = new URLSearchParams(window.location.search);
        function setQuery (name, value) {
          var next = new URLSearchParams(window.location.search);
          if (value) next.set(name, value); else next.delete(name);
          var query = next.toString();
          window.history.replaceState(window.history.state, '', window.location.pathname + (query ? '?' + query : '') + window.location.hash);
        }
        if (lower === base.toLowerCase()) {
          var host = document.getElementById('clips-page');
          var library = host && host.querySelector('clip-library');
          if (!library) return;
          library.setAttribute('base', host.getAttribute('data-base') || base);
          library.setAttribute('timeline', host.getAttribute('data-timeline'));
          if (params.get('clip')) library.setAttribute('clip', params.get('clip'));
          library.setAttribute('src', host.getAttribute('data-api'));
          library.addEventListener('clipopen', function (event) { setQuery('clip', event.detail.id); });
          library.addEventListener('clipclose', function () { setQuery('clip', null); });
          return;
        }
        var editorHost = null;
        var project = null;
        if (lower === base.toLowerCase() + '/timeline') {
          editorHost = document.getElementById('clip-timeline-page');
        } else if (lower.indexOf(prefix) === 0 && path.length > prefix.length) {
          editorHost = document.getElementById('clip-project-page');
          project = decodeURIComponent(path.slice(prefix.length).split('/')[0]);
        }
        var editor = editorHost && editorHost.querySelector('clip-timeline-editor');
        if (!editor) return;
        editor.setAttribute('base', editorHost.getAttribute('data-base') || base);
        editor.setAttribute('login', editorHost.getAttribute('data-login') || '/sessions');
        if (project) {
          editor.setAttribute('project', project);
        } else {
          if (params.get('session')) editor.setAttribute('session', params.get('session'));
          if (params.get('clip')) editor.setAttribute('clip', params.get('clip'));
          editor.addEventListener('sessionchange', function (event) {
            setQuery('clip', null);
            setQuery('session', event.detail.id);
          });
        }
        editor.setAttribute('src', editorHost.getAttribute('data-api'));
        editor.addEventListener('projectsave', function () {
          var name = editor.shadowRoot && editor.shadowRoot.querySelector('input[name=name]');
          if (name && name.value) document.title = name.value + ' — Clips';
        });
      })();
    </script>`;
}

module.exports = {
  id: 'clips-page',
  API,
  timelinePath,
  styles: renderClipsCss,
  render: renderIndexHtml,
  renderTimeline: renderTimelineHtml,
  renderProject: renderProjectHtml,
  script: renderClipsScript
};
