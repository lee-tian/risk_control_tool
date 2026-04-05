import http from 'node:http';
import { calculateRsi, calculateSma, extractCloseSeries } from './marketIndicators.mjs';
import { readJsonFromResponse } from './httpResponses.mjs';
import {
  describeStorageTarget,
  readAppState,
  readRefreshStatus,
  readVixCache,
  writeAppState,
  writeRefreshStatus,
  writeVixCache
} from './lib/storage/index.mjs';
import {
  extractOptionQuoteFromChain,
  extractOptionQuoteFromSnapshot,
  formatOptionSymbol
} from './optionQuotes.mjs';
import { buildPutEntryChecks } from './putCheckRules.mjs';
import { normalizeProviderSymbol } from './providerSymbols.mjs';

const PORT = Number(process.env.PORT ?? 3001);
const API_KEY = process.env.TWELVE_DATA_API_KEY ?? '';
const MARKETDATA_TOKEN = process.env.MARKETDATA_TOKEN ?? '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? '';
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
const BARCHART_BROWSER_HEADERS = {
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache',
  Pragma: 'no-cache',
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

function isMarketDataQuotaErrorMessage(message) {
  return typeof message === 'string' && message.toLowerCase().includes('daily request limit');
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

function getDateKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

async function loadVixCache() {
  return readVixCache();
}

async function saveVixCache(payload) {
  await writeVixCache(payload);
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

function buildPreTradeGeminiPrompt(payload, marketContext) {
  const {
    option_side,
    ticker,
    contracts,
    put_strike,
    premium_per_share,
    expiration_date,
    date_sold,
    current_price,
    beta,
    rsi_14,
    ma_21,
    ma_200,
    current_iv,
    user_rationale
  } = payload;
  const optionSide = option_side === 'call' ? 'Covered Call' : 'Sell Put';
  const isCall = option_side === 'call';

  const currentIvPct = formatPromptMetric(marketContext.current_iv, (value) => `${(Number(value) * 100).toFixed(2)}%`);
  const historicalIvPct = formatPromptMetric(marketContext.historical_iv, (value) => `${(Number(value) * 100).toFixed(2)}%`);
  const ivRankDisplay = formatPromptMetric(marketContext.iv_rank, (value) => Number(value).toFixed(1));
  const ivPercentileDisplay = formatPromptMetric(marketContext.iv_percentile, (value) => Number(value).toFixed(1));
  const putCallRatioDisplay = formatPromptMetric(marketContext.put_call_ratio, (value) => Number(value).toFixed(2));
  const currentPriceDisplay = formatPromptMetric(marketContext.current_price, (value) => Number(value).toFixed(2));
  const priceDateDisplay = formatPromptMetric(marketContext.current_price_date, (value) => String(value));
  const earningsDateDisplay = formatPromptMetric(marketContext.next_earnings_date, (value) => String(value));
  const rsiDisplay = typeof rsi_14 === 'string' && rsi_14.trim() !== '' ? rsi_14 : '未确认';
  const ma21Display = typeof ma_21 === 'string' && ma_21.trim() !== '' ? ma_21 : '未确认';
  const ma200Display = typeof ma_200 === 'string' && ma_200.trim() !== '' ? ma_200 : '未确认';
  const strike = Number(put_strike);
  const premium = Number(premium_per_share);
  const currentPrice = Number(marketContext.current_price ?? current_price);
  const expiration = typeof expiration_date === 'string' ? expiration_date : '';
  const soldDate = typeof date_sold === 'string' ? date_sold : '';
  const expirationTimestamp = Date.parse(`${expiration}T00:00:00Z`);
  const soldTimestamp = Date.parse(`${soldDate}T00:00:00Z`);
  const dte =
    Number.isFinite(expirationTimestamp) && Number.isFinite(soldTimestamp)
      ? Math.max(0, Math.round((expirationTimestamp - soldTimestamp) / (24 * 60 * 60 * 1000)))
      : null;
  const breakeven =
    Number.isFinite(strike) && Number.isFinite(premium) ? (isCall ? strike + premium : strike - premium) : null;
  const strikeBufferPct =
    Number.isFinite(currentPrice) && currentPrice > 0 && Number.isFinite(strike)
      ? ((isCall ? strike - currentPrice : currentPrice - strike) / currentPrice) * 100
      : null;
  const breakevenBufferPct =
    Number.isFinite(currentPrice) && currentPrice > 0 && Number.isFinite(breakeven)
      ? ((isCall ? breakeven - currentPrice : currentPrice - breakeven) / currentPrice) * 100
      : null;
  const priceVsMa21Pct =
    Number.isFinite(currentPrice) && Number.isFinite(Number(ma_21)) && Number(ma_21) > 0
      ? ((currentPrice - Number(ma_21)) / Number(ma_21)) * 100
      : null;
  const priceVsMa200Pct =
    Number.isFinite(currentPrice) && Number.isFinite(Number(ma_200)) && Number(ma_200) > 0
      ? ((currentPrice - Number(ma_200)) / Number(ma_200)) * 100
      : null;
  const importantSignals = [
    `现价 ${currentPriceDisplay}，价格日期 ${priceDateDisplay}`,
    `行权价 ${put_strike}，权利金 ${premium_per_share}，Breakeven ${formatPromptMetric(breakeven, (value) => Number(value).toFixed(2))}`,
    `距离行权价 ${formatPromptMetric(strikeBufferPct, (value) => `${Number(value).toFixed(2)}%`)}`,
    `距离 Breakeven ${formatPromptMetric(breakevenBufferPct, (value) => `${Number(value).toFixed(2)}%`)}`,
    `DTE ${formatPromptMetric(dte, (value) => String(value))}`,
    `MA21 ${ma21Display}，现价相对 MA21 ${formatPromptMetric(priceVsMa21Pct, (value) => `${Number(value).toFixed(2)}%`)}`,
    `MA200 ${ma200Display}，现价相对 MA200 ${formatPromptMetric(priceVsMa200Pct, (value) => `${Number(value).toFixed(2)}%`)}`,
    `RSI(14) ${rsiDisplay}`,
    `Beta ${typeof beta === 'string' && beta.trim() !== '' ? beta : '未确认'}`,
    `Current IV ${currentIvPct} / Historical IV ${historicalIvPct} / IV Rank ${ivRankDisplay} / IV Percentile ${ivPercentileDisplay}`,
    `PCR(OI) ${putCallRatioDisplay}`,
    `下个财报日 ${earningsDateDisplay}`
  ];

  return [
    `你是一位严谨的 ${optionSide} 交易前风险分析师。请用中文回答。`,
    '请只输出严格 JSON，不要输出 Markdown，不要输出代码块，不要有额外解释。',
    '不要联网搜索，不要使用搜索结果，不要假设你看到了实时网页。',
    '你只能基于下面“服务器已抓取的数据快照”和用户输入来分析。',
    `把下面这些项目视为 ${optionSide} 最重要的信息：现价、价格日期、DTE、行权价距离、Breakeven 距离、MA21、MA200、RSI、Beta、Current IV、Historical IV、IV Rank、IV Percentile、PCR、财报日。`,
    `目标：在卖出前，让交易者清晰知道这笔 ${optionSide} 的执行计划、风险、最坏情况、公司基本面。`,
    'JSON schema:',
    '{',
    '  "verdict": "可以考虑 | 需要谨慎 | 不建议卖",',
    '  "summary": "一句话总结，不超过35字",',
    '  "rationale_check": "点评用户对接货、止损、最大亏损边界的计划是否清晰可执行，不超过50字",',
    '  "key_risks": ["最多3条，每条不超过30字"],',
    '  "worst_case": "最坏情况，不超过60字",',
    '  "fundamental_note": "最需要注意的基本面问题，不超过60字",',
    '  "fundamental_events": ["如果基本面有风险，列出最多3个具体事件，带简短日期或季度信息"],',
    '  "current_iv_rank": "当前 IV Rank，返回 0-100 的数字字符串；如果无法确认则写 未确认",',
    `  "iv_rank_note": "简短说明当前 IV Rank 所处区间及其对${optionSide}的含义，不超过40字",`,
    '  "iv_rank_source": "IV Rank 的具体出处名称，例如 Market Chameleon / Barchart / tastytrade；无法确认则写 未确认",',
    '  "iv_rank_time": "这条 IV Rank 数据的时间，尽量保留原网页日期或时间；无法确认则写 未确认",',
    '  "iv_rank_link": "这条 IV Rank 的公开原始网页链接，必须是用户可直接打开的网页，不要返回 Google/Vertex grounding 中转链接；无法确认则写 空字符串",',
    '  "current_iv_check": "基于已提供的 Current IV / Historical IV / IV Percentile 做一句判断，不超过45字",',
    '  "marsi_check": "结合 RSI(14)、MA21、MA200 做一句技术面判断，不超过45字",',
    '  "rsi_check": "基于当前 RSI(14) 判断是否超卖，格式示例：RSI(14) 28.4，已超卖 / RSI(14) 43.2，未超卖，不超过40字",',
    '  "ma200_check": "结合当前价与 MA200 给出一句判断，格式示例：MA200 261.17，现价高于 MA200 / MA200 261.17，现价低于 MA200，不超过40字",',
    '  "next_earnings_date": "下一个财报日，格式 YYYY-MM-DD；如果无法确认则写 未确认",',
    '  "earnings_warning": "判断这笔期权到期前是否会跨财报，并给出简短预警，例如 会跨财报，需谨慎 / 到期早于财报，相对更安全，不超过40字",',
    '  "action": "给出交易动作建议，不超过35字"',
    '}',
    '如果你判断基本面有问题，只能基于你已有常识和下面数据推断；没有把握就返回保守表述。',
    'IV Rank、Current IV、Historical IV、IV Percentile、财报日优先使用服务器已提供的数据，不要自行改写成其他来源。',
    'iv_rank_source 固定写 Barchart 或 MarketData.app；iv_rank_link 优先返回 Barchart 的原始链接。',
    '请明确比较：下一次财报日 是否落在 这笔期权的到期日之前或之内。',
    '如果这笔期权会跨财报，请在 earnings_warning 里明确指出这是财报风险。',
    'fundamental_events 如果没有足够确定的具体事件，就返回空数组。',
    '',
    '服务器已抓取的数据快照：',
    `Barchart Overview Link: ${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(ticker)}/overview`,
    `Barchart Put/Call Link: ${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(ticker)}/put-call-ratios`,
    `Current price: ${currentPriceDisplay}`,
    `Current price date: ${priceDateDisplay}`,
    `Current IV: ${currentIvPct}`,
    `Historical IV: ${historicalIvPct}`,
    `IV Rank: ${ivRankDisplay}`,
    `IV Percentile: ${ivPercentileDisplay}`,
    `Put/Call Ratio(OI): ${putCallRatioDisplay}`,
    `Next earnings date: ${earningsDateDisplay}`,
    `Current IV source: ${marketContext.source.current_iv ?? '未确认'}`,
    `Historical IV source: ${marketContext.source.historical_iv ?? '未确认'}`,
    `IV Rank source: ${marketContext.source.iv_rank ?? '未确认'}`,
    `IV Percentile source: ${marketContext.source.iv_percentile ?? '未确认'}`,
    `Earnings date source: ${marketContext.source.next_earnings_date ?? '未确认'}`,
    `RSI(14): ${rsiDisplay}`,
    `MA21: ${ma21Display}`,
    `MA200: ${ma200Display}`,
    '重要信息快照：',
    ...importantSignals.map((item) => `- ${item}`),
    '',
    `Ticker: ${ticker}`,
    `Contracts: ${contracts}`,
    `Strike: ${put_strike}`,
    `Premium per share: ${premium_per_share}`,
    `Date sold: ${date_sold}`,
    `Expiration date: ${expiration_date}`,
    `Current price: ${current_price}`,
    `Beta: ${beta}`,
    `RSI(14) from app snapshot: ${rsiDisplay}`,
    `MA21 from app snapshot: ${ma21Display}`,
    `MA200 from app snapshot: ${ma200Display}`,
    `Current IV from app snapshot: ${current_iv}`,
    `User plan after strike breaks / stop-loss boundary: ${user_rationale}`
  ].join('\n');
}

function buildPreTradeContextPrompt(payload, marketContext) {
  const ticker = typeof payload?.ticker === 'string' ? payload.ticker.trim().toUpperCase() : '';
  const optionSide = payload?.option_side === 'call' ? 'Covered Call' : 'Sell Put';
  const earningsDateDisplay = formatPromptMetric(marketContext.next_earnings_date, (value) => String(value));
  const currentIvPct = formatPromptMetric(marketContext.current_iv, (value) => `${(Number(value) * 100).toFixed(2)}%`);
  const historicalIvPct = formatPromptMetric(marketContext.historical_iv, (value) => `${(Number(value) * 100).toFixed(2)}%`);
  const ivRankDisplay = formatPromptMetric(marketContext.iv_rank, (value) => Number(value).toFixed(1));
  const ivPercentileDisplay = formatPromptMetric(marketContext.iv_percentile, (value) => Number(value).toFixed(1));
  const expirationDate = typeof payload?.expiration_date === 'string' ? payload.expiration_date : '未确认';

  return [
    `你是一位 ${optionSide} 卖前事件摘要助手。请用中文回答。`,
    '请只输出严格 JSON，不要输出 Markdown，不要输出代码块。',
    '你可以使用 Google Search，但要优先总结财报日、监管消息、公司重大事件、宏观事件窗口。',
    'JSON schema:',
    '{',
    '  "iv_assessment": "一句话判断当前 IV / IV Rank / 权利金环境，不超过40字",',
    '  "earnings_assessment": "一句话判断财报日与本次到期日的关系，不超过40字",',
    '  "special_window_assessment": "一句话判断近期是否处于特殊事件窗口，不超过45字",',
    '  "macro_regulatory_assessment": "一句话总结宏观或监管层面的近期风险，不超过45字",',
    '  "key_flags": ["最多4条，每条不超过28字"]',
    '}',
    '如果没有明确证据，请保守表述，不要编造具体日期。',
    '如果到期日前后有 FOMC、财报、产品发布、监管调查、反垄断、行业政策等，应在 key_flags 中提示。',
    '',
    `Ticker: ${ticker}`,
    `Trade type: ${optionSide}`,
    `Expiration date: ${expirationDate}`,
    `Current IV: ${currentIvPct}`,
    `Historical IV: ${historicalIvPct}`,
    `IV Rank: ${ivRankDisplay}`,
    `IV Percentile: ${ivPercentileDisplay}`,
    `Next earnings date: ${earningsDateDisplay}`,
    `Current IV source: ${marketContext.source.current_iv ?? '未确认'}`,
    `IV Rank source: ${marketContext.source.iv_rank ?? '未确认'}`,
    `Earnings date source: ${marketContext.source.next_earnings_date ?? '未确认'}`,
    `Barchart Overview Link: ${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(ticker)}/overview`,
    `Barchart Put/Call Link: ${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(ticker)}/put-call-ratios`
  ].join('\n');
}

function buildFallbackSearchPrompt({ ticker, topic, expirationDate }) {
  return [
    `请用中文总结 ${ticker} 在 ${expirationDate || '未来几周'} 前后的 ${topic}。`,
    '只输出严格 JSON，不要 Markdown。',
    '{',
    '  "summary": "一句话概括，不超过60字",',
    '  "event_date": "最近最相关事件或新闻日期，尽量 YYYY-MM-DD；拿不到就写 未确认",',
    '  "headline": "这条最相关事件/新闻的短标题，不超过40字",',
    '  "key_flags": ["最多3条短提醒"]',
    '}',
    '必须基于可公开访问的网站信息；如果不确定，请保守表述。',
    '优先找最近的相关新闻、公司事件、宏观或监管事件，并给出对应日期。'
  ].join('\n');
}

async function runGeminiSearchFallback({ ticker, topic, expirationDate }) {
  if (!GEMINI_API_KEY) {
    return {
      summary: `${topic} 暂未补充`,
      eventDate: '未确认',
      headline: '',
      keyFlags: [],
      sources: []
    };
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
            parts: [{ text: buildFallbackSearchPrompt({ ticker, topic, expirationDate }) }]
          }
        ],
        tools: [{ google_search: {} }],
        generationConfig: {
          temperature: 0.2
        }
      })
    }
  );

  const data = await readJsonFromResponse(response, `Gemini ${topic} fallback failed`);
  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message ?? `Gemini ${topic} fallback failed`);
  }

  const text =
    data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text)
      .filter((value) => typeof value === 'string')
      .join('\n')
      .trim() ?? '';

  if (text === '') {
    return {
      summary: `${topic} 暂未补充`,
      eventDate: '未确认',
      headline: '',
      keyFlags: [],
      sources: []
    };
  }

  const parsed = parseGeminiJson(text);
  const rawSources = buildGroundingSources(data).slice(0, 3);
  const sources = rawSources
    .map((item) => {
      const directUrl = getReadableSourceUrl(item);
      return directUrl === ''
        ? null
        : {
            title: item.title,
            url: directUrl
          };
    })
    .filter((item) => item !== null);

  const keyFlags = Array.isArray(parsed.key_flags)
    ? parsed.key_flags
        .map(formatGeminiKeyFlag)
        .filter((item) => typeof item === 'string' && item.trim() !== '')
        .slice(0, 4)
    : [];

  const eventDate =
    typeof parsed.event_date === 'string' && parsed.event_date.trim() !== ''
      ? parsed.event_date
      : extractEventDateFromKeyFlags(parsed.key_flags);

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : `${topic} 暂未补充`,
    eventDate,
    headline: typeof parsed.headline === 'string' ? parsed.headline : '',
    keyFlags,
    sources: sources.filter((item, index, list) => list.findIndex((candidate) => candidate.url === item.url) === index)
  };
}

