import { fetchNoCache, formatTime } from './common.js';
import { getMissions, renderMissionRow } from './missions.js';
import { getStations, renderStationList } from './stations.js';

let cachedMissions = [];
let cachedStations = [];

async function init() {
  document.getElementById('returnMain').addEventListener('click', ()=>location.href='index.html');
  await updateWallet();
  await loadStations();
  await loadMissions();
  setInterval(loadMissions, 5000);
}

async function updateWallet() {
  try {
    const w = await fetchNoCache('/api/wallet').then(r=>r.json());
    document.getElementById('walletDisplay').textContent = `Balance: $${w.balance}`;
  } catch {}
}

async function loadMissions() {
  cachedMissions = await getMissions();
  await updateWallet();
  const container = document.getElementById('cadMissions');
  container.innerHTML = cachedMissions.map(renderMissionRow).join('');
  container.querySelectorAll('.cad-mission').forEach(div=>{
    div.addEventListener('click', ()=>openMission(div.dataset.id));
  });
}

async function loadStations() {
  cachedStations = await getStations();
  const pane = document.getElementById('cadStations');
  pane.innerHTML = renderStationList(cachedStations);
  pane.querySelectorAll('.cad-station').forEach(li=>{
    li.addEventListener('click', ()=>showStation(li.dataset.id));
  });
}

async function showStation(id) {
  const [st, units, unassigned] = await Promise.all([
    fetchNoCache(`/api/stations/${id}`).then(r=>r.json()),
    fetchNoCache(`/api/units?station_id=${id}`).then(r=>r.json()),
    fetchNoCache(`/api/stations/${id}/personnel`).then(r=>r.json()).catch(()=>[])
  ]);
  const pane = document.getElementById('cadStations');
  const personnel = [];
  units.forEach(u => (u.personnel || []).forEach(p => personnel.push({ ...p, unit: u.name })));
  unassigned.forEach(p => personnel.push({ ...p, unit: 'Unassigned' }));
  let html = `<div class="cad-station-detail"><div style="text-align:right"><button id="closeStationDetail">Close</button></div><h3>${st.name}</h3><p>Type: ${st.type}</p><p>Department: ${st.department||''}</p>`;
  html += `<div style="margin:8px 0;"><button id="newPersonnel">New Personnel</button> <button id="newUnit">New Unit</button> <button id="newEquipment">New Equipment</button></div>`;
  html += `<div style="display:flex; gap:20px;"><div><h4>Units</h4><ul>`;
  html += units.map(u => `<li class="cad-unit" data-id="${u.id}">${u.name}</li>`).join('');
  html += `</ul></div><div><h4>Personnel</h4><ul>`;
  html += personnel.map(p => `<li class="cad-personnel" data-id="${p.id}">${p.name} - ${p.unit}</li>`).join('');
  html += `</ul></div></div></div>`;
  pane.innerHTML = html;
  document.getElementById('closeStationDetail').onclick = loadStations;
  document.getElementById('newPersonnel').onclick = () => alert('Not implemented');
  document.getElementById('newUnit').onclick = () => alert('Not implemented');
  document.getElementById('newEquipment').onclick = () => alert('Not implemented');
  pane.querySelectorAll('.cad-unit').forEach(li => li.addEventListener('click', () => alert(`Edit unit ${li.dataset.id}`)));
  pane.querySelectorAll('.cad-personnel').forEach(li => li.addEventListener('click', () => alert(`Edit personnel ${li.dataset.id}`)));
}

