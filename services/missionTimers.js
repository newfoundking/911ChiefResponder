const db = require('../db');

const missionClocks = new Map(); // mission_id -> { endAt, startedAt, baseDuration }

function beginMissionClock(missionId, cb) {
  db.get('SELECT timing, resolve_at FROM missions WHERE id=?', [missionId], (e, row) => {
    if (e || !row) return cb && cb(null);

    const baseDuration = Math.max(0, Number(row.timing || 0)) * 60 * 1000;
    const existingDb = row.resolve_at != null ? Number(row.resolve_at) : null;
    const now = Date.now();
    if (existingDb && existingDb > now) {
      const startedAt = existingDb - baseDuration;
      missionClocks.set(missionId, { endAt: existingDb, startedAt, baseDuration });
      return cb && cb(existingDb);
    }

    const endAt = now + baseDuration;
    const startedAt = now;
    db.run('UPDATE missions SET resolve_at=? WHERE id=?', [endAt, missionId], err => {
      if (!err) missionClocks.set(missionId, { endAt, startedAt, baseDuration });
      cb && cb(err ? null : endAt);
    });
  });
}

function clearMissionClock(missionId) {
  missionClocks.delete(missionId);
  db.run('UPDATE missions SET resolve_at=NULL WHERE id=?', [missionId], ()=>{});
}

function rehydrateMissionClocks() {
  db.all('SELECT id, resolve_at, timing FROM missions WHERE resolve_at IS NOT NULL', (err, rows) => {
    if (err) return;
    const now = Date.now();
    rows.forEach(r => {
      const end = Number(r.resolve_at);
      const baseDuration = Math.max(0, Number(r.timing || 0)) * 60 * 1000;
      const startedAt = end - baseDuration;
      if (end > now) missionClocks.set(r.id, { endAt: end, startedAt, baseDuration });
    });
  });
}

module.exports = {
  missionClocks,
  beginMissionClock,
  clearMissionClock,
  rehydrateMissionClocks,
};
