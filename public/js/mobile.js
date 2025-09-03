// Mobile UI script

// Tab navigation
const tabButtons = document.querySelectorAll('.tab-bar button');
const tabs = document.querySelectorAll('.tab');

function activateTab(id) {
  for (const t of tabs) t.classList.remove('active');
  const el = document.getElementById(id);
  if (el) el.classList.add('active');
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
}

// Modal helper
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modalContent');

function showModal(html) {
  modalContent.innerHTML = html + '<br/><button id="modalClose">Close</button>';
  modal.style.display = 'flex';
  document.getElementById('modalClose').onclick = () => { modal.style.display = 'none'; };
}

modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.style.display = 'none';
});

// Map setup
const map = L.map('map').setView([0,0],2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

let stationById = new Map();

async function loadData() {
  const [missions, stations, units] = await Promise.all([
    fetch('/api/missions').then(r=>r.json()),
    fetch('/api/stations').then(r=>r.json()),
    fetch('/api/units').then(r=>r.json())
  ]);

  stationById = new Map(stations.map(s => [s.id, s]));

  renderStations(stations);
  renderMissions(missions);
  renderUnits(units);
  renderMap(missions, stations, units);
}

function renderMap(missions, stations, units){
  // clear existing layers
  if (window._mapLayers) window._mapLayers.forEach(l => map.removeLayer(l));
  window._mapLayers = [];

  stations.forEach(s => {
    const m = L.circleMarker([s.lat, s.lon], {color:'blue'}).addTo(map);
    m.on('click', () => showModal(`<h3>Station ${s.name}</h3>`));
    window._mapLayers.push(m);
  });

  missions.forEach(mis => {
    const m = L.circleMarker([mis.lat, mis.lon], {color:'red'}).addTo(map);
    m.on('click', () => showModal(`<h3>Mission ${mis.id}</h3><p>${mis.type}</p>`));
    window._mapLayers.push(m);
  });

  units.forEach(u => {
    const st = stationById.get(u.station_id);
    if (!st) return;
    const m = L.circleMarker([st.lat, st.lon], {color:'green'}).addTo(map);
    m.on('click', () => showModal(`<h3>Unit ${u.name || u.id}</h3><p>Status: ${u.status}</p>`));
    window._mapLayers.push(m);
  });
}

function renderList(containerId, items, renderer){
  const el = document.getElementById(containerId);
  el.innerHTML = '';
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = 'list-item';
    div.innerHTML = renderer(item);
    div.addEventListener('click', () => showModal(renderer(item)));
    el.appendChild(div);
  });
}

function renderMissions(missions){
  renderList('missionsTab', missions, m => `Mission ${m.id}: ${m.type}`);
}

function renderStations(stations){
  renderList('stationsTab', stations, s => `Station ${s.id}: ${s.name}`);
}

function renderUnits(units){
  renderList('unitsTab', units, u => `Unit ${u.id}: ${u.name || u.type}`);
}

loadData();
