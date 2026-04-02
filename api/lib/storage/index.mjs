import * as fileStore from './fileStore.mjs';
import * as blobStore from './blobStore.mjs';
import * as kvStore from './kvStore.mjs';

function selectStorageDriver() {
  return (process.env.APP_STORAGE_DRIVER ?? 'file').trim().toLowerCase();
}

function getStore() {
  const driver = selectStorageDriver();
  if (driver === 'kv') {
    return kvStore;
  }

  if (driver === 'blob-json' || driver === 'blob') {
    return blobStore;
  }

  return fileStore;
}

export async function readAppState() {
  return getStore().readAppState();
}

export async function writeAppState(payload) {
  return getStore().writeAppState(payload);
}

export async function readVixCache() {
  return getStore().readVixCache();
}

export async function writeVixCache(payload) {
  return getStore().writeVixCache(payload);
}

export async function readRefreshStatus() {
  return getStore().readRefreshStatus();
}

export async function writeRefreshStatus(payload) {
  return getStore().writeRefreshStatus(payload);
}

export function describeStorageTarget() {
  return getStore().describeStorageTarget();
}

export function getStorageDriver() {
  return selectStorageDriver();
}
