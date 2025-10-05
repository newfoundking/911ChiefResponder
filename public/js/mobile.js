import { fetchNoCache, formatStatus, formatTime, haversineKm } from './common.js';

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
  const closeBtn = document.createElement('button');
  closeBtn.id = 'modalClose';
  closeBtn.className = 'modal-close-btn';
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeModal);
  modalContent.appendChild(closeBtn);
  if (content instanceof Node) {
    modalContent.appendChild(content);
  } else if (content !== undefined && content !== null) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = String(content);
    modalContent.appendChild(wrapper);
  }
  modal.style.display = 'flex';
  modalContent.scrollTop = 0;
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
let stationSortMode = 'name';
let activeUnitDepartment = 'all';
let unitSortMode = 'status';

const defaultEquipmentProvider =
  typeof globalThis !== 'undefined' && typeof globalThis.getDefaultUnitEquipment === 'function'
    ? globalThis.getDefaultUnitEquipment
    : typeof window !== 'undefined' && typeof window.getDefaultUnitEquipment === 'function'
      ? window.getDefaultUnitEquipment
      : null;

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

function expandTrainingListForClass(list, cls) {
  if (
    typeof trainingHelpers !== 'undefined' &&
    trainingHelpers &&
    typeof trainingHelpers.expandTrainingList === 'function'
  ) {
    return trainingHelpers.expandTrainingList(list, cls) || [];
  }
  return Array.isArray(list) ? list : [];
}

let responseZonesCache = null;

async function missionDepartmentsFor(mission) {
  if (Array.isArray(mission?.departments) && mission.departments.length) {
    return mission.departments;
  }
  if (!isFiniteLatLon(mission?.lat, mission?.lon)) return [];
  if (!responseZonesCache) {
    try {
      responseZonesCache = await fetchJson('/api/response-zones');
    } catch {
      responseZonesCache = [];
    }
  }
  const zones = Array.isArray(responseZonesCache) ? responseZonesCache : [];
  const set = new Set();
  zones.forEach((zone) => {
    if (pointInPolygon(mission.lat, mission.lon, zone?.polygon)) {
      const departments = Array.isArray(zone?.departments) ? zone.departments : [];
      departments.forEach((dept) => {
        if (dept) set.add(dept);
      });
    }
  });
  return Array.from(set);
}

function pointInPolygon(lat, lon, polygon) {
  const pts = Array.isArray(polygon?.coordinates) ? polygon.coordinates : [];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][1];
    const yi = pts[i][0];
    const xj = pts[j][1];
    const yj = pts[j][0];
    const intersect = (yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

async function fetchAvailableUnitsForMission(mission) {
  const [stations, unitsRaw] = await Promise.all([
    fetchJson('/api/stations'),
    fetchJson('/api/units?status=available')
  ]);

  const stationMap = new Map(stations.map((station) => [station.id, station]));
  const missionDepts = await missionDepartmentsFor(mission);
  const restrictByDept = missionDepts.length > 0;

  const units = unitsRaw
    .filter((unit) => {
      const station = stationMap.get(unit.station_id);
      const dept = station?.department;
      if (restrictByDept) {
        return dept && missionDepts.includes(dept);
      }
      return true;
    })
    .map((unit) => {
      const station = stationMap.get(unit.station_id);
      const hasCoords =
        station &&
        isFiniteLatLon(station.lat, station.lon) &&
        isFiniteLatLon(mission.lat, mission.lon);
      const distance = hasCoords
        ? haversineKm(Number(station.lat), Number(station.lon), Number(mission.lat), Number(mission.lon))
        : Infinity;
      return {
        ...unit,
        priority: Number(unit.priority) || 1,
        _distanceKm: distance,
        station
      };
    });

  return { units };
}

const UNIT_STATUS_ORDER = {
  on_scene: 0,
  enroute: 1,
  returning: 2,
  transporting: 3,
  available: 4
};


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

  const controls = document.createElement('div');
  controls.className = 'tab-controls';
  const sortControl = createSegmentedControl(
    [
      { value: 'name', label: 'Name' },
      { value: 'department', label: 'Department' },
      { value: 'type', label: 'Type' }
    ],
    stationSortMode,
    (value) => {
      stationSortMode = value;
      renderStations(latestStations);
    }
  );
  controls.appendChild(createControlGroup('Group Stations', sortControl));
  container.appendChild(controls);

  const groups = buildStationGroups(stations, stationSortMode);
  groups.forEach((group) => {
    if (group.title) {
      container.appendChild(createGroupHeader(group.title));
    }
    group.items.forEach((station) => {
      container.appendChild(createStationCard(station));
    });
  });
}

