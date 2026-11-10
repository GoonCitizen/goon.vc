'use strict';

/**
 * Read the whole G00N SQUAD Market forum (active and archived threads, every
 * reply) into the Market Store (default `stores/market`): each thread
 * becomes a listing on goon.vc. The server does the same in the background;
 * this is for a first import or a full re-read. Safe to run again: each
 * thread keeps its cursor, and fields edited on goon.vc keep their value.
 * Stop the goon.vc server first (the Market and members Stores allow one
 * process at a time).
 *
 *   npm run collect:market
 *   npm run collect:market -- --path /tmp/market --members /tmp/members
 */

const settings = require('../settings/local');
const Market = require('../services/market');
const Members = require('../services/members');

function parseArgs (argv) {
  const args = { path: null, members: null };
  const list = argv.slice(2);
  while (list.length) {
    const a = list.shift();
    if (a === '--path') args.path = list.shift();
    else if (a === '--members') args.members = list.shift();
    else throw new Error(`Unknown flag: ${a}`);
  }
  return args;
}

function log (...parts) {
  console.log('[MARKET]', parts.filter((part) => part !== 'MARKET').join(' '));
}

async function main () {
  const args = parseArgs(process.argv);
  const marketSettings = settings.market || {};
  const members = await new Members({ path: args.members || (settings.members && settings.members.path) || './stores/members' }).start();
  const market = new Market(Object.assign({}, marketSettings, {
    path: args.path || marketSettings.path || './stores/market',
    discord: settings.discord || {},
    members,
    // Read here, then stop; the server's own background passes resume from these cursors.
    sync: false,
    tickMs: 0,
    rateTtlMs: 0
  }));
  market.on('log', log);
  market.on('error', (...parts) => console.error('[MARKET]', parts.filter((part) => part !== 'MARKET').join(' ')));
  let stopping = false;
  const stop = async () => {
    await market.stop();
    await members.stop();
  };
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    log('Stopping after the current thread; run again to resume.');
    stop().then(() => process.exit(130), () => process.exit(1));
  });
  try {
    await market.start();
    const result = await market.syncForum({ archived: true });
    const forum = market.forum;
    log(`#${forum ? forum.name : 'market'}: ${result.threads} threads read, ${result.listings} listings added or changed; ${market.listings.size} listings in all.`);
  } finally {
    if (!stopping) await stop();
  }
}

main().catch((error) => {
  console.error('[MARKET]', error && error.message ? error.message : error);
  process.exit(1);
});
