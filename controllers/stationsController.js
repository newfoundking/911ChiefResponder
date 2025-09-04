const db = require('../db');
const { findEquipmentCostByName, requireFunds, adjustBalance, getBalance } = require('../wallet');

const EQUIPMENT_SLOT_COST = 1000;
const BAY_BASE_COST = 5000;
const BAY_EXP_MULTIPLIER = 2.0;
const HOLDING_CELL_BASE_COST = 2500;
const HOLDING_CELL_EXP_MULTIPLIER = 1.5;

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
function createStation(req, res) {
  const { name, type, lat, lon, department } = req.body || {};
  db.run(
    'INSERT INTO stations (name, type, lat, lon, department) VALUES (?, ?, ?, ?, ?)',
    [name, type, lat, lon, department],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, name, type, lat, lon, department });
    }
  );
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
      res.json(rows);
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
