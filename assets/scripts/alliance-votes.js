// Compiled from components/PermafleetVotes.js by `npm run build`. Edit the component, not this file.
'use strict';

(function client () {
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
  const CHOICES = ['yes', 'no', 'abstain'];

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

  function capital (word) {
    return word[0].toUpperCase() + word.slice(1);
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

  function orgList (orgs) {
    return orgs.map((org) => esc(orgLabel(org))).join(' and ');
  }

  function orgItem (org, extra) {
    const logo = org.logoUrl ? `<img src="${esc(org.logoUrl)}" alt="" loading="lazy">` : '';
    return `<li>${logo}<span><a href="${esc(org.path)}">${esc(org.name)}</a><small>${esc(org.symbol)}${extra && extra.sub ? ` · ${esc(extra.sub)}` : ''}</small></span>${extra && extra.badge ? extra.badge : ''}</li>`;
  }

  function voterNote (you) {
    if (!you || !you.signedIn) return `<p class="pf-votes-note">Only a member org's officers vote for it. Officers <a href="${esc(loginPath)}">sign in</a> with the Discord account alliance leadership has on record.</p>`;
    if ((you.officers || []).length) return `<p class="pf-votes-note">You are an officer of ${orgList(you.officers)}: propose for your org, and vote on any open proposal.</p>`;
    return '<p class="pf-votes-note">You are signed in, but your account isn\'t on record as an officer of a member org. Officers are put on record by alliance leadership; ask in #embassy on the G00N SQUAD Discord.</p>';
  }

  function bindForm (form, submit) {
    let choice = null;
    form.querySelectorAll('button[value]').forEach((button) => button.addEventListener('click', () => { choice = button.value; }));
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const status = form.querySelector('.pf-votes-note[role="status"]');
      form.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      status.className = 'pf-votes-note';
      status.textContent = 'Signing…';
      try {
        await submit(choice, new FormData(form));
      } catch (error) {
        status.className = 'pf-votes-note error';
        status.textContent = error.message;
        form.querySelectorAll('button').forEach((b) => { b.disabled = false; });
      }
    });
  }

  function choiceButtons (current) {
    return `<div class="pf-votes-buttons">${CHOICES.map((choice) => `<button class="goon-button" type="submit" value="${choice}" aria-pressed="${current === choice}">${capital(choice)}</button>`).join('')}</div>`;
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
    if (org.custody === 'own') return 'casts its own vote';
    return 'no officers on record yet';
  }

  function renderOrgs (federation) {
    const voting = federation.voting === undefined ? federation.orgs : federation.voting;
    const short = voting < federation.threshold
      ? ` Only ${esc(voting)} ${voting === 1 ? 'org has' : 'orgs have'} officers on record, so nothing can pass until more orgs name theirs.`
      : '';
    return `<ul class="pf-votes-orgs">${federation.organizations.map((org) => orgItem(org, { sub: orgSub(org) })).join('')}</ul>
      <p class="pf-votes-note">${esc(federation.threshold)} of ${esc(federation.orgs)} orgs must vote yes for a proposal to pass.${short}${federation.path ? ` <a href="${esc(federation.path)}">The alliance federation &raquo;</a>` : ''}</p>`;
  }

  function renderPropose (data) {
    const el = document.getElementById('pf-votes-officers');
    if (!el) return;
    const mine = data.you.officers || [];
    if (!mine.length) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const pick = mine.length > 1
      ? `<label>For <select name="org">${mine.map((org) => `<option value="${esc(org.symbol)}">${esc(orgLabel(org))}</option>`).join('')}</select></label>`
      : '';
    el.innerHTML = `<h2>Propose</h2>
      <form class="pf-votes-form" data-propose>
        <p class="pf-votes-note">As an officer of ${orgList(mine)}, you put a proposal to every member org. goon.vc signs it for you.</p>
        ${pick}
        <label>Title <input name="title" maxlength="120" required></label>
        <label>Details <textarea name="summary" maxlength="2000"></textarea></label>
        <label>Open for <select name="days">${[3, 7, 14, 30].map((days) => `<option value="${days}"${days === 7 ? ' selected' : ''}>${days} days</option>`).join('')}</select></label>
        <div class="pf-votes-buttons"><button class="goon-button" type="submit">Propose</button></div>
        <p class="pf-votes-note" role="status"></p>
      </form>`;
    bindForm(el.querySelector('[data-propose]'), async (choice, fields) => {
      const proposal = await request('POST', `${api}/proposals`, {
        title: fields.get('title'),
        summary: fields.get('summary'),
        days: Number(fields.get('days')),
        org: fields.get('org') || undefined
      });
      window.location.assign(proposal.path);
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
      statusEl.innerHTML = voterNote(data.you);
      listEl.innerHTML = renderList(data.proposals);
      orgsEl.innerHTML = renderOrgs(data.federation);
      renderPropose(data);
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
    if (o.yes === undefined) return `${o.threshold} of ${o.total} officers decide`;
    const counts = CHOICES.filter((choice) => o[choice]).map((choice) => `${o[choice]} ${choice}`);
    return `officers: ${counts.length ? counts.join(', ') : 'none yet'} (${o.threshold} of ${o.total} decide)`;
  }

  // Each fellow officer's latest vote on the viewer's orgs.
  function fellowVotes (proposal, symbol) {
    const latest = new Map();
    for (const vote of proposal.officerVotes || []) {
      if (vote.org === symbol) latest.set(vote.officer, vote);
    }
    return Array.from(latest.values());
  }

  function renderOfficerBallot (proposal) {
    const seats = (proposal.you && proposal.you.officers) || [];
    const orgs = proposal.organizations.filter((org) => seats.some((seat) => seat.symbol === org.symbol));
    const current = seats.length && seats.every((seat) => seat.choice === seats[0].choice) ? seats[0].choice : null;
    const rules = orgs.map((org) => `${esc(org.name)} votes once ${esc(org.officers.threshold)} of its ${esc(org.officers.total)} officers agree${org.choice ? `; it votes <strong>${esc(org.choice)}</strong> now` : ''}.`).join(' ');
    const fellows = orgs.map((org) => {
      const rows = fellowVotes(proposal, org.symbol);
      return `<p class="pf-votes-note">${esc(org.name)} officers: ${rows.length ? rows.map((vote) => `${esc(vote.by || 'an officer')} <strong>${esc(vote.choice)}</strong> (${esc(when(vote.castAt))})`).join(' · ') : 'no votes yet'}.</p>`;
    }).join('');
    const yours = seats.length
      ? seats.map((seat) => `${esc(seat.symbol)}: ${seat.choice ? `<strong>${esc(seat.choice)}</strong> (${esc(when(seat.castAt))})` : 'not voted'}`).join(' · ')
      : '';
    return `<form class="pf-votes-form" data-officer-ballot>
        <p class="pf-votes-note">You are an officer of ${orgList(orgs)}. Your vote signs for your org and is also your member vote. ${rules} Only your org's officers see each officer's vote.</p>
        <p class="pf-votes-note">Your vote: ${yours}</p>
        ${choiceButtons(current)}
        <p class="pf-votes-note" role="status"></p>
      </form>${fellows}`;
  }

  function renderBallot (proposal, overview) {
    if (proposal.status !== 'open') return '';
    const seats = (proposal.you && proposal.you.officers) || [];
    if (seats.length) return `<section class="pf-votes-panel"><h2>Vote for your org</h2>${renderOfficerBallot(proposal)}</section>`;
    const voting = proposal.organizations.some((org) => org.custody === 'officers' || org.custody === 'own');
    const none = voting ? '' : '<p class="pf-votes-note">No member org of this federation has officers on record, so none can vote on it.</p>';
    return `<section class="pf-votes-panel"><h2>Vote</h2>${voterNote(overview.you)}${none}</section>`;
  }

  function renderMemberBallot (proposal, overview) {
    const mine = proposal.you && proposal.you.memberVote;
    const officer = ((proposal.you && proposal.you.officers) || []).length > 0;
    const counts = `<p class="pf-intro">${memberLine(proposal.members)}</p>${memberBar(proposal.members)}`;
    const how = '<p class="pf-votes-note">Every member has a say: one vote each, the latest from any of your linked accounts counts. It is advice to the member orgs, who decide. On Discord, run <code>/vote</code> in any server with our bot.</p>';
    if (proposal.status !== 'open') return `<section class="pf-votes-panel"><h2>Members</h2>${counts}</section>`;
    if (!proposal.bridge) return `<section class="pf-votes-panel"><h2>Members</h2>${counts}<p class="pf-votes-note">Member votes are not set up right now.</p></section>`;
    if (!overview.you || !overview.you.signedIn) return `<section class="pf-votes-panel"><h2>Members</h2>${counts}${how}<p class="pf-votes-note"><a href="${esc(loginPath)}">Sign in</a> to vote here.</p></section>`;
    const yours = `<p class="pf-votes-note">${mine ? `Your vote: <strong>${esc(mine.choice)}</strong> (${esc(when(mine.castAt))})` : 'You have not voted.'}</p>`;
    if (officer) return `<section class="pf-votes-panel"><h2>Members</h2>${counts}${how}${yours}<p class="pf-votes-note">Your vote for your org above sets it.</p></section>`;
    return `<section class="pf-votes-panel"><h2>Members</h2>${counts}${how}
      <form class="pf-votes-form" data-member-ballot>
        ${yours}
        ${choiceButtons(mine ? mine.choice : null)}
        <p class="pf-votes-note" role="status"></p>
      </form></section>`;
  }

  function endorsementList (endorsements) {
    if (!endorsements || !endorsements.length) return '';
    return `<br>Signed by ${endorsements.length} officer${endorsements.length === 1 ? '' : 's'}: ${endorsements.map((e) => `<code>${esc(e.id)}</code>`).join(', ')}`;
  }

  function renderProof (proposal) {
    const votes = proposal.votes.map((vote) => `<li>${esc(vote.org || 'Unknown')} ${esc(vote.choice)} · ${esc(when(vote.castAt))}${vote.by ? ` · ${esc(vote.by)}` : ''}${endorsementList(vote.endorsements)}<br><code>${esc(vote.frame)}</code></li>`).join('');
    const fedLink = (id, href) => (href ? `<a href="${esc(href)}"><code>${esc(id)}</code></a>` : `<code>${esc(id)}</code>`);
    const orgFederations = (proposal.orgFederations || []).map((org) => `<p>${esc(org.symbol)} officers, federation ${fedLink(org.id, org.path)}</p><pre>${esc(JSON.stringify(org.descriptor, null, 2))}</pre>`).join('');
    const memberVotes = (proposal.memberVotes || []).map((vote) => `<li>${esc(vote.choice)} · ${esc(when(vote.castAt))} · ${esc(vote.bridge ? `${vote.platform} account, attested` : `${vote.platform} account`)}<br><code>${esc(vote.frame)}</code></li>`).join('');
    const bridges = [proposal.bridge].concat(proposal.bridges || []).filter(Boolean);
    const bridgeProof = bridges.map((b) => `<p>Bridge <code>${esc(b.id)}</code></p><pre>${esc(JSON.stringify(b.descriptor, null, 2))}</pre>`).join('');
    return `<details class="pf-votes-proof">
        <summary>Verify this vote</summary>
        <p>Every proposal and vote is a signed Fabric <code>CONTRACT_MESSAGE</code> under federation ${fedLink(proposal.federationId, proposal.federationPath)}${proposal.current ? '' : ' (the alliance has changed since; this proposal keeps the federation it was made in)'}. The federation id is the SHA-256 of the descriptor below.</p>
        <p>Descriptor</p>
        <pre>${esc(JSON.stringify(proposal.descriptor, null, 2))}</pre>
        ${orgFederations ? `<p>An org that decides by its officers is its own federation of them. Its alliance messages carry its officers' signed messages as <code>endorsements</code>: one officer for a proposal, the org threshold agreeing for a vote.</p>${orgFederations}` : ''}
        <p>Proposal <code>${esc(proposal.id)}</code>${endorsementList(proposal.endorsements)}</p>
        <pre>${esc(proposal.frame)}</pre>
        ${votes ? `<p>Votes, in the order received</p><ol>${votes}</ol>` : ''}
        ${memberVotes || bridgeProof ? `<p>Member votes are <code>FederationMemberVote</code> messages under the same federation. goon.vc is a Bridge: it vouches for each account that votes with a <code>BridgeAttestation</code>, which never names the account, and signs the vote for it. The latest vote per member counts.</p>${bridgeProof}` : ''}
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
          : (org.castAt ? `${when(org.castAt)}${org.by ? ` · ${org.by}` : ''}` : (org.custody === 'none' ? 'no officers on record' : '')),
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
        request('GET', api).catch(() => ({ you: { signedIn: false, officers: [] } }))
      ]);
      view.innerHTML = renderProposal(proposal, overview);
      view.querySelectorAll('[data-officer-ballot]').forEach((form) => bindForm(form, async (choice) => {
        await request('POST', `${api}/proposals/${encodeURIComponent(proposal.id)}/votes`, { choice });
        await draw();
      }));
      view.querySelectorAll('[data-member-ballot]').forEach((form) => bindForm(form, async (choice) => {
        await request('POST', `${api}/proposals/${encodeURIComponent(proposal.id)}/member-votes`, { choice });
        await draw();
      }));
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
})(window);
