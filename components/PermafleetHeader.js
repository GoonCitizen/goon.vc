'use strict';

const escapeHtml = require('../functions/escapeHtml');

function renderPermafleetHeaderCss () {
  return `
      body.pf-section { margin: 0; background: #050A18; }
      body.pf-section .site-header { display: none; }
      .pf-header { display: none; }
      body.pf-section .pf-header {
        position: sticky;
        top: 0;
        z-index: 10;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem 1.25rem;
        padding: 0.6rem 1.25rem;
        background: rgba(5, 12, 28, 0.82);
        border-bottom: 1px solid rgba(142, 191, 208, 0.28);
        backdrop-filter: blur(14px);
        -webkit-backdrop-filter: blur(14px);
        font-family: "Rajdhani", sans-serif;
        text-align: left;
      }
      .pf-header a { color: #8EBFD0; text-decoration: none; }
      .pf-header a:hover { color: #fff; }
      .pf-header-brand { display: flex; align-items: baseline; gap: 0.75rem; }
      .pf-header-home { font-size: 0.8rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
      .pf-header-brand .pf-header-name { font-family: "Bungee", sans-serif; font-size: 1.2rem; letter-spacing: 0.04em; color: #fff; }
      .pf-header-menu { display: flex; flex-wrap: wrap; align-items: center; gap: 0.25rem 1.1rem; margin: 0; padding: 0; list-style: none; }
      .pf-header-menu a {
        display: inline-block;
        padding: 0.2rem 0;
        border-bottom: 2px solid transparent;
        font-size: 0.95rem;
        font-weight: 700;
        letter-spacing: 0.14em;
        text-transform: uppercase;
      }
      .pf-header-menu a[aria-current="page"] { color: #fff; border-bottom-color: #00D4FF; }
      .pf-header-menu a.pf-header-join {
        padding: 0.3rem 0.8rem;
        border: 1px solid rgba(255, 255, 255, 0.25);
        color: #050A18;
        background: linear-gradient(180deg, #7FE9FF 0%, #00D4FF 100%);
      }
      .pf-header-menu a.pf-header-join:hover { color: #050A18; filter: brightness(1.08); }
      @media (max-width: 640px) {
        body.pf-section .pf-header { padding: 0.5rem 0.9rem; }
        .pf-header-menu { gap: 0.25rem 0.85rem; }
        .pf-header-menu a { font-size: 0.85rem; letter-spacing: 0.1em; }
      }`;
}

/**
 * Menu bar for the PERMAFLEET part of the site (overview, schedule,
 * squadrons, organizations); the router shows it instead of the site header.
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {string} props.homeLabel Trusted HTML.
 * @param {string} props.permafleetPath
 * @param {string} props.schedulePath
 * @param {string} props.squadronsPath
 * @param {string} props.organizationsPath
 * @param {string} props.inviteUrl
 * @returns {string}
 */
function renderPermafleetHeaderHtml (props) {
  const item = (href, label, match) => `<li><a href="${escapeHtml(href)}" data-match="${match}">${label}</a></li>`;
  return `<header id="permafleet-header" class="pf-header">
      <div class="pf-header-brand">
        <a class="pf-header-home" href="/">&larr; ${props.homeLabel}</a>
        <a class="pf-header-name" href="${escapeHtml(props.permafleetPath)}">${props.heading}</a>
      </div>
      <nav aria-label="PERMAFLEET">
        <ul class="pf-header-menu">
          ${item(props.permafleetPath, 'Overview', 'exact')}
          ${item(props.schedulePath, 'Schedule', 'exact')}
          ${item(props.squadronsPath, 'Squadrons', 'prefix')}
          ${item(props.organizationsPath, 'Organizations', 'prefix')}
          <li><a class="pf-header-join" href="${escapeHtml(props.inviteUrl)}" target="_blank" rel="noopener noreferrer">Join</a></li>
        </ul>
      </nav>
    </header>`;
}

function renderPermafleetHeaderScript () {
  return `<script type="text/javascript">
      (function () {
        var path = ((window.location.pathname || '/').replace(/\\/+$/, '') || '/').toLowerCase();
        document.querySelectorAll('#permafleet-header a[data-match]').forEach(function (a) {
          var href = a.getAttribute('href').toLowerCase();
          var match = a.getAttribute('data-match');
          if ((match !== 'none' && path === href) || (match === 'prefix' && path.indexOf(href + '/') === 0)) a.setAttribute('aria-current', 'page');
        });
      })();
    </script>`;
}

module.exports = {
  id: 'permafleet-header',
  styles: renderPermafleetHeaderCss,
  render: renderPermafleetHeaderHtml,
  script: renderPermafleetHeaderScript
};
