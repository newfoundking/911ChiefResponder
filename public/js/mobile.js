import { fetchNoCache, formatStatus, formatTime } from './common.js';

// Tab navigation
const tabButtons = document.querySelectorAll('.tab-bar button');
const tabs = document.querySelectorAll('.tab');
let map = null;

function activateTab(id) {
  for (const tab of tabs) {
    tab.classList.toggle('active', tab.id === id);
  }
  for (const btn of tabButtons) {
    btn.classList.toggle('active', btn.dataset.tab === id);
  }
  if (id === 'mapTab' && map) {
    setTimeout(() => map.invalidateSize(), 200);
  }
}

for (const btn of tabButtons) {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
}

// Modal helper
const modal = document.getElementById('modal');
const modalContent = document.getElementById('modalContent');

function closeModal() {
  modal.style.display = 'none';
  modalContent.innerHTML = '';
}

function showModal(content) {
  modalContent.innerHTML = '';
  if (content instanceof Node) {
    modalContent.appendChild(content);
  } else if (content !== undefined && content !== null) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = String(content);
    modalContent.appendChild(wrapper);
  }
  const closeBtn = document.createElement('button');
  closeBtn.id = 'modalClose';
  closeBtn.className = 'modal-close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeModal);
  modalContent.appendChild(closeBtn);
  modal.style.display = 'flex';
  closeBtn.focus();
}

modal.addEventListener('click', (event) => {
  if (event.target === modal) {
    closeModal();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && modal.style.display !== 'none') {
    closeModal();
  }
});

const stationIcons = {
  fire: '/fire.png',
  police: '/police.png',
  ambulance: '/star.png',
  sar: '/sar.png',
  hospital: '/images/hospital.png',
  jail: '/images/prison.png'
};

let stationById = new Map();
let unitsByStation = new Map();
let unitById = new Map();
let missionAssignments = new Map();
let latestMissions = [];
let latestStations = [];
let latestUnits = [];
let mapLayers = [];
let mapBoundsSet = false;
let missionTimerInterval = null;
let loadInProgress = false;

map = L.map('map').setView([0, 0], 2);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);
activateTab('mapTab');

async function loadData() {
  if (loadInProgress) return;
  loadInProgress = true;
  try {
    const [missionsRaw, stations, units] = await Promise.all([
      fetchJson('/api/missions'),
      fetchJson('/api/stations'),
      fetchJson('/api/units')
    ]);

    const missions = sortMissions(missionsRaw);
    latestMissions = missions;
    latestStations = stations;
    latestUnits = units;

    stationById = new Map(stations.map((station) => [station.id, station]));
    unitById = new Map(units.map((unit) => [unit.id, unit]));

    unitsByStation = new Map();
    for (const unit of units) {
      if (!unitsByStation.has(unit.station_id)) {
        unitsByStation.set(unit.station_id, []);
      }
      unitsByStation.get(unit.station_id).push(unit);
    }

    const assignmentPairs = await Promise.all(
      missions.map(async (mission) => {
        try {
          const assigned = await fetchJson(`/api/missions/${mission.id}/units`);
          return [mission.id, assigned];
        } catch (err) {
          console.warn('Failed to load assigned units for mission', mission.id, err);
          return [mission.id, []];
        }
      })
    );
    missionAssignments = new Map(assignmentPairs);

    renderStations(stations);
    renderMissions(missions);
    renderUnits(units);
    renderMap(missions, stations, units);
  } catch (err) {
    console.error('Failed to load mobile data', err);
  } finally {
    loadInProgress = false;
  }
}

