const path = require('node:path');
const Database = require('better-sqlite3');
const db = new Database(path.join(__dirname, 'tiffin.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  monthly_price REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',   -- 'active' | 'paused' | 'transferred'
  subscribed_on TEXT NOT NULL              -- YYYY-MM-DD
);

CREATE TABLE IF NOT EXISTS pauses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,              -- NULL = still paused (ongoing)
  reason TEXT,
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  served_date TEXT NOT NULL,
  meals INTEGER NOT NULL DEFAULT 1,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(customer_id) REFERENCES customers(id)
);

CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'sms',
  event_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS customer_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_customer_id INTEGER NOT NULL,
  to_customer_id INTEGER NOT NULL,
  transfer_date TEXT NOT NULL,
  previous_monthly_price REAL NOT NULL,
  transferred_deliveries INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;