import { fetchNoCache, formatTime } from './common.js';

// Fetch all missions from API and sort by warning level and remaining time
export async function getMissions() {
  const missions = await fetchNoCache('/api/missions').then(r => r.json());
  return sortMissions(missions);
}

export function sortMissions(missions) {
  const level = m => {
    if (m.warning3) return 3;
    if (m.warning2) return 2;
    if (m.warning1) return 1;
    return 0;
  };
  return missions.slice().sort((a,b)=>{
    const diff = level(b) - level(a);
    if (diff !== 0) return diff;
    const ta = a.resolve_at ? a.resolve_at : 0;
    const tb = b.resolve_at ? b.resolve_at : 0;
    return ta - tb;
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
