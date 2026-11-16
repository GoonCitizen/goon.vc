'use strict';

(function () {
  const root = document.getElementById('tool-pdc-dashboard');
  if (!root) return;
  const $ = (id) => root.querySelector('#' + id);

  const TYPES = [
    { id: 'swarm', name: 'M2C “Swarm”', short: 'Swarm', kind: 'laser', size: 'S1 laser repeater PDC', dps: 167, rpm: 1000, source: 'Human / ship-fit candidate', status: 'Unverified', note: 'Common reference point for laser PDCs. Provisional figures: 10 damage × 1,000 rpm ≈ 167 DPS. Availability and compatibility vary by patch.' },
    { id: 'torrent', name: 'MRX “Torrent”', short: 'Torrent', kind: 'ballistic', size: 'S1 ballistic gatling PDC', dps: 360, rpm: 1200, source: 'Human / ship-fit candidate', status: 'Unverified', note: 'Higher provisional paper DPS, but ammunition logistics matter. The dashboard does not estimate magazine endurance, reload access, or interception efficiency.' },
    { id: 'mauler', name: 'Mauler PDC Turret', short: 'Mauler', kind: 'salvage', size: 'Salvaged alien PDC', dps: 167, rpm: 1000, source: 'Recovered from Vanduul Mauler', status: 'Speculative fit', note: 'Reported as lootable from the Mauler and described in community/game-file references as Swarm-derived. Treated here as a separate cosmetic/asset variant with provisional Swarm-equivalent output.' },
    { id: 'empty', name: 'Empty mount', short: 'Empty', kind: 'empty', size: 'No turret installed', dps: 0, rpm: 0, source: '—', status: 'Valid planning state', note: 'Leaves the slot unoccupied. Useful for staging incomplete salvage sets or testing mixed loadouts.' }
  ];
  const state = { ship: 'Perseus', loads: Array(7).fill('swarm'), selected: 'mauler' };
  const maxSlots = () => state.ship === 'Perseus' ? 6 : 7;
  const byId = (id) => TYPES.find((x) => x.id === id);

  function renderSlots () {
    const box = $('pdc-slots');
    box.innerHTML = '';
    for (let i = 0; i < maxSlots(); i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<div class="slot-num">${i + 1}</div><div><label for="pdc-slot${i}">PDC mount ${i + 1}</label><select id="pdc-slot${i}">${TYPES.map((t) => `<option value="${t.id}" ${state.loads[i] === t.id ? 'selected' : ''}>${t.name}</option>`).join('')}</select></div>`;
      el.querySelector('select').addEventListener('change', (e) => {
        state.loads[i] = e.target.value;
        renderSummary();
      });
      box.appendChild(el);
    }
  }

  function bar (label, value, max, kind) {
    return `<div class="bar-row"><span>${label}</span><div class="track"><div class="bar ${kind}" style="width:${max ? value / max * 100 : 0}%"></div></div><strong>${Math.round(value).toLocaleString()}</strong></div>`;
  }

  function renderSummary () {
    const items = state.loads.slice(0, maxSlots()).map(byId);
    const mounted = items.filter((x) => x.id !== 'empty').length;
    const total = items.reduce((a, b) => a + b.dps, 0);
    const energy = items.filter((x) => x.kind === 'laser' || x.kind === 'salvage').length;
    $('pdc-mounted').textContent = `${mounted} / ${maxSlots()}`;
    $('pdc-dps').textContent = total.toLocaleString();
    $('pdc-energy').textContent = Math.round(energy / maxSlots() * 100) + '%';
    $('pdc-confidence').textContent = items.some((x) => x.kind === 'salvage') ? 'Speculative' : 'Low';
    const sums = { laser: 0, ballistic: 0, salvage: 0 };
    const counts = { laser: 0, ballistic: 0, salvage: 0, empty: 0 };
    items.forEach((x) => {
      if (sums[x.kind] != null) sums[x.kind] += x.dps;
      counts[x.kind]++;
    });
    $('pdc-damage').innerHTML = bar('Laser', sums.laser, total, 'laser') + bar('Ballistic', sums.ballistic, total, 'ballistic') + bar('Mauler', sums.salvage, total, 'salvage');
    $('pdc-mix').innerHTML = bar('Laser', counts.laser, maxSlots(), 'laser') + bar('Ballistic', counts.ballistic, maxSlots(), 'ballistic') + bar('Mauler', counts.salvage, maxSlots(), 'salvage') + bar('Empty', counts.empty, maxSlots(), 'laser');
  }

  function renderTable () {
    const tb = $('pdc-comparison');
    tb.innerHTML = TYPES.filter((t) => t.id !== 'empty').map((t) => `<tr class="selectable ${t.id === state.selected ? 'selected' : ''}" data-id="${t.id}" tabindex="0"><td><strong>${t.name}</strong><br><span class="tag ${t.kind}">${t.size}</span></td><td>${t.kind === 'salvage' ? 'Alien salvage' : t.kind[0].toUpperCase() + t.kind.slice(1)}</td><td>${t.dps} <span class="warn">Est.</span><br><small>${t.rpm.toLocaleString()} rpm</small></td><td>${t.source}</td><td class="warn">${t.status}</td></tr>`).join('');
    tb.querySelectorAll('tr').forEach((r) => {
      const pick = () => {
        state.selected = r.dataset.id;
        renderTable();
        renderDetail();
      };
      r.onclick = pick;
      r.onkeydown = (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      };
    });
  }

  function renderDetail () {
    const t = byId(state.selected);
    $('pdc-detail').innerHTML = `<h3>${t.name}</h3><p>${t.note}</p><p><span class="warn">⚠ Unverified:</span> numeric values and fit behavior must be confirmed in the current live build.</p>`;
  }

  function setShip (ship) {
    state.ship = ship;
    root.querySelectorAll('[data-ship]').forEach((b) => b.classList.toggle('active', b.dataset.ship === ship));
    renderSlots();
    renderSummary();
  }

  function toast (msg) {
    const t = $('pdc-toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  }

  root.querySelectorAll('[data-ship]').forEach((b) => { b.onclick = () => setShip(b.dataset.ship); });
  $('pdc-reset').onclick = () => {
    state.loads = Array(7).fill('swarm');
    setShip('Perseus');
    toast('Reset to Perseus laser baseline');
  };
  $('pdc-save').onclick = () => {
    localStorage.setItem('pdc-loadout-v1', JSON.stringify(state));
    toast('Loadout saved locally');
  };
  $('pdc-export').onclick = () => {
    const out = {
      title: `${state.ship} PDC loadout`,
      ship: state.ship,
      slotCount: maxSlots(),
      slots: state.loads.slice(0, maxSlots()).map((id, i) => ({ mount: i + 1, pdc: byId(id).name, estimatedDps: byId(id).dps })),
      disclaimer: 'Unverified, patch-sensitive planning data. Cross-ship and Mauler configurations may be unsupported.'
    };
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${state.ship.toLowerCase()}-pdc-loadout.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Loadout JSON exported');
  };
  try {
    const saved = JSON.parse(localStorage.getItem('pdc-loadout-v1'));
    if (saved && ['Perseus', 'Polaris'].includes(saved.ship) && Array.isArray(saved.loads)) {
      state.ship = saved.ship;
      state.loads = saved.loads.slice(0, 7);
      while (state.loads.length < 7) state.loads.push('swarm');
    }
  } catch (e) {}
  setShip(state.ship);
  renderTable();
  renderDetail();
}());
