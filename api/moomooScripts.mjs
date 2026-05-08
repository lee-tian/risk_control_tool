import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { normalizeProviderSymbol } from './providerSymbols.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_MOOMOO_PYTHON_BIN = process.env.MOOMOO_PYTHON_BIN || 'python3';
export const DEFAULT_MOOMOO_TIMEOUT_MS = Number(process.env.MOOMOO_SCRIPT_TIMEOUT_MS ?? 15000);
const DEFAULT_MOOMOO_SCRIPT_ROOTS = [
  process.env.MOOMOO_SCRIPTS_ROOT,
  '/opt/moomoo/scripts',
  '/Users/emily/.codex/skills/moomooapi/scripts'
].filter((value) => typeof value === 'string' && value.trim() !== '');

export function parseJsonOutput(stdout, fallbackMessage) {
  const text = typeof stdout === 'string' ? stdout.trim() : '';
  if (text === '') {
    throw new Error(fallbackMessage);
  }

  try {
    return JSON.parse(text);
  } catch {
    const firstObjectStart = text.indexOf('{');
    const lastObjectEnd = text.lastIndexOf('}');

    if (firstObjectStart !== -1 && lastObjectEnd !== -1 && lastObjectEnd > firstObjectStart) {
      try {
        return JSON.parse(text.slice(firstObjectStart, lastObjectEnd + 1));
      } catch {
        throw new Error(fallbackMessage);
      }
    }

    throw new Error(fallbackMessage);
  }
}

export function normalizeOptionSide(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'call' || normalized === 'c' || normalized === '认购' || normalized === '涨') {
    return 'call';
  }
  if (normalized === 'put' || normalized === 'p' || normalized === '认沽' || normalized === '跌') {
    return 'put';
  }

  return null;
}

export function parseNumericValue(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function hasExplicitMarketPrefix(symbol) {
  return /^(US|HK|SH|SZ|SG|JP|AU|CA)\./u.test(symbol);
}

export function getMoomooUnderlying(symbol) {
  const normalized = normalizeProviderSymbol(symbol).trim().toUpperCase();
  if (hasExplicitMarketPrefix(normalized)) {
    return normalized;
  }

  return `US.${normalized}`;
}

export function resolveMoomooScriptPath(relativePath) {
  for (const root of DEFAULT_MOOMOO_SCRIPT_ROOTS) {
    const candidate = path.join(root, relativePath);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(DEFAULT_MOOMOO_SCRIPT_ROOTS[0] ?? '/opt/moomoo/scripts', relativePath);
}

export async function runMoomooJsonScript(scriptPath, args, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl(DEFAULT_MOOMOO_PYTHON_BIN, [scriptPath, ...args], {
    timeout: DEFAULT_MOOMOO_TIMEOUT_MS,
    maxBuffer: 1024 * 1024 * 8
  });

  const payload = parseJsonOutput(stdout, `Invalid JSON output from ${scriptPath}`);
  if (typeof payload?.error === 'string' && payload.error.trim() !== '') {
    throw new Error(payload.error.trim());
  }

  return payload;
}
