import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function importFresh(modulePath) {
  return import(`${modulePath}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

describe('file storage adapter', () => {
  let tempDir = '';

  afterEach(async () => {
    delete process.env.APP_DATA_DIR;
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('persists app state and vix cache to the configured data directory', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-storage-'));
    process.env.APP_DATA_DIR = tempDir;

    const fileStore = await importFresh('./lib/storage/fileStore.mjs');

    const snapshot = { puts: [{ id: 'call-1', option_side: 'call' }] };
    const vixCache = { value: 24.5, updated_at: '2026-04-01T18:00:00.000Z' };

    await fileStore.writeAppState(snapshot);
    await fileStore.writeVixCache(vixCache);

    await expect(fileStore.readAppState()).resolves.toEqual(snapshot);
    await expect(fileStore.readVixCache()).resolves.toEqual(vixCache);
    expect(fileStore.describeStorageTarget()).toEqual({
      driver: 'file',
      appStateTarget: path.join(tempDir, 'app-state.json'),
      vixCacheTarget: path.join(tempDir, 'vix-cache.json')
    });
  });
});

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

  it('defaults to the file driver so Docker keeps the existing behavior', async () => {
    const storage = await importFresh('./lib/storage/index.mjs');
    expect(storage.getStorageDriver()).toBe('file');
    expect(storage.describeStorageTarget().driver).toBe('file');
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
      appStateTarget: 'risk-tool/test/app-state.json',
      vixCacheTarget: 'risk-tool/test/vix-cache.json'
    });
  });
});
