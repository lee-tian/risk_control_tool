import { afterEach, describe, expect, it } from 'vitest';

import {
  describeStorageTarget,
  readAppState,
  setBlobSdkLoaderForTests,
  readVixCache,
  writeAppState
} from './lib/storage/blobStore.mjs';

describe('blob storage adapter', () => {
  afterEach(() => {
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.APP_STATE_BLOB_PATH;
    delete process.env.VIX_CACHE_BLOB_PATH;
  });

  it('reads and writes JSON through the blob sdk', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'blob-secret-token';

    let written = '';
    setBlobSdkLoaderForTests(async () => ({
      put: async (_pathname, body) => {
        written = String(body);
        return { pathname: 'risk-tool/app-state.json' };
      },
      head: async () => ({
        url: 'https://example.test/risk-tool/app-state.json'
      })
    }));

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(written, {
        status: 200,
        headers: {
          'Content-Type': 'application/json'
        }
      });

    const payload = { puts: [{ id: 'call-1', option_side: 'call' }] };
    await writeAppState(payload);
    await expect(readAppState()).resolves.toEqual(payload);
    expect(describeStorageTarget()).toEqual({
      driver: 'blob-json',
      blobAccess: 'public',
      appStateTarget: 'risk-tool/app-state.json',
      vixCacheTarget: 'risk-tool/vix-cache.json',
      refreshStatusTarget: 'risk-tool/refresh-status.json'
    });

    globalThis.fetch = originalFetch;
  });

  it('treats a missing blob as an empty cache instead of throwing', async () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'blob-secret-token';

    setBlobSdkLoaderForTests(async () => ({
      put: async () => ({ pathname: 'risk-tool/vix-cache.json' }),
      head: async () => {
        throw new Error('Vercel Blob: The requested blob does not exist');
      }
    }));

    await expect(readVixCache()).resolves.toBeNull();
  });
});
