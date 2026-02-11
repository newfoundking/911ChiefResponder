const { parseArrayField } = require('./index');

function equipmentKey(name) {
  if (name === null || name === undefined) return '';
  const trimmed = String(name).trim();
  return trimmed ? trimmed.toLowerCase() : '';
}

function trainingKey(name) {
  if (name === null || name === undefined) return '';
  const trimmed = String(name).trim();
  return trimmed ? trimmed.toLowerCase() : '';
}

function gatherUnitEquipment(unit, getDefaultUnitEquipment) {
  const counts = new Map();
  if (!unit) return counts;
  const eqArr = [
    ...(Array.isArray(unit.equipment) ? unit.equipment : parseArrayField(unit.equipment)),
    ...(Array.isArray(unit.upgrades) ? unit.upgrades : parseArrayField(unit.upgrades)),
  ];
  for (const eq of eqArr) {
    const label = typeof eq === 'string' ? eq : eq?.name;
    const key = equipmentKey(label);
    if (!key) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  if (typeof getDefaultUnitEquipment === 'function') {
    const defaults = getDefaultUnitEquipment(unit.class, unit.type) || [];
    for (const provided of defaults) {
      const key = equipmentKey(provided);
      if (!key || counts.has(key)) continue;
      counts.set(key, 1);
    }
  }
  return counts;
}

function getUnitTrainingKeySet(unit, expandTrainingList) {
  const set = new Set();
  if (!unit) return set;
  const personnel = Array.isArray(unit.personnel) ? unit.personnel : parseArrayField(unit.personnel);
  for (const p of personnel) {
    const tList = Array.isArray(p?.training) ? p.training : parseArrayField(p?.training);
    const expanded = typeof expandTrainingList === 'function'
      ? expandTrainingList(tList, unit.class)
      : (Array.isArray(tList) ? tList : []);
    for (const t of expanded) {
      const key = trainingKey(t);
      if (key) set.add(key);
    }
  }
  return set;
}

function getVehicleUpgradeConfigForClass(vehicleUpgrades, unitClass) {
  const key = String(unitClass || '').toLowerCase();
  return vehicleUpgrades?.[key] || null;
}

function getUnitQualificationSet(unit, options = {}) {
  const quals = new Set();
  if (!unit) return quals;
  const aliasMap = new Map([
    ['Chief', 'Command Vehicle'],
    ['Command Vehicle', 'Chief'],
  ]);
  const addQualification = (label) => {
    if (!label) return;
    quals.add(label);
    const alias = aliasMap.get(label);
    if (alias) quals.add(alias);
  };
  if (unit.type) addQualification(unit.type);
  const cfg = getVehicleUpgradeConfigForClass(options.vehicleUpgrades || {}, unit.class);
  const upgrades = Array.isArray(cfg?.upgrades) ? cfg.upgrades : [];
  if (!upgrades.length) return quals;
  const allowed = cfg?.allowedByUnit?.[unit.type];
  const allowedSet = Array.isArray(allowed)
    ? new Set(allowed.map((name) => String(name || '').toLowerCase()))
    : null;
  const equipmentKeys = new Set(gatherUnitEquipment(unit, options.getDefaultUnitEquipment).keys());
  const trainingKeys = getUnitTrainingKeySet(unit, options.expandTrainingList);

  for (const upgrade of upgrades) {
    const upgradeName = String(upgrade?.name || '').trim();
    if (!upgradeName) continue;
    if (allowedSet && !allowedSet.has(upgradeName.toLowerCase())) continue;
    const qualifiesAs = upgrade?.qualifiesAs || upgrade?.type || upgradeName;
    const equipmentAny = Array.isArray(upgrade?.equipmentAny)
      ? upgrade.equipmentAny
      : (upgrade?.equipment ? [upgrade.equipment] : [upgradeName]);
    const trainingAny = Array.isArray(upgrade?.trainingAny)
      ? upgrade.trainingAny
      : (upgrade?.training ? [upgrade.training] : []);
    const mode = upgrade?.mode === 'all' ? 'all' : 'any';
    const equipmentMatch = equipmentAny.length
      ? equipmentAny.some((name) => equipmentKeys.has(equipmentKey(name)))
      : false;
    const trainingMatch = trainingAny.length
      ? trainingAny.some((name) => trainingKeys.has(trainingKey(name)))
      : false;
    if (mode === 'all') {
      const equipmentOk = equipmentAny.length ? equipmentMatch : true;
      const trainingOk = trainingAny.length ? trainingMatch : true;
      if (equipmentOk && trainingOk) addQualification(qualifiesAs);
    } else if ((equipmentAny.length && equipmentMatch) || (trainingAny.length && trainingMatch)) {
      addQualification(qualifiesAs);
    }
  }
  return quals;
}

module.exports = {
  equipmentKey,
  trainingKey,
  gatherUnitEquipment,
  getUnitTrainingKeySet,
  getUnitQualificationSet,
};
