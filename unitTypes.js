const CLASS_SPEED = { fire: 63, police: 94, ambulance: 75, sar: 70 };

const unitTypes = [
  { class: "fire", type: "Engine",            capacity: 6, equipmentSlots: 3, attributes: ["waterTank"], cost: 12000, speed: 65 },
  { class: "fire", type: "Ladder",            capacity: 4, equipmentSlots: 2, attributes: ["ladder"], cost: 18000, speed: 60 },
  { class: "fire", type: "Chief",             capacity: 2, equipmentSlots: 2, attributes: [], cost: 8000,  speed: 75 },
  { class: "fire", type: "Rescue",            capacity: 4, equipmentSlots: 2, attributes: [], cost: 15000, speed: 65 },
  { class: "fire", type: "Special Operations",capacity: 4, equipmentSlots: 2, attributes: [], cost: 22000, speed: 75 },
  { class: "fire", type: "Tanker",            capacity: 4, equipmentSlots: 2, attributes: ["tanker"], cost: 12000, speed: 55 },
  { class: "fire", type: "Support Unit",      capacity: 2, equipmentSlots: 4, attributes: [], cost: 5000,  speed: 70 },
  { class: "fire", type: "ARFF",              capacity: 2, equipmentSlots: 4, attributes: ["foam"], cost: 8000,  speed: 60 },

  { class: "ambulance", type: "Ambulance",    capacity: 2, equipmentSlots: 1, attributes: ["medicaltransport"], cost: 14000, speed: 60 },
  { class: "ambulance", type: "Fly-car",      capacity: 2, equipmentSlots: 1, attributes: [], cost: 9000,  speed: 75 },
  { class: "ambulance", type: "Supervisor",   capacity: 4, equipmentSlots: 2, attributes: [], cost: 10000, speed: 75 },
  { class: "ambulance", type: "Mass Casualty",capacity: 4, equipmentSlots: 2, attributes: ["medicaltransport"],  cost: 25000, speed: 60 },
  { class: "ambulance", type: "Inter-facility Transport", capacity: 2, equipmentSlots: 1, attributes: ["medicaltransport"], cost: 13000, speed: 65 },

  { class: "police", type: "Patrol Car",      capacity: 2, equipmentSlots: 2, attributes: ["prisonerTransport"], cost: 9000,  speed: 85 },
  { class: "police", type: "Unmarked Car",    capacity: 4, equipmentSlots: 2, attributes: [], cost: 9500,  speed: 85 },
  { class: "police", type: "Special Services", capacity: 4, equipmentSlots: 4, attributes: [], cost: 20000, speed: 75 },
  { class: "police", type: "SWAT Van",        capacity: 6, equipmentSlots: 4, attributes: ["armor","SWAT"], cost: 30000, speed: 65 },

  { class: "sar", type: "Rescue",     capacity: 4, equipmentSlots: 4, attributes: [], cost: 15000, speed: 65 },
  { class: "sar", type: "Support",    capacity: 2, equipmentSlots: 4, attributes: [], cost: 5000,  speed: 75 },
  { class: "sar", type: "Command",    capacity: 2, equipmentSlots: 3, attributes: [], cost: 15000, speed: 65 },
  { class: "sar", type: "Off Road",   capacity: 2, equipmentSlots: 2, attributes: [], cost: 12000, speed: 65 }
];

unitTypes.forEach(u => {
  if (typeof u.speed !== 'number') {
    u.speed = CLASS_SPEED[u.class] || 63;
  }
});

unitTypes.sort((a,b) => a.class.localeCompare(b.class) || a.type.localeCompare(b.type));
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = unitTypes;
}
