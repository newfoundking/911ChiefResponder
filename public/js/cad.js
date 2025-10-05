import { fetchNoCache, formatTime, playSound, formatStatus, formatCurrency } from './common.js';
import { getMissions, renderMissionRow } from './missions.js';
import { getStations, renderStationList } from './stations.js';
import { editUnit, editPersonnel } from './edit-dialogs.js';

const cleanRank = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const fetchRankOptions = (dept) => {
  if (typeof window !== 'undefined' && typeof window.fetchDepartmentRanks === 'function') {
    return window.fetchDepartmentRanks(dept);
  }
  return Promise.resolve([]);
};

const defaultEquipmentProvider = (typeof globalThis !== 'undefined' && typeof globalThis.getDefaultUnitEquipment === 'function')
  ? globalThis.getDefaultUnitEquipment
  : (typeof window !== 'undefined' && typeof window.getDefaultUnitEquipment === 'function'
      ? window.getDefaultUnitEquipment
      : null);

const equipmentKey = (name) => {
  if (name === null || name === undefined) return '';
  const trimmed = String(name).trim();
  return trimmed ? trimmed.toLowerCase() : '';
};

function gatherEquipmentForUnit(unit) {
  const counts = new Map();
  if (!unit) return counts;
  const eqArr = Array.isArray(unit.equipment) ? unit.equipment : [];
  for (const eq of eqArr) {
    const label = typeof eq === 'string' ? eq : eq?.name;
    const key = equipmentKey(label);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (typeof defaultEquipmentProvider === 'function') {
    const defaults = defaultEquipmentProvider(unit.class, unit.type) || [];
    for (const provided of defaults) {
      const key = equipmentKey(provided);
      if (!key || counts.has(key)) continue;
      counts.set(key, 1);
    }
  }
  return counts;
}

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

async function fetchRouteOSRM(from, to) {
  const url = `/api/route?from=${from[0]},${from[1]}&to=${to[0]},${to[1]}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`route ${res.status}`);
  // Server may return additional metadata such as snapped endpoints and
  // provider information.  Pass through the full JSON so callers can make
  // use of it.
  return res.json();
}

let cachedMissions = [];
let cachedStations = [];
let map;
let selectedMissionId = null;
const stationMarkers = new Map();
const missionMarkers = new Map();

function makeIcon(url, size) {
  return L.icon({ iconUrl: url, iconSize: [size, size], iconAnchor: [size / 2, size] });
}

const stationIcons = {
  fire: makeIcon('/fire.png', 24),
  police: makeIcon('/police.png', 24),
  ambulance: makeIcon('/star.png', 24),
  sar: makeIcon('/sar.png', 24),
  hospital: makeIcon('/images/hospital.png', 24),
  jail: makeIcon('/images/prison.png', 24)
};

const missionIcons = {
  1: makeIcon('/warning1.png', 30),
  2: makeIcon('/warning2.png', 30),
  3: makeIcon('/warning3.png', 30)
};

function initMap() {
  map = L.map('cadMap').setView([47.5646, -52.7002], 13);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);
}

function fitMapToMarkers() {
  if (!map) return;
  const all = [...stationMarkers.values(), ...missionMarkers.values()];
  if (!all.length) return;
  const group = L.featureGroup(all);
  map.fitBounds(group.getBounds().pad(0.1));
  map.closePopup();
}

function updateStationMarkers(stations) {
  stationMarkers.forEach(m => map.removeLayer(m));
  stationMarkers.clear();
  stations.forEach(st => {
    if (Number.isFinite(st.lat) && Number.isFinite(st.lon)) {
      const icon = stationIcons[st.type] || stationIcons.fire;
      const marker = L.marker([st.lat, st.lon], { icon }).addTo(map).bindPopup(st.name);
      stationMarkers.set(st.id, marker);
    }
  });
}

function updateMissionMarkers(missions) {
  missionMarkers.forEach(m => map.removeLayer(m));
  missionMarkers.clear();
  missions.forEach(m => {
    if (Number.isFinite(m.lat) && Number.isFinite(m.lon)) {
      const icon = missionIcons[m.level] || missionIcons[1];
      const marker = L.marker([m.lat, m.lon], { icon }).addTo(map).bindPopup(m.type || 'Mission');
      missionMarkers.set(m.id, marker);
    }
  });
}

function showMissionOnMap(mission) {
  if (!map) return;
  selectedMissionId = mission.id;
  if (Number.isFinite(mission.lat) && Number.isFinite(mission.lon)) {
    map.setView([mission.lat, mission.lon], 13);
    const marker = missionMarkers.get(mission.id);
    if (marker) marker.openPopup();
  }
}

async function init() {
  document.getElementById('returnMain').addEventListener('click', ()=>location.href='index.html');
  document.getElementById('generateMission')
          .addEventListener('click', () => generateMission());
  initMap();
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
    document.getElementById('walletDisplay').textContent = `Balance: ${formatCurrency(w.balance)}`;
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

  updateMissionMarkers(missions);
  if (!selectedMissionId) fitMapToMarkers();

  container.scrollTop = scrollPos;
  missions.forEach((m, idx) => {
    setTimeout(() => {
      checkMissionCompletion(m).catch(() => {});
    }, idx * 100);
  });
  cachedMissions = missions;
}

async function checkMissionCompletion(mission) {
  try {
    const assigned = await fetchNoCache(`/api/missions/${mission.id}/units`).then(r => r.json());
    const unitOnScene = new Map();
    const equipOnScene = new Map();
    const trainOnScene = new Map();
    for (const u of assigned) {
      if (u.status === 'on_scene') {
        unitOnScene.set(u.type, (unitOnScene.get(u.type) || 0) + 1);
        for (const e of Array.isArray(u.equipment) ? u.equipment : []) {
          equipOnScene.set(e, (equipOnScene.get(e) || 0) + 1);
        }
        for (const p of Array.isArray(u.personnel) ? u.personnel : []) {
          for (const t of Array.isArray(p.training) ? p.training : []) {
            trainOnScene.set(t, (trainOnScene.get(t) || 0) + 1);
          }
        }
      }
    }
    const reqUnits = Array.isArray(mission.required_units) ? mission.required_units : [];
    const reqEquip = Array.isArray(mission.equipment_required) ? mission.equipment_required : [];
    const reqTrain = Array.isArray(mission.required_training) ? mission.required_training : [];
    const penalties = Array.isArray(mission.penalties) ? mission.penalties : [];
    const unitsMet = reqUnits.every(r => {
      const types = Array.isArray(r.types) ? r.types : [r.type];
      const baseNeed = r.quantity ?? r.count ?? r.qty ?? 1;
      const ignored = penalties
        .filter(p => (!p.category || p.category === 'unit') && types.includes(p.type))
        .reduce((s, p) => s + (Number(p.quantity) || 0), 0);
      const need = Math.max(0, baseNeed - ignored);
      const count = types.reduce((s, t) => s + (unitOnScene.get(t) || 0), 0);
      return count >= need;
    });
    const equipMet = reqEquip.every(r => {
      const name = r.name || r.type || r;
      const baseNeed = r.qty ?? r.quantity ?? r.count ?? 1;
      const ignored = penalties
        .filter(p => p.category === 'equipment' && (p.type === name || p.name === name))
        .reduce((s, p) => s + (Number(p.quantity) || 0), 0);
      const need = Math.max(0, baseNeed - ignored);
      return (equipOnScene.get(name) || 0) >= need;
    });
    const trainMet = reqTrain.every(r => {
      const name = r.training || r.name || r;
      const baseNeed = r.qty ?? r.quantity ?? r.count ?? 1;
      const ignored = penalties
        .filter(p => p.category === 'training' && (p.type === name || p.name === name))
        .reduce((s, p) => s + (Number(p.quantity) || 0), 0);
      const need = Math.max(0, baseNeed - ignored);
      return (trainOnScene.get(name) || 0) >= need;
    });
    if (!unitsMet || !equipMet || !trainMet) return;

    let reduction = 0;
    for (const mod of Array.isArray(mission.modifiers) ? mission.modifiers : []) {
      if (!mod || typeof mod !== 'object') continue;
      const per = Number(mod.timeReduction) || 0;
      if (!per) continue;
      let have = 0;
      switch (mod.category) {
        case 'equipment':
          have = equipOnScene.get(mod.type) || 0;
          break;
        case 'training':
          have = trainOnScene.get(mod.type) || 0;
          break;
        default:
          have = unitOnScene.get(mod.type) || 0;
      }
      const maxCount = Number(mod.maxCount) || 1;
      reduction += Math.min(have, maxCount) * per;
    }
    const penaltyTime = penalties.reduce((s, p) => s + (Number(p.timePenalty) || 0), 0);
    reduction = Math.max(-100, Math.min(100, reduction - penaltyTime));

    if (!mission.resolve_at) {
      await fetch(`/api/missions/${mission.id}/timer`, { method: 'POST' });
    }
    const resp = await fetch(`/api/missions/${mission.id}/timer`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reduction })
    });
    const data = await resp.json().catch(() => ({}));
    if (data.resolve_at) mission.resolve_at = Number(data.resolve_at);
  } catch {
    /* ignore */
  }
}

async function loadStations() {
  cachedStations = await getStations();
  const pane = document.getElementById('cadStations');
  pane.innerHTML = renderStationList(cachedStations);
  pane.querySelectorAll('.cad-station').forEach(li=>{
    li.addEventListener('click', ()=>showStation(li.dataset.id));
  });
  updateStationMarkers(cachedStations);
  if (!selectedMissionId) fitMapToMarkers();
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
  units.forEach(u => (u.personnel || []).forEach(p => personnel.push({ ...p, rank: cleanRank(p.rank), unit: u.name })));
  unassigned.forEach(p => personnel.push({ ...p, rank: cleanRank(p.rank), unit: 'Unassigned' }));
  let html = `<div class="cad-station-detail"><div class="cad-station-header"><button id="closeStationDetail">Close</button><button id="newPersonnel">New Personnel</button> <button id="newUnit">New Unit</button> <button id="newEquipment">New Equipment</button> <button id="editStation">Edit Station</button> <button id="deleteStation">Delete Station</button></div><h3>${st.name}</h3><p>Type: ${st.type}</p><p>Department: ${st.department||''}</p>`;
  html += `<div style="display:flex; gap:20px;"><div><h4>Units</h4><ul>`;
  html += units.map(u => `<li class="cad-unit" data-id="${u.id}">${u.name}${u.status !== 'available' ? ` <button class="cancel-unit" data-id="${u.id}">Cancel</button>` : ''}</li>`).join('');
  html += `</ul></div><div><h4>Personnel</h4><ul>`;
  html += personnel.map(p => {
    const rank = cleanRank(p.rank);
    const name = p.name || '';
    const displayName = rank ? `${rank} ${name}`.trim() : name;
    return `<li class="cad-personnel" data-id="${p.id}">${displayName} - ${p.unit}</li>`;
  }).join('');
  html += `</ul></div></div></div>`;
  pane.innerHTML = html;
  document.getElementById('closeStationDetail').onclick = loadStations;
  document.getElementById('newPersonnel').onclick = () => openNewPersonnel(st);
  document.getElementById('newUnit').onclick = () => openNewUnit(st);
  document.getElementById('newEquipment').onclick = () => openNewEquipment(st);
  const editStationBtn = document.getElementById('editStation');
  if (editStationBtn) editStationBtn.onclick = () => editStationName(st);
  const deleteStationBtn = document.getElementById('deleteStation');
  if (deleteStationBtn) deleteStationBtn.onclick = () => deleteStationWithConfirm(st);
  pane.querySelectorAll('.cad-unit').forEach(li => li.addEventListener('click', () => showUnitDetail(Number(li.dataset.id))));
  pane.querySelectorAll('.cad-personnel').forEach(li => li.addEventListener('click', () => editPersonnel(Number(li.dataset.id), st)));
  pane.querySelectorAll('.cancel-unit').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const uid = Number(btn.dataset.id);
      await cancelUnit(uid);
      await loadMissions();
      showStation(st.id);
    });
  });
}

window.refreshStationPanelNoCache = showStation;

async function editStationName(st) {
  const currentName = st?.name || '';
  const newName = window.prompt('Enter a new name for this station:', currentName);
  if (newName === null) return;
  const trimmed = String(newName).trim();
  if (!trimmed) { notifyError('Station name is required.'); return; }
  try {
    const res = await fetch(`/api/stations/${st.id}/name`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      notifyError(`Failed to update station: ${data.error || res.statusText}`);
      return;
    }
    await loadStations();
    await showStation(st.id);
  } catch (err) {
    console.error('Failed to rename station', err);
    notifyError('Failed to update station.');
  }
}

async function deleteStationWithConfirm(st) {
  const name = st?.name || 'this station';
  const confirmed = window.confirm(`Delete ${name}? This will remove the station and all assigned units and personnel.`);
  if (!confirmed) return;
  try {
    const res = await fetch(`/api/stations/${st.id}`, { method: 'DELETE' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      notifyError(`Failed to delete station: ${data.error || res.statusText}`);
      return;
    }
    window.currentStation = null;
    await loadStations();
  } catch (err) {
    console.error('Failed to delete station', err);
    notifyError('Failed to delete station.');
  }
}

function getTrainingsForClass(cls) {
  const key = String(cls || '').toLowerCase();
  if (typeof trainingsByClass !== 'undefined' && trainingsByClass[key]) {
    return trainingsByClass[key];
  }
  return [];
}

function expandTrainingListForClass(list, cls) {
  if (typeof trainingHelpers !== 'undefined' && trainingHelpers && typeof trainingHelpers.expandTrainingList === 'function') {
    return trainingHelpers.expandTrainingList(list, cls) || [];
  }
  return Array.isArray(list) ? list : [];
}

if (typeof window !== 'undefined') {
  window.getTrainingsForClass = getTrainingsForClass;
}

function openNewPersonnel(st) {
  const pane = document.getElementById('cadStations');
  const trainings = getTrainingsForClass(st.type);
  const options = trainings.length ? trainings : [{ name: 'general', cost: 0 }];
  let html = `<div style="text-align:right"><button id="cancelNewPers">Back</button></div>`;
  html += `<h3>Add Personnel - ${st.name}</h3>`;
  html += `<input id="persName" placeholder="Name"/>`;
  html += `<select id="persRank"></select>`;
  html += `<div id="persTrainings">`;
  html += options.map((t, idx)=>{
    const name = typeof t === 'string' ? t : t.name;
    const cost = typeof t === 'object' && t.cost ? t.cost : 0;
    return `<label><input type="checkbox" value="${name}" data-cost="${cost}" ${idx===0?'checked':''}/> ${name}${cost?` ($${cost})`:''}</label><br>`;
  }).join('');
  html += `</div><div id="persCost"></div><button id="createPers">Create</button>`;
  pane.innerHTML = html;
  document.getElementById('cancelNewPers').onclick = () => showStation(st.id);
  const nameInput = document.getElementById('persName');
  const rankInput = document.getElementById('persRank');
  const dept = cleanRank(st.department);
  if (rankInput) {
    const populateRankSelect = (ranks, currentValue = '') => {
      const safe = Array.isArray(ranks) ? ranks : [];
      const seen = new Set();
      const options = ['<option value=""></option>'];
      safe.forEach(raw => {
        const value = cleanRank(raw);
        if (!value) return;
        const key = value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        options.push(`<option value="${value.replace(/"/g, '&quot;')}">${value}</option>`);
      });
      const current = cleanRank(currentValue);
      if (current && !seen.has(current.toLowerCase())) {
        options.push(`<option value="${current.replace(/"/g, '&quot;')}">${current}</option>`);
      }
      rankInput.innerHTML = options.join('');
      rankInput.value = current || '';
    };
    populateRankSelect([], '');
    fetchRankOptions(dept).then((ranks) => {
      populateRankSelect(ranks, rankInput.value);
    });
  }
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
    const rankVal = cleanRank(rankInput?.value);
    const training = Array.from(document.querySelectorAll('#persTrainings input:checked')).map(cb=>cb.value);
    if (!name) return notifyError('Missing name');
    const res = await fetch('/api/personnel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ name, rank: rankVal || null, station_id: st.id, training })});
    const data = await res.json();
    if (!res.ok) { notifyError(`Failed: ${data.error || res.statusText}`); return; }
    notifySuccess(`Personnel added. Cost: $${data.charged}`);
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
  html += `<label>Tag: <input id="unitTag"/></label><br>`;
  html += `<label>Priority: <input id="unitPriority" type="number" min="1" max="5" value="1" style="width:60px;"></label><br>`;
  html += `<button id="createUnitBtn">Create</button>`;
  pane.innerHTML = html;
  document.getElementById('cancelNewUnit').onclick = () => showStation(st.id);
  document.getElementById('createUnitBtn').onclick = async ()=>{
    const type = document.getElementById('unitType').value;
    const name = document.getElementById('unitName').value.trim();
    const tag = document.getElementById('unitTag').value.trim();
    const priority = Number(document.getElementById('unitPriority').value)||1;
    if (!type || !name) return notifyError('Missing name or type');
    const res = await fetch('/api/units',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({station_id: st.id,class: st.type,type,name,tag,priority})});
    if(!res.ok){ const data = await res.json().catch(()=>({})); notifyError(`Failed: ${data.error || res.statusText}`); return; }
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
    if (!name) return notifyError('Select equipment');
    const res = await fetch(`/api/stations/${st.id}/equipment`, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ name })});
    const data = await res.json();
    if (!res.ok) { notifyError(`Failed: ${data.error || res.statusText}`); return; }
    notifySuccess(`Purchased ${name} for $${data.cost}`);
    showStation(st.id);
  };
}