function renderMissions(missions) {
  const container = document.getElementById('missionsTab');
  container.innerHTML = '';
  if (!missions.length) {
    container.appendChild(createEmptyMessage('No active missions.'));
    return;
  }

  missions.forEach((mission) => {
    const assigned = missionAssignments.get(mission.id) || [];
    const iconNode = createImageIcon(missionIconUrl(mission, assigned));
    const subtitle = mission.address || '';

    const meta = [createMetaText(`Status: ${mission.status || 'Unknown'}`)];
    if (Number.isFinite(mission.resolve_at)) {
      meta.push(createTimeMeta(mission.resolve_at, 'Time Left'));
    }

    const sections = [];
    const requiredRow = createChipRow(
      (Array.isArray(mission.required_units) ? mission.required_units : [])
        .map((req) => createChip(formatRequirementText(req), 'req'))
    );
    if (requiredRow) sections.push(createCardSection('Required', requiredRow));

    const trainingRow = createChipRow(
      (Array.isArray(mission.required_training) ? mission.required_training : [])
        .map((req) => createChip(formatTrainingText(req), 'training'))
    );
    if (trainingRow) sections.push(createCardSection('Personnel', trainingRow));

    const equipmentRow = createChipRow(
      (Array.isArray(mission.equipment_required) ? mission.equipment_required : [])
        .map((req) => createChip(formatEquipmentRequirementText(req), 'equip'))
    );
    if (equipmentRow) sections.push(createCardSection('Equipment', equipmentRow));

    const assignedRow = createChipRow(assigned.map(createAssignedChip));
    sections.push(createCardSection('Assigned', assignedRow, 'No units assigned'));

    const card = createCard({
      iconNode,
      title: mission.type || `Mission ${mission.id}`,
      subtitle,
      meta,
      sections
    });
    card.addEventListener('click', () => showModal(buildMissionDetail(mission)));
    container.appendChild(card);
  });

  ensureMissionTimerUpdates();
}

function renderStations(stations) {
  const container = document.getElementById('stationsTab');
  container.innerHTML = '';
  if (!stations.length) {
    container.appendChild(createEmptyMessage('No stations available.'));
    return;
  }

  const sorted = [...stations].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  sorted.forEach((station) => {
    const iconUrl = station.icon || stationIcons[station.type] || stationIcons.fire;
    const iconNode = createImageIcon(iconUrl);
    const subtitleParts = [];
    if (station.department) subtitleParts.push(station.department);
    if (station.type) subtitleParts.push(station.type);

    const meta = [];
    if (Number.isFinite(station.bay_count)) {
      meta.push(createMetaText(`${station.bay_count} bays`));
    }
    if (isFiniteLatLon(station.lat, station.lon)) {
      meta.push(createMetaText(`${Number(station.lat).toFixed(4)}, ${Number(station.lon).toFixed(4)}`));
    }

    const sections = [];
    const facilitySection = createFacilitySection(station, 'card');
    if (facilitySection) sections.push(facilitySection);

    const units = unitsByStation.get(station.id) || [];
    const unitRow = createChipRow(units.map((unit) => createChip(unit.name || unit.type || `Unit ${unit.id}`, 'unit')));
    sections.push(createCardSection('Units', unitRow, 'No units assigned'));

    const card = createCard({
      iconNode,
      title: station.name || `Station ${station.id}`,
      subtitle: subtitleParts.join(' • '),
      meta,
      sections
    });
    card.addEventListener('click', () => showModal(buildStationDetail(station)));
    container.appendChild(card);
  });
}

function renderUnits(units) {
  const container = document.getElementById('unitsTab');
  container.innerHTML = '';
  if (!units.length) {
    container.appendChild(createEmptyMessage('No units available.'));
    return;
  }

  const order = { on_scene: 0, enroute: 1, available: 2 };
  const sorted = [...units].sort((a, b) => {
    const orderDiff = (order[a.status] ?? 3) - (order[b.status] ?? 3);
    if (orderDiff !== 0) return orderDiff;
    return (a.name || '').localeCompare(b.name || '');
  });

  sorted.forEach((unit) => {
    const iconNode = createUnitIconNode(unit);
    const subtitleParts = [];
    if (unit.type) subtitleParts.push(unit.type);
    const station = stationById.get(unit.station_id);
    if (station?.name) subtitleParts.push(station.name);

    const meta = [createMetaText(formatStatus(unit.status || 'available', unit.responding))];
    if (Number.isFinite(unit.priority)) {
      meta.push(createMetaText(`Priority ${unit.priority}`));
    }
    const personnelCount = Array.isArray(unit.personnel) ? unit.personnel.length : 0;
    if (personnelCount) {
      meta.push(createMetaText(`${personnelCount} personnel`));
    }

    const sections = [];
    const equipmentRow = createChipRow(
      (Array.isArray(unit.equipment) ? unit.equipment : [])
        .map((item) => createChip(formatEquipmentName(item), 'equip'))
    );
    if (equipmentRow) sections.push(createCardSection('Equipment', equipmentRow));

    const card = createCard({
      iconNode,
      title: unit.name || `Unit ${unit.id}`,
      subtitle: subtitleParts.join(' • '),
      meta,
      sections
    });
    card.addEventListener('click', () => showModal(buildUnitDetail(unit)));
    container.appendChild(card);
  });
}

