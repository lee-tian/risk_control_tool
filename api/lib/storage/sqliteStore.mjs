import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DB_FILE_NAME = 'risk-tool.sqlite';
const DB_BACKUP_FILE_NAME = 'risk-tool-latest.sqlite';
const BACKUP_INTERVAL_MS = 60 * 60 * 1000;
let initialized = false;
let db = null;
let writeQueue = Promise.resolve();

function getDataDir() {
  return process.env.APP_DATA_DIR ?? path.join(process.cwd(), 'data');
}

function getDbFile() {
  return path.join(getDataDir(), DB_FILE_NAME);
}

function getLegacyAppStateFile() {
  return path.join(getDataDir(), 'app-state.json');
}

function getLegacyVixCacheFile() {
  return path.join(getDataDir(), 'vix-cache.json');
}

function getLegacyRefreshStatusFile() {
  return path.join(getDataDir(), 'refresh-status.json');
}

function getBackupDir() {
  return path.join(getDataDir(), 'app-state-backups');
}

function getBackupFile() {
  return path.join(getBackupDir(), DB_BACKUP_FILE_NAME);
}

async function ensureDataDir() {
  await mkdir(getDataDir(), { recursive: true });
}

async function readJsonFile(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }
}

function openDb() {
  if (db) {
    return db;
  }

  db = new DatabaseSync(getDbFile());
  db.exec(`
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS stock_daily_snapshots (
      ticker             TEXT NOT NULL,
      date               TEXT NOT NULL,
      current_price      REAL,
      rsi_14             REAL,
      rsi_14_1h          REAL,
      ma_21              REAL,
      ma_200             REAL,
      current_iv         REAL,
      historical_iv      REAL,
      iv_rank            REAL,
      iv_percentile      REAL,
      put_call_ratio     REAL,
      next_earnings_date TEXT,
      shares             REAL,
      average_cost_basis REAL,
      beta               REAL,
      saved_at           TEXT NOT NULL,
      PRIMARY KEY (ticker, date)
    );
    CREATE TABLE IF NOT EXISTS option_daily_snapshots (
      ticker             TEXT    NOT NULL,
      date               TEXT    NOT NULL,
      side               TEXT    NOT NULL,
      delta_target       REAL    NOT NULL,
      expiration_date    TEXT,
      dte                INTEGER,
      strike             REAL,
      delta              REAL,
      delta_abs          REAL,
      gamma              REAL,
      theta              REAL,
      implied_volatility REAL,
      bid                REAL,
      ask                REAL,
      last_price         REAL,
      mid_price          REAL,
      open_interest      INTEGER,
      volume             INTEGER,
      spread_pct         REAL,
      option_code        TEXT,
      saved_at           TEXT    NOT NULL,
      PRIMARY KEY (ticker, date, side, delta_target)
    );
  `);
  return db;
}

function readJsonKeySync(key) {
  const database = openDb();
  const row = database.prepare('SELECT value FROM kv_store WHERE key = ?').get(key);
  if (!row || row.value == null) {
    return null;
  }

  return JSON.parse(row.value);
}

function writeJsonKeySync(key, value) {
  const database = openDb();
  database
    .prepare(`
      INSERT INTO kv_store (key, value, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `)
    .run(key, JSON.stringify(value, null, 2), new Date().toISOString());
}

async function maybeBackupDb() {
  const dbFile = getDbFile();
  try {
    await stat(dbFile);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null;
    }

    throw error;
  }

  await mkdir(getBackupDir(), { recursive: true });
  const backupFile = getBackupFile();
  try {
    const backupStats = await stat(backupFile);
    if (Date.now() - backupStats.mtimeMs < BACKUP_INTERVAL_MS) {
      return backupFile;
    }
  } catch (error) {
    if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  await copyFile(dbFile, backupFile);
  return backupFile;
}

async function migrateLegacyFilesIfNeeded() {
  const existingAppState = readJsonKeySync('app-state');
  const existingVixCache = readJsonKeySync('vix-cache');
  const existingRefreshStatus = readJsonKeySync('refresh-status');
  if (existingAppState !== null || existingVixCache !== null || existingRefreshStatus !== null) {
    return;
  }

  const [legacyAppState, legacyVixCache, legacyRefreshStatus] = await Promise.all([
    readJsonFile(getLegacyAppStateFile()),
    readJsonFile(getLegacyVixCacheFile()),
    readJsonFile(getLegacyRefreshStatusFile())
  ]);

  if (legacyAppState !== null) {
    writeJsonKeySync('app-state', legacyAppState);
  }
  if (legacyVixCache !== null) {
    writeJsonKeySync('vix-cache', legacyVixCache);
  }
  if (legacyRefreshStatus !== null) {
    writeJsonKeySync('refresh-status', legacyRefreshStatus);
  }
}

async function ensureInitialized() {
  if (initialized) {
    return;
  }

  await ensureDataDir();
  openDb();
  await migrateLegacyFilesIfNeeded();
  initialized = true;
}

async function readJsonKey(key) {
  await ensureInitialized();
  return readJsonKeySync(key);
}

async function writeJsonKey(key, value) {
  await ensureInitialized();
  writeQueue = writeQueue.then(async () => {
    await maybeBackupDb();
    writeJsonKeySync(key, value);
  });
  return writeQueue;
}

export async function readAppState() {
  return readJsonKey('app-state');
}

export async function writeAppState(payload) {
  await writeJsonKey('app-state', payload);
}

export async function readVixCache() {
  return readJsonKey('vix-cache');
}

export async function writeVixCache(payload) {
  await writeJsonKey('vix-cache', payload);
}

export async function readRefreshStatus() {
  return readJsonKey('refresh-status');
}

