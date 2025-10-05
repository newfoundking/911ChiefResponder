const axios = require('axios');
const unitTypes = require('../unitTypes');

// Safely parse JSON fields that should be arrays.
function parseArrayField(str) {
  try {
    const val = JSON.parse(str || '[]');
    if (Array.isArray(val)) return val;
    if (val && typeof val === 'object') return [val];
    return [];
  } catch {
    return [];
  }
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}`;
    const res = await axios.get(url, { headers: { 'User-Agent': '911ChiefResponder' } });
    return res.data?.display_name || null;
  } catch (e) {
    console.error('Reverse geocode failed:', e.message);
    return null;
  }
}

// Simple point in polygon check for [lat, lon] coordinate arrays
function pointInPolygon(lat, lon, poly) {
  const pts = Array.isArray(poly?.coordinates) ? poly.coordinates : [];
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][1], yi = pts[i][0];
    const xj = pts[j][1], yj = pts[j][0];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function findUnitDefinition(unitClass, unitType) {
  const cls = String(unitClass || '').toLowerCase();
  const type = String(unitType || '').toLowerCase();
  return unitTypes.find(
    (u) => String(u.class || '').toLowerCase() === cls && String(u.type || '').toLowerCase() === type
  ) || null;
}

function getSeatInfo(unitClass, unitType, requested) {
  const def = findUnitDefinition(unitClass, unitType);
  const defaultCapacity = Number(def?.capacity || 0) || 0;
  const hasDefault = defaultCapacity > 0;
  let seatOverride = null;
  let seatCapacity = defaultCapacity;

  if (requested !== undefined && requested !== null && requested !== '') {
    let value = Number(requested);
    if (Number.isFinite(value)) {
      value = Math.floor(value);
      if (hasDefault) {
        value = Math.max(1, Math.min(defaultCapacity, value));
        if (value !== defaultCapacity) {
          seatOverride = value;
          seatCapacity = value;
        } else {
          seatOverride = null;
          seatCapacity = defaultCapacity;
        }
      } else {
        seatOverride = Math.max(0, value);
        seatCapacity = seatOverride;
      }
    }
  }

  if (!hasDefault && seatOverride == null) {
    seatCapacity = 0;
  }

  return { defaultCapacity, seatCapacity, seatOverride };
}

module.exports = {
  parseArrayField,
  reverseGeocode,
  pointInPolygon,
  getSeatInfo,
};
