import { fetchNoCache } from './common.js';

export async function getStations() {
  return fetchNoCache('/api/stations').then(r=>r.json());
}

export function groupStationsByDept(stations) {
  const groups = {};
  stations.forEach(st => {
    const dept = st.department || 'Unknown';
    if (!groups[dept]) groups[dept] = [];
    groups[dept].push(st);
  });
  Object.keys(groups).forEach(k=>groups[k].sort((a,b)=>a.name.localeCompare(b.name)));
  return groups;
}

export function renderStationList(stations) {
  const groups = groupStationsByDept(stations);
  let html = '';
  for (const dept of Object.keys(groups).sort()) {
    html += `<div class="cad-dept"><h4>${dept}</h4><ul>`;
    for (const st of groups[dept]) {
      html += `<li class="cad-station" data-id="${st.id}">${st.name}</li>`;
    }
    html += '</ul></div>';
  }
  return html;
}

window.stationUtils = { getStations, renderStationList };
