'use strict';

/**
 * Refresh contracts/organizations.json from public RSI org pages.
 *
 *   npm run build:organizations
 */

const fs = require('fs');
const path = require('path');

const parseRsiOrganization = require('../functions/rsiOrganization');

const OUT = path.resolve(__dirname, '../contracts/organizations.json');

// Order follows "PERMAFLEET's Council of 12" in G00N SQUAD Discord #getting-started.
const MEMBERS = [
  { symbol: 'G00N', displayName: 'G00N SQUAD' },
  { symbol: 'INFN', displayName: 'Infinity Industries' },
  { symbol: 'TRDE', displayName: 'Trans-Galactic Trade' },
  { symbol: 'LCRP', displayName: 'Legacy Corporation' },
  { symbol: 'DOUBLEDOGZ', displayName: 'DoubleDog Delivery, Inc.' },
  { symbol: '4MCONTRACT', displayName: '4M Contractors' },
  { symbol: 'AIMOS', displayName: 'A.I.M.O.S.' }
];

async function fetchOrganization (symbol) {
  const url = `${parseRsiOrganization.RSI_ORIGIN}/orgs/${encodeURIComponent(symbol)}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'goon.vc organizations (+https://goon.vc)' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return parseRsiOrganization(await res.text(), symbol);
}

async function main () {
  const previous = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { organizations: [] };
  const organizations = [];
  for (const member of MEMBERS) {
    try {
      organizations.push(Object.assign({ displayName: member.displayName }, await fetchOrganization(member.symbol)));
      console.log(`[ORGS] ${member.symbol} ok`);
    } catch (error) {
      const kept = (previous.organizations || []).find((o) => o.symbol === member.symbol);
      if (!kept) throw error;
      console.warn(`[ORGS] ${member.symbol} failed (${error.message}); keeping previous record`);
      organizations.push(kept);
    }
  }
  const payload = {
    fetchedAt: new Date().toISOString(),
    source: parseRsiOrganization.RSI_ORIGIN,
    alliance: { name: 'PERMAFLEET', url: `${parseRsiOrganization.RSI_ORIGIN}/orgs/PERMAFLEET` },
    organizations
  };
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2) + '\n');
  console.log(`[ORGS] wrote ${organizations.length} organizations to ${path.relative(process.cwd(), OUT)}`);
}

main().catch((error) => {
  console.error('[ORGS]', error.message);
  process.exit(1);
});
