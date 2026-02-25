'use strict';

const FabricCompiler = require('@fabric/http/types/compiler');
const GoonSite = require('./GoonSite');

/**
 * Goon.VC Compiler: uses GoonSite so the built HTML uses our custom template (types/GoonSPA.js).
 */
class GoonCompiler extends FabricCompiler {
  constructor (settings = {}) {
    super(settings);
    this.site = new GoonSite(this.settings.site || { name: 'GOON.VC', state: this.settings.state });
    return this;
  }
}

module.exports = GoonCompiler;
