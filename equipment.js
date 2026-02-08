const equipment = {
  fire: [
    { name: "Foam", cost: 2500 },
    { name: "Medical", cost: 1000 },
    { name: "Drone", cost: 5000 }
  ],
  police: [
    { name: "Drone", cost: 5000 },
    { name: "Ballistic Shield", cost: 1500 },
    { name: "Battering Ram", cost: 700 }
  ],
  ambulance: [
    { name: "Med stuff", cost: 1000 },
    { name: "Defibrillator", cost: 1200 },
    { name: "Ventilator", cost: 3500 }
  ],
  fire_rescue: [
    { name: "Foam", cost: 2500 },
    { name: "Medical", cost: 1000 },
    { name: "Drone", cost: 5000 },
    { name: "Med stuff", cost: 1000 },
    { name: "Defibrillator", cost: 1200 },
    { name: "Ventilator", cost: 3500 }
  ],
  sar: [
    { name: "Drone", cost: 5000 }
  ]
};

const vehicleUpgrades = {
  fire: {
    upgrades: [
      { name: "Large Tank", cost: 2500, qualifiesAs: "Tanker", equipmentAny: ["Large Tank"] },
      { name: "Rescue Gear", cost: 2000, qualifiesAs: "Rescue", equipmentAny: ["Rescue Gear"] },
      { name: "Ladders", cost: 3000, qualifiesAs: "Ladder", equipmentAny: ["Ladders"] },
      {
        name: "Command Board",
        cost: 1500,
        qualifiesAs: "Command Vehicle",
        equipmentAny: ["Command Board"],
        trainingAny: ["incident command", "chief officer"],
        mode: "all"
      },
      { name: "Quint", cost: 3500, qualifiesAs: "Engine", equipmentAny: ["Quint"] }
    ],
    allowedByUnit: {
      ARFF: ["Ladders"],
      "Command Vehicle": [],
      Engine: ["Large Tank", "Rescue Gear", "Ladders", "Command Board"],
      Ladder: ["Quint", "Rescue Gear"],
      Rescue: ["Ladders"],
      "Special Operations": ["Rescue Gear", "Ladders"],
      "Support Unit": ["Command Board", "Ladders", "Rescue Gear"],
      Tanker: []
    }
  }
};

equipment.vehicleUpgrades = vehicleUpgrades;

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = equipment;
} else if (typeof window !== 'undefined') {
  window.vehicleUpgrades = vehicleUpgrades;
}
