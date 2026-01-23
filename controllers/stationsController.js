const db = require('../db');
const { findEquipmentCostByName, requireFunds, adjustBalance, getBalance } = require('../wallet');
const { getSeatInfo } = require('../utils');
const unitTypes = require('../unitTypes');
const { getFacilityOccupancy } = require('../services/missions');
let trainingModule = {};
try { trainingModule = require('../trainings'); } catch { trainingModule = {}; }
const trainingsByClass = trainingModule.trainingsByClass || {};
const collapseTrainingList = typeof trainingModule.collapseTrainingList === 'function'
  ? trainingModule.collapseTrainingList
  : (list) => {
      const seen = new Set();
      const result = [];
      (Array.isArray(list) ? list : []).forEach((value) => {
        const raw = typeof value === 'string' ? value : value?.name;
        const trimmed = String(raw || '').trim();
        if (!trimmed) return;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        result.push(trimmed);
      });
      return result;
    };

function findUnitDefinition(unitClass, unitType) {
  const cls = String(unitClass || '').toLowerCase();
  const type = String(unitType || '').toLowerCase();
  return unitTypes.find(
    (u) => String(u.class || '').toLowerCase() === cls && String(u.type || '').toLowerCase() === type
  );
}

function findUnitCostByType(unitClass, unitType) {
  const def = findUnitDefinition(unitClass, unitType);
  return Number(def?.cost) || 0;
}

function findTrainingCostByName(name) {
  const key = String(name || '').trim().toLowerCase();
  if (!key) return 0;
  const lists = Object.values(trainingsByClass || {});
  for (const arr of lists || []) {
    for (const item of arr || []) {
      if (typeof item === 'string' && item.trim().toLowerCase() === key) return 0;
      if (item?.name && String(item.name).trim().toLowerCase() === key) return Number(item.cost) || 0;
    }
  }
  return 0;
}

function normalizeTrainingList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => (typeof t === 'string' ? t : t?.name))
    .filter((t) => typeof t === 'string' && t.trim().length)
    .map((t) => t.trim());
}

function normalizeRank(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str.length ? str : null;
}

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

const EQUIPMENT_SLOT_COST = 1000;
const BAY_BASE_COST = 5000;
const BAY_EXP_MULTIPLIER = 2.0;
const HOLDING_CELL_BASE_COST = 2500;
const HOLDING_CELL_EXP_MULTIPLIER = 1.5;
const HOSPITAL_BED_BASE_COST = 4000;
const HOSPITAL_BED_EXP_MULTIPLIER = 1.75;
const STATION_BUILD_COST = 50000;
const STATION_CLASS_MULTIPLIERS = {
  fire_rescue: 1.5,
};
const BASE_PERSON_COST = 100;

function priceBays(count, isExpansion) {
  const base = BAY_BASE_COST * count;
  return isExpansion ? Math.floor(base * BAY_EXP_MULTIPLIER) : base;
}

function priceHoldingCells(count, isExpansion) {
  const base = HOLDING_CELL_BASE_COST * count;
  return isExpansion ? Math.floor(base * HOLDING_CELL_EXP_MULTIPLIER) : base;
}

function priceHospitalBeds(count, isExpansion) {
  const base = HOSPITAL_BED_BASE_COST * count;
  return isExpansion ? Math.floor(base * HOSPITAL_BED_EXP_MULTIPLIER) : base;
}