async function showUnitDetail(unitId) {
  const modal = document.getElementById('unitDetailModal');
  const content = document.getElementById('unitDetailContent');
  try {
    const unit = await fetchNoCache(`/api/units/${unitId}`).then(r=>r.json());
    const station = await fetchNoCache(`/api/stations/${unit.station_id}`).then(r=>r.json());
    let mission = null;
    try {
      mission = await fetchNoCache(`/api/units/${unitId}/mission`).then(r=>r.ok ? r.json() : null);
    } catch {}
    const personnel = await fetchNoCache(`/api/personnel?station_id=${unit.station_id}`).then(r=>r.json());
    const assigned = personnel.filter(p=>p.unit_id===unitId);
    const eqNames = Array.isArray(unit.equipment)
      ? unit.equipment.map(e => typeof e === 'string' ? e : e?.name).filter(Boolean)
      : [];
    const equipmentHtml = eqNames.length
      ? `<ul>${eqNames.map(n => `<li>${n} <button class="remove-equip-btn" data-name="${n}">Remove</button></li>`).join('')}</ul>`
      : '<em>No equipment</em>';
    const availableEq = Array.isArray(station?.equipment) ? station.equipment : [];
    const assignHtml = availableEq.length
      ? `<select id="unit-equip-select">${availableEq.map(n=>`<option value="${n}">${n}</option>`).join('')}</select> <button id="assign-equip-btn">Assign</button>`
      : '<p><em>No equipment in station storage.</em></p>';
    const personnelHtml = assigned.length
      ? `<ul>${assigned.map(p=>{
          const rank = cleanRank(p.rank);
          let trainings = [];
          if (Array.isArray(p.training)) trainings = p.training;
          else if (typeof p.training === 'string') {
            try { trainings = JSON.parse(p.training); } catch { trainings = []; }
          }
          const trainingText = Array.isArray(trainings) && trainings.length ? ` (${trainings.join(', ')})` : '';
          const baseName = p.name || '(no name)';
          const displayName = rank ? `${rank} ${baseName}`.trim() : baseName;
          return `<li>${displayName}${trainingText} <button class="unassign-btn" data-person-id="${p.id}" data-station-id="${p.station_id}">Unassign</button></li>`;
        }).join('')}</ul>`
      : '<p>No personnel assigned to this unit.</p>';
    const missionHtml = mission && mission.id
      ? `<p><strong>Current Mission:</strong> #${mission.id} ${mission.type}</p>`
      : '<p><strong>Current Mission:</strong> None</p>';
    const cancelUnitHtml = unit.status !== 'available'
      ? '<p><button id="cad-cancel-unit-btn">Cancel Unit</button></p>'
      : '';
    content.innerHTML = `
      <p><strong>Name:</strong> ${unit.name || ''} <button id="edit-unit-btn">Edit</button></p>
      <p><strong>Priority:</strong> ${unit.priority ?? 1}</p>
      <p><strong>Station:</strong> ${station?.name || ''}</p>
      <p><strong>Vehicle Class:</strong> ${unit.class || ''} (${unit.type || ''})</p>
      ${missionHtml}
      ${cancelUnitHtml}
      <h4>Equipment Aboard</h4>
      ${equipmentHtml}
      <h4>Assign Equipment from Station</h4>
      ${assignHtml}
      <h4>Assigned Personnel</h4>
      ${personnelHtml}
    `;
    const cancelUnitBtn = content.querySelector('#cad-cancel-unit-btn');
    cancelUnitBtn?.addEventListener('click', async()=>{
      await cancelUnit(unitId);
      modal.style.display = 'none';
      showStation(unit.station_id);
    });
    content.querySelectorAll('.unassign-btn').forEach(btn=>{
      btn.addEventListener('click', async()=>{
        const pid = Number(btn.dataset.personId);
        await fetch(`/api/personnel/${pid}`, {
          method:'PATCH',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ unit_id: null })
        });
        modal.style.display = 'none';
        showStation(unit.station_id);
      });
    });
    content.querySelectorAll('.remove-equip-btn').forEach(btn=>{
      btn.addEventListener('click', async()=>{
        const name = btn.dataset.name;
        const res = await fetch(`/api/units/${unitId}/equipment`, {
          method:'DELETE',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ station_id: unit.station_id, name })
        });
        if(res.ok){
          modal.style.display='none';
          showStation(unit.station_id);
        } else {
          const data = await res.json().catch(()=>({}));
          notifyError(`Failed: ${data.error || res.statusText}`);
        }
      });
    });
    const assignBtn = content.querySelector('#assign-equip-btn');
    assignBtn?.addEventListener('click', async()=>{
      const name = content.querySelector('#unit-equip-select').value;
      const res = await fetch(`/api/units/${unitId}/equipment`, {
        method:'PATCH',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ station_id: unit.station_id, name })
      });
      const data = await res.json().catch(()=>({}));
      if(!res.ok || !data.success){
        notifyError(`Failed: ${data.error || res.statusText}`);
        return;
      }
      modal.style.display='none';
      showStation(unit.station_id);
    });
    content.querySelector('#edit-unit-btn')?.addEventListener('click', ()=>{
      modal.style.display='none';
      editUnit(unit.id);
    });
    modal.style.display = 'block';
  } catch {
    content.textContent = 'Failed to load unit details.';
    modal.style.display = 'block';
  }
}