function renderUnits(units) {
  const container = document.getElementById('unitsTab');
  container.innerHTML = '';
  if (!units.length) {
    container.appendChild(createEmptyMessage('No units available.'));
    return;
  }

  const departmentOptions = buildDepartmentOptions(units);
  if (activeUnitDepartment !== 'all' && !departmentOptions.some((opt) => opt.value === activeUnitDepartment)) {
    activeUnitDepartment = 'all';
  }

  const controls = document.createElement('div');
  controls.className = 'tab-controls';

  const deptControl = createSegmentedControl(departmentOptions, activeUnitDepartment, (value) => {
    activeUnitDepartment = value;
    renderUnits(latestUnits);
  });
  controls.appendChild(createControlGroup('Department', deptControl));

  const sortControl = createSegmentedControl(
    [
      { value: 'status', label: 'Status' },
      { value: 'name', label: 'Name' }
    ],
    unitSortMode,
    (value) => {
      unitSortMode = value;
      renderUnits(latestUnits);
    }
  );
  controls.appendChild(createControlGroup('Sort Units', sortControl));

  container.appendChild(controls);

  const groups = buildUnitGroups(units, activeUnitDepartment, unitSortMode);
  if (!groups.length) {
    container.appendChild(createEmptyMessage('No units match the selected filters.'));
    return;
  }

  groups.forEach((group) => {
    if (group.title) {
      container.appendChild(createGroupHeader(group.title));
    }
    group.items.forEach((unit) => {
      container.appendChild(createUnitCard(unit));
    });
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
    if (!shouldDisplayUnitOnMap(unit)) return;
    const coords = getUnitCoordinates(unit);
    if (!coords) return;
    const marker = L.marker([coords.lat, coords.lon], { icon: unitIconFor(unit), zIndexOffset: 1000 })
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

function buildStationGroups(stations, mode) {
  if (mode === 'department') {
    const groups = new Map();
    stations.forEach((station) => {
      const key = station?.department || 'No Department';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(station);
    });
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, items]) => ({ title, items: sortStationsByName(items) }));
  }
  if (mode === 'type') {
    const groups = new Map();
    stations.forEach((station) => {
      const key = station?.type || 'Other';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(station);
    });
    return Array.from(groups.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, items]) => ({ title, items: sortStationsByName(items) }));
  }
  return [{ title: null, items: sortStationsByName(stations) }];
}

function sortStationsByName(stations) {
  return [...stations].sort((a, b) => (a?.name || '').localeCompare(b?.name || ''));
}

function createStationCard(station) {
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
  return card;
}

function buildDepartmentOptions(units) {
  const departments = new Map();
  let hasNoDept = false;
  units.forEach((unit) => {
    const station = stationById.get(unit.station_id);
    const dept = station?.department;
    if (dept) {
      departments.set(dept, (departments.get(dept) || 0) + 1);
    } else {
      hasNoDept = true;
    }
  });
  const options = [{ value: 'all', label: 'All' }];
  Array.from(departments.keys())
    .sort((a, b) => a.localeCompare(b))
    .forEach((dept) => options.push({ value: dept, label: dept }));
  if (hasNoDept) {
    options.push({ value: '__none__', label: 'No Department' });
  }
  return options;
}

function buildUnitGroups(units, departmentFilter, sortMode) {
  const filtered = units.filter((unit) => {
    if (departmentFilter === 'all') return true;
    const station = stationById.get(unit.station_id);
    const dept = station?.department;
    if (departmentFilter === '__none__') {
      return !dept;
    }
    return dept === departmentFilter;
  });

  const groups = new Map();
  filtered.forEach((unit) => {
    const station = stationById.get(unit.station_id);
    const key = station?.id ?? '__unassigned__';
    if (!groups.has(key)) {
      groups.set(key, { station, units: [] });
    }
    groups.get(key).units.push(unit);
  });

  return Array.from(groups.values())
    .sort((a, b) => {
      const nameA = a.station?.name || 'Unassigned Station';
      const nameB = b.station?.name || 'Unassigned Station';
      return nameA.localeCompare(nameB);
    })
    .map(({ station, units: stationUnits }) => {
      const sortedUnits = sortUnitsForDisplay(stationUnits, sortMode);
      const stationName = station?.name || 'Unassigned Station';
      const dept = station?.department ? ` • ${station.department}` : '';
      return {
        title: `${stationName}${dept}`,
        items: sortedUnits
      };
    });
}

