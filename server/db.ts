import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Settings } from '../shared/types';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');

const inMemory = process.env.KEEL_DB === ':memory:';
if (!inMemory) fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(inMemory ? ':memory:' : path.join(DATA_DIR, 'keel.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,
  plaid_item_id TEXT UNIQUE,
  access_token TEXT NOT NULL,
  institution TEXT NOT NULL,
  cursor TEXT,
  status TEXT NOT NULL DEFAULT 'ok',
  error TEXT,
  last_sync TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  item_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  plaid_account_id TEXT UNIQUE,
  name TEXT NOT NULL,
  institution TEXT,
  mask TEXT,
  type TEXT NOT NULL,
  subtype TEXT,
  balance REAL NOT NULL DEFAULT 0,
  credit_limit REAL,
  apr REAL,
  min_payment REAL,
  due_day INTEGER,
  manual INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'manual',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  plaid_transaction_id TEXT UNIQUE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  name TEXT NOT NULL,
  merchant TEXT,
  category TEXT NOT NULL DEFAULT 'other',
  category_locked INTEGER NOT NULL DEFAULT 0,
  pending INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);
CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  plaid_security_id TEXT,
  symbol TEXT,
  name TEXT NOT NULL,
  quantity REAL NOT NULL,
  price REAL NOT NULL DEFAULT 0,
  cost_basis REAL,
  asset_class TEXT NOT NULL DEFAULT 'other',
  price_updated_at TEXT,
  manual INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS budgets (
  category TEXT PRIMARY KEY,
  amount REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'savings',
  target_amount REAL NOT NULL,
  current_amount REAL NOT NULL DEFAULT 0,
  linked_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  target_date TEXT,
  monthly_contribution REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS insights (
  id TEXT PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  area TEXT NOT NULL,
  severity TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  action TEXT,
  source TEXT NOT NULL DEFAULT 'monitor',
  status TEXT NOT NULL DEFAULT 'new',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  date TEXT PRIMARY KEY,
  assets REAL NOT NULL,
  debt REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS rules (
  pattern TEXT PRIMARY KEY,
  category TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export const uid = () => randomUUID();
export const nowIso = () => new Date().toISOString();

/** Local calendar date as YYYY-MM-DD. */
export function isoDate(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const q = {
  all: <T = any>(sql: string, ...params: unknown[]) => db.prepare(sql).all(...params) as T[],
  get: <T = any>(sql: string, ...params: unknown[]) => db.prepare(sql).get(...params) as T | undefined,
  run: (sql: string, ...params: unknown[]) => db.prepare(sql).run(...params),
};

const DEFAULTS: Settings = {
  strategy: 'avalanche',
  extra_payment: 0,
  target_allocation: null,
  default_account_id: null,
  emergency_months: 3,
  demo: false,
};

export function getSetting<T>(key: string, fallback: T): T {
  const row = q.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export function setSetting(key: string, value: unknown) {
  q.run(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value),
  );
}

export function getSettings(): Settings {
  const out = { ...DEFAULTS } as Record<string, unknown>;
  for (const k of Object.keys(DEFAULTS)) out[k] = getSetting(k, (DEFAULTS as any)[k]);
  return out as unknown as Settings;
}

export function patchSettings(patch: Partial<Settings>) {
  for (const [k, v] of Object.entries(patch)) {
    if (k in DEFAULTS && v !== undefined) setSetting(k, v);
  }
}

export function wipeAll() {
  db.exec(`
    DELETE FROM transactions; DELETE FROM holdings; DELETE FROM goals; DELETE FROM accounts;
    DELETE FROM items; DELETE FROM budgets; DELETE FROM insights; DELETE FROM snapshots;
    DELETE FROM rules; DELETE FROM chat; DELETE FROM settings;
  `);
}