function renderMap(missions, stations, units) {
  if (!map) return;

  for (const layer of mapLayers) {
    map.removeLayer(layer);
  }
  mapLayers = [];

  const boundsPoints = [];

  stations.forEach((station) => {
    if (!isFiniteLatLon(station.lat, station.lon)) return;
    const iconUrl = station.icon || stationIcons[station.type] || stationIcons.fire;
    const marker = L.marker([station.lat, station.lon], { icon: makeIcon(iconUrl, 30) })
      .addTo(map)
      .on('click', () => showModal(buildStationDetail(station)));
    mapLayers.push(marker);
    boundsPoints.push(marker.getLatLng());
  });

  missions.forEach((mission) => {
    if (!isFiniteLatLon(mission.lat, mission.lon)) return;
    const assigned = missionAssignments.get(mission.id) || [];
    const marker = L.marker([mission.lat, mission.lon], { icon: makeIcon(missionIconUrl(mission, assigned), 34) })
      .addTo(map)
      .on('click', () => showModal(buildMissionDetail(mission)));
    mapLayers.push(marker);
    boundsPoints.push(marker.getLatLng());
  });

  units.forEach((unit) => {
    const station = stationById.get(unit.station_id);
    if (!station || !isFiniteLatLon(station.lat, station.lon)) return;
    const marker = L.marker([station.lat, station.lon], { icon: unitIconFor(unit), zIndexOffset: 1000 })
      .addTo(map)
      .on('click', () => showModal(buildUnitDetail(unit)));
    mapLayers.push(marker);
  });

  if (!mapBoundsSet && boundsPoints.length) {
    const bounds = L.latLngBounds(boundsPoints);
    if (bounds.isValid()) {
      map.fitBounds(bounds.pad(0.1));
      mapBoundsSet = true;
    }
  }
}

function fetchJson(url) {
  return fetchNoCache(url).then(async (res) => {
    if (!res.ok) {
      const message = await res.text().catch(() => res.statusText);
      throw new Error(message || res.statusText || 'Request failed');
    }
    return res.json();
  });
}

function sortMissions(missions) {
  const level = (mission) => {
    if (mission.resolve_at) return 3;
    return mission.assigned_count > 0 ? 2 : 1;
  };
  return missions
    .filter((mission) => mission.status !== 'resolved')
    .map((mission) => ({ ...mission, level: level(mission) }))
    .sort((a, b) => {
      const diff = a.level - b.level;
      if (diff !== 0) return diff;
      return (a.id || 0) - (b.id || 0);
    });
}

function missionIconUrl(mission, assigned) {
  const responders = (Array.isArray(assigned) ? assigned : []).filter((unit) =>
    unit && (unit.status === 'enroute' || unit.status === 'on_scene')
  );
  if (responders.length === 0) return '/warning1.png';
  const hasOnScene = responders.some((unit) => unit.status === 'on_scene');
  return hasOnScene ? '/warning3.png' : '/warning2.png';
}

function isFiniteLatLon(lat, lon) {
  return Number.isFinite(Number(lat)) && Number.isFinite(Number(lon));
}

function makeIcon(url, size) {
  return L.divIcon({
    html: `<img src="${url}" style="width:100%;height:100%;object-fit:contain;object-position:center bottom;">`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
    className: ''
  });
}

function makeTagIcon(tag, unitClass, responding, width = 36, height = 24) {
  const classes = ['unit-tag-icon'];
  if (unitClass) classes.push(unitClass);
  if (responding) classes.push('responding');
  const html = `<span class="${classes.join(' ')}" style="--tag-width:${width}px;--tag-height:${height}px;">${tag || ''}</span>`;
  return L.divIcon({
    html,
    iconSize: [width, height],
    iconAnchor: [width / 2, height],
    className: ''
  });
}

function unitIconFor(unit) {
  const url = pickUnitIconUrl(unit);
  if (!url) {
    const label = (unit?.tag || unit?.name || unit?.type || 'UNIT')
      .split(/\s+/)[0]
      .slice(0, 4)
      .toUpperCase();
    return makeTagIcon(label, unit?.class, unit?.responding);
  }
  return makeIcon(url, 28);
}

