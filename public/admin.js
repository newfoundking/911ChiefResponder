document.addEventListener("DOMContentLoaded", async () => {
  if (typeof unitTypes === "undefined") {
    console.error("unitTypes is not defined. Make sure UnitTypes.js is loaded before admin.js.");
    return;
  }
  await loadMissions();
  document.getElementById("new-mission-btn").addEventListener("click", () => {
    openMissionForm();
  });
});

// ---------- helpers to read name/cost from string OR object ----------
function getEquipDisplayList() {
  const lists = Object.values(equipment || {}).flat();
  return lists.map(item => {
    if (typeof item === "string") return { name: item, cost: null };
    return { name: item.name, cost: item.cost ?? null };
  });
}
function getTrainingDisplayList() {
  const lists = Object.values(trainingsByClass || {}).flat();
  return lists.map(item => {
    if (typeof item === "string") return { name: item, cost: null };
    return { name: item.name, cost: item.cost ?? null };
  });
}
// --------------------------------------------------------------------

async function loadMissions() {
  const res = await fetch("/api/mission-templates");
  const missions = await res.json();
  const tbody = document.querySelector("#mission-table tbody");
  tbody.innerHTML = "";
  missions.forEach(m => appendMissionRow(m));
}

function appendMissionRow(mission) {
  const tbody = document.querySelector("#mission-table tbody");
  const row = document.createElement("tr");
  row.innerHTML = `
    <td>${mission.name}</td>
    <td>${mission.trigger_type}</td>
    <td>${mission.trigger_filter}</td>
    <td>${mission.timing}</td>
    <td>${(mission.required_units || []).map(u => `${u.quantity ?? u.count}×${u.type}`).join(", ")}</td>
    <td>${Number.isFinite(mission.rewards) ? mission.rewards : 0}</td>
    <td><button onclick="editMission(${mission.id})">Edit</button></td>
  `;
  tbody.appendChild(row);
}

function openMissionForm(existing = null) {
  const c = document.getElementById("mission-form-container");
  c.style.display = "block";

  c.innerHTML = `
    <h3>${existing ? "Edit" : "New"} Mission</h3>
    <input type="hidden" id="mission-id" value="${existing?.id || ""}">
    <label>Name: <input id="mission-name" value="${existing?.name || ""}"></label><br>
    <label>Trigger Type: <input id="trigger-type" value="${existing?.trigger_type || ""}"></label><br>
    <label>Trigger Filter: <input id="trigger-filter" value="${existing?.trigger_filter || ""}"></label><br>
    <label>Timing (minutes): <input id="timing" type="number" value="${existing?.timing ?? 0}"></label><br>
    <label>Rewards (currency): <input id="rewards" type="number" value="${existing?.rewards ?? 0}"></label><br>

    <h4>Required Units</h4>
    <div><strong>Type</strong> | <strong>Quantity</strong></div>
    <div id="unit-req-container"></div>
    <button type="button" onclick="addUnitRequirementRow()">Add Unit Requirement</button><br>

    <h4>Patients</h4>
    <div><strong>Min</strong> | <strong>Max</strong> | <strong>Chance (0–1)</strong> | <strong>Codes</strong></div>
    <div id="patients-container"></div>
    <button type="button" onclick="addPatientRow()">Add Patient</button><br>

    <h4>Prisoners</h4>
    <div><strong>Min</strong> | <strong>Max</strong> | <strong>Chance (0–1)</strong> | <strong>Transport Chance (0–1)</strong></div>
    <div id="prisoners-container"></div>
    <button type="button" onclick="addPrisonerRow()">Add Prisoner</button><br>

    <h4>Required Training</h4>
    <div><strong>Training</strong> | <strong>Quantity</strong></div>
    <div id="training-container"></div>
    <button type="button" onclick="addTrainingRow()">Add Training</button><br>

    <h4>Modifiers</h4>
    <div><strong>Type</strong> | <strong>Time Reduction (%)</strong> | <strong>Max Count</strong></div>
    <div id="modifiers-container"></div>
    <button type="button" onclick="addModifierRow()">Add Modifier</button><br>

    <h4>Equipment Required</h4>
    <div><strong>Equipment</strong> | <strong>Quantity</strong></div>
    <div id="equipment-container"></div>
    <button type="button" onclick="addEquipmentRow()">Add Equipment</button><br>

    <button onclick="submitMission()">Save</button>
  `;

  // Populate if editing
  (Array.isArray(existing?.required_units) ? existing.required_units : []).forEach(r => addUnitRequirementRow(r.type, r.quantity ?? r.count ?? 1));
  (Array.isArray(existing?.patients) ? existing.patients : []).forEach(p => addPatientRow(p.min, p.max, p.chance, p.codes));
  (Array.isArray(existing?.prisoners) ? existing.prisoners : []).forEach(p => addPrisonerRow(p.min, p.max, p.chance, p.transportChance));
  (Array.isArray(existing?.required_training) ? existing.required_training : []).forEach(t => addTrainingRow(t.training ?? t.name ?? t, t.qty ?? 1));
  (Array.isArray(existing?.modifiers) ? existing.modifiers : []).forEach(m => addModifierRow(m.type, m.timeReduction, m.maxCount));
  (Array.isArray(existing?.equipment_required) ? existing.equipment_required : []).forEach(e => addEquipmentRow(e.name ?? e, e.qty ?? 1));
}

