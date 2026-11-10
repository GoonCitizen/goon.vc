'use strict';

/**
 * The address that reached the reverse proxy: the last `X-Forwarded-For`
 * hop is the one the proxy added, so a client can't pick its own. The header
 * counts only from a loopback peer (the local proxy); anyone reaching this
 * process directly is keyed by their socket address.
 * @param {import('http').IncomingMessage} req
 * @returns {string}
 */
function clientKey (req) {
  const remote = String((req.socket && req.socket.remoteAddress) || '');
  const viaProxy = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  const forwarded = viaProxy
    ? String((req.headers && req.headers['x-forwarded-for']) || '').split(',').map((part) => part.trim()).filter(Boolean)
    : [];
  return forwarded.length ? forwarded[forwarded.length - 1] : (remote || 'local');
}

module.exports = clientKey;
