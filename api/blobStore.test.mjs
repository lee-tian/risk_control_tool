import { afterEach, describe, expect, it } from 'vitest';

import {
  describeStorageTarget,
  readAppState,
  setBlobSdkLoaderForTests,
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
      get: async () => ({
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(written));
            controller.close();
          }
        })
      })
    }));

    const payload = { puts: [{ id: 'call-1', option_side: 'call' }] };
    await writeAppState(payload);
    await expect(readAppState()).resolves.toEqual(payload);
    expect(describeStorageTarget()).toEqual({
      driver: 'blob-json',
      appStateTarget: 'risk-tool/app-state.json',
      vixCacheTarget: 'risk-tool/vix-cache.json'
    });
  });
});