async function openMission(id) {
  const mission = cachedMissions.find(m=>String(m.id)===String(id));
  const pane = document.getElementById('cadDetail');
  const assigned = await fetchNoCache(`/api/missions/${id}/units`).then(r=>r.json()).catch(()=>[]);
  let time = '';
  if (mission.resolve_at) {
    const sec = Math.max(0,(mission.resolve_at - Date.now())/1000);
    time = `<div>Time Remaining: ${formatTime(sec)}</div>`;
  }
  let reqHtml = '';
  if (Array.isArray(mission.required_units) && mission.required_units.length) {
    reqHtml = '<div><strong>Required Units:</strong><ul>' + mission.required_units.map(r=>`<li>${r.quantity ?? r.count ?? r.qty ?? 1} ${r.type}</li>`).join('') + '</ul></div>';
  }
  let assignedHtml = '';
  if (assigned.length) {
    assignedHtml = '<div style="margin-top:8px;"><strong>Assigned Units:</strong><ul>' + assigned.map(u=>`<li>${u.name} - ${u.status}</li>`).join('') + '</ul></div>';
  }
  pane.innerHTML = `<div style="text-align:right"><button id="closeDetail">Close</button></div>
    <h3>${mission.type}</h3>
    ${time}
    <div>${mission.address||''}</div>
    ${reqHtml}
    ${assignedHtml}
    <div style="margin-top:8px;">
      <button id="manualDispatch">Manual Dispatch</button>
      <button id="autoDispatch">Auto Dispatch</button>
      <button id="runCardDispatch">Run Card</button>
    </div>`;
  pane.classList.remove('hidden');
  document.getElementById('closeDetail').onclick = ()=>{
    pane.classList.add('hidden');
    document.getElementById('cadUnits').classList.add('hidden');
  };
  document.getElementById('manualDispatch').onclick = ()=>openManualDispatch(mission);
  document.getElementById('autoDispatch').onclick = ()=>autoDispatch(mission);
  document.getElementById('runCardDispatch').onclick = ()=>runCardDispatch(mission);
}

async function autoDispatch(mission) {
  // Simple auto dispatch: pick first available units matching required types
  const [stations, units] = await Promise.all([
    getStations(),
    fetchNoCache('/api/units?status=available').then(r=>r.json())
  ]);
  const stMap = new Map(stations.map(s=>[s.id,s]));
  const missionDepts = Array.isArray(mission.departments) ? mission.departments : [];
  const available = units.filter(u=>{
    const st = stMap.get(u.station_id);
    return u.status==='available' && (missionDepts.length===0 || (st && missionDepts.includes(st.department)));
  });
  const reqs = Array.isArray(mission.required_units) ? mission.required_units : [];
  const selected = [];
  reqs.forEach(r=>{
    const need = r.quantity ?? r.count ?? r.qty ?? 1;
    const matches = available.filter(u=>u.type===r.type && !selected.includes(u)).slice(0, need);
    selected.push(...matches);
  });
  await dispatchUnits(mission.id, selected.map(u=>u.id));
  await loadMissions();
}

async function runCardDispatch(mission) {
  try {
    const rc = await fetchNoCache(`/api/run-cards/${encodeURIComponent(mission.type)}`).then(r=>r.json());
    const unitTypes = rc.units || [];
    const units = await fetchNoCache('/api/units?status=available').then(r=>r.json());
    const selected = [];
    unitTypes.forEach(t=>{
      const match = units.find(u=>u.type===t && !selected.includes(u));
      if (match) selected.push(match);
    });
    await dispatchUnits(mission.id, selected.map(u=>u.id));
    await loadMissions();
  } catch(e) {
    console.error(e);
  }
}

async function dispatchUnits(missionId, unitIds) {
  for (const id of unitIds) {
    await fetch('/api/mission-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mission_id: missionId, unit_id: id })
    });
  }
}

async function openManualDispatch(mission) {
  const unitsPane = document.getElementById('cadUnits');
  const [stations, units] = await Promise.all([
    getStations(),
    fetchNoCache('/api/units').then(r=>r.json())
  ]);
  const stMap = new Map(stations.map(s=>[s.id,s]));
  const available = units.filter(u=>u.status==='available');
  const groups = {};
  available.forEach(u=>{
    const st = stMap.get(u.station_id);
    const dept = st?.department || 'Unknown';
    if (!groups[dept]) groups[dept] = [];
    groups[dept].push(u);
  });
  let html = '<div class="cad-unit-header"><button id="dispatchUnits">Dispatch</button><button id="closeUnits">Close</button></div>';
  for (const dept of Object.keys(groups).sort()) {
    html += `<h4>${dept}</h4><ul>`;
    for (const u of groups[dept].sort((a,b)=>a.name.localeCompare(b.name))) {
      html += `<li><label><input type="checkbox" value="${u.id}"> ${u.name}</label></li>`;
    }
    html += '</ul>';
  }
  unitsPane.innerHTML = html;
  unitsPane.classList.remove('hidden');
  document.getElementById('closeUnits').onclick = ()=>unitsPane.classList.add('hidden');
  document.getElementById('dispatchUnits').onclick = async ()=>{
    const ids = Array.from(unitsPane.querySelectorAll('input[type=checkbox]:checked')).map(c=>Number(c.value));
    await dispatchUnits(mission.id, ids);
    unitsPane.classList.add('hidden');
    await loadMissions();
  };
}

document.addEventListener('DOMContentLoaded', init);
