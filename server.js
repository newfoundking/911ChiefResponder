const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const db = require('./db');             // your sqlite3 instance
const unitTypes = require('./unitTypes');
let trainingsByClass = {};
let equipment = {};
try { trainingsByClass = require('./trainings'); } catch { /* falls back to {} */ }
try { equipment = require('./equipment'); } catch { /* falls back to {} */ }

const app = express();
const PORT = 911;

app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public'));
app.get('/config/unitTypes.js', (req,res)=>res.sendFile(path.join(__dirname,'unitTypes.js')));
app.get('/config/trainings.js', (req,res)=>res.sendFile(path.join(__dirname,'trainings.js')));
app.get('/config/equipment.js', (req,res)=>res.sendFile(path.join(__dirname,'equipment.js')));

db.serialize(() => {
  // Stations
  db.run(`
    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      type TEXT,
      lat REAL,
      lon REAL
    )
  `);

  // Missions
  db.run(`
    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      lat REAL,
      lon REAL,
      required_units TEXT,
      required_training TEXT DEFAULT '[]',
      equipment_required TEXT DEFAULT '[]',
      patients TEXT DEFAULT '[]',
      prisoners TEXT DEFAULT '[]',
      modifiers TEXT DEFAULT '[]',
      status TEXT
      -- timing will be added via ALTER below if missing
    )
  `);

  // Add timing column if not present
  db.run(`ALTER TABLE missions ADD COLUMN timing INTEGER DEFAULT 10`, () => { /* ignore if exists */ });

  // Mission ↔ Units link
  db.run(`
    CREATE TABLE IF NOT EXISTS mission_units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id INTEGER NOT NULL,
      unit_id INTEGER NOT NULL,
      UNIQUE(mission_id, unit_id)
    )
  `);

  // Mission templates
  db.run(`
    CREATE TABLE IF NOT EXISTS mission_templates (
	  id INTEGER PRIMARY KEY AUTOINCREMENT,
	  name TEXT,
	  trigger_type TEXT,
	  trigger_filter TEXT,
	  timing INTEGER,
	  required_units TEXT,
	  patients TEXT,
	  prisoners TEXT,
	  required_training TEXT,
	  modifiers TEXT,
	  equipment_required TEXT,
	  rewards INTEGER DEFAULT 0
    )
  `);

  // Units
  db.run(`
    CREATE TABLE IF NOT EXISTS units (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      station_id INTEGER,
      class TEXT,
      type TEXT,
      name TEXT,
      personnel TEXT DEFAULT '[]',
      equipment TEXT DEFAULT '[]',
      status TEXT DEFAULT 'available',
      FOREIGN KEY (station_id) REFERENCES stations(id)
    )
  `);

  // Fix any legacy rows where status was "[]"
  db.run(`UPDATE units SET status='available' WHERE status IS NULL OR status='[]'`);

  // Personnel
  db.run(`
    CREATE TABLE IF NOT EXISTS personnel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      training TEXT DEFAULT '[]',
      station_id INTEGER,
      unit_id INTEGER,
      FOREIGN KEY (station_id) REFERENCES stations(id),
      FOREIGN KEY (unit_id) REFERENCES units(id)
    )
  `);

  // Travel persistence (one active row per unit)
  db.run(`
    CREATE TABLE IF NOT EXISTS unit_travel (
      unit_id INTEGER PRIMARY KEY,
      mission_id INTEGER,
      phase TEXT NOT NULL,                -- to_scene | return
      started_at TEXT NOT NULL,           -- ISO
      from_lat REAL NOT NULL,
      from_lon REAL NOT NULL,
      to_lat REAL NOT NULL,
      to_lon REAL NOT NULL,
      coords TEXT NOT NULL,               -- JSON [[lat,lon],...]
      seg_durations TEXT NOT NULL,        -- JSON [sec,...]
      total_duration REAL NOT NULL,       -- seconds (post multiplier)
      FOREIGN KEY (unit_id) REFERENCES units(id)
    )
  `);
});
db.run(`
  CREATE TABLE IF NOT EXISTS wallet (
    id INTEGER PRIMARY KEY CHECK (id=1),
    balance INTEGER DEFAULT 100000
  )
`);

// Station upgrades / storage columns
db.run(`
  ALTER TABLE stations ADD COLUMN equipment_slots INTEGER DEFAULT 0
`, () => { /* ignore if exists */ });
db.run(`
  ALTER TABLE stations ADD COLUMN bay_count INTEGER DEFAULT 0
`, () => { /* ignore if exists */ });
db.run(`
  ALTER TABLE stations ADD COLUMN holding_cells INTEGER DEFAULT 0
`, () => { /* ignore if exists */ });
db.run(`
  ALTER TABLE stations ADD COLUMN equipment TEXT DEFAULT '[]'
`, () => { /* ignore if exists */ });
db.run(`INSERT OR IGNORE INTO wallet (id, balance) VALUES (1, 100000)`);


