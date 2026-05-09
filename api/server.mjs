import http from 'node:http';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { calculateAtr, calculateRsi, calculateSma, extractCloseSeries, extractMoomooKlineRows } from './marketIndicators.mjs';
import {
  fetchMoomooOptionChainSnapshot,
  fetchMoomooOptionExpirations,
  fetchRecommendedMoomooOptionPlan,
  rankExpirationCandidates,
} from './moomooOptionAnalysis.mjs';
import { fetchMoomooOptionQuote } from './moomooOptionQuotes.mjs';
import { fetchMoomooStockQuote, fetchMoomooKline } from './moomooStockQuotes.mjs';
import { getMoomooUnderlying } from './moomooScripts.mjs';
import { readJsonFromResponse } from './httpResponses.mjs';
import {
  describeStorageTarget,
  readAppState,
  readOptionDailySnapshots,
  readRefreshStatus,
  readStockDailySnapshots,
  readVixCache,
  writeAppState,
  writeOptionDailySnapshot,
  writeRefreshStatus,
  writeStockDailySnapshot,
  writeVixCache
} from './lib/storage/index.mjs';
import {
  extractOptionQuoteFromBarchart,
  extractOptionQuoteFromChain,
  extractOptionQuoteFromSnapshot,
  formatOptionSymbol
} from './optionQuotes.mjs';
import { buildPutEntryChecks } from './putCheckRules.mjs';
import { normalizeProviderSymbol } from './providerSymbols.mjs';

function loadLocalEnvFile() {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return;
  }

  const envPath = path.join(process.cwd(), '.env');
  if (!existsSync(envPath)) {
    return;
  }

  const lines = readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key && process.env[key] == null) {
      process.env[key] = value;
    }
  }
}

loadLocalEnvFile();

const PORT = Number(process.env.PORT ?? 3001);
const API_KEY = process.env.TWELVE_DATA_API_KEY ?? '';
const MARKETDATA_TOKEN = process.env.MARKETDATA_TOKEN ?? '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_PRETRADE_MODEL = process.env.OPENAI_PRETRADE_MODEL ?? 'gpt-4.1-mini';
const REQUEST_GAP_MS = Number(process.env.TWELVE_DATA_REQUEST_GAP_MS ?? 350);
const CURRENT_IV_TARGET_DTE = Number(process.env.CURRENT_IV_TARGET_DTE ?? 45);
const CURRENT_IV_TARGET_DELTA = Number(process.env.CURRENT_IV_TARGET_DELTA ?? 0.3);
const CURRENT_IV_STRIKE_LIMIT = Number(process.env.CURRENT_IV_STRIKE_LIMIT ?? 8);
const FEAR_GREED_CACHE_MS = Number(process.env.FEAR_GREED_CACHE_MS ?? 10 * 60 * 1000);
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS ?? 12000);
const AUTO_PRICE_REFRESH_CHECK_MS = Number(process.env.AUTO_PRICE_REFRESH_CHECK_MS ?? 20 * 60 * 1000);
const AUTO_OPTION_REFRESH_CHECK_MS = Number(process.env.AUTO_OPTION_REFRESH_CHECK_MS ?? 30 * 60 * 1000);
const BARCHART_BASE_URL = 'https://www.barchart.com';
const BARCHART_DEFAULT_PAGE = 'put-call-ratios';
const FINVIZ_BASE_URL = 'https://finviz.com';
const BARCHART_BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};
const FINVIZ_BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  Referer: `${FINVIZ_BASE_URL}/`,
  'User-Agent': BARCHART_BROWSER_HEADERS['User-Agent']
};
const FINVIZ_TECHNICAL_CACHE_MS = 5 * 60 * 1000;
let appStateMutationQueue = Promise.resolve();
const finvizTechnicalSnapshotCache = new Map();

function enqueueAppStateMutation(task) {
  const taskPromise = appStateMutationQueue.then(task, task);
  appStateMutationQueue = taskPromise.catch(() => {});
  return taskPromise;
}

function isMarketDataQuotaErrorMessage(message) {
  return typeof message === 'string' && message.toLowerCase().includes('daily request limit');
}

function isGeminiLimitedErrorMessage(message) {
  if (typeof message !== 'string') {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes('high demand') ||
    normalized.includes('rate limit') ||
    normalized.includes('resource exhausted') ||
    normalized.includes('quota') ||
    normalized.includes('429')
  );
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(payload));
}

function fetchWithTimeout(resource, init = {}) {
  return fetch(resource, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)
  });
}

function withTimeout(promise, ms, fallbackValue) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      setTimeout(() => resolve(fallbackValue), ms);
    })
  ]);
}