function getReadableSourceUrl(source) {
  const directFromPublicUrl = normalizePublicWebUrl(source?.publicUrl);
  if (isDirectWebUrl(directFromPublicUrl)) {
    return directFromPublicUrl;
  }

  const directFromUrl = normalizePublicWebUrl(source?.url);
  if (isDirectWebUrl(directFromUrl)) {
    return directFromUrl;
  }

  const title = typeof source?.title === 'string' ? source.title.trim().toLowerCase() : '';
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title)) {
    return `https://${title}`;
  }

  return '';
}

function isDirectWebUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl === '') {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    return !parsed.hostname.toLowerCase().includes('vertexaisearch.cloud.google.com');
  } catch {
    return false;
  }
}

function formatGeminiKeyFlag(flag) {
  if (typeof flag === 'string') {
    return flag.trim();
  }

  if (!flag || typeof flag !== 'object') {
    return '';
  }

  const eventName = typeof flag.event_name === 'string' ? flag.event_name.trim() : '';
  const eventDate = typeof flag.event_date === 'string' ? flag.event_date.trim() : '';
  const tag = typeof flag.flag === 'string' ? flag.flag.trim() : '';

  return [eventDate, eventName, tag ? `(${tag})` : ''].filter(Boolean).join(' ');
}

function extractEventDateFromKeyFlags(keyFlags) {
  if (!Array.isArray(keyFlags)) {
    return '未确认';
  }

  for (const item of keyFlags) {
    if (item && typeof item === 'object' && typeof item.event_date === 'string' && item.event_date.trim() !== '') {
      return item.event_date.trim();
    }
  }

  return '未确认';
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

function normalizePublicWebUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    return '';
  }

  try {
    const parsed = new URL(rawUrl.trim());
    const hostname = parsed.hostname.toLowerCase();
    const href = parsed.toString();

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return '';
    }

    return href;
  } catch {
    return '';
  }
}

