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

function readSecret (file, keys) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of keys) {
      const value = raw && typeof raw[key] === 'string' ? raw[key].trim() : '';
      if (value) return value;
    }
  } catch (_) { /* unreadable: try the next file */ }
  return null;
}

function secretsFiles (discord, opts) {
  const files = [];
  if (discord.secretsFile) files.push(path.resolve(discord.secretsFile));
  files.push(...(opts.candidates || candidateSecretsFiles(opts.env || process.env)));
  return files;
}

function findSecret (discord, opts, keys) {
  for (const file of secretsFiles(discord, opts)) {
    if (!fs.existsSync(file)) continue;
    const value = readSecret(file, keys);
    if (value) return { value, source: file };
  }
  return { value: null, source: null };
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
  const found = findSecret(discord, opts, ['token']);
  return { token: found.value, source: found.source };
}

/**
 * Resolve the Discord application's OAuth2 client secret (member login)
 * without printing it: settings / env first, then `appSecret` in the same
 * secrets files as the bot token (GoonCitizen saves it there from Settings).
 * @param {Object} [discord] settings.discord
 * @param {Object} [opts] same as {@link resolveDiscordToken}
 * @returns {{ clientSecret: string|null, source: string|null }}
 */
function resolveDiscordClientSecret (discord = {}, opts = {}) {
  const env = opts.env || process.env;
  const direct = String(discord.clientSecret || env.DISCORD_APP_SECRET || env.DISCORD_CLIENT_SECRET || '').trim();
  if (direct) return { clientSecret: direct, source: 'env' };
  const found = findSecret(discord, opts, ['appSecret', 'clientSecret']);
  return { clientSecret: found.value, source: found.source };
}

module.exports = resolveDiscordToken;
module.exports.candidateSecretsFiles = candidateSecretsFiles;
module.exports.resolveDiscordClientSecret = resolveDiscordClientSecret;