function parseNumericValue(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.replaceAll(',', '').trim();
  if (normalized === '') {
    return null;
  }

  const numeric = Number(normalized.replace(/%$/u, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function parsePercentToDecimal(value) {
  const numeric = parseNumericValue(value);
  if (!Number.isFinite(numeric) || numeric === null) {
    return null;
  }

  if (typeof value === 'string' && value.includes('%')) {
    return numeric / 100;
  }

  return numeric > 1.5 ? numeric / 100 : numeric;
}

function parsePercentToRank(value) {
  const numeric = parseNumericValue(value);
  if (!Number.isFinite(numeric) || numeric === null) {
    return null;
  }

  if (typeof value === 'string' && value.includes('%')) {
    return numeric;
  }

  return numeric <= 1 ? numeric * 100 : numeric;
}

function toIsoStringFromUnix(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return new Date(numeric * 1000).toISOString();
}

function parseBarchartTradeTime(value) {
  if (typeof value === 'number') {
    return toIsoStringFromUnix(value);
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const match = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{2})$/u);
  if (match) {
    const [, mm, dd, yy] = match;
    return new Date(`20${yy}-${mm}-${dd}T00:00:00Z`).toISOString();
  }

  const parsed = new Date(trimmed);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeDateInput(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const isoMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (isoMatch) {
    return trimmed;
  }

  const shortUsMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{2})$/u);
  if (shortUsMatch) {
    const [, mm, dd, yy] = shortUsMatch;
    return `20${yy}-${mm}-${dd}`;
  }

  const longUsMatch = trimmed.match(/^(\d{2})\/(\d{2})\/(\d{4})$/u);
  if (longUsMatch) {
    const [, mm, dd, yyyy] = longUsMatch;
    return `${yyyy}-${mm}-${dd}`;
  }

  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function extractBarchartListStatValue(html, label) {
  if (typeof html !== 'string' || html === '' || typeof label !== 'string' || label.trim() === '') {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const patterns = [
    new RegExp(
      `<li[^>]*>[\\s\\S]{0,80}?<span[^>]*class="[^"]*left[^"]*"[^>]*>\\s*${escapedLabel}\\s*</span>[\\s\\S]{0,120}?<span[^>]*class="[^"]*right[^"]*"[^>]*>([\\s\\S]{0,120}?)</span>[\\s\\S]{0,40}?</li>`,
      'iu'
    ),
    new RegExp(
      `<dt[^>]*>[\\s\\S]{0,40}?${escapedLabel}[\\s\\S]{0,120}?</dt>[\\s\\S]{0,120}?<dd[^>]*>([\\s\\S]{0,120}?)</dd>`,
      'iu'
    )
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) {
      const value = match[1]
        .replace(/<[^>]+>/gu, ' ')
        .replace(/&nbsp;/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
      if (value !== '') {
        return value;
      }
    }
  }

  return null;
}

function extractBarchartInlineSummaryValue(html, label) {
  if (typeof html !== 'string' || html === '' || typeof label !== 'string' || label.trim() === '') {
    return null;
  }

  const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const patterns = [
    new RegExp(`${escapedLabel}\\s*:\\s*(?:[A-Za-z ]{1,18}:\\s*)?([0-9]{2}\\/[0-9]{2}\\/[0-9]{2,4})`, 'iu'),
    new RegExp(`${escapedLabel}\\s*:\\s*(?:[A-Za-z ]{1,18}:\\s*)?([0-9]+(?:\\.[0-9]+)?%)`, 'iu'),
    new RegExp(`${escapedLabel}\\s*:\\s*(?:[A-Za-z ]{1,18}:\\s*)?([0-9]+(?:\\.[0-9]+)?)`, 'iu')
  ];

  const normalizedHtml = html.replace(/&nbsp;/gu, ' ').replace(/\s+/gu, ' ');
  for (const pattern of patterns) {
    const match = normalizedHtml.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return null;
}

function extractJsonObjectAfterMarker(source, marker) {
  const start = source.indexOf(marker);
  if (start === -1) {
    return null;
  }

  const firstBrace = source.indexOf('{', start + marker.length);
  if (firstBrace === -1) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let index = firstBrace; index < source.length; index += 1) {
    const char = source[index];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (char === '\\') {
      escapeNext = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(firstBrace, index + 1);
      }
    }
  }

  return null;
}

function extractBarchartConfigSource(html) {
  const inlineConfig = extractJsonObjectAfterMarker(html, 'window.config = ');
  if (inlineConfig) {
    return inlineConfig;
  }

  const dynamicConfigMatch = html.match(
    /<script[^>]+id="bc-dynamic-config"[^>]*>\s*(\{[\s\S]*?\})\s*<\/script>/u
  );
  return dynamicConfigMatch ? dynamicConfigMatch[1] : null;
}

function serializeCookies(setCookieValues) {
  if (!Array.isArray(setCookieValues) || setCookieValues.length === 0) {
    return '';
  }

  return setCookieValues
    .map((value) => String(value).split(';', 1)[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

function getSetCookieHeaders(headers) {
  if (typeof headers?.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const combined = headers?.get?.('set-cookie');
  if (typeof combined !== 'string' || combined.trim() === '') {
    return [];
  }

  return combined.split(/,(?=[^;]+=[^;]+)/u).map((value) => value.trim()).filter(Boolean);
}

function getCookieValue(cookieHeader, name) {
  const pattern = new RegExp(`(?:^|; )${name}=([^;]+)`, 'u');
  const match = cookieHeader.match(pattern);
  return match ? decodeURIComponent(match[1]) : null;
}

function normalizeBarchartQuoteRecord(payload) {
  const records = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.results)
      ? payload.results
      : Array.isArray(payload)
        ? payload
        : [];

  return records.length > 0 && typeof records[0] === 'object' && records[0] !== null ? records[0] : null;
}

function extractFinvizCloses(html) {
  if (typeof html !== 'string' || html.trim() === '') {
    return [];
  }

  const closeMatch = html.match(/"close":\[(.*?)\],"lastOpen"/su);
  if (!closeMatch?.[1]) {
    return [];
  }

  try {
    const values = JSON.parse(`[${closeMatch[1]}]`);
    return Array.isArray(values) ? values.map((value) => Number(value)).filter((value) => Number.isFinite(value)) : [];
  } catch {
    return [];
  }
}

function extractFinvizLastTime(html) {
  if (typeof html !== 'string' || html.trim() === '') {
    return null;
  }

  const match = html.match(/"lastTime":(\d{10})/u);
  if (!match?.[1]) {
    return null;
  }

  return toIsoStringFromUnix(Number(match[1]));
}

function parseFinvizMonthDayDate(value, referenceDate = new Date()) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^([A-Za-z]{3})\s+(\d{1,2})(?:\s+'?(\d{2,4}))?$/u);
  if (!match) {
    return null;
  }

  const [, monthLabel, dayLabel, yearLabel] = match;
  const monthIndex = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(
    monthLabel.toLowerCase()
  );
  if (monthIndex === -1) {
    return null;
  }

  const baseYear = referenceDate.getUTCFullYear();
  const parsedYear = yearLabel
    ? yearLabel.length === 2
      ? 2000 + Number(yearLabel)
      : Number(yearLabel)
    : baseYear;
  if (!Number.isFinite(parsedYear)) {
    return null;
  }

  const parsed = new Date(Date.UTC(parsedYear, monthIndex, Number(dayLabel)));
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  if (!yearLabel) {
    const sixMonthsAgo = new Date(referenceDate);
    sixMonthsAgo.setUTCMonth(sixMonthsAgo.getUTCMonth() - 6);
    if (parsed < sixMonthsAgo) {
      parsed.setUTCFullYear(parsed.getUTCFullYear() + 1);
    }
  }

  return parsed.toISOString().slice(0, 10);
}

function isFutureOrTodayDate(value, referenceDate = new Date()) {
  if (typeof value !== 'string' || value.trim() === '') {
    return false;
  }

  const parsed = new Date(`${value.trim()}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) {
    return false;
  }

  const referenceDay = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate())
  );
  return parsed.getTime() >= referenceDay.getTime();
}

export function extractFinvizEarningsInfo(html, referenceDate = new Date()) {
  if (typeof html !== 'string' || html.trim() === '') {
    return {
      next_earnings_date: null,
      earnings_time_code: null
    };
  }

  const tableMatch = html.match(
    /snapshot-td-label[^>]*>\s*(?:<a[^>]*>)?\s*Earnings\s*(?:<\/a>)?\s*<\/div>[\s\S]{0,240}?snapshot-td-content[^>]*>[\s\S]{0,120}?<b[^>]*>\s*(?:<small[^>]*>)?([^<]+?)(?:<\/small>)?\s*<\/b>/iu
  );
  const rawValue = tableMatch?.[1]?.replace(/\s+/gu, ' ').trim() ?? '';
  if (rawValue === '') {
    return {
      next_earnings_date: null,
      earnings_time_code: null
    };
  }

  const timeCodeMatch = rawValue.match(/\b(BMO|AMC)\b/iu);
  const normalizedDate = parseFinvizMonthDayDate(
    rawValue.replace(/\b(BMO|AMC)\b/giu, '').trim(),
    referenceDate
  );

  return {
    next_earnings_date: isFutureOrTodayDate(normalizedDate, referenceDate) ? normalizedDate : null,
    earnings_time_code: timeCodeMatch?.[1]?.toUpperCase() ?? null
  };
}

async function fetchFinvizTechnicalSnapshot(symbol) {
  const normalizedSymbol = String(symbol ?? '').trim().toUpperCase();
  if (normalizedSymbol === '') {
    throw new Error('Finviz symbol is required');
  }

  const now = Date.now();
  const cached = finvizTechnicalSnapshotCache.get(normalizedSymbol);
  if (cached && now - cached.fetchedAt < FINVIZ_TECHNICAL_CACHE_MS) {
    return cached.promise;
  }

  const snapshotPromise = (async () => {
    const url = new URL('/quote.ashx', FINVIZ_BASE_URL);
    url.searchParams.set('t', normalizedSymbol);

    const response = await fetchWithTimeout(url, {
      headers: FINVIZ_BROWSER_HEADERS
    });
    const html = await response.text();

    if (!response.ok) {
      throw new Error(`Finviz page request failed (${response.status})`);
    }

    const closes = extractFinvizCloses(html);
    if (closes.length === 0) {
      throw new Error(`Finviz technical series unavailable for ${normalizedSymbol}`);
    }

    return {
      symbol: normalizedSymbol,
      closes,
      asOf: extractFinvizLastTime(html),
      earnings: extractFinvizEarningsInfo(html),
      source: 'Finviz HTML'
    };
  })();

  finvizTechnicalSnapshotCache.set(normalizedSymbol, {
    fetchedAt: now,
    promise: snapshotPromise
  });

  try {
    return await snapshotPromise;
  } catch (error) {
    finvizTechnicalSnapshotCache.delete(normalizedSymbol);
    throw error;
  }
}

async function fetchBarchartBootstrap(symbol, pagePath = BARCHART_DEFAULT_PAGE) {
  const pageUrl = `${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(symbol)}/${pagePath}`;
  const response = await fetchWithTimeout(pageUrl, {
    headers: {
      ...BARCHART_BROWSER_HEADERS,
      Referer: pageUrl
    }
  });

  const html = await response.text();
  if (!response.ok) {
    throw new Error(`Barchart page request failed (${response.status})`);
  }

  const configSource = extractBarchartConfigSource(html);
  const cookies = serializeCookies(getSetCookieHeaders(response.headers));
  const xsrfToken = getCookieValue(cookies, 'XSRF-TOKEN');
  let config = null;

  if (configSource) {
    try {
      config = JSON.parse(configSource);
    } catch {
      config = null;
    }
  }

  return {
    html,
    pageUrl,
    cookies,
    xsrfToken,
    config
  };
}

async function fetchBarchartProxyJson(symbol, fields, pagePath = BARCHART_DEFAULT_PAGE) {
  const bootstrap = await fetchBarchartBootstrap(symbol, pagePath);
  const endpoint = new URL(`${BARCHART_BASE_URL}/proxies/core-api/v1/quotes/get`);
  endpoint.searchParams.set('symbols', symbol);
  endpoint.searchParams.set('raw', '1');
  endpoint.searchParams.set('fields', fields.join(','));

  const response = await fetchWithTimeout(endpoint, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: bootstrap.cookies,
      Referer: bootstrap.pageUrl,
      'User-Agent': BARCHART_BROWSER_HEADERS['User-Agent'],
      'X-Requested-With': 'XMLHttpRequest',
      ...(bootstrap.xsrfToken ? { 'X-XSRF-TOKEN': bootstrap.xsrfToken } : {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Barchart proxy request failed (${response.status})`);
  }

  const payload = JSON.parse(text);
  if (payload?.error) {
    throw new Error(payload.error?.message || 'Barchart proxy returned an error');
  }

  return {
    payload,
    bootstrap
  };
}

async function fetchBarchartOptionQuote(symbol, expirationDate, strike, side = 'put') {
  const pagePath = 'options';
  const bootstrap = await fetchBarchartBootstrap(symbol, pagePath);
  const endpoint = new URL(`${BARCHART_BASE_URL}/proxies/core-api/v1/options/get`);
  endpoint.searchParams.set('symbol', symbol);
  endpoint.searchParams.set(
    'fields',
    [
      'symbol',
      'optionType',
      'strikePrice',
      'expirationDate',
      'lastPrice',
      'bidPrice',
      'askPrice',
      'tradeTime',
      'delta',
      'gamma',
      'theta',
      'expirationType'
    ].join(',')
  );
  endpoint.searchParams.set('raw', '1');
  endpoint.searchParams.set('expirationDate', expirationDate);
  endpoint.searchParams.set('meta', 'field.shortName,field.description,field.type');
  endpoint.searchParams.set('orderBy', 'strikePrice');
  endpoint.searchParams.set('orderDir', 'asc');

  const response = await fetchWithTimeout(endpoint, {
    headers: {
      Accept: 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: bootstrap.cookies,
      Referer: bootstrap.pageUrl,
      'User-Agent': BARCHART_BROWSER_HEADERS['User-Agent'],
      'X-Requested-With': 'XMLHttpRequest',
      ...(bootstrap.xsrfToken ? { 'X-XSRF-TOKEN': bootstrap.xsrfToken } : {})
    }
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Barchart option quote request failed (${response.status})`);
  }

  const payload = JSON.parse(text);
  if (payload?.error) {
    throw new Error(payload.error?.message || 'Barchart option quote returned an error');
  }

  const quote = extractOptionQuoteFromBarchart(payload, strike, expirationDate, side);
  if (!quote) {
    throw new Error(`Barchart option quote unavailable for ${symbol} ${expirationDate} ${strike} ${side}`);
  }

  return {
    ...quote,
    source: 'Barchart options/get'
  };
}

async function fetchBarchartMarketSnapshot(symbol) {
  const snapshot = {
    current_price: null,
    current_price_date: null,
    next_earnings_date: null,
    earnings_time_code: null,
    current_iv: null,
    historical_iv: null,
    iv_rank: null,
    iv_percentile: null,
    put_call_ratio: null,
    source: null
  };

  let bootstrap = null;
  try {
    bootstrap = await fetchBarchartBootstrap(symbol, BARCHART_DEFAULT_PAGE);
    const currentSymbol = bootstrap?.config?.currentSymbol?.raw ?? bootstrap?.config?.currentSymbol ?? null;

    if (currentSymbol) {
      snapshot.current_price =
        parseNumericValue(currentSymbol.lastPrice) ??
        parseNumericValue(currentSymbol.dailyLastPrice) ??
        snapshot.current_price;
      snapshot.current_price_date =
        parseBarchartTradeTime(currentSymbol.tradeTime) ??
        parseBarchartTradeTime(bootstrap?.config?.currentSymbol?.tradeTime) ??
        snapshot.current_price_date;
      snapshot.put_call_ratio =
        parseNumericValue(extractBarchartListStatValue(bootstrap.html, 'Put/Call OI Ratio')) ??
        parseNumericValue(extractBarchartListStatValue(bootstrap.html, 'Put/Call Open Interest Ratio')) ??
        parseNumericValue(extractBarchartInlineSummaryValue(bootstrap.html, 'Put/Call Open Interest Ratio')) ??
        snapshot.put_call_ratio;
      snapshot.next_earnings_date =
        normalizeDateInput(extractBarchartInlineSummaryValue(bootstrap.html, 'Latest Earnings')) ??
        snapshot.next_earnings_date;
      snapshot.current_iv =
        parsePercentToDecimal(extractBarchartInlineSummaryValue(bootstrap.html, 'Implied Volatility')) ??
        snapshot.current_iv;
      snapshot.historical_iv =
        parsePercentToDecimal(extractBarchartInlineSummaryValue(bootstrap.html, 'Historic Volatility')) ??
        snapshot.historical_iv;
      snapshot.iv_rank =
        parsePercentToRank(extractBarchartInlineSummaryValue(bootstrap.html, 'IV Rank')) ??
        snapshot.iv_rank;
      snapshot.iv_percentile =
        parsePercentToRank(extractBarchartInlineSummaryValue(bootstrap.html, 'IV Percentile')) ??
        snapshot.iv_percentile;
      snapshot.source = 'Barchart HTML';
    }
  } catch {
    bootstrap = null;
  }

  try {
    const { payload } = await fetchBarchartProxyJson(
      symbol,
      [
        'symbol',
        'lastPrice',
        'tradeTime',
        'baseNextEarningsDate',
        'baseTimeCode',
        'optionsWeightedImpliedVolatility',
        'historicVolatility30d',
        'optionsImpliedVolatilityRank1y',
        'optionsImpliedVolatilityPercentile1y',
        'optionsPutCallOpenInterestRatio'
      ],
      BARCHART_DEFAULT_PAGE
    );
    const record = normalizeBarchartQuoteRecord(payload);

    if (record) {
      snapshot.current_price = parseNumericValue(record.lastPrice) ?? snapshot.current_price;
      snapshot.current_price_date = parseBarchartTradeTime(record.tradeTime) ?? snapshot.current_price_date;
      snapshot.next_earnings_date =
        typeof record.baseNextEarningsDate === 'string' && record.baseNextEarningsDate.trim() !== ''
          ? normalizeDateInput(record.baseNextEarningsDate.trim()) ?? record.baseNextEarningsDate.trim()
          : snapshot.next_earnings_date;
      snapshot.earnings_time_code =
        typeof record.baseTimeCode === 'string' && record.baseTimeCode.trim() !== ''
          ? record.baseTimeCode.trim()
          : snapshot.earnings_time_code;
      snapshot.current_iv = parsePercentToDecimal(record.optionsWeightedImpliedVolatility) ?? snapshot.current_iv;
      snapshot.historical_iv = parsePercentToDecimal(record.historicVolatility30d) ?? snapshot.historical_iv;
      snapshot.iv_rank = parsePercentToRank(record.optionsImpliedVolatilityRank1y) ?? snapshot.iv_rank;
      snapshot.iv_percentile =
        parsePercentToRank(record.optionsImpliedVolatilityPercentile1y) ?? snapshot.iv_percentile;
      snapshot.put_call_ratio =
        parseNumericValue(record.optionsPutCallOpenInterestRatio) ?? snapshot.put_call_ratio;
      snapshot.source = 'Barchart quotes/get';
    }
  } catch {
    // Fall through to MarketData.app / TwelveData below.
  }

  try {
    const overviewBootstrap = await fetchBarchartBootstrap(symbol, 'overview');

    snapshot.next_earnings_date =
      normalizeDateInput(extractBarchartListStatValue(overviewBootstrap.html, 'Next Earnings Date')) ??
      snapshot.next_earnings_date;
    snapshot.current_iv =
      parsePercentToDecimal(extractBarchartListStatValue(overviewBootstrap.html, 'Implied Volatility')) ??
      snapshot.current_iv;
    snapshot.historical_iv =
      parsePercentToDecimal(extractBarchartListStatValue(overviewBootstrap.html, 'Historical Volatility')) ??
      snapshot.historical_iv;
    snapshot.iv_rank =
      parsePercentToRank(extractBarchartListStatValue(overviewBootstrap.html, 'IV Rank')) ?? snapshot.iv_rank;
    snapshot.iv_percentile =
      parsePercentToRank(extractBarchartListStatValue(overviewBootstrap.html, 'IV Percentile')) ??
      snapshot.iv_percentile;
    snapshot.source = snapshot.source ?? 'Barchart overview HTML';
  } catch {
    // Ignore HTML fallback errors.
  }

  return snapshot;
}

async function fetchBarchartQuickQuote(symbol) {
  const bootstrap = await fetchBarchartBootstrap(symbol, BARCHART_DEFAULT_PAGE);
  const currentSymbol = bootstrap?.config?.currentSymbol?.raw ?? bootstrap?.config?.currentSymbol ?? null;

  if (!currentSymbol) {
    throw new Error(`Barchart quick quote unavailable for ${symbol}`);
  }

  const price =
    parseNumericValue(currentSymbol.lastPrice) ??
    parseNumericValue(currentSymbol.dailyLastPrice);

  if (price === null || !Number.isFinite(price)) {
    throw new Error(`Invalid Barchart quick quote for ${symbol}`);
  }

  return {
    price,
    asOf:
      parseBarchartTradeTime(currentSymbol.tradeTime) ??
      parseBarchartTradeTime(bootstrap?.config?.currentSymbol?.tradeTime) ??
      null,
    source: 'Barchart HTML'
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loadSavedSnapshot() {
  return readAppState();
}

async function saveSnapshot(payload) {
  await writeAppState(payload);
}

function hasMeaningfulSnapshotData(snapshot) {
  const data = typeof snapshot?.data === 'object' && snapshot.data !== null ? snapshot.data : {};

  return (
    data.config !== null ||
    (Array.isArray(data.puts) && data.puts.length > 0) ||
    (Array.isArray(data.closedTrades) && data.closedTrades.length > 0) ||
    (Array.isArray(data.stockTrades) && data.stockTrades.length > 0) ||
    (Array.isArray(data.tickerList) && data.tickerList.length > 0) ||
    (Array.isArray(data.accountValueHistory) && data.accountValueHistory.length > 0)
  );
}

function mergeSnapshotPreservingExistingCoreState(incomingSnapshot, existingSnapshot, saveMode = 'replace') {
  const incomingData =
    typeof incomingSnapshot?.data === 'object' && incomingSnapshot.data !== null ? incomingSnapshot.data : {};
  const existingData =
    typeof existingSnapshot?.data === 'object' && existingSnapshot.data !== null ? existingSnapshot.data : {};
  const incomingClosedTrades = Array.isArray(incomingData.closedTrades) ? incomingData.closedTrades : [];
  const existingClosedTrades = Array.isArray(existingData.closedTrades) ? existingData.closedTrades : [];
  const incomingStockTrades = Array.isArray(incomingData.stockTrades) ? incomingData.stockTrades : [];
  const existingStockTrades = Array.isArray(existingData.stockTrades) ? existingData.stockTrades : [];
  const incomingAccountValueHistory = Array.isArray(incomingData.accountValueHistory) ? incomingData.accountValueHistory : [];
  const existingAccountValueHistory = Array.isArray(existingData.accountValueHistory) ? existingData.accountValueHistory : [];
  const incomingPuts = Array.isArray(incomingData.puts) ? incomingData.puts : [];
  const existingPuts = Array.isArray(existingData.puts) ? existingData.puts : [];
  const closedPositionIds = buildMembershipSet(
    [...existingClosedTrades, ...incomingClosedTrades],
    (item) => item?.position_id
  );

  const hasSamePositionMembership = compareObjectArrayMembership(incomingPuts, existingPuts, (item) => item?.id);
  const hasClosedTradeSuperset = hasObjectArraySuperset(incomingClosedTrades, existingClosedTrades, (item) => item?.id);
  const hasStockTradeSuperset = hasObjectArraySuperset(incomingStockTrades, existingStockTrades, (item) => item?.id);
  const hasAccountHistorySuperset = hasObjectArraySuperset(
    incomingAccountValueHistory,
    existingAccountValueHistory,
    (item) => item?.date
  );

  return {
    ...incomingSnapshot,
    data: {
      ...incomingData,
      config: incomingData.config ?? existingData.config ?? null,
      puts:
        saveMode === 'replace'
          ? incomingPuts
          : (() => {
              const incomingById = new Map(incomingPuts.map((p) => [p.id, p]));
              const existingById = new Map(existingPuts.map((p) => [p.id, p]));
              const allIds = new Set(
                [...existingById.keys(), ...incomingById.keys()].filter((id) => !closedPositionIds.has(id))
              );

              return [...allIds].map(id => {
                const incoming = incomingById.get(id);
                const existing = existingById.get(id);
                if (!incoming) return existing;
                if (!existing) return incoming;

                // Merge: prefer background updates (market price/greeks) from existing if present
                return {
                  ...incoming,
                  option_market_price_per_share: existing.option_market_price_per_share ?? incoming.option_market_price_per_share,
                  option_market_price_updated: existing.option_market_price_updated ?? incoming.option_market_price_updated,
                  option_theta_per_share: existing.option_theta_per_share ?? incoming.option_theta_per_share,
                  option_delta: existing.option_delta ?? incoming.option_delta,
                  option_gamma: existing.option_gamma ?? incoming.option_gamma
                };
              }).filter(Boolean);
            })(),
      closedTrades:
        saveMode === 'replace' || hasClosedTradeSuperset || existingClosedTrades.length === 0
          ? incomingClosedTrades
          : existingClosedTrades,
      stockTrades:
        saveMode === 'replace' || hasStockTradeSuperset || existingStockTrades.length === 0
          ? incomingStockTrades
          : existingStockTrades,
      accountValueHistory:
        saveMode === 'replace' || hasAccountHistorySuperset || existingAccountValueHistory.length === 0
          ? incomingAccountValueHistory
          : existingAccountValueHistory
    }
  };
}

function buildMembershipSet(items, getKey) {
  return new Set(
    (Array.isArray(items) ? items : [])
      .map((item) => getKey(item))
      .filter((value) => typeof value === 'string' && value.trim() !== '')
  );
}

function compareObjectArrayMembership(incomingItems, existingItems, getKey) {
  const incomingKeys = buildMembershipSet(incomingItems, getKey);
  const existingKeys = buildMembershipSet(existingItems, getKey);

  if (incomingKeys.size !== existingKeys.size) {
    return false;
  }

  return [...incomingKeys].every((key) => existingKeys.has(key));
}

function hasObjectArraySuperset(incomingItems, existingItems, getKey) {
  const incomingKeys = buildMembershipSet(incomingItems, getKey);
  const existingKeys = buildMembershipSet(existingItems, getKey);

  if (existingKeys.size === 0) {
    return true;
  }

  return [...existingKeys].every((key) => incomingKeys.has(key));
}

function mergeTickerListsPreservingExistingEntries(incomingTickerList, existingTickerList) {
  const incomingEntries = Array.isArray(incomingTickerList) ? incomingTickerList : [];
  const existingEntries = Array.isArray(existingTickerList) ? existingTickerList : [];
  const incomingByTicker = new Map(
    incomingEntries
      .filter((entry) => typeof entry?.ticker === 'string' && entry.ticker.trim() !== '')
      .map((entry) => [entry.ticker, entry])
  );
  const existingByTicker = new Map(
    existingEntries
      .filter((entry) => typeof entry?.ticker === 'string' && entry.ticker.trim() !== '')
      .map((entry) => [entry.ticker, entry])
  );
  const tickers = new Set([...existingByTicker.keys(), ...incomingByTicker.keys()]);

  return [...tickers]
    .map((ticker) => {
      const incomingEntry = incomingByTicker.get(ticker);
      const existingEntry = existingByTicker.get(ticker);

      if (!incomingEntry) {
        return existingEntry ?? null;
      }

      if (!existingEntry) {
        return incomingEntry;
      }

      return {
        ...existingEntry,
        ...incomingEntry
      };
    })
    .filter((entry) => entry !== null)
    .sort((a, b) => (a.ticker ?? '').localeCompare(b.ticker ?? ''));
}

function buildCoreSnapshotStats(snapshot) {
  const data = typeof snapshot?.data === 'object' && snapshot.data !== null ? snapshot.data : {};
  return {
    puts: Array.isArray(data.puts) ? data.puts.length : 0,
    closedTrades: Array.isArray(data.closedTrades) ? data.closedTrades.length : 0,
    stockTrades: Array.isArray(data.stockTrades) ? data.stockTrades.length : 0,
    tickerList: Array.isArray(data.tickerList) ? data.tickerList.length : 0,
    accountValueHistory: Array.isArray(data.accountValueHistory) ? data.accountValueHistory.length : 0
  };
}

function findSuspiciousSnapshotShrink(incomingSnapshot, existingSnapshot, saveMode, allowDestructiveWrite) {
  if (saveMode !== 'replace' || allowDestructiveWrite) {
    return [];
  }

  const incoming = buildCoreSnapshotStats(incomingSnapshot);
  const existing = buildCoreSnapshotStats(existingSnapshot);
  const issues = [];

  if (existing.closedTrades > 0 && incoming.closedTrades === 0) {
    issues.push(`closedTrades ${existing.closedTrades} -> 0`);
  }
  if (existing.stockTrades > 0 && incoming.stockTrades === 0) {
    issues.push(`stockTrades ${existing.stockTrades} -> 0`);
  }
  if (existing.accountValueHistory > 1 && incoming.accountValueHistory === 0) {
    issues.push(`accountValueHistory ${existing.accountValueHistory} -> 0`);
  }
  if (existing.tickerList >= 3 && incoming.tickerList <= Math.floor(existing.tickerList / 2)) {
    issues.push(`tickerList ${existing.tickerList} -> ${incoming.tickerList}`);
  }

  return issues;
}

function getDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function loadVixCache() {
  return readVixCache();
}

async function saveVixCache(payload) {
  await writeVixCache(payload);
}

function buildCachedVixSnapshot(cached) {
  if (!cached || typeof cached.value !== 'number' || !Number.isFinite(cached.value)) {
    return null;
  }

  return {
    value: cached.value,
    as_of: typeof cached.as_of === 'string' ? cached.as_of : null,
    source: 'Cboe official daily close',
    cached: true,
    fear_greed_score: typeof cached.fear_greed_score === 'number' ? cached.fear_greed_score : null,
    fear_greed_rating: typeof cached.fear_greed_rating === 'string' ? cached.fear_greed_rating : null,
    fear_greed_status: 'cached',
    fear_greed_error: null,
    storage_driver: describeStorageTarget().driver,
    cache_write_ok: null,
    cache_write_error: null
  };
}

function shouldRefreshVixWithMarketData({ cached, force, includeVix, marketOpen, now, staleTickerCount }) {
  if (!includeVix || staleTickerCount <= 0 || (!marketOpen && !force)) {
    return false;
  }

  return cached?.fetched_on !== getDateKey(now);
}

async function loadRefreshStatus() {
  return readRefreshStatus();
}

async function saveRefreshStatus(payload) {
  await writeRefreshStatus(payload);
}

async function saveRefreshStatusSafely(payload) {
  try {
    await saveRefreshStatus(payload);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : 'Failed to save refresh status';
  }
}

function shouldPersistProgressStatus(status, lastCompletedSteps) {
  if (!status || typeof status !== 'object') {
    return false;
  }

  const completedSteps = Number.isFinite(status.completed_steps) ? status.completed_steps : 0;
  const totalSteps = Number.isFinite(status.total_steps) ? status.total_steps : 0;
  const label = typeof status.current_label === 'string' ? status.current_label : '';

  if (completedSteps <= 0) {
    return false;
  }

  if (completedSteps >= totalSteps && totalSteps > 0) {
    return true;
  }

  if (completedSteps - lastCompletedSteps >= 10) {
    return true;
  }

  return /VIX|Fear & Greed/iu.test(label);
}

function isFreshTimestamp(timestamp, ttlMs) {
  if (typeof timestamp !== 'string' || timestamp === '') {
    return false;
  }

  const value = new Date(timestamp).getTime();
  return Number.isFinite(value) && Date.now() - value < ttlMs;
}

function getLocalDateInput(date = new Date()) {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function isExpiredDateInput(expirationDate, now = new Date()) {
  return typeof expirationDate === 'string' && expirationDate !== '' && expirationDate < getLocalDateInput(now);
}

function getNewYorkTimeParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

  return { weekday, hour, minute };
}

export function isUsMarketOpenEastern(date = new Date()) {
  const { weekday, hour, minute } = getNewYorkTimeParts(date);

  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }

  const minutes = hour * 60 + minute;
  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;
  return minutes >= marketOpen && minutes < marketClose;
}

export function isRefreshStale(timestamp, ttlMs, now = Date.now()) {
  if (typeof timestamp !== 'string' || timestamp === '') {
    return true;
  }

  const value = new Date(timestamp).getTime();
  return !Number.isFinite(value) || now - value >= ttlMs;
}

function getAuthorizationHeader(req) {
  if (!req?.headers) {
    return '';
  }

  if (typeof req.headers.get === 'function') {
    return req.headers.get('authorization') ?? '';
  }

  const headerValue = req.headers.authorization;
  if (Array.isArray(headerValue)) {
    return headerValue[0] ?? '';
  }

  return typeof headerValue === 'string' ? headerValue : '';
}

function requireCronAuthorization(req) {
  const secret = (process.env.CRON_SECRET ?? '').trim();
  if (secret === '') {
    return { ok: false, status: 500, error: 'CRON_SECRET is not configured' };
  }

  const authorization = getAuthorizationHeader(req);
  if (authorization !== `Bearer ${secret}`) {
    return { ok: false, status: 401, error: 'Unauthorized' };
  }

  return { ok: true };
}

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw === '' ? {} : JSON.parse(raw);
}

function buildGeminiPrompt(payload) {
  const {
    option_side,
    ticker,
    contracts,
    put_strike,
    premium_per_share,
    expiration_date,
    date_sold,
    annualized_yield,
    put_risk,
    risk_pct_of_cash,
    current_price,
    beta,
    rsi_14,
    ma_21,
    ma_200,
    current_iv,
    put_call_ratio,
    active_stress_pct
  } = payload;
  const optionSide = option_side === 'call' ? 'Covered Call' : 'Sell Put';

  return [
    `你是一位严谨的 ${optionSide} 风险分析师。请用中文回答。`,
    '请只输出严格 JSON，不要输出 Markdown，不要输出代码块，不要有额外解释。',
    'JSON schema:',
    '{',
    '  "verdict": "适合继续持有 | 需要谨慎 | 不建议做",',
    '  "summary": "一句话总结，不超过35个字",',
    '  "key_risks": ["最多3条，每条不超过30字"],',
    '  "recent_change": "最近最重要变化，不超过50字",',
    '  "fundamental_note": "最需要注意的基本面问题，不超过50字",',
    '  "calc": {',
    '    "breakeven": "数字字符串，保留2位小数",',
    '    "buffer_pct": "数字字符串，保留2位小数，表示(current price - strike) / current price * 100",',
    '    "max_profit": "数字字符串，保留2位小数",',
    '    "annualized_yield_pct": "数字字符串，保留2位小数，表示年化收益率百分比",',
    '    "rsi_display": "例如 28.4（超卖）/ 41.2（非超卖）/ 未刷新"',
    '  }',
    '}',
    '如果使用到了最近新闻或网页信息，请优先基于 Google Search 的结果。',
    '',
    `Ticker: ${ticker}`,
    `Contracts: ${contracts}`,
    `Strike: ${put_strike}`,
    `Premium per share: ${premium_per_share}`,
    `Date sold: ${date_sold}`,
    `Expiration date: ${expiration_date}`,
    `Annualized yield: ${annualized_yield}`,
    `Risk: ${put_risk}`,
    `Risk % of cash: ${risk_pct_of_cash}`,
    `Active stress pct: ${active_stress_pct}`,
    `Current price: ${current_price}`,
    `Beta: ${beta}`,
    `RSI(14): ${rsi_14}`,
    `MA21: ${ma_21}`,
    `MA200: ${ma_200}`,
    `Current IV: ${current_iv}`,
    `Put-Call Ratio(OI): ${put_call_ratio}`
  ].join('\n');
}

function formatPromptMetric(value, formatter = (input) => String(input)) {
  if (value === null || value === undefined || value === '') {
    return '未确认';
  }

  return formatter(value);
}

function formatDecimalAsPercent(value) {
  return formatPromptMetric(value, (input) => `${(Number(input) * 100).toFixed(2)}%`);
}

function formatNumericPercent(value) {
  return formatPromptMetric(value, (input) => `${Number(input).toFixed(2)}%`);
}

function formatStrikeLevel(cluster) {
  if (!cluster || !Number.isFinite(cluster.strike)) {
    return '未确认';
  }

  return `${cluster.strike.toFixed(2)} (OI ${Math.round(cluster.openInterest ?? 0)})`;
}

function formatTechnicalLevel(level) {
  if (!level || !Number.isFinite(level.price)) {
    return '未确认';
  }

  const label =
    typeof level.label === 'string' && level.label.trim() !== ''
      ? level.label.trim()
      : typeof level.source === 'string' && level.source.trim() !== ''
        ? level.source.trim()
        : '日K关键位';
  const strength =
    typeof level.strength === 'number' && Number.isFinite(level.strength) ? `, 强度 ${level.strength.toFixed(1)}` : '';
  return `${level.price.toFixed(2)} (${label}${strength})`;
}

function getPreferredSupportResistanceLabel(technicalLevel, cluster) {
  const technicalLabel = formatTechnicalLevel(technicalLevel);
  if (technicalLabel !== '未确认') {
    return technicalLabel;
  }

  return formatStrikeLevel(cluster);
}

function formatCandidateForPrompt(candidate) {
  return {
    code: candidate.code,
    strike: Number(candidate.strike.toFixed(2)),
    delta: candidate.delta === null ? '未确认' : Number(candidate.delta.toFixed(4)),
    delta_abs: candidate.deltaAbs === null || candidate.deltaAbs === undefined ? '未确认' : Number(candidate.deltaAbs.toFixed(4)),
    open_interest: Math.round(candidate.openInterest),
    volume: Math.round(candidate.volume),
    bid: candidate.bid === null ? '未确认' : Number(candidate.bid.toFixed(2)),
    ask: candidate.ask === null ? '未确认' : Number(candidate.ask.toFixed(2)),
    spread_pct: candidate.spreadPct === null ? '未确认' : Number(candidate.spreadPct.toFixed(2)),
    implied_volatility_pct:
      candidate.impliedVolatility === null ? '未确认' : Number(candidate.impliedVolatility.toFixed(2)),
    otm_pct: candidate.distancePct === null || candidate.distancePct === undefined ? '未确认' : Number(candidate.distancePct.toFixed(2)),
    outside_key_level:
      typeof candidate.outsideLevel === 'boolean'
        ? candidate.outsideLevel
        : '未确认',
    key_level_buffer_pct:
      candidate.levelDistancePct === null || candidate.levelDistancePct === undefined
        ? '未确认'
        : Number(candidate.levelDistancePct.toFixed(2)),
    selection_basis: Array.isArray(candidate.selectionBasis) ? candidate.selectionBasis : []
  };
}

function formatRecommendedPremium(candidate) {
  if (!candidate) {
    return '未确认';
  }

  const price = typeof candidate.price === 'number' && Number.isFinite(candidate.price) ? candidate.price : null;
  const bid = typeof candidate.bid === 'number' && Number.isFinite(candidate.bid) ? candidate.bid : null;
  const ask = typeof candidate.ask === 'number' && Number.isFinite(candidate.ask) ? candidate.ask : null;

  if (price !== null) {
    return price.toFixed(2);
  }
  if (bid !== null && ask !== null) {
    return ((bid + ask) / 2).toFixed(2);
  }
  if (ask !== null) {
    return ask.toFixed(2);
  }
  if (bid !== null) {
    return bid.toFixed(2);
  }
  return '未确认';
}

function formatRecommendedDistance(candidate, currentPrice) {
  if (!candidate || currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return '未确认';
  }

  const distancePct =
    candidate.side === 'call'
      ? ((candidate.strike - currentPrice) / currentPrice) * 100
      : ((currentPrice - candidate.strike) / currentPrice) * 100;

  return `${distancePct >= 0 ? '+' : ''}${distancePct.toFixed(2)}%`;
}

function buildKlineRationale(analysisContext) {
  const optionSide = analysisContext.optionSide === 'call' ? 'call' : 'put';
  const candidate = analysisContext.optionChain.recommended_candidate;
  const supportLevel = getPreferredSupportResistanceLabel(
    analysisContext.optionChain.technical_support,
    analysisContext.optionChain.support_cluster
  );
  const resistanceLevel = getPreferredSupportResistanceLabel(
    analysisContext.optionChain.technical_resistance,
    analysisContext.optionChain.resistance_cluster
  );

  if (!candidate) {
    return optionSide === 'call'
      ? `日K压力参考 ${resistanceLevel}；当前没有找到同时满足 45 DTE 优先、OTM 和关键位外侧条件的 Call 候选。`
      : `日K支撑参考 ${supportLevel}；当前没有找到同时满足 45 DTE 优先、OTM 和关键位外侧条件的 Put 候选。`;
  }

  const sideText = optionSide === 'call' ? 'Call' : 'Put';
  const anchorText = optionSide === 'call' ? `日K压力 ${resistanceLevel}` : `日K支撑 ${supportLevel}`;
  const outsideText =
    candidate.outsideLevel == null ? '尚未确认是否位于关键位外侧' : candidate.outsideLevel ? '位于关键位外侧' : '仍在关键位内侧';
  const bufferText =
    candidate.levelDistancePct == null
      ? '未确认关键位缓冲'
      : `距关键位缓冲 ${candidate.levelDistancePct >= 0 ? '+' : ''}${candidate.levelDistancePct.toFixed(2)}%`;
  const basisText = Array.isArray(candidate.selectionBasis) && candidate.selectionBasis.length > 0
    ? `满足 ${candidate.selectionBasis.join(' / ')}`
    : '满足量化筛选条件';

  return `${anchorText}；推荐 ${candidate.strike.toFixed(2)} ${sideText}，${outsideText}，${bufferText}，${basisText}。`;
}

function buildSideSpecificPromptInstructions(optionSide, optionChain) {
  const recommendedCandidate = optionChain.recommended_candidate;
  const technicalSupport = optionChain.technical_support?.price ?? optionChain.support_cluster?.strike;
  const technicalResistance = optionChain.technical_resistance?.price ?? optionChain.resistance_cluster?.strike;
  const sideLabel = optionSide === 'call' ? 'Sell Call' : 'Sell Put';
  const anchorLevel = optionSide === 'call' ? '日K 压力位' : '日K 支撑位';
  const anchorCandidateSide = optionSide === 'call' ? 'call' : 'put';
  const candidateAnchorText = recommendedCandidate
    ? `${recommendedCandidate.code} @ ${recommendedCandidate.strike.toFixed(2)}`
    : '暂无满足 Delta 0.10-0.20 / 5%-10% OTM / 关键位外侧条件的候选';
  const strikeGuardrail =
    optionSide === 'call'
      ? `如果推荐卖 Call，推荐行权价原则上应不低于日K压力位 ${Number.isFinite(technicalResistance) ? technicalResistance.toFixed(2) : '未确认'}，除非明确说明是在更激进地卖出。`
      : `如果推荐卖 Put，推荐行权价原则上应不高于日K支撑位 ${Number.isFinite(technicalSupport) ? technicalSupport.toFixed(2) : '未确认'}，除非明确说明是在更激进地卖出。`;

  return [
    `当前方向是 ${sideLabel}。请严格按这个方向分析，不要按另一个方向写结论。`,
    optionSide === 'call'
      ? 'Sell Call 先看历史日K压力位外侧，再用 35-60 DTE、45 DTE 优先、Delta 0.10-0.20、5%-10% OTM 和 OI/价差做排序。'
      : 'Sell Put 先看历史日K支撑位外侧，再用 35-60 DTE、45 DTE 优先、Delta 0.10-0.20、5%-10% OTM 和 OI/价差做排序。',
    `当前最值得优先参考的主锚点是 ${anchorLevel}。`,
    `候选合约也只能优先围绕 ${anchorCandidateSide} 侧候选展开，当前首选候选: ${candidateAnchorText}。`,
    strikeGuardrail,
    optionSide === 'call'
      ? '如果 summary、recommendation_reason、trade_action 提到“支撑位更安全的 Put”之类表述，说明方向错了，必须改写。'
      : '如果 summary、recommendation_reason、trade_action 提到“压力位更安全的 Call”之类表述，说明方向错了，必须改写。'
  ];
}

function buildPreTradeGeminiPrompt(payload, analysisContext) {
  const optionSide = payload.option_side === 'call' ? 'call' : 'put';
  const optionSideLabel = optionSide === 'call' ? 'Sell Call' : 'Sell Put';
  const {
    ticker,
    date_sold,
    user_rationale
  } = payload;
  const { marketContext, optionChain } = analysisContext;
  const sideSpecificInstructions = buildSideSpecificPromptInstructions(optionSide, optionChain);
  const recommendedCandidate = optionChain.recommended_candidate;

  return [
    '你是一位资深的衍生品量化策略师，擅长结合正股历史日K线、期权链 OI 和流动性数据做美股期权卖方决策。',
    '请用中文回答。',
    '请只输出严格 JSON，不要输出 Markdown，不要输出代码块，不要输出额外解释。',
    '你只能基于我提供的 moomoo API 历史 K 线、期权链摘要、当前 VIX/VXN 状态和用户交易计划来分析，不要自行联网搜索。',
    '',
    'Analysis Framework:',
    '1. 先用 moomoo 历史日K线识别正股关键支撑位和压力位。',
    '2. 到期日优先选择 35-60 DTE 中最接近 45 天的一档；如果没有，再取最近的一档。',
    '3. 候选合约优先选择更远一点的 OTM 行权价。',
    '4. 候选合约至少满足以下之一：Delta 0.10-0.20，或距现价 5%-10% OTM，或位于关键支撑/压力外侧。',
    '5. 再结合 OI、成交量、买卖价差和 IV Rank 判断执行质量。',
    '6. 必须根据当前交易方向使用对应侧候选，不要串用另一侧逻辑。',
    '',
    '请输出以下 JSON schema:',
    '{',
    '  "verdict": "可以卖 | 需要谨慎 | 暂不卖",',
    '  "summary": "一句话总结，不超过40字",',
    '  "recommended_expiration": "推荐到期日，格式 YYYY-MM-DD",',
    '  "recommended_dte": "推荐 DTE 数字，不带单位",',
    '  "premium_view": "基于 IV Rank / IV / 权利金环境的判断，不超过45字",',
    '  "support_level": "明确写出日K支撑位价格和原因，不超过30字",',
    '  "resistance_level": "明确写出日K压力位价格和原因，不超过30字",',
    '  "recommended_strike": "建议的最安全行权价；没有合适候选则写 暂无合适合约",',
    '  "recommended_premium": "建议关注的权利金/股；没有合适候选则写 未确认",',
    '  "recommended_distance": "建议行权价距离现价的百分比；没有则写 未确认",',
    '  "recommendation_reason": "解释为什么选择这个行权价，不超过70字",',
    '  "candidate_focus": "点名最值得关注的候选合约并说明其满足了哪些量化条件，不超过60字",',
    '  "trade_action": "明确的交易决策，不超过35字",',
    '  "key_risks": ["最多3条，每条不超过28字"],',
    '  "warnings": ["如果成交量异常放大或价差过大必须提醒；最多4条"]',
    '}',
    '',
    '用户计划:',
    `- 标的: ${ticker}`,
    `- 方向: ${optionSideLabel}`,
    `- 建议基准日: ${date_sold}`,
    `- 用户自述计划: ${typeof user_rationale === 'string' && user_rationale.trim() !== '' ? user_rationale : '未提供'}`,
    '',
    '市场上下文:',
    `- 现价: ${formatPromptMetric(marketContext.current_price, (value) => Number(value).toFixed(2))}`,
    `- 现价时间: ${formatPromptMetric(marketContext.current_price_date)}`,
    `- Current IV: ${formatDecimalAsPercent(marketContext.current_iv)}`,
    `- IV Rank: ${formatPromptMetric(marketContext.iv_rank, (value) => Number(value).toFixed(1))}`,
    `- Next earnings date: ${formatPromptMetric(marketContext.next_earnings_date)}`,
    `- VIX: ${formatPromptMetric(marketContext.vix?.value, (value) => Number(value).toFixed(2))} (as of ${formatPromptMetric(marketContext.vix?.as_of)})`,
    `- VXN: ${formatPromptMetric(marketContext.vxn?.value, (value) => Number(value).toFixed(2))} (as of ${formatPromptMetric(marketContext.vxn?.as_of)})`,
    '',
    'moomoo 历史日K摘要:',
    `- 日K 支撑位: ${formatTechnicalLevel(optionChain.technical_support)}`,
    `- 日K 压力位: ${formatTechnicalLevel(optionChain.technical_resistance)}`,
    `- K线分析日期: ${formatPromptMetric(optionChain.kline_as_of)}`,
    '',
    'moomoo 期权链摘要:',
    `- 推荐到期日: ${formatPromptMetric(optionChain.expiration_date)}`,
    `- 推荐 DTE: ${formatPromptMetric(optionChain.recommended_dte, (value) => String(Math.round(value)))}`,
    `- Put OI 支撑峰值: ${formatStrikeLevel(optionChain.support_cluster)}`,
    `- Call OI 压力峰值: ${formatStrikeLevel(optionChain.resistance_cluster)}`,
    `- 当前首选候选行权价: ${recommendedCandidate ? recommendedCandidate.strike.toFixed(2) : '未确认'}`,
    `- 当前首选候选权利金/股: ${formatRecommendedPremium(recommendedCandidate)}`,
    `- 当前首选候选距现价: ${formatRecommendedDistance(recommendedCandidate, marketContext.current_price)}`,
    `- 目标方向候选合约: ${JSON.stringify(optionChain.candidate_contracts.map(formatCandidateForPrompt), null, 2)}`,
    `- 预警: ${JSON.stringify(optionChain.warnings)}`,
    '',
    '方向专属约束:',
    ...sideSpecificInstructions.map((line) => `- ${line}`),
    '',
    '请根据以上信息给出卖方交易决策。'
  ].join('\n');
}

function sanitizeStringList(value, limit = 4) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function parseGeminiJson(text) {
  const candidates = [text];
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1).trim());
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // Try the next extraction strategy.
    }
  }

  throw new Error('Gemini returned invalid JSON');
}

function buildGroundingSources(data) {
  const groundingChunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  return groundingChunks
    .map((chunk) => chunk?.web)
    .filter((item) => item && typeof item.uri === 'string')
    .map((item) => ({
      title: typeof item.title === 'string' && item.title !== '' ? item.title : item.uri,
      url: item.uri
    }))
    .map((item) => ({
      ...item,
      publicUrl: typeof item.url === 'string' ? item.url : ''
    }))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.url === item.url) === index);
}

async function analyzePositionWithGemini(payload) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: buildGeminiPrompt(payload) }]
          }
        ],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.3
        }
      })
    }
  );

  const data = await readJsonFromResponse(response, 'Gemini analysis failed');
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message ?? 'Gemini analysis failed');
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text)
      .filter((value) => typeof value === 'string')
      .join('\n')
      .trim() ?? '';

  if (text === '') {
    throw new Error('Gemini returned empty analysis');
  }

  const parsed = parseGeminiJson(text);

  const optionSide = payload.option_side === 'call' ? 'call' : 'put';
  const currentPrice = Number(payload.current_price);
  const strike = Number(payload.put_strike);
  const premiumPerShare = Number(payload.premium_per_share);
  const contracts = Number(payload.contracts);
  const annualizedYield = Number(payload.annualized_yield);
  const rsi = payload.rsi_14 === null || payload.rsi_14 === undefined ? null : Number(payload.rsi_14);
  const breakeven = optionSide === 'call' ? strike + premiumPerShare : strike - premiumPerShare;
  const bufferPct =
    Number.isFinite(currentPrice) && currentPrice > 0
      ? (optionSide === 'call' ? ((strike - currentPrice) / currentPrice) * 100 : ((currentPrice - strike) / currentPrice) * 100)
      : 0;
  const maxProfit = premiumPerShare * contracts * 100;

  parsed.calc = {
    breakeven: breakeven.toFixed(2),
    buffer_pct: bufferPct.toFixed(2),
    max_profit: maxProfit.toFixed(2),
    annualized_yield_pct: Number.isFinite(annualizedYield) ? (annualizedYield * 100).toFixed(2) : '0.00',
    rsi_display:
      rsi === null || !Number.isFinite(rsi) ? '未刷新' : `${rsi.toFixed(1)}（${rsi <= 30 ? '超卖' : '非超卖'}）`
  };

  const sources = buildGroundingSources(data)
    .map(({ title, publicUrl, url }) => ({
      title,
      url: publicUrl || url
    }))
    .slice(0, 6);

  return {
    analysis: parsed,
    sources
  };
}

async function fetchLatestOfficialVolatilityIndexDailyClose(symbol) {
  const response = await fetchWithTimeout(`https://cdn.cboe.com/api/global/us_indices/daily_prices/${symbol}_History.csv`);
  const csv = await response.text();

  if (!response.ok) {
    throw new Error(`Failed to fetch official ${symbol} history`);
  }

  const rows = csv
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5);

  if (rows.length < 2) {
    throw new Error(`Official ${symbol} history is empty`);
  }

  const header = rows[0].map((value) => value.toUpperCase());
  const dateIndex = header.findIndex((value) => value === 'DATE');
  const closeIndex = header.findIndex((value) => value === 'CLOSE');

  if (dateIndex === -1 || closeIndex === -1) {
    throw new Error(`Unexpected ${symbol} history format`);
  }

  const latestRow = rows[rows.length - 1];
  const date = latestRow[dateIndex];
  const value = Number(latestRow[closeIndex]);

  if (!date || !Number.isFinite(value)) {
    throw new Error(`Invalid official ${symbol} daily close`);
  }

  return {
    value,
    asOf: date,
    source: 'Cboe official daily close'
  };
}

function buildPreTradeAnalysisPayload(parsed, analysisContext) {
  const optionSide = analysisContext.optionSide === 'call' ? 'call' : 'put';
  const sideLabel = optionSide === 'call' ? 'Call' : 'Put';
  const supportLevel = getPreferredSupportResistanceLabel(
    analysisContext.optionChain.technical_support,
    analysisContext.optionChain.support_cluster
  );
  const resistanceLevel = getPreferredSupportResistanceLabel(
    analysisContext.optionChain.technical_resistance,
    analysisContext.optionChain.resistance_cluster
  );
  const recommendedCandidate = analysisContext.optionChain.recommended_candidate;
  const fallbackReason =
    optionSide === 'call'
      ? '请优先选择 35-60 DTE 内最接近 45 天、位于日K压力位外侧且更远 OTM 的 call 合约。'
      : '请优先选择 35-60 DTE 内最接近 45 天、位于日K支撑位外侧且更远 OTM 的 put 合约。';
  const fallbackTradeAction =
    optionSide === 'call' ? '优先考虑更高行权价、位于压力位外侧的 Call。' : '优先考虑更低行权价、位于支撑位外侧的 Put。';
  const fallbackSummary =
    optionSide === 'call'
      ? '请结合 45 DTE、日K压力位外侧与 call 候选再确认。'
      : '请结合 45 DTE、日K支撑位外侧与 put 候选再确认。';
  const candidateFallback =
    recommendedCandidate
      ? `${recommendedCandidate.code} 是当前更贴近 ${sideLabel} 侧筛选条件的候选。`
      : `当前没有满足 Delta 0.10-0.20 / 5%-10% OTM / 关键位外侧条件的 ${sideLabel.toLowerCase()} 候选合约。`;
  const fallbackExpiration = analysisContext.optionChain.expiration_date || '未确认';
  const fallbackRecommendedDte =
    typeof analysisContext.optionChain.recommended_dte === 'number' && Number.isFinite(analysisContext.optionChain.recommended_dte)
      ? String(Math.round(analysisContext.optionChain.recommended_dte))
      : '未确认';
  const fallbackPremium = formatRecommendedPremium(recommendedCandidate);
  const fallbackDistance = formatRecommendedDistance(recommendedCandidate, analysisContext.marketContext.current_price);
  const klineRationale = buildKlineRationale(analysisContext);
  const containsWrongSideBias = (value) => {
    if (typeof value !== 'string') {
      return false;
    }
    const normalized = value.trim();
    if (normalized === '') {
      return false;
    }
    if (optionSide === 'put') {
      return /(?:卖\s*call|sell\s*call|covered\s*call|(?:优先考虑|考虑|选择)\s*\d+(?:\.\d+)?\s*call|call\s+oi\s*(?:峰值|压力位)|call\s*峰值|压力位更安全的call|US\.[A-Z.]+\d{6}C\d+)/iu.test(
        normalized
      );
    }
    return /(?:卖\s*put|sell\s*put|(?:优先考虑|考虑|选择)\s*\d+(?:\.\d+)?\s*put|put\s+oi\s*(?:峰值|支撑位)|put\s*峰值|支撑位更安全的put|US\.[A-Z.]+\d{6}P\d+)/iu.test(
      normalized
    );
  };
  const sanitizeDirectionalText = (value, fallback) => {
    if (typeof value !== 'string') {
      return fallback;
    }
    const normalized = value.trim();
    if (normalized === '' || containsWrongSideBias(normalized)) {
      return fallback;
    }
    return normalized;
  };
  const sanitizeDirectionalWarnings = (warnings) =>
    sanitizeStringList(warnings, 4).filter((warning) => !containsWrongSideBias(warning));

  return {
    verdict:
      typeof parsed.verdict === 'string' && parsed.verdict.trim() !== '' ? parsed.verdict.trim() : '需要谨慎',
    summary: sanitizeDirectionalText(parsed.summary, fallbackSummary),
    recommended_expiration:
      typeof parsed.recommended_expiration === 'string' && parsed.recommended_expiration.trim() !== ''
        ? parsed.recommended_expiration.trim()
        : fallbackExpiration,
    recommended_dte:
      typeof parsed.recommended_dte === 'string' && parsed.recommended_dte.trim() !== ''
        ? parsed.recommended_dte.trim()
        : fallbackRecommendedDte,
    premium_view:
      typeof parsed.premium_view === 'string' && parsed.premium_view.trim() !== ''
        ? parsed.premium_view.trim()
        : 'IV Rank 未完全确认，权利金吸引力需谨慎判断。',
    support_level: supportLevel,
    resistance_level: resistanceLevel,
    recommended_strike:
      typeof parsed.recommended_strike === 'string' && parsed.recommended_strike.trim() !== ''
        ? parsed.recommended_strike.trim()
        : recommendedCandidate
          ? recommendedCandidate.strike.toFixed(2)
          : '暂无合适合约',
    recommended_premium:
      typeof parsed.recommended_premium === 'string' && parsed.recommended_premium.trim() !== ''
        ? parsed.recommended_premium.trim()
        : fallbackPremium,
    recommended_distance:
      typeof parsed.recommended_distance === 'string' && parsed.recommended_distance.trim() !== ''
        ? parsed.recommended_distance.trim()
        : fallbackDistance,
    recommendation_reason: sanitizeDirectionalText(parsed.recommendation_reason, fallbackReason),
    candidate_focus: sanitizeDirectionalText(
      parsed.candidate_focus,
      recommendedCandidate && recommendedCandidate.selectionBasis?.length
        ? `${candidateFallback} 满足 ${recommendedCandidate.selectionBasis.join(' / ')}。`
        : candidateFallback
    ),
    kline_rationale: klineRationale,
    trade_action: sanitizeDirectionalText(parsed.trade_action, fallbackTradeAction),
    key_risks: sanitizeStringList(parsed.key_risks, 3),
    warnings: [...sanitizeDirectionalWarnings(parsed.warnings), ...analysisContext.optionChain.warnings].filter(
      (item, index, list) => list.indexOf(item) === index
    )
  };
}

async function analyzePreTradeWithGemini(payload) {
  const ticker = typeof payload?.ticker === 'string' ? payload.ticker.trim().toUpperCase() : '';
  if (ticker === '') {
    throw new Error('Ticker is required');
  }

  const analysisContext = await buildPreTradeAnalysisContext(payload, ticker);
  return runPreTradeAnalysisWithGemini(payload, analysisContext);
}

async function buildPreTradeAnalysisContext(payload, ticker) {
  const optionSide = payload?.option_side === 'call' ? 'call' : 'put';
  const marketMetrics = await fetchMarketMetrics(ticker);
  const tradeDate =
    typeof payload?.date_sold === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(payload.date_sold.trim())
      ? payload.date_sold.trim()
      : new Date().toISOString().slice(0, 10);
  const recommendedPlan = await fetchRecommendedMoomooOptionPlan(
    ticker,
    optionSide,
    tradeDate,
    marketMetrics.current_price ?? parseNumericValue(payload.current_price)
  );
  const [optionSnapshot, vixResult, vxnResult] = await Promise.all([
    Promise.resolve(recommendedPlan.snapshot),
    fetchLatestOfficialVolatilityIndexDailyClose('VIX').catch(() => null),
    fetchLatestOfficialVolatilityIndexDailyClose('VXN').catch(() => null)
  ]);
  const currentPrice =
    marketMetrics.current_price ??
    parseNumericValue(payload.current_price) ??
    recommendedPlan.klineSnapshot?.rows?.at(-1)?.close ??
    null;
  const optionSummary = recommendedPlan.summary;
  const analysisContext = {
    optionSide,
    marketContext: {
      ...marketMetrics,
      current_price: currentPrice,
      current_price_date: marketMetrics.current_price_date ?? recommendedPlan.klineSnapshot?.endDate ?? null,
      vix: vixResult,
      vxn: vxnResult
    },
    optionChain: {
      underlying: optionSnapshot.underlying,
      expiration_date: optionSnapshot.expirationDate,
      recommended_dte: recommendedPlan.dte,
      total_contracts: optionSnapshot.rows.length,
      support_cluster: optionSummary.supportCluster,
      resistance_cluster: optionSummary.resistanceCluster,
      technical_support: optionSummary.klineLevels?.nearestSupport ?? null,
      technical_resistance: optionSummary.klineLevels?.nearestResistance ?? null,
      kline_as_of: optionSummary.klineLevels?.asOf ?? recommendedPlan.klineSnapshot?.endDate ?? null,
      recommended_candidate: optionSummary.recommendedCandidate,
      candidate_contracts: optionSummary.candidates,
      warnings: optionSummary.warnings
    }
  };

  return analysisContext;
}

async function runPreTradeAnalysisWithGemini(payload, analysisContext) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [{ text: buildPreTradeGeminiPrompt(payload, analysisContext) }]
          }
        ],
        generationConfig: {
          temperature: 0.2
        }
      })
    }
  );

  const data = await readJsonFromResponse(response, 'Gemini pre-trade analysis failed');
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message ?? 'Gemini pre-trade analysis failed');
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text)
      .filter((value) => typeof value === 'string')
      .join('\n')
      .trim() ?? '';

  if (text === '') {
    throw new Error('Gemini returned empty analysis');
  }

  const parsed = parseGeminiJson(text);

  return {
    analysis: buildPreTradeAnalysisPayload(parsed, analysisContext),
    market_context: {
      current_price: analysisContext.marketContext.current_price,
      current_price_date: analysisContext.marketContext.current_price_date,
      current_iv: analysisContext.marketContext.current_iv,
      iv_rank: analysisContext.marketContext.iv_rank,
      next_earnings_date: analysisContext.marketContext.next_earnings_date,
      vix: analysisContext.marketContext.vix,
      vxn: analysisContext.marketContext.vxn
    },
    option_chain: analysisContext.optionChain,
    provider: 'Gemini 2.5 Flash'
  };
}

