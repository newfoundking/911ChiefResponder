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

// Helper to format numeric values as USD currency strings
export function formatCurrency(amount) {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' })
    .format(Number(amount) || 0);
}

// Map internal unit statuses to human readable status codes
export function formatStatus(status, responding = false) {
  switch (status) {
    case 'available':
      return 'Status 8';
    case 'transporting':
      return 'Status 9';
    case 'enroute':
      return responding ? 'Status 11' : 'Status 10';
    case 'on_scene':
      return 'Status 12';
    case 'at_station':
      return 'Status 19';
    default:
      return status;
  }
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

// Display a confirmation modal with the given message and return a Promise
// that resolves to true if confirmed and false if cancelled. The modal uses
// the existing `.modal-overlay` styles so it matches other overlays.
export function showConfirmModal(message) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.style.zIndex = '20000';

    const content = document.createElement('div');
    content.className = 'modal-content';

    const msg = document.createElement('p');
    msg.textContent = message;

    const btnWrap = document.createElement('div');
    btnWrap.style.textAlign = 'right';
    btnWrap.style.marginTop = '1em';

    const confirmBtn = document.createElement('button');
    confirmBtn.textContent = 'Confirm';
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = 'Cancel';

    btnWrap.appendChild(confirmBtn);
    btnWrap.appendChild(cancelBtn);
    content.appendChild(msg);
    content.appendChild(btnWrap);
    overlay.appendChild(content);
    document.body.appendChild(overlay);

    const focusable = [confirmBtn, cancelBtn];
    const cleanup = (result) => {
      overlay.remove();
      document.removeEventListener('keydown', keyHandler);
      resolve(result);
    };
    confirmBtn.addEventListener('click', () => cleanup(true));
    cancelBtn.addEventListener('click', () => cleanup(false));
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) cleanup(false);
    });

    const keyHandler = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cleanup(false);
      } else if (e.key === 'Tab') {
        e.preventDefault();
        let idx = focusable.indexOf(document.activeElement);
        idx = e.shiftKey
          ? (idx - 1 + focusable.length) % focusable.length
          : (idx + 1) % focusable.length;
        focusable[idx].focus();
      }
    };
    document.addEventListener('keydown', keyHandler);
    confirmBtn.focus();
  });
}

// Expose helpers globally for legacy scripts
window.fetchNoCache = fetchNoCache;
window.haversineKm = haversineKm;
window.formatTime = formatTime;
window.formatCurrency = formatCurrency;
window.formatStatus = formatStatus;
window.playSound = playSound;
window.showConfirmModal = showConfirmModal;
