const db = require('../db');
const unitTypes = require('../unitTypes');
const { adjustBalance, getBalance } = require('../wallet');
const { clearMissionClock } = require('./missionTimers');

const CLASS_SPEED = { fire: 63, police: 94, ambulance: 75, sar: 70 };

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
  });
}

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
  return run(
    `INSERT INTO facility_load (station_id, type, expires_at) VALUES (?,?,?)`,
    [stationId, type, expiresAt]
  );
}

async function allocateTransport(kind, lat, lon, unitClass) {
  const facilities = await all(
    kind === 'patient'
      ? `SELECT id, lat, lon, bed_capacity AS capacity, type FROM stations WHERE type='hospital' AND bed_capacity>0`
      : `SELECT id, lat, lon, holding_cells AS capacity, type FROM stations WHERE (type='jail' OR (type='police' AND holding_cells>0))`
  );
  if (!facilities.length) return null;

  facilities.forEach(f => {
    f.distance = haversine(lat, lon, f.lat, f.lon);
  });
  facilities.sort((a, b) => a.distance - b.distance);

  const speed = CLASS_SPEED[unitClass] || 63;
  const now = Date.now();

  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    const occ = await getFacilityOccupancy(f.id, kind);
    if (occ.count < f.capacity) {
      await addFacilityLoad(f.id, kind, now + 10 * 60 * 1000);
      return f;
    }
    const nextFree = occ.nextFree || now;
    const timeUntilFree = nextFree - now;
    const next = facilities[i + 1];
    const travelToNext = next ? (haversine(lat, lon, next.lat, next.lon) / speed) * 3600 * 1000 : Infinity;
    if (timeUntilFree < travelToNext) {
      await addFacilityLoad(f.id, kind, nextFree + 10 * 60 * 1000);
      return f;
    }
  }

  const first = facilities[0];
  const occ = await getFacilityOccupancy(first.id, kind);
  const expiry = (occ.nextFree || now) + 10 * 60 * 1000;
  await addFacilityLoad(first.id, kind, expiry);
  return first;
}

async function handleTransports(unitIds, lat, lon, patients, prisoners) {
  const summary = {
    patientTransports: 0,
    prisonerTransports: 0,
    transportReward: 0,
    transportAssignments: []
  };

  let patientCount = 0;
  for (const p of patients) patientCount += Number(p.count || 0);
  let prisonerCount = 0;
  for (const p of prisoners) prisonerCount += Number(p.transport || 0);

  if (!unitIds.length || (patientCount === 0 && prisonerCount === 0)) return summary;

  const placeholders = unitIds.map(() => '?').join(',');
  const rows = await all(`SELECT id, type FROM units WHERE id IN (${placeholders})`, unitIds);

  const medUnits = [];
  const prisUnits = [];
  for (const r of rows) {
    const ut = unitTypes.find(t => t.type === r.type);
    const attrs = (Array.isArray(ut?.attributes) ? ut.attributes : []).map(attr =>
      typeof attr === 'string' ? attr.toLowerCase() : attr
    );
    if (attrs.includes('medicaltransport')) medUnits.push(r.id);
    if (attrs.includes('prisonertransport')) prisUnits.push(r.id);
  }

  const medTransports = Math.min(patientCount, medUnits.length);
  for (let i = 0; i < medTransports; i++) {
    const facility = await allocateTransport('patient', lat, lon, 'ambulance');
    summary.patientTransports += 1;
    summary.transportReward += 500;
    if (facility) {
      summary.transportAssignments.push({ unitId: medUnits[i], kind: 'patient', facility });
    }
  }

  const prisTransports = Math.min(prisonerCount, prisUnits.length);
  for (let i = 0; i < prisTransports; i++) {
    const facility = await allocateTransport('prisoner', lat, lon, 'police');
    summary.prisonerTransports += 1;
    summary.transportReward += 500;
    if (facility) {
      summary.transportAssignments.push({ unitId: prisUnits[i], kind: 'prisoner', facility });
    }
  }

  if (summary.transportReward > 0) {
    await adjustBalance(summary.transportReward);
  }

  return summary;
}

function haversine(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180, la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function safeParse(json, fallback) {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function resolveMissionById(missionId, cb) {
  const promise = (async () => {
    await run('UPDATE missions SET status=? WHERE id=?', ['resolved', missionId]);

    const unitRows = await all('SELECT unit_id FROM mission_units WHERE mission_id=?', [missionId]);
    const ids = unitRows.map(r => r.unit_id);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      await run(`UPDATE units SET status='available', responding=0 WHERE id IN (${placeholders})`, ids);
      await run(`DELETE FROM unit_travel WHERE unit_id IN (${placeholders})`, ids);
    }
    await run('DELETE FROM mission_units WHERE mission_id=?', [missionId]);

    const mission = await get('SELECT type, lat, lon, patients, prisoners, penalties FROM missions WHERE id=?', [missionId]);
    const missionName = mission?.type || '';
    const patients = safeParse(mission?.patients, []);
    const prisoners = safeParse(mission?.prisoners, []);
    const penalties = safeParse(mission?.penalties, []);

    const template = await get('SELECT rewards FROM mission_templates WHERE name=?', [missionName]);
    const baseReward = Number(template?.rewards || 0);
    const rewardPenalty = penalties.reduce((sum, p) => sum + (Number(p.rewardPenalty) || 0), 0);
    const reward = Math.max(0, baseReward * (1 - rewardPenalty / 100));

    if (reward > 0) {
      await adjustBalance(+reward);
    }

    let transportSummary = { patientTransports: 0, prisonerTransports: 0, transportReward: 0 };
    if (mission) {
      transportSummary = await handleTransports(ids, mission.lat, mission.lon, patients, prisoners);
    }

    const balance = await getBalance();
    clearMissionClock(missionId);

    return { freed: ids.length, reward, balance, ...transportSummary };
  })();

  if (typeof cb === 'function') {
    promise.then(result => cb(null, result)).catch(err => cb(err));
  }
  return promise;
}

module.exports = {
  resolveMissionById,
  getFacilityOccupancy,
  handleTransports,
};