function resolveMissionById(missionId, cb) {
  db.serialize(() => {
    db.run('UPDATE missions SET status=? WHERE id=?', ['resolved', missionId], (e0) => {
      if (e0) return cb && cb(e0);

      db.all('SELECT unit_id FROM mission_units WHERE mission_id=?', [missionId], async (e1, rows) => {
        if (e1) return cb && cb(e1);
        const ids = (rows || []).map(r => r.unit_id);
        const placeholders = ids.map(() => '?').join(',');

        const freeUnits = ids.length
          ? new Promise((resolve, reject) =>
              db.run(`UPDATE units SET status='available' WHERE id IN (${placeholders})`, ids, (e) => e ? reject(e) : resolve()))
          : Promise.resolve();

        try {
          await freeUnits;
          db.run('DELETE FROM mission_units WHERE mission_id=?', [missionId], (e2) => {
            if (e2) return cb && cb(e2);

            // reward from mission_templates.name == missions.type
            db.get('SELECT type FROM missions WHERE id=?', [missionId], (e3, m) => {
              if (e3) return cb && cb(e3);
              const missionName = m?.type || '';
              db.get('SELECT rewards FROM mission_templates WHERE name=?', [missionName], async (e4, trow) => {
                if (e4) return cb && cb(e4);
                const reward = Number(trow?.rewards || 0);
                try {
                  if (reward > 0) await adjustBalance(+reward);
                  const bal = await getBalance();
                  clearMissionClock(missionId);
                  cb && cb(null, { freed: ids.length, reward, balance: bal });
                } catch (eAdj) {
                  cb && cb(eAdj);
                }
              });
            });
          });
        } catch (eFree) {
          cb && cb(eFree);
        }
      });
    });
  });
}

const missionClocks = new Map(); // mission_id -> { startedAt: number(ms), durationMs: number }

function beginMissionClock(missionId) {
  if (missionClocks.has(missionId)) return; // already running
  db.get('SELECT timing FROM missions WHERE id=?', [missionId], (e, row) => {
    if (e || !row) return;
    const minutes = Number(row.timing || 0);
    const durationMs = Math.max(0, minutes) * 60 * 1000; // minutes -> ms
    missionClocks.set(missionId, { startedAt: Date.now(), durationMs });
  });
}

function clearMissionClock(missionId) {
  missionClocks.delete(missionId);
}

function findUnitCostByType(t) {
  try {
    if (!Array.isArray(unitTypes)) return 0;
    const u = unitTypes.find(x => x.type === t);
    return Number(u?.cost) || 0;
  } catch { return 0; }
}
function findTrainingCostByName(name) {
  try {
    const lists = Object.values(trainingsByClass || {});
    for (const arr of lists) {
      for (const item of arr || []) {
        if (typeof item === 'string' && item === name) return 0;
        if (item?.name === name) return Number(item.cost) || 0;
      }
    }
    return 0;
  } catch { return 0; }
}
function findEquipmentCostByName(name) {
  try {
    const lists = Object.values(equipment || {});
    for (const arr of lists || []) {
      for (const item of arr || []) {
        if (typeof item === 'string' && item === name) return 0;
        if (item?.name === name) return Number(item.cost) || 0;
      }
    }
    return 0;
  } catch { return 0; }
}

function getBalance() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT balance FROM wallet WHERE id=1`, (e, row) =>
      e ? reject(e) : resolve(Number(row?.balance || 0))
    );
  });
}
function adjustBalance(delta) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE wallet SET balance = balance + ? WHERE id=1`, [Number(delta)||0],
      function (e) { e ? reject(e) : resolve(true); });
  });
}
async function requireFunds(amount) {
  const need = Number(amount) || 0;
  const bal = await getBalance();
  if (bal < need) return { ok:false, balance: bal, need };
  return { ok:true, balance: bal };
}

