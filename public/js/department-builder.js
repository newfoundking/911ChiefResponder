const stationListEl = document.getElementById('stationList');
const addStationBtn = document.getElementById('addStation');
const submitBtn = document.getElementById('submitDepartment');
const resetBtn = document.getElementById('resetForm');
const deptNameInput = document.getElementById('departmentName');
const deptRanksInput = document.getElementById('departmentRanks');
const statusMessage = document.getElementById('statusMessage');

function normalizeText(value) {
  return String(value || '').trim();
}

function uniqueValues(values) {
  const seen = new Set();
  const result = [];
  values.forEach((value) => {
    const trimmed = normalizeText(value);
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(trimmed);
  });
  return result;
}

function getDepartmentRankOptions() {
  if (!deptRanksInput) return [];
  const raw = deptRanksInput.value || '';
  return uniqueValues(raw.split(','));
}

async function fetchRandomPersonName() {
  try {
    const rnd = await fetch('/api/random-name').then((res) => res.json());
    if (rnd?.first && rnd?.last) {
      return `${rnd.first} ${rnd.last}`;
    }
  } catch {
    // ignore failures and fall back to empty string
  }
  return '';
}

function buildRankSelectOptions(ranks, selected) {
  const normalizedRanks = uniqueValues(ranks);
  const selectedRank = normalizeText(selected);
  if (selectedRank && !normalizedRanks.some((rank) => rank.toLowerCase() === selectedRank.toLowerCase())) {
    normalizedRanks.unshift(selectedRank);
  }
  const options = ['<option value=""></option>'];
  normalizedRanks.forEach((rank) => {
    options.push(`<option value="${rank}" ${rank === selectedRank ? 'selected' : ''}>${rank}</option>`);
  });
  return options.join('');
}

function expandTrainingListForStation(list, stationType) {
  if (typeof trainingHelpers !== 'undefined' && trainingHelpers && typeof trainingHelpers.expandTrainingList === 'function') {
    return trainingHelpers.expandTrainingList(list, stationType) || [];
  }
  return uniqueValues(list);
}

function getDefaultTrainingsForStation(stationType, options) {
  const opts = Array.isArray(options) ? options : [];
  const validNames = new Set(opts.map((opt) => normalizeText(opt)).filter(Boolean).map((name) => name.toLowerCase()));
  if (typeof trainingHelpers !== 'undefined' && trainingHelpers && typeof trainingHelpers.getTrainingDefaults === 'function') {
    const defaults = trainingHelpers.getTrainingDefaults(stationType) || [];
    return defaults.filter((name) => validNames.has(normalizeText(name).toLowerCase()));
  }
  const key = normalizeText(stationType).toLowerCase();
  const defaults = (typeof trainingDefaults !== 'undefined' && trainingDefaults && trainingDefaults[key]) || [];
  const arr = Array.isArray(defaults) ? defaults : [defaults];
  return arr
    .map((name) => normalizeText(name))
    .filter((name) => name && validNames.has(name.toLowerCase()));
}
const stationTemplate = () => ({
  name: '',
  type: 'fire',
  latlon: '',
  lat: '',
  lon: '',
  bays: 1,
  equipment_slots: 0,
  holding_cells: 0,
  bed_capacity: 0,
  equipment: [],
  units: [],
});

const unitTemplate = () => ({
  name: '',
  type: '',
  tag: '',
  priority: 1,
  equipment: [],
  patrol: false,
  personnel: [],
  personnel_add_count: 1,
});

const personTemplate = () => ({
  name: '',
  rank: '',
  training: [],
});

function createPersonForStation(stationType) {
  const trainingOptions = getTrainingOptions(stationType);
  const defaults = getDefaultTrainingsForStation(stationType, trainingOptions);
  return {
    name: '',
    rank: '',
    training: expandTrainingListForStation(defaults, stationType),
  };
}

const state = {
  stations: [stationTemplate()],
};

function clearStatus() {
  statusMessage.textContent = '';
  statusMessage.className = 'status';
  statusMessage.style.display = 'none';
}

function showStatus(message, variant = 'success') {
  statusMessage.textContent = message;
  statusMessage.className = `status ${variant}`;
  statusMessage.style.display = 'block';
}

function getEquipmentOptions(stationType) {
  const list = equipment?.[stationType] || [];
  return list.map((item) => item.name);
}

