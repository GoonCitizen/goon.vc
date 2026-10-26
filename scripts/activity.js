'use strict';

/**
 * Read the whole message history of the home Discord server (every channel
 * and public thread the bot can read) into the activity Store (default
 * `stores/activity`): when each member last posted, for check-ins with
 * members who went quiet. Keeps author ids and times only. Safe to run
 * again: each channel's cursor is saved, so an interrupted run picks up
 * where it stopped and a finished one only reads what is new. Stop the
 * goon.vc server first (the Store allows one process at a time).
 *
 *   npm run collect:activity
 *   npm run collect:activity -- --path /tmp/activity
 */

const settings = require('../settings/local');
const Activity = require('../services/activity');

function parseArgs (argv) {
  const args = { path: null };
  const list = argv.slice(2);
  while (list.length) {
    const a = list.shift();
    if (a === '--path') args.path = list.shift();
    else throw new Error(`Unknown flag: ${a}`);
  }
  return args;
}

function log (message) {
  console.log('[ACTIVITY]', message);
}

async function main () {
  const args = parseArgs(process.argv);
  const activitySettings = settings.activity || {};
  const activity = new Activity({
    path: args.path || activitySettings.path || './stores/activity',
    discord: settings.discord || {},
    refreshOnStart: false,
    ttlMs: 0
  });
  await activity.start();
  let stopping = false;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    log('Stopping after the current page; run again to resume.');
    activity.stop().then(() => process.exit(130), () => process.exit(1));
  });
  try {
    const status = await activity.sync({ progress: log });
    log(`${status.members} members with a known last post (history from ${status.oldestPost || 'nowhere yet'}); ${status.channels.complete} of ${status.channels.tracked} channels read back to the start, ${status.channels.unreadable} the bot can't read.`);
  } finally {
    if (!stopping) await activity.stop();
  }
}

main().catch((error) => {
  console.error('[ACTIVITY]', error && error.message ? error.message : error);
  process.exit(1);
});
