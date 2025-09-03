const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const { getRandomName } = require('./names');

const db = require('./db');             // your sqlite3 instance
const unitTypes = require('./unitTypes');
let trainingsByClass = {};
let equipment = {};
try { trainingsByClass = require('./trainings'); } catch { /* falls back to {} */ }
try { equipment = require('./equipment'); } catch { /* falls back to {} */ }

// Normalize legacy status values missing the underscore.
// Older clients used "onscene" while the server expects "on_scene".
// This ensures any existing records are standardized on startup.
db.serialize(() => {
  db.run("UPDATE units SET status='on_scene' WHERE status='onscene'");
  db.run("UPDATE missions SET status='on_scene' WHERE status='onscene'");
});

const { parseArrayField, reverseGeocode, pointInPolygon } = require('./utils');

const TRAVEL_SPEED = { fire: 63, police: 94, ambulance: 75 }; // km/h (25% faster)
function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180, la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const app = express();
const PORT = 911;

app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public'));
app.get('/config/unitTypes.js', (req,res)=>res.sendFile(path.join(__dirname,'unitTypes.js')));
app.get('/config/trainings.js', (req,res)=>res.sendFile(path.join(__dirname,'trainings.js')));
app.get('/config/equipment.js', (req,res)=>res.sendFile(path.join(__dirname,'equipment.js')));
app.get('/config/osmPoiTypes.js', (req,res)=>res.sendFile(path.join(__dirname,'osmPoiTypes.js')));

// Modular routes
const missionsRoutes = require('./routes/missions');
const stationsRoutes = require('./routes/stations');
const unitsRoutes = require('./routes/units');

app.use('/api/missions', missionsRoutes);
app.use('/api/stations', stationsRoutes);
app.use('/api/units', unitsRoutes);

db.serialize(() => {
  // Stations
  db.run(`
    CREATE TABLE IF NOT EXISTS stations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      type TEXT,
      lat REAL,
      lon REAL,
      department TEXT
    )
  `);

  // Missions
  db.run(`
    CREATE TABLE IF NOT EXISTS missions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT,
      lat REAL,
      lon REAL,
      address TEXT,
      departments TEXT,
      required_units TEXT,
      required_training TEXT DEFAULT '[]',
      equipment_required TEXT DEFAULT '[]',
      patients TEXT DEFAULT '[]',
      prisoners TEXT DEFAULT '[]',
      modifiers TEXT DEFAULT '[]',
      penalty_options TEXT DEFAULT '[]',
      penalties TEXT DEFAULT '[]',
      non_emergency INTEGER,
      status TEXT,
      timing INTEGER DEFAULT 10,
      resolve_at INTEGER
    )
  `);

  db.run(`
    ALTER TABLE mission_templates ADD COLUMN non_emergency INTEGER
  `, () => { /* ignore if exists */ });
  db.run(`
    ALTER TABLE mission_templates ADD COLUMN frequency INTEGER DEFAULT 3
  `, () => { /* ignore if exists */ });

  // Add timing/department/resolve columns if not present (for legacy DBs)
  db.run(`ALTER TABLE missions ADD COLUMN timing INTEGER DEFAULT 10`, () => { /* ignore if exists */ });
  db.run(`ALTER TABLE missions ADD COLUMN departments TEXT`, () => { /* ignore if exists */ });
  db.run(`ALTER TABLE missions ADD COLUMN resolve_at INTEGER`, () => { /* ignore if exists */ });
  // Newer schema fields
  db.run(`ALTER TABLE missions ADD COLUMN penalty_options TEXT DEFAULT '[]'`, () => { /* ignore if exists */ });
  db.run(`ALTER TABLE missions ADD COLUMN penalties TEXT DEFAULT '[]'`, () => { /* ignore if exists */ });
  db.run(`ALTER TABLE missions ADD COLUMN non_emergency INTEGER`, () => { /* ignore if exists */ });
  db.run(`ALTER TABLE missions ADD COLUMN address TEXT`, () => { /* ignore if exists */ });
  db.run(`UPDATE missions SET departments = json_array(department) WHERE departments IS NULL AND department IS NOT NULL`, () => {});

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
          penalty_options TEXT,
          rewards INTEGER DEFAULT 0,
          non_emergency INTEGER,
          frequency INTEGER DEFAULT 3
    )
  `);

  // Run cards
  db.run(`
    CREATE TABLE IF NOT EXISTS run_cards (
      mission_name TEXT PRIMARY KEY,
      units TEXT,
      training TEXT,
      equipment TEXT
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
      tag TEXT,
      priority INTEGER DEFAULT 1,
      personnel TEXT DEFAULT '[]',
      equipment TEXT DEFAULT '[]',
      status TEXT DEFAULT 'available',
      icon TEXT,
      responding_icon TEXT,
      responding INTEGER DEFAULT 0,
      patrol INTEGER DEFAULT 0,
      FOREIGN KEY (station_id) REFERENCES stations(id)
    )
  `);

  // Fix any legacy rows where status was "[]". Avoid referencing the
  // responding column here since older databases may not have it yet.
  db.run(`UPDATE units SET status='available' WHERE status IS NULL OR status='[]'`);
  // Add patrol column for legacy DBs
  db.run(`ALTER TABLE units ADD COLUMN patrol INTEGER DEFAULT 0`, () => {});
  // Add priority column for legacy DBs
  db.run(`ALTER TABLE units ADD COLUMN priority INTEGER DEFAULT 1`, () => {});
  // Add tag column for legacy DBs
  db.run(`ALTER TABLE units ADD COLUMN tag TEXT`, () => {});

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

  // Response zones
  db.run(`
    CREATE TABLE IF NOT EXISTS response_zones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      departments TEXT,
      station_id INTEGER,
      polygon TEXT
    )
  `);
  db.run(`ALTER TABLE response_zones ADD COLUMN departments TEXT`, () => { /* ignore if exists */ });
  db.run(`UPDATE response_zones SET departments = json_array(department) WHERE departments IS NULL AND department IS NOT NULL`, () => {});
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
  ALTER TABLE stations ADD COLUMN department TEXT
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
db.run(`
  ALTER TABLE stations ADD COLUMN bed_capacity INTEGER DEFAULT 0
`, () => { /* ignore if exists */ });
db.run(`
  ALTER TABLE stations ADD COLUMN icon TEXT
`, () => { /* ignore if exists */ });
db.run(`
  ALTER TABLE units ADD COLUMN icon TEXT
`, () => { /* ignore if exists */ });
db.run(`
  ALTER TABLE units ADD COLUMN responding_icon TEXT
