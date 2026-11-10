'use strict';

/**
 * Sign a Market escrow payout as the buyer or seller, with your own escrow
 * key, and post it to goon.vc. Two of the three escrow keys (buyer, seller,
 * goon.vc) settle an order; goon.vc never holds yours.
 *
 * The escrow key is the account's BIP87 cosigner key, `m/87'/B'/n'/0/0` of
 * your seed's master xprv (B = 0 on mainnet, 1 elsewhere; n = --account),
 * the same key Passport shares with "Link your escrow key". Never your
 * Fabric identity key.
 *
 *   npm run market:sign -- pubkey                    (your escrow key, as goon.vc lists it)
 *   npm run market:sign -- show <order>              (what the order asks you to sign)
 *   npm run market:sign -- sign <order> [release|refund]
 *
 * The payout is rebuilt here from what it describes (escrow coin,
 * destination, amount, fee) and checked against its request id before
 * anything is signed.
 *
 * Flags: --origin https://goon.vc (default), --key-file <file> (a master
 * xprv, or JSON with `xprv`; else FABRIC_XPRV), --account <n> (default 0),
 * --network mainnet|testnet|signet|regtest (default: the Market's escrow
 * network, read from --origin), --print (print the signed frame and post
 * nothing, for signing offline and pasting on the order page).
 */

const fs = require('fs');
const { deriveAccount, normalizeAccountNetwork } = require('@fabric/core/functions/accountKeys');
const Federation = require('@fabric/core/types/federation');
const { signFrame } = require('../functions/fabricFederation');

const KINDS = ['release', 'refund'];
const USAGE = 'Usage: npm run market:sign -- pubkey | show <order> | sign <order> [release|refund]  [--origin url] [--key-file file] [--account n] [--network name] [--print]';