function pickUnitIconUrl(unit) {
  if (!unit) return null;
  const sanitizedType = (unit.type || '').replace(/\s+/g, '');
  const baseIcon = sanitizedType ? `/images/${sanitizedType}.png` : null;
  const respDefault = sanitizedType ? `/images/${sanitizedType}-responding.png` : null;
  const normal = unit.icon || baseIcon || stationIcons[unit.class] || stationIcons.fire;
  const responding = unit.responding_icon || respDefault || normal;
  return unit.responding ? responding : normal;
}

function createCard({ iconNode, title, subtitle, meta = [], sections = [] }) {
  const card = document.createElement('div');
  card.className = 'list-card';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'list-card__icon';
  if (iconNode) iconWrap.appendChild(iconNode);
  card.appendChild(iconWrap);

  const body = document.createElement('div');
  body.className = 'list-card__body';
  card.appendChild(body);

  const titleEl = document.createElement('div');
  titleEl.className = 'list-card__title';
  titleEl.textContent = title;
  body.appendChild(titleEl);

  if (subtitle) {
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'list-card__subtitle';
    subtitleEl.textContent = subtitle;
    body.appendChild(subtitleEl);
  }

  const metaNodes = meta.filter(Boolean);
  if (metaNodes.length) {
    const metaEl = buildMetaRow(metaNodes, 'list-card__meta');
    if (metaEl) body.appendChild(metaEl);
  }

  sections.forEach((section) => {
    if (section) body.appendChild(section);
  });

  return card;
}

function createCardSection(label, contentNode, fallbackText) {
  return buildSection(label, contentNode, fallbackText, { variant: 'card' });
}

function createDetailSection(label, contentNode, fallbackText) {
  return buildSection(label, contentNode, fallbackText, { variant: 'detail' });
}

function buildSection(label, contentNode, fallbackText, { variant = 'card' } = {}) {
  if (!contentNode && !fallbackText) return null;
  const section = document.createElement('div');
  section.className = variant === 'detail' ? 'detail-section' : 'list-card__section';

  const titleEl = document.createElement('span');
  titleEl.className = variant === 'detail' ? 'detail-section__title' : 'section-title';
  titleEl.textContent = label ? `${label}:` : '';
  section.appendChild(titleEl);

  const body = document.createElement('div');
  body.className = variant === 'detail' ? 'detail-section__body' : 'section-content';
  if (contentNode) {
    body.appendChild(contentNode);
  } else if (fallbackText) {
    const empty = document.createElement('span');
    empty.className = 'empty';
    empty.textContent = fallbackText;
    body.appendChild(empty);
  }
  section.appendChild(body);
  return section;
}

function createChip(text, variant) {
  if (!text) return null;
  const span = document.createElement('span');
  span.className = 'chip';
  if (variant) span.classList.add(`chip--${variant}`);
  span.textContent = text;
  return span;
}

function createChipRow(chips) {
  const items = chips.filter(Boolean);
  if (!items.length) return null;
  const row = document.createElement('div');
  row.className = 'chip-row';
  items.forEach((chip) => row.appendChild(chip));
  return row;
}

function createMetaText(text) {
  return createTextSpan(text);
}

function createTimeMeta(timestamp, label = 'Time Left') {
  if (!Number.isFinite(Number(timestamp))) return null;
  const wrapper = document.createElement('span');
  wrapper.textContent = `${label}: `;
  const timer = createTimerSpan(Number(timestamp));
  if (timer) wrapper.appendChild(timer);
  return wrapper;
}

function createTimerSpan(timestamp) {
  if (!Number.isFinite(timestamp)) return null;
  const span = document.createElement('span');
  span.className = 'timer';
  span.dataset.resolve = String(timestamp);
  const seconds = Math.max(0, (timestamp - Date.now()) / 1000);
  span.textContent = formatTime(seconds);
  return span;
}

function createTextSpan(text) {
  if (text === undefined || text === null || text === '') return null;
  const span = document.createElement('span');
  span.textContent = text;
  return span;
}

function createEtaMeta(timestamp) {
  if (!Number.isFinite(Number(timestamp))) return null;
  const wrapper = document.createElement('span');
  wrapper.textContent = 'ETA ';
  const timer = createTimerSpan(Number(timestamp));
  if (timer) wrapper.appendChild(timer);
  return wrapper;
}

