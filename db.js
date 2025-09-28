const sqlite3 = require("sqlite3").verbose();

const dbPath = process.env.DB_PATH || process.env.SQLITE_DB_PATH || "./game.db";
const db = new sqlite3.Database(dbPath);

module.exports = db;