`, () => { /* ignore if exists */ });
db.run(`
  ALTER TABLE units ADD COLUMN responding INTEGER DEFAULT 0
`, () => { /* ignore if exists */ });
db.run(`
  ALTER TABLE units ADD COLUMN tag TEXT
`, () => { /* ignore if exists */ });
db.run(`
  CREATE TABLE IF NOT EXISTS facility_load (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (station_id) REFERENCES stations(id)
  )
`);
db.run(`INSERT OR IGNORE INTO wallet (id, balance) VALUES (1, 100000)`);


function getFacilityOccupancy(stationId, type) {
  return new Promise((resolve, reject) => {
    const now = Date.now();
    db.get(
      `SELECT COUNT(*) AS cnt, MIN(expires_at) AS next FROM facility_load WHERE station_id=? AND type=? AND expires_at>?`,
      [stationId, type, now],
      (err, row) => {
        if (err) return reject(err);
        resolve({ count: row?.cnt || 0, nextFree: row?.next || 0 });
      }
    );
  });
}

function addFacilityLoad(stationId, type, expiresAt) {
  return new Promise((resolve, reject) => {
    db.run(
      `INSERT INTO facility_load (station_id, type, expires_at) VALUES (?,?,?)`,
      [stationId, type, expiresAt],
      err => (err ? reject(err) : resolve())
    );
  });
}


async function allocateTransport(kind, lat, lon, unitClass) {
  const facilities = await new Promise((resolve, reject) => {
    if (kind === 'patient') {
      db.all(
        `SELECT id, lat, lon, bed_capacity AS capacity FROM stations WHERE type='hospital' AND bed_capacity>0`,
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    } else {
      db.all(
        `SELECT id, lat, lon, holding_cells AS capacity FROM stations WHERE (type='jail' OR (type='police' AND holding_cells>0))`,
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    }
  });
  if (!facilities.length) return null;
  facilities.forEach(f => {
    f.distance = haversine(lat, lon, f.lat, f.lon);
  });
  facilities.sort((a, b) => a.distance - b.distance);
  const speed = TRAVEL_SPEED[unitClass] || 63;
  const now = Date.now();
  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    const occ = await getFacilityOccupancy(f.id, kind);
    if (occ.count < f.capacity) {
      await addFacilityLoad(f.id, kind, now + 10 * 60 * 1000);
      return f.id;
    }
    const nextFree = occ.nextFree || now;
    const timeUntilFree = nextFree - now;
    const next = facilities[i + 1];
    const travelToNext = next ? (haversine(lat, lon, next.lat, next.lon) / speed) * 3600 * 1000 : Infinity;
    if (timeUntilFree < travelToNext) {
      await addFacilityLoad(f.id, kind, nextFree + 10 * 60 * 1000);
      return f.id;
    }
  }
  const first = facilities[0];
  const occ = await getFacilityOccupancy(first.id, kind);
  const expiry = (occ.nextFree || now) + 10 * 60 * 1000;
  await addFacilityLoad(first.id, kind, expiry);
  return first.id;
}

async function handleTransports(unitIds, lat, lon, patients, prisoners) {
  let patientCount = 0;
  for (const p of patients) patientCount += Number(p.count || 0);
  let prisonerCount = 0;
  for (const p of prisoners) prisonerCount += Number(p.transport || 0);
  if (!unitIds.length) return;

  const placeholders = unitIds.map(() => '?').join(',');
  const rows = await new Promise((resolve, reject) => {
    db.all(`SELECT id, type FROM units WHERE id IN (${placeholders})`, unitIds, (err, r) =>
      err ? reject(err) : resolve(r || [])
    );
  });

  const medUnits = [];
  const prisUnits = [];
  for (const r of rows) {
    const ut = unitTypes.find(t => t.type === r.type);
    const attrs = Array.isArray(ut?.attributes) ? ut.attributes : [];
    if (attrs.includes('medicaltransport')) medUnits.push(r.id);
    if (attrs.includes('prisonertransport')) prisUnits.push(r.id);
  }

  const medTransports = Math.min(patientCount, medUnits.length);
  for (let i = 0; i < medTransports; i++) {
    await allocateTransport('patient', lat, lon, 'ambulance');
    await adjustBalance(500);
  }

  const prisTransports = Math.min(prisonerCount, prisUnits.length);
  for (let i = 0; i < prisTransports; i++) {
    await allocateTransport('prisoner', lat, lon, 'police');
    await adjustBalance(500);
  }
}

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
              db.run(`UPDATE units SET status='available', responding=0 WHERE id IN (${placeholders})`, ids, (e) => e ? reject(e) : resolve()))
          : Promise.resolve();

        const clearTravels = ids.length
          ? new Promise((resolve, reject) =>
              db.run(`DELETE FROM unit_travel WHERE unit_id IN (${placeholders})`, ids, (e) => e ? reject(e) : resolve()))
          : Promise.resolve();

        try {
          await freeUnits;
          await clearTravels;
          db.run('DELETE FROM mission_units WHERE mission_id=?', [missionId], (e2) => {
            if (e2) return cb && cb(e2);

            db.get('SELECT type, lat, lon, patients, prisoners, penalties FROM missions WHERE id=?', [missionId], (e3, m) => {
              if (e3) return cb && cb(e3);
              const missionName = m?.type || '';
              let pats = []; let pris = [];
              try { pats = JSON.parse(m?.patients || '[]'); } catch {}
              try { pris = JSON.parse(m?.prisoners || '[]'); } catch {}
              let penalties = [];
              try { penalties = JSON.parse(m?.penalties || '[]'); } catch {}
              db.get('SELECT rewards FROM mission_templates WHERE name=?', [missionName], async (e4, trow) => {
                if (e4) return cb && cb(e4);
                const baseReward = Number(trow?.rewards || 0);
                const rewardPenalty = penalties.reduce((s,p)=> s + (Number(p.rewardPenalty)||0),0);
                const reward = Math.max(0, baseReward * (1 - rewardPenalty/100));
                try {
                  if (reward > 0) await adjustBalance(+reward);
                  await handleTransports(ids, m.lat, m.lon, pats, pris);
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

const { missionClocks, beginMissionClock, clearMissionClock, rehydrateMissionClocks } = require('./services/missionTimers');
rehydrateMissionClocks();

function missionRequirementsMet(mission, assigned) {
  const unitOnScene = new Map();
  const equipOnScene = new Map();
  const trainOnScene = new Map();

  for (const u of assigned) {
    // Normalize status so minor formatting differences (case, spaces, missing
    // underscores) don't cause us to overlook units that have actually
    // arrived at the scene. Legacy clients may send "onscene" or other
    // variants; treat them all as "on_scene".
    const normStatus = String(u.status || '')
      .toLowerCase()
      .replace(/\s+/g, '_');
    if (normStatus !== 'on_scene' && normStatus !== 'onscene') continue;
    unitOnScene.set(u.type, (unitOnScene.get(u.type) || 0) + 1);

    const eqArr = parseArrayField(u.equipment);
    for (const e of eqArr) {
      equipOnScene.set(e, (equipOnScene.get(e) || 0) + 1);
    }

    const personnel = parseArrayField(u.personnel);
    for (const p of personnel) {
      const tList = Array.isArray(p.training) ? p.training : parseArrayField(p.training);
      for (const t of tList) {
        trainOnScene.set(t, (trainOnScene.get(t) || 0) + 1);
      }
    }
  }

  const penalties = parseArrayField(mission.penalties);
  const reqUnits = parseArrayField(mission.required_units).map(r => {
    const types = Array.isArray(r.types) ? r.types : (r.type ? [r.type] : []);
    const ignored = penalties
      .filter(p => types.includes(p.type))
      .reduce((s, p) => s + (Number(p.quantity) || 0), 0);
    const qty = Math.max(0, (r.quantity ?? r.count ?? 1) - ignored);
    return { ...r, quantity: qty, types };
  });
  const reqEquip = parseArrayField(mission.equipment_required);
  const reqTrain = parseArrayField(mission.required_training);

  const unitsMet = reqUnits.every(r => {
    const count = r.types.reduce((s, t) => s + (unitOnScene.get(t) || 0), 0);
    return count >= (r.quantity ?? r.count ?? 1);
  });
  const equipMet = reqEquip.every(r => {
    const name = r.name || r.type || r;
    const need = r.qty ?? r.quantity ?? r.count ?? 1;
    return (equipOnScene.get(name) || 0) >= need;
  });
  const trainMet = reqTrain.every(r => {
    const name = r.training || r.name || r;
    const need = r.qty ?? r.quantity ?? r.count ?? 1;
    return (trainOnScene.get(name) || 0) >= need;
  });

  return unitsMet && equipMet && trainMet;
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

// Provide a random first/last name from names.db
app.get('/api/random-name', async (req, res) => {
  try {
    const { first, last } = await getRandomName();
    res.json({ first, last });
  } catch (e) {
    res.status(500).json({ error: 'Failed to fetch name' });
  }
});

/* =========================
   POIs (Overpass)
   ========================= */
app.get('/api/pois', async (req, res) => {
  const { lat, lon, radius } = req.query;
  try {
    const response = await axios.get(`https://overpass-api.de/api/interpreter`, {
      params: {
        data: `[out:json];(node(around:${radius},${lat},${lon})["amenity"];node(around:${radius},${lat},${lon})["building"];node(around:${radius},${lat},${lon})["leisure"];node(around:${radius},${lat},${lon})["tourism"];node(around:${radius},${lat},${lon})["shop"];node(around:${radius},${lat},${lon})["aeroway"];node(around:${radius},${lat},${lon})["landuse"];node(around:${radius},${lat},${lon})["office"];node(around:${radius},${lat},${lon})["man_made"];);out;`
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
    const { station_id, class: unitClass, type, name, tag } = req.body || {};
    let { priority } = req.body || {};
    if (!station_id || !unitClass || !type || !name)
      return res.status(400).json({ error: 'station_id, class, type, name are required' });

    priority = Number(priority);
    if (!Number.isFinite(priority)) priority = 1;
    priority = Math.min(5, Math.max(1, priority));

    const usage = await stationBayUsage(Number(station_id));
    if (!usage.ok) return res.status(404).json({ error: usage.reason });
    if (usage.used >= usage.bays) return res.status(409).json({ error: 'No free bays at station' });

    const cost = findUnitCostByType(type) || 0;
    const ok = await requireFunds(cost);
    if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: cost });

    db.run(
      `INSERT INTO units (station_id, class, type, name, tag, priority, status) VALUES (?,?,?,?,?,?, 'available')`,
      [station_id, unitClass, type, name, tag, priority],
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
/*
app.get('/api/missions', (req, res) => {
  const sql = `
    SELECT m.*, 
           SUM(CASE WHEN u.status = 'enroute' THEN 1 ELSE 0 END) AS responding_count,
           SUM(CASE WHEN u.status IN ('enroute','on_scene') THEN 1 ELSE 0 END) AS assigned_count
    FROM missions m
    LEFT JOIN mission_units mu ON mu.mission_id = m.id
    LEFT JOIN units u ON u.id = mu.unit_id
    GROUP BY m.id
  `;
  db.all(sql, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const parsed = rows.map(m => ({
      ...m,
      departments: parseArrayField(m.departments),
      required_units: JSON.parse(m.required_units || "[]"),
      required_training: JSON.parse(m.required_training || "[]"),
      equipment_required: JSON.parse(m.equipment_required || "[]"),
      patients: JSON.parse(m.patients || "[]"),
      prisoners: JSON.parse(m.prisoners || "[]"),
      modifiers: JSON.parse(m.modifiers || "[]"),
      penalty_options: JSON.parse(m.penalty_options || "[]"),
      penalties: JSON.parse(m.penalties || "[]"),
      timing: typeof m.timing === 'number' ? m.timing : 10,
      resolve_at: m.resolve_at != null ? Number(m.resolve_at) : null,
      non_emergency: m.non_emergency === 1 || m.non_emergency === true,
      responding_count: Number(m.responding_count) || 0,
      assigned_count: Number(m.assigned_count) || 0
    }));
    res.json(parsed);
  });
});

app.post('/api/missions', async (req, res) => {
  const {
    type, lat, lon,
    required_units = [], required_training = [],
    equipment_required = [], patients = [], prisoners = [], modifiers = [],
    penalty_options = [], penalties = [],
    timing = 10,
    non_emergency = null
  } = req.body;

  const address = await reverseGeocode(lat, lon);

  db.all('SELECT * FROM response_zones', (err, zones) => {
    if (err) return res.status(500).json({ error: err.message });

    const departmentSet = new Set();
    zones.forEach(z => {
      try {
        const poly = JSON.parse(z.polygon || '{}');
        if (pointInPolygon(lat, lon, poly)) {
          parseArrayField(z.departments).forEach(d => departmentSet.add(d));
        }
      } catch {}
    });
    const departments = Array.from(departmentSet);

    db.run(`
      INSERT INTO missions
      (type, lat, lon, address, departments, required_units, required_training, equipment_required, patients, prisoners, modifiers, penalty_options, penalties, status, timing, non_emergency)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      type, lat, lon, address,
      JSON.stringify(departments),
      JSON.stringify(required_units),
      JSON.stringify(required_training),
      JSON.stringify(equipment_required),
      JSON.stringify(patients),
      JSON.stringify(prisoners),
      JSON.stringify(modifiers),
      JSON.stringify(penalty_options),
      JSON.stringify(penalties),
      'active',
      timing,
      non_emergency ? 1 : null
    ],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        id: this.lastID,
        type, lat, lon, address,
        departments,
        required_units, required_training, equipment_required, patients, prisoners, modifiers,
        penalty_options, penalties,
        status: 'active',
        timing
      });
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
  db.all(
    `SELECT
       u.id, u.station_id, u.class, u.type, u.name, u.status, u.responding, u.icon, u.responding_icon, u.equipment,
       MIN(ut.started_at) AS travel_started_at,
       MIN(ut.total_duration) AS travel_total_duration,
       COALESCE(json_group_array(
         json_object('id', p.id, 'name', p.name, 'training', p.training)
       ), '[]') AS personnel
     FROM mission_units mu
     JOIN units u ON u.id = mu.unit_id
     LEFT JOIN unit_travel ut ON ut.unit_id = mu.unit_id
       AND ut.phase = 'to_scene'
       AND ut.mission_id = mu.mission_id
       AND (strftime('%s','now') - strftime('%s', ut.started_at)) < ut.total_duration
     LEFT JOIN personnel p ON p.unit_id = u.id
     WHERE mu.mission_id = ?
     GROUP BY u.id`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const parsed = rows.map(r => {
        const { travel_started_at, travel_total_duration, ...rest } = r;
        const base = {
          ...rest,
          responding: r.responding === 1 || r.responding === true,
          equipment: (()=>{ try { return JSON.parse(r.equipment||'[]'); } catch { return []; } })(),
          personnel: (()=>{
            try {
              return JSON.parse(r.personnel||'[]').map(p => ({
                ...p,
                training: (()=>{ try { return JSON.parse(p.training||'[]'); } catch { return []; } })()
              }));
            } catch {
              return [];
            }
          })()
        };
        if (travel_started_at && travel_total_duration) {
          const eta = new Date(travel_started_at).getTime() + Number(travel_total_duration) * 1000;
          if (eta > Date.now()) base.eta = eta;
        }
        return base;
      });
      res.json(parsed);
    }
  );
});

// Fetch a single mission by id
app.get('/api/missions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid mission id' });
  db.get('SELECT * FROM missions WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    const mission = {
      ...row,
      departments: parseArrayField(row.departments),
      required_units: parseArrayField(row.required_units),
      required_training: parseArrayField(row.required_training),
      equipment_required: parseArrayField(row.equipment_required),
      patients: parseArrayField(row.patients),
      prisoners: parseArrayField(row.prisoners),
      modifiers: parseArrayField(row.modifiers),
      penalty_options: parseArrayField(row.penalty_options),
      penalties: parseArrayField(row.penalties),
      timing: typeof row.timing === 'number' ? row.timing : 10,
      resolve_at: row.resolve_at != null ? Number(row.resolve_at) : null,
      non_emergency: row.non_emergency === 1 || row.non_emergency === true,
    };
    res.json(mission);
  });
});

// Update penalties for a mission
app.patch('/api/missions/:id/penalties', express.json(), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid mission id' });
  const penalties = JSON.stringify(req.body?.penalties || []);
  db.run('UPDATE missions SET penalties=? WHERE id=?', [penalties, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, penalties: JSON.parse(penalties) });
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
    db.get('SELECT non_emergency FROM missions WHERE id=?', [missionId], (err, m) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!m) return res.status(404).json({ error: 'mission not found' });
        const responding = m.non_emergency ? 0 : 1;
        db.run(`INSERT INTO mission_units (mission_id, unit_id) VALUES (?, ?)`, [missionId, unitId], function (err2) {
            if (err2) return res.status(500).json({ error: err2.message });
            db.run(`UPDATE units SET status = 'enroute', responding=? WHERE id = ?`, [responding, unitId], function (err3) {
                if (err3) return res.status(500).json({ error: err3.message });
                res.json({ success: true });
            });
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

// Start or clear mission timers
app.post('/api/missions/:id/timer', (req, res) => {
  const missionId = parseInt(req.params.id, 10);
  if (!missionId) return res.status(400).json({ error: 'invalid id' });
  beginMissionClock(missionId, end => {
    if (!end) return res.status(404).json({ error: 'mission not found' });
    res.json({ resolve_at: end });
  });
});

app.patch('/api/missions/:id/timer', (req, res) => {
  const missionId = parseInt(req.params.id, 10);
  if (!missionId) return res.status(400).json({ error: 'invalid id' });
  const reduction = Math.max(-100, Math.min(100, Number(req.body?.reduction) || 0));
  const clk = missionClocks.get(missionId);
  if (!clk) return res.status(404).json({ error: 'timer not running' });
  const now = Date.now();
  const elapsed = now - clk.startedAt;
  const remaining = Math.max(0, clk.baseDuration - elapsed);
  const newRemaining = remaining * (1 - reduction / 100);
  const endAt = now + newRemaining;
  clk.endAt = endAt;
  db.run('UPDATE missions SET resolve_at=? WHERE id=?', [endAt, missionId], err => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ resolve_at: endAt });
  });
});

*/
/* Missions routes moved to routes/missions.js */

// Additional mission endpoints not yet migrated to modular routes
app.get('/api/missions/:id/units', (req, res) => {
  db.all(
    `SELECT
       u.id, u.station_id, u.class, u.type, u.name, u.status, u.responding, u.icon, u.responding_icon, u.equipment,
       MIN(ut.started_at) AS travel_started_at,
       MIN(ut.total_duration) AS travel_total_duration,
       COALESCE(json_group_array(
         json_object('id', p.id, 'name', p.name, 'training', p.training)
       ), '[]') AS personnel
     FROM mission_units mu
     JOIN units u ON u.id = mu.unit_id
     LEFT JOIN unit_travel ut ON ut.unit_id = mu.unit_id
       AND ut.phase = 'to_scene'
       AND ut.mission_id = mu.mission_id
       AND (strftime('%s','now') - strftime('%s', ut.started_at)) < ut.total_duration
     LEFT JOIN personnel p ON p.unit_id = u.id
     WHERE mu.mission_id = ?
     GROUP BY u.id`,
    [req.params.id],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const parsed = rows.map(r => {
        const { travel_started_at, travel_total_duration, ...rest } = r;
        const base = {
          ...rest,
          responding: r.responding === 1 || r.responding === true,
          equipment: (()=>{ try { return JSON.parse(r.equipment||'[]'); } catch { return []; } })(),
          personnel: (()=>{
            try {
              return JSON.parse(r.personnel||'[]').map(p => ({
                ...p,
                training: (()=>{ try { return JSON.parse(p.training||'[]'); } catch { return []; } })()
              }));
            } catch {
              return [];
            }
          })()
        };
        if (travel_started_at && travel_total_duration) {
          const eta = new Date(travel_started_at).getTime() + Number(travel_total_duration) * 1000;
          if (eta > Date.now()) base.eta = eta;
        }
        return base;
      });
      res.json(parsed);
    }
  );
});

