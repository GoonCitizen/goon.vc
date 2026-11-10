'use strict';

const FabricCompiler = require('@fabric/core/types/compiler');

class Compiler extends FabricCompiler {
  constructor (settings = {}) {
    super(settings);

    // define settings
    this.settings = Object.assign({
      ast: null,
      body: null,
      type: 'javascript',
      inputs: [],
      outputs: []
    }, settings);

    // ensure chain-ability
    return this;
  }
}

module.exports = Compiler;
