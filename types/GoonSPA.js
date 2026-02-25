'use strict';

const FabricSPA = require('@fabric/http/types/spa');

/**
 * Goon.VC SPA: outputs the original static GOON SQUAD page (matches assets/index.original.html).
 * Edit _renderWith() below to change the page.
 */
class GoonSPA extends FabricSPA {
  /**
   * Build the full HTML document. Matches the original index.original.html.
   * @param {string} [html=''] - Ignored; output is static. Kept for API compatibility.
   * @returns {string} Full document string.
   */
  _renderWith (html = '') {
    return `<html>
  <head>
    <title>GOON SQUAD</title>
    <meta name="viewport" content="width=500, initial-scale=1" />
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Bungee&display=swap" rel="stylesheet">
    <style type="text/css">
      body { background: #333; color: #ddd; text-align: center; }
      h1, h2, h3 { font-family: "Bungee", sans-serif; font-weight: 400; font-style: normal; }
      a { color: #fff; }
      footer, footer > div { padding-top: 1em; }
    </style>
  </head>
  <body>
    <h1>GOON SQUAD<sup>&trade;</sup></h1>
    <h3><a href="https://discord.com/servers/g00n-squad-1190527980120850493">Join the Squad &raquo;</a></h3>
    <iframe src="https://discord.com/widget?id=1190527980120850493&theme=dark" width="350" height="800" allowtransparency="true" frameborder="0" sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"></iframe>
    <footer>
      <div><h3><a href="https://discord.com/servers/g00n-squad-1190527980120850493">Join the Squad &raquo;</a></h3></div>
      <div><code>bc1qx5ktkj6utjw3vl43htvn434c9kg89m73lympr0</code></div>
      <div><small>&copy; big lol</small></div>
    </footer>
  </body>
</html>
`;
  }
}

module.exports = GoonSPA;