function sortUnitsForDisplay(units, sortMode) {
  return [...units].sort((a, b) => {
    if (sortMode === 'status') {
      const orderDiff = (UNIT_STATUS_ORDER[a.status] ?? 99) - (UNIT_STATUS_ORDER[b.status] ?? 99);
      if (orderDiff !== 0) return orderDiff;
    }
    return (a.name || '').localeCompare(b.name || '');
  });
}

function createUnitCard(unit) {
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
  return card;
}

function createControlGroup(label, node) {
  const wrap = document.createElement('div');
  wrap.className = 'control-group';
  const labelEl = document.createElement('span');
  labelEl.className = 'control-label';
  labelEl.textContent = label;
  wrap.appendChild(labelEl);
  wrap.appendChild(node);
  return wrap;
}

function createSegmentedControl(options, activeValue, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'segmented';
  options.forEach((option) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = option.label;
    btn.classList.toggle('active', option.value === activeValue);
    btn.addEventListener('click', () => {
      if (option.value === activeValue) return;
      activeValue = option.value;
      onChange(option.value);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function createGroupHeader(text) {
  const header = document.createElement('div');
  header.className = 'group-header';
  header.textContent = text;
  return header;
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

function shouldDisplayUnitOnMap(unit) {
  if (!unit) return false;
  if (unit.responding) return true;
  const status = String(unit.status || '').toLowerCase();
  if (!status) return false;
  return status !== 'available';
}

function getUnitCoordinates(unit) {
  if (!unit) return null;
  if (isFiniteLatLon(unit.lat, unit.lon)) {
    return { lat: Number(unit.lat), lon: Number(unit.lon) };
  }
  const station = stationById.get(unit.station_id);
  if (station && isFiniteLatLon(station.lat, station.lon)) {
    return { lat: Number(station.lat), lon: Number(station.lon) };
  }
  return null;
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

  const dispatchSection = buildMissionDispatchSection(mission);
  if (dispatchSection) {
    detail.appendChild(createDetailSection('Dispatch Units', dispatchSection.node, dispatchSection.fallback));
  }

  return detail;
}

function buildMissionDispatchSection(mission) {
  const dispatchable = getDispatchableUnitsForMission(mission);
  if (!dispatchable.length) {
    return { node: null, fallback: 'No eligible units available.' };
  }

  const wrapper = document.createElement('div');
  wrapper.className = 'dispatch-section';

  const buttonGrid = document.createElement('div');
  buttonGrid.className = 'dispatch-button-grid';

  const panelContainer = document.createElement('div');
  panelContainer.className = 'dispatch-panel-container hidden';

  const status = document.createElement('div');
  status.className = 'dispatch-status';

  const setStatus = (message = '', tone = 'info') => {
    status.textContent = message;
    status.dataset.tone = tone;
  };

  const refreshMissionDetail = async () => {
    await loadData();
    const updated = latestMissions.find((m) => m.id === mission.id);
    if (updated) {
      showModal(buildMissionDetail(updated));
    } else {
      closeModal();
    }
  };

  const createActionButton = (label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dispatch-button';
    btn.textContent = label;
    return btn;
  };

  const handleAction = async (btn, fn) => {
    if (btn.disabled) return;
    btn.disabled = true;
    try {
      await fn();
    } catch (err) {
      setStatus(err?.message || 'Dispatch failed.', 'error');
    } finally {
      btn.disabled = false;
    }
  };

  let manualBtn;
  let unitTypeBtn;
  let activePanelKey = null;

  const updatePanelState = () => {
    if (manualBtn) manualBtn.classList.toggle('active', activePanelKey === 'manual');
    if (unitTypeBtn) unitTypeBtn.classList.toggle('active', activePanelKey === 'unitType');
    panelContainer.classList.toggle('hidden', activePanelKey === null);
  };

  const hidePanel = () => {
    panelContainer.innerHTML = '';
    activePanelKey = null;
    updatePanelState();
  };

  const openPanel = (key, factory) => {
    if (activePanelKey === key) {
      hidePanel();
      return;
    }
    panelContainer.innerHTML = '';
    const node = factory();
    if (node) {
      panelContainer.appendChild(node);
      activePanelKey = key;
    } else {
      activePanelKey = null;
    }
    updatePanelState();
  };

  const autoBtn = createActionButton('Auto');
  autoBtn.addEventListener('click', () =>
    handleAction(autoBtn, async () => {
      hidePanel();
      setStatus('Calculating auto dispatch…', 'info');
      const count = await autoDispatchMission(mission);
      setStatus(`Dispatched ${count} unit${count === 1 ? '' : 's'}.`, 'success');
      await refreshMissionDetail();
    })
  );
  buttonGrid.appendChild(autoBtn);

  const runCardBtn = createActionButton('Run Card');
  runCardBtn.addEventListener('click', () =>
    handleAction(runCardBtn, async () => {
      hidePanel();
      setStatus('Applying run card…', 'info');
      const count = await runCardDispatchMission(mission);
      setStatus(`Dispatched ${count} unit${count === 1 ? '' : 's'}.`, 'success');
      await refreshMissionDetail();
    })
  );
  buttonGrid.appendChild(runCardBtn);

  manualBtn = createActionButton('Manual');
  manualBtn.addEventListener('click', () => {
    setStatus('');
    openPanel('manual', () =>
      buildManualDispatchPanel(mission, {
        setStatus,
        onComplete: refreshMissionDetail
      })
    );
  });
  buttonGrid.appendChild(manualBtn);

  unitTypeBtn = createActionButton('Unit Type');
  unitTypeBtn.addEventListener('click', () => {
    setStatus('');
    openPanel('unitType', () =>
      buildUnitTypeDispatchPanel(mission, {
        setStatus,
        onComplete: refreshMissionDetail
      })
    );
  });
  buttonGrid.appendChild(unitTypeBtn);

  wrapper.appendChild(buttonGrid);
  wrapper.appendChild(panelContainer);
  wrapper.appendChild(status);

  return { node: wrapper, fallback: null };
}

function buildManualDispatchPanel(mission, { setStatus, onComplete }) {
  const container = document.createElement('div');
  container.className = 'dispatch-panel dispatch-panel--manual';

  const intro = document.createElement('p');
  intro.className = 'dispatch-panel__intro';
  intro.textContent = 'Select available units to send to this mission.';
  container.appendChild(intro);

  const listWrapper = document.createElement('div');
  listWrapper.className = 'dispatch-panel__list';
  container.appendChild(listWrapper);

  const actions = document.createElement('div');
  actions.className = 'dispatch-panel__actions';
  container.appendChild(actions);

  const dispatchBtn = document.createElement('button');
  dispatchBtn.type = 'button';
  dispatchBtn.className = 'dispatch-button dispatch-button--primary';
  dispatchBtn.textContent = 'Dispatch Selected';
  actions.appendChild(dispatchBtn);

  const forceLabel = document.createElement('label');
  forceLabel.className = 'dispatch-panel__force';
  const forceCheckbox = document.createElement('input');
  forceCheckbox.type = 'checkbox';
  forceLabel.appendChild(forceCheckbox);
  const forceText = document.createElement('span');
  forceText.textContent = 'Force dispatch';
  forceLabel.appendChild(forceText);
  actions.appendChild(forceLabel);

  const renderUnits = async () => {
    listWrapper.innerHTML = '<div class="dispatch-panel__loading">Loading available units…</div>';
    dispatchBtn.disabled = true;
    try {
      const { units } = await fetchAvailableUnitsForMission(mission);
      if (!units.length) {
        listWrapper.innerHTML = '<div class="dispatch-panel__empty">No available units meet the criteria.</div>';
        return;
      }

      const groups = new Map();
      units.forEach((unit) => {
        const station = unit.station;
        const deptKey = station?.department || 'No Department';
        if (!groups.has(deptKey)) groups.set(deptKey, new Map());
        const stationKey = station?.id ?? '__unassigned__';
        if (!groups.get(deptKey).has(stationKey)) {
          groups.get(deptKey).set(stationKey, { station, units: [] });
        }
        groups.get(deptKey).get(stationKey).units.push(unit);
      });

      const departmentEntries = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
      listWrapper.innerHTML = '';

      departmentEntries.forEach(([dept, stations]) => {
        const group = document.createElement('div');
        group.className = 'dispatch-group';

        const title = document.createElement('div');
        title.className = 'dispatch-group__title';
        title.textContent = dept;
        group.appendChild(title);

        const stationEntries = Array.from(stations.values()).sort((a, b) => {
          const nameA = a.station?.name || 'Unassigned Station';
          const nameB = b.station?.name || 'Unassigned Station';
          return nameA.localeCompare(nameB);
        });

        stationEntries.forEach(({ station, units: stationUnits }) => {
          const stationWrap = document.createElement('div');
          stationWrap.className = 'dispatch-station';

          const stationTitle = document.createElement('div');
          stationTitle.className = 'dispatch-station__title';
          stationTitle.textContent = station?.name || 'Unassigned Station';
          stationWrap.appendChild(stationTitle);

          const unitList = document.createElement('div');
          unitList.className = 'dispatch-unit-list';
          sortUnitsForDisplay(stationUnits, 'name').forEach((unit) => {
            const label = document.createElement('label');
            label.className = 'dispatch-unit';

            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.value = unit.id;
            label.appendChild(checkbox);

            const textWrap = document.createElement('div');
            textWrap.className = 'dispatch-unit__text';
            label.appendChild(textWrap);

            const main = document.createElement('span');
            main.className = 'dispatch-unit__name';
            main.textContent = unit.name || unit.type || `Unit ${unit.id}`;
            textWrap.appendChild(main);

            const metaParts = [];
            if (unit.type) metaParts.push(unit.type);
            if (Number.isFinite(unit._distanceKm) && unit._distanceKm !== Infinity) {
              metaParts.push(`${unit._distanceKm.toFixed(1)} km`);
            }
            if (metaParts.length) {
              const meta = document.createElement('span');
              meta.className = 'dispatch-unit__meta';
              meta.textContent = metaParts.join(' • ');
              textWrap.appendChild(meta);
            }

            unitList.appendChild(label);
          });

          stationWrap.appendChild(unitList);
          group.appendChild(stationWrap);
        });

        listWrapper.appendChild(group);
      });

      dispatchBtn.disabled = false;
    } catch (err) {
      listWrapper.innerHTML = `<div class="dispatch-panel__error">${err?.message || 'Failed to load units.'}</div>`;
    }
  };

  renderUnits();

  dispatchBtn.addEventListener('click', async () => {
    const selected = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map((input) => Number(input.value));
    if (!selected.length) {
      setStatus('Select at least one unit to dispatch.', 'error');
      return;
    }
    dispatchBtn.disabled = true;
    setStatus('Dispatching selected units…', 'info');
    try {
      await dispatchUnitsForMission(mission, selected, { force: forceCheckbox.checked });
      setStatus(`Dispatched ${selected.length} unit${selected.length === 1 ? '' : 's'}.`, 'success');
      await onComplete();
    } catch (err) {
      setStatus(err?.message || 'Dispatch failed.', 'error');
    } finally {
      dispatchBtn.disabled = false;
    }
  });

  return container;
}

function buildUnitTypeDispatchPanel(mission, { setStatus, onComplete }) {
  const container = document.createElement('div');
  container.className = 'dispatch-panel dispatch-panel--types';

  const listWrapper = document.createElement('div');
  listWrapper.className = 'dispatch-panel__list';
  container.appendChild(listWrapper);

  const populate = async () => {
    listWrapper.innerHTML = '<div class="dispatch-panel__loading">Loading unit types…</div>';
    try {
      const { units } = await fetchAvailableUnitsForMission(mission);
      const groups = new Map();
      units.forEach((unit) => {
        const typeKey = unit.type || 'Unknown';
        if (!groups.has(typeKey)) groups.set(typeKey, []);
        groups.get(typeKey).push(unit);
      });

      const entries = Array.from(groups.entries()).sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length) {
        listWrapper.innerHTML = '<div class="dispatch-panel__empty">No available units to dispatch by type.</div>';
        return;
      }

      listWrapper.innerHTML = '';
      entries.forEach(([type, list]) => {
        list.sort((a, b) => {
          const distDiff = (a._distanceKm ?? Infinity) - (b._distanceKm ?? Infinity);
          if (distDiff !== 0) return distDiff;
          const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
          if (priorityDiff !== 0) return priorityDiff;
          return (a.name || '').localeCompare(b.name || '');
        });

        const row = document.createElement('div');
        row.className = 'dispatch-type-row';

        const label = document.createElement('div');
        label.className = 'dispatch-type-label';
        label.textContent = `${type} (${list.length})`;
        row.appendChild(label);

        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.className = 'dispatch-type-button';
        sendBtn.textContent = 'Send 1';
        row.appendChild(sendBtn);

        sendBtn.addEventListener('click', async () => {
          if (!list.length) {
            setStatus('No available units of this type.', 'error');
            return;
          }
          const unit = list.shift();
          sendBtn.disabled = true;
          setStatus(`Dispatching ${unit.name || unit.type || 'unit'}…`, 'info');
          try {
            await dispatchUnitsForMission(mission, [unit.id], { force: true });
            setStatus(`Dispatched ${unit.name || unit.type || 'unit'}.`, 'success');
            await onComplete();
          } catch (err) {
            setStatus(err?.message || 'Dispatch failed.', 'error');
          } finally {
            sendBtn.disabled = false;
          }
        });

        listWrapper.appendChild(row);
      });
    } catch (err) {
      listWrapper.innerHTML = `<div class="dispatch-panel__error">${err?.message || 'Failed to load unit types.'}</div>`;
    }
  };

  populate();

  return container;
}

async function autoDispatchMission(mission) {
  const { units } = await fetchAvailableUnitsForMission(mission);
  const trainingNeeds = (Array.isArray(mission.required_training) ? mission.required_training : [])
    .map((req) => ({ name: req.training || req.name || req, qty: Number(req.qty ?? req.quantity ?? req.count ?? 1) }))
    .filter((item) => item.name);
  const equipmentNeeds = (Array.isArray(mission.equipment_required) ? mission.equipment_required : [])
    .map((req) => ({ name: req.name || req.type || req, qty: Number(req.qty ?? req.quantity ?? req.count ?? 1) }))
    .filter((item) => item.name);

  function trainingCount(unit, name) {
    const target = String(name || '').trim().toLowerCase();
    if (!target) return 0;
    let count = 0;
    for (const person of Array.isArray(unit.personnel) ? unit.personnel : []) {
      const list = Array.isArray(person.training) ? person.training : [];
      const expanded = expandTrainingListForClass(list, unit.class);
      if (expanded.some((t) => String(t || '').trim().toLowerCase() === target)) count++;
    }
    return count;
  }

  function equipmentCount(unit, name) {
    const key = equipmentKey(name);
    if (!key) return 0;
    const counts = gatherEquipmentForUnit(unit);
    return counts.get(key) || 0;
  }

  function applyNeeds(unit) {
    for (const need of trainingNeeds) {
      need.qty -= trainingCount(unit, need.name);
    }
    for (const need of equipmentNeeds) {
      need.qty -= equipmentCount(unit, need.name);
    }
  }

  const assigned = await fetchJson(`/api/missions/${mission.id}/units`).catch(() => []);
  const assignedCounts = {};
  for (const unit of Array.isArray(assigned) ? assigned : []) {
    if (!['enroute', 'on_scene'].includes(unit?.status)) continue;
    if (unit?.type) {
      assignedCounts[unit.type] = (assignedCounts[unit.type] || 0) + 1;
    }
    applyNeeds(unit);
  }

  const selected = [];
  const selectedIds = new Set();

  const sortUnits = (a, b) => {
    const distDiff = (a._distanceKm ?? Infinity) - (b._distanceKm ?? Infinity);
    if (distDiff !== 0) return distDiff;
    if (a.station_id === b.station_id) {
      const priorityDiff = (a.priority ?? 0) - (b.priority ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
    }
    return (a.name || '').localeCompare(b.name || '');
  };

  function unitMatchesNeed(unit) {
    return trainingNeeds.some((need) => need.qty > 0 && trainingCount(unit, need.name) > 0) ||
      equipmentNeeds.some((need) => need.qty > 0 && equipmentCount(unit, need.name) > 0);
  }

  function unitMatchesAllNeeds(unit) {
    return trainingNeeds.every((need) => need.qty <= 0 || trainingCount(unit, need.name) > 0) &&
      equipmentNeeds.every((need) => need.qty <= 0 || equipmentCount(unit, need.name) > 0);
  }

  function selectUnit(unit) {
    if (!unit || selectedIds.has(unit.id)) return;
    selectedIds.add(unit.id);
    selected.push(unit);
    applyNeeds(unit);
  }

  const requirements = Array.isArray(mission.required_units) ? mission.required_units : [];
  for (const req of requirements) {
    const types = Array.isArray(req.types) ? req.types.filter(Boolean) : [];
    if (!types.length && req.type) types.push(req.type);
    const needTotal = Number(req.quantity ?? req.count ?? req.qty ?? 1) || 1;
    let remaining = needTotal - types.reduce((sum, type) => sum + (assignedCounts[type] || 0), 0);
    remaining = Math.max(0, remaining);
    for (let i = 0; i < remaining; i++) {
      const candidates = units
        .filter((unit) => !selectedIds.has(unit.id) && types.includes(unit.type))
        .sort(sortUnits);
      if (!candidates.length) break;
      const chosen = candidates.find(unitMatchesAllNeeds) || candidates.find(unitMatchesNeed) || candidates[0];
      selectUnit(chosen);
    }
  }

  for (const need of trainingNeeds) {
    while (need.qty > 0) {
      const candidates = units
        .filter((unit) => !selectedIds.has(unit.id) && trainingCount(unit, need.name) > 0)
        .sort(sortUnits);
      if (!candidates.length) break;
      selectUnit(candidates[0]);
    }
  }

  for (const need of equipmentNeeds) {
    while (need.qty > 0) {
      const candidates = units
        .filter((unit) => !selectedIds.has(unit.id) && equipmentCount(unit, need.name) > 0)
        .sort(sortUnits);
      if (!candidates.length) break;
      selectUnit(candidates[0]);
    }
  }

  if (!selected.length) {
    throw new Error('No additional units available for dispatch.');
  }

  await dispatchUnitsForMission(mission, selected.map((unit) => unit.id));
  return selected.length;
}

async function runCardDispatchMission(mission) {
  if (!mission?.type) {
    throw new Error('Mission type unavailable for run card dispatch.');
  }
  const res = await fetchNoCache(`/api/run-cards/${encodeURIComponent(mission.type)}`);
  if (!res.ok) {
    const message = await res.text().catch(() => 'No run card for this mission.');
    throw new Error(message || 'No run card for this mission.');
  }
  const card = await res.json();
  const rcMission = {
    ...mission,
    required_units: card?.units || [],
    required_training: card?.training || [],
    equipment_required: card?.equipment || []
  };
  return autoDispatchMission(rcMission);
}

function getDispatchableUnitsForMission(mission) {
  const assignedIds = new Set((missionAssignments.get(mission.id) || []).map((unit) => unit.id));
  const departments = new Set((Array.isArray(mission.departments) ? mission.departments : []).filter(Boolean));
  const restrictByDept = departments.size > 0;

  return latestUnits
    .filter((unit) => {
      if (assignedIds.has(unit.id)) return false;
      const status = String(unit.status || '').toLowerCase();
      if (status !== 'available') return false;
      const station = stationById.get(unit.station_id);
      const dept = station?.department;
      if (restrictByDept) {
        return dept && departments.has(dept);
      }
      return true;
    })
    .map((unit) => {
      const station = stationById.get(unit.station_id);
      return {
        unit,
        station,
        department: station?.department || 'No Department'
      };
    });
}

async function dispatchUnitsForMission(mission, unitIds, { force = false } = {}) {
  for (const unitId of unitIds) {
    const res = await fetch('/api/mission-units', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mission_id: mission.id, unit_id: unitId, force })
    });
    if (!res.ok) {
      throw new Error(await extractErrorMessage(res));
    }
  }
}

async function extractErrorMessage(res) {
  try {
    const text = await res.text();
    if (text) {
      try {
        const data = JSON.parse(text);
        if (data && data.error) return data.error;
      } catch {}
      return text;
    }
  } catch {}
  return res.statusText || 'Request failed';
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