function getUnitOptions(stationType) {
  const classes = stationType === 'fire_rescue' ? ['fire', 'ambulance'] : [stationType];
  const classSet = new Set(classes.map((value) => String(value || '').toLowerCase()));
  return (Array.isArray(unitTypes) ? unitTypes : []).filter((u) => classSet.has(String(u.class || '').toLowerCase()));
}

function getUnitClassForType(stationType, unitType) {
  const desiredType = String(unitType || '').toLowerCase();
  if (!desiredType) return stationType;
  const options = getUnitOptions(stationType);
  const match = options.find((opt) => String(opt.type || '').toLowerCase() === desiredType);
  return String(match?.class || stationType);
}

function getTrainingOptions(stationType) {
  const list = typeof trainingHelpers !== 'undefined' && trainingHelpers && typeof trainingHelpers.getTrainingsForClass === 'function'
    ? trainingHelpers.getTrainingsForClass(stationType) || []
    : (trainingsByClass?.[stationType] || []);
  return list.map((t) => (typeof t === 'string' ? t : t.name)).filter(Boolean);
}

function ensureUnitDefaults(station) {
  const options = getUnitOptions(station.type);
  station.units.forEach((unit) => {
    if (!unit.type && options.length) {
      unit.type = options[0].type;
    }
    if (!Array.isArray(unit.personnel)) {
      unit.personnel = [];
    }
    if (!Number.isFinite(Number(unit.personnel_add_count))) {
      unit.personnel_add_count = 1;
    }
    if (unit.patrol === undefined) {
      unit.patrol = false;
    }
  });
}

function preserveFocusAndScroll(container, renderFn) {
  const active = document.activeElement;
  const focusKey = active?.dataset?.focusKey;
  const selectionStart = active?.selectionStart;
  const selectionEnd = active?.selectionEnd;
  const scrollTop = container.scrollTop;
  renderFn();
  container.scrollTop = scrollTop;
  if (focusKey) {
    const next = container.querySelector(`[data-focus-key="${focusKey}"]`);
    if (next) {
      next.focus();
      if (typeof selectionStart === 'number' && typeof next.setSelectionRange === 'function') {
        next.setSelectionRange(selectionStart, selectionEnd ?? selectionStart);
      }
    }
  }
}

