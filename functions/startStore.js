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
 * json-pointer treats a purely numeric path token as an array index, so a
 * Discord snowflake under `/channels/<id>` (or `/clips/5001` then `/clips/5001-l0`)
 * makes the parent an array. `@fabric/core` Store then refuses any later
 * non-index key. Keep each parent in memory as a map; do not persist the empty
 * parent (child keys stay the durable records).
 * @param {Object} store
 * @param {string} path
 */
function ensureMapParents (store, path) {
  const content = store && store._state && store._state.content;
  if (!content || typeof content !== 'object') return;
  const raw = String(path || '');
  const tokens = (raw.charAt(0) === '/' ? raw.slice(1) : raw).split('/').filter(Boolean);
  if (tokens.length < 2) return;
  let node = content;
  for (let i = 0; i < tokens.length - 1; i++) {
    const token = tokens[i];
    const child = Object.prototype.hasOwnProperty.call(node, token) ? node[token] : undefined;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      node = child;
      continue;
    }
    const next = {};
    if (Array.isArray(child)) {
      for (const [key, value] of Object.entries(child)) next[key] = value;
    }
    node[token] = next;
    node = next;
  }
}

/**
 * Hold map parents around `get` / `set` so snowflake (and mixed) child keys
 * never land under an array.
 * @param {Object} store
 * @returns {Object} the store
 */
function holdMapParents (store) {
  if (!store || store._goonMapParents) return store;
  const origGet = store.get;
  const origSet = store.set;
  store.get = function (key) {
    return Promise.resolve(origGet.call(this, key)).then((value) => {
      ensureMapParents(this, key);
      return value;
    });
  };
  store.set = function (key, value) {
    ensureMapParents(this, key);
    return origSet.call(this, key, value);
  };
  store._goonMapParents = true;
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
  await assertStoreOpen(store);
  return holdMapParents(store);
}

module.exports = startStore;
module.exports.assertStoreOpen = assertStoreOpen;
module.exports.ensureMapParents = ensureMapParents;
module.exports.holdMapParents = holdMapParents;