function buildMetaRow(nodes, className) {
  const items = nodes.filter(Boolean);
  if (!items.length) return null;
  const row = document.createElement('div');
  row.className = className;
  items.forEach((node, index) => {
    if (index > 0) {
      const sep = document.createElement('span');
      sep.className = 'meta-sep';
      sep.textContent = '•';
      row.appendChild(sep);
    }
    row.appendChild(node);
  });
  return row;
}

function createImageIcon(url, className = 'list-icon') {
  if (!url) return null;
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.className = className;
  return img;
}

function createUnitIconNode(unit, options = {}) {
  const size = options.size === 'detail' ? { width: 48, height: 28, className: 'detail-icon' } : { width: 36, height: 24, className: 'list-icon' };
  const url = pickUnitIconUrl(unit);
  if (url) {
    return createImageIcon(url, size.className);
  }
  const span = document.createElement('span');
  span.className = 'unit-tag-icon';
  if (unit?.class) span.classList.add(unit.class);
  if (unit?.responding) span.classList.add('responding');
  span.style.setProperty('--tag-width', `${size.width}px`);
  span.style.setProperty('--tag-height', `${size.height}px`);
  const label = (unit?.tag || unit?.name || unit?.type || 'UNIT')
    .split(/\s+/)[0]
    .slice(0, 4)
    .toUpperCase();
  span.textContent = label || 'UNIT';
  return span;
}

function formatRequirementText(req) {
  if (!req) return '';
  const types = Array.isArray(req.types) ? req.types.filter(Boolean) : [];
  if (!types.length && req.type) types.push(req.type);
  const count = Number(req.count ?? req.quantity ?? req.qty ?? req.min ?? 1);
  const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
  const typeStr = types.length ? types.join(' or ') : 'Units';
  return `${safeCount}× ${typeStr}`;
}

function formatTrainingText(req) {
  if (req === null || req === undefined) return '';
  if (typeof req === 'string') return `1× ${req}`;
  const name = req.training || req.name || req.type || req.skill || '';
  if (!name) return '';
  const count = Number(req.qty ?? req.quantity ?? req.count ?? 1);
  const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
  return `${safeCount}× ${name}`;
}

function formatEquipmentRequirementText(req) {
  if (req === null || req === undefined) return '';
  if (typeof req === 'string') return `1× ${req}`;
  const name = req.name || req.type || '';
  if (!name) return '';
  const count = Number(req.qty ?? req.quantity ?? req.count ?? 1);
  const safeCount = Number.isFinite(count) && count > 0 ? count : 1;
  return `${safeCount}× ${name}`;
}

function formatEquipmentName(item) {
  if (!item) return '';
  if (typeof item === 'string') return item;
  const name = item.name || item.type || '';
  const count = Number(item.quantity ?? item.count ?? item.qty);
  if (name && Number.isFinite(count) && count > 1) {
    return `${count}× ${name}`;
  }
  return name;
}

function createAssignedChip(unit) {
  if (!unit) return null;
  const label = unit.name || unit.type || `Unit ${unit.id}`;
  const status = formatStatus(unit.status || 'enroute', unit.responding);
  return createChip(`${label} • ${status}`, 'unit');
}
function buildMissionDetail(mission) {
  const assigned = missionAssignments.get(mission.id) || [];
  const detail = document.createElement('div');
  detail.className = 'detail-view';

  const iconNode = createImageIcon(missionIconUrl(mission, assigned), 'detail-icon');
  const metaNodes = [createMetaText(`Status: ${mission.status || 'Unknown'}`)];
  if (Number.isFinite(mission.resolve_at)) {
    metaNodes.push(createTimeMeta(mission.resolve_at, 'Time Left'));
  }
  if (Number.isFinite(mission.responding_count)) {
    metaNodes.push(createMetaText(`Responding: ${mission.responding_count}`));
  }
  if (Number.isFinite(mission.assigned_count)) {
    metaNodes.push(createMetaText(`Assigned: ${mission.assigned_count}`));
  }
  detail.appendChild(buildDetailHeader({
    iconNode,
    title: mission.type || `Mission ${mission.id}`,
    subtitle: mission.address || '',
    metaNodes
  }));

  const departments = Array.isArray(mission.departments) ? mission.departments : [];
  if (departments.length) {
    const deptRow = createChipRow(departments.map((dept) => createChip(dept, 'dept')));
    detail.appendChild(createDetailSection('Departments', deptRow));
  }

  if (isFiniteLatLon(mission.lat, mission.lon)) {
    detail.appendChild(createDetailSection('Coordinates', createTextSpan(`${Number(mission.lat).toFixed(4)}, ${Number(mission.lon).toFixed(4)}`)));
  }

  detail.appendChild(createDetailSection('Assigned Units', createAssignedDetailList(assigned), 'No units assigned yet.'));

  const unitReqList = createListFromArray((Array.isArray(mission.required_units) ? mission.required_units : []).map(formatRequirementText));
  detail.appendChild(createDetailSection('Unit Requirements', unitReqList, 'No vehicle requirements.'));

  const trainingList = createListFromArray((Array.isArray(mission.required_training) ? mission.required_training : []).map(formatTrainingText));
  if (trainingList) detail.appendChild(createDetailSection('Personnel Requirements', trainingList));

  const equipmentList = createListFromArray((Array.isArray(mission.equipment_required) ? mission.equipment_required : []).map(formatEquipmentRequirementText));
  if (equipmentList) detail.appendChild(createDetailSection('Equipment Required', equipmentList));

  return detail;
}

