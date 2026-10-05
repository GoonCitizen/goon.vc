'use strict';

const escapeHtml = require('../functions/escapeHtml');

function renderHomeCss () {
  return `
      .home-page { display: block; }
      .site-nav {
        font-family: "Bungee", sans-serif;
        letter-spacing: 0.06em;
        margin: 0.35em 0 1.25em;
      }
      .site-nav a {
        border-bottom: 1px solid rgba(255, 255, 255, 0.35);
        text-decoration: none;
      }
      .site-nav a:hover { border-bottom-color: #fff; }
      .site-nav-item + .site-nav-item::before { content: "·"; margin: 0 0.4em; }`;
}

/**
 * @param {Object} props
 * @param {string} props.heading Trusted HTML.
 * @param {Array<{ href: string, label: string }>} props.nav Labels are trusted HTML.
 * @param {string} props.joinUrl
 * @param {string} props.joinLabel Trusted HTML.
 * @param {string} props.widgetSrc
 * @param {number} props.widgetWidth
 * @param {number} props.widgetHeight
 * @param {string} props.loginPath
 * @param {string} props.loginLabel Trusted HTML.
 * @param {string} props.bitcoinAddress
 * @param {string} props.copyright Trusted HTML.
 */
function renderHomeMainHtml (props) {
  const navHtml = props.nav
    .map((item) => `<span class="site-nav-item"><a href="${escapeHtml(item.href)}">${item.label}</a></span>`)
    .join('');
  return `<main id="home-page" class="home-page">
      <h1>${props.heading}</h1>
      <p class="site-nav">${navHtml}</p>
      <h3><a href="${props.joinUrl}">${props.joinLabel}</a></h3>
      <iframe src="${props.widgetSrc}" width="${props.widgetWidth}" height="${props.widgetHeight}" allowtransparency="true" frameborder="0" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
      <footer>
        <div><h3><a href="${props.joinUrl}">${props.joinLabel}</a></h3></div>
        <div><a class="footer-login-button" href="${props.loginPath}">${props.loginLabel}</a></div>
        <div><code>${props.bitcoinAddress}</code></div>
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

module.exports = {
  id: 'home-page',
  styles: renderHomeCss,
  render: renderHomeMainHtml
};
