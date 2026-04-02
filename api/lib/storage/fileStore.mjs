import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DATA_DIR = process.env.APP_DATA_DIR ?? path.join(process.cwd(), 'data');
const APP_STATE_FILE = path.join(DATA_DIR, 'app-state.json');
const VIX_CACHE_FILE = path.join(DATA_DIR, 'vix-cache.json');
const REFRESH_STATUS_FILE = path.join(DATA_DIR, 'refresh-status.json');

async function ensureDataDir() {
  await mkdir(DATA_DIR, { recursive: true });
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

async function writeJsonFile(filePath, payload) {
  await ensureDataDir();
  await writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
}

export async function readAppState() {
  return readJsonFile(APP_STATE_FILE);
}

export async function writeAppState(payload) {
  await writeJsonFile(APP_STATE_FILE, payload);
}

export async function readVixCache() {
  return readJsonFile(VIX_CACHE_FILE);
}

export async function writeVixCache(payload) {
  await writeJsonFile(VIX_CACHE_FILE, payload);
}

export async function readRefreshStatus() {
  return readJsonFile(REFRESH_STATUS_FILE);
}

export async function writeRefreshStatus(payload) {
  await writeJsonFile(REFRESH_STATUS_FILE, payload);
}

export function describeStorageTarget() {
  return {
    driver: 'file',
    appStateTarget: APP_STATE_FILE,
    vixCacheTarget: VIX_CACHE_FILE,
    refreshStatusTarget: REFRESH_STATUS_FILE
  };
}
