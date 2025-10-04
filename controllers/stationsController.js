const db = require('../db');
const { findEquipmentCostByName, requireFunds, adjustBalance, getBalance } = require('../wallet');
const unitTypes = require('../unitTypes');
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

const EQUIPMENT_SLOT_COST = 1000;
const BAY_BASE_COST = 5000;
const BAY_EXP_MULTIPLIER = 2.0;
const HOLDING_CELL_BASE_COST = 2500;
const HOLDING_CELL_EXP_MULTIPLIER = 1.5;
const STATION_BUILD_COST = 50000;
const BASE_PERSON_COST = 100;

function priceBays(count, isExpansion) {
  const base = BAY_BASE_COST * count;
  return isExpansion ? Math.floor(base * BAY_EXP_MULTIPLIER) : base;
}

function priceHoldingCells(count, isExpansion) {
  const base = HOLDING_CELL_BASE_COST * count;
  return isExpansion ? Math.floor(base * HOLDING_CELL_EXP_MULTIPLIER) : base;
}

// GET /api/stations
function getStations(req, res) {
  db.all('SELECT * FROM stations', (err, rows) => {
    if (err) return res.status(500).send('Error reading stations');
    const parsed = rows.map(r => {
      let equipment; try { equipment = JSON.parse(r.equipment || '[]'); } catch { equipment = []; }
      return { ...r, equipment };
    });
    res.json(parsed);
  });
}

// GET /api/stations/:id
function getStation(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  db.get('SELECT * FROM stations WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Station not found' });
    let equipment; try { equipment = JSON.parse(row.equipment || '[]'); } catch { equipment = []; }
    res.json({ ...row, equipment });
  });
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

    const allowedTypes = new Set(['fire', 'police', 'ambulance', 'sar', 'hospital', 'jail']);
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
      };
      unitsNormalized.push(normalized);
      unitPersonnelBuckets.push([]);

      if (Array.isArray(unitRaw?.personnel)) {
        unitRaw.personnel.forEach((personRaw) => {
          const pname = String(personRaw?.name || '').trim();
          if (!pname) return;
          const trainingRaw = normalizeTrainingList(personRaw?.training);
          const training = collapseTrainingList(trainingRaw, type);
          const rank = normalizeRank(personRaw?.rank);
          const trainingCost = training.reduce((sum, t) => sum + (findTrainingCostByName(t) || 0), 0);
          personnelCostTotal += BASE_PERSON_COST + trainingCost;
          unitPersonnelBuckets[idx].push({ name: pname, rank, training });
        });
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
        unitPersonnelBuckets[assignedIndex].push(entry);
      } else {
        stationPersonnel.push(entry);
      }
    }

    const stationEquipmentCostTotal = stationEquipment.reduce(
      (sum, item) => sum + (findEquipmentCostByName(item) || 0),
      0
    );

    const stationCost =
      STATION_BUILD_COST +
      priceBays(bays, false) +
      (equipmentSlots * EQUIPMENT_SLOT_COST) +
      (holdingCells > 0 ? priceHoldingCells(holdingCells, false) : 0);

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
          `INSERT INTO units (station_id, class, type, name, tag, priority, status, equipment)
           VALUES (?, ?, ?, ?, ?, ?, 'available', ?)` ,
          [stationId, unit.class, unit.type, unit.name, unit.tag, unit.priority, JSON.stringify(unit.equipment)]
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

// DELETE /api/stations
function deleteStations(req, res) {
  db.run('DELETE FROM stations', err => {
    if (err) return res.status(500).send('Error deleting stations.');
    res.send('All stations deleted.');
  });
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
    if (s.type !== 'police') return res.status(400).json({ error: 'Holding cells only on police stations' });
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
  deleteStations,
  buyEquipment,
  patchEquipmentSlots,
  patchDepartment,
  patchHoldingCells,
  getStationPersonnel,
};