async function validatePublicWebUrl(rawUrl) {
  const normalizedInput = normalizePublicWebUrl(rawUrl);
  if (normalizedInput === '') {
    return '';
  }

  const isGroundingRedirect =
    normalizedInput.includes('vertexaisearch.cloud.google.com') || normalizedInput.includes('/grounding-api-redirect/');

  if (isGroundingRedirect) {
    try {
      const response = await fetch(normalizedInput, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RiskExposureTool/1.0)',
          Accept: 'text/html,application/xhtml+xml'
        },
        signal: AbortSignal.timeout(5000)
      });

      if (!response.ok) {
        return '';
      }

      const resolved = normalizePublicWebUrl(response.url || '');
      if (resolved === '' || resolved.includes('vertexaisearch.cloud.google.com')) {
        return '';
      }

      return resolved;
    } catch {
      return '';
    }
  }

  const attempt = async (method) => {
    try {
      const response = await fetch(normalizedInput, {
        method,
        redirect: 'follow',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; RiskExposureTool/1.0)',
          Accept: 'text/html,application/xhtml+xml'
        },
        signal: AbortSignal.timeout(4000)
      });

      if (!response.ok) {
        return '';
      }

      const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
      if (contentType !== '' && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        return '';
      }

      return normalizePublicWebUrl(response.url || normalizedInput);
    } catch {
      return '';
    }
  };

  const headResult = await attempt('HEAD');
  if (headResult !== '') {
    return headResult;
  }

  return attempt('GET');
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
      publicUrl: normalizePublicWebUrl(item.url)
    }))
    .filter((item, index, list) => list.findIndex((candidate) => candidate.url === item.url) === index);
}