async function openMission(id) {
  const mission = cachedMissions.find(m=>String(m.id)===String(id));
  if (!mission) return;
  showMissionOnMap(mission);
  const pane = document.getElementById('cadDetail');
  const assigned = await fetchNoCache(`/api/missions/${id}/units`).then(r=>r.json()).catch(()=>[]);
  let time = '';
  if (mission.resolve_at) {
    const sec = Math.max(0,(mission.resolve_at - Date.now())/1000);
    time = `<div>Time Remaining: ${formatTime(sec)}</div>`;
  }
  const assignedCounts = {};
  const equipCounts = {};
  const trainCounts = {};
  assigned.forEach(u => {
    assignedCounts[u.type] = (assignedCounts[u.type] || 0) + 1;
    (Array.isArray(u.equipment) ? u.equipment : []).forEach(e => {
      equipCounts[e] = (equipCounts[e] || 0) + 1;
    });
    (Array.isArray(u.personnel) ? u.personnel : []).forEach(p => {
      (Array.isArray(p.training) ? p.training : []).forEach(t => {
        trainCounts[t] = (trainCounts[t] || 0) + 1;
      });
    });
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
  let reqEquipHtml = '';
  if (Array.isArray(mission.equipment_required) && mission.equipment_required.length) {
    reqEquipHtml = '<div><strong>Required Equipment:</strong><ul>' + mission.equipment_required.map(r=>{
      const name = r.name || r.type || r;
      const need = r.qty ?? r.quantity ?? r.count ?? 1;
      const have = equipCounts[name] || 0;
      return `<li>${need} ${name} (${have}/${need})</li>`;
    }).join('') + '</ul></div>';
  }
  let reqTrainHtml = '';
  if (Array.isArray(mission.required_training) && mission.required_training.length) {
    reqTrainHtml = '<div><strong>Required Training:</strong><ul>' + mission.required_training.map(r=>{
      const name = r.training || r.name || r;
      const need = r.qty ?? r.quantity ?? r.count ?? 1;
      const have = trainCounts[name] || 0;
      return `<li>${need} ${name} (${have}/${need})</li>`;
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
      const statusText = formatStatus(u.status, u.responding);
      return `<li>${u.name} - ${statusText}${etaText} <button class="cancel-unit" data-unit="${u.id}">Cancel</button></li>`;
    }).join('') + '</ul></div>';
  }
  pane.innerHTML = `<div class="cad-detail-header">
      <button id="closeDetail">Close</button>
      <button id="manualDispatch">Manual Dispatch</button>
      <button id="autoDispatch">Auto Dispatch</button>
      <button id="runCardDispatch">Run Card</button>
      <button id="unitTypeDispatchBtn">Unit Type Dispatch</button>
    </div>
    <h3>${mission.type}</h3>
    ${time}
    <div>${mission.address||''}</div>
    ${reqHtml}
    ${reqEquipHtml}
    ${reqTrainHtml}
    ${assignedHtml}`;
  pane.classList.remove('hidden');
  document.getElementById('closeDetail').onclick = ()=>{
    pane.classList.add('hidden');
    document.getElementById('cadUnits').classList.add('hidden');
    selectedMissionId = null;
    fitMapToMarkers();
  };
  document.getElementById('manualDispatch').onclick = ()=>openManualDispatch(mission);
  document.getElementById('autoDispatch').onclick = ()=>autoDispatch(mission);
  document.getElementById('runCardDispatch').onclick = ()=>runCardDispatch(mission);
  document.getElementById('unitTypeDispatchBtn').onclick = ()=>openUnitTypeDispatch(mission);
  pane.querySelectorAll('.cancel-unit').forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = Number(btn.dataset.unit);
      await cancelUnit(uid);
      await loadMissions();
      await openMission(mission.id);
    });
  });
}