async function runPreTradeAnalysisWithOpenAI(payload, analysisContext) {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured');
  }

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: OPENAI_PRETRADE_MODEL,
      temperature: 0.2,
      messages: [
        {
          role: 'user',
          content: buildPreTradeGeminiPrompt(payload, analysisContext)
        }
      ]
    })
  });

  const data = await readJsonFromResponse(response, 'OpenAI pre-trade analysis failed');
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message ?? 'OpenAI pre-trade analysis failed');
  }

  const rawContent = data?.choices?.[0]?.message?.content ?? '';
  const text = Array.isArray(rawContent)
    ? rawContent
        .map((part) => (typeof part?.text === 'string' ? part.text : typeof part === 'string' ? part : ''))
        .join('\n')
        .trim()
    : typeof rawContent === 'string'
      ? rawContent.trim()
      : '';

  if (text === '') {
    throw new Error('OpenAI returned empty analysis');
  }

  const parsed = parseGeminiJson(text);
  return {
    analysis: buildPreTradeAnalysisPayload(parsed, analysisContext),
    market_context: {
      current_price: analysisContext.marketContext.current_price,
      current_price_date: analysisContext.marketContext.current_price_date,
      current_iv: analysisContext.marketContext.current_iv,
      iv_rank: analysisContext.marketContext.iv_rank,
      next_earnings_date: analysisContext.marketContext.next_earnings_date,
      vix: analysisContext.marketContext.vix,
      vxn: analysisContext.marketContext.vxn
    },
    option_chain: analysisContext.optionChain,
    provider: `OpenAI ${OPENAI_PRETRADE_MODEL}`
  };
}

