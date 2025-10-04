const defaultUnitEquipment = {
  fire: {
    Ladder: ['Ladder'],
    ARFF: ['Foam System'],
    Rescue: ['Rescue Gear']
  },
  ambulance: {
    Ambulance: ['Med Stuff'],
    'Fly-car': ['Med Stuff'],
    Supervisor: ['Med Stuff'],
    'Mass Casualty': ['Med Stuff']
  },
  police: {
    'SWAT Van': ['Ballistic Shield', 'Battering Ram']
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
