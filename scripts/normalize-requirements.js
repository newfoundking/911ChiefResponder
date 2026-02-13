#!/usr/bin/env node
const sqlite3 = require('sqlite3').verbose();
const dbPath = process.env.DB_PATH || './chief911.sqlite';

const canonicalRequirementId = (unitClass, type) => {
  const cls = String(unitClass || '').trim().toLowerCase();
  const unitType = String(type || '').trim();
  if (!cls || !unitType) return '';
  return `${cls}:${unitType}`;
};

const normalizeReq = (req) => {
  if (!req || typeof req !== 'object') return req;
  const out = { ...req };
  const tokens = Array.isArray(out.types) ? out.types.filter(Boolean) : [];
  if (out.id) tokens.push(out.id);
  if (out.type) tokens.push(out.type);
  if (out.class && out.type) {
    const id = canonicalRequirementId(out.class, out.type);
    if (id) {
      out.id = id;
      if (!tokens.includes(id)) tokens.unshift(id);
    }
  }
  out.types = [...new Set(tokens.map((v) => String(v).trim()).filter(Boolean))];
  return out;
};

const normalizeJsonArray = (text) => {
  let arr;
  try { arr = JSON.parse(text || '[]'); } catch { return text; }
  if (!Array.isArray(arr)) return text;
  return JSON.stringify(arr.map(normalizeReq));
};

const tables = [
  ['run_cards', 'mission_name', 'units'],
  ['run_card_presets', 'id', 'units'],
  ['mission_templates', 'name', 'required_units'],
  ['missions', 'id', 'required_units'],
];

const db = new sqlite3.Database(dbPath);
for (const [table, keyCol, col] of tables) {
  db.all(`SELECT ${keyCol} AS key, ${col} AS value FROM ${table}`, (err, rows=[]) => {
    if (err) return;
    for (const row of rows) {
      const normalized = normalizeJsonArray(row.value);
      if (normalized !== row.value) {
        db.run(`UPDATE ${table} SET ${col}=? WHERE ${keyCol}=?`, [normalized, row.key]);
      }
    }
  });
}
setTimeout(() => db.close(), 200);
