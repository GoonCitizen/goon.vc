'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const SECRETS_FILE = 'discord.secrets.json';

/**
 * GoonCitizen desktop secrets locations (same token the LiveRelay bot uses).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
function candidateSecretsFiles (env = process.env) {
  const home = os.homedir();
  const out = [];
  if (env.SC_SETTINGS_DIR) out.push(path.join(env.SC_SETTINGS_DIR, SECRETS_FILE));
  out.push(path.join(home, 'Library/Application Support/@rsi/star-citizen/stores/gooncitizen', SECRETS_FILE));
  out.push(path.join(home, 'Library/Application Support/GoonCitizen/stores/gooncitizen', SECRETS_FILE));
  out.push(path.join(home, '.config/@rsi/star-citizen/stores/gooncitizen', SECRETS_FILE));
  out.push(path.join(home, '.config/GoonCitizen/stores/gooncitizen', SECRETS_FILE));
  return out;
}

function readToken (file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const token = raw && typeof raw.token === 'string' ? raw.token.trim() : '';
    return token || null;
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a Discord bot token without printing it.
 * @param {Object} [discord] settings.discord
 * @param {Object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string[]} [opts.candidates] override GoonCitizen secrets locations
 * @returns {{ token: string|null, source: string|null }}
 */
function resolveDiscordToken (discord = {}, opts = {}) {
  const env = opts.env || process.env;
  const direct = String(discord.token || env.DISCORD_BOT_TOKEN || '').trim();
  if (direct) return { token: direct, source: 'env' };
  const files = [];
  if (discord.secretsFile) files.push(path.resolve(discord.secretsFile));
  files.push(...(opts.candidates || candidateSecretsFiles(env)));
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const token = readToken(file);
    if (token) return { token, source: file };
  }
  return { token: null, source: null };
}

module.exports = resolveDiscordToken;
module.exports.candidateSecretsFiles = candidateSecretsFiles;
