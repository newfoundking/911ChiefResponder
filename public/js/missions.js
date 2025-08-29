import { fetchNoCache, formatTime } from './common.js';

// Fetch all missions from API and sort by warning level and remaining time
export async function getMissions() {
  const missions = await fetchNoCache('/api/missions').then(r => r.json());
  return sortMissions(missions);
}

export function sortMissions(missions) {
  const level = m => {
    if (m.resolve_at) return 3;
    return (m.assigned_count > 0) ? 2 : 1;
  };
  return missions
    .filter(m => m.status !== 'resolved')
    .map(m => ({ ...m, level: level(m) }))
    .sort((a, b) => {
      const diff = a.level - b.level;
      if (diff !== 0) return diff;
      return (a.id || 0) - (b.id || 0);
    });
}

export function renderMissionRow(mission) {
  const lvl = mission.level || (mission.resolve_at ? 3 : (mission.assigned_count > 0 ? 2 : 1));
  const icon = `/warning${lvl}.png`;
  let time = '';
  if (mission.resolve_at) {
    const sec = Math.max(0, (mission.resolve_at - Date.now())/1000);
    time = ` - ${formatTime(sec)}`;
  }
  return `<div class="cad-mission" data-id="${mission.id}"><img src="${icon}" class="cad-icon"/> ${mission.type || 'Mission'}${time}<div class="cad-address">${mission.address || ''}</div></div>`;
}

// Expose globally
window.missionUtils = { getMissions, renderMissionRow };
