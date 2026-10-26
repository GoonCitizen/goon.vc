'use strict';

/**
 * Read a Hangar Export (hangar.link) JSON file: `{ type: 'hangarlink',
 * version, pledges }`, one entry per pledge on the RSI pledges pages. Each
 * pledge names the account it came from (`hangar`) and lists its `items`;
 * ships are the items of kind Ship (model in `title`, manufacturer in
 * `liner`, the owner's name for it in `itemCustomName`). Upgrades and
 * buybacks are skipped, and prices, pledge ids, dates, and everything else
 * are never read or kept.
 */

const { sanitizeHandle } = require('./rsiCitizen');

const MAX_PLEDGES = 5000;
const MAX_SHIPS = 2000;
const MAX_TEXT = 80;
const SHIP_KINDS = /^(ship|vehicle)$/i;
const LTI = /\b(lti|lifetime)\b|^inslti$/i;

class HangarExportError extends Error {
  constructor (code, message) {
    super(message);
    this.code = code;
    this.status = 400;
  }
}

function text (value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const out = String(value).replace(/\s+/g, ' ').trim();
  return out ? out.slice(0, MAX_TEXT) : null;
}

// "Anvil Aerospace (ANVL)" → "Anvil Aerospace"
function maker (value) {
  return value ? value.replace(/\s*\([A-Z0-9]{2,6}\)\s*$/, '') || null : null;
}

function itemsOf (pledge) {
  return Array.isArray(pledge.items) ? pledge.items.filter((item) => item && typeof item === 'object') : [];
}

// `insuranceType` is `insNone`, `ins<months>`, or the lifetime code; the
// pledge's Insurance item says the same in words.
function hasLti (pledge) {
  if (typeof pledge.insuranceType === 'string' && LTI.test(pledge.insuranceType)) return true;
  return itemsOf(pledge).some((item) => /^insurance$/i.test(String(item.kind || '')) && LTI.test(String(item.title || '')));
}

function shipsOf (pledge) {
  if (pledge.buyback === true || /^upgrade$/i.test(String(pledge.pledgeType || ''))) return [];
  const lti = hasLti(pledge);
  const warbond = pledge.warbond === true;
  const out = [];
  for (const item of itemsOf(pledge)) {
    if (!SHIP_KINDS.test(String(item.kind || ''))) continue;
    const model = text(item.title);
    if (!model) continue;
    const custom = text(item.itemCustomName);
    out.push({
      model,
      manufacturer: maker(text(item.liner)),
      name: custom && custom.toLowerCase() !== model.toLowerCase() ? custom : null,
      lti,
      warbond
    });
  }
  return out;
}

/**
 * @param {*} data Parsed JSON from a Hangar Export file.
 * @returns {{ hangar: string|null, ships: Array<{ model: string, manufacturer: string|null, name: string|null, lti: boolean, warbond: boolean }>, models: number }}
 *   `hangar` is the RSI handle the pledges name, when they name one.
 * @throws {HangarExportError} `NOT_AN_EXPORT`, `HANGARS`, or `NO_SHIPS`
 */
function parseHangarExport (data) {
  if (!data || typeof data !== 'object' || data.type !== 'hangarlink' || !Array.isArray(data.pledges)) {
    throw new HangarExportError('NOT_AN_EXPORT', 'That file isn’t a Hangar Export. Attach the .json file the Hangar Export extension saved.');
  }
  const pledges = data.pledges.slice(0, MAX_PLEDGES).filter((pledge) => pledge && typeof pledge === 'object');
  const hangars = new Map();
  for (const pledge of pledges) {
    const handle = sanitizeHandle(typeof pledge.hangar === 'string' ? pledge.hangar : '');
    if (handle && !hangars.has(handle.toLowerCase())) hangars.set(handle.toLowerCase(), handle);
  }
  if (hangars.size > 1) {
    throw new HangarExportError('HANGARS', `That file holds more than one RSI account (${[...hangars.values()].join(', ')}). Export one account at a time.`);
  }
  const hangar = hangars.size ? [...hangars.values()][0] : null;
  const ships = [];
  for (const pledge of pledges) {
    for (const ship of shipsOf(pledge)) {
      if (ships.length < MAX_SHIPS) ships.push(ship);
    }
  }
  if (!ships.length) {
    throw new HangarExportError('NO_SHIPS', 'That export has no ships in it. Make sure the export finished going through every pledge page.');
  }
  return { hangar, ships, models: countModels(ships) };
}

function countModels (ships) {
  return new Set(ships.map((ship) => ship.model.toLowerCase())).size;
}

module.exports = { parseHangarExport, countModels, HangarExportError };
