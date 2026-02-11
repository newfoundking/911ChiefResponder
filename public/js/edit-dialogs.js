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

const normalizeEquipmentName = (value) => {
  return String(value || '').trim();
};

const getVehicleUpgradeConfigForClass = (unitClass) => {
  const key = String(unitClass || '').toLowerCase();
  const source = (typeof vehicleUpgrades !== 'undefined' && vehicleUpgrades)
    ? vehicleUpgrades
    : (equipment?.vehicleUpgrades || {});
  return source?.[key] || null;
};

const findUnitDefinition = (unitClass, unitType) => {
  const cls = String(unitClass || '').toLowerCase();
  const type = String(unitType || '').toLowerCase();
  return (Array.isArray(unitTypes) ? unitTypes : []).find(
    (u) => String(u.class || '').toLowerCase() === cls && String(u.type || '').toLowerCase() === type
  ) || null;
};

const equipmentOptionsForClass = (unitClass) => {
  const list = Array.isArray(equipment?.[unitClass]) ? equipment[unitClass] : [];
  return list.map((item) => {
    if (typeof item === 'string') return { name: item, cost: 0 };
    return { name: item?.name || '', cost: Number(item?.cost) || 0 };
  }).filter((opt) => opt.name);
};

const upgradeOptionsForUnit = (unit) => {
  const cfg = getVehicleUpgradeConfigForClass(unit?.class);
  const upgrades = Array.isArray(cfg?.upgrades) ? cfg.upgrades : [];
  if (!upgrades.length) return [];
  const allowed = cfg?.allowedByUnit?.[unit?.type];
  const allowedSet = Array.isArray(allowed)
    ? new Set(allowed.map((name) => String(name || '').toLowerCase()))
    : null;
  return upgrades
    .filter((upg) => {
      if (!upg) return false;
      const name = String(upg?.name || '').toLowerCase();
      if (!name) return false;
      if (!allowedSet) return true;
      return allowedSet.has(name);
    })
    .map((upg) => ({
      name: upg?.name || '',
      cost: Number(upg?.cost) || 0,
      isUpgrade: true
    }))
    .filter((opt) => opt.name);
};

