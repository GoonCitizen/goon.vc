'use strict';

/**
 * Save the PERMAFLEET recruiting campaigns (contracts/recruiting.json) as
 * drafts on the running goon.vc server, through the campaigns API, and list
 * every member each would reach, by name. Nothing is sent: the run ends
 * with the exact command that sends those previews, and only that command
 * sends them (to the members listed who still qualify; a draft edited since
 * is refused).
 * Each campaign DMs members who hold the qualifying rank (Prospect IV) and
 * none of the unit's roles, with a Start button for the unit's DM script.
 * Running it again updates open drafts and skips members an earlier campaign
 * for the same unit already reached. Needs GOON_SCRIPTS_TOKEN and a server
 * running with GOON_CAMPAIGNS=1.
 *
 *   npm run campaigns:recruiting                          (save drafts, list recipients)
 *   npm run campaigns:recruiting -- --unit bravo-squadron (only this unit)
 *   npm run campaigns:recruiting -- --send <campaign>:<preview> [--send …]
 *                                                         (send what a preview listed)
 *   … --send … --at 2026-11-01T18:00:00-05:00             (schedule)
 *   npm run campaigns:recruiting -- --origin https://goon.vc
 */

const settings = require('../settings/local');
const recruiting = require('../functions/recruiting');

const BY = 'npm run campaigns:recruiting';
const APPROVAL = /^([0-9a-f]{12}):([0-9a-f]{8})$/;

function parseArgs (argv) {
  const http = settings.http || {};
  const args = {
    units: [],
    send: [],
    at: null,
    origin: `http://127.0.0.1:${http.port || 8080}`,
    file: recruiting.FILE
  };
  const list = argv.slice(2);
  while (list.length) {
    const a = list.shift();
    if (a === '--unit') args.units.push(list.shift());
    else if (a === '--send') {
      const match = APPROVAL.exec(String(list.shift() || ''));
      if (!match) throw new Error('--send needs <campaign>:<preview>, as printed by a run without --send');
      args.send.push({ campaign: match[1], preview: match[2] });
    }
    else if (a === '--at') args.at = list.shift();
    else if (a === '--origin') args.origin = String(list.shift() || '').replace(/\/+$/, '');
    else if (a === '--file') args.file = list.shift();
    else throw new Error(`Unknown flag: ${a}`);
  }
  if (args.at && Number.isNaN(Date.parse(args.at))) throw new Error('--at needs a date, e.g. 2026-11-01T18:00:00-05:00');
  if (args.at && !args.send.length) throw new Error('--at applies to the previews you name with --send');
  return args;
}

function log (message) {
  console.log('[CAMPAIGNS:RECRUITING]', message);
}

async function main () {
  const args = parseArgs(process.argv);
  const token = (settings.community || {}).token;
  if (!token) throw new Error('Set GOON_SCRIPTS_TOKEN (the campaigns API token).');

  const api = async (method, route, body) => {
    const response = await fetch(`${args.origin}/services/doorman/campaigns${route}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }).catch((error) => {
      throw new Error(`Could not reach ${args.origin} (${error.cause ? error.cause.code || error.cause.message : error.message}). Is goon.vc running there?`);
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    if (response.status === 404 && !json) throw new Error(`${args.origin} has no campaigns API: is it running with GOON_CAMPAIGNS=1 and GOON_SCRIPTS_TOKEN?`);
    if (!response.ok) throw Object.assign(new Error((json && json.error) || `HTTP ${response.status}`), { status: response.status });
    return json;
  };

  if (args.send.length) {
    for (const { campaign, preview } of args.send) {
      const sent = await api('POST', `/${campaign}/schedule`, { preview, sendAt: args.at || undefined, by: BY });
      log(`${sent.title}: ${sent.status}${sent.status === 'scheduled' ? ` for ${sent.sendAt}` : ''}, to ${sent.preview ? sent.preview.reach : 0} of the members previewed.`);
    }
    return;
  }

  const contract = recruiting.load(args.file);
  const approvals = [];
  const wanted = recruiting.drafts(contract).filter((entry) => !args.units.length || args.units.includes(entry.unit));
  if (!wanted.length) throw new Error(`No units to recruit for${args.units.length ? `: ${args.units.join(', ')}` : ''}`);

  const { campaigns: existing } = await api('GET', '');
  for (const { unit, draft } of wanted) {
    const step = recruiting.plan(draft, existing);
    if (step.action === 'busy' || step.action === 'keep') {
      const current = existing.find((campaign) => campaign.id === step.id);
      log(`${unit}: ${current.title} is already ${current.status} (${step.id}); left alone.`);
      continue;
    }
    const saved = step.action === 'create'
      ? await api('POST', '', Object.assign({ by: BY }, step.draft))
      : await api('PATCH', `/${step.id}`, { title: step.draft.title, content: step.draft.content, filter: step.draft.filter, by: BY });
    const preview = await api('POST', `/${saved.id}/preview`, {});
    const skipped = [
      preview.inactive ? `${preview.inactive} not in voice or posting in ${draft.filter.activeWithinDays} days` : null,
      preview.optedOut ? `${preview.optedOut} opted out` : null,
      preview.excluded ? `${preview.excluded} already asked` : null
    ].filter(Boolean);
    log(`${unit}: ${step.action === 'create' ? 'saved' : 'updated'} draft ${saved.id}: reaches ${preview.reach} of ${preview.found} found${skipped.length ? ` (skipped: ${skipped.join(', ')})` : ''}.`);
    (preview.recipients || []).forEach((recipient, index) => console.log(`  ${index + 1}. ${recipient.name || 'Unnamed member'}`));
    if (preview.reach > 0) approvals.push(`--send ${saved.id}:${preview.id}`);
  }
  if (!approvals.length) return log('Nobody to reach; nothing to send.');
  log('Nothing was sent. To send exactly these previews, run:');
  console.log(`  npm run campaigns:recruiting -- ${approvals.join(' ')}${args.origin === parseArgs(['', '']).origin ? '' : ` --origin ${args.origin}`}`);
  log('Add --at <date> to schedule. A preview goes stale when its draft changes or this runs again.');
}

main().catch((error) => {
  console.error('[CAMPAIGNS:RECRUITING]', error && error.message ? error.message : error);
  process.exit(1);
});
