const cleanRank = (value) => {
  if (value === null || value === undefined) return '';
  return String(value).trim();
};

const fetchRankOptions = (dept) => {
  if (typeof window !== 'undefined' && typeof window.fetchDepartmentRanks === 'function') {
    return window.fetchDepartmentRanks(dept);
  }
  return Promise.resolve([]);
};

export function openPersonnelModal(person, station) {
  const modal = document.getElementById('editPersonnelModal');
  const content = document.getElementById('editPersonnelContent');
  const st = station || window.currentStation || {};
  const getTrainings = typeof getTrainingsForClass === 'function' ? getTrainingsForClass : () => [];
  const availableTrainings = getTrainings(st.type);
  const currentName = person?.name || '';
  const currentRank = cleanRank(person?.rank);
  const currentTraining = Array.isArray(person?.training) ? person.training : [];
  const curSet = new Set(currentTraining.map(t => String(t).toLowerCase()));
  content.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:10px;">
      <label>
        <div>Name</div>
        <input id="edit-personnel-name" type="text" style="width:100%;" value="${currentName.replace(/"/g, '&quot;')}" />
      </label>
      <label>
        <div>Rank</div>
        <input id="edit-personnel-rank" type="text" style="width:100%;" value="${currentRank.replace(/"/g, '&quot;')}" list="edit-personnel-rank-options" />
        <datalist id="edit-personnel-rank-options"></datalist>
      </label>
      <div>
        <div>Training</div>
        <div id="edit-training-list" style="max-height:160px; overflow:auto; padding:6px; border:1px solid #ddd; border-radius:6px;">
          ${
            availableTrainings.length
              ? availableTrainings.map(t => {
                  const name = typeof t === 'string' ? t : t.name;
                  const checked = curSet.has(String(name).toLowerCase()) ? 'checked' : '';
                  return `<label style="display:block;"><input type="checkbox" value="${name}" ${checked}> ${name}</label>`;
                }).join('')
              : '<em>No training list available for this station type.</em>'
          }
        </div>
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="edit-personnel-cancel" type="button">Cancel</button>
        <button id="edit-personnel-save" type="button" style="background:#0b5; color:#fff;">Save</button>
      </div>
    </div>
  `;
  const rankInput = content.querySelector('#edit-personnel-rank');
  const rankList = content.querySelector('#edit-personnel-rank-options');
  const stationDept = cleanRank(st?.department);
  if (rankList) {
    fetchRankOptions(stationDept).then((ranks) => {
      const safe = Array.isArray(ranks) ? ranks : [];
      rankList.innerHTML = safe
        .map(r => `<option value="${String(r || '').replace(/"/g, '&quot;')}"></option>`)
        .join('');
    });
  }
  content.querySelector('#edit-personnel-cancel').onclick = () => { modal.style.display = 'none'; };
  content.querySelector('#edit-personnel-save').onclick = async () => {
    const nameEl = content.querySelector('#edit-personnel-name');
    const name = (nameEl?.value || '').trim();
    const rankVal = cleanRank(rankInput?.value);
    const selectedTrainings = Array.from(content.querySelectorAll('#edit-training-list input[type=checkbox]:checked')).map(cb => cb.value);
    const payload = { id: person.id, station_id: (station && station.id) || person.station_id, name, rank: rankVal || null, training: selectedTrainings };
    const urlBase = `/api/personnel/${person.id}`;
    const attempts = [
      { method: 'PATCH', url: urlBase, body: payload },
      { method: 'PUT',   url: urlBase, body: payload },
      { method: 'POST',  url: `${urlBase}?_method=PATCH`, body: payload },
      { method: 'POST',  url: `${urlBase}?_method=PUT`,   body: payload },
      { method: 'POST',  url: urlBase, body: payload, headers: { 'X-HTTP-Method-Override': 'PATCH' } },
      { method: 'POST',  url: urlBase, body: payload, headers: { 'X-HTTP-Method-Override': 'PUT' } },
      { method: 'POST',  url: `/api/personnel/update`, body: payload },
    ];
    let ok = false, lastStatus = 0, lastText = '';
    for (const a of attempts) {
      try {
        const res = await fetch(a.url, {
          method: a.method,
          headers: { 'Content-Type': 'application/json', ...(a.headers || {}) },
          body: JSON.stringify(a.body),
          cache: 'no-store'
        });
        lastStatus = res.status;
        lastText = await res.text().catch(()=>'');
        if (res.ok || [200,201,202,204].includes(res.status)) { ok = true; break; }
      } catch (e) {
        lastText = e?.message || String(e);
      }
    }
    if (!ok) {
      notifyError(`Failed to save personnel changes.\nLast response (${lastStatus}): ${lastText}`);
      return;
    }
    modal.style.display = 'none';
    const refresh = window.refreshStationPanelNoCache;
    if (typeof refresh === 'function' && (station?.id || person.station_id)) {
      await refresh(station?.id || person.station_id);
    }
  };
  modal.style.display = 'block';
}