function renderStationCard(station, index) {
  ensureUnitDefaults(station);
  const unitOptions = getUnitOptions(station.type);
  const trainingOptions = getTrainingOptions(station.type);
  const equipOptions = getEquipmentOptions(station.type);
  const departmentRanks = getDepartmentRankOptions();
  const unitSelectOptions = (selected) =>
    unitOptions
      .map((opt) => `<option value="${opt.type}" ${opt.type === selected ? 'selected' : ''}>${opt.type}</option>`)
      .join('');

  return `
    <div class="station-card" data-station-index="${index}">
      <div class="station-header">
        <h3>Station ${index + 1}</h3>
        <button class="ghost" data-action="remove-station">Remove</button>
      </div>
      <div class="grid">
        <label>
          Name
          <input type="text" data-field="name" data-focus-key="station-${index}-name" value="${station.name}" placeholder="Station name" />
        </label>
        <label>
          Type
          <select data-field="type" data-focus-key="station-${index}-type">
            <option value="fire" ${station.type === 'fire' ? 'selected' : ''}>Fire</option>
            <option value="fire_rescue" ${station.type === 'fire_rescue' ? 'selected' : ''}>Fire Rescue</option>
            <option value="police" ${station.type === 'police' ? 'selected' : ''}>Police</option>
            <option value="ambulance" ${station.type === 'ambulance' ? 'selected' : ''}>Ambulance</option>
            <option value="sar" ${station.type === 'sar' ? 'selected' : ''}>SAR</option>
            <option value="hospital" ${station.type === 'hospital' ? 'selected' : ''}>Hospital</option>
            <option value="jail" ${station.type === 'jail' ? 'selected' : ''}>Jail</option>
          </select>
        </label>
        <label>
          Latitude, Longitude (decimal)
          <input type="text" data-field="latlon" data-focus-key="station-${index}-latlon" value="${getLatLonDisplayValue(station)}" placeholder="43.72166707800811, -79.62026053315279" />
        </label>
        <label>
          Bays
          <input type="number" min="0" data-field="bays" data-focus-key="station-${index}-bays" value="${station.bays}" />
        </label>
        <label>
          Equipment Slots
          <input type="number" min="0" data-field="equipment_slots" data-focus-key="station-${index}-equipment-slots" value="${station.equipment_slots}" />
        </label>
        <label>
          Holding Cells
          <input type="number" min="0" data-field="holding_cells" data-focus-key="station-${index}-holding-cells" value="${station.holding_cells}" />
        </label>
        <label>
          Hospital Beds
          <input type="number" min="0" data-field="bed_capacity" data-focus-key="station-${index}-bed-capacity" value="${station.bed_capacity}" />
        </label>
      </div>

      <div class="section-title">Station Equipment</div>
      <div class="pill-list">
        ${equipOptions.length ? equipOptions.map((name) => `
          <label class="pill">
            <input type="checkbox" class="equipment-checkbox" data-focus-key="station-${index}-equipment-${name}" data-equipment-name="${name}" ${station.equipment.includes(name) ? 'checked' : ''} />
            ${name}
          </label>`).join('') : '<em>No equipment defined for this class.</em>'}
      </div>

      <div class="section-title">Units</div>
      <div>
        ${station.units.map((unit, unitIndex) => `
          <div class="unit-card" data-unit-index="${unitIndex}">
            <div class="inline-actions" style="justify-content: space-between;">
              <strong>Unit ${unitIndex + 1}</strong>
              <button class="ghost" data-action="remove-unit">Remove</button>
            </div>
            <div class="grid">
              <label>
                Name
                <input type="text" data-field="unit-name" data-focus-key="station-${index}-unit-${unitIndex}-name" value="${unit.name}" placeholder="Engine 1" />
              </label>
              <label>
                Type
                <select data-field="unit-type" data-focus-key="station-${index}-unit-${unitIndex}-type">
                  ${unitSelectOptions(unit.type)}
                </select>
              </label>
              <label>
                Tag
                <input type="text" data-field="unit-tag" data-focus-key="station-${index}-unit-${unitIndex}-tag" value="${unit.tag}" placeholder="E1" />
              </label>
              <label>
                Priority
                <input type="number" min="1" max="5" data-field="unit-priority" data-focus-key="station-${index}-unit-${unitIndex}-priority" value="${unit.priority}" />
              </label>
              <label>
                Patrol
                <input type="checkbox" data-field="unit-patrol" data-focus-key="station-${index}-unit-${unitIndex}-patrol" ${unit.patrol ? 'checked' : ''} />
              </label>
            </div>
            <div class="section-title">Unit Equipment</div>
            <div class="pill-list">
              ${equipOptions.length ? equipOptions.map((name) => `
                <label class="pill">
                  <input type="checkbox" class="unit-equipment-checkbox" data-focus-key="station-${index}-unit-${unitIndex}-equipment-${name}" data-equipment-name="${name}" ${unit.equipment.includes(name) ? 'checked' : ''} />
                  ${name}
                </label>`).join('') : '<em>No equipment defined for this class.</em>'}
            </div>
            <div class="section-title">Unit Personnel</div>
            <div>
              ${unit.personnel.map((person, personIndex) => `
                <div class="person-card" data-person-index="${personIndex}">
                  <div class="inline-actions" style="justify-content: space-between;">
                    <strong>Person ${personIndex + 1}</strong>
                    <button class="ghost" data-action="remove-unit-person">Remove</button>
                  </div>
                  <div class="grid">
                    <label>
                      Name
                      <input type="text" data-field="person-name" data-focus-key="station-${index}-unit-${unitIndex}-person-${personIndex}-name" value="${person.name}" placeholder="Alex Rivera" />
                    </label>
                    <label>
                      Rank
                      ${departmentRanks.length ? `
                        <select data-field="person-rank" data-focus-key="station-${index}-unit-${unitIndex}-person-${personIndex}-rank">
                          ${buildRankSelectOptions(departmentRanks, person.rank)}
                        </select>
                      ` : `
                        <input type="text" data-field="person-rank" data-focus-key="station-${index}-unit-${unitIndex}-person-${personIndex}-rank" value="${person.rank}" placeholder="Captain" />
                      `}
                    </label>
                  </div>
                  <div class="section-title">Training</div>
                  <div class="pill-list">
                    ${trainingOptions.length ? trainingOptions.map((name) => `
                      <label class="pill">
                        <input type="checkbox" class="training-checkbox" data-focus-key="station-${index}-unit-${unitIndex}-person-${personIndex}-training-${name}" data-training-name="${name}" ${person.training.includes(name) ? 'checked' : ''} />
                        ${name}
                      </label>`).join('') : '<em>No training list available.</em>'}
                  </div>
                </div>
              `).join('')}
            </div>
            <div class="inline-actions">
              <label>
                Add Count
                <input type="number" min="1" max="50" data-field="unit-personnel-add-count" data-focus-key="station-${index}-unit-${unitIndex}-personnel-add-count" value="${unit.personnel_add_count || 1}" />
              </label>
              <button class="secondary" data-action="add-unit-person">Add Personnel</button>
            </div>
          </div>
        `).join('')}
      </div>
      <div class="inline-actions">
        <button class="secondary" data-action="add-unit">Add Unit</button>
      </div>

    </div>
  `;
}

