const defaultUnitEquipment = {
  fire: {
    // Fire units start without default equipment; upgrades/equipment are configured per unit.
  },
  ambulance: {
    Ambulance: ['ALS Medical'],
    'Fly-car': ['ALS Medical'],
    Supervisor: ['ALS Medical'],
    'Mass Casualty': ['ALS Medical'],
    'Inter-facility Transport': ['ALS Medical']
  },
  police: {
    'SWAT Van': ['Tactical Gear']
  }
};

function getDefaultUnitEquipment(unitClass, unitType) {
  if (!unitClass || !unitType) return [];
  const cls = String(unitClass).toLowerCase();
  const type = String(unitType).toLowerCase();
  const classMap = defaultUnitEquipment[cls];
  if (!classMap) return [];
  const entries = classMap[unitType] || classMap[type] || classMap[String(unitType)] || classMap[String(unitType).trim()];
  if (Array.isArray(entries)) return entries.slice();
  // Fall back to case-insensitive lookup
  for (const [name, list] of Object.entries(classMap)) {
    if (String(name).toLowerCase() === type) {
      return Array.isArray(list) ? list.slice() : [];
    }
  }
  return [];
}

const defaultEquipmentApi = { defaultUnitEquipment, getDefaultUnitEquipment };

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = defaultEquipmentApi;
} else {
  const globalObj = typeof globalThis !== 'undefined' ? globalThis : window;
  globalObj.defaultUnitEquipment = defaultUnitEquipment;
  globalObj.getDefaultUnitEquipment = getDefaultUnitEquipment;
}
