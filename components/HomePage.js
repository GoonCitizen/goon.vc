'use strict';

function renderHomeCss () {
  return `
      .home-page { display: block; }`;
}

/**
 * Title and nav live in SiteHeader.
 * @param {Object} props
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
  return `<main id="home-page" class="home-page">
      <iframe src="${props.widgetSrc}" width="${props.widgetWidth}" height="${props.widgetHeight}" allowtransparency="true" frameborder="0" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
      <footer>
        <div><h3><a href="${props.joinUrl}">${props.joinLabel}</a></h3></div>
        <div><a class="footer-login-button" href="${props.loginPath}">${props.loginLabel}</a></div>
        <div><code>${props.bitcoinAddress}</code></div>
        ${props.alliance || ''}
        <div><small>${props.copyright}</small></div>
      </footer>
    </main>`;
}

module.exports = {
  id: 'home-page',
  styles: renderHomeCss,
  render: renderHomeMainHtml
};
