'use strict';

/**
 * Collect every clip ever posted in the Discord clip channels (names with
 * clip/clips/video/videos, every media channel, and the threads under them, in
 * every guild the bot is in) into the clips Store (default `stores/clips`),
 * then build the low-resolution proxies. Safe to run again: clips already
 * stored are kept, and an interrupted run picks up where it stopped. Stop the
 * goon.vc server first (the Store allows one process at a time).
 *
 *   npm run collect:clips
 *   npm run collect:clips -- --channel clips --guild 1190527980120850493  (only these)
 *   npm run collect:clips -- --days 30        (only the last 30 days)
 *   npm run collect:clips -- --no-proxies     (index only; proxies later)
 *   npm run collect:clips -- --links          (also import Medal / YouTube / Twitch links with yt-dlp)
 *   npm run collect:clips -- --retry-failed   (try every failed clip again; missing-tool failures are retried on every start)
 */

const settings = require('../settings/local');
const Clips = require('../services/clips');

function parseArgs (argv) {
  const args = { channels: [], guilds: [], days: 0, proxies: true, links: false, retryFailed: false, path: null };
  const list = argv.slice(2);
  while (list.length) {
    const a = list.shift();
    if (a === '--channel') args.channels.push(list.shift());
    else if (a === '--guild') args.guilds.push(list.shift());
    else if (a === '--days') args.days = Number(list.shift());
    else if (a === '--no-proxies') args.proxies = false;
    else if (a === '--links') args.links = true;
    else if (a === '--retry-failed') args.retryFailed = true;
    else if (a === '--path') args.path = list.shift();
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (!Number.isFinite(args.days) || args.days < 0) throw new Error('--days needs a number of days (0 = everything)');
  return args;
}

function log (message) {
  console.log('[COLLECT:CLIPS]', message);
}

async function main () {
  const args = parseArgs(process.argv);
  const discord = settings.discord || {};
  const configured = settings.clips || {};
  const guilds = args.guilds.length ? args.guilds : (configured.guilds || undefined);
  const clips = new Clips(Object.assign({}, configured, {
    path: args.path || configured.path,
    discord,
    guilds,
    channels: args.channels.length ? args.channels : configured.channels,
    mediaChannels: args.channels.length ? false : configured.mediaChannels,
    poll: false,
    refreshOnStart: false,
    backfillDays: args.days,
    maxPages: Infinity,
    externalLinks: args.links || configured.externalLinks,
    log
  }));

  try {
    await clips.start();
  } catch (error) {
    throw new Error(`Could not open the clips Store at ${clips.dirs.store} (${error.message || error}). Is the goon.vc server running? Stop it first.`);
  }

  try {
    log(`reading ${args.days ? `the last ${args.days} days of` : 'the whole history of'} ${clips.settings.channels.join(', ')}${clips.settings.mediaChannels ? ' and every media channel' : ''} (threads included) in ${guilds ? `guild ${guilds.join(', ')}` : 'every guild the bot is in'}`);
    const status = await clips.refresh({ fromStart: true });
    log(`${status.channels} channel${status.channels === 1 ? '' : 's'}, ${status.added} new clip${status.added === 1 ? '' : 's'}${status.error ? ` (errors: ${status.error})` : ''}`);
    if (!status.channels) log('no matching channel: is the bot in the guild with View Channel on the clip channels?');
    if (args.links) log(`queued ${await clips.queueLinks()} links for import (needs yt-dlp)`);
    if (args.retryFailed) log(`queued ${await clips.retryFailed({ all: true })} failed clips for another try`);
    if (args.proxies) {
      log('building proxies (needs ffmpeg + ffprobe)…');
      if (clips._processing) await clips._processing;
      await clips.processPending();
    } else {
      clips._stopped = true;
      if (clips._processing) await clips._processing;
    }
    const summary = await clips.list();
    for (const channel of summary.channels) {
      log(`#${channel.name}${channel.guild ? ` (${channel.guild})` : ''}: ${channel.clips} clips${channel.error ? `, error: ${channel.error}` : ''}`);
    }
    return summary.status;
  } finally {
    await clips.stop();
  }
}

main().then((status) => {
  log(`ready ${status.ready}, waiting ${status.pending}, failed ${status.failed}, links only ${status.linksOnly}`);
}).catch((exception) => {
  console.error('[COLLECT:CLIPS]', '[EXCEPTION]', exception.message || exception);
  process.exitCode = 1;
});