async function missionDepartmentsFor(mission) {
  if (Array.isArray(mission.departments) && mission.departments.length) return mission.departments;
  try {
    const zones = await fetch('/api/response-zones').then(r=>r.json());
    const set = new Set();
    for (const z of zones) {
      if (pointInPolygon(mission.lat, mission.lon, z.polygon)) {
        const depts = Array.isArray(z.departments) ? z.departments : [];
        depts.forEach(d=>set.add(d));
      }
    }
    return Array.from(set);
  } catch {
    return [];
  }
}

function pointInPolygon(lat, lon, poly) {
  const pts = Array.isArray(poly?.coordinates) ? poly.coordinates : [];
  let inside = false;
  for (let i=0, j=pts.length-1; i<pts.length; j=i++) {
    const xi = pts[i][1], yi = pts[i][0];
    const xj = pts[j][1], yj = pts[j][0];
    const intersect = ((yi>lat)!==(yj>lat)) && (lon < (xj - xi)*(lat - yi)/(yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

async function autoDispatch(mission) {
  try {
    const [stations, allUnitsRaw] = await Promise.all([
      getStations(),
      fetchNoCache('/api/units?status=available').then(r=>r.json())
    ]);
    const stMap = new Map(stations.map(s=>[s.id,s]));
    const missionDepts = await missionDepartmentsFor(mission);
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
      const target = String(name || '').trim().toLowerCase();
      if (!target) return 0;
      let c = 0;
      for (const p of Array.isArray(u.personnel) ? u.personnel : []) {
        const list = Array.isArray(p.training) ? p.training : [];
        const expanded = expandTrainingListForClass(list, u.class);
        if (expanded.some((t) => String(t || '').trim().toLowerCase() === target)) c++;
      }
      return c;
    }
    function equipmentCount(u, name) {
      const key = equipmentKey(name);
      if (!key) return 0;
      const counts = gatherEquipmentForUnit(u);
      return counts.get(key) || 0;
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

    // Account for units already assigned to this mission (enroute/on_scene)
    const assigned = await fetchNoCache(`/api/missions/${mission.id}/units`).then(r=>r.json()).catch(()=>[]);
    const assignedCounts = {};
    for (const a of assigned) {
      if (!['enroute','on_scene'].includes(a.status)) continue;
      assignedCounts[a.type] = (assignedCounts[a.type] || 0) + 1;
      applyNeeds(a);
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
      const types = Array.isArray(r.types) ? r.types : [r.type];
      let need = (r.quantity ?? r.count ?? r.qty ?? 1) - types.reduce((s,t)=>s+(assignedCounts[t]||0),0);
      for (let i=0; i<need; i++) {
        let candidates = allUnits.filter(u=>!selectedIds.has(u.id) && types.includes(u.type))
                                 .sort(sortUnits);
        if (!candidates.length) break;
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
        if (!candidates.length) break;
        selectUnit(candidates[0]);
      }
    }

    for (const n of equipmentNeeds) {
      while (n.qty > 0) {
        const candidates = allUnits.filter(u=>!selectedIds.has(u.id) && equipmentCount(u,n.name)>0)
                                   .sort(sortUnits);
        if (!candidates.length) break;
        selectUnit(candidates[0]);
      }
    }

    if (!selected.length) { notifyError('No additional units available for dispatch.'); return; }
    await dispatchUnits(mission, selected);
    await loadMissions();
    await openMission(mission.id);
  } catch (e) {
    console.error(e);
    notifyError('Auto dispatch failed.');
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
    if (!res.ok) { notifyError('No run card for this mission.'); return; }
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
    notifyError('Run card dispatch failed.');
  } finally {
    if (tempArea) area.remove();
  }
}

async function dispatchUnits(mission, units, force=false) {
  for (const u of units) {
    await fetch('/api/mission-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mission_id: mission.id, unit_id: u.id, ...(force ? { force: true } : {}) })
    });

    try {
      const st = cachedStations.find(s => s.id === u.station_id);
      if (!st) continue;
      const rawFrom = [st.lat, st.lon];
      const rawTo = [mission.lat, mission.lon];

      const { coords, duration, annotations, from: snappedFrom, to: snappedTo } = await fetchRouteOSRM(rawFrom, rawTo);
      const from = snappedFrom || rawFrom;
      const to = snappedTo || rawTo;

      const seg_durations = (annotations?.duration?.length === coords.length - 1)
        ? annotations.duration
        : Array.from({ length: coords.length - 1 }, () => duration / Math.max(1, coords.length - 1));

      const speedMultiplier = { fire: 1.2, police: 1.3, ambulance: 1.25, sar: 1.2 };
      const mult = speedMultiplier[u.class] || 1;
      const total_duration = Math.max(5, duration / mult);

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
  let html = '<div class="cad-unit-header"><button id="dispatchUnits">Dispatch</button><button id="closeUnits">Close</button></div>';
  const orderedUnits = available.slice().sort((a,b)=>a.distance - b.distance);
  const deptOrder = [];
  const groups = new Map();
  for (const unit of orderedUnits) {
    const dept = unit.department;
    if (!groups.has(dept)) {
      groups.set(dept, []);
      deptOrder.push(dept);
    }
    groups.get(dept).push(unit);
  }
  for (const dept of deptOrder) {
    html += `<h4>${dept}</h4><ul>`;
    for (const u of groups.get(dept)) {
      const distLabel = Number.isFinite(u.distance) ? `${u.distance.toFixed(1)} km` : 'N/A';
      html += `<li><label><input type="checkbox" value="${u.id}"> ${u.name} (${distLabel})</label></li>`;
    }
    html += '</ul>';
  }
  unitsPane.innerHTML = html;
  unitsPane.classList.remove('hidden');
  document.getElementById('closeUnits').onclick = ()=>unitsPane.classList.add('hidden');
  document.getElementById('dispatchUnits').onclick = async ()=>{
    const ids = Array.from(unitsPane.querySelectorAll('input[type=checkbox]:checked')).map(c=>Number(c.value));
    const selectedUnits = ids.map(id => available.find(u => u.id === id)).filter(Boolean);
    await dispatchUnits(mission, selectedUnits, true);
    unitsPane.classList.add('hidden');
    await loadMissions();
    await openMission(mission.id);
  };
}

async function openUnitTypeDispatch(mission) {
  const unitsPane = document.getElementById('cadUnits');
  const [stations, units] = await Promise.all([
    getStations(),
    fetchNoCache('/api/units?status=available').then(r=>r.json())
  ]);
  const stMap = new Map(stations.map(s=>[s.id,s]));
  const missionDepts = Array.isArray(mission.departments) ? mission.departments : [];
  const groups = new Map();
  units.forEach(u=>{
    const st = stMap.get(u.station_id);
    const dept = st?.department;
    if (missionDepts.length && (!dept || !missionDepts.includes(dept))) return;
    const dist = st ? haversine(mission.lat, mission.lon, st.lat, st.lon) : Infinity;
    const arr = groups.get(u.type) || [];
    arr.push({ ...u, distance: dist });
    groups.set(u.type, arr);
  });
  let html = '<div class="cad-unit-header"><button id="closeUnitType">Close</button></div>';
  for (const [type, list] of groups.entries()) {
    const arr = list.sort((a,b)=>a.distance-b.distance);
    html += `<div><strong>${type}</strong> (${arr.length}) <button data-type="${type}" class="type-send">Send 1</button></div>`;
  }
  unitsPane.innerHTML = html;
  unitsPane.classList.remove('hidden');
  document.getElementById('closeUnitType').onclick = ()=>unitsPane.classList.add('hidden');
  unitsPane.querySelectorAll('.type-send').forEach(btn=>{
    btn.addEventListener('click', async ()=>{
      const type = btn.dataset.type;
      const list = groups.get(type) || [];
      if (!list.length) { notifyError('No available units'); return; }
      const unit = list.shift();
      await dispatchUnits(mission, [unit], true);
      await loadMissions();
      await openMission(mission.id);
      openUnitTypeDispatch(mission);
    });
  });
}

async function cancelUnit(unitId) {
  if (!unitId) return;
  try {
    await fetch(`/api/units/${unitId}/cancel`, { method: 'POST' });
  } catch {}
}

export async function generateMission(retry = false, excludeIndex = null) {
  if (missionTemplates.length === 0) { notifyError('No mission templates loaded.'); return; }
  const stations = await fetch('/api/stations').then(r => r.json()).catch(() => []);
  if (!stations.length) { notifyError('No stations available.'); return; }
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
      const matches = pois.filter(p => {
        if (!p.tags) return false;
        if ((template.trigger_filter || "").includes("=")) {
          const [key, val] = template.trigger_filter.split("=");
          return p.tags[key] === val;
        }
        return p.tags.amenity === template.trigger_filter;
      });
      if (matches.length) {
        const poi = matches[Math.floor(Math.random() * matches.length)];
        // Overpass area POIs provide coordinates in a `center` object.
        // Use those when direct lat/lon are missing so missions spawn
        // at the correct POI location.
        lat = poi.lat ?? poi.center?.lat;
        lon = poi.lon ?? poi.center?.lon;
      } else {
        console.warn(`No matching POI found for mission template "${template?.name || template?.id}" (ID: ${template?.id})`, template);
        if (!retry) return generateMission(true, templateIndex);
        return;
      }
    } catch (e) {
      console.error('POI lookup failed', e);
      notifyError('POI lookup failed.');
      return;
    }
  } else if (template.trigger_type === 'intersection' && template.trigger_filter) {
    const [r1Raw, r2Raw] = String(template.trigger_filter).split('|');
    const road1 = r1Raw?.trim();
    const road2 = r2Raw?.trim();
    if (road1 && road2) {
      try {
        const query = `[out:json];(
          way["name"="${road1}"](around:${radius},${st.lat},${st.lon});
        )->.r1;(
          way["name"="${road2}"](around:${radius},${st.lat},${st.lon});
        )->.r2;
        node(w.r1)(w.r2);
        out;`;
        const resp = await fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query));
        const data = await resp.json();
        if (Array.isArray(data.elements) && data.elements.length) {
          const inter = data.elements[0];
          lat = inter.lat; lon = inter.lon;
        } else {
          console.warn(`No intersection found for roads "${road1}" and "${road2}"`);
        }
      } catch (e) {
        console.error('Intersection lookup failed', e);
      }
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
  } catch (err) { console.error('Failed to create mission:', err); notifyError('Failed to create mission.'); }
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
