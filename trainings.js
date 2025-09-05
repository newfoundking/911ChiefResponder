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
    { name: "EMR", cost: 400 },␊
    { name: "paramedic", cost: 800 },␊
    { name: "critical care", cost: 1200 },␊
    { name: "team lead", cost: 900 },
    { name: "incident command", cost: 1000 }
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

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = trainingsByClass;
}