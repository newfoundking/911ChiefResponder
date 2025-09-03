const db = require('../db');
const { findEquipmentCostByName, requireFunds, adjustBalance, getBalance } = require('../wallet');

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
  db.run('UPDATE stations SET bay_count = COALESCE(bay_count,0) + ? WHERE id=?', [add, stationId], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, station_id: stationId, added: add });
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

module.exports = {
  getStations,
  getStation,
  createStation,
  patchBays,
  deleteStations,
  buyEquipment,
};
