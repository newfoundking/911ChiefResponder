// Common utility functions shared across front-end pages
// Provides helpers for fetching without cache and formatting time

// Force-fresh GETs to avoid cached responses
export async function fetchNoCache(url) {
  const sep = url.includes('?') ? '&' : '?';
  const res = await fetch(`${url}${sep}t=${Date.now()}`, { cache: 'no-store' });
  return res;
}

// Compute haversine distance in kilometers
export function haversineKm(aLat, aLon, bLat, bLon) {
  const R = 6371;
  const dLat = (bLat - aLat) * Math.PI / 180;
  const dLon = (bLon - aLon) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180, la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLat/2)**2 + Math.cos(la1)*Math.cos(la2)*Math.sin(dLon/2)**2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Helper to format seconds as M:SS
export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

// Play an audio file from the given path. Errors are ignored so a
// missing file or blocked autoplay does not break the UI.
export function playSound(path) {
  try {
    const audio = new Audio(path);
    audio.play();
  } catch {
    // noop
  }
}

// Expose helpers globally for legacy scripts
window.fetchNoCache = fetchNoCache;
window.haversineKm = haversineKm;
window.formatTime = formatTime;
window.playSound = playSound;
