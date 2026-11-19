'use strict';

/**
 * `/services/rsi` for clients that are not asking for the HTML claim page.
 * The routes are GoonCitizen's (`@rsi/star-citizen/rsi`): the index, org and
 * citizen reads, the biography claim, and verify. Browsers asking for HTML
 * at the index are answered earlier with the claim page.
 */

const rsi = require('@rsi/star-citizen/rsi');

class RsiService {
  middleware () {
    return (req, res, next) => {
      const pathname = String(req.path || '').replace(/\/+$/, '') || '/';
      rsi.handle(req, res, pathname).then((handled) => {
        if (!handled) next();
      }).catch((error) => {
        if (res.headersSent) return;
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({ error: error && error.message ? error.message : 'RSI is unavailable' }));
      });
    };
  }
}

module.exports = RsiService;