async function hydrateFacilityFields(row) {
  let equipment;
  try { equipment = JSON.parse(row.equipment || '[]'); }
  catch { equipment = []; }

  const station = { ...row, equipment };

  if (row.type === 'hospital') {
    const capacity = Math.max(0, Number(row.bed_capacity || 0));
    if (capacity > 0) {
      const occ = await getFacilityOccupancy(row.id, 'patient');
      const total = Math.max(0, Number(occ?.count || 0));
      const active = Math.min(total, capacity);
      const waiting = Math.max(0, total - capacity);
      station.occupied_beds = active;
      station.total_patient_transports = total;
      station.staged_patients = waiting;
      station.next_free_bed_at = occ?.nextFree || null;
    } else {
      station.occupied_beds = 0;
      station.total_patient_transports = 0;
      station.staged_patients = 0;
      station.next_free_bed_at = null;
    }
  } else if (row.type === 'jail' || (row.type === 'police' && Number(row.holding_cells) > 0)) {
    const capacity = Math.max(0, Number(row.holding_cells || 0));
    if (capacity > 0) {
      const occ = await getFacilityOccupancy(row.id, 'prisoner');
      const total = Math.max(0, Number(occ?.count || 0));
      const active = Math.min(total, capacity);
      const waiting = Math.max(0, total - capacity);
      station.occupied_cells = active;
      station.total_prisoner_transports = total;
      station.staged_prisoners = waiting;
      station.next_free_cell_at = occ?.nextFree || null;
    } else {
      station.occupied_cells = 0;
      station.total_prisoner_transports = 0;
      station.staged_prisoners = 0;
      station.next_free_cell_at = null;
    }
  } else {
    station.occupied_beds = Number(row.occupied_beds || 0);
    station.occupied_cells = Number(row.occupied_cells || 0);
  }

  return station;
}

// GET /api/stations
async function getStations(req, res) {
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM stations', (err, result) => (err ? reject(err) : resolve(result || [])));
    });
    const enriched = await Promise.all(rows.map(hydrateFacilityFields));
    res.json(enriched);
  } catch (e) {
    res.status(500).send('Error reading stations');
  }
}

