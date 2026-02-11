const equipmentCatalog = require('../equipment');

function normalizeNameList(value) {
  const raw = Array.isArray(value) ? value : (value === undefined || value === null ? [] : [value]);
  const list = [];
  const seen = new Set();
  for (const item of raw) {
    const name = String(item || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(name);
  }
  return list;
}

function getUpgradeNamesForUnit(unitClass, unitType) {
  const cls = String(unitClass || '').toLowerCase();
  const type = String(unitType || '').trim();
  const cfg = equipmentCatalog?.vehicleUpgrades?.[cls] || null;
  const upgrades = Array.isArray(cfg?.upgrades) ? cfg.upgrades : [];
  const allowed = cfg?.allowedByUnit?.[type];
  const allowedSet = Array.isArray(allowed)
    ? new Set(allowed.map((name) => String(name || '').trim().toLowerCase()).filter(Boolean))
    : null;

  const names = new Set();
  for (const upgrade of upgrades) {
    const name = String(upgrade?.name || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (allowedSet && !allowedSet.has(key)) continue;
    names.add(key);
  }
  return names;
}

function splitUnitLoadout({ unitClass, unitType, equipmentInput, upgradesInput }) {
  const incomingEquipment = normalizeNameList(equipmentInput);
  const incomingUpgrades = normalizeNameList(upgradesInput);
  const validUpgradeNames = getUpgradeNamesForUnit(unitClass, unitType);

  const equipment = [];
  const upgrades = [];
  const equipmentSeen = new Set();
  const upgradeSeen = new Set();

  const pushEquipment = (name) => {
    const key = name.toLowerCase();
    if (equipmentSeen.has(key)) return;
    equipmentSeen.add(key);
    equipment.push(name);
  };
  const pushUpgrade = (name) => {
    const key = name.toLowerCase();
    if (upgradeSeen.has(key)) return;
    upgradeSeen.add(key);
    upgrades.push(name);
  };

  for (const name of incomingEquipment) {
    const key = name.toLowerCase();
    if (validUpgradeNames.has(key)) {
      pushUpgrade(name);
    } else {
      pushEquipment(name);
    }
  }
  for (const name of incomingUpgrades) {
    const key = name.toLowerCase();
    if (!validUpgradeNames.has(key)) continue;
    pushUpgrade(name);
  }

  return { equipment, upgrades };
}

module.exports = {
  normalizeNameList,
  getUpgradeNamesForUnit,
  splitUnitLoadout,
};
