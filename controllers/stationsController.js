const db = require('../db');

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

module.exports = {
  getStations,
  getStation,
  createStation,
  patchBays,
  deleteStations,
};