const unitEquipmentOptions = (unit) => {
  const options = [...equipmentOptionsForClass(unit?.class)];
  const seen = new Set();
  return options.filter((opt) => {
    const key = normalizeEquipmentName(opt?.name).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
        <select id="edit-personnel-rank" style="width:100%;"></select>
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
  const stationDept = cleanRank(st?.department);
  if (rankInput) {
    const populateRankSelect = (ranks, currentValue = '') => {
      const safe = Array.isArray(ranks) ? ranks : [];
      const seen = new Set();
      const options = ['<option value=""></option>'];
      safe.forEach(raw => {
        const value = cleanRank(raw);
        if (!value) return;
        const key = value.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        options.push(`<option value="${value.replace(/"/g, '&quot;')}">${value}</option>`);
      });
      const current = cleanRank(currentValue);
      if (current && !seen.has(current.toLowerCase())) {
        options.push(`<option value="${current.replace(/"/g, '&quot;')}">${current}</option>`);
      }
      rankInput.innerHTML = options.join('');
      rankInput.value = current || '';
    };
    populateRankSelect([], currentRank);
    fetchRankOptions(stationDept).then((ranks) => {
      populateRankSelect(ranks, rankInput.value || currentRank);
    });
    rankInput.value = cleanRank(currentRank);
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
  const computeDefaultSeats = () => {
    const fromUnit = Number(unit?.default_capacity);
    if (Number.isFinite(fromUnit) && fromUnit > 0) return fromUnit;
    if (typeof window !== 'undefined' && typeof window.defaultSeatCapacity === 'function') {
      return Number(window.defaultSeatCapacity(unit?.class, unit?.type)) || 0;
    }
    return 0;
  };
  const defaultSeats = computeDefaultSeats();
  const seatDisplay = (() => {
    if (!defaultSeats) return '';
    const value = unit?.seat_override != null ? Number(unit.seat_override) || defaultSeats : Number(unit?.seat_capacity) || defaultSeats;
    return String(Math.max(1, Math.min(defaultSeats, value)));
  })();
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
      <label>
        <div>Seats${defaultSeats ? ` (max ${defaultSeats})` : ''}</div>
        <input id="edit-unit-seats" type="number" ${defaultSeats ? `min="1" max="${defaultSeats}" value="${seatDisplay}"` : 'disabled placeholder="N/A"'} style="width:100%;" ${defaultSeats ? `placeholder="${defaultSeats}"` : ''} />
      </label>
      <div>
        <div id="edit-unit-equipment-label" style="font-weight:bold;">Equipment</div>
        <div id="edit-unit-equipment" style="max-height:160px; overflow:auto; padding:6px; border:1px solid #ddd; border-radius:6px;"></div>
      </div>
      <div style="display:flex; gap:8px; justify-content:flex-end;">
        <button id="edit-unit-cancel" type="button">Cancel</button>
        <button id="edit-unit-save" type="button" style="background:#0b5; color:#fff;">Save</button>
      </div>
    </div>`;
  const seatInput = content.querySelector('#edit-unit-seats');
  if (seatInput && defaultSeats) {
    seatInput.addEventListener('blur', () => {
      const raw = seatInput.value.trim();
      if (!raw) {
        seatInput.value = '';
        return;
      }
      let value = Math.floor(Number(raw));
      if (!Number.isFinite(value)) {
        seatInput.value = String(defaultSeats);
        return;
      }
      value = Math.max(1, Math.min(defaultSeats, value));
      seatInput.value = String(value);
    });
  }
  const equipmentSelection = new Set(
    (Array.isArray(unit?.equipment) ? unit.equipment : [])
      .map((item) => normalizeEquipmentName(item))
      .filter(Boolean)
  );
  const upgradeSelection = new Set(
    (Array.isArray(unit?.upgrades) ? unit.upgrades : [])
      .map((item) => normalizeEquipmentName(item))
      .filter(Boolean)
  );
  const equipLabel = content.querySelector('#edit-unit-equipment-label');
  const equipContainer = content.querySelector('#edit-unit-equipment');
  const renderEquipmentOptions = () => {
    if (!equipContainer) return;
    const def = findUnitDefinition(unit?.class, unit?.type);
    const slots = Number(def?.equipmentSlots || 0);
    if (equipLabel) {
      equipLabel.textContent = slots ? `Upgrades & Equipment (${slots} slots)` : 'Upgrades & Equipment';
    }
    const opts = unitEquipmentOptions(unit);
    const upgradeOpts = upgradeOptionsForUnit(unit);
    equipContainer.innerHTML = '';
    if (!opts.length && !upgradeOpts.length) {
      equipContainer.innerHTML = '<em>No upgrades or equipment available for this unit.</em>';
      return;
    }
    opts.forEach((opt) => {
      const label = document.createElement('label');
      label.style.display = 'block';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = opt.name;
      checkbox.checked = equipmentSelection.has(opt.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          if (slots && equipmentSelection.size >= slots) {
            checkbox.checked = false;
            notifyError('No free equipment slots for this unit.');
            return;
          }
          equipmentSelection.add(opt.name);
        } else {
          equipmentSelection.delete(opt.name);
        }
      });
      const span = document.createElement('span');
      span.textContent = opt.cost ? `${opt.name} ($${opt.cost})` : opt.name;
      label.append(checkbox, ' ', span);
      equipContainer.appendChild(label);
    });
    if (upgradeOpts.length) {
      const upgradeLabel = document.createElement('div');
      upgradeLabel.style.fontWeight = 'bold';
      upgradeLabel.style.marginTop = '8px';
      upgradeLabel.textContent = 'Vehicle Upgrades';
      equipContainer.appendChild(upgradeLabel);
    }
    upgradeOpts.forEach((opt) => {
      const label = document.createElement('label');
      label.style.display = 'block';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = opt.name;
      checkbox.checked = upgradeSelection.has(opt.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) upgradeSelection.add(opt.name);
        else upgradeSelection.delete(opt.name);
      });
      const span = document.createElement('span');
      span.textContent = opt.cost ? `${opt.name} ($${opt.cost})` : opt.name;
      label.append(checkbox, ' ', span);
      equipContainer.appendChild(label);
    });
  };
  renderEquipmentOptions();
  content.querySelector('#edit-unit-cancel').onclick = () => { modal.style.display = 'none'; };
  content.querySelector('#edit-unit-save').onclick = async () => {
    const nameEl = content.querySelector('#edit-unit-name');
    const name = (nameEl?.value || '').trim();
    const tag = (content.querySelector('#edit-unit-tag')?.value || '').trim();
    let priority = Number(content.querySelector('#edit-unit-priority')?.value);
    if (!Number.isFinite(priority)) priority = 1;
    priority = Math.min(5, Math.max(1, priority));
    const payload = { name, tag, priority, equipment: Array.from(equipmentSelection), upgrades: Array.from(upgradeSelection) };
    if (seatInput && !seatInput.disabled) {
      const raw = seatInput.value.trim();
      if (!raw) {
        payload.seats = null;
      } else {
        let value = Math.floor(Number(raw));
        if (Number.isFinite(value)) {
          if (defaultSeats > 0) {
            value = Math.max(1, Math.min(defaultSeats, value));
          } else {
            value = Math.max(0, value);
          }
          payload.seats = value;
        }
      }
    }
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