function buildStationDetail(station) {
  const detail = document.createElement('div');
  detail.className = 'detail-view';

  const iconUrl = station.icon || stationIcons[station.type] || stationIcons.fire;
  const metaNodes = [];
  if (station.department) metaNodes.push(createMetaText(station.department));
  if (station.type) metaNodes.push(createMetaText(station.type));
  detail.appendChild(buildDetailHeader({
    iconNode: createImageIcon(iconUrl, 'detail-icon'),
    title: station.name || `Station ${station.id}`,
    subtitle: station.address || '',
    metaNodes
  }));

  if (isFiniteLatLon(station.lat, station.lon)) {
    detail.appendChild(createDetailSection('Coordinates', createTextSpan(`${Number(station.lat).toFixed(4)}, ${Number(station.lon).toFixed(4)}`)));
  }
  if (Number.isFinite(station.bay_count)) {
    detail.appendChild(createDetailSection('Bays', createTextSpan(String(station.bay_count))));
  }

  const facilitySection = createFacilitySection(station, 'detail');
  if (facilitySection) detail.appendChild(facilitySection);

  const equipmentList = createListFromArray((Array.isArray(station.equipment) ? station.equipment : []).map(formatEquipmentName));
  if (equipmentList) detail.appendChild(createDetailSection('Equipment', equipmentList));

  const units = unitsByStation.get(station.id) || [];
  detail.appendChild(createDetailSection('Units', createAssignedDetailList(units), units.length ? undefined : 'No units assigned.'));
  return detail;
}

function buildUnitDetail(unit) {
  const detail = document.createElement('div');
  detail.className = 'detail-view';

  const iconNode = createUnitIconNode(unit, { size: 'detail' });
  const station = stationById.get(unit.station_id);
  const metaNodes = [createMetaText(formatStatus(unit.status || 'available', unit.responding))];
  if (station?.name) metaNodes.push(createMetaText(station.name));
  if (Number.isFinite(unit.priority)) metaNodes.push(createMetaText(`Priority ${unit.priority}`));
  detail.appendChild(buildDetailHeader({
    iconNode,
    title: unit.name || `Unit ${unit.id}`,
    subtitle: unit.type || '',
    metaNodes
  }));

  const detailLines = [];
  if (unit.class) detailLines.push(`Class: ${unit.class}`);
  if (unit.tag) detailLines.push(`Tag: ${unit.tag}`);
  if (unit.station_id != null) detailLines.push(`Station ID: ${unit.station_id}`);
  const detailList = createListFromArray(detailLines);
  if (detailList) detail.appendChild(createDetailSection('Details', detailList));

  const equipmentList = createListFromArray((Array.isArray(unit.equipment) ? unit.equipment : []).map(formatEquipmentName));
  detail.appendChild(createDetailSection('Equipment', equipmentList, 'No equipment assigned.'));

  const personnelList = createPersonnelList(unit.personnel);
  detail.appendChild(createDetailSection('Personnel', personnelList, 'No personnel assigned.'));

  return detail;
}

