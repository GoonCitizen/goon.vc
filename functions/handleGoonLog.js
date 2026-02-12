'use strict';

module.exports = async function handleGoonLog (...message) {
  console.log('[GOON.VC]', '[LOG]', ...message);
};
