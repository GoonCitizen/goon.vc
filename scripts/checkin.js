'use strict';

/**
 * Save the check-in campaigns (contracts/checkin.json) as drafts on the
 * running goon.vc server, through the campaigns API, and list every member
 * each would reach, by name. Nothing is sent: campaign DMs only go out when
 * remaeus sends them from Discord (`/goon checkins`).
 * Tiers go most inactive first: very old (120+ days since last active),
 * somewhat old (60 to 120), getting old (30 to 60); members active in the
 * last 30 days, or never seen, are left alone. Each DM is a friendly hello
 * with a Start button for the check-in script. Running it again updates open
 * drafts, skips members an earlier campaign of the same tier reached, and
 * skips anyone a check-in reached in the last `spacingDays`, so no member
 * gets more than three. Needs GOON_SCRIPTS_TOKEN and a server running with
 * GOON_CAMPAIGNS=1. `/goon checkins` does the same from Discord.
 *
 *   npm run campaigns:checkin                          (save drafts, list recipients)
 *   npm run campaigns:checkin -- --tier very-old       (only this tier)
 *   npm run campaigns:checkin -- --send <campaign>:<preview>
 *                                                      (refused: only remaeus sends DMs from Discord)
 *   npm run campaigns:checkin -- --origin https://goon.vc
 */

const settings = require('../settings/local');
const checkin = require('../functions/checkin');

const BY = 'npm run campaigns:checkin';
const HOUR = 60 * 60 * 1000;
const APPROVAL = /^([0-9a-f]{12}):([0-9a-f]{8})$/;

function parseArgs (argv) {
  const http = settings.http || {};
  const args = {
    tiers: [],
    send: [],
    at: null,
    stagger: 0,
    origin: `http://127.0.0.1:${http.port || 8080}`,
    file: checkin.FILE
  };
  const list = argv.slice(2);
  while (list.length) {
    const a = list.shift();
    if (a === '--tier') args.tiers.push(list.shift());
    else if (a === '--send') {
      const match = APPROVAL.exec(String(list.shift() || ''));
      if (!match) throw new Error('--send needs <campaign>:<preview>, as printed by a run without --send');
      args.send.push({ campaign: match[1], preview: match[2] });
    }
    else if (a === '--at') args.at = list.shift();
    else if (a === '--stagger') args.stagger = Number(list.shift());
    else if (a === '--origin') args.origin = String(list.shift() || '').replace(/\/+$/, '');
    else if (a === '--file') args.file = list.shift();
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (args.at && Number.isNaN(Date.parse(args.at))) throw new Error('--at needs a date, e.g. 2026-11-01T18:00:00-05:00');
  if (!(args.stagger >= 0)) throw new Error('--stagger needs a number of hours');
  if ((args.at || args.stagger) && !args.send.length) throw new Error('--at and --stagger apply to the previews you name with --send');
  return args;
}

function log (message) {
  console.log('[CAMPAIGNS:CHECKIN]', message);
}

async function main () {
  const args = parseArgs(process.argv);
  const token = (settings.community || {}).token;
  if (!token) throw new Error('Set GOON_SCRIPTS_TOKEN (the campaigns API token).');

  const request = async (method, url, body, auth = true) => {
    const response = await fetch(url, {
      method,
      headers: Object.assign({ 'content-type': 'application/json', accept: 'application/json' }, auth ? { authorization: `Bearer ${token}` } : {}),
      body: body === undefined ? undefined : JSON.stringify(body)
    }).catch((error) => {
      throw new Error(`Could not reach ${args.origin} (${error.cause ? error.cause.code || error.cause.message : error.message}). Is goon.vc running there?`);
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { response, json };
  };
  const api = async (method, route, body) => {
    const { response, json } = await request(method, `${args.origin}/services/doorman/campaigns${route}`, body);
    if (response.status === 404 && !json) throw new Error(`${args.origin} has no campaigns API: is it running with GOON_CAMPAIGNS=1 and GOON_SCRIPTS_TOKEN?`);
    if (!response.ok) throw Object.assign(new Error((json && json.error) || `HTTP ${response.status}`), { status: response.status });
    return json;
  };

  if (args.send.length) {
    throw new Error('Campaign DMs only go out when remaeus sends them from Discord (`/goon checkins`).');
  }

  const activity = await request('GET', `${args.origin}/services/activity`, undefined, false).catch(() => null);
  const index = activity && activity.response.ok ? activity.json : null;
  if (!index) log('Warning: no message history on this server (GET /services/activity); last active is voice presence only.');
  else if (!index.backfilled) log(`Warning: message history is still being read (${index.channels.complete} of ${index.channels.tracked} channels done); members who only post may look more inactive than they are. \`npm run collect:activity\` reads it all.`);

  const contract = checkin.load(args.file);
  const wanted = checkin.drafts(contract).filter((entry) => !args.tiers.length || args.tiers.includes(entry.tier));
  if (!wanted.length) throw new Error(`No check-in tiers${args.tiers.length ? ` named ${args.tiers.join(', ')}` : ''}`);

  const approvals = [];
  const { campaigns: existing } = await api('GET', '');
  for (const { tier, draft } of wanted) {
    const step = checkin.plan(draft, existing, { spacingDays: contract.spacingDays });
    if (step.action === 'busy' || step.action === 'keep') {
      const current = existing.find((campaign) => campaign.id === step.id);
      log(`${tier}: ${current.title} is already ${current.status} (${step.id}); left alone.`);
      continue;
    }
    const saved = step.action === 'create'
      ? await api('POST', '', Object.assign({ by: BY }, step.draft))
      : await api('PATCH', `/${step.id}`, { title: step.draft.title, content: step.draft.content, filter: step.draft.filter, by: BY });
    const preview = await api('POST', `/${saved.id}/preview`, {});
    const skipped = [
      preview.active ? `${preview.active} active more recently` : null,
      preview.inactive ? `${preview.inactive} inactive longer (an earlier tier)` : null,
      preview.unseen ? `${preview.unseen} never seen` : null,
      preview.optedOut ? `${preview.optedOut} opted out` : null,
      preview.excluded ? `${preview.excluded} already checked in with` : null
    ].filter(Boolean);
    log(`${tier}: ${step.action === 'create' ? 'saved' : 'updated'} draft ${saved.id}: reaches ${preview.reach} of ${preview.found} found${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}.`);
    (preview.recipients || []).forEach((recipient, index) => console.log(`  ${index + 1}. ${recipient.name || 'Unnamed member'}`));
    if (preview.reach > 0) approvals.push(`--send ${saved.id}:${preview.id}`);
  }
  if (!approvals.length) return log('Nobody to reach; nothing to send.');
  log(`Nothing was sent. Campaign DMs only go out when remaeus sends them from Discord (\`/goon checkins\`). Drafts: ${approvals.map((flag) => flag.replace('--send ', '')).join(', ')}.`);
}

main().catch((error) => {
  console.error('[CAMPAIGNS:CHECKIN]', error && error.message ? error.message : error);
  process.exit(1);
});