// ====== Add Row Functions ======
function addUnitRequirementRow(selectedType = "", qty = 1) {
  const container = document.getElementById("unit-req-container");
  const row = document.createElement("div");

  const select = document.createElement("select");
  unitTypes.forEach(u => {
    const option = document.createElement("option");
    option.value = u.type;
    option.textContent = `${u.class} - ${u.type}`;
    if (u.type === selectedType) option.selected = true;
    select.appendChild(option);
  });
  select.name = "type";

  const input = document.createElement("input");
  input.type = "number";
  input.name = "quantity";
  input.min = 1;
  input.value = qty;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove";
  removeBtn.type = "button";
  removeBtn.onclick = () => container.removeChild(row);

  row.appendChild(select);
  row.appendChild(input);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function addPatientRow(min = 0, max = 0, chance = 1, codes = "") {
  const container = document.getElementById("patients-container");
  const row = document.createElement("div");

  const minInput = document.createElement("input");
  minInput.type = "number"; minInput.name = "min"; minInput.min = 0; minInput.value = min;

  const maxInput = document.createElement("input");
  maxInput.type = "number"; maxInput.name = "max"; maxInput.min = 0; maxInput.value = max;

  const chanceInput = document.createElement("input");
  chanceInput.type = "number"; chanceInput.name = "chance"; chanceInput.step = "0.01"; chanceInput.min = 0; chanceInput.max = 1; chanceInput.value = chance;

  const codesInput = document.createElement("input");
  codesInput.type = "text"; codesInput.name = "codes"; codesInput.value = codes;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove"; removeBtn.type = "button"; removeBtn.onclick = () => container.removeChild(row);

  row.appendChild(minInput);
  row.appendChild(maxInput);
  row.appendChild(chanceInput);
  row.appendChild(codesInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function addPrisonerRow(min = 0, max = 0, chance = 1, transportChance = 1) {
  const container = document.getElementById("prisoners-container");
  const row = document.createElement("div");

  const minInput = document.createElement("input");
  minInput.type = "number"; minInput.name = "min"; minInput.min = 0; minInput.value = min;

  const maxInput = document.createElement("input");
  maxInput.type = "number"; maxInput.name = "max"; maxInput.min = 0; maxInput.value = max;

  const chanceInput = document.createElement("input");
  chanceInput.type = "number"; chanceInput.name = "chance"; chanceInput.step = "0.01"; chanceInput.min = 0; chanceInput.max = 1; chanceInput.value = chance;

  const transportInput = document.createElement("input");
  transportInput.type = "number"; transportInput.name = "transportChance"; transportInput.step = "0.01"; transportInput.min = 0; transportInput.max = 1; transportInput.value = transportChance;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove"; removeBtn.type = "button"; removeBtn.onclick = () => container.removeChild(row);

  row.appendChild(minInput);
  row.appendChild(maxInput);
  row.appendChild(chanceInput);
  row.appendChild(transportInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function addTrainingRow(selected = "", qty = 1) {
  const container = document.getElementById("training-container");
  const row = document.createElement("div");

  const select = document.createElement("select");
  getTrainingDisplayList().forEach(({ name, cost }) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = cost ? `${name} ($${cost})` : name;
    if (name === selected) option.selected = true;
    select.appendChild(option);
  });
  select.name = "training";

  const qtyInput = document.createElement("input");
  qtyInput.type = "number"; qtyInput.name = "qty"; qtyInput.min = 1; qtyInput.value = qty;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove"; removeBtn.type = "button"; removeBtn.onclick = () => container.removeChild(row);

  row.appendChild(select);
  row.appendChild(qtyInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function addModifierRow(selectedType = "", timeReduction = 0, maxCount = 1) {
  const container = document.getElementById("modifiers-container");
  const row = document.createElement("div");

  const select = document.createElement("select");
  unitTypes.forEach(u => {
    const option = document.createElement("option");
    option.value = u.type;
    option.textContent = `${u.class} - ${u.type}`;
    if (u.type === selectedType) option.selected = true;
    select.appendChild(option);
  });
  select.name = "type";

  const reductionInput = document.createElement("input");
  reductionInput.type = "number"; reductionInput.name = "timeReduction"; reductionInput.min = 0; reductionInput.max = 100; reductionInput.value = timeReduction;

  const maxCountInput = document.createElement("input");
  maxCountInput.type = "number"; maxCountInput.name = "maxCount"; maxCountInput.min = 1; maxCountInput.value = maxCount;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove"; removeBtn.type = "button"; removeBtn.onclick = () => container.removeChild(row);

  row.appendChild(select);
  row.appendChild(reductionInput);
  row.appendChild(maxCountInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

function addEquipmentRow(selected = "", qty = 1) {
  const container = document.getElementById("equipment-container");
  const row = document.createElement("div");

  const select = document.createElement("select");
  getEquipDisplayList().forEach(({ name, cost }) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = cost ? `${name} ($${cost})` : name;
    if (name === selected) option.selected = true;
    select.appendChild(option);
  });
  select.name = "name";

  const qtyInput = document.createElement("input");
  qtyInput.type = "number"; qtyInput.name = "qty"; qtyInput.min = 1; qtyInput.value = qty;

  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Remove"; removeBtn.type = "button"; removeBtn.onclick = () => container.removeChild(row);

  row.appendChild(select);
  row.appendChild(qtyInput);
  row.appendChild(removeBtn);
  container.appendChild(row);
}

async function editMission(id) {
  const res = await fetch(`/api/mission-templates/id/${id}`);
  const mission = await res.json();
  openMissionForm(mission);
}

async function submitMission() {
  const id = document.getElementById("mission-id").value || null;
  const mission = {
    name: document.getElementById("mission-name").value,
    trigger_type: document.getElementById("trigger-type").value,
    trigger_filter: document.getElementById("trigger-filter").value,
    timing: Number(document.getElementById("timing").value),
    rewards: Number(document.getElementById("rewards").value) || 0, // <-- NEW
    required_units: collectRows("#unit-req-container") || [],
    patients: collectRows("#patients-container") || [],
    prisoners: collectRows("#prisoners-container") || [],
    required_training: collectRows("#training-container") || [],
    modifiers: collectRows("#modifiers-container") || [],
    equipment_required: collectRows("#equipment-container") || []
  };

  const url = id ? `/api/mission-templates/${id}` : `/api/mission-templates`;
  const method = id ? "PUT" : "POST";

  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(mission)
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    console.error("Save failed:", err);
    alert(`Save failed: ${err.error || res.statusText}`);
    return;
  }

  document.getElementById("mission-form-container").style.display = "none";
  await loadMissions();
}

function collectRows(containerSel) {
  const container = document.querySelector(containerSel);
  if (!container) return [];
  const rows = Array.from(container.querySelectorAll("div"));
  if (!rows.length) return [];
  return rows.map(div => {
    const inputs = div.querySelectorAll("input, select");
    const obj = {};
    inputs.forEach(inp => {
      obj[inp.name] = inp.type === "number" ? Number(inp.value) : inp.value;
    });
    return obj;
  });
}
