function getKvConfig() {
  const baseUrl = process.env.KV_REST_API_URL ?? '';
  const token = process.env.KV_REST_API_TOKEN ?? '';

  if (baseUrl === '' || token === '') {
    throw new Error('KV_REST_API_URL / KV_REST_API_TOKEN are required when APP_STORAGE_DRIVER=kv');
  }

  return {
    baseUrl: baseUrl.replace(/\/$/u, ''),
    token
  };
}

function getAppStateKey() {
  return process.env.APP_STATE_KV_KEY ?? 'risk-tool:app-state';
}

function getVixCacheKey() {
  return process.env.VIX_CACHE_KV_KEY ?? 'risk-tool:vix-cache';
}

async function readJsonKey(key) {
  const { baseUrl, token } = getKvConfig();
  const response = await fetch(`${baseUrl}/get/${encodeURIComponent(key)}`, {
    headers: {
      Authorization: `Bearer ${token}`
    }
  });

  if (!response.ok) {
    throw new Error(`KV get failed (${response.status})`);
  }

  const payload = await response.json();
  if (payload?.result == null) {
    return null;
  }

  return typeof payload.result === 'string' ? JSON.parse(payload.result) : payload.result;
}

async function writeJsonKey(key, value) {
  const { baseUrl, token } = getKvConfig();
  const response = await fetch(`${baseUrl}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(JSON.stringify(value))
  });

  if (!response.ok) {
    throw new Error(`KV set failed (${response.status})`);
  }
}

export async function readAppState() {
  return readJsonKey(getAppStateKey());
}

export async function writeAppState(payload) {
  await writeJsonKey(getAppStateKey(), payload);
}

export async function readVixCache() {
  return readJsonKey(getVixCacheKey());
}

export async function writeVixCache(payload) {
  await writeJsonKey(getVixCacheKey(), payload);
}

export function describeStorageTarget() {
  return {
    driver: 'kv',
    appStateTarget: getAppStateKey(),
    vixCacheTarget: getVixCacheKey()
  };
}
