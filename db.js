'use strict';
/**
 * db.js — dual backend: PostgreSQL (Neon) when DATABASE_URL is set,
 * otherwise a JSON file. One household per deployment (Satish's house).
 *
 * Shape:
 *   users:    [{id, username, name, passHash, mustChangePw, createdAt}]
 *   sessions: [{id, userId, admin:bool, createdAt}]
 *   ledger:   ledger.js state {monthlyTarget, contributions, txns, allocs, seq}
 *   bills:    [{id, name, cents, due, recurrence, split, payerId, status, paidAt}]
 *   shopping: [{id, item, qty, assignedTo, estCents, done, createdAt}]
 *   inventory:[{id, product, qty, unit, category, costCents, boughtAt, expires}]
 *   receipts: [{id, txnId, file, merchant, totalCents, items, status, by, at}]
 */
const fs = require('fs');
const path = require('path');
const ledger = require('./ledger');

let DATA_DIR = process.env.HF_DATA_DIR || path.join(__dirname, 'data');
const JSON_PATH = () => path.join(DATA_DIR, 'data.json');
const BACKUP_DIR = () => path.join(DATA_DIR, 'backups');

let pg = null;
try { pg = require('pg'); } catch (e) { console.warn('[db] pg not installed — JSON storage only'); }

let pool = null;
let backend = null; // 'pg' | 'json'
let cache = null;

function blankDb() {
  return {
    users: [], sessions: [],
    ledger: ledger.blankLedger(),
    bills: [], shopping: [], inventory: [], receipts: [],
    seq: 1,
  };
}

function nextId(db) { return 'u' + (db.seq++); }

// ---------------------------------------------------------------- JSON ---

function loadCache() {
  if (cache) return cache;
  const p = JSON_PATH();
  try {
    cache = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : blankDb();
  } catch (e) {
    console.warn('[db] data.json unreadable, starting fresh:', e.message);
    cache = blankDb();
  }
  for (const k of ['users', 'sessions', 'bills', 'shopping', 'inventory', 'receipts']) cache[k] = cache[k] || [];
  cache.ledger = cache.ledger || ledger.blankLedger();
  cache.seq = cache.seq || 1;
  return cache;
}

function saveCache() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  snapshot();
  const tmp = JSON_PATH() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, JSON_PATH());
}

/** Keep a rolling set of dated backups (the "years and years" safety net). */
function snapshot() {
  try {
    const dir = BACKUP_DIR();
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(dir, 'backup-' + day + '.json'), JSON.stringify(cache));
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('backup-')).sort();
    while (files.length > 30) fs.unlinkSync(path.join(dir, files.shift()));
  } catch (e) { console.warn('[db] snapshot failed:', e.message); }
}

// ------------------------------------------------------------------ PG ---

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hf_kv (
  k TEXT PRIMARY KEY,
  v JSONB NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);`;

async function pgInit() {
  const url = process.env.DATABASE_URL;
  if (!url || !pg) return false;
  try {
    pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
    await pool.query(SCHEMA);
    backend = 'pg';
    console.log('[db] PostgreSQL backend active');
    // One-time migration from JSON if it has data and pg is empty
    const r = await pool.query('SELECT v FROM hf_kv WHERE k=$1', ['state']);
    if (r.rows.length === 0) {
      const file = loadCache();
      const hasData = file.users.length > 0 || file.ledger.txns.length > 0;
      if (hasData) {
        await pool.query('INSERT INTO hf_kv (k, v) VALUES ($1, $2)', ['state', JSON.stringify(file)]);
        console.log('[db] migrated JSON data into Postgres');
      }
    }
    return true;
  } catch (e) {
    console.warn('[db] Postgres unreachable, JSON fallback:', e.message);
    pool = null;
    return false;
  }
}

async function pgGet() {
  const r = await pool.query('SELECT v FROM hf_kv WHERE k=$1', ['state']);
  if (r.rows.length === 0) return blankDb();
  const db = r.rows[0].v;
  db.users = db.users || []; db.sessions = db.sessions || [];
  db.ledger = db.ledger || ledger.blankLedger();
  for (const k of ['bills', 'shopping', 'inventory', 'receipts']) db[k] = db[k] || [];
  db.seq = db.seq || 1;
  return db;
}

async function pgSave(db) {
  await pool.query(
    `INSERT INTO hf_kv (k, v, updated_at) VALUES ('state', $1, now())
     ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v, updated_at = now()`,
    [JSON.stringify(db)]
  );
}

// ----------------------------------------------------------------- API ---

async function init() {
  if (!(await pgInit())) {
    backend = 'json';
    loadCache();
    console.log('[db] JSON file backend active');
  }
}

function isPg() { return backend === 'pg'; }

/**
 * Load the db, run fn(db), save. Serializes mutations so two roommates
 * saving at the same moment cannot interleave (brief section 13).
 */
let _queue = Promise.resolve();
function mutate(fn) {
  const run = async () => {
    let db;
    if (isPg()) db = await pgGet();
    else { db = loadCache(); }
    const out = await fn(db);
    if (isPg()) await pgSave(db);
    else { cache = db; saveCache(); }
    return out;
  };
  const p = _queue.then(run);
  _queue = p.catch(() => {});
  return p;
}

async function read(fn) {
  if (isPg()) return fn(await pgGet());
  return fn(loadCache());
}

module.exports = { init, isPg, mutate, read, nextId, BACKUP_DIR, DATA_DIR };
