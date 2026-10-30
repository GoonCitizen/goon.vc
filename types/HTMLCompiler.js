'use strict';

const fs = require('fs');
const path = require('path');
const GoonSite = require('./GoonSite');

/**
 * Compile the GoonSPA HTML document and the browser code of its components
 * (`GoonSPA#clientScripts`, written under `scripts/` beside it); no webpack / Hub
 * UI bundle.
 */
class HTMLCompiler {
  /**
   * @param {Object} [settings]
   */
  constructor (settings = {}) {
    this.settings = settings;
    const siteConfig = settings.site || settings;
    this.site = new GoonSite(siteConfig);
  }

  /**
   * @param {string} [target]
   * @returns {Promise<boolean>}
   */
  async compileTo (target = 'assets/index.html') {
    const html = this.site.spa._renderWith('');
    const dir = path.dirname(target);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, html);
    for (const client of this.site.spa.clientScripts()) {
      const file = path.join(dir, client.src);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, client.compile());
    }
    return true;
  }
}

module.exports = HTMLCompiler;
