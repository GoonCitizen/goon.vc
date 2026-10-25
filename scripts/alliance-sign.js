'use strict';

/**
 * Sign a PERMAFLEET alliance vote or proposal as one of an org's officers,
 * with your own Fabric key, and post it to goon.vc. The org's alliance vote
 * follows once enough of its officers agree (contracts/alliance.json,
 * `officers` / `threshold`).
 *
 *   npm run alliance:sign -- pubkey                          (the key to list as an officer)
 *   npm run alliance:sign -- vote <proposal> yes [--org INFN]
 *   npm run alliance:sign -- propose "Adopt the charter" --summary "…" --days 7 [--org INFN]
 *   npm run alliance:sign -- member-vote <proposal> yes    (your own advisory member vote;
 *                                                           the key must be linked to your goon.vc member)
 *
 * Flags: --origin https://goon.vc (default), --key-file <file> (an xprv, or
 * JSON with `xprv`; else FABRIC_XPRV), --print (print the signed frame and
 * post nothing, for signing offline and pasting on the vote page).
 */

const fs = require('fs');
const Key = require('@fabric/core/types/key');
const federation = require('../functions/allianceFederation');

const DAY_MS = 24 * 60 * 60 * 1000;
const USAGE = 'Usage: npm run alliance:sign -- pubkey | vote <proposal> <yes|no|abstain> | member-vote <proposal> <yes|no|abstain> | propose "<title>" [--summary text] [--days n]  [--org SYMBOL] [--origin url] [--key-file file] [--print]';

function parseArgs (argv) {
  const args = { command: null, positional: [], org: null, origin: 'https://goon.vc', keyFile: null, print: false, summary: '', days: 7 };
  const list = argv.slice(2);
  while (list.length) {
    const a = list.shift();
    if (a === '--org') args.org = String(list.shift() || '').toUpperCase();
    else if (a === '--origin') args.origin = String(list.shift() || '').replace(/\/+$/, '');
    else if (a === '--key-file') args.keyFile = list.shift();
    else if (a === '--summary') args.summary = String(list.shift() || '');
    else if (a === '--days') args.days = Number(list.shift());
    else if (a === '--print') args.print = true;
    else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    else if (!args.command) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

function loadKey (keyFile) {
  let xprv = process.env.FABRIC_XPRV;
  if (keyFile) {
    const text = fs.readFileSync(keyFile, 'utf8').trim();
    xprv = text.startsWith('{') ? JSON.parse(text).xprv : text;
  }
  if (!xprv) throw new Error('Set FABRIC_XPRV or pass --key-file.');
  return new Key({ xprv: String(xprv).trim() });
}

async function api (origin, method, route, body) {
  const response = await fetch(`${origin}/services/alliance${route}`, {
    method,
    headers: Object.assign({ accept: 'application/json' }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || `${method} ${route} failed (${response.status})`);
  return data;
}

/** The org federation this key is an officer of, among `orgs` ({ symbol, id, descriptor }). */
function pickOrg (orgs, signer, wanted) {
  const mine = orgs.filter((org) => federation.isValidator(org.descriptor, signer));
  if (wanted) {
    const org = mine.find((o) => o.symbol === wanted);
    if (!org) throw new Error(`This key is not an officer of ${wanted}${mine.length ? ` (it is for ${mine.map((o) => o.symbol).join(', ')})` : ''}.`);
    return org;
  }
  if (!mine.length) throw new Error('This key is not an officer of any member org.');
  if (mine.length > 1) throw new Error(`This key is an officer of ${mine.map((o) => o.symbol).join(', ')}; pass --org.`);
  return mine[0];
}

async function main () {
  const args = parseArgs(process.argv);
  if (!args.command) throw new Error(USAGE);
  const key = loadKey(args.keyFile);
  const signer = key.pubkey.slice(2);
  if (args.command === 'pubkey') {
    console.log(`fabric:${signer}`);
    return;
  }
  let body;
  if (args.command === 'vote') {
    const [id, choice] = args.positional;
    if (!id || !federation.CHOICES.includes(String(choice || '').toLowerCase())) throw new Error(USAGE);
    const proposal = await api(args.origin, 'GET', `/proposals/${encodeURIComponent(id)}`);
    const org = pickOrg(proposal.orgFederations || [], signer, args.org);
    // Stay after this officer's last vote even if this clock is behind the one that signed it.
    let castAt = Date.now();
    for (const vote of proposal.officerVotes || []) {
      if (vote.org !== org.symbol) continue;
      const opened = federation.openFrame(vote.frame);
      if (opened.signer === signer) castAt = Math.max(castAt, Date.parse(opened.body.castAt) + 1);
    }
    body = federation.officerVoteBody(org.id, {
      allianceFederationId: proposal.federationId,
      org: org.symbol,
      proposalId: proposal.id,
      choice: choice.toLowerCase(),
      castAt: new Date(castAt).toISOString()
    });
  } else if (args.command === 'member-vote') {
    const [id, choice] = args.positional;
    if (!id || !federation.CHOICES.includes(String(choice || '').toLowerCase())) throw new Error(USAGE);
    const proposal = await api(args.origin, 'GET', `/proposals/${encodeURIComponent(id)}`);
    let castAt = Date.now();
    for (const vote of proposal.memberVotes || []) {
      if (vote.signer === signer) castAt = Math.max(castAt, Date.parse(vote.castAt) + 1);
    }
    body = federation.memberVoteBody(proposal.federationId, {
      proposalId: proposal.id,
      choice: choice.toLowerCase(),
      castAt: new Date(castAt).toISOString()
    });
  } else if (args.command === 'propose') {
    const title = String(args.positional.join(' ')).trim();
    if (!title) throw new Error(USAGE);
    if (!Number.isInteger(args.days) || args.days < 1 || args.days > 30) throw new Error('--days must be 1 to 30.');
    const overview = await api(args.origin, 'GET', '');
    if (overview.status !== 'ready') throw new Error('Alliance votes are not configured on that server.');
    const orgs = overview.federation.organizations.filter((o) => o.federation).map((o) => ({ symbol: o.symbol, id: o.federation.id, descriptor: o.federation.descriptor }));
    const org = pickOrg(orgs, signer, args.org);
    const now = Date.now();
    body = federation.officerProposalBody(org.id, {
      allianceFederationId: overview.federation.id,
      org: org.symbol,
      title,
      summary: args.summary,
      proposer: key.pubkey,
      createdAt: new Date(now).toISOString(),
      closesAt: new Date(now + args.days * DAY_MS).toISOString()
    });
  } else {
    throw new Error(USAGE);
  }
  const { frame } = federation.signFrame(body, key);
  if (args.print) {
    console.log(frame);
    return;
  }
  const result = await api(args.origin, 'POST', '/messages', { frame });
  if (body.type === federation.MESSAGE_TYPES.memberVote) {
    const m = result.members;
    console.log(`${result.title} — ${result.status} · members: ${m.yes} yes, ${m.no} no, ${m.abstain} abstain (advisory)`);
    console.log(`${args.origin}${result.path}`);
    return;
  }
  const org = (result.organizations || []).find((o) => o.symbol === body.org) || {};
  const officers = body.choice && org.officers ? ` · ${body.org} officers: ${org.officers[body.choice]} ${body.choice} of ${org.officers.threshold} needed` : '';
  console.log(`${result.title} — ${result.status}${org.choice ? ` · ${body.org} votes ${org.choice}` : ''}${officers}`);
  console.log(`${args.origin}${result.path}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