export function editPersonnel(id, station) {
  fetch(`/api/personnel/${id}`)
    .then(res => res.json())
    .then(person => {
      openPersonnelModal(person, station);
    });
}

export function openUnitModal(unit) {
  const modal = document.getElementById('editUnitModal');
  const content = document.getElementById('editUnitContent');
  const currentName = unit?.name || '';
  const currentTag = unit?.tag || '';
  const currentPrio = Number(unit?.priority) || 1;
  content.innerHTML = `
    <div style="display:flex; flex-direction:column; gap:10px;">
      <label>
        <div>Name</div>
        <input id="edit-unit-name" type="text" style="width:100%;" value="${currentName.replace(/"/g,'&quot;')}" />
      </label>
      <label>
        <div>Tag</div>
        <input id="edit-unit-tag" type="text" style="width:100%;" value="${currentTag.replace(/"/g,'&quot;')}" />
      </label>
      <label>
        <div>Priority (1-5)</div>
        <input id="edit-unit-priority" type="number" min="1" max="5" value="${currentPrio}" />
      </label>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="edit-unit-cancel" type="button">Cancel</button>
        <button id="edit-unit-save" type="button" style="background:#0b5; color:#fff;">Save</button>
      </div>
    </div>`;
  content.querySelector('#edit-unit-cancel').onclick = () => { modal.style.display = 'none'; };
  content.querySelector('#edit-unit-save').onclick = async () => {
    const nameEl = content.querySelector('#edit-unit-name');
    const name = (nameEl?.value || '').trim();
    const tag = (content.querySelector('#edit-unit-tag')?.value || '').trim();
    let priority = Number(content.querySelector('#edit-unit-priority')?.value);
    if (!Number.isFinite(priority)) priority = 1;
    priority = Math.min(5, Math.max(1, priority));
    const payload = { name, tag, priority };
    const urlBase = `/api/units/${unit.id}`;
    const attempts = [
      { method:'PATCH', url:urlBase, body:payload },
      { method:'PUT', url:urlBase, body:payload },
      { method:'POST', url:`${urlBase}?_method=PATCH`, body:payload },
      { method:'POST', url:`${urlBase}?_method=PUT`, body:payload },
      { method:'POST', url:urlBase, body:payload, headers:{'X-HTTP-Method-Override':'PATCH'} },
      { method:'POST', url:urlBase, body:payload, headers:{'X-HTTP-Method-Override':'PUT'} },
      { method:'POST', url:'/api/units/update', body:{ id:unit.id, ...payload } }
    ];
    let ok=false,lastStatus=0,lastText='';
    for(const a of attempts){
      try{
        const res=await fetch(a.url,{method:a.method,headers:{'Content-Type':'application/json',...(a.headers||{})},body:JSON.stringify(a.body),cache:'no-store'});
        lastStatus=res.status; lastText=await res.text().catch(()=> '');
        if(res.ok||[200,201,202,204].includes(res.status)){ ok=true; break; }
      }catch(e){ lastText=e?.message||String(e); }
    }
    if(!ok){ notifyError(`Failed to save unit changes.\nLast response (${lastStatus}): ${lastText}`); return; }
    modal.style.display='none';
    const refresh = window.refreshStationPanelNoCache;
    if (typeof refresh === 'function') {
      await refresh(unit.station_id);
    }
  };
  modal.style.display = 'block';
}

export function editUnit(id) {
  fetch(`/api/units/${id}`)
    .then(res => res.json())
    .then(unit => { openUnitModal(unit); });
}

if (typeof window !== 'undefined') {
  Object.assign(window, { openPersonnelModal, editPersonnel, openUnitModal, editUnit });
}