// Public endpoint to see wallet
app.get('/api/wallet', async (req, res) => {
  try { res.json({ balance: await getBalance() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

/* =========================
   POIs (Overpass)
   ========================= */
app.get('/api/pois', async (req, res) => {
  const { lat, lon, radius } = req.query;
  try {
    const response = await axios.get(`https://overpass-api.de/api/interpreter`, {
      params: {
        data: `[out:json];node(around:${radius},${lat},${lon})["amenity"];out;`
      }
    });
    res.json(response.data.elements);
  } catch (error) {
    console.error('Error fetching POIs:', error);
    res.status(500).send('Error fetching POIs');
  }
});

// ==== Pricing (integers only) ====

function priceHoldingCells(count, isExpansion) {
  const base = HOLDING_CELL_BASE_COST * count;
  return isExpansion ? Math.floor(base * HOLDING_CELL_EXP_MULTIPLIER_X100 / 100) : base;
}
function intOrZero(n) { const x = Number(n); return Number.isFinite(x) ? Math.trunc(x) : 0; }

function getStationById(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM stations WHERE id = ?`, [id], (err, row) => {
      if (err) return reject(err);
      if (row) {
        try { row.equipment = JSON.parse(row.equipment || '[]'); }
        catch { row.equipment = []; }
      }
      resolve(row || null);
    });
  });
}

function stationBayUsage(stationId){
  return new Promise((resolve, reject) => {
    db.get(`SELECT bay_count FROM stations WHERE id=?`, [stationId], (err, s) => {
      if (err) return reject(err);
      if (!s) return resolve({ ok:false, reason:'Station not found' });
      db.get(`SELECT COUNT(*) AS used FROM units WHERE station_id=?`, [stationId], (e, r) => {
        if (e) return reject(e);
        resolve({ ok:true, bays: Number(s.bay_count||0), used: Number(r?.used||0) });
      });
    });
  });
}

// Create a unit (charges the unit type cost)
app.post('/api/units', async (req, res) => {
  try {
    const { station_id, class: unitClass, type, name } = req.body || {};
    if (!station_id || !unitClass || !type || !name)
      return res.status(400).json({ error: 'station_id, class, type, name are required' });

    const usage = await stationBayUsage(Number(station_id));
    if (!usage.ok) return res.status(404).json({ error: usage.reason });
    if (usage.used >= usage.bays) return res.status(409).json({ error: 'No free bays at station' });

    const cost = findUnitCostByType(type) || 0;
    const ok = await requireFunds(cost);
    if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });

    db.run(
      `INSERT INTO units (station_id, class, type, name, status) VALUES (?,?,?,?, 'available')`,
      [station_id, unitClass, type, name],
      async function (err) {
        if (err) return res.status(500).json({ error: err.message });
        if (cost > 0) await adjustBalance(-cost);
        const balance = await getBalance();
        res.json({ ok:true, id: this.lastID, charged: cost, balance });
      }
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

const BAY_BASE_COST = 5000; // whole dollars
const HOLDING_CELL_BASE_COST = 2500;
const X100 = (x)=>x; // tiny helper to readability
const EXPANSION_MULT = { bay: X100(200), holding: X100(150) }; // 2.0x and 1.5x

const priceBays = (n, isExpansion)=> isExpansion ? Math.floor(BAY_BASE_COST*n*EXPANSION_MULT.bay/100) : BAY_BASE_COST*n;
const priceHolding = (n, isExpansion)=> isExpansion ? Math.floor(HOLDING_CELL_BASE_COST*n*EXPANSION_MULT.holding/100) : HOLDING_CELL_BASE_COST*n;

app.patch('/api/stations/:id/holding-cells', (req, res) => {
  const id = Number(req.params.id), add = Math.max(0, Number(req.body?.add||0));
  if (!id || !add) return res.status(400).json({ error: 'Invalid station id/add' });
  db.get(`SELECT holding_cells, type FROM stations WHERE id=?`, [id], (e, s) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.type !== 'police') return res.status(400).json({ error: 'Holding cells only on police stations' });
    const newCount = Number(s.holding_cells||0) + add;
    const cost = priceHolding(add, true);
    db.run(`UPDATE stations SET holding_cells=? WHERE id=?`, [newCount, id], (e2)=>{
      if (e2) return res.status(500).json({ error: e2.message });
      res.json({ success:true, station_id:id, added:add, new_holding_cells:newCount, cost });
    });
  });
});


/* =========================
   Missions
   ========================= */
app.get('/api/missions', (req, res) => {
  db.all("SELECT * FROM missions", (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const parsed = rows.map(m => ({
      ...m,
      required_units: JSON.parse(m.required_units || "[]"),
      required_training: JSON.parse(m.required_training || "[]"),
      equipment_required: JSON.parse(m.equipment_required || "[]"),
      patients: JSON.parse(m.patients || "[]"),
      prisoners: JSON.parse(m.prisoners || "[]"),
      modifiers: JSON.parse(m.modifiers || "[]"),
      timing: typeof m.timing === 'number' ? m.timing : 10
    }));
    res.json(parsed);
  });
});

app.post('/api/missions', (req, res) => {
  const {
    type, lat, lon,
    required_units = [], required_training = [],
    equipment_required = [], patients = [], prisoners = [], modifiers = [],
    timing = 10
  } = req.body;

  db.run(`
    INSERT INTO missions
    (type, lat, lon, required_units, required_training, equipment_required, patients, prisoners, modifiers, status, timing)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `,
  [
    type, lat, lon,
    JSON.stringify(required_units),
    JSON.stringify(required_training),
    JSON.stringify(equipment_required),
    JSON.stringify(patients),
    JSON.stringify(prisoners),
    JSON.stringify(modifiers),
    "active",
    timing
  ],
  function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({
      id: this.lastID,
      type, lat, lon,
      required_units, required_training, equipment_required, patients, prisoners, modifiers,
      status: "active",
      timing
    });
  });
});

app.put('/api/missions/:id', (req, res) => {
  const missionId = parseInt(req.params.id, 10);
  db.run(`UPDATE missions SET status='resolved' WHERE id=?`, [missionId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: missionId, status: "resolved" });
  });
});

app.delete('/api/missions', (req, res) => {
  db.run("DELETE FROM missions", (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.sendStatus(200);
  });
});

app.get('/api/missions/:id/units', (req, res) => {
  db.all(`
    SELECT u.*
    FROM mission_units mu
    JOIN units u ON u.id = mu.unit_id
    WHERE mu.mission_id = ?
  `, [req.params.id], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows || []);
  });
});
// Get personnel for a station (only unassigned)
app.get('/api/stations/:id/personnel', (req, res) => {
    const stationId = req.params.id;
    db.all(`SELECT * FROM personnel WHERE station_id = ? AND (unit_id IS NULL OR unit_id = '')`, [stationId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
// Get personnel assigned to a unit
app.get('/api/units/:id/personnel', (req, res) => {
    const unitId = req.params.id;
    db.all(`SELECT * FROM personnel WHERE unit_id = ?`, [unitId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});
// Assign personnel to a unit
app.post('/api/units/:id/personnel', (req, res) => {
    const unitId = req.params.id;
    const { personnelId } = req.body;
    db.run(`UPDATE personnel SET unit_id = ? WHERE id = ?`, [unitId, personnelId], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

// Assign unit to mission
app.post('/api/missions/:id/units', (req, res) => {
    const missionId = req.params.id;
    const { unitId } = req.body;

    db.run(`INSERT INTO mission_units (mission_id, unit_id) VALUES (?, ?)`, [missionId, unitId], function (err) {
        if (err) return res.status(500).json({ error: err.message });

        db.run(`UPDATE units SET status = 'enroute' WHERE id = ?`, [unitId], function (err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            res.json({ success: true });
        });
    });
});

// Resolve mission & free units + credit rewards from template(name==type)
app.post('/api/missions/:id/resolve', (req, res) => {
  const missionId = parseInt(req.params.id, 10);
  if (!missionId) return res.status(400).json({ error: 'invalid id' });

  resolveMissionById(missionId, (err, result) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true, ...(result || {}) });
  });
});


/* =========================
   Stations
   ========================= */
app.get('/api/stations', (req, res) => {
  db.all('SELECT * FROM stations', (err, rows) => {
    if (err) return res.status(500).send('Error reading stations');
    rows = rows.map(r => {
      try { r.equipment = JSON.parse(r.equipment || '[]'); } catch { r.equipment = []; }
      return r;
    });
    res.json(rows);
  });
});

app.get('/api/stations/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  db.get('SELECT * FROM stations WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Station not found' });
    try { row.equipment = JSON.parse(row.equipment || '[]'); } catch { row.equipment = []; }
    res.json(row);
  });
});

// ==== Station Bay Pricing (integer dollars) ====
const BAY_EXPANSION_MULTIPLIER_X100 = 200; // 200 = 2.00x cost for post-build expansion

// PATCH /api/stations/:id/bays  { add: <int> }
app.patch('/api/stations/:id/bays', async (req, res) => {
  try {
    const stationId = Number(req.params.id);
    const add = Math.max(0, Number(req.body?.add ?? 0));
    if (!Number.isInteger(stationId) || stationId <= 0) {
      return res.status(400).json({ error: 'Invalid station id' });
    }
    if (!Number.isInteger(add) || add <= 0) {
      return res.status(400).json({ error: 'add must be a positive integer' });
    }

    const station = await getStationById(stationId);
    if (!station) return res.status(404).json({ error: 'Station not found' });

    // All PATCH-based bay adds are post-build expansions => expansion cost (2.0x)
    const cost = priceBays(add, true);

    const newCount = (Number(station.bay_count) || 0) + add;
    db.run(
      `UPDATE stations SET bay_count = ? WHERE id = ?`,
      [newCount, stationId],
      function (err) {
        if (err) return res.status(500).json({ error: 'DB update failed' });
        return res.json({
          success: true,
          station_id: stationId,
          added: add,
          new_bay_count: newCount,
          cost
        });
      }
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});


app.post('/api/stations', async (req, res) => {
  try {
    const { name, type, lat, lon } = req.body || {};
    const BUILD_COST = 50000;

    const ok = await requireFunds(BUILD_COST);
    if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: BUILD_COST });

    db.run('INSERT INTO stations (name, type, lat, lon, bay_count, equipment_slots, holding_cells) VALUES (?, ?, ?, ?, 0, 0, 0)',
      [name, type, lat, lon],
      async function (err) {
        if (err) return res.status(500).send('Failed to insert station');
        await adjustBalance(-BUILD_COST);
        const balance = await getBalance();
        res.json({ id: this.lastID, name, type, lat, lon, bay_count: 0, equipment_slots: 0, holding_cells: 0, equipment: [], charged: BUILD_COST, balance });
      }
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

const EQUIPMENT_SLOT_COST = 1000;

// PATCH /api/stations/:id/equipment-slots  { add: <int> }
app.patch('/api/stations/:id/equipment-slots', (req, res) => {
  const id = Number(req.params.id), add = Math.max(0, Number(req.body?.add||0));
  if (!id || !add) return res.status(400).json({ error: 'Invalid station id/add' });

  db.get(`SELECT equipment_slots FROM stations WHERE id=?`, [id], async (e, s) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!s) return res.status(404).json({ error: 'Not found' });

    const cost = EQUIPMENT_SLOT_COST * add;
    const ok = await requireFunds(cost);
    if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });

    const newCount = Number(s.equipment_slots||0) + add;
    db.run(`UPDATE stations SET equipment_slots=? WHERE id=?`, [newCount, id], async (e2) => {
      if (e2) return res.status(500).json({ error: e2.message });
      await adjustBalance(-cost);
      const balance = await getBalance();
      res.json({ success:true, station_id:id, added:add, new_equipment_slots:newCount, cost, balance });
    });
  });
});

// POST /api/stations/:id/equipment  { name: <string> }
app.post('/api/stations/:id/equipment', (req, res) => {
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
    const ok = await requireFunds(cost);
    if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });

    list.push(name);
    db.run(`UPDATE stations SET equipment=? WHERE id=?`, [JSON.stringify(list), stationId], async (e2) => {
      if (e2) return res.status(500).json({ error: e2.message });
      await adjustBalance(-cost);
      const balance = await getBalance();
      res.json({ success: true, station_id: stationId, equipment: list, cost, balance });
    });
  });
});


app.delete('/api/stations', (req, res) => {
  db.run('DELETE FROM stations', err => {
    if (err) return res.status(500).send('Error deleting stations.');
    res.send('All stations deleted.');
  });
});

/* =========================
   Units
   ========================= */
app.get('/api/units', (req, res) => {
  const { station_id, status } = req.query;
  const params = [];
  let sql = 'SELECT * FROM units';
  const where = [];
  if (station_id) { where.push('station_id = ?'); params.push(station_id); }
  if (status)     { where.push('status = ?');     params.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const parsed = rows.map(u => ({
      ...u,
      personnel: JSON.parse(u.personnel || '[]'),
      equipment: JSON.parse(u.equipment || '[]'),
    }));
    res.json(parsed);
  });
});

// Assign equipment from station storage to a unit
app.patch('/api/units/:id/equipment', (req, res) => {
  const unitId = Number(req.params.id);
  const stationId = Number(req.body?.station_id);
  const name = String(req.body?.name || '').trim();
  if (!unitId || !stationId || !name) {
    return res.status(400).json({ error: 'unit_id, station_id and name are required' });
  }

  db.get(`SELECT equipment FROM stations WHERE id=?`, [stationId], (err, st) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!st) return res.status(404).json({ error: 'Station not found' });
    let stList; try { stList = JSON.parse(st.equipment || '[]'); } catch { stList = []; }
    const idx = stList.indexOf(name);
    if (idx === -1) return res.status(409).json({ error: 'Equipment not available' });

    db.get(`SELECT equipment FROM units WHERE id=?`, [unitId], (err2, u) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (!u) return res.status(404).json({ error: 'Unit not found' });
      let uList; try { uList = JSON.parse(u.equipment || '[]'); } catch { uList = []; }
      uList.push(name);
      stList.splice(idx, 1);
      db.serialize(() => {
        db.run(`UPDATE stations SET equipment=? WHERE id=?`, [JSON.stringify(stList), stationId]);
        db.run(`UPDATE units SET equipment=? WHERE id=?`, [JSON.stringify(uList), unitId], function (e3) {
          if (e3) return res.status(500).json({ error: e3.message });
          res.json({ success: true, unit_id: unitId, equipment: uList, station_equipment: stList });
        });
      });
    });
  });
});

// Ensure station has a free bay
async function ensureStationHasFreeBay(stationId) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT bay_count FROM stations WHERE id = ?`, [stationId], (err, s) => {
      if (err) return reject(err);
      if (!s) return resolve({ ok: false, reason: 'Station not found' });

      db.get(
        `SELECT COUNT(*) AS cnt FROM units WHERE station_id = ?`,
        [stationId],
        (err2, row) => {
          if (err2) return reject(err2);
          const used = Number(row?.cnt || 0);
          const bays = Number(s.bay_count || 0);
          if (used >= bays) return resolve({ ok: false, reason: 'No free bays at station' });
          resolve({ ok: true, used, bays });
        }
      );
    });
  });
}



// Update unit status
app.patch('/api/units/:id/status', (req, res) => {
  const { status } = req.body || {};
  const id = parseInt(req.params.id, 10);
  if (!id || !status) return res.status(400).json({ error: 'id and status required' });
  db.run('UPDATE units SET status = ? WHERE id = ?', [status, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

/* =========================
   Personnel
   ========================= */
app.get('/api/personnel', (req, res) => {
  const { station_id } = req.query;
  let query = 'SELECT * FROM personnel';
  const params = [];
  if (station_id) { query += ' WHERE station_id = ?'; params.push(station_id); }
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch personnel' });
    const processed = rows.map(p => ({ ...p, training: JSON.parse(p.training || '[]') }));
    res.json(processed);
  });
});

app.get('/api/personnel/:id', (req, res) => {
  db.get('SELECT * FROM personnel WHERE id = ?', [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    row.training = JSON.parse(row.training || '[]');
    res.json(row);
  });
});

app.post('/api/personnel', async (req, res) => {
  try {
    const { name, station_id, training = [] } = req.body || {};
    const BASE_PERSON_COST = 100;

    // sum of training costs
    const tCost = (Array.isArray(training) ? training : []).reduce((sum, t) => {
      const key = typeof t === 'string' ? t : t?.name;
      return sum + (findTrainingCostByName(key) || 0);
    }, 0);
    const total = BASE_PERSON_COST + tCost;

    const ok = await requireFunds(total);
    if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: total });

    db.run(
      'INSERT INTO personnel (name, station_id, training) VALUES (?, ?, ?)',
      [name, station_id, JSON.stringify(training || [])],
      async function (err) {
        if (err) return res.status(500).send('Failed to insert personnel');
        await adjustBalance(-total);
        const balance = await getBalance();
        res.json({ id: this.lastID, charged: total, base: BASE_PERSON_COST, training_cost: tCost, balance });
      }
    );
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});


app.put('/api/personnel/:id', (req, res) => {
  const id = req.params.id;
  const { name, training } = req.body;
  db.run(
    'UPDATE personnel SET name = ?, training = ? WHERE id = ?',
    [name, JSON.stringify(training || []), id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.patch('/api/personnel/:id', (req, res) => {
  const id = req.params.id;

  const fields = [];
  const params = [];

  if (req.body.name !== undefined) {
    fields.push('name = ?');
    params.push(req.body.name);
  }
  if (req.body.training !== undefined) {
    fields.push('training = ?');
    params.push(JSON.stringify(req.body.training || []));
  }
  if (req.body.unit_id !== undefined) {
    fields.push('unit_id = ?');
    params.push(req.body.unit_id);
  }

  if (!fields.length) {
    return res.status(400).json({ error: 'No updatable fields provided' });
  }

  params.push(id);
  const sql = `UPDATE personnel SET ${fields.join(', ')} WHERE id = ?`;

  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, changed: this.changes });
  });
});


/* =========================
   Mission templates
   ========================= */
app.get('/api/mission-templates', (req, res) => {
  db.all('SELECT * FROM mission_templates', (err, rows) => {
    if (err) return res.status(500).json({ error: 'Database error' });
    const parsed = rows.map(row => ({
      ...row,
      required_units: JSON.parse(row.required_units || '[]'),
      patients: JSON.parse(row.patients || '[]'),
      prisoners: JSON.parse(row.prisoners || '[]'),
      modifiers: JSON.parse(row.modifiers || '[]'),
      required_training: JSON.parse(row.required_training || '[]'),
      equipment_required: JSON.parse(row.equipment_required || '[]'),
	  rewards: Number.isFinite(row.rewards) ? row.rewards : 0
    }));
    res.json(parsed);
  });
});

app.post('/api/mission-templates', express.json(), (req, res) => {
  const b = req.body || {};
  const fields = {
    name: b.name || '',
    trigger_type: b.trigger_type || '',
    trigger_filter: b.trigger_filter || '',
    timing: Number(b.timing) || 0,
    required_units: JSON.stringify(b.required_units || []),
    patients: JSON.stringify(b.patients || []),
    prisoners: JSON.stringify(b.prisoners || []),
    required_training: JSON.stringify(b.required_training || []),
    modifiers: JSON.stringify(b.modifiers || []),
    equipment_required: JSON.stringify(b.equipment_required || []),
    rewards: Number(b.rewards) || 0
  };
  db.run(
    `INSERT INTO mission_templates
     (name, trigger_type, trigger_filter, timing,
      required_units, patients, prisoners, required_training, modifiers, equipment_required, rewards)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [fields.name, fields.trigger_type, fields.trigger_filter, fields.timing,
     fields.required_units, fields.patients, fields.prisoners, fields.required_training,
     fields.modifiers, fields.equipment_required, fields.rewards],
    function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID, ...fields });
    }
  );
});

app.put('/api/mission-templates/:id', express.json(), (req, res) => {
  const id = req.params.id;
  const b = req.body || {};
  const fields = {
    name: b.name || '',
    trigger_type: b.trigger_type || '',
    trigger_filter: b.trigger_filter || '',
    timing: Number(b.timing) || 0,
    required_units: JSON.stringify(b.required_units || []),
    patients: JSON.stringify(b.patients || []),
    prisoners: JSON.stringify(b.prisoners || []),
    required_training: JSON.stringify(b.required_training || []),
    modifiers: JSON.stringify(b.modifiers || []),
    equipment_required: JSON.stringify(b.equipment_required || []),
    rewards: Number(b.rewards) || 0
  };
  db.run(
    `UPDATE mission_templates SET
      name=?, trigger_type=?, trigger_filter=?, timing=?,
      required_units=?, patients=?, prisoners=?, required_training=?,
      modifiers=?, equipment_required=?, rewards=?
     WHERE id=?`,
    [fields.name, fields.trigger_type, fields.trigger_filter, fields.timing,
     fields.required_units, fields.patients, fields.prisoners, fields.required_training,
     fields.modifiers, fields.equipment_required, fields.rewards, id],
    function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id, ...fields });
    }
  );
});


app.get('/api/mission-templates/id/:id', (req, res) => {
  db.get(`SELECT id, name, trigger_type, trigger_filter, timing,
                 required_units, patients, prisoners, required_training,
                 modifiers, equipment_required, rewards
          FROM mission_templates WHERE id=?`, [req.params.id], (err, r) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!r)   return res.status(404).json({ error: "Not found" });
	try { r.required_units = JSON.parse(r.required_units || '[]'); } catch { r.required_units = []; }
	try { r.patients = JSON.parse(r.patients || '[]'); } catch { r.patients = []; }
	try { r.prisoners = JSON.parse(r.prisoners || '[]'); } catch { r.prisoners = []; }
	try { r.required_training = JSON.parse(r.required_training || '[]'); } catch { r.required_training = []; }
	try { r.modifiers = JSON.parse(r.modifiers || '[]'); } catch { r.modifiers = []; }
	try { r.equipment_required = JSON.parse(r.equipment_required || '[]'); } catch { r.equipment_required = []; }
	r.rewards = Number.isFinite(r.rewards) ? r.rewards : 0;
    res.json(r);
  });
});

/* =========================
   Mission ↔ Unit assignment
   (with global busy guard)
   ========================= */
app.post('/api/mission-units', (req, res) => {
  const { mission_id, unit_id } = req.body || {};
  if (!mission_id || !unit_id) return res.status(400).json({ error: 'mission_id and unit_id are required' });

  // Guard: prevent double-dispatch across all missions
  db.get('SELECT status FROM units WHERE id=?', [unit_id], (e, unitRow) => {
    if (e) return res.status(500).json({ error: e.message });
    if (!unitRow) return res.status(404).json({ error: 'unit not found' });
    if (unitRow.status !== 'available') return res.status(409).json({ error: 'unit busy' });

    // Prevent duplicates for same mission
    db.get('SELECT id FROM mission_units WHERE mission_id=? AND unit_id=?', [mission_id, unit_id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (row) return res.json({ ok: true, alreadyAssigned: true });

      db.run('INSERT INTO mission_units (mission_id, unit_id) VALUES (?, ?)', [mission_id, unit_id], function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        // Flip unit to enroute immediately (front-end may PATCH too, that’s fine)
        db.run('UPDATE units SET status=? WHERE id=?', ['enroute', unit_id], () => res.json({ ok: true, id: this?.lastID }));
      });
    });
  });
});

app.delete('/api/mission-units', (req, res) => {
  const { mission_id, unit_id } = req.body || {};
  if (!mission_id || !unit_id) return res.status(400).json({ error: 'mission_id and unit_id are required' });

  db.run('DELETE FROM mission_units WHERE mission_id = ? AND unit_id = ?', [mission_id, unit_id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    // Optional: set available immediately (or let arrival back at station do it)
    db.run('UPDATE units SET status=? WHERE id=?', ['available', unit_id], () => res.json({ ok: true, removed: this.changes }));
  });
});

/* =========================
   Unit travel persistence
   ========================= */
// Save/overwrite a unit’s current travel plan
app.post('/api/unit-travel', (req, res) => {
  const {
    unit_id, mission_id = null, phase = 'to_scene', started_at,
    from, to, coords, seg_durations, total_duration
  } = req.body || {};
  if (!unit_id || !started_at || !from || !to || !coords || !seg_durations || !total_duration) {
    return res.status(400).json({ error: 'invalid payload' });
  }

  db.run(`
    INSERT INTO unit_travel (unit_id, mission_id, phase, started_at, from_lat, from_lon, to_lat, to_lon, coords, seg_durations, total_duration)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(unit_id) DO UPDATE SET
      mission_id=excluded.mission_id,
      phase=excluded.phase,
      started_at=excluded.started_at,
      from_lat=excluded.from_lat,
      from_lon=excluded.from_lon,
      to_lat=excluded.to_lat,
      to_lon=excluded.to_lon,
      coords=excluded.coords,
      seg_durations=excluded.seg_durations,
      total_duration=excluded.total_duration
  `, [
    unit_id, mission_id, phase, started_at,
    from[0], from[1], to[0], to[1],
    JSON.stringify(coords), JSON.stringify(seg_durations), total_duration
  ], (err) => {
    if (err) return res.status(500).json({ error: err.message });

    // If this leg is already done (e.g., 0 duration or back-dated), flip immediately
    const elapsed = (Date.now() - new Date(started_at).getTime()) / 1000;
    if (elapsed >= Number(total_duration || 0)) {
      if (phase === 'to_scene') {
        db.run('UPDATE units SET status=? WHERE id=?', ['on_scene', unit_id], () => {});
        db.run('DELETE FROM unit_travel WHERE unit_id=?', [unit_id], () => {});
        if (mission_id) {
          db.run('UPDATE missions SET status=? WHERE id=?', ['on_scene', mission_id], () => {});
			beginMissionClock(mission_id);
        }
      } else if (phase === 'return') {
        db.run('UPDATE units SET status=? WHERE id=?', ['available', unit_id], () => {});
        db.run('DELETE FROM unit_travel WHERE unit_id=?', [unit_id], () => {});
      }
    }

    res.json({ ok: true });
  });
});


// Return only travels still in progress (elapsed < total_duration)
app.get('/api/unit-travel/active', (req, res) => {
  db.all('SELECT * FROM unit_travel', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const now = Date.now();

    // Apply side effects (arrivals/returns) before returning list
    const toReturn = [];
    const afterOps = [];

    for (const r of (rows || [])) {
      const elapsed = (now - new Date(r.started_at).getTime()) / 1000;
      const done = elapsed >= (r.total_duration || 0);

      if (done) {
        if (r.phase === 'to_scene') {
          // Arrived at scene
          afterOps.push(new Promise(resolve => {
            db.run('UPDATE units SET status=? WHERE id=?', ['on_scene', r.unit_id], () => {
              db.run('DELETE FROM unit_travel WHERE unit_id=?', [r.unit_id], () => {
                if (r.mission_id) {
                  db.run('UPDATE missions SET status=? WHERE id=?', ['on_scene', r.mission_id], () => {
                    beginMissionClock(r.mission_id);
                    resolve();
                  });
                } else resolve();
              });
            });
          }));
        } else if (r.phase === 'return') {
          afterOps.push(new Promise(resolve => {
            db.run('UPDATE units SET status=? WHERE id=?', ['available', r.unit_id], () => {
              db.run('DELETE FROM unit_travel WHERE unit_id=?', [r.unit_id], () => resolve());
            });
          }));
        }
        continue; // do not include completed legs in the response
      }

      // Still in progress -> include in output
      toReturn.push({
        unit_id: r.unit_id,
        mission_id: r.mission_id,
        phase: r.phase,
        started_at: r.started_at,
        from: [r.from_lat, r.from_lon],
        to: [r.to_lat, r.to_lon],
        coords: JSON.parse(r.coords || '[]'),
        seg_durations: JSON.parse(r.seg_durations || '[]'),
        total_duration: r.total_duration
      });
    }

Promise.all(afterOps).then(() => {
  // After arrivals/returns have been applied, check any mission clocks
  const now = Date.now();
  const toResolve = [];
  for (const [missionId, clk] of missionClocks.entries()) {
    if (clk && now - clk.startedAt >= (clk.durationMs || 0)) {
      toResolve.push(missionId);
    }
  }

  if (!toResolve.length) {
    return res.json(toReturn);
  }

  // Resolve any that are due, then respond
  let pending = toResolve.length;
  toResolve.forEach(id => {
    resolveMissionById(id, () => {
      // Always clear the clock (resolver also clears, but safe to ensure)
      clearMissionClock(id);
      if (--pending === 0) res.json(toReturn);
    });
  });
}).catch(e => res.status(500).json({ error: e.message }));
	});
});


// Clear a unit’s travel (on arrival/cancel)
app.delete('/api/unit-travel/:unit_id', (req, res) => {
  const unitId = parseInt(req.params.unit_id, 10);
  db.run('DELETE FROM unit_travel WHERE unit_id=?', [unitId], (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

function getStationById(id) {
  return new Promise((resolve, reject) => {
    db.get(`SELECT * FROM stations WHERE id = ?`, [id], (err, row) => {
      if (err) return reject(err);
      if (row) {
        try { row.equipment = JSON.parse(row.equipment || '[]'); }
        catch { row.equipment = []; }
      }
      resolve(row || null);
    });
  });
}

// PATCH /api/stations/:id/holding-cells { add: <int> }
app.patch('/api/stations/:id/holding-cells', async (req, res) => {
  try {
    const stationId = intOrZero(req.params.id);
    const add = intOrZero(req.body?.add);
    if (stationId <= 0) return res.status(400).json({ error: 'Invalid station id' });
    if (add <= 0) return res.status(400).json({ error: 'add must be a positive integer' });

    const station = await getStationById(stationId);
    if (!station) return res.status(404).json({ error: 'Station not found' });

    // Post‑build PATCH => expansion pricing (1.5x)
    const cost = priceHoldingCells(add, /*isExpansion*/ true);
    const newCount = intOrZero(station.holding_cells) + add;

    db.run(`UPDATE stations SET holding_cells = ? WHERE id = ?`,
      [newCount, stationId],
      function (err) {
        if (err) return res.status(500).json({ error: 'DB update failed' });
        res.json({
          success: true,
          station_id: stationId,
          added: add,
          new_holding_cells: newCount,
          cost
        });
      });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});

/* =========================
   Misc
   ========================= */
app.get('/api/unit-types', (req, res) => res.json({ unitTypes }));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

setInterval(() => {
  if (missionClocks.size === 0) return;
  const now = Date.now();
  const due = [];
  for (const [id, clk] of missionClocks.entries()) {
    if (clk && now - clk.startedAt >= (clk.durationMs || 0)) due.push(id);
  }
  if (!due.length) return;
  due.forEach(id => {
    resolveMissionById(id, () => clearMissionClock(id));
  });
}, 1000);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
