'use strict';

module.exports = async function handleGoonDebug (...message) {
  console.log('[GOON.VC]', '[DEBUG]', ...message);
};
