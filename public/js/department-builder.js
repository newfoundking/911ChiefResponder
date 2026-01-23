const stationListEl = document.getElementById('stationList');
const addStationBtn = document.getElementById('addStation');
const submitBtn = document.getElementById('submitDepartment');
const resetBtn = document.getElementById('resetForm');
const deptNameInput = document.getElementById('departmentName');
const deptRanksInput = document.getElementById('departmentRanks');
const statusMessage = document.getElementById('statusMessage');

const stationTemplate = () => ({
  name: '',
  type: 'fire',
  lat: '',
  lon: '',
  bays: 1,
  equipment_slots: 0,
  holding_cells: 0,
  bed_capacity: 0,
  equipment: [],
  units: [],
  personnel: [],
});

const unitTemplate = () => ({
  name: '',
  type: '',
  tag: '',
  priority: 1,
  equipment: [],
});

const personTemplate = () => ({
  name: '',
  rank: '',
  training: [],
  assigned_unit: '',
});

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
  return (Array.isArray(unitTypes) ? unitTypes : []).filter((u) => u.class === stationType);
}

function getTrainingOptions(stationType) {
  return (trainingsByClass?.[stationType] || []).map((t) => (typeof t === 'string' ? t : t.name));
}

function ensureUnitDefaults(station) {
  const options = getUnitOptions(station.type);
  station.units.forEach((unit) => {
    if (!unit.type && options.length) {
      unit.type = options[0].type;
    }
  });
}

