'use strict';

/**
 * Feature flags. Flip to `true` to enable.
 */
const FEATURES = {
  // Login link in the site header. Off: it rendered, then hid itself after the
  // Hub/Discord probes on hosts without login. /sessions and footer buttons are unaffected.
  headerLogin: false
};

module.exports = {
  FEATURES
};
