import { fetchNoCache, formatTime } from './common.js';

// Fetch all missions from API and sort by warning level and remaining time
export async function getMissions() {
  const missions = await fetchNoCache('/api/missions').then(r => r.json());
  return sortMissions(missions);
}

export function sortMissions(missions) {
  const level = m => {
    if (m.warning1) return 1;
    if (m.warning2) return 2;
    if (m.warning3) return 3;
    return 4;
  };
  return missions
    .filter(m => m.status !== 'resolved')
    .slice()
    .sort((a, b) => {
      const diff = level(a) - level(b);
      if (diff !== 0) return diff;
      return (a.id || 0) - (b.id || 0);
    });
}

export function renderMissionRow(mission) {
  const lvl = mission.warning3 ? 3 : mission.warning2 ? 2 : mission.warning1 ? 1 : 1;
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