async function analyzePreTradeWithLlmFallback(payload) {
  const ticker = typeof payload?.ticker === 'string' ? payload.ticker.trim().toUpperCase() : '';
  if (ticker === '') {
    throw new Error('Ticker is required');
  }

  const analysisContext = await buildPreTradeAnalysisContext(payload, ticker);

  try {
    return await runPreTradeAnalysisWithGemini(payload, analysisContext);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Gemini pre-trade analysis failed';
    if (!isGeminiLimitedErrorMessage(message) || !OPENAI_API_KEY) {
      throw error;
    }

    return runPreTradeAnalysisWithOpenAI(payload, analysisContext);
  }
}

async function fetchMarketDataJson(url, { allowNoData = false } = {}) {
  const timedResponse = await fetchWithTimeout(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${MARKETDATA_TOKEN}`
    }
  });
  const data = await readJsonFromResponse(timedResponse, 'Failed to fetch MarketData.app data');

  if (allowNoData && data?.s === 'no_data') {
    return data;
  }

  if (!timedResponse.ok || data?.s === 'error') {
    throw new Error(data?.errmsg ?? data?.message ?? 'Failed to fetch MarketData.app data');
  }

  return data;
}

function pickIvSample(data) {
  const ivList = Array.isArray(data?.iv) ? data.iv : [];
  const deltaList = Array.isArray(data?.delta) ? data.delta : [];

  let bestSample = null;

  for (let index = 0; index < ivList.length; index += 1) {
    const iv = Number(ivList[index]);
    const delta = Number(deltaList[index]);

    if (!Number.isFinite(iv) || !Number.isFinite(delta) || iv <= 0) {
      continue;
    }

    const deltaDistance = Math.abs(Math.abs(delta) - CURRENT_IV_TARGET_DELTA);
    if (bestSample === null || deltaDistance < bestSample.deltaDistance) {
      bestSample = { iv, deltaDistance };
    }
  }

  return bestSample;
}

async function fetchCurrentIvFromMarketData(symbol) {
  if (!MARKETDATA_TOKEN) {
    throw new Error('MARKETDATA_TOKEN is not configured');
  }

  const providerSymbol = normalizeProviderSymbol(symbol);
  const url = new URL(`https://api.marketdata.app/v1/options/chain/${encodeURIComponent(providerSymbol)}/`);
  url.searchParams.set('side', 'put');
  url.searchParams.set('range', 'otm');
  url.searchParams.set('dte', String(CURRENT_IV_TARGET_DTE));
  url.searchParams.set('strikeLimit', String(CURRENT_IV_STRIKE_LIMIT));

  const data = await fetchMarketDataJson(url);
  const sample = pickIvSample(data);

  if (!sample) {
    throw new Error(`Current IV unavailable for ${symbol}`);
  }

  return sample.iv;
}

async function fetchCurrentIv(symbol) {
  try {
    const barchartSnapshot = await fetchBarchartMarketSnapshot(symbol);
    if (typeof barchartSnapshot.current_iv === 'number' && Number.isFinite(barchartSnapshot.current_iv)) {
      return barchartSnapshot.current_iv;
    }
  } catch {
    // Fall back to MarketData.app.
  }

  return fetchCurrentIvFromMarketData(symbol);
}

async function fetchCurrentStockQuoteFromMarketData(symbol) {
  if (!MARKETDATA_TOKEN) {
    throw new Error('MARKETDATA_TOKEN is not configured');
  }

  const providerSymbol = normalizeProviderSymbol(symbol);
  const url = new URL(`https://api.marketdata.app/v1/stocks/quotes/${encodeURIComponent(providerSymbol)}/`);
  const data = await fetchMarketDataJson(url, { allowNoData: true });

  if (data?.s === 'no_data') {
    throw new Error(`Stock quote unavailable for ${symbol}`);
  }

  const last = Array.isArray(data?.last) ? Number(data.last[0]) : Number.NaN;
  const updated = Array.isArray(data?.updated) ? Number(data.updated[0]) : Number.NaN;

  if (!Number.isFinite(last) || last <= 0) {
    throw new Error(`Invalid MarketData.app stock quote for ${symbol}`);
  }

  return {
    price: last,
    asOf: Number.isFinite(updated) && updated > 0 ? new Date(updated * 1000).toISOString() : null
  };
}

async function fetchNextEarningsDateFromMarketData(symbol) {
  if (!MARKETDATA_TOKEN) {
    throw new Error('MARKETDATA_TOKEN is not configured');
  }

  const providerSymbol = normalizeProviderSymbol(symbol);
  const url = new URL(`https://api.marketdata.app/v1/stocks/earnings/${encodeURIComponent(providerSymbol)}/`);
  url.searchParams.set('from', new Date().toISOString().slice(0, 10));
  url.searchParams.set('countback', '1');

  const data = await fetchMarketDataJson(url, { allowNoData: true });
  if (data?.s === 'no_data') {
    return null;
  }

  const reportDates = Array.isArray(data?.reportDate) ? data.reportDate : Array.isArray(data?.date) ? data.date : [];
  if (reportDates.length === 0 || typeof reportDates[0] !== 'string') {
    return null;
  }

  const date = reportDates[0].trim();
  return date === '' ? null : date.slice(0, 10);
}

const OPTION_SNAPSHOT_DELTA_TARGETS = [0.20, 0.30, 0.50];
const OPTION_SNAPSHOT_SIDES = ['put', 'call'];

/**
 * Fetch option snapshots for a single ticker from moomoo.
 * Finds the expiration closest to DTE 45 and returns rows for each
 * combination of side × delta_target (0.20, 0.30, 0.50).
 *
 * @param {string} ticker  Underlying symbol, e.g. 'AAPL'.
 * @param {number|null} currentPrice  Current stock price (used for OTM pct).
 * @returns {Promise<Array<object>>}  Rows ready for writeOptionDailySnapshot.
 */
async function fetchOptionSnapshotForTicker(ticker, currentPrice = null) {
  const tradeDate = new Date().toISOString().slice(0, 10);

  // 1. Get available expirations and pick the one closest to DTE 45.
  const expirationPayload = await fetchMoomooOptionExpirations(ticker);
  const ranked = rankExpirationCandidates(expirationPayload.expirations, tradeDate);
  if (ranked.length === 0) {
    throw new Error(`No future expirations available for ${ticker}`);
  }
  const best = ranked[0];

  // 2. Fetch option chain snapshot for that expiration.
  const chainSnapshot = await fetchMoomooOptionChainSnapshot(ticker, best.expirationDate);
  const rows = chainSnapshot.rows; // normalizeSnapshotRow already applied

  // 3. For each side × delta_target, find the closest-delta contract.
  const result = [];
  for (const side of OPTION_SNAPSHOT_SIDES) {
    const sideRows = rows.filter((row) => row.side === side);
    if (sideRows.length === 0) {
      continue;
    }

    for (const deltaTarget of OPTION_SNAPSHOT_DELTA_TARGETS) {
      // delta on puts is negative, use abs value for comparison.
      const withDeltaAbs = sideRows
        .filter((row) => row.delta !== null)
        .map((row) => ({
          ...row,
          _deltaAbs: Math.abs(row.delta ?? 0)
        }));
      if (withDeltaAbs.length === 0) {
        continue;
      }

      // Sort by closest delta, then by highest OI for ties.
      withDeltaAbs.sort((a, b) => {
        const distA = Math.abs(a._deltaAbs - deltaTarget);
        const distB = Math.abs(b._deltaAbs - deltaTarget);
        if (distA !== distB) {
          return distA - distB;
        }
        return (b.openInterest ?? 0) - (a.openInterest ?? 0);
      });

      const contract = withDeltaAbs[0];
      const bid = contract.bid ?? null;
      const ask = contract.ask ?? null;
      const midPrice = bid !== null && ask !== null ? (bid + ask) / 2 : contract.price ?? null;

      result.push({
        side,
        deltaTarget,
        expirationDate: best.expirationDate,
        dte: best.dte,
        strike: contract.strike,
        delta: contract.delta,
        deltaAbs: contract._deltaAbs,
        gamma: contract.gamma,
        theta: contract.theta,
        impliedVolatility: contract.impliedVolatility,
        bid,
        ask,
        lastPrice: contract.lastPrice,
        midPrice,
        openInterest: contract.openInterest,
        volume: contract.volume,
        spreadPct: contract.spreadPct,
        code: contract.code
      });
    }
  }

  return result;
}

async function fetchMarketMetrics(symbol) {
  const referenceDate = new Date();
  const metrics = {
    symbol,
    current_price: null,
    current_price_date: null,
    next_earnings_date: null,
    earnings_time_code: null,
    current_iv: null,
    historical_iv: null,
    iv_rank: null,
    iv_percentile: null,
    put_call_ratio: null,
    source: {
      current_price: null,
      next_earnings_date: null,
      current_iv: null,
      historical_iv: null,
      iv_rank: null,
      iv_percentile: null,
      put_call_ratio: null
    }
  };

  try {
    const barchartSnapshot = await fetchBarchartMarketSnapshot(symbol);
    if (typeof barchartSnapshot.current_price === 'number' && Number.isFinite(barchartSnapshot.current_price)) {
      metrics.current_price = barchartSnapshot.current_price;
      metrics.current_price_date = barchartSnapshot.current_price_date;
      metrics.source.current_price = barchartSnapshot.source ?? 'Barchart';
    }
    if (
      typeof barchartSnapshot.next_earnings_date === 'string' &&
      barchartSnapshot.next_earnings_date !== '' &&
      isFutureOrTodayDate(barchartSnapshot.next_earnings_date, referenceDate)
    ) {
      metrics.next_earnings_date = barchartSnapshot.next_earnings_date;
      metrics.earnings_time_code = barchartSnapshot.earnings_time_code;
      metrics.source.next_earnings_date = barchartSnapshot.source ?? 'Barchart';
    }
    if (typeof barchartSnapshot.current_iv === 'number' && Number.isFinite(barchartSnapshot.current_iv)) {
      metrics.current_iv = barchartSnapshot.current_iv;
      metrics.source.current_iv = barchartSnapshot.source ?? 'Barchart';
    }
    if (typeof barchartSnapshot.historical_iv === 'number' && Number.isFinite(barchartSnapshot.historical_iv)) {
      metrics.historical_iv = barchartSnapshot.historical_iv;
      metrics.source.historical_iv = barchartSnapshot.source ?? 'Barchart';
    }
    if (typeof barchartSnapshot.iv_rank === 'number' && Number.isFinite(barchartSnapshot.iv_rank)) {
      metrics.iv_rank = barchartSnapshot.iv_rank;
      metrics.source.iv_rank = barchartSnapshot.source ?? 'Barchart';
    }
    if (typeof barchartSnapshot.iv_percentile === 'number' && Number.isFinite(barchartSnapshot.iv_percentile)) {
      metrics.iv_percentile = barchartSnapshot.iv_percentile;
      metrics.source.iv_percentile = barchartSnapshot.source ?? 'Barchart';
    }
    if (typeof barchartSnapshot.put_call_ratio === 'number' && Number.isFinite(barchartSnapshot.put_call_ratio)) {
      metrics.put_call_ratio = barchartSnapshot.put_call_ratio;
      metrics.source.put_call_ratio = barchartSnapshot.source ?? 'Barchart';
    }
  } catch {
    // Fall back field-by-field below.
  }

  if (metrics.current_price === null) {
    try {
      const quote = await fetchCurrentStockQuoteFromMarketData(symbol);
      metrics.current_price = quote.price;
      metrics.current_price_date = quote.asOf;
      metrics.source.current_price = 'MarketData.app /stocks/quotes';
    } catch {
      // Leave empty.
    }
  }

  if (metrics.next_earnings_date === null) {
    try {
      const earningsDate = await fetchNextEarningsDateFromMarketData(symbol);
      if (earningsDate && isFutureOrTodayDate(earningsDate, referenceDate)) {
        metrics.next_earnings_date = earningsDate;
        metrics.source.next_earnings_date = 'MarketData.app /stocks/earnings';
      }
    } catch {
      // Leave empty.
    }
  }

  if (metrics.next_earnings_date === null) {
    try {
      const finvizSnapshot = await fetchFinvizTechnicalSnapshot(symbol);
      if (
        typeof finvizSnapshot.earnings?.next_earnings_date === 'string' &&
        finvizSnapshot.earnings.next_earnings_date !== '' &&
        isFutureOrTodayDate(finvizSnapshot.earnings.next_earnings_date, referenceDate)
      ) {
        metrics.next_earnings_date = finvizSnapshot.earnings.next_earnings_date;
        metrics.earnings_time_code =
          typeof finvizSnapshot.earnings.earnings_time_code === 'string' && finvizSnapshot.earnings.earnings_time_code !== ''
            ? finvizSnapshot.earnings.earnings_time_code
            : metrics.earnings_time_code;
        metrics.source.next_earnings_date = 'Finviz HTML';
      }
    } catch {
      // Leave empty.
    }
  }

  if (metrics.current_iv === null) {
    try {
      metrics.current_iv = await fetchCurrentIvFromMarketData(symbol);
      metrics.source.current_iv = 'MarketData.app /options/chain';
    } catch {
      // Leave empty.
    }
  }

  if (metrics.put_call_ratio === null) {
    try {
      const putCallRatio = await fetchPutCallRatio(symbol);
      metrics.put_call_ratio = putCallRatio.value;
      metrics.source.put_call_ratio = putCallRatio.source;
    } catch {
      // Leave empty.
    }
  }

  return metrics;
}

export async function fetchCurrentOptionQuote(symbol, expirationDate, strike, side = 'put') {
  try {
    return await fetchMoomooOptionQuote(symbol, expirationDate, strike, side);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
  }

  try {
    return await fetchBarchartOptionQuote(symbol, expirationDate, strike, side);
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
  }

  if (!MARKETDATA_TOKEN) {
    throw new Error('MARKETDATA_TOKEN is not configured');
  }

  const optionSymbol = formatOptionSymbol(symbol, expirationDate, strike, side);

  try {
    const quoteUrl = new URL(`https://api.marketdata.app/v1/options/quotes/${encodeURIComponent(optionSymbol)}/`);
    const quoteData = await fetchMarketDataJson(quoteUrl, { allowNoData: true });

    if (quoteData?.s !== 'no_data') {
      const snapshotQuote = extractOptionQuoteFromSnapshot(quoteData);
      if (snapshotQuote) {
        return {
          ...snapshotQuote,
          source: 'MarketData.app /options/quotes'
        };
      }
    }
  } catch (error) {
    if (!(error instanceof Error)) {
      throw error;
    }
  }

  const url = new URL(`https://api.marketdata.app/v1/options/chain/${encodeURIComponent(symbol)}/`);
  url.searchParams.set('expiration', expirationDate);
  url.searchParams.set('side', side);

  const data = await fetchMarketDataJson(url, { allowNoData: true });
  let sample = extractOptionQuoteFromChain(data, strike);

  if (!sample) {
    const fallbackUrl = new URL(`https://api.marketdata.app/v1/options/chain/${encodeURIComponent(symbol)}/`);
    fallbackUrl.searchParams.set('side', side);
    const fallbackData = await fetchMarketDataJson(fallbackUrl, { allowNoData: true });

    if (fallbackData?.s !== 'no_data') {
      const optionSymbols = Array.isArray(fallbackData?.optionSymbol) ? fallbackData.optionSymbol : [];
      const exactIndex = optionSymbols.findIndex((value) => String(value) === optionSymbol);

      if (exactIndex !== -1) {
        sample = extractOptionQuoteFromChain(
          {
            strike: [fallbackData?.strike?.[exactIndex]],
            bid: [fallbackData?.bid?.[exactIndex]],
            ask: [fallbackData?.ask?.[exactIndex]],
            mid: [fallbackData?.mid?.[exactIndex]],
            last: [fallbackData?.last?.[exactIndex]],
            theta: [fallbackData?.theta?.[exactIndex]],
            delta: [fallbackData?.delta?.[exactIndex]],
            gamma: [fallbackData?.gamma?.[exactIndex]]
          },
          strike
        );
      }
    }
  }

  if (!sample) {
    throw new Error(
      `${symbol} ${expirationDate} ${strike} ${side} 在当前 MarketData.app 延迟期权数据里暂无可用报价`
    );
  }

  return {
    price: sample.price,
    theta: sample.theta,
    delta: sample.delta,
    gamma: sample.gamma,
    source: 'MarketData.app /options/chain'
  };
}

async function fetchPutCallRatio(symbol) {
  try {
    const barchartSnapshot = await fetchBarchartMarketSnapshot(symbol);
    if (typeof barchartSnapshot.put_call_ratio === 'number' && Number.isFinite(barchartSnapshot.put_call_ratio)) {
      return {
        value: barchartSnapshot.put_call_ratio,
        source: 'Barchart quotes/get'
      };
    }
  } catch {
    // Fall back to MarketData.app.
  }

  if (!MARKETDATA_TOKEN) {
    throw new Error('MARKETDATA_TOKEN is not configured');
  }

  const fetchOpenInterestTotal = async (side) => {
    const providerSymbol = normalizeProviderSymbol(symbol);
    const url = new URL(`https://api.marketdata.app/v1/options/chain/${encodeURIComponent(providerSymbol)}/`);
    url.searchParams.set('expiration', 'all');
    url.searchParams.set('side', side);

    const data = await fetchMarketDataJson(url);
    const openInterestList = Array.isArray(data?.openInterest) ? data.openInterest : [];

    return openInterestList.reduce((sum, value) => {
      const numeric = Number(value);
      return Number.isFinite(numeric) ? sum + numeric : sum;
    }, 0);
  };

  const putOpenInterest = await fetchOpenInterestTotal('put');
  const callOpenInterest = await fetchOpenInterestTotal('call');

  if (callOpenInterest <= 0) {
    throw new Error(`Put-Call Ratio unavailable for ${symbol}`);
  }

  return {
    value: putOpenInterest / callOpenInterest,
    source: 'MarketData.app /options/chain'
  };
}

function normalizeQuoteRequest(item) {
  if (typeof item === 'string') {
    return {
      symbol: item.trim().toUpperCase(),
      exchange: null,
      mic_code: null,
      include_rsi: undefined,
      include_ma: undefined,
      include_current_iv: undefined,
      include_market_metrics: undefined
    };
  }

  if (typeof item === 'object' && item !== null) {
    return {
      symbol: typeof item.symbol === 'string' ? item.symbol.trim().toUpperCase() : '',
      exchange: typeof item.exchange === 'string' && item.exchange.trim() !== '' ? item.exchange.trim().toUpperCase() : null,
      mic_code: typeof item.mic_code === 'string' && item.mic_code.trim() !== '' ? item.mic_code.trim().toUpperCase() : null,
      include_rsi: typeof item.include_rsi === 'boolean' ? item.include_rsi : undefined,
      include_ma: typeof item.include_ma === 'boolean' ? item.include_ma : undefined,
      include_current_iv: typeof item.include_current_iv === 'boolean' ? item.include_current_iv : undefined,
      include_market_metrics: typeof item.include_market_metrics === 'boolean' ? item.include_market_metrics : undefined
    };
  }

  return {
    symbol: '',
    exchange: null,
    mic_code: null,
    include_rsi: undefined,
    include_ma: undefined,
    include_current_iv: undefined,
    include_market_metrics: undefined
  };
}

async function fetchLatestOfficialVixDailyClose() {
  const snapshot = await fetchLatestOfficialVolatilityIndexDailyClose('VIX');
  return {
    value: snapshot.value,
    asOf: snapshot.asOf
  };
}

function getSetCookieValues(headers) {
  if (!headers) {
    return [];
  }

  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie();
  }

  const singleHeader = headers.get?.('set-cookie');
  if (typeof singleHeader !== 'string' || singleHeader.trim() === '') {
    return [];
  }

  return singleHeader
    .split(/,(?=[^;,=\s]+=[^;,]+)/u)
    .map((value) => value.trim())
    .filter(Boolean);
}

