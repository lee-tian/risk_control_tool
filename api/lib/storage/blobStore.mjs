let blobSdkLoader = () => import('@vercel/blob');

function getAppStatePath() {
  return process.env.APP_STATE_BLOB_PATH ?? 'risk-tool/app-state.json';
}

function getVixCachePath() {
  return process.env.VIX_CACHE_BLOB_PATH ?? 'risk-tool/vix-cache.json';
}

async function loadBlobSdk() {
  return blobSdkLoader();
}

async function readJsonBlob(pathname) {
  const { get } = await loadBlobSdk();

  try {
    const result = await get(pathname, {
      access: 'private',
      token: process.env.BLOB_READ_WRITE_TOKEN
    });

    if (!result?.body) {
      return null;
    }

    const text = await new Response(result.body).text();
    return text.trim() === '' ? null : JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/not found/iu.test(message)) {
      return null;
    }

    throw error;
  }
}

async function writeJsonBlob(pathname, payload) {
  const { put } = await loadBlobSdk();
  await put(pathname, JSON.stringify(payload, null, 2), {
    access: 'private',
    allowOverwrite: true,
    addRandomSuffix: false,
    contentType: 'application/json',
    token: process.env.BLOB_READ_WRITE_TOKEN
  });
}

export async function readAppState() {
  return readJsonBlob(getAppStatePath());
}

export async function writeAppState(payload) {
  await writeJsonBlob(getAppStatePath(), payload);
}

export async function readVixCache() {
  return readJsonBlob(getVixCachePath());
}

export async function writeVixCache(payload) {
  await writeJsonBlob(getVixCachePath(), payload);
}

export function describeStorageTarget() {
  return {
    driver: 'blob-json',
    appStateTarget: getAppStatePath(),
    vixCacheTarget: getVixCachePath()
  };
}

export function setBlobSdkLoaderForTests(loader) {
  blobSdkLoader = loader;
}
