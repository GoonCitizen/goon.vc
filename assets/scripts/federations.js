'use strict';

/**
 * Fabric federations behind alliance votes: the index (the alliance
 * federation of member orgs and each org's federation of officers) and one
 * page per federation (its signers, threshold, descriptor, and the
 * proposals or alliances it decides in), all from the alliance service.
 */
(function () {
  const indexEl = document.getElementById('federations-page');
  const pageEl = document.getElementById('federation-page');
  if (!indexEl || !pageEl) return;
  const api = indexEl.getAttribute('data-api') || '/services/alliance/federations';
  const base = (indexEl.getAttribute('data-base') || '/federations').replace(/\/+$/, '');
  const votesPath = pageEl.getAttribute('data-votes') || '/operations/PERMAFLEET/votes';
  const siteTitle = pageEl.getAttribute('data-site-title') || 'GOON SQUAD';
  const path = (window.location.pathname || '/').replace(/\/+$/, '');
  const onIndex = path.toLowerCase() === base.toLowerCase();
  const onFederation = path.toLowerCase().indexOf(base.toLowerCase() + '/') === 0;
  if (!onIndex && !onFederation) return;

  const STATUS = { open: 'Open', passed: 'Passed', failed: 'Failed', expired: 'Expired' };
  const CUSTODY = { 'goon.vc': 'stewards vote, goon.vc signs', own: 'holds its own key', officers: 'decided by its officers' };

  function esc (value) {
    return String(value === undefined || value === null ? '' : value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function request (url) {
    const res = await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
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
    return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function title (fed) {
    return fed.kind === 'alliance' ? `${fed.name} alliance` : `[${fed.symbol}] ${fed.name} officers`;
  }

  function rule (fed) {
    return `${fed.threshold} of ${fed.members} ${fed.kind === 'alliance' ? 'member orgs' : 'officers'} decide`;
  }

  function item (fed) {
    const state = fed.current ? '' : ' retired';
    return `<li class="${esc(fed.kind)}${state}">
        <h3><a href="${esc(fed.path)}">${esc(title(fed))}</a><small>${fed.kind === 'alliance' ? 'Alliance' : 'Org'}${fed.current ? '' : ' · retired'}</small></h3>
        <p class="pf-votes-meta">${esc(rule(fed))} · ${esc(fed.network)} · since ${esc(when(fed.createdAt))}</p>
        <p class="pf-votes-meta pf-federation-id">${esc(fed.id)}</p>
      </li>`;
  }

  async function loadIndex () {
    const listEl = document.getElementById('federations-list');
    try {
      const data = await request(api);
      listEl.innerHTML = data.federations.length
        ? `<ul class="pf-votes-list pf-federations-list">${data.federations.map(item).join('')}</ul>`
        : '<p class="pf-intro">No federations yet.</p>';
    } catch (error) {
      listEl.innerHTML = error.status === 503
        ? '<p class="pf-intro">Alliance votes are not set up yet.</p>'
        : `<p class="pf-votes-note error">${esc(error.message)}</p>`;
    }
  }

  function orgItem (org) {
    const logo = org.logoUrl ? `<img src="${esc(org.logoUrl)}" alt="" loading="lazy">` : '';
    const sub = org.federation
      ? `<a href="${esc(org.federation.path)}">${esc(org.federation.threshold)} of ${esc(org.federation.officers)} officers decide</a>`
      : esc(CUSTODY[org.custody] || org.custody);
    return `<li>${logo}<span><a href="${esc(org.path)}">${esc(org.name)}</a><small>${esc(org.symbol)} · ${sub}</small></span></li>`;
  }

  function proposalItem (p) {
    return `<li class="${esc(p.status)}">
        <h3><a href="${esc(p.path)}">${esc(p.title)}</a></h3>
        <p class="pf-votes-meta"><span class="pf-votes-status ${esc(p.status)}">${esc(STATUS[p.status] || p.status)}</span>${esc(p.tally.yes)} yes · ${esc(p.tally.no)} no · ${esc(p.tally.abstain)} abstain of ${esc(p.tally.orgs)} orgs</p>
      </li>`;
  }

  function renderAlliance (fed) {
    return `<h2>Member organizations</h2>
      <ul class="pf-votes-orgs">${fed.organizations.map(orgItem).join('')}</ul>
      <p class="pf-votes-note">Each org signs with its own validator key; ${esc(fed.threshold)} yes votes pass a proposal.</p>
      <h2>Proposals</h2>
      ${fed.proposals.length
        ? `<ul class="pf-votes-list">${fed.proposals.slice().reverse().map(proposalItem).join('')}</ul>`
        : `<p class="pf-intro">No proposals in this federation. <a href="${esc(votesPath)}">Alliance votes &raquo;</a></p>`}`;
  }

  function renderOrganization (fed) {
    return `<h2>Officers</h2>
      <ul class="pf-votes-orgs">${fed.officers.map((officer) => `<li><span>${esc(officer.name)}<small class="pf-federation-id">${esc(officer.pubkey)}</small></span></li>`).join('')}</ul>
      <p class="pf-votes-note">${esc(fed.threshold)} of ${esc(fed.officers.length)} officers must sign the same choice for <a href="${esc(fed.organization.path)}">${esc(fed.name)}</a> to vote; goon.vc then signs the org's alliance vote with a key derived for this federation, carrying their signatures.</p>
      <h2>Decides for</h2>
      <ul class="pf-votes-list pf-federations-list">${fed.alliances.map(item).join('')}</ul>`;
  }

  function renderFederation (fed) {
    document.title = `${title(fed)} — Federations — ${siteTitle}`;
    return `<p class="pf-eyebrow">${fed.kind === 'alliance' ? 'Alliance federation' : 'Org federation'}${fed.current ? '' : ' · retired'}</p>
      <h1>${esc(title(fed))}</h1>
      <p class="pf-intro">${esc(rule(fed))} · ${esc(fed.network)} · since ${esc(when(fed.createdAt))}</p>
      ${fed.kind === 'alliance' ? renderAlliance(fed) : renderOrganization(fed)}
      <details class="pf-votes-proof" open>
        <summary>Descriptor</summary>
        <p>Federation <code>${esc(fed.id)}</code> is the SHA-256 of this Fabric federation descriptor.</p>
        <pre>${esc(JSON.stringify(fed.descriptor, null, 2))}</pre>
        ${fed.invite ? `<p>Invite, signed by the publisher org</p><pre>${esc(fed.invite)}</pre>` : ''}
      </details>`;
  }

  async function loadFederation () {
    const view = document.getElementById('federation-view');
    const id = decodeURIComponent(path.slice(base.length + 1));
    try {
      view.innerHTML = renderFederation(await request(`${api}/${encodeURIComponent(id)}`));
    } catch (error) {
      view.innerHTML = error.status === 404
        ? '<p class="pf-intro">No such federation.</p>'
        : `<p class="pf-votes-note error">${esc(error.message)}</p>`;
    }
  }

  if (onIndex) loadIndex();
  else loadFederation();
})();
