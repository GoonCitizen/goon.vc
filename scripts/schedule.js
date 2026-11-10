'use strict';

/**
 * Build the PERMAFLEET (or G00N SQUAD) week-ops board from Discord Guild
 * Scheduled Events into assets/<brand>-schedule.{svg,html}.
 *
 *   npm run build:schedule
 *   npm run build:schedule -- --brand goon
 *   npm run build:schedule -- --from-json FILE   (GoonCitizen fetch output works)
 *   npm run build:schedule -- --offline          (snapshot only, no Discord)
 */

const fs = require('fs');
const path = require('path');

const settings = require('../settings/local');
const events = require('../functions/discordScheduledEvents');
const graphic = require('../functions/scheduleGraphic');
const resolveDiscordToken = require('../functions/resolveDiscordToken');

const ROOT = path.resolve(__dirname, '..');

function parseArgs (argv) {
  const args = { brand: null, fromJson: null, offline: false, outDir: null };
  const list = argv.slice(2);
  while (list.length) {
    const a = list.shift();
    if (a === '--brand') args.brand = list.shift();
    else if (a === '--from-json') args.fromJson = list.shift();
    else if (a === '--offline') args.offline = true;
    else if (a === '--out-dir') args.outDir = list.shift();
    else throw new Error(`Unknown flag: ${a}`);
  }
  return args;
}

function readSnapshot (file) {
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  const list = Array.isArray(payload) ? payload : (payload.events || []);
  return {
    guildId: payload.guildId || null,
    fetchedAt: payload.fetchedAt || null,
    events: list.map(events.serializeScheduledEvent).filter(Boolean),
    source: file
  };
}

function writeSnapshot (file, loaded) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    guildId: loaded.guildId,
    fetchedAt: loaded.fetchedAt,
    count: loaded.events.length,
    events: loaded.events
  }, null, 2) + '\n');
}

async function loadEvents (args, discord, snapshotPath) {
  if (args.fromJson) return readSnapshot(path.resolve(args.fromJson));

  if (!args.offline) {
    const auth = resolveDiscordToken(discord);
    if (auth.token) {
      const res = await events.fetchGuildScheduledEvents({
        token: auth.token,
        guildId: discord.guildId
      });
      if (res.ok) {
        console.error(`[BUILD:SCHEDULE] fetched ${res.events.length} events from Discord (token: ${auth.source})`);
        const loaded = {
          guildId: String(discord.guildId),
          fetchedAt: new Date().toISOString(),
          events: res.events,
          source: 'discord'
        };
        writeSnapshot(snapshotPath, loaded);
        return loaded;
      }
      console.error(`[BUILD:SCHEDULE] Discord fetch failed (${res.status}): ${res.error}`);
    } else {
      console.error('[BUILD:SCHEDULE] no Discord bot token (set DISCORD_BOT_TOKEN or DISCORD_SECRETS_FILE)');
    }
  }

  if (fs.existsSync(snapshotPath)) {
    console.error(`[BUILD:SCHEDULE] using snapshot ${path.relative(ROOT, snapshotPath)}`);
    return readSnapshot(snapshotPath);
  }
  throw new Error('No scheduled events: Discord unavailable and no snapshot. Try --from-json FILE.');
}

async function main () {
  const args = parseArgs(process.argv);
  const discord = Object.assign({ guildId: events.DEFAULT_GUILD_ID }, settings.discord);
  const scheduleSettings = discord.schedule || {};
  const snapshotPath = path.resolve(ROOT, scheduleSettings.snapshot || 'stores/discord/scheduled-events.json');
  const brand = graphic.resolveBrand(args.brand || scheduleSettings.brand || 'permafleet');

  const loaded = await loadEvents(args, discord, snapshotPath);
  if (!loaded.events.length) throw new Error('No scheduled events to render.');

  const schedule = events.buildWeekSchedule(loaded.events);
  const rendered = graphic.renderWeekScheduleGraphic({
    events: loaded.events,
    schedule,
    fetchedAt: loaded.fetchedAt || schedule.generatedAt,
    brand: brand.id,
    guildName: brand.title
  });

  const outDir = path.resolve(args.outDir || path.join(ROOT, 'assets'));
  fs.mkdirSync(outDir, { recursive: true });
  const svgPath = path.join(outDir, rendered.baseName + '.svg');
  const htmlPath = path.join(outDir, rendered.baseName + '.html');
  fs.writeFileSync(svgPath, rendered.svg);
  fs.writeFileSync(htmlPath, rendered.html);
  return { brand: brand.id, count: loaded.events.length, source: loaded.source, svg: svgPath, html: htmlPath };
}

main().then((output) => {
  console.log('[BUILD:SCHEDULE]', '[OUTPUT]', output);
}).catch((exception) => {
  console.error('[BUILD:SCHEDULE]', '[EXCEPTION]', exception.message || exception);
  process.exitCode = 1;
});
