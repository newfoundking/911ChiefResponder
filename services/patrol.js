const db = require('../db');

const CLASS_SPEED = { fire: 63, police: 94, ambulance: 75, sar: 70 };

function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180, la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function randomPointNear(lat, lon, radiusKm) {
  const r = radiusKm / 6371;
  const u = Math.random();
  const v = Math.random();
  const w = r * Math.sqrt(u);
  const t = 2 * Math.PI * v;
  const lat1 = lat * Math.PI / 180;
  const lon1 = lon * Math.PI / 180;
  const newLat = Math.asin(Math.sin(lat1) * Math.cos(w) + Math.cos(lat1) * Math.sin(w) * Math.cos(t));
  const newLon = lon1 + Math.atan2(Math.sin(t) * Math.sin(w) * Math.cos(lat1), Math.cos(w) - Math.sin(lat1) * Math.sin(newLat));
  return [newLat * 180 / Math.PI, newLon * 180 / Math.PI];
}

function startPatrol(unitId) {
  return new Promise(resolve => {
    db.get(`SELECT u.id, u.class, s.lat AS st_lat, s.lon AS st_lon FROM units u JOIN stations s ON s.id=u.station_id WHERE u.id=?`, [unitId], (err, row) => {
      if (err || !row) return resolve();
      const speed = CLASS_SPEED[row.class] || 56;
      const [destLat, destLon] = randomPointNear(row.st_lat, row.st_lon, 5);
      const fromLat = row.st_lat;
      const fromLon = row.st_lon;
      const distKm = haversineKm(fromLat, fromLon, destLat, destLon);
      const total = Math.max(5, (distKm / speed) * 3600);
      const coords = JSON.stringify([[fromLat, fromLon], [destLat, destLon]]);
      const segs = JSON.stringify([total]);
      db.run(`INSERT OR REPLACE INTO unit_travel (unit_id, mission_id, phase, started_at, from_lat, from_lon, to_lat, to_lon, coords, seg_durations, total_duration) VALUES (?, NULL, 'patrol', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [unitId, new Date().toISOString(), fromLat, fromLon, destLat, destLon, coords, segs, total], () => resolve());
    });
  });
}

function handlePatrolCompletion(travelRow) {
  return new Promise(resolve => {
    db.get(`SELECT u.class, u.patrol_until, s.lat AS st_lat, s.lon AS st_lon FROM units u JOIN stations s ON s.id=u.station_id WHERE u.id=?`, [travelRow.unit_id], (err, row) => {
      if (err || !row) {
        db.run('DELETE FROM unit_travel WHERE unit_id=?', [travelRow.unit_id], () => resolve());
        return;
      }
      const speed = CLASS_SPEED[row.class] || 56;
      const now = Date.now();
      const fromLat = travelRow.to_lat;
      const fromLon = travelRow.to_lon;
      let destLat, destLon, phase = 'patrol';
      if (row.patrol_until && now < row.patrol_until) {
        [destLat, destLon] = randomPointNear(row.st_lat, row.st_lon, 5);
      } else {
        destLat = row.st_lat;
        destLon = row.st_lon;
        phase = 'return';
        db.run('UPDATE units SET patrol=0, patrol_until=NULL WHERE id=?', [travelRow.unit_id]);
      }
      const distKm = haversineKm(fromLat, fromLon, destLat, destLon);
      const total = Math.max(5, (distKm / speed) * 3600);
      const coords = JSON.stringify([[fromLat, fromLon], [destLat, destLon]]);
      const segs = JSON.stringify([total]);
      db.run(`UPDATE unit_travel SET phase=?, started_at=?, from_lat=?, from_lon=?, to_lat=?, to_lon=?, coords=?, seg_durations=?, total_duration=? WHERE unit_id=?`,
        [phase, new Date().toISOString(), fromLat, fromLon, destLat, destLon, coords, segs, total, travelRow.unit_id], () => resolve());
    });
  });
}

module.exports = { startPatrol, handlePatrolCompletion };