function buildDetailHeader({ iconNode, title, subtitle, metaNodes = [] }) {
  const header = document.createElement('div');
  header.className = 'detail-header';

  const iconWrap = document.createElement('div');
  iconWrap.className = 'detail-header__icon';
  if (iconNode) iconWrap.appendChild(iconNode);
  header.appendChild(iconWrap);

  const textWrap = document.createElement('div');
  textWrap.className = 'detail-header__text';
  const titleEl = document.createElement('h3');
  titleEl.className = 'detail-header__title';
  titleEl.textContent = title;
  textWrap.appendChild(titleEl);
  if (subtitle) {
    const subtitleEl = document.createElement('div');
    subtitleEl.className = 'detail-header__subtitle';
    subtitleEl.textContent = subtitle;
    textWrap.appendChild(subtitleEl);
  }
  const metaRow = buildMetaRow(metaNodes, 'detail-header__meta');
  if (metaRow) textWrap.appendChild(metaRow);
  header.appendChild(textWrap);
  return header;
}

function createAssignedDetailList(units) {
  const list = Array.isArray(units) ? units : [];
  if (!list.length) return null;
  const ul = document.createElement('ul');
  ul.className = 'detail-list';
  list.forEach((unit) => {
    const li = document.createElement('li');
    const title = document.createElement('div');
    title.className = 'detail-list__title';
    title.textContent = unit?.name || unit?.type || `Unit ${unit?.id ?? ''}`;
    li.appendChild(title);

    const metaNodes = [];
    metaNodes.push(createTextSpan(formatStatus(unit?.status || 'enroute', unit?.responding)));
    if (unit?.type) metaNodes.push(createTextSpan(unit.type));
    const personnelCount = Array.isArray(unit?.personnel) ? unit.personnel.length : 0;
    if (personnelCount) metaNodes.push(createTextSpan(`${personnelCount} personnel`));
    const etaNode = createEtaMeta(unit?.eta);
    if (etaNode) metaNodes.push(etaNode);
    const metaRow = buildMetaRow(metaNodes, 'detail-list__meta');
    if (metaRow) li.appendChild(metaRow);
    ul.appendChild(li);
  });
  return ul;
}

function createPersonnelList(personnel) {
  const list = Array.isArray(personnel) ? personnel : [];
  if (!list.length) return null;
  const ul = document.createElement('ul');
  ul.className = 'detail-list';
  list.forEach((person) => {
    const name = person?.name || 'Personnel';
    const details = [];
    if (person?.rank) details.push(person.rank);
    if (Array.isArray(person?.training) && person.training.length) {
      details.push(`Training: ${person.training.join(', ')}`);
    }
    const li = document.createElement('li');
    li.textContent = details.length ? `${name} (${details.join(' • ')})` : name;
    ul.appendChild(li);
  });
  return ul;
}

function createListFromArray(items) {
  const texts = (items || [])
    .map((item) => (item ?? ''))
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .filter(Boolean);
  if (!texts.length) return null;
  const ul = document.createElement('ul');
  ul.className = 'detail-list';
  texts.forEach((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    ul.appendChild(li);
  });
  return ul;
}

function createFacilitySection(station, variant) {
  if (station.type === 'hospital') {
    const capacity = Number(station.bed_capacity);
    if (Number.isFinite(capacity) && capacity > 0) {
      const occupied = Number.isFinite(Number(station.occupied_beds)) ? Number(station.occupied_beds) : 0;
      return buildSection('Beds', createTextSpan(`${occupied}/${capacity} occupied`), null, { variant });
    }
  }
  const cellCapacity = Number(station.holding_cells);
  if (station.type === 'jail' || (Number.isFinite(cellCapacity) && cellCapacity > 0)) {
    const capacity = Number.isFinite(cellCapacity) ? cellCapacity : 0;
    if (capacity > 0) {
      const occupied = Number.isFinite(Number(station.occupied_cells)) ? Number(station.occupied_cells) : 0;
      return buildSection('Cells', createTextSpan(`${occupied}/${capacity} occupied`), null, { variant });
    }
  }
  return null;
}

function createEmptyMessage(text) {
  const p = document.createElement('p');
  p.className = 'empty-state';
  p.textContent = text;
  return p;
}

function ensureMissionTimerUpdates() {
  if (missionTimerInterval) return;
  missionTimerInterval = setInterval(() => {
    document.querySelectorAll('.timer[data-resolve]').forEach((el) => {
      const ts = Number(el.dataset.resolve);
      if (!Number.isFinite(ts)) return;
      const seconds = Math.max(0, (ts - Date.now()) / 1000);
      el.textContent = formatTime(seconds);
    });
  }, 1000);
}

loadData();
setInterval(loadData, 15000);
window.addEventListener('focus', () => loadData());