export function buildCookieHeaderFromSetCookie(setCookieValues) {
  if (!Array.isArray(setCookieValues) || setCookieValues.length === 0) {
    return '';
  }

  return setCookieValues
    .map((value) => (typeof value === 'string' ? value.split(';', 1)[0].trim() : ''))
    .filter(Boolean)
    .join('; ');
}

async function fetchFearGreedGraphData(init = {}) {
  const response = await fetchWithTimeout('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    ...init,
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      Origin: 'https://www.cnn.com',
      Referer: 'https://www.cnn.com/',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      ...(init.headers ?? {})
    }
  });
  const data = await readJsonFromResponse(response, 'Failed to fetch CNN Fear & Greed Index');

  if (!response.ok || !data?.fear_and_greed || typeof data.fear_and_greed.score !== 'number') {
    throw new Error('Failed to fetch CNN Fear & Greed Index');
  }

  return data;
}

async function fetchFearGreedIndex() {
  try {
    const pageResponse = await fetchWithTimeout('https://www.cnn.com/markets/fear-and-greed', {
      headers: {
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
      }
    });
    const cookieHeader = buildCookieHeaderFromSetCookie(getSetCookieValues(pageResponse.headers));
    const data = await fetchFearGreedGraphData(
      cookieHeader
        ? {
            headers: {
              Cookie: cookieHeader
            }
          }
        : {}
    );

    return {
      score: data.fear_and_greed.score,
      rating: typeof data.fear_and_greed.rating === 'string' ? data.fear_and_greed.rating : ''
    };
  } catch (sessionError) {
    const data = await fetchFearGreedGraphData();
    const sessionMessage =
      sessionError instanceof Error ? sessionError.message : 'Failed to fetch CNN Fear & Greed Index';

    return {
      score: data.fear_and_greed.score,
      rating: typeof data.fear_and_greed.rating === 'string' ? data.fear_and_greed.rating : '',
      sessionMessage
    };
  }
}

async function fetchQuote(requestItem) {
  try {
    const moomooQuote = await fetchMoomooStockQuote(getMoomooUnderlying(requestItem.symbol));
    return {
      symbol: requestItem.symbol,
      ok: true,
      price: moomooQuote.last_price,
      as_of: new Date().toISOString(),
      source: 'Moomoo API'
    };
  } catch {
    // Fall back to Barchart quick quote
  }

  try {
    const quickQuote = await fetchBarchartQuickQuote(requestItem.symbol);
    return {
      symbol: requestItem.symbol,
      ok: true,
      price: quickQuote.price,
      as_of: quickQuote.asOf,
      source: quickQuote.source
    };
  } catch {
    // Fall back to MarketData.app / TwelveData.
  }

  try {
    const marketDataQuote = await fetchCurrentStockQuoteFromMarketData(requestItem.symbol);
    return {
      symbol: requestItem.symbol,
      ok: true,
      price: marketDataQuote.price,
      as_of: marketDataQuote.asOf,
      source: 'MarketData.app /stocks/quotes'
    };
  } catch {
    // Fall back to TwelveData.
  }

  const providerSymbol = normalizeProviderSymbol(requestItem.symbol);
  const url = new URL('https://api.twelvedata.com/price');
  url.searchParams.set('symbol', providerSymbol);
  if (requestItem.exchange) {
    url.searchParams.set('exchange', requestItem.exchange);
  }
  if (requestItem.mic_code) {
    url.searchParams.set('mic_code', requestItem.mic_code);
  }
  url.searchParams.set('apikey', API_KEY);

  const response = await fetchWithTimeout(url);
  const data = await readJsonFromResponse(response, 'Failed to fetch TwelveData price');

  if (!response.ok || data?.status === 'error' || typeof data?.price !== 'string') {
    return {
      symbol: requestItem.symbol,
      exchange: requestItem.exchange,
      mic_code: requestItem.mic_code,
      ok: false,
      message: data?.message ?? 'Failed to fetch price'
    };
  }

  const price = Number(data.price);
  if (!Number.isFinite(price)) {
    return {
      symbol: requestItem.symbol,
      exchange: requestItem.exchange,
      mic_code: requestItem.mic_code,
      ok: false,
      message: 'Invalid price payload'
    };
  }

  return {
    symbol: requestItem.symbol,
    ok: true,
    price,
    source: 'TwelveData /price'
  };
}

