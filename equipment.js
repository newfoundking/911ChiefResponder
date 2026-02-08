const equipment = {
  fire: [
    { name: "Foam", cost: 2500 },
    { name: "Medical", cost: 1000 },
    { name: "Drone", cost: 5000 }
  ],
  police: [
    { name: "Drone", cost: 5000 },
    { name: "Tactical Gear", cost: 2500 },
    { name: "Forensic Equipment", cost: 2000 }
  ],
  ambulance: [
    { name: "ALS Medical", cost: 1500 },
    { name: "Rescue Gear", cost: 2000 }
  ],
  fire_rescue: [
    { name: "Foam", cost: 2500 },
    { name: "Medical", cost: 1000 },
    { name: "Drone", cost: 5000 },
    { name: "ALS Medical", cost: 1500 },
    { name: "Rescue Gear", cost: 2000 }
  ],
  sar: [
    { name: "Drone", cost: 5000 },
    { name: "Rescue Gear", cost: 2000 },
    { name: "Medical", cost: 1000 }
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
  },
  police: {
    upgrades: [
      { name: "Tactical Unit", cost: 2500, qualifiesAs: "SWAT Van", equipmentAny: ["Tactical Unit"] },
      { name: "Patrol Gear", cost: 1500, qualifiesAs: "Patrol Car", equipmentAny: ["Patrol Gear"] }
    ],
    allowedByUnit: {
      "Patrol Car": ["Tactical Unit"],
      "Unmarked Car": ["Tactical Unit", "Patrol Gear"],
      "Special Services": ["Tactical Unit", "Patrol Gear"],
      "SWAT Van": []
    }
  },
  sar: {
    upgrades: [
      { name: "Command Board", cost: 1500, qualifiesAs: "Command", equipmentAny: ["Command Board"] },
      { name: "4x4", cost: 2000, qualifiesAs: "Off Road", equipmentAny: ["4x4"] }
    ],
    allowedByUnit: {
      Rescue: ["Command Board", "4x4"],
      Support: ["Command Board", "4x4"],
      Command: [],
      "Off Road": []
    }
  },
  ambulance: {
    upgrades: [
      { name: "Command Board", cost: 1500, qualifiesAs: "Supervisor", equipmentAny: ["Command Board"] }
    ],
    allowedByUnit: {
      Ambulance: ["Command Board"],
      "Fly-car": ["Command Board"],
      "Mass Casualty": ["Command Board"],
      Supervisor: [],
      "Inter-facility Transport": []
    }
  }
};

equipment.vehicleUpgrades = vehicleUpgrades;

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = equipment;
} else if (typeof window !== 'undefined') {
  window.vehicleUpgrades = vehicleUpgrades;
}
