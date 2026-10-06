'use strict';

const escapeHtml = require('../functions/escapeHtml');

function renderHeaderCss () {
  return `
      .site-header h1 { margin-bottom: 0.4em; }
      .site-header h1 a { text-decoration: none; }
      .site-nav {
        font-family: "Bungee", sans-serif;
        letter-spacing: 0.06em;
        margin: 0.35em 0 1.25em;
      }
      .site-nav a {
        border-bottom: 1px solid rgba(255, 255, 255, 0.35);
        text-decoration: none;
      }
      .site-nav a:hover, .site-nav a[aria-current="page"] { border-bottom-color: #fff; }
      .site-nav a[aria-current="page"] { border-bottom-width: 2px; }
      .site-nav-item + .site-nav-item::before { content: "·"; margin: 0 0.4em; }
      body.op-active .site-header, body.schedule-active .site-header { display: none; }
      .site-alliance { font-family: "Bungee", sans-serif; }`;
}

/**
 * Footer line linking the alliance page.
 * @param {string} allianceUrl
 */
function renderAllianceHtml (allianceUrl) {
  return `<div class="site-alliance"><small>Member of THE <a href="${escapeHtml(allianceUrl)}">PERMAFLEET PROTECTORATE</a></small></div>`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {Array<{ href: string, label: string }>} props.nav Labels are trusted HTML.
 */
function renderHeaderHtml (props) {
  const navHtml = props.nav
    .map((item) => `<span class="site-nav-item"><a href="${escapeHtml(item.href)}">${item.label}</a></span>`)
    .join('');
  return `<header id="site-header" class="site-header">
      <h1><a href="/">${props.heading}</a></h1>
      <p class="site-nav">${navHtml}</p>
    </header>`;
}

function renderHeaderScript () {
  return `<script type="text/javascript">
      (function () {
        var path = ((window.location.pathname || '/').replace(/\\/+$/, '') || '/').toLowerCase();
        document.querySelectorAll('.site-nav a[href^="/"]').forEach(function (a) {
          var href = a.getAttribute('href').toLowerCase();
          if (path === href || path.indexOf(href + '/') === 0) a.setAttribute('aria-current', 'page');
        });
      })();
    </script>`;
}

module.exports = {
  id: 'site-header',
  styles: renderHeaderCss,
  render: renderHeaderHtml,
  renderAlliance: renderAllianceHtml,
  script: renderHeaderScript
};
