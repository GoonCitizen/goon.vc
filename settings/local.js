'use strict';

/**
 * Local settings for GOON.VC (HTML site + Hub API zipper).
 * Edit site.* to change title, Discord widget, Bitcoin, footer without touching templates.
 */
module.exports = {
  name: 'GOON.VC',

  /**
   * Upstream Fabric Hub that owns /sessions, /device-links, /services/rpc.
   * Override with FABRIC_HUB_ORIGIN (must be allowlisted — loopback or
   * https://hub.fabric.pub / https://relay.goon.vc / https://goon.vc).
   */
  hub: {
    origin: process.env.FABRIC_HUB_ORIGIN || 'https://hub.fabric.pub'
  },

  http: {
    port: Number(process.env.FABRIC_HUB_PORT || process.env.PORT || 8080) || 8080,
    interface: process.env.FABRIC_HUB_INTERFACE || process.env.FABRIC_HTTP_INTERFACE || '127.0.0.1',
    hostname: process.env.FABRIC_HUB_HOSTNAME || 'goon.vc'
  },

  /**
   * Discord Guild Scheduled Events → PERMAFLEET week board (`npm run build:schedule`).
   * The bot token is env-only (this file is tracked): DISCORD_BOT_TOKEN, or a
   * `discord.secrets.json` via DISCORD_SECRETS_FILE. Falls back to the
   * GoonCitizen desktop secrets file when present.
   */
  discord: {
    guildId: process.env.DISCORD_GUILD_ID || '1190527980120850493',
    token: process.env.DISCORD_BOT_TOKEN || null,
    secretsFile: process.env.DISCORD_SECRETS_FILE || null,
    // Member Login (OAuth2). Register <origin>/services/members/discord/callback
    // as a redirect in the Discord application; the secret is env-only.
    clientId: process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID || null,
    clientSecret: process.env.DISCORD_APP_SECRET || process.env.DISCORD_CLIENT_SECRET || null,
    redirectUri: process.env.DISCORD_REDIRECT_URI || null,
    schedule: {
      brand: process.env.DISCORD_SCHEDULE_BRAND || 'permafleet',
      // Last successful fetch; reused when Discord is unreachable.
      snapshot: 'stores/discord/scheduled-events.json'
    }
  },

  // Members, login sessions, and OAuth state (Fabric Store).
  members: {
    path: process.env.GOON_MEMBERS_STORE || 'stores/members'
  },

  // /events: scheduled events from every guild the Discord bot is in (Fabric Store cache).
  events: {
    path: process.env.GOON_EVENTS_STORE || 'stores/events'
  },

  // /services/operations: per-operation metrics from Discord gateway events (Fabric Store).
  operations: {
    path: process.env.GOON_OPERATIONS_STORE || 'stores/operations',
    file: 'contracts/operations.json',
    gateway: process.env.GOON_OPERATIONS_GATEWAY !== '0'
  },

  // /services/idlerpg: global IdleRPG presence statistic (Doorman in-process,
  // fed by the operations gateway client; Fabric Store).
  presence: {
    path: process.env.GOON_PRESENCE_STORE || 'stores/presence',
    tickMs: Number(process.env.GOON_PRESENCE_TICK_MS || 600000) || 600000,
    channels: [], // empty = every voice channel the bot can see counts
    announcements: ['1560112808283086929'] // G00N SQUAD #idlerpg
  },

  // /tournaments: templates and every tournament run from one (Fabric Store, kept forever).
  tournaments: {
    path: process.env.GOON_TOURNAMENTS_STORE || 'stores/tournaments'
  },

  // /services/leaderboards/1v1: the ladder pinned in G00N SQUAD #1v1-challenges (Fabric Store).
  // The bot needs View Channel + Read Message History there, and the Message Content intent.
  leaderboard: {
    path: process.env.GOON_LEADERBOARD_STORE || 'stores/leaderboard',
    channelId: '1229937640116064276',
    channelName: '1v1-challenges'
  },

  site: {
    title: 'GOON SQUAD',
    heading: 'GOON SQUAD<sup>&trade;</sup>',
    joinLabel: 'Join the Squad &raquo;',
    joinUrl: 'https://discord.com/servers/g00n-squad-1190527980120850493',
    loginLabel: '&gt; LOGIN &lt;',
    loginPath: '/sessions',
    discordWidgetId: '1190527980120850493',
    bitcoinAddress: 'bc1qx5ktkj6utjw3vl43htvn434c9kg89m73lympr0',
    copyright: '&copy; big lol',
    viewport: 'width=500, initial-scale=1'
  }
};