function renderStationCard(station, index) {
  ensureUnitDefaults(station);
  const unitOptions = getUnitOptions(station.type);
  const trainingOptions = getTrainingOptions(station.type);
  const equipOptions = getEquipmentOptions(station.type);
  const unitSelectOptions = (selected) =>
    unitOptions
      .map((opt) => `<option value="${opt.type}" ${opt.type === selected ? 'selected' : ''}>${opt.type}</option>`)
      .join('');
  const unitAssignmentOptions = (selected) => {
    const base = [`<option value="" ${selected === '' ? 'selected' : ''}>Unassigned</option>`];
    station.units.forEach((unit, idx) => {
      base.push(`<option value="${idx}" ${String(selected) === String(idx) ? 'selected' : ''}>${unit.name || `Unit ${idx + 1}`}</option>`);
    });
    return base.join('');
  };

  return `
    <div class="station-card" data-station-index="${index}">
      <div class="station-header">
        <h3>Station ${index + 1}</h3>
        <button class="ghost" data-action="remove-station">Remove</button>
      </div>
      <div class="grid">
        <label>
          Name
          <input type="text" data-field="name" value="${station.name}" placeholder="Station name" />
        </label>
        <label>
          Type
          <select data-field="type">
            <option value="fire" ${station.type === 'fire' ? 'selected' : ''}>Fire</option>
            <option value="police" ${station.type === 'police' ? 'selected' : ''}>Police</option>
            <option value="ambulance" ${station.type === 'ambulance' ? 'selected' : ''}>Ambulance</option>
            <option value="sar" ${station.type === 'sar' ? 'selected' : ''}>SAR</option>
            <option value="hospital" ${station.type === 'hospital' ? 'selected' : ''}>Hospital</option>
            <option value="jail" ${station.type === 'jail' ? 'selected' : ''}>Jail</option>
          </select>
        </label>
        <label>
          Latitude (decimal)
          <input type="number" step="any" data-field="lat" value="${station.lat}" placeholder="40.7128" />
        </label>
        <label>
          Longitude (decimal)
          <input type="number" step="any" data-field="lon" value="${station.lon}" placeholder="-74.0060" />
        </label>
        <label>
          Bays
          <input type="number" min="0" data-field="bays" value="${station.bays}" />
        </label>
        <label>
          Equipment Slots
          <input type="number" min="0" data-field="equipment_slots" value="${station.equipment_slots}" />
        </label>
        <label>
          Holding Cells
          <input type="number" min="0" data-field="holding_cells" value="${station.holding_cells}" />
        </label>
        <label>
          Hospital Beds
          <input type="number" min="0" data-field="bed_capacity" value="${station.bed_capacity}" />
        </label>
      </div>

      <div class="section-title">Station Equipment</div>
      <div class="pill-list">
        ${equipOptions.length ? equipOptions.map((name) => `
          <label class="pill">
            <input type="checkbox" class="equipment-checkbox" data-equipment-name="${name}" ${station.equipment.includes(name) ? 'checked' : ''} />
            ${name}
          </label>`).join('') : '<em>No equipment defined for this class.</em>'}
      </div>

      <div class="section-title">Units</div>
      <div class="inline-actions">
        <button class="secondary" data-action="add-unit">Add Unit</button>
      </div>
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
                <input type="text" data-field="unit-name" value="${unit.name}" placeholder="Engine 1" />
              </label>
              <label>
                Type
                <select data-field="unit-type">
                  ${unitSelectOptions(unit.type)}
                </select>
              </label>
              <label>
                Tag
                <input type="text" data-field="unit-tag" value="${unit.tag}" placeholder="E1" />
              </label>
              <label>
                Priority
                <input type="number" min="1" max="5" data-field="unit-priority" value="${unit.priority}" />
              </label>
            </div>
            <div class="section-title">Unit Equipment</div>
            <div class="pill-list">
              ${equipOptions.length ? equipOptions.map((name) => `
                <label class="pill">
                  <input type="checkbox" class="unit-equipment-checkbox" data-equipment-name="${name}" ${unit.equipment.includes(name) ? 'checked' : ''} />
                  ${name}
                </label>`).join('') : '<em>No equipment defined for this class.</em>'}
            </div>
          </div>
        `).join('')}
      </div>

      <div class="section-title">Personnel</div>
      <div class="inline-actions">
        <button class="secondary" data-action="add-person">Add Personnel</button>
      </div>
      <div>
        ${station.personnel.map((person, personIndex) => `
          <div class="person-card" data-person-index="${personIndex}">
            <div class="inline-actions" style="justify-content: space-between;">
              <strong>Person ${personIndex + 1}</strong>
              <button class="ghost" data-action="remove-person">Remove</button>
            </div>
            <div class="grid">
              <label>
                Name
                <input type="text" data-field="person-name" value="${person.name}" placeholder="Alex Rivera" />
              </label>
              <label>
                Rank
                <input type="text" data-field="person-rank" value="${person.rank}" placeholder="Captain" />
              </label>
              <label>
                Assigned Unit
                <select data-field="person-assigned-unit">
                  ${unitAssignmentOptions(person.assigned_unit)}
                </select>
              </label>
            </div>
            <div class="section-title">Training</div>
            <div class="pill-list">
              ${trainingOptions.length ? trainingOptions.map((name) => `
                <label class="pill">
                  <input type="checkbox" class="training-checkbox" data-training-name="${name}" ${person.training.includes(name) ? 'checked' : ''} />
                  ${name}
                </label>`).join('') : '<em>No training list available.</em>'}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function render() {
  stationListEl.innerHTML = state.stations.map(renderStationCard).join('');
}

function parseNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

stationListEl.addEventListener('click', (event) => {
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
      station.personnel.forEach((person) => {
        if (person.assigned_unit !== '' && Number(person.assigned_unit) >= station.units.length) {
          person.assigned_unit = '';
        }
      });
    }
  }
  if (action === 'add-person') {
    station.personnel.push(personTemplate());
  }
  if (action === 'remove-person') {
    const personCard = event.target.closest('[data-person-index]');
    if (personCard) {
      const personIndex = Number(personCard.dataset.personIndex);
      station.personnel.splice(personIndex, 1);
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
      station.personnel = [];
    } else if (['bays', 'equipment_slots', 'holding_cells', 'bed_capacity'].includes(field)) {
      station[field] = parseNumber(event.target.value, 0);
    } else {
      station[field] = event.target.value;
    }
    render();
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
    render();
    return;
  }

  const personCard = event.target.closest('[data-person-index]');
  if (personCard) {
    const personIndex = Number(personCard.dataset.personIndex);
    const person = station.personnel[personIndex];
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
    if (field === 'person-assigned-unit') person.assigned_unit = event.target.value;
  }
});

addStationBtn.addEventListener('click', () => {
  state.stations.push(stationTemplate());
  clearStatus();
  render();
});

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
      class: station.type,
      tag: unit.tag.trim(),
      priority: parseNumber(unit.priority, 1),
      equipment: unit.equipment.slice(),
    })),
    personnel: station.personnel.map((person) => ({
      name: person.name.trim(),
      rank: person.rank.trim(),
      training: person.training.slice(),
      assigned_unit: person.assigned_unit,
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
