const path = require('node:path');
const fs = require('node:fs');
const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

const dbPath = path.join(__dirname, 'test.sqlite');
if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
process.env.DB_PATH = dbPath;

const db = require('../db');
const missionsController = require('../controllers/missionsController');
const { handleTransports } = require('../services/missions');
const { missionClocks } = require('../services/missionTimers');

function exec(sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, err => (err ? reject(err) : resolve()));
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function createMockRes() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

beforeEach(async () => {
  missionClocks.clear();
  await exec(`
    DROP TABLE IF EXISTS mission_units;
    DROP TABLE IF EXISTS unit_travel;
    DROP TABLE IF EXISTS missions;
    DROP TABLE IF EXISTS mission_templates;
    DROP TABLE IF EXISTS units;
    DROP TABLE IF EXISTS wallet;
    DROP TABLE IF EXISTS facility_load;
    DROP TABLE IF EXISTS stations;

    CREATE TABLE missions (
      id INTEGER PRIMARY KEY,
      type TEXT,
      status TEXT,
      lat REAL,
      lon REAL,
      patients TEXT,
      prisoners TEXT,
      penalties TEXT,
      resolve_at INTEGER
    );

    CREATE TABLE mission_units (
      mission_id INTEGER,
      unit_id INTEGER
    );

    CREATE TABLE unit_travel (
      unit_id INTEGER,
      mission_id INTEGER
    );

    CREATE TABLE mission_templates (
      name TEXT PRIMARY KEY,
      rewards INTEGER
    );

    CREATE TABLE units (
      id INTEGER PRIMARY KEY,
      type TEXT,
      status TEXT,
      responding INTEGER
    );

    CREATE TABLE wallet (
      id INTEGER PRIMARY KEY,
      balance INTEGER
    );

    CREATE TABLE facility_load (
      station_id INTEGER,
      type TEXT,
      expires_at INTEGER
    );

    CREATE TABLE stations (
      id INTEGER PRIMARY KEY,
      lat REAL,
      lon REAL,
      bed_capacity INTEGER,
      holding_cells INTEGER,
      type TEXT
    );
  `);
});

after(async () => {
  await new Promise(resolve => db.close(() => resolve()));
});

test('PUT /api/missions/:id resolves missions and releases resources', async () => {
  const missionId = 1;
  const now = Date.now();

  await run(`INSERT INTO missions (id, type, status, lat, lon, patients, prisoners, penalties, resolve_at) VALUES (?,?,?,?,?,?,?,?,?)`, [
    missionId,
    'Test Mission',
    'active',
    40.0,
    -75.0,
    JSON.stringify([]),
    JSON.stringify([]),
    JSON.stringify([]),
    now + 60000,
  ]);

  await run(`INSERT INTO mission_templates (name, rewards) VALUES (?, ?)`, ['Test Mission', 1000]);

  await run(`INSERT INTO units (id, type, status, responding) VALUES (?,?,?,?)`, [101, 'Ambulance', 'on_scene', 1]);
  await run(`INSERT INTO units (id, type, status, responding) VALUES (?,?,?,?)`, [102, 'Patrol Car', 'on_scene', 1]);

  await run(`INSERT INTO mission_units (mission_id, unit_id) VALUES (?, ?)`, [missionId, 101]);
  await run(`INSERT INTO mission_units (mission_id, unit_id) VALUES (?, ?)`, [missionId, 102]);

  await run(`INSERT INTO unit_travel (unit_id, mission_id) VALUES (?, ?)`, [101, missionId]);
  await run(`INSERT INTO unit_travel (unit_id, mission_id) VALUES (?, ?)`, [102, missionId]);

  await run(`INSERT INTO wallet (id, balance) VALUES (1, ?)`, [500]);

  missionClocks.set(missionId, {
    endAt: now + 60000,
    startedAt: now,
    baseDuration: 60000,
  });

  const req = { params: { id: String(missionId) } };
  const res = createMockRes();

  await missionsController.updateMission(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body?.ok, 'response should include ok flag');
  assert.equal(res.body?.freed, 2);
  assert.equal(res.body?.reward, 1000);
  assert.equal(res.body?.balance, 1500);
  assert.equal(res.body?.patientTransports, 0);
  assert.equal(res.body?.prisonerTransports, 0);
  assert.equal(res.body?.transportReward, 0);

  const unitRows = await all(`SELECT status, responding FROM units ORDER BY id`);
  for (const row of unitRows) {
    assert.equal(row.status, 'available');
    assert.equal(row.responding, 0);
  }

  const remainingAssignments = await all(`SELECT * FROM mission_units WHERE mission_id=?`, [missionId]);
  assert.equal(remainingAssignments.length, 0);

  const remainingTravel = await all(`SELECT * FROM unit_travel WHERE mission_id=?`, [missionId]);
  assert.equal(remainingTravel.length, 0);

  const missionRow = await get(`SELECT status, resolve_at FROM missions WHERE id=?`, [missionId]);
  assert.equal(missionRow.status, 'resolved');
  assert.strictEqual(missionRow.resolve_at, null);

  assert.equal(missionClocks.has(missionId), false);
});

