import { fetchNoCache, formatTime, playSound } from './common.js';
import { getMissions, renderMissionRow } from './missions.js';
import { getStations, renderStationList } from './stations.js';
import { editUnit, editPersonnel } from './edit-dialogs.js';

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
  const missions = await getMissions();
  await updateWallet();
  const container = document.getElementById('cadMissions');
  const scrollPos = container.scrollTop;

  const existing = new Map();
  container.querySelectorAll('.cad-mission').forEach(el => existing.set(el.dataset.id, el));

  missions.forEach(m => {
    const id = String(m.id);
    const html = renderMissionRow(m);
    let el = existing.get(id);
    if (el) {
      const temp = document.createElement('div');
      temp.innerHTML = html;
      const newEl = temp.firstElementChild;
      el.innerHTML = newEl.innerHTML;
      existing.delete(id);
    } else {
      const temp = document.createElement('div');
      temp.innerHTML = html;
      el = temp.firstElementChild;
      el.addEventListener('click', () => openMission(el.dataset.id));
    }
    container.appendChild(el);
  });

  existing.forEach(el => el.remove());

  container.scrollTop = scrollPos;
  cachedMissions = missions;
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
  window.currentStation = st;
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
  document.getElementById('newPersonnel').onclick = () => openNewPersonnel(st);
  document.getElementById('newUnit').onclick = () => openNewUnit(st);
  document.getElementById('newEquipment').onclick = () => openNewEquipment(st);
  pane.querySelectorAll('.cad-unit').forEach(li => li.addEventListener('click', () => editUnit(Number(li.dataset.id))));
  pane.querySelectorAll('.cad-personnel').forEach(li => li.addEventListener('click', () => editPersonnel(Number(li.dataset.id))));
}

window.refreshStationPanelNoCache = showStation;

function getTrainingsForClass(cls) {
  const key = String(cls || '').toLowerCase();
  if (typeof trainingsByClass !== 'undefined' && trainingsByClass[key]) {
    return trainingsByClass[key];
  }
  return [];
}

function openNewPersonnel(st) {
  const pane = document.getElementById('cadStations');
  const trainings = getTrainingsForClass(st.type);
  const options = trainings.length ? trainings : [{ name: 'general', cost: 0 }];
  let html = `<div style="text-align:right"><button id="cancelNewPers">Back</button></div>`;
  html += `<h3>Add Personnel - ${st.name}</h3>`;
  html += `<input id="persName" placeholder="Name"/><div id="persTrainings">`;
  html += options.map((t, idx)=>{
    const name = typeof t === 'string' ? t : t.name;
    const cost = typeof t === 'object' && t.cost ? t.cost : 0;
    return `<label><input type="checkbox" value="${name}" data-cost="${cost}" ${idx===0?'checked':''}/> ${name}${cost?` ($${cost})`:''}</label><br>`;
  }).join('');
  html += `</div><div id="persCost"></div><button id="createPers">Create</button>`;
  pane.innerHTML = html;
  document.getElementById('cancelNewPers').onclick = () => showStation(st.id);
  const nameInput = document.getElementById('persName');
  fetch('/api/random-name').then(r=>r.json()).then(n=>{
    if (n.first && n.last) nameInput.value = `${n.first} ${n.last}`;
  }).catch(()=>{});
  function updateCost(){
    const base = 100;
    const selected = Array.from(document.querySelectorAll('#persTrainings input:checked'));
    const cost = base + selected.reduce((sum,cb)=>sum+Number(cb.dataset.cost||0),0);
    document.getElementById('persCost').textContent = `Cost: $${cost}`;
  }
  document.querySelectorAll('#persTrainings input').forEach(cb=>cb.addEventListener('change', updateCost));
  updateCost();
  document.getElementById('createPers').onclick = async ()=>{
    const name = nameInput.value.trim();
    const training = Array.from(document.querySelectorAll('#persTrainings input:checked')).map(cb=>cb.value);
    if (!name) return alert('Missing name');
    const res = await fetch('/api/personnel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ name, station_id: st.id, training })});
    const data = await res.json();
    if (!res.ok) { alert(`Failed: ${data.error || res.statusText}`); return; }
    alert(`Personnel added. Cost: $${data.charged}`);
    showStation(st.id);
  };
}

function openNewUnit(st) {
  const pane = document.getElementById('cadStations');
  const types = (typeof unitTypes !== 'undefined' ? unitTypes : []).filter(u=>u.class===st.type);
  const options = types.map(t=>`<option value="${t.type}">${t.type}</option>`).join('');
  let html = `<div style="text-align:right"><button id="cancelNewUnit">Back</button></div>`;
  html += `<h3>New Unit - ${st.name}</h3>`;
  html += `<label>Type: <select id="unitType">${options}</select></label><br>`;
  html += `<label>Name: <input id="unitName"/></label><br>`;
  html += `<label>Priority: <input id="unitPriority" type="number" min="1" max="5" value="1" style="width:60px;"></label><br>`;
  html += `<button id="createUnitBtn">Create</button>`;
  pane.innerHTML = html;
  document.getElementById('cancelNewUnit').onclick = () => showStation(st.id);
  document.getElementById('createUnitBtn').onclick = async ()=>{
    const type = document.getElementById('unitType').value;
    const name = document.getElementById('unitName').value.trim();
    const priority = Number(document.getElementById('unitPriority').value)||1;
    if (!type || !name) return alert('Missing name or type');
    const res = await fetch('/api/units',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({station_id: st.id,class: st.type,type,name,priority})});
    if(!res.ok){ const data = await res.json().catch(()=>({})); alert(`Failed: ${data.error || res.statusText}`); return; }
    showStation(st.id);
  };
}