// Fetch a single mission by id
app.get('/api/missions/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid mission id' });
  db.get('SELECT * FROM missions WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    const mission = {
      ...row,
      departments: parseArrayField(row.departments),
      required_units: parseArrayField(row.required_units),
      required_training: parseArrayField(row.required_training),
      equipment_required: parseArrayField(row.equipment_required),
      patients: parseArrayField(row.patients),
      prisoners: parseArrayField(row.prisoners),
      modifiers: parseArrayField(row.modifiers),
      penalty_options: parseArrayField(row.penalty_options),
      penalties: parseArrayField(row.penalties),
      timing: typeof row.timing === 'number' ? row.timing : 10,
      resolve_at: row.resolve_at != null ? Number(row.resolve_at) : null,
      non_emergency: row.non_emergency === 1 || row.non_emergency === true,
    };
    res.json(mission);
  });
});

// Update penalties for a mission
app.patch('/api/missions/:id/penalties', express.json(), (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid mission id' });
  const penalties = JSON.stringify(req.body?.penalties || []);
  db.run('UPDATE missions SET penalties=? WHERE id=?', [penalties, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id, penalties: JSON.parse(penalties) });
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
/*
app.get('/api/stations', async (req, res) => {
  try {
    const rows = await new Promise((resolve, reject) => {
      db.all('SELECT * FROM stations', (err, r) => (err ? reject(err) : resolve(r)));
    });
    for (const r of rows) {
      try { r.equipment = JSON.parse(r.equipment || '[]'); } catch { r.equipment = []; }
      if (r.type === 'hospital') {
        const occ = await getFacilityOccupancy(r.id, 'patient');
        r.occupied_beds = occ.count;
      } else if (r.type === 'jail' || (r.type === 'police' && Number(r.holding_cells) > 0)) {
        const occ = await getFacilityOccupancy(r.id, 'prisoner');
        r.occupied_cells = occ.count;
      }
    }
    res.json(rows);
  } catch (e) {
    res.status(500).send('Error reading stations');
  }
});

app.get('/api/stations/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  try {
    const row = await new Promise((resolve, reject) => {
      db.get('SELECT * FROM stations WHERE id=?', [id], (err, r) => (err ? reject(err) : resolve(r)));
    });
    if (!row) return res.status(404).json({ error: 'Station not found' });
    try { row.equipment = JSON.parse(row.equipment || '[]'); } catch { row.equipment = []; }
    if (row.type === 'hospital') {
      const occ = await getFacilityOccupancy(id, 'patient');
      row.occupied_beds = occ.count;
    } else if (row.type === 'jail' || (row.type === 'police' && Number(row.holding_cells) > 0)) {
      const occ = await getFacilityOccupancy(id, 'prisoner');
      row.occupied_cells = occ.count;
    }
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const { name, type, lat, lon, department = null, beds = 0, holding_cells = 0 } = req.body || {};
    const BUILD_COST = 50000;
    const holdingCost = (type === 'police' || type === 'jail') ? priceHolding(holding_cells, false) : 0;
    const totalCost = BUILD_COST + holdingCost;

    const ok = await requireFunds(totalCost);
    if (!ok.ok) return res.status(409).json({ error: 'Insufficient funds', balance: ok.balance, needed: totalCost });

    db.run('INSERT INTO stations (name, type, lat, lon, department, bay_count, equipment_slots, holding_cells, bed_capacity) VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?)',
      [name, type, lat, lon, department, holding_cells, beds],
      async function (err) {
        if (err) return res.status(500).send('Failed to insert station');
        await adjustBalance(-totalCost);
        const balance = await getBalance();
        res.json({ id: this.lastID, name, type, lat, lon, department, bay_count: 0, equipment_slots: 0, holding_cells, bed_capacity: beds, equipment: [], charged: totalCost, balance });

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
// PATCH /api/stations/:id/icon  { icon: <string> }
app.patch('/api/stations/:id/icon', (req, res) => {
  const id = Number(req.params.id);
  const icon = String(req.body?.icon || '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  if (icon.length > 2048) return res.status(400).json({ error: 'Icon URL too long' });
  db.run(`UPDATE stations SET icon=? WHERE id=?`, [icon, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id, icon });
  });
});

// PATCH /api/stations/:id/department  { department: <string> }
app.patch('/api/stations/:id/department', (req, res) => {
  const id = Number(req.params.id);
  const department = String(req.body?.department || '').trim();
  if (!id) return res.status(400).json({ error: 'Invalid station id' });
  db.run(`UPDATE stations SET department=? WHERE id=?`, [department, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id, department });
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
*/

/* =========================
   Units
   ========================= */
/*
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

    // Load all personnel and group them by unit
    db.all('SELECT * FROM personnel', [], (err2, pers) => {
      if (err2) return res.status(500).json({ error: err2.message });
      const byUnit = new Map();
      for (const p of pers) {
        if (!p.unit_id) continue;
        let list = byUnit.get(p.unit_id);
        if (!list) { list = []; byUnit.set(p.unit_id, list); }
        let training;
        try { training = JSON.parse(p.training || '[]'); }
        catch { training = []; }
        list.push({ ...p, training });
      }

      const parsed = rows.map(u => ({
        ...u,
        priority: Number(u.priority) || 1,
        patrol: u.patrol === 1 || u.patrol === true,
        responding: u.responding === 1 || u.responding === true,
        equipment: (() => { try { return JSON.parse(u.equipment || '[]'); } catch { return []; } })(),
        personnel: byUnit.get(u.id) || [],
      }));
      res.json(parsed);
    });
  });
});

app.get('/api/units/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid unit id' });
  db.get('SELECT * FROM units WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    let equipment;
    try { equipment = JSON.parse(row.equipment || '[]'); }
    catch { equipment = []; }
    const parsed = {
      ...row,
      priority: Number(row.priority) || 1,
      patrol: row.patrol === 1 || row.patrol === true,
      responding: row.responding === 1 || row.responding === true,
      equipment
    };
    res.json(parsed);
  });
});

// Update basic unit fields (e.g., name/type)
app.patch('/api/units/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid unit id' });

  const fields = [];
  const params = [];
  if (req.body.name !== undefined) { fields.push('name = ?'); params.push(req.body.name); }
  if (req.body.type !== undefined) { fields.push('type = ?'); params.push(req.body.type); }
  if (req.body.class !== undefined) { fields.push('class = ?'); params.push(req.body.class); }
  if (req.body.tag !== undefined) { fields.push('tag = ?'); params.push(req.body.tag); }
  if (req.body.priority !== undefined) {
    let pr = Number(req.body.priority);
    if (!Number.isFinite(pr)) pr = 1;
    pr = Math.min(5, Math.max(1, pr));
    fields.push('priority = ?');
    params.push(pr);
  }
  if (!fields.length) return res.status(400).json({ error: 'No updatable fields provided' });

  params.push(id);
  const sql = `UPDATE units SET ${fields.join(', ')} WHERE id = ?`;
  db.run(sql, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, changed: this.changes });
  });
});

// Get mission (if any) that a unit is assigned to
app.get('/api/units/:id/mission', (req, res) => {
  const unitId = Number(req.params.id);
  if (!unitId) return res.status(400).json({ error: 'Invalid unit id' });
  db.get(
    `SELECT m.* FROM mission_units mu JOIN missions m ON m.id = mu.mission_id WHERE mu.unit_id = ?`,
    [unitId],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.json(null);
      const mission = {
        ...row,
        required_units: parseArrayField(row.required_units),
        required_training: parseArrayField(row.required_training),
        equipment_required: parseArrayField(row.equipment_required),
        patients: parseArrayField(row.patients),
        prisoners: parseArrayField(row.prisoners),
        modifiers: parseArrayField(row.modifiers),
        timing: typeof row.timing === 'number' ? row.timing : 10,
        non_emergency: row.non_emergency === 1 || row.non_emergency === true,
      };
      res.json(mission);
    }
  );
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

// Remove equipment from a unit back to station storage
app.delete('/api/units/:id/equipment', (req, res) => {
  const unitId = Number(req.params.id);
  const stationId = Number(req.body?.station_id);
  const name = String(req.body?.name || '').trim();
  if (!unitId || !stationId || !name) {
    return res.status(400).json({ error: 'unit_id, station_id and name are required' });
  }

  db.get(`SELECT equipment, equipment_slots FROM stations WHERE id=?`, [stationId], (err, st) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!st) return res.status(404).json({ error: 'Station not found' });
    let stList; try { stList = JSON.parse(st.equipment || '[]'); } catch { stList = []; }
    const slots = Number(st.equipment_slots || 0);

    db.get(`SELECT equipment FROM units WHERE id=?`, [unitId], (err2, u) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (!u) return res.status(404).json({ error: 'Unit not found' });
      let uList; try { uList = JSON.parse(u.equipment || '[]'); } catch { uList = []; }
      const idx = uList.indexOf(name);
      if (idx === -1) return res.status(404).json({ error: 'Equipment not found on unit' });
      if (slots && stList.length >= slots) return res.status(409).json({ error: 'No free equipment slots' });

      uList.splice(idx, 1);
      stList.push(name);
      db.serialize(() => {
        db.run(`UPDATE units SET equipment=? WHERE id=?`, [JSON.stringify(uList), unitId]);
        db.run(`UPDATE stations SET equipment=? WHERE id=?`, [JSON.stringify(stList), stationId], function (e3) {
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
  let { status } = req.body || {};
  const id = parseInt(req.params.id, 10);
  if (!id || !status) return res.status(400).json({ error: 'id and status required' });

  // Normalize legacy status value without underscore.
  if (status === 'onscene') status = 'on_scene';

  if (status === 'enroute') {
    db.get('SELECT m.non_emergency FROM mission_units mu JOIN missions m ON m.id = mu.mission_id WHERE mu.unit_id=?', [id], (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      const responding = row && row.non_emergency ? 0 : 1;
      db.run('UPDATE units SET status=?, responding=? WHERE id=?', [status, responding, id], function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ ok: true, status, responding: Boolean(responding) });
      });
    });
  } else {
    db.run('UPDATE units SET status=?, responding=0 WHERE id=?', [status, id], function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true, status, responding: false });
    });
  }
});

// Toggle unit patrol flag
app.patch('/api/units/:id/patrol', (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid unit id' });
  const patrol = req.body && req.body.patrol ? 1 : 0;
  db.run('UPDATE units SET patrol=? WHERE id=?', [patrol, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, patrol: Boolean(patrol) });
  });
});
// PATCH /api/units/:id/icon  { icon: <string> }
app.patch('/api/units/:id/icon', (req, res) => {
  const id = Number(req.params.id);
  const icon = req.body?.icon !== undefined ? String(req.body.icon).trim() : undefined;
  const respondingIcon = req.body?.responding_icon !== undefined ? String(req.body.responding_icon).trim() : undefined;
  if (!id) return res.status(400).json({ error: 'Invalid unit id' });
  if (icon !== undefined && icon.length > 2048) return res.status(400).json({ error: 'Icon URL too long' });
  if (respondingIcon !== undefined && respondingIcon.length > 2048) return res.status(400).json({ error: 'Icon URL too long' });
  const sets = [];
  const params = [];
  if (icon !== undefined) { sets.push('icon=?'); params.push(icon); }
  if (respondingIcon !== undefined) { sets.push('responding_icon=?'); params.push(respondingIcon); }
  if (!sets.length) return res.status(400).json({ error: 'No icon provided' });
  params.push(id);
  db.run(`UPDATE units SET ${sets.join(', ')} WHERE id=?`, params, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, id, icon, responding_icon: respondingIcon });
  });
});

// Cancel unit: free it from any mission and set available
app.post('/api/units/:id/cancel', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'invalid id' });
  db.serialize(() => {
    db.all('SELECT mission_id FROM mission_units WHERE unit_id=?', [id], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const missions = rows.map(r => r.mission_id);
      db.run('DELETE FROM mission_units WHERE unit_id=?', [id]);
      db.run('DELETE FROM unit_travel WHERE unit_id=?', [id]);
      db.run('UPDATE units SET status=?, responding=0 WHERE id=?', ['available', id], function (err2) {
        if (err2) return res.status(500).json({ error: err2.message });
        res.json({ ok: true, missions });
      });
    });
  });
});
*/

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
      required_units: parseArrayField(row.required_units),
      patients: parseArrayField(row.patients),
      prisoners: parseArrayField(row.prisoners),
      modifiers: parseArrayField(row.modifiers),
      required_training: parseArrayField(row.required_training),
      equipment_required: parseArrayField(row.equipment_required),
      penalty_options: parseArrayField(row.penalty_options),
      rewards: Number.isFinite(row.rewards) ? row.rewards : 0,
      non_emergency: row.non_emergency === 1 || row.non_emergency === true,
      frequency: Number.isFinite(row.frequency) ? row.frequency : 3
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
    penalty_options: JSON.stringify(b.penalty_options || []),
    rewards: Number(b.rewards) || 0,
    non_emergency: b.non_emergency ? 1 : null,
    frequency: Math.min(5, Math.max(1, Number(b.frequency) || 3))
  };
  db.run(
    `INSERT INTO mission_templates
     (name, trigger_type, trigger_filter, timing,
      required_units, patients, prisoners, required_training, modifiers, equipment_required, penalty_options, rewards, non_emergency, frequency)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [fields.name, fields.trigger_type, fields.trigger_filter, fields.timing,
     fields.required_units, fields.patients, fields.prisoners, fields.required_training,
     fields.modifiers, fields.equipment_required, fields.penalty_options, fields.rewards, fields.non_emergency, fields.frequency],
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
    penalty_options: JSON.stringify(b.penalty_options || []),
    rewards: Number(b.rewards) || 0,
    non_emergency: b.non_emergency ? 1 : null,
    frequency: Math.min(5, Math.max(1, Number(b.frequency) || 3))
  };
  db.run(
    `UPDATE mission_templates SET
      name=?, trigger_type=?, trigger_filter=?, timing=?,
      required_units=?, patients=?, prisoners=?, required_training=?,
      modifiers=?, equipment_required=?, penalty_options=?, rewards=?, non_emergency=?, frequency=?
     WHERE id=?`,
    [fields.name, fields.trigger_type, fields.trigger_filter, fields.timing,
     fields.required_units, fields.patients, fields.prisoners, fields.required_training,
     fields.modifiers, fields.equipment_required, fields.penalty_options, fields.rewards, fields.non_emergency, fields.frequency, id],
    function(err){
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id, ...fields });
    }
  );
});


app.get('/api/mission-templates/id/:id', (req, res) => {
  db.get(`SELECT id, name, trigger_type, trigger_filter, timing,
                 required_units, patients, prisoners, required_training,
                 modifiers, equipment_required, penalty_options, rewards, non_emergency, frequency
          FROM mission_templates WHERE id=?`, [req.params.id], (err, r) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!r)   return res.status(404).json({ error: "Not found" });
    r.required_units = parseArrayField(r.required_units);
    r.patients = parseArrayField(r.patients);
    r.prisoners = parseArrayField(r.prisoners);
    r.required_training = parseArrayField(r.required_training);
    r.modifiers = parseArrayField(r.modifiers);
    r.equipment_required = parseArrayField(r.equipment_required);
    r.penalty_options = parseArrayField(r.penalty_options);
    r.rewards = Number.isFinite(r.rewards) ? r.rewards : 0;
    r.non_emergency = r.non_emergency === 1 || r.non_emergency === true;
    r.frequency = Number.isFinite(r.frequency) ? r.frequency : 3;
    res.json(r);
  });
});

// Run card endpoints
app.get('/api/run-cards/:name', (req, res) => {
  db.get('SELECT units, training, equipment FROM run_cards WHERE mission_name=?', [req.params.name], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    const units = parseArrayField(row.units);
    const training = parseArrayField(row.training);
    const equipment = parseArrayField(row.equipment);
    res.json({ units, training, equipment });
  });
});

app.put('/api/run-cards/:name', express.json(), (req, res) => {
  const b = req.body || {};
  const units = JSON.stringify(b.units || []);
  const training = JSON.stringify(b.training || []);
  const equipment = JSON.stringify(b.equipment || []);
  db.run(
    `INSERT INTO run_cards (mission_name, units, training, equipment)
     VALUES (?,?,?,?)
     ON CONFLICT(mission_name) DO UPDATE SET
       units=excluded.units,
       training=excluded.training,
       equipment=excluded.equipment`,
    [req.params.name, units, training, equipment],
    err => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ ok: true });
    }
  );
});

/* =========================
   Mission ↔ Unit assignment
   (with global busy guard)
   ========================= */
app.post('/api/mission-units', (req, res) => {
  const { mission_id, unit_id, force } = req.body || {};
  if (!mission_id || !unit_id) return res.status(400).json({ error: 'mission_id and unit_id are required' });

  // Guard: prevent double-dispatch across all missions and fetch department
  db.get(
    'SELECT u.status, s.department FROM units u LEFT JOIN stations s ON u.station_id = s.id WHERE u.id=?',
    [unit_id],
    (e, unitRow) => {
      if (e) return res.status(500).json({ error: e.message });
      if (!unitRow) return res.status(404).json({ error: 'unit not found' });
      if (unitRow.status !== 'available') return res.status(409).json({ error: 'unit busy' });

      // Prevent duplicates for same mission
      db.get('SELECT id FROM mission_units WHERE mission_id=? AND unit_id=?', [mission_id, unit_id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row) return res.json({ ok: true, alreadyAssigned: true });

        db.get('SELECT non_emergency, departments FROM missions WHERE id=?', [mission_id], (err2, m) => {
          if (err2) return res.status(500).json({ error: err2.message });
          if (!m) return res.status(404).json({ error: 'mission not found' });

          const allowed = parseArrayField(m.departments);
          if (!force && allowed.length && !allowed.includes(unitRow.department)) {
            return res.status(403).json({ error: 'department not allowed' });
          }

          const responding = m.non_emergency ? 0 : 1;
          db.run('INSERT INTO mission_units (mission_id, unit_id) VALUES (?, ?)', [mission_id, unit_id], function (err3) {
            if (err3) return res.status(500).json({ error: err3.message });
            // Flip unit to enroute immediately (front-end may PATCH too, that’s fine)
            db.run('UPDATE units SET status=?, responding=? WHERE id=?', ['enroute', responding, unit_id], () =>
              res.json({ ok: true, id: this?.lastID })
            );
          });
        });
      });
    }
  );
});

app.delete('/api/mission-units', (req, res) => {
  const { mission_id, unit_id } = req.body || {};
  if (!mission_id || !unit_id) return res.status(400).json({ error: 'mission_id and unit_id are required' });

  db.run('DELETE FROM mission_units WHERE mission_id = ? AND unit_id = ?', [mission_id, unit_id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    const removed = this.changes;
    db.run('DELETE FROM unit_travel WHERE unit_id=?', [unit_id], err2 => {
      if (err2) return res.status(500).json({ error: err2.message });
      // Optional: set available immediately (or let arrival back at station do it)
      db.run('UPDATE units SET status=?, responding=0 WHERE id=?', ['available', unit_id], () =>
        res.json({ ok: true, removed })
      );
    });
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
        db.run('UPDATE units SET status=?, responding=0 WHERE id=?', ['on_scene', unit_id], () => {});
        db.run('DELETE FROM unit_travel WHERE unit_id=?', [unit_id], () => {});
        if (mission_id) {
          db.run('UPDATE missions SET status=? WHERE id=?', ['on_scene', mission_id], () => {});
        }
      } else if (phase === 'return') {
        db.run('UPDATE units SET status=?, responding=0 WHERE id=?', ['available', unit_id], () => {});
        db.run('DELETE FROM unit_travel WHERE unit_id=?', [unit_id], () => {});
      }
    }

    res.json({ ok: true });
  });
});

function processUnitTravels(rows) {
  const now = Date.now();
  const active = [];
  const afterOps = [];

  for (const r of rows || []) {
    const elapsed = (now - new Date(r.started_at).getTime()) / 1000;
    const done = elapsed >= Number(r.total_duration || 0);

    if (done) {
      if (r.phase === 'to_scene') {
        afterOps.push(new Promise(resolve => {
          const finalize = resolved => {
            const unitStatus = resolved ? 'available' : 'on_scene';
            db.run('UPDATE units SET status=?, responding=0 WHERE id=?', [unitStatus, r.unit_id], () => {
              db.run('DELETE FROM unit_travel WHERE unit_id=?', [r.unit_id], () => {
                if (!resolved && r.mission_id) {
                  db.run('UPDATE missions SET status=? WHERE id=?', ['on_scene', r.mission_id], () => resolve());
                } else resolve();
              });
            });
          };

          if (r.mission_id) {
            db.get('SELECT status FROM missions WHERE id=?', [r.mission_id], (e, row) => {
              const resolved = e || !row || row.status === 'resolved';
              finalize(resolved);
            });
          } else {
            finalize(true);
          }
        }));
      } else if (r.phase === 'return') {
        afterOps.push(new Promise(resolve => {
          db.run('UPDATE units SET status=?, responding=0 WHERE id=?', ['available', r.unit_id], () => {
            db.run('DELETE FROM unit_travel WHERE unit_id=?', [r.unit_id], () => resolve());
          });
        }));
      }
      continue;
    }

    active.push({
      unit_id: r.unit_id,
      mission_id: r.mission_id,
      phase: r.phase,
      started_at: new Date(r.started_at).getTime(),
      from: [r.from_lat, r.from_lon],
      to: [r.to_lat, r.to_lon],
      coords: JSON.parse(r.coords || '[]'),
      seg_durations: JSON.parse(r.seg_durations || '[]'),
      total_duration: r.total_duration
    });
  }

  return { active, afterOps };
}

// Return only travels still in progress (elapsed < total_duration)
app.get('/api/unit-travel/active', (req, res) => {
  db.all('SELECT * FROM unit_travel', (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const { active, afterOps } = processUnitTravels(rows);
    Promise.all(afterOps)
      .then(() => res.json(active))
      .catch(e => res.status(500).json({ error: e.message }));
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

app.get('/api/response-zones', (req, res) => {
  db.all('SELECT * FROM response_zones', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const zones = rows.map(r => ({
      ...r,
      departments: parseArrayField(r.departments),
      polygon: (() => { try { return JSON.parse(r.polygon || '{}'); } catch { return {}; } })()
    }));
    res.json(zones);
  });
});

app.post('/api/response-zones', (req, res) => {
  const { name, departments, polygon } = req.body;
  if (!name || !polygon) {
    return res.status(400).json({ error: 'Missing fields' });
  }
  const deptArr = Array.isArray(departments) ? departments : [];
  db.run(
    `INSERT INTO response_zones (name, departments, station_id, polygon) VALUES (?,?,?,?)`,
    [name, JSON.stringify(deptArr), null, JSON.stringify(polygon)],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id: this.lastID });
    }
  );
});

app.put('/api/response-zones/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, departments, polygon } = req.body;
  if (!id) return res.status(400).json({ error: 'Invalid id' });
  const deptArr = Array.isArray(departments) ? departments : [];
  db.run(
    `UPDATE response_zones SET name=?, departments=?, polygon=? WHERE id=?`,
    [name, JSON.stringify(deptArr), JSON.stringify(polygon), id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ id });
    }
  );
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

// Periodically process unit travel arrivals/returns so missions can progress
setInterval(() => {
  db.all('SELECT * FROM unit_travel', (err, rows) => {
    if (err || !rows) return;
    const { afterOps } = processUnitTravels(rows);
    if (afterOps.length) Promise.all(afterOps).catch(() => {});
  });
}, 1000);

// Periodically check mission requirements and start/stop timers
setInterval(() => {
  db.all(
    `SELECT id, required_units, equipment_required, required_training, penalties, resolve_at
     FROM missions WHERE status != 'resolved'`,
    (err, missions) => {
      if (err || !missions) return;
      missions.forEach(m => {
        db.all(
          `SELECT u.*, COALESCE(json_group_array(json_object('id', p.id, 'name', p.name, 'training', p.training)), '[]') AS personnel
           FROM mission_units mu
           JOIN units u ON u.id = mu.unit_id
           LEFT JOIN personnel p ON p.unit_id = u.id
           WHERE mu.mission_id=?
           GROUP BY u.id`,
          [m.id],
          (e2, units) => {
            if (e2 || !units) return;
            const allMet = missionRequirementsMet(m, units);
            const dbEnd = m.resolve_at != null ? Number(m.resolve_at) : null;
            const hasTimer = missionClocks.has(m.id) || (dbEnd && dbEnd > Date.now());
            if (allMet && !hasTimer) beginMissionClock(m.id);
            else if (!allMet && hasTimer) clearMissionClock(m.id);
          }
        );
      });
    }
  );
}, 2000);

setInterval(() => {
  const now = Date.now();
  db.run('DELETE FROM facility_load WHERE expires_at <= ?', [now]);
}, 60000);

setInterval(() => {
  if (missionClocks.size === 0) return;
  const now = Date.now();
  const due = [];
  for (const [id, clk] of missionClocks.entries()) {
    if (clk && now >= clk.endAt) due.push(id);
  }
  if (!due.length) return;
  due.forEach(id => {
    resolveMissionById(id, () => clearMissionClock(id));
  });
}, 1000);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
