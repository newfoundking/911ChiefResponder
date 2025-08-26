const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./names.db");

function getRandomName() {
  return new Promise((resolve, reject) => {
    db.get("SELECT first_name AS first FROM names ORDER BY RANDOM() LIMIT 1", (err, firstRow) => {
      if (err) return reject(err);
      db.get("SELECT last_name AS last FROM names ORDER BY RANDOM() LIMIT 1", (err2, lastRow) => {
        if (err2) return reject(err2);
        resolve({ first: firstRow.first, last: lastRow.last });
      });
    });
  });
}

module.exports = { getRandomName };