test('PUT /api/missions/:id includes transport summary when transports occur', async () => {
  const missionId = 2;
  const now = Date.now();

  await run(
    `INSERT INTO missions (id, type, status, lat, lon, patients, prisoners, penalties, resolve_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      missionId,
      'Transport Mission',
      'active',
      40.0,
      -75.0,
      JSON.stringify([{ count: 1 }]),
      JSON.stringify([{ transport: 1 }]),
      JSON.stringify([]),
      now + 60000,
    ]
  );

  await run(`INSERT INTO mission_templates (name, rewards) VALUES (?, ?)`, ['Transport Mission', 200]);

  await run(`INSERT INTO units (id, type, status, responding) VALUES (?,?,?,?)`, [201, 'Ambulance', 'on_scene', 1]);
  await run(`INSERT INTO units (id, type, status, responding) VALUES (?,?,?,?)`, [202, 'Patrol Car', 'on_scene', 1]);

  await run(`INSERT INTO mission_units (mission_id, unit_id) VALUES (?, ?)`, [missionId, 201]);
  await run(`INSERT INTO mission_units (mission_id, unit_id) VALUES (?, ?)`, [missionId, 202]);

  await run(`INSERT INTO unit_travel (unit_id, mission_id) VALUES (?, ?)`, [201, missionId]);
  await run(`INSERT INTO unit_travel (unit_id, mission_id) VALUES (?, ?)`, [202, missionId]);

  await run(`INSERT INTO wallet (id, balance) VALUES (1, 0)`);

  await run(
    `INSERT INTO stations (id, lat, lon, bed_capacity, holding_cells, type) VALUES (?,?,?,?,?,?)`,
    [401, 40.0, -75.0, 5, 0, 'hospital']
  );
  await run(
    `INSERT INTO stations (id, lat, lon, bed_capacity, holding_cells, type) VALUES (?,?,?,?,?,?)`,
    [402, 40.0, -75.0, 0, 5, 'police']
  );

  missionClocks.set(missionId, {
    endAt: now + 60000,
    startedAt: now,
    baseDuration: 60000,
  });

  const req = { params: { id: String(missionId) } };
  const res = createMockRes();

  await missionsController.updateMission(req, res);

  assert.equal(res.statusCode, 200);
  assert.ok(res.body?.ok, 'response should include ok flag');
  assert.equal(res.body?.freed, 2);
  assert.equal(res.body?.reward, 200);
  assert.equal(res.body?.patientTransports, 1);
  assert.equal(res.body?.prisonerTransports, 1);
  assert.equal(res.body?.transportReward, 1000);
  assert.equal(res.body?.balance, 1200);

  const walletRow = await get(`SELECT balance FROM wallet WHERE id=1`);
  assert.equal(walletRow.balance, 1200);

  const loads = await all(`SELECT type FROM facility_load ORDER BY type`);
  assert.deepEqual(
    loads.map(l => l.type),
    ['patient', 'prisoner']
  );

  assert.equal(missionClocks.has(missionId), false);
});

test('handleTransports counts prisoner transports regardless of attribute case', async () => {
  await run(`INSERT INTO units (id, type, status, responding) VALUES (?,?,?,?)`, [201, 'Patrol Car', 'on_scene', 1]);
  await run(`INSERT INTO wallet (id, balance) VALUES (1, 0)`);
  await run(
    `INSERT INTO stations (id, lat, lon, bed_capacity, holding_cells, type) VALUES (?,?,?,?,?,?)`,
    [301, 40.0, -75.0, 0, 3, 'police']
  );

  const summary = await handleTransports([201], 40.0, -75.0, [], [{ transport: 1 }]);

  const loads = await all(`SELECT type FROM facility_load`);
  assert.equal(loads.length, 1);
  assert.equal(loads[0].type, 'prisoner');

  const walletRow = await get(`SELECT balance FROM wallet WHERE id=1`);
  assert.equal(walletRow.balance, 500);
  assert.deepEqual(summary, {
    patientTransports: 0,
    prisonerTransports: 1,
    transportReward: 500,
  });
});
