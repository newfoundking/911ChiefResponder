const db = require('../db');
const { parseArrayField } = require('../utils');
const unitTypes = require('../unitTypes');

// GET /api/units
function getUnits(req, res) {
  const { station_id, status } = req.query;
  const params = [];
  let sql =
    `SELECT u.*, COALESCE(json_group_array(json_object('id', p.id, 'name', p.name, 'training', p.training)), '[]') AS personnel
     FROM units u
     LEFT JOIN personnel p ON p.unit_id = u.id`;
  const where = [];
  if (station_id) { where.push('u.station_id = ?'); params.push(station_id); }
  if (status) { where.push('u.status = ?'); params.push(status); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' GROUP BY u.id';

  db.all(sql, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const parsed = rows.map(u => ({
      ...u,
      priority: Number(u.priority) || 1,
      patrol: u.patrol === 1 || u.patrol === true,
      responding: u.responding === 1 || u.responding === true,
      equipment: parseArrayField(u.equipment),
      personnel: (() => {
        try {
          return JSON.parse(u.personnel || '[]').map(p => ({
            ...p,
            training: parseArrayField(p.training)
          }));
        } catch {
          return [];
        }
      })()
    }));
    res.json(parsed);
  });
}

// GET /api/units/:id
function getUnit(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid unit id' });
  db.get('SELECT * FROM units WHERE id=?', [id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Not found' });
    const parsed = {
      ...row,
      priority: Number(row.priority) || 1,
      patrol: row.patrol === 1 || row.patrol === true,
      responding: row.responding === 1 || row.responding === true,
      equipment: parseArrayField(row.equipment),
    };
    res.json(parsed);
  });
}

// GET /api/units/:id/mission
function getUnitMission(req, res) {
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
}

// PATCH /api/units/:id
function updateUnit(req, res) {
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
}

// PATCH /api/units/:id/status
function patchStatus(req, res) {
  const id = Number(req.params.id);
  const status = String(req.body?.status || '').trim();
  if (!id || !status) return res.status(400).json({ error: 'Invalid unit id/status' });
  db.run('UPDATE units SET status=? WHERE id=?', [status, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, status });
  });
}

// PATCH /api/units/:id/patrol
function patchPatrol(req, res) {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid unit id' });
  const patrol = req.body && req.body.patrol ? 1 : 0;
  db.run('UPDATE units SET patrol=? WHERE id=?', [patrol, id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, patrol: Boolean(patrol) });
  });
}

// PATCH /api/units/:id/icon
function patchIcon(req, res) {
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
}

// PATCH /api/units/:id/equipment
function patchEquipment(req, res) {
  const unitId = Number(req.params.id);
  const stationId = Number(req.body?.station_id);
  const name = String(req.body?.name || '').trim();
  if (!unitId || !stationId || !name) {
    return res.status(400).json({ error: 'unit_id, station_id and name are required' });
  }

  db.get(`SELECT equipment FROM stations WHERE id=?`, [stationId], (err, st) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!st) return res.status(404).json({ error: 'Station not found' });
    let stList = parseArrayField(st.equipment);
    const idx = stList.indexOf(name);
    if (idx === -1) return res.status(409).json({ error: 'Equipment not available' });

    db.get(`SELECT equipment, class, type FROM units WHERE id=?`, [unitId], (err2, u) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (!u) return res.status(404).json({ error: 'Unit not found' });
      let uList = parseArrayField(u.equipment);

      const uType = unitTypes.find(
        (t) => t.class === u.class && t.type === u.type
      );
      const slots = Number(uType?.equipmentSlots || 0);
      if (slots && uList.length >= slots)
        return res.status(409).json({ error: 'No free equipment slots' });

      uList.push(name);
      stList.splice(idx, 1);
      db.serialize(() => {
        db.run(`UPDATE stations SET equipment=? WHERE id=?`, [JSON.stringify(stList), stationId]);
        db.run(
          `UPDATE units SET equipment=? WHERE id=?`,
          [JSON.stringify(uList), unitId],
          function (e3) {
            if (e3) return res.status(500).json({ error: e3.message });
            res.json({
              success: true,
              unit_id: unitId,
              equipment: uList,
              station_equipment: stList,
            });
          }
        );
      });
    });
  });
}

// DELETE /api/units/:id/equipment
function deleteEquipment(req, res) {
  const unitId = Number(req.params.id);
  const stationId = Number(req.body?.station_id);
  const name = String(req.body?.name || '').trim();
  if (!unitId || !stationId || !name) {
    return res.status(400).json({ error: 'unit_id, station_id and name are required' });
  }

  db.get(`SELECT equipment, equipment_slots FROM stations WHERE id=?`, [stationId], (err, st) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!st) return res.status(404).json({ error: 'Station not found' });
    let stList = parseArrayField(st.equipment);
    const slots = Number(st.equipment_slots || 0);

    db.get(`SELECT equipment FROM units WHERE id=?`, [unitId], (err2, u) => {
      if (err2) return res.status(500).json({ error: err2.message });
      if (!u) return res.status(404).json({ error: 'Unit not found' });
      let uList = parseArrayField(u.equipment);
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
}

// POST /api/units/:id/cancel
function cancelUnit(req, res) {
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
}

module.exports = {
  getUnits,
  getUnit,
  getUnitMission,
  updateUnit,
  patchStatus,
  patchPatrol,
  patchIcon,
  patchEquipment,
  deleteEquipment,
  cancelUnit,
};
