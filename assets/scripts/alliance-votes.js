'use strict';

/**
 * PERMAFLEET alliance votes: the index (member orgs, every proposal, and the
 * proposal form for Org Stewards) and one page per proposal (each org's vote,
 * the steward's Yes / No / Abstain, officer progress and the signing command
 * for orgs that decide by their officers, a box for posting signed frames,
 * every member's advisory vote, and the signed Federation messages), all
 * through the alliance service.
 */
(function () {
  const indexEl = document.getElementById('pf-votes-page');
  const pageEl = document.getElementById('pf-vote-page');
  if (!indexEl || !pageEl) return;
  const api = indexEl.getAttribute('data-api') || '/services/alliance';
  const base = (indexEl.getAttribute('data-base') || '/operations/PERMAFLEET/votes').replace(/\/+$/, '');
  const loginPath = indexEl.getAttribute('data-login') || '/sessions';
  const siteTitle = pageEl.getAttribute('data-site-title') || 'GOON SQUAD';
  const path = (window.location.pathname || '/').replace(/\/+$/, '');
  const onIndex = path.toLowerCase() === base.toLowerCase();
  const onProposal = path.toLowerCase().indexOf(base.toLowerCase() + '/') === 0;
  if (!onIndex && !onProposal) return;

  const STATUS = { open: 'Open', passed: 'Passed', failed: 'Failed', expired: 'Expired' };

  function esc (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function request (method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: Object.assign({ Accept: 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const error = new Error((data && data.error) || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return data;
  }

  function when (iso) {
    const date = new Date(iso);
    if (isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function statusLine (proposal, withClose) {
    const t = proposal.tally;
    const close = withClose && proposal.status === 'open' ? ` · Open until ${esc(when(proposal.closesAt))}` : '';
    return `<span class="pf-votes-status ${esc(proposal.status)}">${esc(STATUS[proposal.status] || proposal.status)}</span>${esc(t.yes)} yes · ${esc(t.no)} no · ${esc(t.abstain)} abstain · ${esc(t.waiting)} not voted — ${esc(t.threshold)} of ${esc(t.orgs)} orgs must vote yes${close}`;
  }

  function bar (tally) {
    const pct = (n) => (tally.orgs ? (100 * n / tally.orgs) : 0).toFixed(2);
    return `<div class="pf-votes-bar" role="img" aria-label="${esc(tally.yes)} yes, ${esc(tally.no)} no, ${esc(tally.abstain)} abstain of ${esc(tally.orgs)} orgs"><span class="yes" style="width:${pct(tally.yes)}%"></span><span class="abstain" style="width:${pct(tally.abstain)}%"></span><span class="no" style="width:${pct(tally.no)}%"></span></div>`;
  }

  function memberLine (members) {
    const m = members || { yes: 0, no: 0, abstain: 0, total: 0 };
    return `Members (advisory): ${esc(m.yes)} yes · ${esc(m.no)} no · ${esc(m.abstain)} abstain`;
  }

  function memberBar (members) {
    const m = members || { yes: 0, no: 0, abstain: 0, total: 0 };
    const pct = (n) => (m.total ? (100 * n / m.total) : 0).toFixed(2);
    return `<div class="pf-votes-bar members" role="img" aria-label="Members: ${esc(m.yes)} yes, ${esc(m.no)} no, ${esc(m.abstain)} abstain"><span class="yes" style="width:${pct(m.yes)}%"></span><span class="abstain" style="width:${pct(m.abstain)}%"></span><span class="no" style="width:${pct(m.no)}%"></span></div>`;
  }

  function orgLabel (org) {
    return org ? `[${org.symbol}] ${org.name}` : 'Unknown org';
  }

  function orgItem (org, extra) {
    const logo = org.logoUrl ? `<img src="${esc(org.logoUrl)}" alt="" loading="lazy">` : '';
    return `<li>${logo}<span><a href="${esc(org.path)}">${esc(org.name)}</a><small>${esc(org.symbol)}${extra && extra.sub ? ` · ${esc(extra.sub)}` : ''}</small></span>${extra && extra.badge ? extra.badge : ''}</li>`;
  }

  function custodyOf (federation, symbol) {
    const org = federation && federation.organizations.find((o) => o.symbol === symbol);
    return org ? org.custody : null;
  }

  function signCommand (args) {
    const origin = window.location.origin === 'https://goon.vc' ? '' : ` --origin ${window.location.origin}`;
    return `npm run alliance:sign -- ${args}${origin}`;
  }

  function commandBlock (command) {
    return `<p class="pf-votes-command"><code>${esc(command)}</code><button class="goon-button" type="button" data-copy="${esc(command)}">Copy</button></p>`;
  }

  function stewardNote (you, federation) {
    const officerOf = (you.officers || []).map((symbol) => {
      const org = federation && federation.organizations.find((o) => o.symbol === symbol);
      return esc(org ? orgLabel(org) : symbol);
    });
    const officerNote = officerOf.length ? `<p class="pf-votes-note">You are an officer of ${officerOf.join(' and ')}: sign proposals and votes with your own Fabric key.</p>` : '';
    if (!you.signedIn) return `<p class="pf-votes-note">Org Stewards <a href="${esc(loginPath)}">sign in</a> to propose and vote for their org; officers of an org that decides by its officers sign with their own Fabric keys.</p>`;
    const stewarded = you.organizations.filter((symbol) => custodyOf(federation, symbol) !== 'officers');
    if (!stewarded.length) return officerNote || '<p class="pf-votes-note">You are signed in, but not listed as an Org Steward or officer of a member organization. Link the Discord account or Fabric key your org named on the sign-in page.</p>';
    const names = stewarded.map((symbol) => {
      const org = federation && federation.organizations.find((o) => o.symbol === symbol);
      return esc(org ? orgLabel(org) : symbol);
    });
    return `<p class="pf-votes-note">You vote for ${names.join(' and ')}.</p>${officerNote}`;
  }

  function bindCopy (root) {
    root.querySelectorAll('[data-copy]').forEach((button) => button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(button.getAttribute('data-copy'));
        button.textContent = 'Copied';
      } catch (e) {
        button.textContent = 'Select and copy';
      }
    }));
  }

  /* ---------- index ---------- */

  function renderList (proposals) {
    if (!proposals.length) return '<p class="pf-intro">No proposals yet.</p>';
    return `<ul class="pf-votes-list">${proposals.map((p) => `<li class="${esc(p.status)}">
        <h3><a href="${esc(p.path)}">${esc(p.title)}</a></h3>
        <p class="pf-votes-meta">${statusLine(p, true)}</p>
        <p class="pf-votes-meta">Proposed by ${esc(orgLabel(p.proposer))}${p.by ? ` (${esc(p.by)})` : ''} on ${esc(when(p.createdAt))}</p>
        ${bar(p.tally)}
        ${p.members && p.members.total ? `<p class="pf-votes-meta">${memberLine(p.members)}</p>` : ''}
      </li>`).join('')}</ul>`;
  }

  function orgSub (org) {
    if (org.federation) return `${org.federation.threshold} of ${org.federation.officers} officers decide`;
    return `${org.stewards} steward${org.stewards === 1 ? '' : 's'}${org.custody === 'own' ? ' · own key' : ''}`;
  }

  function renderOrgs (federation) {
    return `<ul class="pf-votes-orgs">${federation.organizations.map((org) => orgItem(org, { sub: orgSub(org) })).join('')}</ul>
      <p class="pf-votes-note">${esc(federation.threshold)} of ${esc(federation.orgs)} orgs must vote yes for a proposal to pass.${federation.path ? ` <a href="${esc(federation.path)}">The alliance federation &raquo;</a>` : ''}</p>`;
  }

  function renderOfficerPropose (data) {
    const el = document.getElementById('pf-votes-officers');
    if (!el) return;
    const orgs = data.federation.organizations.filter((org) => org.federation);
    if (!orgs.length) return;
    const mine = (data.you.officers || []).filter((symbol) => orgs.some((org) => org.symbol === symbol));
    const flag = mine.length === 1 ? ` --org ${mine[0]}` : '';
    el.hidden = false;
    el.innerHTML = `<h2>Officers</h2>
      <p class="pf-votes-note">${esc(orgs.map((org) => org.symbol).join(', '))} ${orgs.length === 1 ? 'decides' : 'decide'} by ${orgs.length === 1 ? 'its' : 'their'} officers' signatures. Officers propose and vote with their own Fabric key (<code>FABRIC_XPRV</code> or <code>--key-file</code>); <code>pubkey</code> prints the key to list as an officer.</p>
      ${commandBlock(signCommand(`propose "Title" --summary "Details" --days 7${flag}`))}`;
    bindCopy(el);
  }

  function setupForm (data) {
    const panel = document.getElementById('pf-votes-propose');
    const form = document.getElementById('pf-votes-form');
    const orgs = data.you.organizations.filter((symbol) => custodyOf(data.federation, symbol) !== 'officers');
    if (!orgs.length) return;
    panel.hidden = false;
    const picker = form.querySelector('[data-org-picker]');
    if (orgs.length > 1) {
      picker.hidden = false;
      picker.querySelector('select').innerHTML = orgs.map((symbol) => `<option value="${esc(symbol)}">${esc(symbol)}</option>`).join('');
    }
    const status = form.querySelector('.pf-votes-note');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const fields = new FormData(form);
      const body = { title: fields.get('title'), summary: fields.get('summary'), days: Number(fields.get('days')) };
      if (orgs.length > 1) body.org = fields.get('org');
      form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      status.className = 'pf-votes-note';
      status.textContent = 'Signing…';
      try {
        const proposal = await request('POST', `${api}/proposals`, body);
        window.location.href = proposal.path;
      } catch (error) {
        status.className = 'pf-votes-note error';
        status.textContent = error.message;
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    });
  }

  async function loadIndex () {
    const statusEl = document.getElementById('pf-votes-status');
    const listEl = document.getElementById('pf-votes-list');
    const orgsEl = document.getElementById('pf-votes-orgs');
    try {
      const data = await request('GET', api);
      if (data.status !== 'ready') {
        statusEl.innerHTML = '<p class="pf-intro">Alliance votes are not set up yet.</p>';
        listEl.innerHTML = '';
        return;
      }
      statusEl.innerHTML = stewardNote(data.you, data.federation);
      listEl.innerHTML = renderList(data.proposals);
      orgsEl.innerHTML = renderOrgs(data.federation);
      setupForm(data);
      renderOfficerPropose(data);
    } catch (error) {
      statusEl.innerHTML = `<p class="pf-votes-note error">${esc(error.message)}</p>`;
      listEl.innerHTML = '';
    }
  }

  /* ---------- proposal ---------- */

  function choiceBadge (choice) {
    return `<span class="pf-votes-choice ${esc(choice || '')}">${esc(choice || 'Not voted')}</span>`;
  }

  function officerLine (org) {
    const o = org.officers;
    const counts = ['yes', 'no', 'abstain'].filter((choice) => o[choice]).map((choice) => `${o[choice]} ${choice}`);
    return `officers: ${counts.length ? counts.join(', ') : 'none yet'} (${o.threshold} of ${o.total} decide)`;
  }

  function renderOfficerBallot (proposal, you) {
    const orgs = proposal.organizations.filter((org) => org.officers);
    if (!orgs.length) return '';
    const mine = (you.officers || []).filter((symbol) => orgs.some((org) => org.symbol === symbol));
    const flag = mine.length === 1 ? ` --org ${mine[0]}` : '';
    return `<div class="pf-votes-officers">
        <p class="pf-votes-note">${esc(orgs.map((org) => org.symbol).join(', '))} ${orgs.length === 1 ? 'votes' : 'vote'} once enough of ${orgs.length === 1 ? 'its' : 'their'} officers sign the same choice with their own Fabric keys:</p>
        ${commandBlock(signCommand(`vote ${proposal.shortId} yes${flag}`))}
        <p class="pf-votes-note">Use <code>no</code> or <code>abstain</code> in place of <code>yes</code>. A later vote from the same officer replaces their earlier one.</p>
      </div>`;
  }

  function renderPaste (proposal) {
    return `<form class="pf-votes-form" data-paste>
        <label>Post a signed frame <textarea name="frame" spellcheck="false" placeholder="Hex from npm run alliance:sign -- vote ${esc(proposal.shortId)} yes --print"></textarea></label>
        <div class="pf-votes-buttons"><button class="goon-button" type="submit">Post</button></div>
        <p class="pf-votes-note" role="status"></p>
      </form>`;
  }

  function renderBallot (proposal, overview) {
    const you = overview.you;
    if (proposal.status !== 'open') return '';
    const extras = proposal.organizations.some((org) => org.custody === 'officers' || org.custody === 'own')
      ? `${renderOfficerBallot(proposal, you)}${renderPaste(proposal)}`
      : '';
    const stewarded = (you.organizations || []).filter((symbol) => {
      const org = proposal.organizations.find((o) => o.symbol === symbol);
      return !org || org.custody !== 'officers';
    });
    if (!you.signedIn || !stewarded.length) return `<section class="pf-votes-panel"><h2>Vote</h2>${stewardNote(you, overview.federation)}${extras}</section>`;
    const mine = proposal.organizations.filter((org) => stewarded.includes(org.symbol));
    if (!mine.length) return `<section class="pf-votes-panel"><h2>Vote</h2><p class="pf-votes-note">Your org was not a member of the alliance when this proposal was made.</p>${extras}</section>`;
    return `<section class="pf-votes-panel"><h2>Vote</h2>${mine.map((org) => {
      if (org.custody === 'own') return `<p class="pf-votes-note">${esc(orgLabel(org))} votes with its own key: post a signed <code>FederationVote</code> below or to <code>${esc(api)}/messages</code>.</p>`;
      return `<form class="pf-votes-form" data-ballot="${esc(org.symbol)}">
        <p class="pf-votes-note">For ${esc(orgLabel(org))}${org.choice ? ` — currently <strong>${esc(org.choice)}</strong>${org.by ? ` (${esc(org.by)})` : ''}` : ''}</p>
        <div class="pf-votes-buttons">${['yes', 'no', 'abstain'].map((choice) => `<button class="goon-button" type="submit" value="${choice}" aria-pressed="${org.choice === choice}">${choice[0].toUpperCase() + choice.slice(1)}</button>`).join('')}</div>
        <p class="pf-votes-note" role="status"></p>
      </form>`;
    }).join('')}${extras}</section>`;
  }

  function renderMemberBallot (proposal, overview) {
    const mine = proposal.you && proposal.you.memberVote;
    const counts = `<p class="pf-intro">${memberLine(proposal.members)}</p>${memberBar(proposal.members)}`;
    const how = '<p class="pf-votes-note">Every member has a say: one vote each, the latest from any of your linked accounts counts. It is advice to the member orgs, who decide. On Discord, run <code>/vote</code> in any server with our bot.</p>';
    if (proposal.status !== 'open') return `<section class="pf-votes-panel"><h2>Members</h2>${counts}</section>`;
    if (!proposal.bridge) return `<section class="pf-votes-panel"><h2>Members</h2>${counts}<p class="pf-votes-note">Member votes are not set up right now.</p></section>`;
    if (!overview.you || !overview.you.signedIn) return `<section class="pf-votes-panel"><h2>Members</h2>${counts}${how}<p class="pf-votes-note"><a href="${esc(loginPath)}">Sign in</a> to vote here.</p></section>`;
    return `<section class="pf-votes-panel"><h2>Members</h2>${counts}${how}
      <form class="pf-votes-form" data-member-ballot>
        <p class="pf-votes-note">${mine ? `Your vote: <strong>${esc(mine.choice)}</strong> (${esc(when(mine.castAt))})` : 'You have not voted.'}</p>
        <div class="pf-votes-buttons">${['yes', 'no', 'abstain'].map((choice) => `<button class="goon-button" type="submit" value="${choice}" aria-pressed="${!!mine && mine.choice === choice}">${choice[0].toUpperCase() + choice.slice(1)}</button>`).join('')}</div>
        <p class="pf-votes-note" role="status"></p>
      </form></section>`;
  }

  function endorsementList (endorsements) {
    if (!endorsements || !endorsements.length) return '';
    return `<br>Endorsed by officer frames ${endorsements.map((e) => `<code>${esc(e.id)}</code>`).join(', ')}`;
  }

  function renderProof (proposal) {
    const votes = proposal.votes.map((vote) => `<li>${esc(vote.org || 'Unknown')} ${esc(vote.choice)} · ${esc(when(vote.castAt))}${vote.by ? ` · ${esc(vote.by)}` : ''}${endorsementList(vote.endorsements)}<br><code>${esc(vote.frame)}</code></li>`).join('');
    const officerVotes = (proposal.officerVotes || []).map((vote) => `<li>${esc(vote.org)} officer ${esc(vote.by || '')} ${esc(vote.choice)} · ${esc(when(vote.castAt))} · <code>${esc(vote.id)}</code><br><code>${esc(vote.frame)}</code></li>`).join('');
    const fedLink = (id, href) => (href ? `<a href="${esc(href)}"><code>${esc(id)}</code></a>` : `<code>${esc(id)}</code>`);
    const orgFederations = (proposal.orgFederations || []).map((org) => `<p>${esc(org.symbol)} officers, federation ${fedLink(org.id, org.path)}</p><pre>${esc(JSON.stringify(org.descriptor, null, 2))}</pre>`).join('');
    const memberVotes = (proposal.memberVotes || []).map((vote) => `<li>${esc(vote.choice)} · ${esc(when(vote.castAt))} · ${esc(vote.bridge ? `${vote.platform} account, attested` : 'own Fabric key')} · key <code>${esc(vote.signer.slice(0, 16))}…</code><br><code>${esc(vote.frame)}</code></li>`).join('');
    const bridges = [proposal.bridge].concat(proposal.bridges || []).filter(Boolean);
    const bridgeProof = bridges.map((b) => `<p>Bridge <code>${esc(b.id)}</code></p><pre>${esc(JSON.stringify(b.descriptor, null, 2))}</pre>`).join('');
    return `<details class="pf-votes-proof">
        <summary>Verify this vote</summary>
        <p>Every proposal and vote is a Fabric <code>CONTRACT_MESSAGE</code> signed by the org's key, under federation ${fedLink(proposal.federationId, proposal.federationPath)}${proposal.current ? '' : ' (the alliance has changed since; this proposal keeps the federation it was made in)'}. The federation id is the SHA-256 of the descriptor below.</p>
        <p>Descriptor</p>
        <pre>${esc(JSON.stringify(proposal.descriptor, null, 2))}</pre>
        ${orgFederations ? `<p>An org that decides by its officers is its own federation of their keys. Its alliance messages carry its officers' signed messages as <code>endorsements</code>: one officer for a proposal, the org threshold agreeing for a vote.</p>${orgFederations}` : ''}
        <p>Proposal <code>${esc(proposal.id)}</code>${endorsementList(proposal.endorsements)}</p>
        <pre>${esc(proposal.frame)}</pre>
        ${votes ? `<p>Votes, in the order received</p><ol>${votes}</ol>` : ''}
        ${officerVotes ? `<p>Officer votes, in the order received</p><ol>${officerVotes}</ol>` : ''}
        ${memberVotes || bridgeProof ? `<p>Member votes are <code>FederationMemberVote</code> messages under the same federation. goon.vc is a Bridge: it holds a key for each account that votes and signs a <code>BridgeAttestation</code> for it with the bridge key (the attestation carries the account's key, never its id or name). The account key signs the vote, which carries the attestation. A member may also sign with a Fabric key linked to their goon.vc account. The latest vote per member counts.</p>${bridgeProof}` : ''}
        ${memberVotes ? `<p>Member votes counted</p><ol>${memberVotes}</ol>` : ''}
      </details>`;
  }

  function renderProposal (proposal, overview) {
    document.title = `${proposal.title} — PERMAFLEET Votes — ${siteTitle}`;
    return `<p class="pf-eyebrow">PERMAFLEET vote</p>
      <h1>${esc(proposal.title)}</h1>
      <p class="pf-intro">${statusLine(proposal)}</p>
      ${bar(proposal.tally)}
      <p class="pf-intro">Proposed by ${esc(orgLabel(proposal.proposer))}${proposal.by ? ` (${esc(proposal.by)})` : ''} on ${esc(when(proposal.createdAt))}; voting ${proposal.status === 'open' ? 'closes' : 'closed'} ${esc(when(proposal.closesAt))}.</p>
      ${proposal.summary ? `<p class="pf-votes-summary">${esc(proposal.summary)}</p>` : ''}
      ${renderBallot(proposal, overview)}
      ${renderMemberBallot(proposal, overview)}
      <h2>Member organizations</h2>
      <ul class="pf-votes-orgs">${proposal.organizations.map((org) => orgItem(org, {
        sub: org.officers
          ? officerLine(org)
          : (org.castAt ? `${when(org.castAt)}${org.by ? ` · ${org.by}` : ''}` : ''),
        badge: choiceBadge(org.choice)
      })).join('')}</ul>
      ${renderProof(proposal)}`;
  }

  async function loadProposal () {
    const view = document.getElementById('pf-vote-view');
    const id = decodeURIComponent(path.slice(base.length + 1));
    async function draw () {
      const [proposal, overview] = await Promise.all([
        request('GET', `${api}/proposals/${encodeURIComponent(id)}`),
        request('GET', api).catch(() => ({ you: { signedIn: false, organizations: [] } }))
      ]);
      view.innerHTML = renderProposal(proposal, overview);
      bindCopy(view);
      view.querySelectorAll('[data-paste]').forEach((form) => form.addEventListener('submit', async (event) => {
        event.preventDefault();
        const status = form.querySelector('.pf-votes-note[role="status"]');
        const frame = String(new FormData(form).get('frame') || '').replace(/\s+/g, '');
        if (!frame) return;
        form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
        status.className = 'pf-votes-note';
        status.textContent = 'Checking…';
        try {
          await request('POST', `${api}/messages`, { frame });
          await draw();
        } catch (error) {
          status.className = 'pf-votes-note error';
          status.textContent = error.message;
          form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        }
      }));
      view.querySelectorAll('[data-ballot]').forEach((form) => {
        let choice = null;
        form.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { choice = button.value; }));
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const status = form.querySelector('.pf-votes-note[role="status"]');
          form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          status.className = 'pf-votes-note';
          status.textContent = 'Signing…';
          try {
            await request('POST', `${api}/proposals/${encodeURIComponent(proposal.id)}/votes`, { choice, org: form.getAttribute('data-ballot') });
            await draw();
          } catch (error) {
            status.className = 'pf-votes-note error';
            status.textContent = error.message;
            form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          }
        });
      });
      view.querySelectorAll('[data-member-ballot]').forEach((form) => {
        let choice = null;
        form.querySelectorAll('button').forEach((button) => button.addEventListener('click', () => { choice = button.value; }));
        form.addEventListener('submit', async (event) => {
          event.preventDefault();
          const status = form.querySelector('.pf-votes-note[role="status"]');
          form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
          status.className = 'pf-votes-note';
          status.textContent = 'Signing…';
          try {
            await request('POST', `${api}/proposals/${encodeURIComponent(proposal.id)}/member-votes`, { choice });
            await draw();
          } catch (error) {
            status.className = 'pf-votes-note error';
            status.textContent = error.message;
            form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
          }
        });
      });
    }
    try {
      await draw();
    } catch (error) {
      view.innerHTML = error.status === 404
        ? '<p class="pf-intro">No such proposal.</p>'
        : `<p class="pf-votes-note error">${esc(error.message)}</p>`;
    }
  }

  if (onIndex) loadIndex();
  else loadProposal();
})();
