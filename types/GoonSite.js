'use strict';

const FabricSite = require('@fabric/http/types/site');
const GoonSPA = require('./GoonSPA');

/**
 * Goon.VC Site: uses GoonSPA so the HTML template is the one in types/GoonSPA.js.
 */
class GoonSite extends FabricSite {
  constructor (settings = {}) {
    super(settings);
    this.spa = new GoonSPA(this.settings);
    return this;
  }
}

module.exports = GoonSite;
