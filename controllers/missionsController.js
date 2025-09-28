const db = require('../db');
const { parseArrayField, reverseGeocode, pointInPolygon } = require('../utils');
const { beginMissionClock, clearMissionClock, missionClocks } = require('../services/missionTimers');
const { resolveMissionById } = require('../services/missions');

// GET /api/missions
async function getMissions(req, res) {
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
      required_units: parseArrayField(m.required_units),
      required_training: parseArrayField(m.required_training),
      equipment_required: parseArrayField(m.equipment_required),
      patients: parseArrayField(m.patients),
      prisoners: parseArrayField(m.prisoners),
      modifiers: parseArrayField(m.modifiers),
      penalty_options: parseArrayField(m.penalty_options),
      penalties: parseArrayField(m.penalties),
      timing: typeof m.timing === 'number' ? m.timing : 10,
      resolve_at: m.resolve_at != null ? Number(m.resolve_at) : null,
      non_emergency: m.non_emergency === 1 || m.non_emergency === true,
      responding_count: Number(m.responding_count) || 0,
      assigned_count: Number(m.assigned_count) || 0
    }));
    res.json(parsed);
  });
}

// POST /api/missions
async function createMission(req, res) {
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

    const matches = [];
    zones.forEach(z => {
      try {
        const poly = JSON.parse(z.polygon || '{}');
        if (pointInPolygon(lat, lon, poly)) {
          const prio = z.priority != null ? Number(z.priority) : Infinity;
          matches.push({ priority: prio, departments: parseArrayField(z.departments) });
        }
      } catch {}
    });
    matches.sort((a, b) => a.priority - b.priority);
    const seen = new Set();
    const departments = [];
    matches.forEach(m => {
      m.departments.forEach(d => {
        if (!seen.has(d)) {
          seen.add(d);
          departments.push(d);
        }
      });
    });

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
    function (err2) {
      if (err2) return res.status(500).json({ error: err2.message });
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
}

// PUT /api/missions/:id
async function updateMission(req, res) {
  const missionId = parseInt(req.params.id, 10);
  if (!missionId) return res.status(400).json({ error: 'invalid id' });
  try {
    const result = await resolveMissionById(missionId);
    res.json({ ok: true, ...(result || {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// DELETE /api/missions
function deleteMissions(req, res) {
  db.run('DELETE FROM missions', err => {
    if (err) return res.status(500).json({ error: err.message });
    res.sendStatus(200);
  });
}

// Minimal timer endpoints using service
function startTimer(req, res) {
  const missionId = parseInt(req.params.id, 10);
  if (!missionId) return res.status(400).json({ error: 'invalid id' });
  beginMissionClock(missionId, end => {
    if (!end) return res.status(404).json({ error: 'mission not found' });
    res.json({ resolve_at: end });
  });
}

function modifyTimer(req, res) {
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
}

function clearTimer(req, res) {
  const missionId = parseInt(req.params.id, 10);
  if (!missionId) return res.status(400).json({ error: 'invalid id' });
  clearMissionClock(missionId);
  res.json({ ok: true });
}

module.exports = {
  getMissions,
  createMission,
  updateMission,
  deleteMissions,
  startTimer,
  modifyTimer,
  clearTimer,
};
