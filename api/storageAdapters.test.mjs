import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importFresh(modulePath) {
  return import(`${modulePath}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('storage driver selector', () => {
  afterEach(() => {
    delete process.env.APP_STORAGE_DRIVER;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.APP_STATE_BLOB_PATH;
    delete process.env.VIX_CACHE_BLOB_PATH;
    delete process.env.KV_REST_API_URL;
    delete process.env.KV_REST_API_TOKEN;
    delete process.env.APP_STATE_KV_KEY;
    delete process.env.VIX_CACHE_KV_KEY;
    vi.restoreAllMocks();
  });

  it('defaults to the sqlite driver for local and Docker deployments', async () => {
    const storage = await importFresh('./lib/storage/index.mjs');
    expect(storage.getStorageDriver()).toBe('sqlite');
    expect(storage.describeStorageTarget().driver).toBe('sqlite');
  });

  it('coerces legacy file driver settings back to sqlite', async () => {
    process.env.APP_STORAGE_DRIVER = 'file';

    const storage = await importFresh('./lib/storage/index.mjs');
    expect(storage.getStorageDriver()).toBe('sqlite');
    expect(storage.describeStorageTarget().driver).toBe('sqlite');
  });

  it('switches to blob-json when APP_STORAGE_DRIVER=blob-json', async () => {
    process.env.APP_STORAGE_DRIVER = 'blob-json';
    process.env.BLOB_READ_WRITE_TOKEN = 'blob-secret-token';
    process.env.APP_STATE_BLOB_PATH = 'risk-tool/test/app-state.json';
    process.env.VIX_CACHE_BLOB_PATH = 'risk-tool/test/vix-cache.json';

    const storage = await importFresh('./lib/storage/index.mjs');
    expect(storage.getStorageDriver()).toBe('blob-json');
    expect(storage.describeStorageTarget()).toEqual({
      driver: 'blob-json',
      blobAccess: 'public',
      appStateTarget: 'risk-tool/test/app-state.json',
      vixCacheTarget: 'risk-tool/test/vix-cache.json',
      refreshStatusTarget: 'risk-tool/refresh-status.json'
    });
  });
});

describe('sqlite storage adapter', () => {
  let tempDir = '';

  afterEach(async () => {
    delete process.env.APP_DATA_DIR;
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('persists app state and vix cache to sqlite', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-sqlite-'));
    process.env.APP_DATA_DIR = tempDir;

    const sqliteStore = await importFresh('./lib/storage/sqliteStore.mjs');

    const snapshot = { version: 1, data: { puts: [{ id: 'put-1', ticker: 'AAPL' }] } };
    const vixCache = { value: 22.1, updated_at: '2026-04-07T19:00:00.000Z' };

    await sqliteStore.writeAppState(snapshot);
    await sqliteStore.writeVixCache(vixCache);

    await expect(sqliteStore.readAppState()).resolves.toEqual(snapshot);
    await expect(sqliteStore.readVixCache()).resolves.toEqual(vixCache);
    expect(sqliteStore.describeStorageTarget()).toEqual({
      driver: 'sqlite',
      sqlitePath: path.join(tempDir, 'risk-tool.sqlite'),
      sqliteBackupPath: path.join(tempDir, 'app-state-backups', 'risk-tool-latest.sqlite'),
      appStateTarget: 'kv_store:app-state',
      vixCacheTarget: 'kv_store:vix-cache',
      refreshStatusTarget: 'kv_store:refresh-status',
      stockSnapshotsTarget: 'stock_daily_snapshots',
      optionSnapshotsTarget: 'option_daily_snapshots'
    });
  });

  it('keeps app state valid under concurrent sqlite writes', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-sqlite-'));
    process.env.APP_DATA_DIR = tempDir;

    const sqliteStore = await importFresh('./lib/storage/sqliteStore.mjs');

    const snapshots = Array.from({ length: 6 }, (_, index) => ({
      version: 1,
      exported_at: `2026-04-06T19:14:0${index}.000Z`,
      data: {
        config: { cash: 100000 + index },
        closedTrades: Array.from({ length: index }, (__, tradeIndex) => ({ id: `closed-${index}-${tradeIndex}` })),
        stockTrades: [],
        scenario: null,
        vixHistory: [],
        accountValueHistory: [{ date: '2026-04-06', total_capital: 100000 + index }],
        tickerList: Array.from({ length: 14 }, (__, tickerIndex) => ({
          ticker: `T${tickerIndex}`,
          beta: 1 + index / 10,
          shares: tickerIndex === 0 ? 100 + index : null
        })),
        puts: []
      }
    }));

    await Promise.all(snapshots.map((snapshot) => sqliteStore.writeAppState(snapshot)));

    const persisted = await sqliteStore.readAppState();
    expect(persisted).not.toBeNull();
    expect(snapshots).toContainEqual(persisted);
  });

  it('migrates legacy json files into sqlite on first read', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-sqlite-'));
    process.env.APP_DATA_DIR = tempDir;

    const legacySnapshot = { version: 1, data: { puts: [{ id: 'put-legacy', ticker: 'AAPL' }] } };
    const legacyVixCache = { value: 19.4 };

    await writeFile(path.join(tempDir, 'app-state.json'), JSON.stringify(legacySnapshot, null, 2), 'utf8');
    await writeFile(path.join(tempDir, 'vix-cache.json'), JSON.stringify(legacyVixCache, null, 2), 'utf8');

    const sqliteStore = await importFresh('./lib/storage/sqliteStore.mjs');

    await expect(sqliteStore.readAppState()).resolves.toEqual(legacySnapshot);
    await expect(sqliteStore.readVixCache()).resolves.toEqual(legacyVixCache);
  });
});
