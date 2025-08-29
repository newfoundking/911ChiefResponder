import { fetchNoCache, formatTime } from './common.js';
import { getMissions, renderMissionRow } from './missions.js';
import { getStations, renderStationList } from './stations.js';

let cachedMissions = [];
let cachedStations = [];

async function init() {
  document.getElementById('returnMain').addEventListener('click', ()=>location.href='index.html');
  await loadStations();
  await loadMissions();
  setInterval(loadMissions, 5000);
}

async function loadMissions() {
  cachedMissions = await getMissions();
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
  const st = await fetchNoCache(`/api/stations/${id}`).then(r=>r.json());
  const pane = document.getElementById('cadStations');
  pane.innerHTML = `<div class="cad-station-detail"><div style="text-align:right"><button id="closeStationDetail">Close</button></div><h3>${st.name}</h3><p>Type: ${st.type}</p><p>Department: ${st.department||''}</p></div>`;
  document.getElementById('closeStationDetail').onclick = loadStations;
}

function openMission(id) {
  const mission = cachedMissions.find(m=>String(m.id)===String(id));
  const pane = document.getElementById('cadDetail');
  let time = '';
  if (mission.resolve_at) {
    const sec = Math.max(0,(mission.resolve_at - Date.now())/1000);
    time = `<div>Time Remaining: ${formatTime(sec)}</div>`;
  }
  pane.innerHTML = `<div style="text-align:right"><button id="closeDetail">Close</button></div>
    <h3>${mission.type}</h3>
    ${time}
    <div>${mission.address||''}</div>
    <div style="margin-top:8px;">
      <button id="manualDispatch">Manual Dispatch</button>
      <button id="autoDispatch">Auto Dispatch</button>
      <button id="runCardDispatch">Run Card</button>
    </div>`;
  pane.classList.remove('hidden');
  document.getElementById('closeDetail').onclick = ()=>pane.classList.add('hidden');
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
  unitsPane.classList.add('active');
  document.getElementById('closeUnits').onclick = ()=>unitsPane.classList.remove('active');
  document.getElementById('dispatchUnits').onclick = async ()=>{
    const ids = Array.from(unitsPane.querySelectorAll('input[type=checkbox]:checked')).map(c=>Number(c.value));
    await dispatchUnits(mission.id, ids);
    unitsPane.classList.remove('active');
    await loadMissions();
  };
}

document.addEventListener('DOMContentLoaded', init);
