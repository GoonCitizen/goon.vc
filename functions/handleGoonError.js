'use strict';

module.exports = async function handleGoonError (...error) {
  console.error('[GOON.VC]', '[ERROR]', ...error);
};
