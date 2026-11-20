'use strict';

/**
 * Who has to be approved before they can use goon.vc. Officers on record
 * (PERMAFLEET alliance officers, and named RED ARMY officers) wait for a
 * reviewer. Everyone else is approved on sign-in and can claim an RSI handle.
 */

const alliance = require('../contracts/alliance.json');
const redArmy = require('../contracts/red-army.json');

const DISCORD_ACCOUNT = /^discord:(\d{5,25})$/;

/**
 * @returns {Map<string, Array<{ symbol: string, name: string }>>}
 */
function officersByDiscord () {
  const map = new Map();
  const add = (account, symbol, name) => {
    const match = DISCORD_ACCOUNT.exec(String(account || ''));
    if (!match || !symbol) return;
    const list = map.get(match[1]) || [];
    if (!list.some((org) => org.symbol === symbol)) list.push({ symbol, name: name || symbol });
    map.set(match[1], list);
  };
  for (const org of alliance.organizations || []) {
    for (const account of org.officers || []) add(account, org.symbol, org.symbol);
  }
  for (const org of redArmy.organizations || []) {
    for (const officer of org.officers || []) add(officer && officer.account, org.symbol, org.name || org.symbol);
  }
  return map;
}

const OFFICERS = officersByDiscord();

/**
 * Org symbols this member is an officer of, from their linked Discord accounts.
 * @param {Object|null} member
 * @returns {string[]}
 */
function officerSymbols (member) {
  const symbols = [];
  for (const account of (member && member.accounts) || []) {
    if (account.platform !== 'discord') continue;
    for (const org of OFFICERS.get(String(account.id)) || []) {
      if (!symbols.includes(org.symbol)) symbols.push(org.symbol);
    }
  }
  return symbols;
}

/**
 * @param {Object|null} member
 * @returns {boolean} True when a linked Discord account is an officer on record.
 */
function memberNeedsReview (member) {
  return officerSymbols(member).length > 0;
}

module.exports = { officersByDiscord, officerSymbols, memberNeedsReview };