function openNewEquipment(st) {
  const pane = document.getElementById('cadStations');
  const list = (typeof equipment !== 'undefined' && equipment[st.type]) ? equipment[st.type] : [];
  const options = list.map(e=>`<option value="${e.name}" data-cost="${e.cost}">${e.name} ($${e.cost})</option>`).join('');
  let html = `<div style="text-align:right"><button id="cancelNewEquip">Back</button></div>`;
  html += `<h3>Buy Equipment - ${st.name}</h3>`;
  html += `<label>Equipment: <select id="equipSelect">${options}</select></label><br>`;
  html += `<button id="buyEquipBtn">Buy</button>`;
  pane.innerHTML = html;
  document.getElementById('cancelNewEquip').onclick = () => showStation(st.id);
  document.getElementById('buyEquipBtn').onclick = async ()=>{
    const select = document.getElementById('equipSelect');
    const name = select.value;
    if (!name) return alert('Select equipment');
    const res = await fetch(`/api/stations/${st.id}/equipment`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name })});
    const data = await res.json();
    if (!res.ok) { alert(`Failed: ${data.error || res.statusText}`); return; }
    alert(`Purchased ${name} for $${data.cost}`);
    showStation(st.id);
  };
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
      const types = Array.isArray(r.types) ? r.types : [r.type];
      const have = types.reduce((s,t)=>s+(assignedCounts[t]||0),0);
      return `<li>${need} ${types.join(' or ')} (${have}/${need})</li>`;
    }).join('') + '</ul></div>';
  }
  let assignedHtml = '';
  if (assigned.length) {
    assignedHtml = '<div style="margin-top:8px;"><strong>Assigned Units:</strong><ul>' + assigned.map(u=>{
      let etaText = '';
      if (u.eta) {
        const sec = Math.max(0, (u.eta - Date.now()) / 1000);
        etaText = ` (${formatTime(sec)})`;
      }
      return `<li>${u.name} - ${u.status}${etaText}</li>`;
    }).join('') + '</ul></div>';
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
      <button id="classDispatchBtn">Class Dispatch</button>
    </div>`;
  pane.classList.remove('hidden');
  document.getElementById('closeDetail').onclick = ()=>{
    pane.classList.add('hidden');
    document.getElementById('cadUnits').classList.add('hidden');
  };
  document.getElementById('manualDispatch').onclick = ()=>openManualDispatch(mission);
  document.getElementById('autoDispatch').onclick = ()=>autoDispatch(mission);
  document.getElementById('runCardDispatch').onclick = ()=>runCardDispatch(mission);
  document.getElementById('classDispatchBtn').onclick = ()=>openClassDispatch(mission);
}

async function autoDispatch(mission) {
  try {
    const [stations, allUnitsRaw] = await Promise.all([
      getStations(),
      fetchNoCache('/api/units?status=available').then(r=>r.json())
    ]);
    const stMap = new Map(stations.map(s=>[s.id,s]));
    const missionDepts = Array.isArray(mission.departments) ? mission.departments : [];
    const allUnits = allUnitsRaw
      .filter(u=>{
        const st = stMap.get(u.station_id);
        return missionDepts.length===0 || (st && missionDepts.includes(st.department));
      })
      .map(u=>{
        const st = stMap.get(u.station_id);
        const dist = st ? haversine(mission.lat, mission.lon, st.lat, st.lon) : Infinity;
        const priority = Number(u.priority) || 1;
        return { ...u, priority, _dist: dist };
      });

    const sortUnits = (a,b)=>{
      if (a.station_id === b.station_id) return a.priority - b.priority;
      return a._dist - b._dist;
    };

    function trainingCount(u, name) {
      let c = 0;
      for (const p of Array.isArray(u.personnel)?u.personnel:[]) {
        for (const t of Array.isArray(p.training)?p.training:[]) {
          if (String(t).toLowerCase() === String(name).toLowerCase()) c++;
        }
      }
      return c;
    }
    function equipmentCount(u, name) {
      return Array.isArray(u.equipment)
        ? u.equipment.filter(e=>String(e).toLowerCase()===String(name).toLowerCase()).length
        : 0;
    }

    const selected = [];
    const selectedIds = new Set();

    const trainingNeeds = (Array.isArray(mission.required_training)?mission.required_training:[])
      .map(r=>({ name: r.training || r.name || r, qty: r.qty ?? r.quantity ?? r.count ?? 1 }));
    const equipmentNeeds = (Array.isArray(mission.equipment_required)?mission.equipment_required:[])
      .map(r=>({ name: r.name || r.type || r, qty: r.qty ?? r.quantity ?? r.count ?? 1 }));

    function applyNeeds(u) {
      for (const n of trainingNeeds) n.qty -= trainingCount(u, n.name);
      for (const n of equipmentNeeds) n.qty -= equipmentCount(u, n.name);
    }

    function unitMatchesNeed(u) {
      return trainingNeeds.some(n=>n.qty>0 && trainingCount(u,n.name)>0) ||
             equipmentNeeds.some(n=>n.qty>0 && equipmentCount(u,n.name)>0);
    }

    function unitMatchesAllNeeds(u) {
      return trainingNeeds.every(n=>n.qty<=0 || trainingCount(u,n.name)>0) &&
             equipmentNeeds.every(n=>n.qty<=0 || equipmentCount(u,n.name)>0);
    }

    function selectUnit(u) {
      selectedIds.add(u.id);
      selected.push(u);
      applyNeeds(u);
    }

    const reqUnits = Array.isArray(mission.required_units) ? mission.required_units : [];
    for (const r of reqUnits) {
      const need = r.quantity ?? r.count ?? r.qty ?? 1;
      for (let i=0; i<need; i++) {
        const types = Array.isArray(r.types) ? r.types : [r.type];
        let candidates = allUnits.filter(u=>!selectedIds.has(u.id) && types.includes(u.type))
                                 .sort(sortUnits);
        if (!candidates.length) { alert('No available units meet the requirements.'); return; }
        const chosen = candidates.find(unitMatchesAllNeeds) ||
                       candidates.find(unitMatchesNeed) ||
                       candidates[0];
        selectUnit(chosen);
      }
    }

    for (const n of trainingNeeds) {
      while (n.qty > 0) {
        const candidates = allUnits.filter(u=>!selectedIds.has(u.id) && trainingCount(u,n.name)>0)
                                   .sort(sortUnits);
        if (!candidates.length) { alert('Insufficient training to meet requirements.'); return; }
        selectUnit(candidates[0]);
      }
    }

    for (const n of equipmentNeeds) {
      while (n.qty > 0) {
        const candidates = allUnits.filter(u=>!selectedIds.has(u.id) && equipmentCount(u,n.name)>0)
                                   .sort(sortUnits);
        if (!candidates.length) { alert('Insufficient equipment to meet requirements.'); return; }
        selectUnit(candidates[0]);
      }
    }

    if (!selected.length) { alert('No available units meet the requirements.'); return; }
    await dispatchUnits(mission, selected);
    await loadMissions();
    await openMission(mission.id);
  } catch (e) {
    console.error(e);
    alert('Auto dispatch failed.');
  }
}

async function runCardDispatch(mission) {
  let area = document.getElementById('manualDispatchArea');
  let tempArea = false;
  if (!area) {
    area = document.createElement('div');
    area.id = 'manualDispatchArea';
    area.style.display = 'none';
    document.body.appendChild(area);
    tempArea = true;
  }
  try {
    const res = await fetch(`/api/run-cards/${encodeURIComponent(mission.type)}`);
    if (!res.ok) { alert('No run card for this mission.'); return; }
    const rc = await res.json();
    const rcMission = {
      ...mission,
      departments: mission.departments || [],
      required_units: rc.units || [],
      required_training: rc.training || [],
      equipment_required: rc.equipment || []
    };
    await autoDispatch(rcMission);
  } catch (e) {
    console.error(e);
    alert('Run card dispatch failed.');
  } finally {
    if (tempArea) area.remove();
  }
}

async function dispatchUnits(mission, units) {
  for (const u of units) {
    await fetch('/api/mission-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mission_id: mission.id, unit_id: u.id })
    });

    try {
      const st = cachedStations.find(s => s.id === u.station_id);
      if (!st) continue;
      const from = [st.lat, st.lon];
      const to = [mission.lat, mission.lon];
      const coords = [from, to];
      const distKm = haversine(from[0], from[1], to[0], to[1]);
      const baseSpeed = 56; // km/h
      const mult = ({ fire: 1.2, police: 1.3, ambulance: 1.25 }[u.class] || 1);
      const total_duration = Math.max(5, (distKm / (baseSpeed * mult)) * 3600);
      const seg_durations = [total_duration];
      await fetch('/api/unit-travel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          unit_id: u.id,
          mission_id: mission.id,
          phase: 'to_scene',
          started_at: new Date().toISOString(),
          from,
          to,
          coords,
          seg_durations,
          total_duration
        })
      });
    } catch (e) {
      console.warn('Failed to record unit travel', e);
    }
  }
  if (units.length) playSound('/audio/dispatch.mp3');
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
    const selectedUnits = ids.map(id => available.find(u => u.id === id)).filter(Boolean);
    await dispatchUnits(mission, selectedUnits);
    unitsPane.classList.add('hidden');
    await loadMissions();
    await openMission(mission.id);
  };
}

async function openClassDispatch(mission) {
  const unitsPane = document.getElementById('cadUnits');
  const [stations, units] = await Promise.all([
    getStations(),
    fetchNoCache('/api/units?status=available').then(r=>r.json())
  ]);
  const stMap = new Map(stations.map(s=>[s.id,s]));
  const groups = { fire: [], police: [], ambulance: [] };
  units.forEach(u=>{
    const st = stMap.get(u.station_id);
    const dist = st ? haversine(mission.lat, mission.lon, st.lat, st.lon) : Infinity;
    if (groups[u.class]) groups[u.class].push({ ...u, distance: dist });
  });
  let html = '<div class="cad-unit-header"><button id="closeClass">Close</button></div>';
  for (const cls of Object.keys(groups)) {
    const arr = groups[cls].sort((a,b)=>a.distance-b.distance);
    html += `<div><strong>${cls.charAt(0).toUpperCase()+cls.slice(1)}</strong> (${arr.length}) <button data-class="${cls}" class="class-send">Send 1</button></div>`;
  }
  unitsPane.innerHTML = html;
  unitsPane.classList.remove('hidden');
  document.getElementById('closeClass').onclick = ()=>unitsPane.classList.add('hidden');
  unitsPane.querySelectorAll('.class-send').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const cls = btn.dataset.class;
      const list = groups[cls];
      if (!list.length) { alert('No available units'); return; }
      const unit = list.shift();
      await dispatchUnits(mission, [unit]);
      await loadMissions();
      await openMission(mission.id);
      openClassDispatch(mission);
    });
  });
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
    playSound('/audio/newalert.mp3');
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