async function fetchRsi(requestItem, interval = '1day') {
  if (interval === '1day') {
    try {
      const moomooKlinePayload = await fetchMoomooKline(getMoomooUnderlying(requestItem.symbol), '1d', 100);
      const rows = extractMoomooKlineRows(moomooKlinePayload);
      const closes = rows.map(r => r.close);
      const rsi = calculateRsi(closes, 14);

      if (typeof rsi === 'number' && Number.isFinite(rsi)) {
        return {
          symbol: requestItem.symbol,
          ok: true,
          rsi,
          interval,
          source: 'Moomoo 1D Kline'
        };
      }
    } catch {
      // Fall through to Finviz API backed sources below
    }

    try {
      const finvizSnapshot = await fetchFinvizTechnicalSnapshot(requestItem.symbol);
      const rsi = calculateRsi(finvizSnapshot.closes, 14);

      if (typeof rsi === 'number' && Number.isFinite(rsi)) {
        return {
          symbol: requestItem.symbol,
          ok: true,
          rsi,
          interval,
          source: finvizSnapshot.source
        };
      }
    } catch {
      // Fall through to API-backed sources below.
    }
  } else if (interval === '1h') {
    try {
      const moomooKlinePayload = await fetchMoomooKline(getMoomooUnderlying(requestItem.symbol), '60m', 80);
      const rows = extractMoomooKlineRows(moomooKlinePayload);
      const closes = rows.map(r => r.close);
      const rsi = calculateRsi(closes, 14);

      if (typeof rsi === 'number' && Number.isFinite(rsi)) {
        return {
          symbol: requestItem.symbol,
          ok: true,
          rsi,
          interval,
          source: 'Moomoo 60m Kline'
        };
      }
    } catch {
      // Fall through to API-backed sources below
    }
  }

  try {
    const marketDataInterval = interval === '1h' ? '1H' : 'D';
    const countback = interval === '1h' ? 80 : 100;
    const from = interval === '1h' ? '10daysago' : '1yearago';
    const to = interval === '1h' ? 'now' : 'today';
    const closes = await fetchMarketDataCandlesCloses(requestItem.symbol, marketDataInterval, { from, to, countback });
    const rsi = calculateRsi(closes, 14);

    if (typeof rsi === 'number' && Number.isFinite(rsi)) {
      return {
        symbol: requestItem.symbol,
        ok: true,
        rsi,
        interval
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (isMarketDataQuotaErrorMessage(message)) {
      return {
        symbol: requestItem.symbol,
        ok: false,
        message
      };
    }
  }

  try {
    const providerSymbol = normalizeProviderSymbol(requestItem.symbol);
    const url = new URL('https://api.twelvedata.com/rsi');
    url.searchParams.set('symbol', providerSymbol);
    url.searchParams.set('interval', interval);
    url.searchParams.set('time_period', '14');
    url.searchParams.set('series_type', 'close');
    url.searchParams.set('outputsize', '1');
    if (requestItem.exchange) {
      url.searchParams.set('exchange', requestItem.exchange);
    }
    if (requestItem.mic_code) {
      url.searchParams.set('mic_code', requestItem.mic_code);
    }
    url.searchParams.set('apikey', API_KEY);

    const response = await fetchWithTimeout(url);
    const data = await readJsonFromResponse(response, `Failed to fetch RSI (${interval})`);
    const rawValue = Array.isArray(data?.values) && data.values.length > 0 ? data.values[0]?.rsi : null;

    if (!response.ok || data?.status === 'error' || typeof rawValue !== 'string') {
      return {
        symbol: requestItem.symbol,
        ok: false,
        message: data?.message ?? `Failed to fetch RSI (${interval})`
      };
    }

    const rsi = Number(rawValue);
    if (!Number.isFinite(rsi)) {
      return {
        symbol: requestItem.symbol,
        ok: false,
        message: `Invalid RSI payload (${interval})`
      };
    }

    return {
      symbol: requestItem.symbol,
      ok: true,
      rsi,
      interval
    };
  } catch (error) {
    return {
      symbol: requestItem.symbol,
      ok: false,
      message: error instanceof Error ? error.message : `Failed to fetch RSI (${interval})`
    };
  }
}

async function fetchSma(requestItem, timePeriod) {
  try {
    const moomooKlinePayload = await fetchMoomooKline(getMoomooUnderlying(requestItem.symbol), '1d', Math.max(timePeriod + 20, 240));
    const rows = extractMoomooKlineRows(moomooKlinePayload);
    const closes = rows.map(r => r.close);
    const sma = calculateSma(closes, timePeriod);

    if (typeof sma === 'number' && Number.isFinite(sma)) {
      return {
        symbol: requestItem.symbol,
        ok: true,
        sma,
        source: 'Moomoo 1D Kline'
      };
    }
  } catch {
    // Fall through to Finviz API backed sources below
  }

  try {
    const finvizSnapshot = await fetchFinvizTechnicalSnapshot(requestItem.symbol);
    const sma = calculateSma(finvizSnapshot.closes, timePeriod);

    if (typeof sma === 'number' && Number.isFinite(sma)) {
      return {
        symbol: requestItem.symbol,
        ok: true,
        sma,
        source: finvizSnapshot.source
      };
    }
  } catch {
    // Fall through to API-backed sources below.
  }

  try {
    const closes = await fetchMarketDataCandlesCloses(requestItem.symbol, 'D', {
      from: '2yearsago',
      to: 'today',
      countback: Math.max(timePeriod + 20, 240)
    });
    const sma = calculateSma(closes, timePeriod);

    if (typeof sma === 'number' && Number.isFinite(sma)) {
      return {
        symbol: requestItem.symbol,
        ok: true,
        sma
      };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (isMarketDataQuotaErrorMessage(message)) {
      return {
        symbol: requestItem.symbol,
        ok: false,
        message
      };
    }
  }

  try {
    const providerSymbol = normalizeProviderSymbol(requestItem.symbol);
    const url = new URL('https://api.twelvedata.com/sma');
    url.searchParams.set('symbol', providerSymbol);
    url.searchParams.set('interval', '1day');
    url.searchParams.set('time_period', String(timePeriod));
    url.searchParams.set('series_type', 'close');
    url.searchParams.set('outputsize', '1');
    if (requestItem.exchange) {
      url.searchParams.set('exchange', requestItem.exchange);
    }
    if (requestItem.mic_code) {
      url.searchParams.set('mic_code', requestItem.mic_code);
    }
    url.searchParams.set('apikey', API_KEY);

    const response = await fetchWithTimeout(url);
    const data = await readJsonFromResponse(response, `Failed to fetch SMA${timePeriod}`);
    const rawValue = Array.isArray(data?.values) && data.values.length > 0 ? data.values[0]?.sma : null;

    if (!response.ok || data?.status === 'error' || typeof rawValue !== 'string') {
      return {
        symbol: requestItem.symbol,
        ok: false,
        message: data?.message ?? `Failed to fetch SMA${timePeriod}`
      };
    }

    const sma = Number(rawValue);
    if (!Number.isFinite(sma)) {
      return {
        symbol: requestItem.symbol,
        ok: false,
        message: `Invalid SMA${timePeriod} payload`
      };
    }

    return {
      symbol: requestItem.symbol,
      ok: true,
      sma
    };
  } catch (error) {
    return {
      symbol: requestItem.symbol,
      ok: false,
      message: error instanceof Error ? error.message : `Failed to fetch SMA${timePeriod}`
    };
  }
}

async function fetchAtr(requestItem, period = 14) {
  try {
    const moomooKlinePayload = await fetchMoomooKline(getMoomooUnderlying(requestItem.symbol), '1d', Math.max(period + 30, 60));
    const rows = extractMoomooKlineRows(moomooKlinePayload);
    const atr = calculateAtr(rows, period);

    if (typeof atr === 'number' && Number.isFinite(atr)) {
      return {
        symbol: requestItem.symbol,
        ok: true,
        atr,
        period,
        source: 'Moomoo 1D Kline'
      };
    }
  } catch {
    // Fall through to MarketData.app candles
  }

  try {
    const url = new URL(`https://api.marketdata.app/v1/stocks/candles/D/${encodeURIComponent(normalizeProviderSymbol(requestItem.symbol))}/`);
    url.searchParams.set('from', '3monthsago');
    url.searchParams.set('to', 'today');
    url.searchParams.set('countback', String(Math.max(period + 30, 60)));
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Token ${MARKETDATA_TOKEN}` }
    });
    if (response.ok) {
      const data = await readJsonFromResponse(response, 'MarketData candles for ATR');
      if (data?.s === 'ok' && Array.isArray(data.h) && Array.isArray(data.l) && Array.isArray(data.c)) {
        const rows = data.c.map((close, i) => ({
          high: data.h[i],
          low: data.l[i],
          close
        }));
        const atr = calculateAtr(rows, period);
        if (typeof atr === 'number' && Number.isFinite(atr)) {
          return {
            symbol: requestItem.symbol,
            ok: true,
            atr,
            period,
            source: 'MarketData.app candles'
          };
        }
      }
    }
  } catch {
    // Fall through
  }

  return {
    symbol: requestItem.symbol,
    ok: false,
    message: `Failed to fetch ATR(${period})`
  };
}

async function fetchMarketDataCandlesCloses(symbol, resolution, { from, to, countback }) {
  if (!MARKETDATA_TOKEN) {
    throw new Error('MARKETDATA_TOKEN is not configured');
  }

  const providerSymbol = normalizeProviderSymbol(symbol);
  const url = new URL(`https://api.marketdata.app/v1/stocks/candles/${resolution}/${encodeURIComponent(providerSymbol)}/`);
  if (from) {
    url.searchParams.set('from', from);
  }
  if (to) {
    url.searchParams.set('to', to);
  }
  if (countback) {
    url.searchParams.set('countback', String(countback));
  }

  const response = await fetchWithTimeout(url, {
    headers: {
      Authorization: `Token ${MARKETDATA_TOKEN}`
    }
  });
  const data = await readJsonFromResponse(response, `Failed to fetch MarketData candles (${resolution})`);

  if (!response.ok || data?.s !== 'ok') {
    throw new Error(data?.errmsg ?? data?.error ?? `Failed to fetch MarketData candles (${resolution})`);
  }

  const closes = extractCloseSeries(data);
  if (closes.length === 0) {
    throw new Error(`Empty MarketData candles payload (${resolution})`);
  }

  return closes;
}

async function fetchQuoteBundle(requestItem) {
  const includeRsi = requestItem.include_rsi !== false;
  const includeMa = requestItem.include_ma !== false;
  const includeCurrentIv = requestItem.include_current_iv !== false;
  const includeMarketMetrics = requestItem.include_market_metrics === true;
  const quoteResult = await fetchQuote(requestItem);
  let rsiResult;
  let rsi1hResult;
  if (!includeRsi) {
    rsiResult = {
      symbol: requestItem.symbol,
      ok: true,
      skipped: true
    };
    rsi1hResult = {
      symbol: requestItem.symbol,
      ok: true,
      skipped: true
    };
  } else {
    await sleep(REQUEST_GAP_MS);
    rsiResult = await fetchRsi(requestItem, '1day');
    await sleep(REQUEST_GAP_MS);
    rsi1hResult = await fetchRsi(requestItem, '1h');
  }

  let ma21Result;
  let ma200Result;
  if (!includeMa) {
    ma21Result = {
      symbol: requestItem.symbol,
      ok: true,
      skipped: true
    };
    ma200Result = {
      symbol: requestItem.symbol,
      ok: true,
      skipped: true
    };
  } else {
    await sleep(REQUEST_GAP_MS);
    ma21Result = await fetchSma(requestItem, 21);
    await sleep(REQUEST_GAP_MS);
    ma200Result = await fetchSma(requestItem, 200);
  }

  let atrResult;
  if (!includeMa) {
    atrResult = { symbol: requestItem.symbol, ok: true, skipped: true };
  } else {
    await sleep(REQUEST_GAP_MS);
    atrResult = await fetchAtr(requestItem, 14);
  }

  let currentIvResult;
  if (!includeCurrentIv) {
    currentIvResult = {
      symbol: requestItem.symbol,
      ok: true,
      skipped: true
    };
  } else {
    await sleep(REQUEST_GAP_MS);
    try {
      const currentIv = await fetchCurrentIv(requestItem.symbol);
      currentIvResult = {
        symbol: requestItem.symbol,
        ok: true,
        currentIv
      };
    } catch (error) {
      currentIvResult = {
        symbol: requestItem.symbol,
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to fetch Current IV'
      };
    }
  }

  let marketMetricsResult;
  if (!includeMarketMetrics) {
    marketMetricsResult = {
      symbol: requestItem.symbol,
      ok: true,
      skipped: true
    };
  } else {
    await sleep(REQUEST_GAP_MS);
    try {
      const marketMetrics = await fetchMarketMetrics(requestItem.symbol);
      marketMetricsResult = {
        symbol: requestItem.symbol,
        ok: true,
        marketMetrics
      };
    } catch (error) {
      marketMetricsResult = {
        symbol: requestItem.symbol,
        ok: false,
        message: error instanceof Error ? error.message : 'Failed to fetch market metrics'
      };
    }
  }
  return {
    quoteResult,
    rsiResult,
    rsi1hResult,
    ma21Result,
    ma200Result,
    atrResult,
    currentIvResult,
    marketMetricsResult
  };
}

async function computeVixSnapshot() {
  const todayKey = getDateKey();
  const cached = await loadVixCache();
  const storageTarget = describeStorageTarget();
  let vixValue = cached && cached.fetched_on === todayKey && typeof cached.value === 'number' ? cached.value : null;
  let vixAsOf = cached && typeof cached.as_of === 'string' ? cached.as_of : null;

  if (vixValue === null || vixAsOf === null || cached?.fetched_on !== todayKey) {
    const dailyClose = await fetchLatestOfficialVixDailyClose();
    vixValue = dailyClose.value;
    vixAsOf = dailyClose.asOf;
  }

  let fearGreedScore =
    cached && typeof cached.fear_greed_score === 'number' ? cached.fear_greed_score : null;
  let fearGreedRating =
    cached && typeof cached.fear_greed_rating === 'string' ? cached.fear_greed_rating : null;
  let fearGreedFetchedAt =
    cached && typeof cached.fear_greed_fetched_at === 'string' ? cached.fear_greed_fetched_at : null;
  let fearGreedStatus =
    fearGreedScore !== null && fearGreedFetchedAt && isFreshTimestamp(fearGreedFetchedAt, FEAR_GREED_CACHE_MS)
      ? 'cached'
      : fearGreedScore !== null
        ? 'stale-cache'
        : 'no-cache';
  let fearGreedError = null;

  if (!isFreshTimestamp(fearGreedFetchedAt, FEAR_GREED_CACHE_MS)) {
    try {
      const fetchedFearGreed = await fetchFearGreedIndex();
      fearGreedScore = fetchedFearGreed.score;
      fearGreedRating = fetchedFearGreed.rating;
      fearGreedFetchedAt = new Date().toISOString();
      fearGreedStatus = 'fetched-live';
    } catch (error) {
      fearGreedError = error instanceof Error ? error.message : 'Failed to fetch CNN Fear & Greed Index';
      fearGreedStatus = fearGreedScore !== null ? 'fetch-failed-used-cache' : 'fetch-failed-no-cache';
    }
  }

  let cacheWriteOk = true;
  let cacheWriteError = null;
  try {
    await saveVixCache({
      fetched_on: todayKey,
      value: vixValue,
      as_of: vixAsOf,
      fear_greed_score: fearGreedScore,
      fear_greed_rating: fearGreedRating,
      fear_greed_fetched_at: fearGreedFetchedAt
    });
  } catch (error) {
    cacheWriteOk = false;
    cacheWriteError = error instanceof Error ? error.message : 'Failed to save VIX cache';
  }

  return {
    value: vixValue,
    as_of: vixAsOf,
    source: 'Cboe official daily close',
    cached: true,
    fear_greed_score: fearGreedScore,
    fear_greed_rating: fearGreedRating,
    fear_greed_status: fearGreedStatus,
    fear_greed_error: fearGreedError,
    storage_driver: storageTarget.driver,
    cache_write_ok: cacheWriteOk,
    cache_write_error: cacheWriteError
  };
}

function coerceSnapshot(snapshot, now = new Date()) {
  const exportedAt = now.toISOString();
  const data = typeof snapshot?.data === 'object' && snapshot.data !== null ? snapshot.data : {};
  const closedTrades = Array.isArray(data.closedTrades)
    ? data.closedTrades
    : Array.isArray(data.history)
      ? data.history
      : [];

  return {
    version: 1,
    exported_at: typeof snapshot?.exported_at === 'string' ? snapshot.exported_at : exportedAt,
    data: {
      config: data.config ?? null,
      puts: Array.isArray(data.puts) ? data.puts : [],
      closedTrades,
      stockTrades: Array.isArray(data.stockTrades) ? data.stockTrades : [],
      tickerList: Array.isArray(data.tickerList) ? data.tickerList : [],
      scenario: data.scenario ?? null,
      vixHistory: Array.isArray(data.vixHistory) ? data.vixHistory : [],
      accountValueHistory: Array.isArray(data.accountValueHistory) ? data.accountValueHistory : []
    }
  };
}

function computeSnapshotAccountEquity(snapshotData) {
  const cash = typeof snapshotData?.config?.cash === 'number' ? snapshotData.config.cash : 0;
  const stockValue = Array.isArray(snapshotData?.tickerList)
    ? snapshotData.tickerList.reduce((sum, entry) => {
        const shares = typeof entry?.shares === 'number' ? entry.shares : 0;
        const currentPrice = typeof entry?.current_price === 'number' ? entry.current_price : 0;
        return sum + shares * currentPrice;
      }, 0)
    : 0;
  const unrealizedOptionPnl = Array.isArray(snapshotData?.puts)
    ? snapshotData.puts.reduce((sum, position) => {
        const premiumPerShare = typeof position?.premium_per_share === 'number' ? position.premium_per_share : 0;
        const marketPrice =
          typeof position?.option_market_price_per_share === 'number' ? position.option_market_price_per_share : null;
        const contracts = typeof position?.contracts === 'number' ? position.contracts : 0;
        if (marketPrice === null) {
          return sum;
        }
        return sum + (premiumPerShare - marketPrice) * contracts * 100;
      }, 0)
    : 0;

  return cash + stockValue + unrealizedOptionPnl;
}

function upsertDailyAccountValueHistory(history, totalCapital, now = new Date()) {
  if (!Number.isFinite(totalCapital) || totalCapital <= 0) {
    return Array.isArray(history)
      ? history.filter(
          (item) =>
            typeof item?.date === 'string' &&
            item.date !== '' &&
            typeof item?.as_of === 'string' &&
            item.as_of !== '' &&
            typeof item?.total_capital === 'number' &&
            Number.isFinite(item.total_capital)
        )
      : [];
  }

  const date = getLocalDateInput(now);
  const asOf = now.toISOString();
  const normalized = Array.isArray(history)
    ? history.filter(
        (item) =>
          typeof item?.date === 'string' &&
          item.date !== '' &&
          typeof item?.as_of === 'string' &&
          item.as_of !== '' &&
          typeof item?.total_capital === 'number' &&
          Number.isFinite(item.total_capital)
      )
    : [];
  const index = normalized.findIndex((item) => typeof item?.date === 'string' && item.date === date);
  const nextEntry = {
    date,
    total_capital: totalCapital,
    as_of: asOf
  };

  if (index >= 0) {
    normalized[index] = nextEntry;
  } else {
    normalized.push(nextEntry);
  }

  return normalized.sort((a, b) => {
    const dateCompare = String(a?.date ?? '').localeCompare(String(b?.date ?? ''));
    if (dateCompare !== 0) {
      return dateCompare;
    }
    return String(a?.as_of ?? '').localeCompare(String(b?.as_of ?? ''));
  });
}

export async function refreshAppStateSnapshot(
  snapshot,
  {
    now = new Date(),
    force = false,
    includeVix = true,
    fetchQuoteBundleFn = fetchQuoteBundle,
    fetchCurrentOptionQuoteFn = fetchCurrentOptionQuote,
    refreshVixFn = computeVixSnapshot,
    sleepFn = sleep,
    onProgress = null,
    source = 'system'
  } = {}
) {
  const normalizedSnapshot = coerceSnapshot(snapshot, now);
  const marketOpen = isUsMarketOpenEastern(now);
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const nextTickerList = normalizedSnapshot.data.tickerList.map((entry) => ({ ...entry }));
  const nextPuts = normalizedSnapshot.data.puts.map((position) => ({ ...position }));
  const nextHistory = normalizedSnapshot.data.closedTrades.map((entry) => ({ ...entry }));
  const nextStockTrades = Array.isArray(normalizedSnapshot.data.stockTrades) ? normalizedSnapshot.data.stockTrades.map((entry) => ({ ...entry })) : [];
  const nextConfig = normalizedSnapshot.data.config ? { ...normalizedSnapshot.data.config } : { cash: 0, risk_limit_pct: 0.01, warning_threshold_pct: 0.8 };
  const staleTickerIndexes =
    marketOpen || force
      ? nextTickerList
          .map((entry, index) => ({ entry, index }))
          .filter(
            ({ entry }) =>
              typeof entry?.ticker === 'string' &&
              entry.ticker.trim() !== '' &&
              (force || isRefreshStale(entry.last_updated ?? null, AUTO_PRICE_REFRESH_CHECK_MS, nowMs))
          )
          .map(({ index }) => index)
      : [];
  const staleOptionIndexes =
    marketOpen || force
      ? nextPuts
          .map((position, index) => ({ position, index }))
          .filter(
            ({ position }) =>
              typeof position?.ticker === 'string' &&
              position.ticker.trim() !== '' &&
              !isExpiredDateInput(position.expiration_date ?? '', now) &&
              (force || isRefreshStale(position.option_market_price_updated ?? null, AUTO_OPTION_REFRESH_CHECK_MS, nowMs))
          )
          .map(({ index }) => index)
      : [];
  const cachedVix = includeVix ? await loadVixCache() : null;
  const shouldRefreshVix = shouldRefreshVixWithMarketData({
    cached: cachedVix,
    force,
    includeVix,
    marketOpen,
    now,
    staleTickerCount: staleTickerIndexes.length
  });
  const totalSteps = staleTickerIndexes.length + staleOptionIndexes.length + (shouldRefreshVix ? 1 : 0);
  const tickerResults = [];
  const optionResults = [];
  let completedSteps = 0;

  async function emitProgress(overrides = {}) {
    if (typeof onProgress !== 'function') {
      return;
    }

    await onProgress({
      status: 'running',
      source,
      started_at: nowIso,
      finished_at: null,
      updated_at: new Date().toISOString(),
      market_open: marketOpen,
      force,
      include_vix: shouldRefreshVix,
      total_steps: totalSteps,
      completed_steps: completedSteps,
      refreshed_tickers: tickerResults.filter((item) => item.ok).length,
      refreshed_options: optionResults.filter((item) => item.ok).length,
      current_label: null,
      message: marketOpen || force ? '后台刷新进行中' : '当前非盘中，跳过股票与期权刷新',
      error: null,
      ...overrides
    });
  }

  await emitProgress();

  if (marketOpen || force) {
    for (let listIndex = 0; listIndex < staleTickerIndexes.length; listIndex += 1) {
      const index = staleTickerIndexes[listIndex];
      const entry = nextTickerList[index];
      await emitProgress({
        current_label: `正在刷新股票 ${entry.ticker}`
      });

      try {
        const { quoteResult, rsiResult, rsi1hResult, ma21Result, ma200Result, atrResult, currentIvResult, marketMetricsResult } =
          await fetchQuoteBundleFn({
            symbol: entry.ticker,
            exchange: entry.provider_exchange ?? null,
            mic_code: entry.provider_mic_code ?? null,
            include_market_metrics: true
          });
        const updatedAt = nowIso;

        if (quoteResult.ok) {
          entry.current_price = quoteResult.price;
          entry.last_updated = updatedAt;
        }
        if (rsiResult.ok) {
          entry.rsi_14 = rsiResult.rsi;
          entry.rsi_updated = updatedAt;
        }
        if (rsi1hResult.ok) {
          entry.rsi_14_1h = rsi1hResult.rsi;
          entry.rsi_updated = updatedAt;
        }
        if (ma21Result.ok) {
          entry.ma_21 = ma21Result.sma;
        }
        if (ma200Result.ok) {
          entry.ma_200 = ma200Result.sma;
        }
        if (atrResult && atrResult.ok && typeof atrResult.atr === 'number') {
          entry.atr_14 = atrResult.atr;
        }
        if (currentIvResult.ok && typeof currentIvResult.currentIv === 'number') {
          entry.current_iv = currentIvResult.currentIv;
          entry.current_iv_updated = updatedAt;
        }
        if (marketMetricsResult.ok && marketMetricsResult.marketMetrics) {
          const marketMetrics = marketMetricsResult.marketMetrics;
          if (typeof marketMetrics.next_earnings_date === 'string' && marketMetrics.next_earnings_date !== '') {
            entry.next_earnings_date = marketMetrics.next_earnings_date;
          }
          if (typeof marketMetrics.historical_iv === 'number') {
            entry.historical_iv = marketMetrics.historical_iv;
          }
          if (typeof marketMetrics.iv_rank === 'number') {
            entry.iv_rank = marketMetrics.iv_rank;
          }
          if (typeof marketMetrics.iv_percentile === 'number') {
            entry.iv_percentile = marketMetrics.iv_percentile;
          }
          if (typeof marketMetrics.put_call_ratio === 'number') {
            entry.put_call_ratio = marketMetrics.put_call_ratio;
            entry.put_call_ratio_updated = updatedAt;
          }
        }

        tickerResults.push({
          ticker: entry.ticker,
          ok: true
        });
      } catch (error) {
        tickerResults.push({
          ticker: entry.ticker,
          ok: false,
          message: error instanceof Error ? error.message : 'Ticker refresh failed'
        });
      }

      completedSteps += 1;
      await emitProgress({
        current_label: `股票 ${entry.ticker} 刷新完成`
      });

      if (listIndex < staleTickerIndexes.length - 1) {
        await sleepFn(REQUEST_GAP_MS);
      }
    }

    for (let listIndex = 0; listIndex < staleOptionIndexes.length; listIndex += 1) {
      const index = staleOptionIndexes[listIndex];
      const position = nextPuts[index];
      await emitProgress({
        current_label: `正在刷新期权 ${position.ticker}`
      });

      try {
        const optionQuote = await fetchCurrentOptionQuoteFn(
          position.ticker,
          position.expiration_date,
          position.put_strike,
          position.option_side === 'call' ? 'call' : 'put'
        );
        const preservedTheta = typeof position.option_theta_per_share === 'number' ? position.option_theta_per_share : null;
        const preservedDelta = typeof position.option_delta === 'number' ? position.option_delta : null;
        const preservedGamma = typeof position.option_gamma === 'number' ? position.option_gamma : null;
        position.option_market_price_per_share = optionQuote.price;
        position.option_market_price_updated = nowIso;
        position.option_theta_per_share = typeof optionQuote.theta === 'number' ? optionQuote.theta : preservedTheta;
        position.option_delta = typeof optionQuote.delta === 'number' ? optionQuote.delta : preservedDelta;
        position.option_gamma = typeof optionQuote.gamma === 'number' ? optionQuote.gamma : preservedGamma;
        optionResults.push({
          id: position.id,
          ticker: position.ticker,
          ok: true
        });
      } catch (error) {
        optionResults.push({
          id: position.id,
          ticker: position.ticker,
          ok: false,
          message: error instanceof Error ? error.message : 'Option refresh failed'
        });
      }

      completedSteps += 1;
      await emitProgress({
        current_label: `期权 ${position.ticker} 刷新完成`
      });

      if (listIndex < staleOptionIndexes.length - 1) {
        await sleepFn(REQUEST_GAP_MS);
      }
    }
  }

  let vixResult = null;
  if (shouldRefreshVix) {
    await emitProgress({
      current_label: '正在刷新 VIX / Fear & Greed'
    });
    try {
      vixResult = await refreshVixFn();
    } catch (error) {
      vixResult = {
        error: error instanceof Error ? error.message : 'Failed to refresh VIX cache'
      };
    }
    completedSteps += 1;
    await emitProgress({
      current_label: 'VIX / Fear & Greed 刷新完成'
    });
  } else if (includeVix && cachedVix?.fetched_on === getDateKey(now)) {
    vixResult = {
      skipped: true,
      reason: 'already-refreshed-today'
    };
  } else if (includeVix && staleTickerIndexes.length === 0) {
    vixResult = {
      skipped: true,
      reason: 'no-stock-refresh'
    };
  }

  let nextAccountValueHistory = normalizedSnapshot.data.accountValueHistory;
  try {
    nextAccountValueHistory = upsertDailyAccountValueHistory(
      normalizedSnapshot.data.accountValueHistory,
      computeSnapshotAccountEquity({
        ...normalizedSnapshot.data,
        tickerList: nextTickerList,
        puts: nextPuts
      }),
      now
    );
  } catch {
    nextAccountValueHistory = Array.isArray(normalizedSnapshot.data.accountValueHistory)
      ? normalizedSnapshot.data.accountValueHistory
      : [];
  }

  const activePuts = [];
  const closedPositionIds = new Set(
    nextHistory
      .map((entry) => (typeof entry?.position_id === 'string' ? entry.position_id : null))
      .filter((positionId) => positionId !== null)
  );
  for (const position of nextPuts) {
    if (isExpiredDateInput(position.expiration_date, now)) {
      if (closedPositionIds.has(position.id)) {
        continue;
      }

      const realizedPnl = (position.premium_per_share || 0) * (position.contracts || 0) * 100;
      nextHistory.push({
        id: `closed_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
        position_id: position.id,
        ticker: position.ticker,
        option_side: position.option_side || 'put',
        put_strike: position.put_strike,
        premium_sold_per_share: position.premium_per_share || 0,
        premium_bought_back_per_share: 0,
        contracts: position.contracts,
        date_sold: position.date_sold,
        expiration_date: position.expiration_date,
        closed_at: nowIso,
        close_reason: 'expired',
        realized_pnl: realizedPnl
      });
      closedPositionIds.add(position.id);

      const tickerIndex = nextTickerList.findIndex(t => t.ticker === position.ticker);
      if (tickerIndex !== -1) {
        const tickerEntry = nextTickerList[tickerIndex];
        const currentPrice = tickerEntry.current_price;
        if (typeof currentPrice === 'number' && Number.isFinite(currentPrice)) {
          const isCall = position.option_side === 'call';
          const isPut = position.option_side === 'put' || !position.option_side;
          
          let assigned = false;
          let tradeAction = null;
          
          if (isCall && currentPrice >= position.put_strike) {
            assigned = true;
            tradeAction = 'sell';
          } else if (isPut && currentPrice <= position.put_strike) {
            assigned = true;
            tradeAction = 'buy';
          }

          if (assigned) {
            const sharesToTrade = (position.contracts || 0) * 100;
            const cashImpact = sharesToTrade * position.put_strike;
            
            if (tradeAction === 'sell') {
              tickerEntry.shares = (tickerEntry.shares || 0) - sharesToTrade;
              nextConfig.cash = (nextConfig.cash || 0) + cashImpact;
            } else if (tradeAction === 'buy') {
              const currentShares = tickerEntry.shares || 0;
              const currentCost = tickerEntry.average_cost_basis || 0;
              const newTotalShares = currentShares + sharesToTrade;
              
              if (newTotalShares > 0) {
                const newTotalCost = (currentShares * currentCost) + cashImpact;
                tickerEntry.average_cost_basis = newTotalCost / newTotalShares;
              }
              
              tickerEntry.shares = newTotalShares;
              nextConfig.cash = (nextConfig.cash || 0) - cashImpact;
            }

            nextStockTrades.push({
              id: `trade_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`,
              ticker: position.ticker,
              action: tradeAction,
              shares: sharesToTrade,
              price_per_share: position.put_strike,
              traded_at: nowIso,
              cash_change: tradeAction === 'sell' ? cashImpact : -cashImpact,
              realized_pnl: 0
            });
          }
        }
      }
    } else {
      activePuts.push(position);
    }
  }

  nextPuts.splice(0, nextPuts.length, ...activePuts);

  const updatedSnapshot = {
    ...normalizedSnapshot,
    exported_at: nowIso,
    data: {
      ...normalizedSnapshot.data,
      tickerList: nextTickerList,
      puts: nextPuts,
      closedTrades: nextHistory,
      stockTrades: nextStockTrades,
      config: nextConfig,
      accountValueHistory: nextAccountValueHistory
    }
  };

  return {
    snapshot: updatedSnapshot,
    marketOpen,
    force,
    includeVix: shouldRefreshVix,
    requestedIncludeVix: includeVix,
    tickerResults,
    optionResults,
    vixResult,
    refreshedTickers: tickerResults.filter((item) => item.ok).length,
    refreshedOptions: optionResults.filter((item) => item.ok).length
  };
}

export async function handleApiRequest(req, res) {
  if (!req.url) {
    sendJson(res, 400, { error: 'Missing URL' });
    return;
  }

  if (req.method === 'OPTIONS') {
    sendJson(res, 204, {});
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname === '/api/position-analysis' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await analyzePositionWithGemini(payload);
      sendJson(res, 200, {
        ...result,
        as_of: new Date().toISOString(),
        source: 'Gemini 2.5 Flash + Google Search'
      });
    } catch (error) {
      sendJson(res, 502, {
        error: error instanceof Error ? error.message : 'Gemini analysis failed'
      });
    }
    return;
  }

  if (url.pathname === '/api/pre-trade-analysis' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await analyzePreTradeWithLlmFallback(payload);
      sendJson(res, 200, {
        ...result,
        as_of: new Date().toISOString(),
        source: `${result.provider} + moomoo option snapshots + historical kline`
      });
    } catch (error) {
      sendJson(res, 502, {
        error: error instanceof Error ? error.message : 'Pre-trade analysis failed'
      });
    }
    return;
  }

  if (url.pathname === '/api/vix' && req.method === 'GET') {
    try {
      if (url.searchParams.get('cache_only') === 'true') {
        const cachedSnapshot = buildCachedVixSnapshot(await loadVixCache());
        if (!cachedSnapshot) {
          sendJson(res, 404, { error: 'VIX cache is empty' });
          return;
        }

        sendJson(res, 200, cachedSnapshot);
        return;
      }

      const snapshot = await computeVixSnapshot();
      sendJson(res, 200, snapshot);
    } catch (error) {
      sendJson(res, 502, {
        error: error instanceof Error ? error.message : 'Failed to fetch VIX'
      });
    }
    return;
  }

  if (url.pathname === '/api/cron/refresh-market-data' && (req.method === 'GET' || req.method === 'POST')) {
    const auth = requireCronAuthorization(req);
    if (!auth.ok) {
      sendJson(res, auth.status, { error: auth.error });
      return;
    }

    try {
      const payload = req.method === 'POST' ? await readJsonBody(req) : {};
      const force = (url.searchParams.get('force') ?? payload.force ?? '') === 'true' || payload.force === true;
      const includeVix = !((url.searchParams.get('include_vix') ?? payload.include_vix ?? '') === 'false' || payload.include_vix === false);
      const source = typeof payload.source === 'string' && payload.source.trim() !== '' ? payload.source.trim() : 'github-actions';
      const startedAt = new Date().toISOString();
      const runningStatusError = await saveRefreshStatusSafely({
        status: 'running',
        source,
        started_at: startedAt,
        finished_at: null,
        updated_at: startedAt,
        market_open: null,
        force,
        include_vix: includeVix,
        total_steps: 0,
        completed_steps: 0,
        refreshed_tickers: 0,
        refreshed_options: 0,
        current_label: '正在读取服务器快照',
        message: '后台刷新已启动',
        error: null
      });
      const snapshot = await loadSavedSnapshot();
      let lastSavedProgressStep = 0;
      const refreshResult = await refreshAppStateSnapshot(snapshot, {
        force,
        includeVix,
        source,
        onProgress: async (status) => {
          if (!shouldPersistProgressStatus(status, lastSavedProgressStep)) {
            return;
          }

          lastSavedProgressStep = Number.isFinite(status.completed_steps) ? status.completed_steps : lastSavedProgressStep;
          await saveRefreshStatusSafely(status);
        }
      });
      await enqueueAppStateMutation(async () => {
        const latestSnapshot = await loadSavedSnapshot();
        const mergedSnapshot = mergeSnapshotPreservingExistingCoreState(
          refreshResult.snapshot,
          latestSnapshot,
          'merge'
        );
        mergedSnapshot.data.tickerList = mergeTickerListsPreservingExistingEntries(
          refreshResult.snapshot?.data?.tickerList,
          latestSnapshot?.data?.tickerList
        );
        await saveSnapshot(mergedSnapshot);
      });
      const successStatusError = await saveRefreshStatusSafely({
        status: 'success',
        source,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        market_open: refreshResult.marketOpen,
        force,
        include_vix: refreshResult.includeVix,
        total_steps: refreshResult.tickerResults.length + refreshResult.optionResults.length + (refreshResult.includeVix ? 1 : 0),
        completed_steps: refreshResult.tickerResults.length + refreshResult.optionResults.length + (refreshResult.includeVix ? 1 : 0),
        refreshed_tickers: refreshResult.refreshedTickers,
        refreshed_options: refreshResult.refreshedOptions,
        current_label: null,
        message: refreshResult.marketOpen || force ? '后台刷新完成' : '当前非盘中，跳过股票、期权和 VIX / Fear & Greed',
        error: runningStatusError ?? null
      });

      sendJson(res, 200, {
        ok: true,
        ran_at: new Date().toISOString(),
        market_open: refreshResult.marketOpen,
        force,
        include_vix: refreshResult.includeVix,
        requested_include_vix: refreshResult.requestedIncludeVix,
        refreshed_tickers: refreshResult.refreshedTickers,
        refreshed_options: refreshResult.refreshedOptions,
        ticker_failures: refreshResult.tickerResults.filter((item) => !item.ok),
        option_failures: refreshResult.optionResults.filter((item) => !item.ok),
        vix_result: refreshResult.vixResult,
        refresh_status_warning: runningStatusError ?? successStatusError,
        storage: describeStorageTarget()
      });
    } catch (error) {
      await saveRefreshStatusSafely({
        status: 'error',
        source: 'github-actions',
        started_at: null,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        market_open: null,
        force: false,
        include_vix: true,
        total_steps: 0,
        completed_steps: 0,
        refreshed_tickers: 0,
        refreshed_options: 0,
        current_label: null,
        message: '后台刷新失败',
        error: error instanceof Error ? error.message : 'Failed to refresh market data'
      });
      sendJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'Failed to refresh market data'
      });
    }
    return;
  }

  if (url.pathname === '/api/refresh-status' && req.method === 'GET') {
    try {
      const status = await loadRefreshStatus();
      sendJson(res, 200, {
        status: status ?? {
          status: 'idle',
          source: null,
          started_at: null,
          finished_at: null,
          updated_at: null,
          market_open: null,
          force: false,
          include_vix: true,
          total_steps: 0,
          completed_steps: 0,
          refreshed_tickers: 0,
          refreshed_options: 0,
          current_label: null,
          message: '后台刷新尚未运行',
          error: null
        }
      });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : 'Failed to load refresh status'
      });
    }
    return;
  }

  if (url.pathname === '/api/put-check' && req.method === 'GET') {
    if (!API_KEY) {
      sendJson(res, 500, { error: 'TWELVE_DATA_API_KEY is not configured' });
      return;
    }

    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    const strike = Number(url.searchParams.get('strike') ?? '');
    const beta = Number(url.searchParams.get('beta') ?? '');
    const dateSold = url.searchParams.get('date_sold') ?? '';
    const expirationDate = url.searchParams.get('expiration_date') ?? '';
    const side = (url.searchParams.get('side') ?? 'put').trim().toLowerCase() === 'call' ? 'call' : 'put';
    const exchange = (url.searchParams.get('exchange') ?? '').trim().toUpperCase() || null;
    const mic_code = (url.searchParams.get('mic_code') ?? '').trim().toUpperCase() || null;
    const cachedCurrentPrice = Number(url.searchParams.get('cached_current_price') ?? '');
    const cachedRsi = Number(url.searchParams.get('cached_rsi_14') ?? '');
    const cachedMa20 = Number(url.searchParams.get('cached_ma_20') ?? '');
    const cachedCurrentIv = Number(url.searchParams.get('cached_current_iv') ?? '');

    if (
      symbol === '' ||
      !Number.isFinite(strike) ||
      strike <= 0 ||
      !Number.isFinite(beta) ||
      beta <= 0 ||
      dateSold === '' ||
      expirationDate === ''
    ) {
      sendJson(res, 400, { error: 'symbol, strike, beta, date_sold, expiration_date are required' });
      return;
    }

    const requestItem = { symbol, exchange, mic_code };

    try {
      const quoteResult = await fetchQuote(requestItem);
      await sleep(REQUEST_GAP_MS);
      const rsiResult = await fetchRsi(requestItem);
      await sleep(REQUEST_GAP_MS);
      const ma20Result = await fetchSma(requestItem, 20);
      let currentIv = null;
      let currentIvError = null;

      try {
        await sleep(REQUEST_GAP_MS);
        currentIv = await fetchCurrentIv(symbol);
      } catch (error) {
        currentIvError = error instanceof Error ? error.message : 'Current IV fetch failed';
      }

      const fallbackNotes = [];
      const currentPrice = quoteResult.ok
        ? quoteResult.price
        : Number.isFinite(cachedCurrentPrice) && cachedCurrentPrice > 0
          ? cachedCurrentPrice
          : null;
      if (!quoteResult.ok && currentPrice !== null) {
        fallbackNotes.push('价格使用本地历史数据');
      }

      const rsi = rsiResult.ok
        ? rsiResult.rsi
        : Number.isFinite(cachedRsi)
          ? cachedRsi
          : null;
      if (!rsiResult.ok && rsi !== null) {
        fallbackNotes.push('RSI 使用本地历史数据');
      }

      const ma20 = ma20Result.ok
        ? ma20Result.sma
        : Number.isFinite(cachedMa20)
          ? cachedMa20
          : null;
      if (!ma20Result.ok && ma20 !== null) {
        fallbackNotes.push('MA20 使用本地历史数据');
      }

      if (currentIv === null && Number.isFinite(cachedCurrentIv)) {
        currentIv = cachedCurrentIv;
        fallbackNotes.push('Current IV 使用本地历史数据');
      }

      let currentVix = null;
      let currentVixError = null;
      try {
        const todayKey = getDateKey();
        const cachedVix = await loadVixCache();
        if (
          cachedVix &&
          cachedVix.fetched_on === todayKey &&
          typeof cachedVix.value === 'number' &&
          Number.isFinite(cachedVix.value)
        ) {
          currentVix = cachedVix.value;
        } else {
          const officialVix = await fetchLatestOfficialVixDailyClose();
          currentVix = officialVix.value;
        }
      } catch (error) {
        currentVixError = error instanceof Error ? error.message : 'VIX fetch failed';
      }

      let ivRank = null;
      let ivRankError = null;
      try {
        const marketSnapshot = await fetchBarchartMarketSnapshot(symbol);
        if (typeof marketSnapshot.iv_rank === 'number' && Number.isFinite(marketSnapshot.iv_rank)) {
          ivRank = marketSnapshot.iv_rank;
        }
      } catch (error) {
        ivRankError = error instanceof Error ? error.message : 'IV Rank fetch failed';
      }

      const fetchErrors = [
        currentPrice === null ? (quoteResult.ok ? null : quoteResult.message) : null,
        rsi === null ? (rsiResult.ok ? null : rsiResult.message) : null,
        ma20 === null ? (ma20Result.ok ? null : ma20Result.message) : null
      ].filter((value) => value !== null);

      if (fetchErrors.length > 0 || currentPrice === null || rsi === null || ma20 === null) {
        sendJson(res, 200, {
          ok: false,
          summary: '有提示风险，不建议执行',
          failures: [
            '价格 / RSI / MA20 无法获取，且本地历史数据也不可用',
            ...fetchErrors
          ]
        });
        return;
      }
      const { checks, dte, otmPct } = buildPutEntryChecks({
        side,
        strike,
        currentPrice,
        beta,
        dateSold,
        expirationDate,
        ma20,
        rsi,
        vix: currentVix,
        ivRank
      });

      const failures = checks.filter((item) => !item.passed).map((item) => `${item.label} 未满足：${item.detail}`);
      const passedAllChecks = checks.every((item) => item.passed);

      sendJson(res, 200, {
        ok: passedAllChecks,
        summary: passedAllChecks
          ? '条件满足，可以继续'
          : '有提示风险，不建议执行',
        failures,
        checks,
        side,
        fallback_notes: fallbackNotes,
        current_iv_note: currentIvError,
        vix_note: currentVixError,
        iv_rank_note: ivRankError,
        metrics: {
          current_price: currentPrice,
          rsi_14: rsi,
          ma_20: ma20,
          current_iv: currentIv,
          current_vix: currentVix,
          iv_rank: ivRank,
          otm_pct: otmPct,
          dte,
          as_of: new Date().toISOString()
        }
      });
    } catch (error) {
      sendJson(res, 502, {
        ok: false,
        summary: '有提示风险，不建议执行',
        failures: [error instanceof Error ? error.message : 'Unknown upstream error']
      });
    }
    return;
  }

  if (url.pathname === '/api/app-state' && req.method === 'GET') {
    try {
      const snapshot = await loadSavedSnapshot();
      sendJson(res, 200, { snapshot });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to load app state' });
    }
    return;
  }

  if (url.pathname === '/api/app-state' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const incomingSnapshot = coerceSnapshot(payload);
      const saveMode = req.headers['x-app-state-save-mode'] === 'replace' ? 'replace' : 'merge';
      const allowDestructiveWrite = req.headers['x-app-state-allow-destructive'] === 'true';
      const saveResult = await enqueueAppStateMutation(async () => {
        const existingSnapshot = await loadSavedSnapshot();

        if (!hasMeaningfulSnapshotData(incomingSnapshot) && hasMeaningfulSnapshotData(existingSnapshot)) {
          return {
            ok: false,
            status: 409,
            payload: {
              error: 'Refusing to overwrite existing app state with an empty snapshot'
            }
          };
        }

        const suspiciousShrinkIssues = findSuspiciousSnapshotShrink(
          incomingSnapshot,
          existingSnapshot,
          saveMode,
          allowDestructiveWrite
        );
        if (suspiciousShrinkIssues.length > 0) {
          return {
            ok: false,
            status: 409,
            payload: {
              error: `Refusing suspicious destructive app-state overwrite: ${suspiciousShrinkIssues.join(', ')}`,
              code: 'SUSPICIOUS_SNAPSHOT_SHRINK',
              issues: suspiciousShrinkIssues
            }
          };
        }

        const mergedSnapshot = mergeSnapshotPreservingExistingCoreState(incomingSnapshot, existingSnapshot, saveMode);
        if (saveMode === 'merge') {
          mergedSnapshot.data.tickerList = mergeTickerListsPreservingExistingEntries(
            incomingSnapshot?.data?.tickerList,
            existingSnapshot?.data?.tickerList
          );
        }
        await saveSnapshot(mergedSnapshot);
        console.info(
          '[app-state] saved',
          JSON.stringify({
            saveMode,
            puts: Array.isArray(mergedSnapshot?.data?.puts) ? mergedSnapshot.data.puts.length : 0,
            closedTrades: Array.isArray(mergedSnapshot?.data?.closedTrades) ? mergedSnapshot.data.closedTrades.length : 0,
            stockTrades: Array.isArray(mergedSnapshot?.data?.stockTrades) ? mergedSnapshot.data.stockTrades.length : 0,
            storage: describeStorageTarget()
          })
        );
        return { ok: true };
      });

      if (!saveResult.ok) {
        sendJson(res, saveResult.status, saveResult.payload);
        return;
      }

      // Fire-and-forget: persist stock daily snapshot on every merge-mode save
      // (merge mode is exclusively used by quote refresh operations).
      if (saveMode === 'merge') {
        const tickerEntries = Array.isArray(incomingSnapshot?.data?.tickerList)
          ? incomingSnapshot.data.tickerList
          : [];
        if (tickerEntries.length > 0) {
          writeStockDailySnapshot(tickerEntries).catch((err) => {
            console.warn('[stock-snapshots] write failed:', err instanceof Error ? err.message : err);
          });

          // Fire-and-forget: fetch moomoo option snapshots for enabled tickers.
          for (const entry of tickerEntries) {
            if (entry?.option_snapshot_enabled !== true) {
              continue;
            }
            const entryTicker = typeof entry?.ticker === 'string' ? entry.ticker.trim().toUpperCase() : '';
            if (entryTicker === '') {
              continue;
            }
            const currentPrice = typeof entry?.current_price === 'number' && Number.isFinite(entry.current_price)
              ? entry.current_price
              : null;
            fetchOptionSnapshotForTicker(entryTicker, currentPrice)
              .then((rows) => writeOptionDailySnapshot(entryTicker, rows))
              .catch((err) => {
                console.warn(
                  `[option-snapshots] ${entryTicker} failed:`,
                  err instanceof Error ? err.message : err
                );
              });
          }
        }
      }

      const storageTarget = describeStorageTarget();
      sendJson(res, 200, {
        ok: true,
        saved_at: new Date().toISOString(),
        storage: storageTarget,
        save_mode: saveMode
      });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to save app state' });
    }
    return;
  }

  if (url.pathname === '/api/stock-snapshots' && req.method === 'GET') {
    try {
      const ticker = url.searchParams.get('ticker') ?? undefined;
      const startDate = url.searchParams.get('start') ?? undefined;
      const endDate = url.searchParams.get('end') ?? undefined;
      const rows = await readStockDailySnapshots({ ticker, startDate, endDate });
      sendJson(res, 200, { rows, count: rows.length });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to read stock snapshots' });
    }
    return;
  }

  if (url.pathname === '/api/option-snapshots' && req.method === 'GET') {
    try {
      const ticker = url.searchParams.get('ticker') ?? undefined;
      const startDate = url.searchParams.get('start') ?? undefined;
      const endDate = url.searchParams.get('end') ?? undefined;
      const side = url.searchParams.get('side') ?? undefined;
      const rows = await readOptionDailySnapshots({ ticker, startDate, endDate, side });
      sendJson(res, 200, { rows, count: rows.length });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to read option snapshots' });
    }
    return;
  }

  if (url.pathname !== '/api/quotes' || req.method !== 'GET') {
    if (url.pathname === '/api/market-metrics' && req.method === 'GET') {
      const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
      if (symbol === '') {
        sendJson(res, 400, { error: 'symbol is required' });
        return;
      }

      try {
        const metrics = await fetchMarketMetrics(symbol);
        sendJson(res, 200, {
          ...metrics,
          as_of: new Date().toISOString()
        });
      } catch (error) {
        sendJson(res, 502, {
          error: error instanceof Error ? error.message : 'Unknown upstream error'
        });
      }
      return;
    }

    if (url.pathname === '/api/option-price' && req.method === 'GET') {
      const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
      const expirationDate = (url.searchParams.get('expiration_date') ?? '').trim();
      const strike = Number(url.searchParams.get('strike') ?? '');
      const side = (url.searchParams.get('side') ?? 'put').trim().toLowerCase();

      if (symbol === '' || expirationDate === '' || !Number.isFinite(strike) || strike <= 0) {
        sendJson(res, 400, { error: 'symbol, expiration_date, strike are required' });
        return;
      }

      try {
        const optionQuote = await fetchCurrentOptionQuote(symbol, expirationDate, strike, side);
        sendJson(res, 200, {
          symbol,
          expiration_date: expirationDate,
          strike,
          side,
          option_price_per_share: optionQuote.price,
          theta_per_share: optionQuote.theta,
          delta: optionQuote.delta,
          gamma: optionQuote.gamma,
          as_of: new Date().toISOString(),
          source: optionQuote.source ?? 'MarketData.app /options/quotes'
        });
      } catch (error) {
        sendJson(res, 502, {
          error: error instanceof Error ? error.message : 'Unknown upstream error'
        });
      }
      return;
    }

    if (url.pathname !== '/api/put-call-ratio' || req.method !== 'GET') {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }

    const symbol = (url.searchParams.get('symbol') ?? '').trim().toUpperCase();
    if (symbol === '') {
      sendJson(res, 400, { error: 'symbol is required' });
      return;
    }

    try {
      const putCallRatio = await fetchPutCallRatio(symbol);
      sendJson(res, 200, {
        symbol,
        put_call_ratio: putCallRatio.value,
        as_of: new Date().toISOString(),
        source: putCallRatio.source
      });
    } catch (error) {
      sendJson(res, 502, {
        error: error instanceof Error ? error.message : 'Unknown upstream error'
      });
    }
    return;
  }

  if (!API_KEY) {
    sendJson(res, 500, { error: 'TWELVE_DATA_API_KEY is not configured' });
    return;
  }

  const itemsParam = url.searchParams.get('items');
  const symbolsParam = url.searchParams.get('symbols') ?? '';
  const requestedItems = itemsParam
    ? (() => {
        try {
          const parsed = JSON.parse(itemsParam);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return null;
        }
      })()
    : [...new Set(symbolsParam.split(',').map((item) => item.trim().toUpperCase()).filter(Boolean))];

  if (requestedItems === null) {
    sendJson(res, 400, { error: 'items query parameter must be valid JSON' });
    return;
  }

  const requests = requestedItems.map(normalizeQuoteRequest).filter((item) => item.symbol !== '');

  if (requests.length === 0) {
    sendJson(res, 400, { error: 'symbols or items query parameter is required' });
    return;
  }

  try {
    const quotes = {};
    const quoteAsOf = {};
    const quoteSources = {};
    const rsi = {};
    const rsi1h = {};
    const ma21 = {};
    const ma200 = {};
    const atr14 = {};
    const currentIv = {};
    const nextEarningsDate = {};
    const historicalIv = {};
    const ivRank = {};
    const ivPercentile = {};
    const putCallRatio = {};
    const errors = {};

    for (const requestItem of requests) {
      const { quoteResult, rsiResult, rsi1hResult, ma21Result, ma200Result, atrResult, currentIvResult, marketMetricsResult } = await fetchQuoteBundle(requestItem);


      if (quoteResult.ok) {
        quotes[quoteResult.symbol] = quoteResult.price;
        if (typeof quoteResult.as_of === 'string' && quoteResult.as_of !== '') {
          quoteAsOf[quoteResult.symbol] = quoteResult.as_of;
        }
        if (typeof quoteResult.source === 'string' && quoteResult.source !== '') {
          quoteSources[quoteResult.symbol] = quoteResult.source;
        }
      } else {
        errors[quoteResult.symbol] = quoteResult.message;
      }

      if (rsiResult.ok) {
        rsi[rsiResult.symbol] = rsiResult.rsi;
      } else if (!(rsiResult.symbol in errors)) {
        errors[rsiResult.symbol] = rsiResult.message;
      }

      if (rsi1hResult.ok) {
        rsi1h[rsi1hResult.symbol] = rsi1hResult.rsi;
      } else if (!(rsi1hResult.symbol in errors)) {
        errors[rsi1hResult.symbol] = rsi1hResult.message;
      }

      if (ma21Result.ok) {
        ma21[ma21Result.symbol] = ma21Result.sma;
      } else if (!(ma21Result.symbol in errors)) {
        errors[ma21Result.symbol] = ma21Result.message;
      }

      if (ma200Result.ok) {
        ma200[ma200Result.symbol] = ma200Result.sma;
      } else if (!(ma200Result.symbol in errors)) {
        errors[ma200Result.symbol] = ma200Result.message;
      }

      if (atrResult && atrResult.ok && typeof atrResult.atr === 'number') {
        atr14[atrResult.symbol] = atrResult.atr;
      }

      if (currentIvResult.ok) {
        currentIv[currentIvResult.symbol] = currentIvResult.currentIv;
      } else if (!(currentIvResult.symbol in errors)) {
        errors[currentIvResult.symbol] = currentIvResult.message;
      }

      if (marketMetricsResult?.ok && marketMetricsResult.marketMetrics) {
        const metrics = marketMetricsResult.marketMetrics;
        if (typeof metrics.next_earnings_date === 'string' && metrics.next_earnings_date !== '') {
          nextEarningsDate[marketMetricsResult.symbol] = metrics.next_earnings_date;
        }
        if (typeof metrics.historical_iv === 'number' && Number.isFinite(metrics.historical_iv)) {
          historicalIv[marketMetricsResult.symbol] = metrics.historical_iv;
        }
        if (typeof metrics.iv_rank === 'number' && Number.isFinite(metrics.iv_rank)) {
          ivRank[marketMetricsResult.symbol] = metrics.iv_rank;
        }
        if (typeof metrics.iv_percentile === 'number' && Number.isFinite(metrics.iv_percentile)) {
          ivPercentile[marketMetricsResult.symbol] = metrics.iv_percentile;
        }
        if (typeof metrics.put_call_ratio === 'number' && Number.isFinite(metrics.put_call_ratio)) {
          putCallRatio[marketMetricsResult.symbol] = metrics.put_call_ratio;
        }
      } else if (marketMetricsResult && !marketMetricsResult.ok && !(marketMetricsResult.symbol in errors)) {
        errors[marketMetricsResult.symbol] = marketMetricsResult.message;
      }

      await sleep(REQUEST_GAP_MS);
    }

    sendJson(res, 200, {
      quotes,
      quoteAsOf,
      quoteSources,
      rsi,
      rsi1h,
      ma21,
      ma200,
      atr14,
      currentIv,
      nextEarningsDate,
      historicalIv,
      ivRank,
      ivPercentile,
      putCallRatio,
      errors,
      as_of: new Date().toISOString(),
      source: 'Barchart -> MarketData.app -> TwelveData'
    });
  } catch (error) {
    sendJson(res, 502, {
      error: error instanceof Error ? error.message : 'Unknown upstream error'
    });
  }
}

function shouldStartServer() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return import.meta.url === new URL(`file://${process.argv[1]}`).href;
  } catch {
    return false;
  }
}

if (shouldStartServer()) {
  const server = http.createServer(handleApiRequest);

  server.listen(PORT, () => {
    console.log(`Quote API listening on ${PORT}`);
  });
}
