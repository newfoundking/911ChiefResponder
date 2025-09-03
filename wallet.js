const db = require('./db');
let equipment = {};
try { equipment = require('./equipment'); } catch { /* falls back to {} */ }

function findEquipmentCostByName(name) {
  try {
    const lists = Object.values(equipment || {});
    for (const arr of lists || []) {
      for (const item of arr || []) {
        if (typeof item === 'string' && item === name) return 0;
        if (item?.name === name) return Number(item.cost) || 0;
      }
    }
    return 0;
  } catch { return 0; }
}

function getBalance() {
  return new Promise((resolve, reject) => {
    db.get(`SELECT balance FROM wallet WHERE id=1`, (e, row) =>
      e ? reject(e) : resolve(Number(row?.balance || 0))
    );
  });
}

function adjustBalance(delta) {
  return new Promise((resolve, reject) => {
    db.run(`UPDATE wallet SET balance = balance + ? WHERE id=1`, [Number(delta) || 0],
      function (e) { e ? reject(e) : resolve(true); });
  });
}

async function requireFunds(amount) {
  const need = Number(amount) || 0;
  const bal = await getBalance();
  if (bal < need) return { ok: false, balance: bal, need };
  return { ok: true, balance: bal };
}

module.exports = {
  findEquipmentCostByName,
  getBalance,
  adjustBalance,
  requireFunds,
};