function parseArgs (argv) {
  const args = { command: null, positional: [], origin: 'https://goon.vc', keyFile: null, account: 0, network: null, print: false };
  const list = argv.slice(2);
  while (list.length) {
    const a = list.shift();
    if (a === '--origin') args.origin = String(list.shift() || '').replace(/\/+$/, '');
    else if (a === '--key-file') args.keyFile = list.shift();
    else if (a === '--account') {
      args.account = Number(list.shift());
      if (!Number.isInteger(args.account) || args.account < 0 || args.account >= 0x80000000) throw new Error(`--account takes a whole number.\n${USAGE}`);
    } else if (a === '--network') args.network = normalizeAccountNetwork(list.shift());
    else if (a === '--print') args.print = true;
    else if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}\n${USAGE}`);
    else if (!args.command) args.command = a;
    else args.positional.push(a);
  }
  return args;
}

function loadXprv (keyFile) {
  let xprv = process.env.FABRIC_XPRV;
  if (keyFile) {
    const text = fs.readFileSync(keyFile, 'utf8').trim();
    xprv = text.startsWith('{') ? JSON.parse(text).xprv : text;
  }
  if (!xprv) throw new Error('Set FABRIC_XPRV or pass --key-file.');
  return String(xprv).trim();
}

/** The account's escrow (BIP87 cosigner) key on the network. */
function escrowKey (xprv, account, network) {
  return deriveAccount(xprv, { account, network }).cosigner.key;
}

async function api (origin, method, route, body) {
  const response = await fetch(`${origin}/services/market${route}`, {
    method,
    headers: Object.assign({ accept: 'application/json' }, body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error((data && data.error) || `${method} ${route} failed (${response.status})`);
  return data;
}

function btc (sats) {
  return `${(Number(sats) / 1e8).toFixed(8).replace(/\.?0+$/, '')} BTC (${Number(sats).toLocaleString('en-US')} sats)`;
}

/**
 * The order's signing request, checked: the descriptor hashes to the
 * escrow id, this key is one of its signers, and each payout rebuilds to
 * its request id.
 * @returns {{ request: Object, payouts: Object[] }}
 */
async function load (args, signer) {
  const [id] = args.positional;
  if (!id) throw new Error(USAGE);
  const request = await api(args.origin, 'GET', `/orders/${encodeURIComponent(id)}/request?pubkey=${signer}`);
  const descriptor = Federation.canonicalDescriptor(request.descriptor);
  if (Federation.descriptorId(descriptor) !== request.federationId) throw new Error('The escrow descriptor does not match its id; not signing.');
  if (!Federation.isValidator(descriptor, signer)) throw new Error('This key is not one of the escrow keys. Check --account and --network.');
  const payouts = request.withdrawals.map((w) => {
    const prepared = Federation.verifyWithdrawalRequest(descriptor, w.request);
    return Object.assign({}, w, { psbtBase64: prepared.psbtBase64 });
  });
  return { request, payouts };
}

function describe (request, payouts) {
  const lines = [`Order ${request.order}: you are the ${request.role} · ${request.state} · ${request.network}`, `Escrow ${request.federationId}`];
  if (!payouts.length) lines.push('Nothing to sign yet.');
  for (const w of payouts) {
    const signed = w.signers.includes(request.role);
    lines.push(`${w.kind === 'release' ? 'Pay the seller' : 'Refund the buyer'}: ${btc(w.request.amountSats)} to ${w.request.destinationAddress} (fee ${Number(w.request.feeSats).toLocaleString('en-US')} sats) · signed by ${w.signers.join(', ') || 'nobody yet'}${signed ? ' (you have signed)' : ''}`);
  }
  return lines.join('\n');
}

async function main () {
  const args = parseArgs(process.argv);
  if (!args.command) throw new Error(USAGE);
  const xprv = loadXprv(args.keyFile);
  let network = args.network;
  if (!network) {
    const catalog = await api(args.origin, 'GET', '');
    if (!catalog.escrow || !catalog.escrow.network) throw new Error(`${args.origin} has not named its escrow network yet; pass --network.`);
    network = normalizeAccountNetwork(catalog.escrow.network);
  }
  const key = escrowKey(xprv, args.account, network);
  const signer = key.pubkey.slice(2);
  if (args.command === 'pubkey') {
    console.log(`${key.pubkey} (account ${args.account}, ${network})`);
    return;
  }
  if (args.command === 'show') {
    const { request, payouts } = await load(args, signer);
    console.log(describe(request, payouts));
    return;
  }
  if (args.command !== 'sign') throw new Error(USAGE);
  const kind = args.positional[1] ? String(args.positional[1]).toLowerCase() : null;
  if (kind && !KINDS.includes(kind)) throw new Error(USAGE);
  const { request, payouts } = await load(args, signer);
  const open = payouts.filter((w) => !w.signers.includes(request.role));
  let payout;
  if (kind) {
    payout = payouts.find((w) => w.kind === kind);
    if (!payout) throw new Error(`Order ${request.order} has no ${kind} to sign.`);
  } else if (open.length === 1) {
    payout = open[0];
  } else {
    throw new Error(open.length ? `Order ${request.order} has both a release and a refund open; name one.\n${describe(request, payouts)}` : `Nothing for you to sign.\n${describe(request, payouts)}`);
  }
  if (payout.signers.includes(request.role)) throw new Error(`You have already signed this ${payout.kind}.`);
  const { signatures } = Federation.signWithdrawal({ psbtBase64: payout.psbtBase64, privateKey: key.private });
  const { frame } = signFrame(Federation.signatureMessage(request.federationId, payout.request.requestId, signatures), key);
  console.log(`Signing: ${payout.kind === 'release' ? 'pay the seller' : 'refund the buyer'} ${btc(payout.request.amountSats)} to ${payout.request.destinationAddress}`);
  if (args.print) {
    console.log(frame);
    return;
  }
  const result = await api(args.origin, 'POST', '/messages', { frame });
  console.log(`Order ${result.order}: ${result.state} · ${result.withdrawal} signed by ${(result.signers || []).join(', ')}`);
  console.log(`${args.origin}/services/market/orders/${result.order}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