function pickBestPublicSourceLink(preferredSourceName, sources) {
  const publicSources = Array.isArray(sources) ? sources.filter((item) => item.publicUrl !== '') : [];
  if (publicSources.length === 0) {
    return '';
  }

  const preferred = typeof preferredSourceName === 'string' ? preferredSourceName.trim().toLowerCase() : '';
  if (preferred !== '' && preferred !== '未确认') {
    const matched = publicSources.find((item) => {
      const title = item.title.toLowerCase();
      const url = item.publicUrl.toLowerCase();
      return title.includes(preferred) || url.includes(preferred.replace(/\s+/g, ''));
    });

    if (matched) {
      return matched.publicUrl;
    }
  }

  return publicSources[0].publicUrl;
}

async function resolveValidPublicSourceLink(preferredSourceName, sources, initialUrl = '') {
  const candidates = [];

  const normalizedInitial = normalizePublicWebUrl(initialUrl);
  if (normalizedInitial !== '') {
    candidates.push(normalizedInitial);
  }

  const preferred = pickBestPublicSourceLink(preferredSourceName, sources);
  if (preferred !== '' && !candidates.includes(preferred)) {
    candidates.push(preferred);
  }

  const publicSources = Array.isArray(sources) ? sources.filter((item) => item.publicUrl !== '') : [];
  for (const item of publicSources) {
    if (!candidates.includes(item.publicUrl)) {
      candidates.push(item.publicUrl);
    }
  }

  for (const candidate of candidates) {
    const validated = await validatePublicWebUrl(candidate);
    if (validated !== '') {
      return validated;
    }
  }

  return '';
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

async function analyzePreTradeWithGemini(payload) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const ticker = typeof payload?.ticker === 'string' ? payload.ticker.trim().toUpperCase() : '';
  if (ticker === '') {
    throw new Error('Ticker is required');
  }

  const marketContext = await fetchMarketMetrics(ticker);

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
            parts: [{ text: buildPreTradeGeminiPrompt(payload, marketContext) }]
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
  const currentPrice = Number(payload.current_price);
  const strike = Number(payload.put_strike);
  const premiumPerShare = Number(payload.premium_per_share);
  const contracts = Number(payload.contracts);
  const breakeven = strike - premiumPerShare;
  const netCostBasis = breakeven * contracts * 100;
  const maxProfit = premiumPerShare * contracts * 100;
  const riskAtTenPctDrop = netCostBasis * 0.1;

  parsed.calc = {
    max_profit: Number.isFinite(maxProfit) ? maxProfit.toFixed(2) : '0.00',
    risk_at_10pct_drop: Number.isFinite(riskAtTenPctDrop) ? riskAtTenPctDrop.toFixed(2) : '0.00'
  };

  if (!Array.isArray(parsed.fundamental_events)) {
    parsed.fundamental_events = [];
  }
  if (typeof parsed.current_iv_rank === 'number' && Number.isFinite(parsed.current_iv_rank)) {
    parsed.current_iv_rank = parsed.current_iv_rank.toFixed(1);
  } else if (typeof parsed.current_iv_rank !== 'string') {
    parsed.current_iv_rank = '未确认';
  }
  if (typeof parsed.iv_rank_note !== 'string') {
    parsed.iv_rank_note = '未获取到 IV Rank 说明';
  }
  if (typeof parsed.iv_rank_source !== 'string') {
    parsed.iv_rank_source = '未确认';
  }
  if (typeof parsed.iv_rank_time !== 'string') {
    parsed.iv_rank_time = '未确认';
  }
  if (typeof parsed.iv_rank_link !== 'string') {
    parsed.iv_rank_link = '';
  }
  if (typeof parsed.current_iv_check !== 'string') {
    parsed.current_iv_check = '未获取到 Current IV 判断';
  }
  if (typeof parsed.marsi_check !== 'string') {
    parsed.marsi_check = '未获取到 MA/RSI 判断';
  }
  if (typeof parsed.rsi_check !== 'string') {
    parsed.rsi_check = '未获取到 RSI 超卖判断';
  }
  if (typeof parsed.ma200_check !== 'string') {
    parsed.ma200_check = '未获取到 MA200 判断';
  }
  if (typeof parsed.next_earnings_date !== 'string') {
    parsed.next_earnings_date = '未确认';
  }
  if (typeof parsed.earnings_warning !== 'string') {
    parsed.earnings_warning = '未获取到财报日预警';
  }
  const ivRankLink = `${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(ticker)}/overview`;
  parsed.current_iv_rank =
    marketContext.iv_rank === null || !Number.isFinite(marketContext.iv_rank)
      ? parsed.current_iv_rank
      : marketContext.iv_rank.toFixed(1);
  parsed.iv_rank_source = marketContext.source.iv_rank ?? 'Barchart';
  parsed.iv_rank_time = marketContext.current_price_date ?? '未确认';
  parsed.iv_rank_link = ivRankLink;
  parsed.next_earnings_date = marketContext.next_earnings_date ?? parsed.next_earnings_date;

  const sources = [
    {
      title: `${ticker} Overview - Barchart`,
      url: ivRankLink
    },
    {
      title: `${ticker} Put/Call Ratios - Barchart`,
      url: `${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(ticker)}/put-call-ratios`
    }
  ];

  return {
    analysis: parsed,
    sources,
    market_context: marketContext
  };
}

