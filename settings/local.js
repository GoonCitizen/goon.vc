'use strict';

const goonSquad = require('../contracts/goon-squad.json');

/**
 * Local settings for GOON.VC (HTML site + Hub API zipper).
 * Edit site.* to change title, Discord widget, Bitcoin, footer without touching templates.
 */
module.exports = {
  name: 'GOON.VC',

  /**
   * Upstream Fabric Hub that owns /sessions, /device-links, /services/rpc.
   * Override with FABRIC_HUB_ORIGIN (must be allowlisted — loopback or
   * https://hub.fabric.pub / https://hub.goon.vc / https://relay.goon.vc /
   * https://goon.vc). `seeds` are more Hubs, tried in order when the ones
   * before can't be reached (FABRIC_HUB_SEEDS, comma separated; empty for none).
   */
  hub: {
    origin: process.env.FABRIC_HUB_ORIGIN || 'https://hub.fabric.pub',
    seeds: (process.env.FABRIC_HUB_SEEDS ?? 'https://hub.goon.vc').split(',').map((s) => s.trim()).filter(Boolean)
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
    // as a redirect in the Discord application. Without DISCORD_APP_ID it is the
    // application that owns the bot token; the secret is DISCORD_APP_SECRET or
    // `appSecret` in the bot's discord.secrets.json (never in this file).
    clientId: process.env.DISCORD_APP_ID || process.env.DISCORD_CLIENT_ID || null,
    clientSecret: process.env.DISCORD_APP_SECRET || process.env.DISCORD_CLIENT_SECRET || null,
    redirectUri: process.env.DISCORD_REDIRECT_URI || null,
    schedule: {
      brand: process.env.DISCORD_SCHEDULE_BRAND || 'permafleet',
      // Member orgs' and squadrons' Discord servers whose events join guildId's
      // on the PERMAFLEET schedule. The bot must be in each to see their events.
      servers: process.env.DISCORD_SCHEDULE_SERVERS
        ? process.env.DISCORD_SCHEDULE_SERVERS.split(',').map((id) => id.trim()).filter(Boolean)
        : [
            '1145511542637482114', // 4M-CONTRACTORS (discord.gg/4m-contractors)
            '937681528790609970', // TRDE, "Trans-Galactic" (discord.gg/GGMQYSf5S7)
            '1439226629867044976', // AIMOS (discord.gg/aimos)
            '1200935959961817088', // Risky Business, IDBC (discord.gg/riskyb)
            '635948860459450400' // SC Shellback, SHELLBACKS org (RED ARMY; no public invite)
          ],
      // Last successful fetch; reused when Discord is unreachable.
      snapshot: 'stores/discord/scheduled-events.json'
    }
  },

  // Members, login sessions, and OAuth state (Fabric Store).
  members: {
    path: process.env.GOON_MEMBERS_STORE || 'stores/members',
    // Origins Passport may sign in to (comma list, e.g. https://goon.vc). Unset:
    // `siteUrl` in production (or when it is a loopback origin), else loopback
    // origins only. The Host header never picks one; production with nothing
    // to pin turns Passport off.
    origins: process.env.GOON_MEMBERS_ORIGINS
      ? process.env.GOON_MEMBERS_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
      : undefined,
    // New Discord sign-ins wait at /waiting until a reviewer approves them;
    // members from before reviews began count as approved. Reviewers are
    // Discord user ids (default @remaeus), DMed when someone new is waiting.
    review: {
      enabled: process.env.GOON_MEMBERS_REVIEW !== '0',
      reviewers: (process.env.GOON_MEMBERS_REVIEWERS || '420222636954615808')
        .split(',').map((id) => id.trim()).filter(Boolean)
    }
  },

  // /events: scheduled events from every guild the Discord bot is in (Fabric Store cache).
  events: {
    path: process.env.GOON_EVENTS_STORE || 'stores/events'
  },

  // /schedule: an availability poll for named people or a role, then a Discord
  // scheduled event on that server for the time the opener picks.
  schedule: {
    enabled: process.env.GOON_SCHEDULE !== '0',
    path: process.env.GOON_SCHEDULE_STORE || 'stores/schedule',
    timeZone: process.env.GOON_SCHEDULE_TZ || 'America/Chicago'
  },

  // /services/operations: per-operation metrics from Discord gateway events (Fabric Store).
  operations: {
    path: process.env.GOON_OPERATIONS_STORE || 'stores/operations',
    file: 'contracts/operations.json',
    gateway: process.env.GOON_OPERATIONS_GATEWAY !== '0'
  },

  // The one in-process Doorman (IdleRPG plugs into it) and its DM scripts, e.g.
  // `/goon setup`, which walks a server admin through connecting their server.
  // Answers are recorded per server in the Fabric Store; nothing reads them yet.
  community: {
    enabled: process.env.GOON_COMMUNITY !== '0',
    path: process.env.GOON_COMMUNITY_STORE || 'stores/community',
    scripts: 'contracts/scripts',
    // Unlocks PUT /services/doorman/scripts/<id> and GET …/<id>/results, and the
    // campaigns API. Env only (this file is tracked).
    token: process.env.GOON_SCRIPTS_TOKEN || null,
    // Campaigns: one DM to every member a filter selects (`/goon campaign`, or
    // the API). On unless GOON_CAMPAIGNS=0. Listing members needs the privileged
    // Server Members intent; Discord refuses the whole gateway connection when
    // it is asked for without being enabled in the Developer Portal (Bot →
    // Privileged Gateway Intents) first.
    campaigns: {
      enabled: process.env.GOON_CAMPAIGNS !== '0',
      path: process.env.GOON_CAMPAIGNS_STORE || 'stores/campaigns',
      intervalMs: 2000, // one DM every 2 seconds
      maxAudience: 500, // per server campaign
      guildCooldownMs: 24 * 60 * 60 * 1000, // one server campaign a day
      // Who may actually send DMs (Discord user ids). Preview stays open to
      // server managers. Default: remaeus. GOON_CAMPAIGN_SENDERS=0 sends none.
      senders: process.env.GOON_CAMPAIGN_SENDERS === '0'
        ? []
        : (process.env.GOON_CAMPAIGN_SENDERS || goonSquad.campaignSenders.join(','))
          .split(',').map((id) => id.trim()).filter(Boolean)
    }
  },

  // /services/idlerpg: global IdleRPG presence statistic (Doorman in-process,
  // fed by the operations gateway client; Fabric Store).
  presence: {
    path: process.env.GOON_PRESENCE_STORE || 'stores/presence',
    tickMs: Number(process.env.GOON_PRESENCE_TICK_MS || 600000) || 600000,
    // What earns XP: 'voice' (in a voice channel) and/or 'text' (posting keeps a
    // member present for 30 minutes). goon.vc pays voice only.
    sources: (process.env.GOON_PRESENCE_SOURCES || 'voice').split(','),
    channels: [], // empty = every voice channel the bot can see counts
    announcements: [goonSquad.channels.idlerpg.id] // G00N SQUAD #idlerpg
  },

  // /tournaments: templates and every tournament run from one (Fabric Store, kept forever).
  tournaments: {
    path: process.env.GOON_TOURNAMENTS_STORE || 'stores/tournaments',
    // Unlocks edits to finished tournaments; unset = they stay final. Env only (this file is tracked).
    password: process.env.GOON_TOURNAMENTS_PASSWORD || null
  },
  // /leagues: perpetual and seasonal Elo duel leagues (Fabric Store, kept forever).
  leagues: {
    path: process.env.GOON_LEAGUES_STORE || 'stores/leagues',
    // Unlocks edits to logged duels; unset = they stay as logged. Env only (this file is tracked).
    password: process.env.GOON_LEAGUES_PASSWORD || process.env.GOON_TOURNAMENTS_PASSWORD || null
  },
  // /operations/PERMAFLEET/votes: one vote per member org, as a Fabric Federation.
  // Orgs and their officers' accounts (discord:<id>) are in contracts/alliance.json;
  // only officers vote, signed in to goon.vc, which signs for them from its Fabric
  // key (fabric.xprv / stores/fabric).
  alliance: {
    path: process.env.GOON_ALLIANCE_STORE || 'stores/alliance',
    file: process.env.GOON_ALLIANCE_ROSTER || 'contracts/alliance.json'
  },

  // /red-army: orgs and Discord servers that have added the bot but are not yet
  // PERMAFLEET members (contracts/red-army.json). Not a vote and not a federation.
  redArmy: {
    file: process.env.GOON_RED_ARMY_ROSTER || 'contracts/red-army.json'
  },

  // /services/market: the G00N SQUAD Market forum mirrored both ways (each thread is a
  // listing), BTC prices, and 2-of-3 escrow (buyer, seller, goon.vc as arbiter) through the
  // Hub's federation mailbox. The forum is an id, exact name, or "/regex/" in discord.guildId,
  // mirrored only while @everyone can view it. The bot needs View Channel, Read Message History,
  // Send Messages in Threads, Create Posts, Manage Threads, and Manage Webhooks there
  // (/services/discord/invite?for=market) plus the Message Content intent. Escrow runs on the
  // Hub's network; set GOON_MARKET_NETWORK to refuse any other (mainnet needs allowMainnet).
  // Arbiters are account keys (discord:<id>, fabric:<pubkey>) who may rule on disputes.
  // GOON_MARKET=0 turns the market off; GOON_MARKET_SYNC=0 serves it without the forum.
  market: {
    enabled: process.env.GOON_MARKET !== '0',
    path: process.env.GOON_MARKET_STORE || 'stores/market',
    forum: process.env.GOON_MARKET_FORUM || '/market/',
    sync: process.env.GOON_MARKET_SYNC !== '0',
    webhook: true,
    network: process.env.GOON_MARKET_NETWORK || null,
    dibsHours: 24,
    payGraceHours: 24,
    deliveryDays: 7,
    confirmDays: 3,
    arbiters: (process.env.GOON_MARKET_ARBITERS || '').split(',').map((s) => s.trim()).filter(Boolean)
  },

  // Discord application commands /idlerpg and /1v1, answered on the operations gateway client.
  commands: {
    enabled: process.env.GOON_COMMANDS !== '0'
  },

  // /services/leaderboards/1v1: the ladder pinned in G00N SQUAD #1v1-challenges (Fabric Store).
  // The bot needs View Channel + Read Message History there, and the Message Content intent.
  leaderboard: {
    path: process.env.GOON_LEADERBOARD_STORE || 'stores/leaderboard',
    channelId: '1229937640116064276',
    channelName: '1v1-challenges'
  },

  // When each member of the home server last posted (author ids + times only), for check-ins
  // with members who went quiet. History is read once over REST (`npm run collect:activity`
  // reads it all with the server stopped), new posts come from the gateway, and every channel
  // is polled hourly. The bot needs View Channel + Read Message History; GOON_ACTIVITY=0 stops
  // reading history (new posts from the gateway are still noted).
  activity: {
    path: process.env.GOON_ACTIVITY_STORE || 'stores/activity',
    sync: process.env.GOON_ACTIVITY !== '0'
  },

  // Check-ins with quiet members (contracts/checkin.json). Off until someone
  // with Manage Server turns them on with `/goon checkins`; then a weekly pass.
  checkins: {
    path: process.env.GOON_CHECKINS_STORE || 'stores/checkins'
  },

  // Welcome DMs inviting new members to join PERMAFLEET (contracts/welcome.json).
  // Off until someone with Manage Server turns them on with `/goon welcome`.
  welcome: {
    path: process.env.GOON_WELCOME_STORE || 'stores/welcome'
  },

  // Members' ships from Hangar Export JSON (`/hangar import`); public totals at /services/hangar.
  hangar: {
    path: process.env.GOON_HANGAR_STORE || 'stores/hangar'
  },

  // /clips: videos and screenshots from the Discord clip channels, low-res proxies for the
  // storyboard editor, and server-side renders (Fabric Store + media on disk).
  // Channels are ids, exact names, or "/regex/" (default: names with "clip(s)"/"video(s)"/"screenshot(s)",
  // plus every media channel); threads under a matched channel are read too.
  // Needs ffmpeg + ffprobe on PATH; the bot needs View Channel + Read Message History.
  // Medal links are downloaded with yt-dlp; GOON_CLIPS_LINKS=1 (or "all") also imports
  // YouTube / Streamable / Twitch, "0" keeps every link as a source only, or list hosts.
  // Each clip's best download (up to 1080p) is kept in <store>/masters for renders, and
  // links are re-checked weekly for a better version; GOON_CLIPS_MASTERS=0 keeps proxies only.
  // Go-live announcements in #streams (GOON_CLIPS_STREAM_CHANNELS, same matchers) are followed
  // to the Twitch broadcast (VOD) once it ends, downloaded up to 720p and kept like a clip;
  // GOON_CLIPS_STREAMS=links puts VODs on the timeline as links only, "0" ignores announcements.
  // Downloads wait while the largest allowed file (1 GB, 8 GB for a VOD) would leave less than
  // GOON_CLIPS_MIN_FREE_GB (default 20) free on the disk.
  clips: {
    path: process.env.GOON_CLIPS_STORE || 'stores/clips',
    channels: process.env.GOON_CLIPS_CHANNELS
      ? process.env.GOON_CLIPS_CHANNELS.split(',').map((s) => s.trim()).filter(Boolean)
      : [
          goonSquad.channels.clips.id,
          goonSquad.channels.videos.id,
          goonSquad.channels.screenshots.id,
          '/(^|[^a-z])(clips?|videos?|screenshots?)([^a-z]|$)/'
        ],
    externalLinks: (() => {
      const links = (process.env.GOON_CLIPS_LINKS || '').trim();
      if (!links) return undefined;
      if (links === '1' || links === 'all') return true;
      if (links === '0') return false;
      return links.split(',').map((s) => s.trim()).filter(Boolean);
    })(),
    keepMasters: process.env.GOON_CLIPS_MASTERS !== '0',
    minFreeBytes: process.env.GOON_CLIPS_MIN_FREE_GB
      ? Number(process.env.GOON_CLIPS_MIN_FREE_GB) * 1024 * 1024 * 1024
      : undefined,
    streams: {
      enabled: process.env.GOON_CLIPS_STREAMS !== '0',
      download: process.env.GOON_CLIPS_STREAMS !== 'links',
      channels: process.env.GOON_CLIPS_STREAM_CHANNELS
        ? process.env.GOON_CLIPS_STREAM_CHANNELS.split(',').map((s) => s.trim()).filter(Boolean)
        : [goonSquad.channels.streams.id, '/(^|[^a-z])streams?([^a-z]|$)/']
    },
    poll: process.env.GOON_CLIPS !== '0'
  },

  // Relay of G00N SQUAD public channels (@everyone can view; text / announcement,
  // not age-restricted) to the Fabric network as GoonCitizen chat packs for one
  // Federation group: set GOON_FABRIC_GROUP (and that group's contract id) from
  // GoonCitizen, then add the relay key (logged on start, GET /services/fabric)
  // to the group. Needs the Message Content intent on the bot. The key is
  // GOON_FABRIC_XPRV, else one generated once and kept in the store. The Peer
  // only dials out; GOON_FABRIC_RELAY=0 turns relaying off.
  fabric: {
    path: process.env.GOON_FABRIC_STORE || 'stores/fabric',
    xprv: process.env.GOON_FABRIC_XPRV || null,
    peers: (process.env.GOON_FABRIC_PEERS ?? 'hub.fabric.pub:7777,relay.goon.vc:7777').split(',').map((s) => s.trim()).filter(Boolean),
    group: process.env.GOON_FABRIC_GROUP || null,
    contract: process.env.GOON_FABRIC_GROUP_CONTRACT || null,
    relay: process.env.GOON_FABRIC_RELAY !== '0'
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