export async function writeRefreshStatus(payload) {
  await writeJsonKey('refresh-status', payload);
}

/**
 * Upsert one row per (ticker, date) into stock_daily_snapshots.
 * @param {Array<object>} entries  Array of TickerEntry-shaped objects.
 */
export async function writeStockDailySnapshot(entries) {
  await ensureInitialized();
  const date = new Date().toISOString().slice(0, 10);
  const savedAt = new Date().toISOString();
  const database = openDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO stock_daily_snapshots
      (ticker, date, current_price, rsi_14, rsi_14_1h, ma_21, ma_200,
       current_iv, historical_iv, iv_rank, iv_percentile, put_call_ratio,
       next_earnings_date, shares, average_cost_basis, beta, saved_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const entry of entries) {
    if (typeof entry?.ticker !== 'string' || entry.ticker.trim() === '') {
      continue;
    }
    stmt.run(
      entry.ticker,
      date,
      entry.current_price ?? null,
      entry.rsi_14 ?? null,
      entry.rsi_14_1h ?? null,
      entry.ma_21 ?? null,
      entry.ma_200 ?? null,
      entry.current_iv ?? null,
      entry.historical_iv ?? null,
      entry.iv_rank ?? null,
      entry.iv_percentile ?? null,
      entry.put_call_ratio ?? null,
      entry.next_earnings_date ?? null,
      entry.shares ?? null,
      entry.average_cost_basis ?? null,
      entry.beta ?? null,
      savedAt
    );
  }
}

/**
 * Query stock_daily_snapshots.
 * @param {{ ticker?: string, startDate?: string, endDate?: string }} options
 * @returns {Array<object>}
 */
export async function readStockDailySnapshots({ ticker, startDate, endDate } = {}) {
  await ensureInitialized();
  const database = openDb();

  const conditions = [];
  const params = [];

  if (typeof ticker === 'string' && ticker.trim() !== '') {
    conditions.push('ticker = ?');
    params.push(ticker.trim().toUpperCase());
  }
  if (typeof startDate === 'string' && startDate.trim() !== '') {
    conditions.push('date >= ?');
    params.push(startDate.trim());
  }
  if (typeof endDate === 'string' && endDate.trim() !== '') {
    conditions.push('date <= ?');
    params.push(endDate.trim());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM stock_daily_snapshots ${where} ORDER BY ticker, date`;
  return database.prepare(sql).all(...params);
}

/**
 * Upsert option snapshot rows into option_daily_snapshots.
 * @param {string} ticker  Underlying ticker symbol.
 * @param {Array<object>} rows  Rows from fetchOptionSnapshotForTicker.
 */
export async function writeOptionDailySnapshot(ticker, rows) {
  if (typeof ticker !== 'string' || ticker.trim() === '' || !Array.isArray(rows) || rows.length === 0) {
    return;
  }
  await ensureInitialized();
  const date = new Date().toISOString().slice(0, 10);
  const savedAt = new Date().toISOString();
  const database = openDb();
  const stmt = database.prepare(`
    INSERT OR REPLACE INTO option_daily_snapshots
      (ticker, date, side, delta_target, expiration_date, dte, strike,
       delta, delta_abs, gamma, theta, implied_volatility,
       bid, ask, last_price, mid_price, open_interest, volume,
       spread_pct, option_code, saved_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const normalizedTicker = ticker.trim().toUpperCase();
  for (const row of rows) {
    stmt.run(
      normalizedTicker,
      date,
      row.side ?? null,
      row.deltaTarget ?? null,
      row.expirationDate ?? null,
      row.dte ?? null,
      row.strike ?? null,
      row.delta ?? null,
      row.deltaAbs ?? null,
      row.gamma ?? null,
      row.theta ?? null,
      row.impliedVolatility ?? null,
      row.bid ?? null,
      row.ask ?? null,
      row.lastPrice ?? null,
      row.midPrice ?? null,
      row.openInterest ?? null,
      row.volume ?? null,
      row.spreadPct ?? null,
      row.code ?? null,
      savedAt
    );
  }
}

/**
 * Query option_daily_snapshots.
 * @param {{ ticker?: string, startDate?: string, endDate?: string, side?: string }} options
 * @returns {Array<object>}
 */
export async function readOptionDailySnapshots({ ticker, startDate, endDate, side } = {}) {
  await ensureInitialized();
  const database = openDb();

  const conditions = [];
  const params = [];

  if (typeof ticker === 'string' && ticker.trim() !== '') {
    conditions.push('ticker = ?');
    params.push(ticker.trim().toUpperCase());
  }
  if (typeof side === 'string' && (side === 'put' || side === 'call')) {
    conditions.push('side = ?');
    params.push(side);
  }
  if (typeof startDate === 'string' && startDate.trim() !== '') {
    conditions.push('date >= ?');
    params.push(startDate.trim());
  }
  if (typeof endDate === 'string' && endDate.trim() !== '') {
    conditions.push('date <= ?');
    params.push(endDate.trim());
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const sql = `SELECT * FROM option_daily_snapshots ${where} ORDER BY ticker, date, side, delta_target`;
  return database.prepare(sql).all(...params);
}

export function describeStorageTarget() {
  return {
    driver: 'sqlite',
    sqlitePath: getDbFile(),
    sqliteBackupPath: getBackupFile(),
    appStateTarget: 'kv_store:app-state',
    vixCacheTarget: 'kv_store:vix-cache',
    refreshStatusTarget: 'kv_store:refresh-status',
    stockSnapshotsTarget: 'stock_daily_snapshots',
    optionSnapshotsTarget: 'option_daily_snapshots'
  };
}
