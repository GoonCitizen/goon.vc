'use strict';

/**
 * Throw unless the Store's LevelDB is actually open. `@fabric/core` Store
 * creates the database without awaiting its open and only logs failures, so a
 * locked or unreadable store would otherwise "start" and drop every write.
 * @param {Object} store `@fabric/core` Store (started).
 * @returns {Promise<Object>} the store
 */
async function assertStoreOpen (store) {
  const where = (store && store.settings && store.settings.path) || 'store';
  if (!store || !store.db) throw new Error(`Could not open database at ${where}`);
  try {
    await store.db.open();
  } catch (error) {
    const cause = (error && error.cause) || error;
    const reason = cause && cause.code === 'LEVEL_LOCKED'
      ? 'it is locked by another process (is another goon.vc already running from this directory?)'
      : (cause && cause.message) || String(cause);
    throw new Error(`Could not open database at ${where}: ${reason}`, { cause: error });
  }
  return store;
}

/**
 * Start a `@fabric/core` Store and refuse to continue if its database did not open.
 * Every Store is strict: a failed LevelDB read or write rejects instead of
 * reading as a missing key or resolving as saved, so a member record, a vote,
 * or an escrow order is never silently rebuilt from empty or lost.
 * @param {Object} store
 * @returns {Promise<Object>} the store
 */
async function startStore (store) {
  if (store && store.settings) store.settings.strict = true;
  await store.start();
  return assertStoreOpen(store);
}

module.exports = startStore;
module.exports.assertStoreOpen = assertStoreOpen;