async function analyzePreTradeContextWithGemini(payload) {
  const ticker = typeof payload?.ticker === 'string' ? payload.ticker.trim().toUpperCase() : '';
  if (ticker === '') {
    throw new Error('Ticker is required');
  }

  const marketContext = await fetchMarketMetrics(ticker);
  const overviewUrl = `${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(ticker)}/overview`;
  const pcrUrl = `${BARCHART_BASE_URL}/stocks/quotes/${encodeURIComponent(ticker)}/put-call-ratios`;
  const expirationDate = typeof payload?.expiration_date === 'string' ? payload.expiration_date : '';
  const includeSearch = payload?.include_search === true;

  const ivAssessment =
    marketContext.current_iv == null && marketContext.iv_rank == null
      ? '网站暂未拿到 IV 与 IV Rank'
      : `Current IV ${marketContext.current_iv == null ? '未确认' : `${(marketContext.current_iv * 100).toFixed(2)}%`}，IV Rank ${marketContext.iv_rank == null ? '未确认' : marketContext.iv_rank.toFixed(1)}，IV Percentile ${marketContext.iv_percentile == null ? '未确认' : marketContext.iv_percentile.toFixed(1)}`;

  const earningsAssessment =
    marketContext.next_earnings_date == null
      ? '网站暂未拿到财报日'
      : expirationDate !== '' && marketContext.next_earnings_date <= expirationDate
        ? `财报日 ${marketContext.next_earnings_date} 早于或落在到期日前，存在财报风险`
        : `财报日 ${marketContext.next_earnings_date} 晚于到期日，财报风险相对较小`;

  let specialWindowAssessment = '网站暂未直接提供特殊事件摘要';
  let fundamentalRiskAssessment = '网站暂未直接提供基本面风险摘要';
  let specialWindowSources = [];
  let fundamentalSources = [];
  let keyFlags = [];

  if (includeSearch && GEMINI_API_KEY) {
    const emptyFallback = { summary: '网站暂未直接提供摘要', keyFlags: [], sources: [] };
    const [specialWindowFallback, fundamentalFallback] = await Promise.all([
      withTimeout(
        runGeminiSearchFallback({
          ticker,
          topic: '公司事件窗口（财报、产品发布、促销、资本开支、组织调整）',
          expirationDate
        }),
        20000,
        emptyFallback
      ),
      withTimeout(
        runGeminiSearchFallback({
          ticker,
          topic: '基本面风险（最近利空新闻、需求放缓、利润率压力、竞争、执行或诉讼影响）',
          expirationDate
        }),
        20000,
        emptyFallback
      )
    ]);

    specialWindowAssessment =
      specialWindowFallback.eventDate && specialWindowFallback.eventDate !== '未确认'
        ? `${specialWindowFallback.summary}（${specialWindowFallback.eventDate}）`
        : specialWindowFallback.summary;
    fundamentalRiskAssessment =
      fundamentalFallback.eventDate && fundamentalFallback.eventDate !== '未确认'
        ? `${fundamentalFallback.summary}（${fundamentalFallback.eventDate}）`
        : fundamentalFallback.summary;
    specialWindowSources = specialWindowFallback.sources.slice(0, 1);
    fundamentalSources = fundamentalFallback.sources.slice(0, 1);
    keyFlags = [...specialWindowFallback.keyFlags, ...fundamentalFallback.keyFlags];

    if (specialWindowFallback.headline) {
      keyFlags.unshift(`相关新闻：${specialWindowFallback.headline}`);
    }
    if (fundamentalFallback.headline) {
      keyFlags.unshift(`基本面风险：${fundamentalFallback.headline}`);
    }
  }

  if (marketContext.next_earnings_date) {
    keyFlags.unshift(`财报日 ${marketContext.next_earnings_date}`);
  }

  keyFlags = keyFlags.filter((item, index, list) => typeof item === 'string' && item.trim() !== '' && list.indexOf(item) === index).slice(0, 6);

  return {
    summary: {
      iv_assessment: ivAssessment,
      earnings_assessment: earningsAssessment,
      special_window_assessment: specialWindowAssessment,
      fundamental_risk_assessment: fundamentalRiskAssessment,
      key_flags: keyFlags
    },
    partial: !includeSearch,
    sources: [
      { title: `${ticker} Overview - Barchart`, url: overviewUrl },
      { title: `${ticker} Put/Call Ratios - Barchart`, url: pcrUrl },
      ...specialWindowSources,
      ...fundamentalSources
    ].filter((item, index, list) => list.findIndex((candidate) => candidate.url === item.url) === index),
    source_map: {
      iv_assessment: [{ title: `${ticker} Overview - Barchart`, url: overviewUrl }],
      earnings_assessment: [{ title: `${ticker} Overview - Barchart`, url: overviewUrl }],
      special_window_assessment: specialWindowSources,
      fundamental_risk_assessment: fundamentalSources
    },
    marketContext
  };
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

async function fetchMarketMetrics(symbol) {
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
    if (typeof barchartSnapshot.next_earnings_date === 'string' && barchartSnapshot.next_earnings_date !== '') {
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
      if (earningsDate) {
        metrics.next_earnings_date = earningsDate;
        metrics.source.next_earnings_date = 'MarketData.app /stocks/earnings';
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

async function fetchCurrentOptionQuote(symbol, expirationDate, strike, side = 'put') {
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
        return snapshotQuote;
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
    gamma: sample.gamma
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
  const response = await fetchWithTimeout('https://cdn.cboe.com/api/global/us_indices/daily_prices/VIX_History.csv');
  const csv = await response.text();

  if (!response.ok) {
    throw new Error('Failed to fetch official VIX history');
  }

  const rows = csv
    .trim()
    .split(/\r?\n/)
    .map((line) => line.split(',').map((cell) => cell.trim()))
    .filter((cells) => cells.length >= 5);

  if (rows.length < 2) {
    throw new Error('Official VIX history is empty');
  }

  const header = rows[0].map((value) => value.toUpperCase());
  const dateIndex = header.findIndex((value) => value === 'DATE');
  const closeIndex = header.findIndex((value) => value === 'CLOSE');

  if (dateIndex === -1 || closeIndex === -1) {
    throw new Error('Unexpected VIX history format');
  }

  const latestRow = rows[rows.length - 1];
  const date = latestRow[dateIndex];
  const value = Number(latestRow[closeIndex]);

  if (!date || !Number.isFinite(value)) {
    throw new Error('Invalid official VIX daily close');
  }

  return {
    value,
    asOf: date
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

  return {
    version: 1,
    exported_at: typeof snapshot?.exported_at === 'string' ? snapshot.exported_at : exportedAt,
    data: {
      config: data.config ?? null,
      puts: Array.isArray(data.puts) ? data.puts : [],
      closedTrades: Array.isArray(data.closedTrades) ? data.closedTrades : [],
      stockTrades: Array.isArray(data.stockTrades) ? data.stockTrades : [],
      tickerList: Array.isArray(data.tickerList) ? data.tickerList : [],
      scenario: data.scenario ?? null,
      vixHistory: Array.isArray(data.vixHistory) ? data.vixHistory : [],
      accountValueHistory: Array.isArray(data.accountValueHistory) ? data.accountValueHistory : []
    }
  };
}

function computeSnapshotTotalCapital(snapshotData) {
  const cash = typeof snapshotData?.config?.cash === 'number' ? snapshotData.config.cash : 0;
  const stockValue = Array.isArray(snapshotData?.tickerList)
    ? snapshotData.tickerList.reduce((sum, entry) => {
        const shares = typeof entry?.shares === 'number' ? entry.shares : 0;
        const currentPrice = typeof entry?.current_price === 'number' ? entry.current_price : 0;
        return sum + shares * currentPrice;
      }, 0)
    : 0;
  const optionValue = Array.isArray(snapshotData?.puts)
    ? snapshotData.puts.reduce((sum, position) => {
        const marketPrice = typeof position?.option_market_price_per_share === 'number'
          ? position.option_market_price_per_share
          : 0;
        const contracts = typeof position?.contracts === 'number' ? position.contracts : 0;
        return sum + marketPrice * contracts * 100;
      }, 0)
    : 0;

  return cash + stockValue + optionValue;
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
  const totalSteps = staleTickerIndexes.length + staleOptionIndexes.length + (includeVix ? 1 : 0);
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
      include_vix: includeVix,
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
        const { quoteResult, rsiResult, rsi1hResult, ma21Result, ma200Result, currentIvResult, marketMetricsResult } =
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
        position.option_market_price_per_share = optionQuote.price;
        position.option_market_price_updated = nowIso;
        position.option_theta_per_share = optionQuote.theta;
        position.option_delta = optionQuote.delta;
        position.option_gamma = optionQuote.gamma;
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
  if (includeVix) {
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
  }

  let nextAccountValueHistory = normalizedSnapshot.data.accountValueHistory;
  try {
    nextAccountValueHistory = upsertDailyAccountValueHistory(
      normalizedSnapshot.data.accountValueHistory,
      computeSnapshotTotalCapital({
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

  const updatedSnapshot = {
    ...normalizedSnapshot,
    exported_at: nowIso,
    data: {
      ...normalizedSnapshot.data,
      tickerList: nextTickerList,
      puts: nextPuts,
      accountValueHistory: nextAccountValueHistory
    }
  };

  return {
    snapshot: updatedSnapshot,
    marketOpen,
    force,
    includeVix,
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
      const result = await analyzePreTradeWithGemini(payload);
      sendJson(res, 200, {
        ...result,
        as_of: new Date().toISOString(),
        source: 'Gemini 2.5 Flash + Barchart/MarketData structured snapshot'
      });
    } catch (error) {
      sendJson(res, 502, {
        error: error instanceof Error ? error.message : 'Gemini pre-trade analysis failed'
      });
    }
    return;
  }

  if (url.pathname === '/api/pre-trade-context' && req.method === 'POST') {
    try {
      const payload = await readJsonBody(req);
      const result = await analyzePreTradeContextWithGemini(payload);
      sendJson(res, 200, {
        ...result,
        as_of: new Date().toISOString(),
        source: 'Gemini 2.5 Flash + Google Search + Barchart/MarketData'
      });
    } catch (error) {
      sendJson(res, 502, {
        error: error instanceof Error ? error.message : 'Gemini pre-trade context failed'
      });
    }
    return;
  }

  if (url.pathname === '/api/vix' && req.method === 'GET') {
    try {
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
      await saveSnapshot(refreshResult.snapshot);
      const successStatusError = await saveRefreshStatusSafely({
        status: 'success',
        source,
        started_at: startedAt,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        market_open: refreshResult.marketOpen,
        force,
        include_vix: includeVix,
        total_steps: refreshResult.tickerResults.length + refreshResult.optionResults.length + (includeVix ? 1 : 0),
        completed_steps: refreshResult.tickerResults.length + refreshResult.optionResults.length + (includeVix ? 1 : 0),
        refreshed_tickers: refreshResult.refreshedTickers,
        refreshed_options: refreshResult.refreshedOptions,
        current_label: null,
        message: refreshResult.marketOpen || force ? '后台刷新完成' : '当前非盘中，仅刷新了 VIX / Fear & Greed',
        error: runningStatusError ?? null
      });

      sendJson(res, 200, {
        ok: true,
        ran_at: new Date().toISOString(),
        market_open: refreshResult.marketOpen,
        force,
        include_vix: includeVix,
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
      const existingSnapshot = await loadSavedSnapshot();

      if (!hasMeaningfulSnapshotData(incomingSnapshot) && hasMeaningfulSnapshotData(existingSnapshot)) {
        sendJson(res, 409, {
          error: 'Refusing to overwrite existing app state with an empty snapshot'
        });
        return;
      }

      await saveSnapshot(payload);
      const storageTarget = describeStorageTarget();
      sendJson(res, 200, {
        ok: true,
        saved_at: new Date().toISOString(),
        storage: storageTarget
      });
    } catch (error) {
      sendJson(res, 500, { error: error instanceof Error ? error.message : 'Failed to save app state' });
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
          source: 'MarketData.app /options/quotes'
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
    const currentIv = {};
    const nextEarningsDate = {};
    const historicalIv = {};
    const ivRank = {};
    const ivPercentile = {};
    const putCallRatio = {};
    const errors = {};

    for (const requestItem of requests) {
      const { quoteResult, rsiResult, rsi1hResult, ma21Result, ma200Result, currentIvResult, marketMetricsResult } = await fetchQuoteBundle(requestItem);

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
