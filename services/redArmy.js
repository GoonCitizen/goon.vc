'use strict';

const fs = require('fs');
const path = require('path');
const { parseRoster, report } = require('../functions/redArmy');

const BASE = '/services/red-army';

function sendJson (res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function fail (status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function readJson (file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * RED ARMY roster: named orgs plus Discord servers the bot is in that are
 * not yet PERMAFLEET members. Not a vote and not a Fabric federation.
 */
class RedArmy {
  /**
   * @param {Object} [settings]
   * @param {string} [settings.file] Roster (`contracts/red-army.json`).
   * @param {string} [settings.homeGuildId] G00N SQUAD Discord (never listed).
   * @param {Object|Function} [settings.alliance] Alliance roster, or a function returning it.
   * @param {Array<{ id: string, name?: string }>|Function} [settings.discordGuilds] Servers the bot is in (`Events#list` `guilds`).
   */
  constructor (settings = {}) {
    this.settings = Object.assign({
      file: path.resolve(__dirname, '../contracts/red-army.json'),
      homeGuildId: null,
      alliance: null,
      discordGuilds: null
    }, Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined)));
    this.error = null;
  }

  _roster () {
    try {
      const roster = parseRoster(readJson(this.settings.file));
      this.error = null;
      return roster;
    } catch (error) {
      this.error = error && error.message ? error.message : 'RED ARMY roster is not set up right now.';
      throw fail(503, this.error);
    }
  }

  async _guilds () {
    const src = this.settings.discordGuilds;
    try {
      const list = typeof src === 'function' ? await src() : src;
      return Array.isArray(list) ? list : [];
    } catch (_) {
      return [];
    }
  }

  _alliance () {
    try {
      const src = this.settings.alliance;
      const alliance = typeof src === 'function' ? src() : src;
      return alliance && alliance.organizations ? alliance : (alliance && alliance.roster) || alliance;
    } catch (_) {
      return null;
    }
  }

  /**
   * Public RED ARMY list. Always available while the roster file parses.
   * @returns {Promise<{ name: string, organizations: Array<Object>, servers: Array<Object> }>}
   */
  async report () {
    const roster = this._roster();
    return report(roster, await this._guilds(), {
      homeGuildId: this.settings.homeGuildId,
      alliance: this._alliance()
    });
  }

  async start () {
    try {
      this._roster();
    } catch (_) { /* served as 503 until the file is fixed */ }
    return this;
  }

  async stop () {
    return this;
  }

  middleware () {
    return (req, res, next) => {
      const pathname = (req.path || new URL(req.url, 'http://localhost').pathname).replace(/\/+$/, '');
      if (pathname !== BASE) return next();
      const method = String(req.method || 'GET').toUpperCase();
      if (method !== 'GET') {
        sendJson(res, 405, { error: 'Method not allowed' });
        return;
      }
      this.report().then(
        (payload) => sendJson(res, 200, payload),
        (error) => sendJson(res, error && error.status ? error.status : 500, {
          error: error && error.message ? error.message : 'RED ARMY unavailable'
        })
      );
    };
  }
}

module.exports = RedArmy;
module.exports.BASE = BASE;