// GET /api/stations/:id
async function getStation(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM stations WHERE id=?', [id], (err, result) => (err ? reject(err) : resolve(result)));
    });
    if (!row) return res.status(404).json({ error: 'Station not found' });
    const hydrated = await hydrateFacilityFields(row);
    res.json(hydrated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// POST /api/stations
async function createStation(req, res) {
  try {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const type = String(body.type || '').toLowerCase();
    const lat = Number(body.lat);
    const lon = Number(body.lon);
    const departmentRaw = body.department;
    const department = departmentRaw != null && String(departmentRaw).trim().length
      ? String(departmentRaw).trim()
      : null;

    if (!name || !type || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({ error: 'name, type, lat and lon are required' });
    }

    const allowedTypes = new Set(['fire', 'police', 'ambulance', 'sar', 'hospital', 'jail', 'fire_rescue']);
    if (!allowedTypes.has(type)) {
      return res.status(400).json({ error: 'Unsupported station type' });
    }

    let bays = Math.max(0, Number(body.bays ?? body.bay_count ?? 0));
    let equipmentSlots = Math.max(0, Number(body.equipment_slots ?? 0));
    let holdingCells = Math.max(0, Number(body.holding_cells ?? 0));
    let bedCapacity = Math.max(0, Number(body.bed_capacity ?? 0));

    if (!['police', 'jail'].includes(type)) holdingCells = 0;
    if (type !== 'hospital') bedCapacity = 0;

    const stationEquipment = Array.isArray(body.equipment)
      ? body.equipment
          .map((item) => String(item || '').trim())
          .filter((item) => item.length)
      : [];

    const unitsInput = Array.isArray(body.units) ? body.units : [];
    const personnelInput = Array.isArray(body.personnel) ? body.personnel : [];

    if (equipmentSlots > 0 && stationEquipment.length > equipmentSlots) {
      return res.status(400).json({ error: 'Not enough equipment slots for selected equipment' });
    }
    if (equipmentSlots === 0 && stationEquipment.length > 0) {
      return res.status(400).json({ error: 'Equipment slots must be purchased for stored equipment' });
    }

    const unitsNormalized = [];
    const unitPersonnelBuckets = [];
    let unitCostTotal = 0;
    let unitEquipmentCostTotal = 0;

    for (let idx = 0; idx < unitsInput.length; idx += 1) {
      const unitRaw = unitsInput[idx];
      const unitName = String(unitRaw?.name || '').trim();
      const unitType = String(unitRaw?.type || '').trim();
      const unitClass = String(unitRaw?.class || type).toLowerCase();
      const tag = unitRaw?.tag != null ? String(unitRaw.tag).trim() : null;
      let priority = Number(unitRaw?.priority ?? 1);
      if (!Number.isFinite(priority)) priority = 1;
      priority = Math.min(5, Math.max(1, priority));

      if (!unitName || !unitType) {
        return res.status(400).json({ error: `Unit #${idx + 1} is missing a name or type` });
      }

      const unitDef = findUnitDefinition(unitClass, unitType);
      if (!unitDef) {
        return res.status(400).json({ error: `Unit type ${unitType} (${unitClass}) is not allowed` });
      }

      const seatInfo = getSeatInfo(unitDef.class, unitDef.type, unitRaw?.seats ?? unitRaw?.seat_override ?? unitRaw?.seat_capacity);
      const seatCapacity = Number(seatInfo.seatCapacity || 0);

      const equipmentList = Array.isArray(unitRaw?.equipment)
        ? unitRaw.equipment
            .map((item) => String(item || '').trim())
            .filter((item) => item.length)
        : [];
      if (Number(unitDef.equipmentSlots || 0) && equipmentList.length > Number(unitDef.equipmentSlots)) {
        return res.status(400).json({
          error: `Unit ${unitName} exceeds equipment slots (${equipmentList.length}/${unitDef.equipmentSlots})`,
        });
      }
      if (!Number(unitDef.equipmentSlots || 0) && equipmentList.length) {
        return res.status(400).json({ error: `Unit ${unitName} cannot carry equipment` });
      }

      unitCostTotal += Number(unitDef.cost) || 0;
      equipmentList.forEach((item) => {
        unitEquipmentCostTotal += findEquipmentCostByName(item) || 0;
      });

      const normalized = {
        name: unitName,
        type: unitDef.type,
        class: unitDef.class,
        tag,
        priority,
        equipment: equipmentList,
        seat_override: seatInfo.seatOverride,
        seat_capacity: seatCapacity,
        default_capacity: seatInfo.defaultCapacity,
      };
      unitsNormalized.push(normalized);
      unitPersonnelBuckets.push([]);

      if (Array.isArray(unitRaw?.personnel)) {
        for (const personRaw of unitRaw.personnel) {
          const pname = String(personRaw?.name || '').trim();
          if (!pname) return;
          const trainingRaw = normalizeTrainingList(personRaw?.training);
          const training = collapseTrainingList(trainingRaw, type);
          const rank = normalizeRank(personRaw?.rank);
          const trainingCost = training.reduce((sum, t) => sum + (findTrainingCostByName(t) || 0), 0);
          personnelCostTotal += BASE_PERSON_COST + trainingCost;
          if (seatCapacity && unitPersonnelBuckets[idx].length >= seatCapacity) {
            return res.status(400).json({ error: `Unit ${unitName} exceeds seat capacity (${seatCapacity})` });
          }
          unitPersonnelBuckets[idx].push({ name: pname, rank, training });
        }
      }
    }

    if (bays < unitsNormalized.length) {
      return res.status(400).json({ error: 'Not enough bays for the selected units', required_bays: unitsNormalized.length });
    }

    const stationPersonnel = [];
    let personnelCostTotal = 0;

    for (let idx = 0; idx < personnelInput.length; idx += 1) {
      const personRaw = personnelInput[idx];
      const pname = String(personRaw?.name || '').trim();
      if (!pname) continue;
      const trainingRaw = normalizeTrainingList(personRaw?.training);
      const training = collapseTrainingList(trainingRaw, type);
      const rank = normalizeRank(personRaw?.rank);
      const entry = { name: pname, rank, training };
      const trainingCost = training.reduce((sum, t) => sum + (findTrainingCostByName(t) || 0), 0);
      personnelCostTotal += BASE_PERSON_COST + trainingCost;

      const rawAssignment = personRaw?.assigned_unit;
      const hasAssignment = rawAssignment !== undefined && rawAssignment !== null && String(rawAssignment).trim() !== '';
      if (hasAssignment) {
        const assignedIndex = Number(rawAssignment);
        if (!Number.isInteger(assignedIndex) || assignedIndex < 0 || assignedIndex >= unitPersonnelBuckets.length) {
          return res.status(400).json({ error: `Personnel #${idx + 1} has an invalid unit assignment` });
        }
        const unitInfo = unitsNormalized[assignedIndex];
        const capacity = Number(unitInfo?.seat_capacity || 0);
        if (capacity && unitPersonnelBuckets[assignedIndex].length >= capacity) {
          return res.status(400).json({ error: `Unit ${unitInfo?.name || assignedIndex + 1} exceeds seat capacity (${capacity})` });
        }
        unitPersonnelBuckets[assignedIndex].push(entry);
      } else {
        stationPersonnel.push(entry);
      }
    }

    const stationEquipmentCostTotal = stationEquipment.reduce(
      (sum, item) => sum + (findEquipmentCostByName(item) || 0),
      0
    );

    const baseStationCost =
      STATION_BUILD_COST +
      priceBays(bays, false) +
      (equipmentSlots * EQUIPMENT_SLOT_COST) +
      (holdingCells > 0 ? priceHoldingCells(holdingCells, false) : 0);
    const multiplier = Number(STATION_CLASS_MULTIPLIERS[type] || 1);
    const stationCost = Math.round(baseStationCost * multiplier);

    const totalCost = stationCost + unitCostTotal + unitEquipmentCostTotal + stationEquipmentCostTotal + personnelCostTotal;

    const funds = await requireFunds(totalCost);
    if (!funds.ok) {
      return res.status(409).json({ error: 'Insufficient funds', balance: funds.balance, needed: totalCost });
    }

    await runAsync('BEGIN IMMEDIATE TRANSACTION');
    try {
      const stationRow = await runAsync(
        `INSERT INTO stations (name, type, lat, lon, department, bay_count, equipment_slots, holding_cells, bed_capacity, equipment)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [
          name,
          type,
          lat,
          lon,
          department,
          bays,
          equipmentSlots,
          holdingCells,
          bedCapacity,
          JSON.stringify(stationEquipment),
        ]
      );
      const stationId = stationRow.lastID;

      const createdUnits = [];
      const createdPersonnel = [];

      for (let i = 0; i < unitsNormalized.length; i += 1) {
        const unit = unitsNormalized[i];
        const insertUnit = await runAsync(
          `INSERT INTO units (station_id, class, type, name, tag, priority, status, equipment, seat_override)
           VALUES (?, ?, ?, ?, ?, ?, 'available', ?, ?)` ,
          [
            stationId,
            unit.class,
            unit.type,
            unit.name,
            unit.tag,
            unit.priority,
            JSON.stringify(unit.equipment),
            unit.seat_override ?? null,
          ]
        );
        const unitId = insertUnit.lastID;
        createdUnits.push({ id: unitId, ...unit });

        const assigned = unitPersonnelBuckets[i];
        for (const person of assigned) {
          const insertPerson = await runAsync(
            `INSERT INTO personnel (name, rank, station_id, unit_id, training) VALUES (?, ?, ?, ?, ?)` ,
            [person.name, person.rank ?? null, stationId, unitId, JSON.stringify(person.training)]
          );
          createdPersonnel.push({ id: insertPerson.lastID, ...person, unit_id: unitId });
        }
      }

      for (const person of stationPersonnel) {
        const insertPerson = await runAsync(
          `INSERT INTO personnel (name, rank, station_id, unit_id, training) VALUES (?, ?, ?, NULL, ?)` ,
          [person.name, person.rank ?? null, stationId, JSON.stringify(person.training)]
        );
        createdPersonnel.push({ id: insertPerson.lastID, ...person, unit_id: null });
      }

      await adjustBalance(-totalCost);
      await runAsync('COMMIT');
      const balance = await getBalance();

      return res.json({
        id: stationId,
        name,
        type,
        lat,
        lon,
        department,
        bay_count: bays,
        equipment_slots: equipmentSlots,
        holding_cells: holdingCells,
        bed_capacity: bedCapacity,
        equipment: stationEquipment,
        cost_breakdown: {
          station: stationCost,
          units: unitCostTotal,
          unit_equipment: unitEquipmentCostTotal,
          station_equipment: stationEquipmentCostTotal,
          personnel: personnelCostTotal,
          total: totalCost,
        },
        units: createdUnits,
        personnel: createdPersonnel,
        balance,
      });
    } catch (err) {
      await runAsync('ROLLBACK');
      console.error(err);
      return res.status(500).json({ error: err.message || 'Failed to create station' });
    }
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || 'Failed to create station' });
  }
}

// PATCH /api/stations/:id/bays
function patchBays(req, res) {
  const stationId = Number(req.params.id);
  const add = Math.max(0, Number(req.body?.add || 0));
  if (!stationId || !add) return res.status(400).json({ error: 'Invalid station id/add' });

  const cost = priceBays(add, true);
  requireFunds(cost)
    .then(ok => {
      if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });
      db.run(
        'UPDATE stations SET bay_count = COALESCE(bay_count,0) + ? WHERE id=?',
        [add, stationId],
        async function (err) {
          if (err) return res.status(500).json({ error: err.message });
          await adjustBalance(-cost);
          const balance = await getBalance();
          res.json({ success: true, station_id: stationId, added: add, cost, balance });
        }
      );
    })
    .catch(e => res.status(500).json({ error: e.message }));
}

// PATCH /api/stations/:id/icon  { icon: <string> }
function patchIcon(req, res) {
  const id = Number(req.params.id);
  const icon = String(req.body?.icon || '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  if (icon.length > 2048) return res.status(400).json({ error: 'Icon URL too long' });
  db.run('UPDATE stations SET icon=? WHERE id=?', [icon, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id, icon });
  });
}

// PATCH /api/stations/:id/name  { name: <string> }
async function patchName(req, res) {
  const id = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (name.length > 200) return res.status(400).json({ error: 'Name too long' });
  try {
    const result = await runAsync('UPDATE stations SET name=? WHERE id=?', [name, id]);
    if (!result.changes) return res.status(404).json({ error: 'Station not found' });
    res.json({ success: true, id, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// DELETE /api/stations
function deleteStations(req, res) {
  db.run('DELETE FROM stations', err => {
    if (err) return res.status(500).send('Error deleting stations.');
    res.send('All stations deleted.');
  });
}

// DELETE /api/stations/:id
async function deleteStation(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid station id' });

  try {
    const exists = await getAsync('SELECT id FROM stations WHERE id=?', [id]);
    if (!exists) return res.status(404).json({ error: 'Station not found' });

    await runAsync('BEGIN TRANSACTION');
    await runAsync('DELETE FROM facility_load WHERE station_id=?', [id]);
    await runAsync('DELETE FROM response_zones WHERE station_id=?', [id]);
    await runAsync('DELETE FROM personnel WHERE unit_id IN (SELECT id FROM units WHERE station_id=?)', [id]);
    await runAsync('DELETE FROM personnel WHERE station_id=?', [id]);
    await runAsync('DELETE FROM mission_units WHERE unit_id IN (SELECT id FROM units WHERE station_id=?)', [id]);
    await runAsync('DELETE FROM unit_travel WHERE unit_id IN (SELECT id FROM units WHERE station_id=?)', [id]);
    await runAsync('DELETE FROM units WHERE station_id=?', [id]);
    await runAsync('DELETE FROM stations WHERE id=?', [id]);
    await runAsync('COMMIT');
    res.json({ success: true, id });
  } catch (err) {
    try { await runAsync('ROLLBACK'); } catch { /* ignore */ }
    res.status(500).json({ error: err.message });
  }
}

// POST /api/stations/:id/equipment  { name: <string> }
function buyEquipment(req, res) {
  const stationId = Number(req.params.id);
  const name = String(req.body?.name || '').trim();
  if (!stationId || !name) return res.status(400).json({ error: 'Invalid station id or name' });

  db.get(`SELECT equipment, equipment_slots FROM stations WHERE id=?`, [stationId], async (err, st) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!st) return res.status(404).json({ error: 'Station not found' });

    let list; try { list = JSON.parse(st.equipment || '[]'); } catch { list = []; }
    const slots = Number(st.equipment_slots || 0);
    if (slots && list.length >= slots) return res.status(409).json({ error: 'No free equipment slots' });

    const cost = findEquipmentCostByName(name);
    try {
      const ok = await requireFunds(cost);
      if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });

      list.push(name);
      db.run(`UPDATE stations SET equipment=? WHERE id=?`, [JSON.stringify(list), stationId], async (e2) => {
        if (e2) return res.status(500).json({ error: e2.message });
        try {
          await adjustBalance(-cost);
          const balance = await getBalance();
          res.json({ success: true, station_id: stationId, equipment: list, cost, balance });
        } catch (e3) {
          res.status(500).json({ error: e3.message });
        }
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// PATCH /api/stations/:id/equipment-slots  { add: <int> }
function patchEquipmentSlots(req, res) {
  const id = Number(req.params.id);
  const add = Math.max(0, Number(req.body?.add || 0));
  if (!id || !add) return res.status(400).json({ error: 'Invalid station id/add' });

  db.get(`SELECT equipment_slots FROM stations WHERE id=?`, [id], async (err, station) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!station) return res.status(404).json({ error: 'Not found' });

    const cost = EQUIPMENT_SLOT_COST * add;
    try {
      const ok = await requireFunds(cost);
      if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });

      const newCount = Number(station.equipment_slots || 0) + add;
      db.run(`UPDATE stations SET equipment_slots=? WHERE id=?`, [newCount, id], async (e2) => {
        if (e2) return res.status(500).json({ error: e2.message });
        await adjustBalance(-cost);
        const balance = await getBalance();
        res.json({ success: true, station_id: id, added: add, new_equipment_slots: newCount, cost, balance });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// PATCH /api/stations/:id/department  { department: <string> }
function patchDepartment(req, res) {
  const id = Number(req.params.id);
  const department = String(req.body?.department || '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  db.run(`UPDATE stations SET department=? WHERE id=?`, [department, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id, department });
  });
}

// PATCH /api/stations/:id/holding-cells  { add: <int> }
function patchHoldingCells(req, res) {
  const id = Number(req.params.id);
  const add = Math.max(0, Number(req.body?.add || 0));
  if (!id || !add) return res.status(400).json({ error: 'Invalid station id/add' });
  db.get(`SELECT holding_cells, type FROM stations WHERE id=?`, [id], async (err, s) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (!['police', 'jail'].includes(s.type)) {
      return res.status(400).json({ error: 'Holding cells only available on police or jail stations' });
    }
    const newCount = Number(s.holding_cells || 0) + add;
    const cost = priceHoldingCells(add, true);
    try {
      const ok = await requireFunds(cost);
      if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });
      db.run(`UPDATE stations SET holding_cells=? WHERE id=?`, [newCount, id], async (e2) => {
        if (e2) return res.status(500).json({ error: e2.message });
        await adjustBalance(-cost);
        const balance = await getBalance();
        res.json({ success: true, station_id: id, added: add, new_holding_cells: newCount, cost, balance });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// PATCH /api/stations/:id/beds  { add: <int> }
function patchHospitalBeds(req, res) {
  const id = Number(req.params.id);
  const add = Math.max(0, Number(req.body?.add || 0));
  if (!id || !add) return res.status(400).json({ error: 'Invalid station id/add' });
  db.get(`SELECT bed_capacity, type FROM stations WHERE id=?`, [id], async (err, s) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.type !== 'hospital') {
      return res.status(400).json({ error: 'Beds can only be purchased for hospitals' });
    }
    const newCount = Number(s.bed_capacity || 0) + add;
    const cost = priceHospitalBeds(add, true);
    try {
      const ok = await requireFunds(cost);
      if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });
      db.run(`UPDATE stations SET bed_capacity=? WHERE id=?`, [newCount, id], async (e2) => {
        if (e2) return res.status(500).json({ error: e2.message });
        await adjustBalance(-cost);
        const balance = await getBalance();
        res.json({ success: true, station_id: id, added: add, new_bed_capacity: newCount, cost, balance });
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

// GET /api/stations/:id/personnel
function getStationPersonnel(req, res) {
  const stationId = req.params.id;
  db.all(
    `SELECT * FROM personnel WHERE station_id = ? AND (unit_id IS NULL OR unit_id = '')`,
    [stationId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const processed = rows.map((row) => ({
        ...row,
        rank: normalizeRank(row.rank),
        training: (() => {
          try { return JSON.parse(row.training || '[]'); }
          catch { return []; }
        })(),
      }));
      res.json(processed);
    }
  );
}

module.exports = {
  getStations,
  getStation,
  createStation,
  patchBays,
  patchIcon,
  patchName,
  deleteStations,
  deleteStation,
  buyEquipment,
  patchEquipmentSlots,
  patchDepartment,
  patchHoldingCells,
  patchHospitalBeds,
  getStationPersonnel,
};
