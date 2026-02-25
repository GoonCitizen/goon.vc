'use strict';

const HubInterface = require('@fabric/hub/components/HubInterface');

/**
 * Interface is the main component for the GoonVC application.
 * @type {HubInterface}
 * @property {Object} settings Configuration settings.
 * @property {String} name Service name.
 * @property {Object} services Services.
 * @property {Object} clients Clients.
 * @property {Object} targets Targets.
 * @property {Object} history History.
 * @property {Object} origin Origin.
 */
class Interface extends HubInterface {
  /**
   * Create an instance of the {@link Interface} component.
   * @param {Object} props Properties for the Interface component.
   * @returns {Interface} Instance of the {@link Interface}.
   */
  constructor (props) {
    super(props);
  }

  /**
   * Start the GoonVC service.
   * @returns {GoonVC} Instance of the {@link GoonVC}.
   */
  start () {
    super.start();
  }

  /**
   * Stop the GoonVC service.
   * @returns {GoonVC} Instance of the {@link GoonVC}.
   */
  stop () {
    super.stop();
  }
}

module.exports = Interface;
