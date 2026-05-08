import path from 'node:path';

const storeLoaders = {
  'blob-json': () => import('./blobStore.mjs'),
  blob: () => import('./blobStore.mjs'),
  kv: () => import('./kvStore.mjs'),
  sqlite: () => import('./sqliteStore.mjs')
};

function selectStorageDriver() {
  const driver = (process.env.APP_STORAGE_DRIVER ?? 'sqlite').trim().toLowerCase();
  if (driver === '' || driver === 'file') {
    return 'sqlite';
  }

  return driver;
}

async function getStore() {
  const driver = selectStorageDriver();
  if (driver === 'sqlite') {
    return storeLoaders.sqlite();
  }

  if (driver === 'kv') {
    return storeLoaders.kv();
  }

  if (driver === 'blob-json' || driver === 'blob') {
    return storeLoaders[driver]();
  }

  return storeLoaders.sqlite();
}

function getBlobStorageDescription() {
  return {
    driver: 'blob-json',
    blobAccess: 'public',
    appStateTarget: process.env.APP_STATE_BLOB_PATH ?? 'risk-tool/app-state.json',
    vixCacheTarget: process.env.VIX_CACHE_BLOB_PATH ?? 'risk-tool/vix-cache.json',
    refreshStatusTarget: process.env.REFRESH_STATUS_BLOB_PATH ?? 'risk-tool/refresh-status.json'
  };
}

function getKvStorageDescription() {
  return {
    driver: 'kv',
    appStateTarget: process.env.APP_STATE_KV_KEY ?? 'risk-tool:app-state',
    vixCacheTarget: process.env.VIX_CACHE_KV_KEY ?? 'risk-tool:vix-cache',
    refreshStatusTarget: process.env.REFRESH_STATUS_KV_KEY ?? 'risk-tool:refresh-status'
  };
}

function getSqliteStorageDescription() {
  const dataDir = process.env.APP_DATA_DIR ?? path.join(process.cwd(), 'data');
  return {
    driver: 'sqlite',
    sqlitePath: path.join(dataDir, 'risk-tool.sqlite'),
    sqliteBackupPath: path.join(dataDir, 'app-state-backups', 'risk-tool-latest.sqlite'),
    appStateTarget: 'kv_store:app-state',
    vixCacheTarget: 'kv_store:vix-cache',
    refreshStatusTarget: 'kv_store:refresh-status'
  };
}

export async function readAppState() {
  return (await getStore()).readAppState();
}

export async function writeAppState(payload) {
  return (await getStore()).writeAppState(payload);
}

export async function readVixCache() {
  return (await getStore()).readVixCache();
}

export async function writeVixCache(payload) {
  return (await getStore()).writeVixCache(payload);
}

export async function readRefreshStatus() {
  return (await getStore()).readRefreshStatus();
}

export async function writeRefreshStatus(payload) {
  return (await getStore()).writeRefreshStatus(payload);
}

export async function writeStockDailySnapshot(entries) {
  // Only the sqlite driver implements the snapshots table.
  if (selectStorageDriver() !== 'sqlite') {
    return;
  }
  return (await getStore()).writeStockDailySnapshot(entries);
}

export async function readStockDailySnapshots(options) {
  // Only the sqlite driver implements the snapshots table.
  if (selectStorageDriver() !== 'sqlite') {
    return [];
  }
  return (await getStore()).readStockDailySnapshots(options);
}

export async function writeOptionDailySnapshot(ticker, rows) {
  // Only the sqlite driver implements the snapshots table.
  if (selectStorageDriver() !== 'sqlite') {
    return;
  }
  return (await getStore()).writeOptionDailySnapshot(ticker, rows);
}

export async function readOptionDailySnapshots(options) {
  // Only the sqlite driver implements the snapshots table.
  if (selectStorageDriver() !== 'sqlite') {
    return [];
  }
  return (await getStore()).readOptionDailySnapshots(options);
}

export function describeStorageTarget() {
  const driver = selectStorageDriver();
  if (driver === 'blob-json' || driver === 'blob') {
    return getBlobStorageDescription();
  }

  if (driver === 'kv') {
    return getKvStorageDescription();
  }

  return getSqliteStorageDescription();
}

export function getStorageDriver() {
  return selectStorageDriver();
}
