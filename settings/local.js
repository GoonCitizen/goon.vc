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

  site: {
    title: 'GOON SQUAD',
    heading: 'GOON SQUAD<sup>&trade;</sup>',
    joinLabel: 'Join the Squad &raquo;',
    joinUrl: 'https://discord.com/servers/g00n-squad-1190527980120850493',
    loginLabel: '&gt; LOGIN &lt;',
    loginPath: '/sessions',
    monitorUrl: 'https://relay.goon.vc',
    monitorLabel: 'Monitor',
    discordWidgetId: '1190527980120850493',
    discordWidgetTheme: 'dark',
    discordWidgetWidth: 350,
    discordWidgetHeight: 800,
    bitcoinAddress: 'bc1qx5ktkj6utjw3vl43htvn434c9kg89m73lympr0',
    copyright: '&copy; big lol',
    viewport: 'width=500, initial-scale=1'
  }
};
