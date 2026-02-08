const trainingsByClass = {
  fire: [
    { name: "firefighter", cost: 500 },
    { name: "paramedic", cost: 800 },
    { name: "hazmat", cost: 900 },
    { name: "chief officer", cost: 1200 },
    { name: "drone pilot", cost: 600 },
    { name: "water rescue", cost: 700 },
    { name: "high angle rescue", cost: 900 },
    { name: "incident command", cost: 1000 }
  ],
  police: [
    { name: "police officer", cost: 500 },
    { name: "investigator", cost: 700 },
    { name: "SWAT", cost: 1200 },
    { name: "K9 handler", cost: 1000 },
    { name: "traffic specialist", cost: 500 },
    { name: "forensics", cost: 800 },
    { name: "supervisor", cost: 900 },
    { name: "drone pilot", cost: 600 },
    { name: "negotiator", cost: 900 }
  ],
  ambulance: [
    { name: "EMR", cost: 400 },
    { name: "paramedic", cost: 800 },
    { name: "critical care", cost: 1200 },
    { name: "team lead", cost: 900 },
    { name: "incident command", cost: 1000 }
  ],
  fire_rescue: [
    { name: "firefighter", cost: 500 },
    { name: "paramedic", cost: 800 },
    { name: "hazmat", cost: 900 },
    { name: "chief officer", cost: 1200 },
    { name: "drone pilot", cost: 600 },
    { name: "water rescue", cost: 700 },
    { name: "high angle rescue", cost: 900 },
    { name: "incident command", cost: 1000 },
    { name: "EMR", cost: 400 },
    { name: "critical care", cost: 1200 },
    { name: "team lead", cost: 900 }
  ],
  sar: [
    { name: "searcher", cost: 500 },
    { name: "team leader", cost: 900 },
    { name: "search manager", cost: 1200 },
    { name: "high angle rescue", cost: 900 },
    { name: "water rescue", cost: 700 },
    { name: "drone pilot", cost: 600 },
    { name: "EMR", cost: 400 },
    { name: "paramedic", cost: 800 }
  ]
};

const trainingDefaults = {
  fire: ["firefighter"],
  police: ["police officer"],
  ambulance: ["EMR"],
  fire_rescue: ["firefighter", "EMR"],
  sar: ["searcher"],
};

const trainingEquivalencies = {
  fire: {
    "chief officer": ["incident command", "firefighter"],
    "incident command": ["firefighter"],
    "paramedic": ["EMR"],
  },
  police: {
    "SWAT": ["police officer"],
    "K9 handler": ["police officer"],
  },
  ambulance: {
    "critical care": ["paramedic", "EMR"],
    "paramedic": ["EMR"],
    "incident command": ["team lead"],
  },
  fire_rescue: {
    "chief officer": ["incident command", "firefighter"],
    "incident command": ["firefighter", "team lead"],
    "critical care": ["paramedic", "EMR"],
    "paramedic": ["EMR"],
  },
  sar: {
    "search manager": ["team leader", "searcher"],
    "team leader": ["searcher"],
    "high angle rescue": ["searcher"],
    "water rescue": ["searcher"],
    "drone pilot": ["searcher"],
    "paramedic": ["EMR"],
  },
};

function classKey(cls) {
  return String(cls || '').trim().toLowerCase();
}

function normalizeInputList(list) {
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const item of list) {
    let value = '';
    if (typeof item === 'string') value = item;
    else if (item && typeof item === 'object' && typeof item.name === 'string') value = item.name;
    else if (item != null) value = String(item);
    const trimmed = value.trim();
    if (!trimmed) continue;
    result.push(trimmed);
  }
  return result;
}

function buildEquivalencyMaps(cls) {
  const key = classKey(cls);
  const rawList = trainingsByClass[key] || [];
  const order = [];
  const canonical = new Map();
  rawList.forEach((entry) => {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (!name) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    const lower = trimmed.toLowerCase();
    if (!canonical.has(lower)) {
      canonical.set(lower, trimmed);
    }
    order.push(canonical.get(lower));
  });

  const rawEquiv = trainingEquivalencies[key] || {};
  const forward = new Map();
  const reverse = new Map();
  Object.entries(rawEquiv).forEach(([higher, lowers]) => {
    const higherKey = String(higher || '').trim().toLowerCase();
    if (!higherKey) return;
    const higherName = canonical.get(higherKey);
    if (!higherName) return;
    const list = Array.isArray(lowers) ? lowers : [lowers];
    const parentKey = higherName.toLowerCase();
    list.forEach((lower) => {
      const lowerKey = String(lower || '').trim().toLowerCase();
      if (!lowerKey) return;
      const lowerName = canonical.get(lowerKey);
      if (!lowerName) return;
      if (!forward.has(parentKey)) forward.set(parentKey, new Set());
      forward.get(parentKey).add(lowerName);
      if (!reverse.has(lowerKey)) reverse.set(lowerKey, new Set());
      reverse.get(lowerKey).add(higherName);
    });
  });

  return { forward, reverse, canonical, order };
}

