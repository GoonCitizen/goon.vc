'use strict';

// Settings
const settings = require('../settings/local');

// Services
const GoonVC = require('../services/goon.vc');

// Functions
const handleGoonDebug = require('../functions/handleGoonDebug');
const handleGoonError = require('../functions/handleGoonError');
const handleGoonLog = require('../functions/handleGoonLog');
const handleGoonMessage = require('../functions/handleGoonMessage');

async function main (input = {}) {
  // Core Service
  const vc = new GoonVC(input);

  // Event Handlers
  vc.on('debug', handleGoonDebug.bind(this));
  vc.on('error', handleGoonError.bind(this));
  vc.on('log', handleGoonLog.bind(this));
  vc.on('message', handleGoonMessage.bind(this));

  // Start Service
  await vc.start();

  // Return Service Information
  return {
    id: vc.id,
    name: vc.name
  };
}

main(settings).catch((exception) => {
  console.error('[GOON.VC]', '[ERROR]', exception);
}).then((output) => {
  console.log('[GOON.VC]', '[OUTPUT]', output);
});
