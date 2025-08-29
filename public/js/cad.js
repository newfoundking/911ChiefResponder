import { fetchNoCache, formatTime } from './common.js';
import { getMissions, renderMissionRow } from './missions.js';
import { getStations, renderStationList } from './stations.js';

let missionTemplates = [];
fetch('/api/mission-templates')
  .then(r => r.json())
  .then(data => { missionTemplates = data.map(t => ({ ...t, frequency: Number(t.frequency) || 3 })); })
  .catch(err => console.error('Failed to load mission templates:', err));

const missionAddressCache = {};
async function reverseGeocode(lat, lon, id) {
  if (id && missionAddressCache[id]) return missionAddressCache[id];
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`);
    const data = await res.json();
    const addr = data?.display_name || '';
    if (id) missionAddressCache[id] = addr;
    return addr;
  } catch {
    return '';
  }
}

function randomCount({min=0, max=0, chance=1}) {
  min = Math.floor(min); max = Math.floor(max);
  if (max <= min) return min;
  if (Math.random() < chance) return max;
  return min + Math.floor(Math.random() * (max - min));
}

function instantiatePatients(arr) {
  return (arr || []).map(p => {
    const count = randomCount(p);
    return { count, codes: p.codes };
  }).filter(p => p.count > 0);
}

function instantiatePrisoners(arr) {
  return (arr || []).map(p => {
    const count = randomCount(p);
    const transportChance = Number(p.transportChance) || 0;
    let transport = 0;
    for (let i = 0; i < count; i++) {
      if (Math.random() < transportChance) transport++;
    }
    return { count, transport };
  }).filter(p => p.count > 0);
}

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180, la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

let cachedMissions = [];
let cachedStations = [];

async function init() {
  document.getElementById('returnMain').addEventListener('click', ()=>location.href='index.html');
  await updateWallet();
  await loadStations();
  await loadMissions();
  setInterval(loadMissions, 5000);

  document.querySelectorAll('.cad-speed').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.cad-speed').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      switch (btn.dataset.speed) {
        case 'pause':
          setMissionGenerationSpeed(null);
          break;
        case 'slow':
          setMissionGenerationSpeed([90,150]);
          break;
        case 'medium':
          setMissionGenerationSpeed([30,90]);
          break;
        case 'fast':
          setMissionGenerationSpeed([10,30]);
          break;
      }
    });
  });
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
  const assignedCounts = {};
  assigned.forEach(u => {
    assignedCounts[u.type] = (assignedCounts[u.type] || 0) + 1;
  });
  let reqHtml = '';
  if (Array.isArray(mission.required_units) && mission.required_units.length) {
    reqHtml = '<div><strong>Required Units:</strong><ul>' + mission.required_units.map(r=>{
      const need = r.quantity ?? r.count ?? r.qty ?? 1;
      const have = assignedCounts[r.type] || 0;
      return `<li>${need} ${r.type} (${have}/${need})</li>`;
    }).join('') + '</ul></div>';
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
  await openMission(mission.id);
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
    await openMission(mission.id);
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
  const available = units.filter(u=>u.status==='available').map(u=>{
    const st = stMap.get(u.station_id);
    const dist = st ? haversine(mission.lat, mission.lon, st.lat, st.lon) : Infinity;
    return { ...u, department: st?.department || 'Unknown', distance: dist };
  });
  const groups = {};
  available.forEach(u=>{
    if (!groups[u.department]) groups[u.department] = [];
    groups[u.department].push(u);
  });
  let html = '<div class="cad-unit-header"><button id="dispatchUnits">Dispatch</button><button id="closeUnits">Close</button></div>';
  for (const dept of Object.keys(groups).sort()) {
    html += `<h4>${dept}</h4><ul>`;
    for (const u of groups[dept].sort((a,b)=>a.distance - b.distance)) {
      html += `<li><label><input type="checkbox" value="${u.id}"> ${u.name} (${u.distance.toFixed(1)} km)</label></li>`;
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
    await openMission(mission.id);
  };
}

async function generateMission(retry = false, excludeIndex = null) {
  if (missionTemplates.length === 0) { alert("No mission templates loaded."); return; }
  const stations = await fetch('/api/stations').then(r => r.json()).catch(() => []);
  if (!stations.length) { alert("No stations available."); return; }
  const st = stations[Math.floor(Math.random() * stations.length)];
  const radius = 5000;

  let availableTemplates = missionTemplates;
  if (excludeIndex !== null) {
    availableTemplates = missionTemplates.filter((_, idx) => idx !== excludeIndex);
    if (!availableTemplates.length) return;
  }
  const weights = availableTemplates.map(t => Math.max(1, 6 - (Number(t.frequency) || 3)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let pick = Math.random() * totalWeight;
  let template = availableTemplates[0];
  for (let i = 0; i < availableTemplates.length; i++) {
    if ((pick -= weights[i]) < 0) { template = availableTemplates[i]; break; }
  }
  const templateIndex = missionTemplates.indexOf(template);

  let lat, lon;
  if (template.trigger_type === 'poi' && template.trigger_filter) {
    try {
      const pois = await fetch(`/api/pois?lat=${st.lat}&lon=${st.lon}&radius=${radius}`)
        .then(r => r.json()).catch(() => []);
      const matches = pois.filter(p => p.tags && p.tags.amenity === template.trigger_filter);
      if (matches.length) {
        const poi = matches[Math.floor(Math.random() * matches.length)];
        lat = poi.lat; lon = poi.lon;
      } else {
        console.warn('No matching POI found.');
        if (!retry) return generateMission(true, templateIndex);
        return;
      }
    } catch (e) {
      console.error('POI lookup failed', e);
      alert('POI lookup failed.');
      return;
    }
  } else if (template.trigger_type === 'intersection' && template.trigger_filter) {
    const [road1, road2] = String(template.trigger_filter).split('|');
    if (road1 && road2) {
      try {
        const query = `[out:json];way["name"="${road1}"](around:${radius},${st.lat},${st.lon});way["name"="${road2}"](around:${radius},${st.lat},${st.lon});node(w["name"="${road1}"])(w["name"="${road2}"]);out;`;
        const resp = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query));
        const data = await resp.json();
        if (Array.isArray(data.elements) && data.elements.length) {
          const inter = data.elements[0];
          lat = inter.lat; lon = inter.lon;
        }
      } catch (e) { console.error('Intersection lookup failed', e); }
    }
  }
  if (lat === undefined || lon === undefined) {
    try {
      const roadQuery = `[out:json];way["highway"](around:${radius},${st.lat},${st.lon});out geom;`;
      const roadResp = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(roadQuery));
      const roadData = await roadResp.json();
      if (Array.isArray(roadData.elements) && roadData.elements.length) {
        const way = roadData.elements[Math.floor(Math.random() * roadData.elements.length)];
        const geom = Array.isArray(way.geometry) ? way.geometry : [];
        if (geom.length) {
          const pt = geom[Math.floor(Math.random() * geom.length)];
          lat = pt.lat;
          lon = pt.lon;
        }
      }
    } catch (e) { console.error('Road lookup failed', e); }
  }
  if (lat === undefined || lon === undefined) {
    lat = st.lat;
    lon = st.lon;
  }

  const missionData = {
    type: template.name, lat, lon,
    required_units: template.required_units,
    required_training: template.required_training || [],
    equipment_required: template.equipment_required || [],
    patients: instantiatePatients(template.patients),
    prisoners: instantiatePrisoners(template.prisoners),
    modifiers: template.modifiers || [],
    penalty_options: template.penalty_options || [],
    penalties: [],
    timing: template.timing ?? 10
  };
  try {
    const res = await fetch('/api/missions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(missionData) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadMissions();
  } catch (err) { console.error("Failed to create mission:", err); alert("Failed to create mission."); }
}

let missionGenTimer = null;
let missionGenRange = null;

function scheduleMissionGeneration() {
  if (!missionGenRange) return;
  const [min, max] = missionGenRange;
  const delay = (Math.floor(Math.random() * (max - min + 1)) + min) * 1000;
  missionGenTimer = setTimeout(() => {
    generateMission();
    scheduleMissionGeneration();
  }, delay);
}

function setMissionGenerationSpeed(range) {
  if (missionGenTimer) clearTimeout(missionGenTimer);
  missionGenRange = range;
  if (range) scheduleMissionGeneration();
}

document.addEventListener('DOMContentLoaded', init);
