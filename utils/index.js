const axios = require('axios');

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

module.exports = {
  parseArrayField,
  reverseGeocode,
  pointInPolygon,
};
