'use strict';

const Hub = require('@fabric/hub');
const merge = require('lodash.merge');

/**
 * GoonVC is the main service for the GoonVC application.
 * @type {Hub}
 * @property {Object} settings Configuration settings.
 * @property {String} name Service name.
 * @property {Object} services Services.
 * @property {Object} clients Clients.
 * @property {Object} targets Targets.
 * @property {Object} history History.
 * @property {Object} origin Origin.
 */
class GoonVC extends Hub {
  /**
   * Create an instance of the {@link GoonVC} service.
   * @param {Object} [settings] Settings for the GoonVC instance.
   * @returns {GoonVC} Instance of the {@link GoonVC}.
   */
  constructor (settings = {}) {
    super(settings);

    this.settings = merge({
      name: 'GOON.VC'
    }, settings);

    return this;
  }

  /**
   * Start the GoonVC service.
   * @returns {GoonVC} Instance of the {@link GoonVC}.
   */
  async start () {
    // Handle this event in your application
    // Name, Channel, Message
    this.emit('log', 'GOON.VC', 'Starting service...');

    // Return the service instance
    return this;
  }
}

module.exports = GoonVC;