function render() {
  preserveFocusAndScroll(stationListEl, () => {
    stationListEl.innerHTML = state.stations.map(renderStationCard).join('');
  });
}

function parseNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseLatLon(value) {
  const raw = normalizeText(value);
  if (!raw) return null;
  const parts = raw.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function getLatLonDisplayValue(station) {
  if (normalizeText(station.latlon)) return station.latlon;
  if (station.lat !== '' && station.lon !== '') {
    return `${station.lat}, ${station.lon}`;
  }
  return '';
}

function parseCount(value, fallback = 1, max = 50) {
  const num = Math.floor(Number(value));
  if (!Number.isFinite(num)) return fallback;
  return Math.max(1, Math.min(max, num));
}

stationListEl.addEventListener('click', async (event) => {
  const stationCard = event.target.closest('[data-station-index]');
  if (!stationCard) return;
  const stationIndex = Number(stationCard.dataset.stationIndex);
  const station = state.stations[stationIndex];
  if (!station) return;

  const action = event.target.dataset.action;
  if (!action) return;
  clearStatus();

  if (action === 'remove-station') {
    state.stations.splice(stationIndex, 1);
  }
  if (action === 'add-unit') {
    station.units.push(unitTemplate());
  }
  if (action === 'remove-unit') {
    const unitCard = event.target.closest('[data-unit-index]');
    if (unitCard) {
      const unitIndex = Number(unitCard.dataset.unitIndex);
      station.units.splice(unitIndex, 1);
    }
  }
  if (action === 'add-unit-person') {
    const unitCard = event.target.closest('[data-unit-index]');
    if (unitCard) {
      const unitIndex = Number(unitCard.dataset.unitIndex);
      const unit = station.units[unitIndex];
      if (!unit) return;
      const countInput = unitCard.querySelector('[data-field="unit-personnel-add-count"]');
      const count = parseCount(countInput?.value, unit.personnel_add_count || 1);
      unit.personnel_add_count = count;
      const people = Array.from({ length: count }, () => createPersonForStation(station.type));
      const names = await Promise.all(people.map(() => fetchRandomPersonName()));
      names.forEach((name, idx) => {
        if (name) people[idx].name = name;
      });
      if (!Array.isArray(unit.personnel)) unit.personnel = [];
      unit.personnel.push(...people);
    }
  }
  if (action === 'remove-unit-person') {
    const unitCard = event.target.closest('[data-unit-index]');
    const personCard = event.target.closest('[data-person-index]');
    if (unitCard && personCard) {
      const unitIndex = Number(unitCard.dataset.unitIndex);
      const personIndex = Number(personCard.dataset.personIndex);
      const unit = station.units[unitIndex];
      if (unit && Array.isArray(unit.personnel)) {
        unit.personnel.splice(personIndex, 1);
      }
    }
  }

  render();
});

stationListEl.addEventListener('change', (event) => {
  const stationCard = event.target.closest('[data-station-index]');
  if (!stationCard) return;
  const stationIndex = Number(stationCard.dataset.stationIndex);
  const station = state.stations[stationIndex];
  if (!station) return;
  clearStatus();

  const field = event.target.dataset.field;
  if (field && !event.target.closest('[data-unit-index]') && !event.target.closest('[data-person-index]')) {
    if (field === 'type') {
      station.type = event.target.value;
      station.equipment = [];
      station.units = [];
      render();
      return;
    } else if (field === 'latlon') {
      station.latlon = event.target.value;
      const parsed = parseLatLon(event.target.value);
      if (parsed) {
        station.lat = parsed.lat;
        station.lon = parsed.lon;
      } else {
        station.lat = '';
        station.lon = '';
      }
      return;
    } else if (['bays', 'equipment_slots', 'holding_cells', 'bed_capacity'].includes(field)) {
      station[field] = parseNumber(event.target.value, 0);
    } else {
      station[field] = event.target.value;
    }
    return;
  }

  if (event.target.classList.contains('equipment-checkbox')) {
    const name = event.target.dataset.equipmentName;
    if (!name) return;
    if (event.target.checked) {
      if (!station.equipment.includes(name)) station.equipment.push(name);
    } else {
      station.equipment = station.equipment.filter((item) => item !== name);
    }
    return;
  }

  const unitCard = event.target.closest('[data-unit-index]');
  if (unitCard) {
    const unitIndex = Number(unitCard.dataset.unitIndex);
    const unit = station.units[unitIndex];
    if (!unit) return;
    if (field === 'unit-personnel-add-count') {
      unit.personnel_add_count = parseCount(event.target.value, unit.personnel_add_count || 1);
      return;
    }
    if (event.target.classList.contains('unit-equipment-checkbox')) {
      const name = event.target.dataset.equipmentName;
      if (!name) return;
      if (event.target.checked) {
        if (!unit.equipment.includes(name)) unit.equipment.push(name);
      } else {
        unit.equipment = unit.equipment.filter((item) => item !== name);
      }
      return;
    }
    if (field === 'unit-name') unit.name = event.target.value;
    if (field === 'unit-type') unit.type = event.target.value;
    if (field === 'unit-tag') unit.tag = event.target.value;
    if (field === 'unit-priority') unit.priority = parseNumber(event.target.value, 1);
    if (field === 'unit-patrol') unit.patrol = event.target.checked;

    const personCard = event.target.closest('[data-person-index]');
    if (personCard) {
      const personIndex = Number(personCard.dataset.personIndex);
      const person = unit.personnel?.[personIndex];
      if (!person) return;
      if (event.target.classList.contains('training-checkbox')) {
        const name = event.target.dataset.trainingName;
        if (!name) return;
        if (event.target.checked) {
          if (!person.training.includes(name)) person.training.push(name);
        } else {
          person.training = person.training.filter((item) => item !== name);
        }
        return;
      }
      if (field === 'person-name') person.name = event.target.value;
      if (field === 'person-rank') person.rank = event.target.value;
    }
  }
});

addStationBtn.addEventListener('click', () => {
  state.stations.push(stationTemplate());
  clearStatus();
  render();
});

if (deptRanksInput) {
  deptRanksInput.addEventListener('input', () => {
    clearStatus();
    render();
  });
}

resetBtn.addEventListener('click', () => {
  state.stations = [stationTemplate()];
  deptNameInput.value = '';
  if (deptRanksInput) deptRanksInput.value = '';
  clearStatus();
  render();
});

submitBtn.addEventListener('click', async () => {
  clearStatus();
  const department = deptNameInput.value.trim();
  const ranksInput = deptRanksInput ? deptRanksInput.value : '';
  if (!department) {
    showStatus('Department name is required.', 'error');
    return;
  }

  const ranks = ranksInput
    .split(',')
    .map((rank) => rank.trim())
    .filter(Boolean);

  const stationsPayload = state.stations.map((station) => ({
    name: station.name.trim(),
    type: station.type,
    lat: Number(station.lat),
    lon: Number(station.lon),
    bays: parseNumber(station.bays, 0),
    equipment_slots: parseNumber(station.equipment_slots, 0),
    holding_cells: parseNumber(station.holding_cells, 0),
    bed_capacity: parseNumber(station.bed_capacity, 0),
    equipment: station.equipment.slice(),
    units: station.units.map((unit) => ({
      name: unit.name.trim(),
      type: unit.type,
      class: getUnitClassForType(station.type, unit.type),
      tag: unit.tag.trim(),
      priority: parseNumber(unit.priority, 1),
      equipment: unit.equipment.slice(),
      patrol: Boolean(unit.patrol),
      personnel: (Array.isArray(unit.personnel) ? unit.personnel : []).map((person) => ({
        name: person.name.trim(),
        rank: person.rank.trim(),
        training: person.training.slice(),
      })),
    })),
  }));

  try {
    const response = await fetch('/api/departments/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ department, stations: stationsPayload }),
    });
    const data = await response.json();
    if (!response.ok) {
      showStatus(data.error || 'Failed to create department.', 'error');
      return;
    }
    if (ranks.length) {
      const rankResponse = await fetch(`/api/departments/${encodeURIComponent(department)}/ranks`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ranks }),
      });
      if (!rankResponse.ok) {
        const rankData = await rankResponse.json().catch(() => ({}));
        showStatus(rankData.error || 'Department created, but ranks failed to save.', 'error');
        return;
      }
    }
    showStatus(`Created ${data.stations.length} stations for ${data.department}.`, 'success');
  } catch (err) {
    showStatus(err.message || 'Failed to create department.', 'error');
  }
});

render();
