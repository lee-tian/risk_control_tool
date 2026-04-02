import * as fileStore from './fileStore.mjs';
import * as kvStore from './kvStore.mjs';

function selectStorageDriver() {
  return (process.env.APP_STORAGE_DRIVER ?? 'file').trim().toLowerCase();
}

function getStore() {
  return selectStorageDriver() === 'kv' ? kvStore : fileStore;
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

export function describeStorageTarget() {
  return getStore().describeStorageTarget();
}

export function getStorageDriver() {
  return selectStorageDriver();
}