function gatherForward(name, maps, visited = new Set()) {
  const trimmed = String(name || '').trim();
  const key = trimmed.toLowerCase();
  if (!trimmed || visited.has(key)) return [];
  visited.add(key);
  const direct = maps.forward.get(key);
  if (!direct) return [];
  const results = [];
  direct.forEach((child) => {
    results.push(child);
    gatherForward(child, maps, visited).forEach((value) => results.push(value));
  });
  return results;
}

function sortByOrder(list, order) {
  if (!Array.isArray(list)) return [];
  const orderMap = new Map();
  order.forEach((name, idx) => {
    const key = String(name || '').toLowerCase();
    if (!orderMap.has(key)) orderMap.set(key, idx);
  });
  return list.slice().sort((a, b) => {
    const aKey = String(a || '').trim().toLowerCase();
    const bKey = String(b || '').trim().toLowerCase();
    const aIdx = orderMap.has(aKey) ? orderMap.get(aKey) : Number.MAX_SAFE_INTEGER;
    const bIdx = orderMap.has(bKey) ? orderMap.get(bKey) : Number.MAX_SAFE_INTEGER;
    if (aIdx !== bIdx) return aIdx - bIdx;
    if (aKey === bKey) return 0;
    return aKey < bKey ? -1 : 1;
  });
}

function getTrainingsForClass(cls) {
  const key = classKey(cls);
  const list = trainingsByClass[key];
  return Array.isArray(list) ? list.slice() : [];
}

function getTrainingDefaults(cls) {
  const defaults = trainingDefaults[classKey(cls)];
  if (!defaults) return [];
  const arr = Array.isArray(defaults) ? defaults : [defaults];
  const maps = buildEquivalencyMaps(cls);
  const seen = new Map();
  arr.forEach((value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const canonical = maps.canonical.get(trimmed.toLowerCase());
    if (!canonical) return;
    const key = canonical.toLowerCase();
    if (!seen.has(key)) seen.set(key, canonical);
  });
  return sortByOrder(Array.from(seen.values()), maps.order);
}

function expandTrainingList(list, cls) {
  const values = normalizeInputList(list);
  if (!values.length) return [];
  const maps = buildEquivalencyMaps(cls);
  const seen = new Map();
  values.forEach((value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const canonical = maps.canonical.get(key) || trimmed;
    const canonicalKey = canonical.toLowerCase();
    if (!seen.has(canonicalKey)) seen.set(canonicalKey, canonical);
    if (maps.canonical.has(key)) {
      gatherForward(canonical, maps).forEach((child) => {
        const childKey = child.toLowerCase();
        if (!seen.has(childKey)) seen.set(childKey, child);
      });
    }
  });
  return sortByOrder(Array.from(seen.values()), maps.order);
}

function collapseTrainingList(list, cls) {
  const values = normalizeInputList(list);
  if (!values.length) return [];
  const maps = buildEquivalencyMaps(cls);
  const seen = new Map();
  values.forEach((value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed) return;
    const key = trimmed.toLowerCase();
    const canonical = maps.canonical.get(key) || trimmed;
    const canonicalKey = canonical.toLowerCase();
    if (!seen.has(canonicalKey)) seen.set(canonicalKey, canonical);
  });
  const implied = new Set();
  seen.forEach((name, key) => {
    gatherForward(name, maps).forEach((child) => {
      const childKey = child.toLowerCase();
      if (seen.has(childKey)) implied.add(childKey);
    });
  });
  const collapsed = [];
  seen.forEach((name, key) => {
    if (!implied.has(key)) collapsed.push(name);
  });
  return sortByOrder(collapsed, maps.order);
}

function ensureDefaultTrainings(list, cls) {
  const base = normalizeInputList(list);
  const defaults = getTrainingDefaults(cls);
  if (!defaults.length) return expandTrainingList(base, cls);
  const combined = base.slice();
  const seen = new Set(combined.map((name) => String(name || '').toLowerCase()));
  defaults.forEach((name) => {
    const key = String(name || '').toLowerCase();
    if (!seen.has(key)) {
      combined.push(name);
      seen.add(key);
    }
  });
  return expandTrainingList(combined, cls);
}

function getTrainingGraph(cls) {
  const maps = buildEquivalencyMaps(cls);
  const forward = {};
  maps.forward.forEach((set, key) => {
    forward[key] = Array.from(set);
  });
  const reverse = {};
  maps.reverse.forEach((set, key) => {
    reverse[key] = Array.from(set);
  });
  const canonical = {};
  maps.canonical.forEach((value, key) => {
    canonical[key] = value;
  });
  return { forward, reverse, canonical, order: maps.order.slice() };
}

const trainingModule = {
  trainingsByClass,
  trainingDefaults,
  trainingEquivalencies,
  getTrainingsForClass,
  getTrainingDefaults,
  expandTrainingList,
  collapseTrainingList,
  ensureDefaultTrainings,
  getTrainingGraph,
};

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = trainingModule;
}

if (typeof window !== 'undefined') {
  window.trainingsByClass = trainingsByClass;
  window.trainingDefaults = trainingDefaults;
  window.trainingEquivalencies = trainingEquivalencies;
  window.trainingHelpers = trainingModule;
}
