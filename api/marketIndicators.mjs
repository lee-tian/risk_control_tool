export function extractCloseSeries(data) {
  if (!data || data.s !== 'ok' || !Array.isArray(data.c)) {
    return [];
  }

  return data.c
    .map((value) => {
      if (typeof value === 'number') {
        return value;
      }
      if (typeof value === 'string' && value.trim() !== '') {
        return Number(value);
      }
      return NaN;
    })
    .filter((value) => Number.isFinite(value));
}

function parseKlineNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const numeric = Number(value.trim());
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeKlineTime(value) {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim();
}

export function extractMoomooKlineRows(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];

  return rows
    .map((row) => {
      const time = normalizeKlineTime(row?.time);
      const open = parseKlineNumber(row?.open);
      const high = parseKlineNumber(row?.high);
      const low = parseKlineNumber(row?.low);
      const close = parseKlineNumber(row?.close);
      const volume = parseKlineNumber(row?.volume) ?? 0;

      if (time === '' || open === null || high === null || low === null || close === null) {
        return null;
      }

      return { time, open, high, low, close, volume };
    })
    .filter(Boolean)
    .sort((left, right) => left.time.localeCompare(right.time));
}

function isPivotLow(rows, index, windowSize) {
  const pivot = rows[index];
  if (!pivot) {
    return false;
  }

  for (let offset = 1; offset <= windowSize; offset += 1) {
    const left = rows[index - offset];
    const right = rows[index + offset];
    if (!left || !right || pivot.low > left.low || pivot.low > right.low) {
      return false;
    }
  }

  return true;
}

function isPivotHigh(rows, index, windowSize) {
  const pivot = rows[index];
  if (!pivot) {
    return false;
  }

  for (let offset = 1; offset <= windowSize; offset += 1) {
    const left = rows[index - offset];
    const right = rows[index + offset];
    if (!left || !right || pivot.high < left.high || pivot.high < right.high) {
      return false;
    }
  }

  return true;
}

function buildLevelClusters(levels, tolerancePct) {
  if (levels.length === 0) {
    return [];
  }

  const sorted = [...levels].sort((left, right) => left.price - right.price);
  const clusters = [];

  for (const level of sorted) {
    const previous = clusters[clusters.length - 1];
    if (
      previous &&
      Math.abs(level.price - previous.price) / Math.max(previous.price, 1) <= tolerancePct
    ) {
      const combinedStrength = previous.strength + level.strength;
      previous.price = ((previous.price * previous.strength) + (level.price * level.strength)) / combinedStrength;
      previous.strength = combinedStrength;
      previous.sources = [...new Set([...previous.sources, ...level.sources])];
      continue;
    }

    clusters.push({
      price: level.price,
      strength: level.strength,
      sources: [...level.sources]
    });
  }

  return clusters.map((cluster) => ({
    price: cluster.price,
    strength: cluster.strength,
    source: cluster.sources.join(' + ')
  }));
}

export function analyzeKlineLevels(rows, currentPrice = null, options = {}) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (normalizedRows.length === 0) {
    return {
      asOf: null,
      currentPrice: Number.isFinite(currentPrice) ? currentPrice : null,
      supportLevels: [],
      resistanceLevels: [],
      nearestSupport: null,
      nearestResistance: null
    };
  }

  const recentWindow = Number.isFinite(options.recentWindow) ? Math.max(5, options.recentWindow) : 20;
  const longWindow = Number.isFinite(options.longWindow) ? Math.max(recentWindow, options.longWindow) : 60;
  const pivotWindow = Number.isFinite(options.pivotWindow) ? Math.max(1, options.pivotWindow) : 2;
  const tolerancePct = Number.isFinite(options.tolerancePct) ? Math.max(0.001, options.tolerancePct) : 0.01;
  const levels = {
    support: [],
    resistance: []
  };

  const lastRow = normalizedRows[normalizedRows.length - 1];
  const referencePrice = Number.isFinite(currentPrice) && currentPrice > 0 ? currentPrice : lastRow.close;

  const pushLevel = (side, price, source, strength = 1) => {
    if (!Number.isFinite(price) || price <= 0) {
      return;
    }
    levels[side].push({
      price,
      strength,
      sources: [source]
    });
  };

  const trailingRecent = normalizedRows.slice(-recentWindow);
  const trailingLong = normalizedRows.slice(-longWindow);
  const recentLow = trailingRecent.reduce((best, row) => Math.min(best, row.low), Number.POSITIVE_INFINITY);
  const recentHigh = trailingRecent.reduce((best, row) => Math.max(best, row.high), Number.NEGATIVE_INFINITY);
  const longLow = trailingLong.reduce((best, row) => Math.min(best, row.low), Number.POSITIVE_INFINITY);
  const longHigh = trailingLong.reduce((best, row) => Math.max(best, row.high), Number.NEGATIVE_INFINITY);

  pushLevel('support', recentLow, `${trailingRecent.length}D low`, 2);
  pushLevel('resistance', recentHigh, `${trailingRecent.length}D high`, 2);
  pushLevel('support', longLow, `${trailingLong.length}D low`, 3);
  pushLevel('resistance', longHigh, `${trailingLong.length}D high`, 3);

  for (let index = pivotWindow; index < normalizedRows.length - pivotWindow; index += 1) {
    const row = normalizedRows[index];
    if (isPivotLow(normalizedRows, index, pivotWindow)) {
      pushLevel('support', row.low, 'swing low', 1);
    }
    if (isPivotHigh(normalizedRows, index, pivotWindow)) {
      pushLevel('resistance', row.high, 'swing high', 1);
    }
  }

  const supportLevels = buildLevelClusters(levels.support, tolerancePct)
    .filter((level) => level.price < referencePrice)
    .sort((left, right) => right.price - left.price);
  const resistanceLevels = buildLevelClusters(levels.resistance, tolerancePct)
    .filter((level) => level.price > referencePrice)
    .sort((left, right) => left.price - right.price);

  return {
    asOf: typeof lastRow.time === 'string' && lastRow.time !== '' ? lastRow.time.slice(0, 10) : null,
    currentPrice: referencePrice,
    supportLevels,
    resistanceLevels,
    nearestSupport: supportLevels[0] ?? null,
    nearestResistance: resistanceLevels[0] ?? null
  };
}

export function calculateSma(closes, period) {
  if (!Array.isArray(closes) || closes.length < period || period <= 0) {
    return null;
  }

  const window = closes.slice(-period);
  const total = window.reduce((sum, value) => sum + value, 0);
  return total / period;
}

export function calculateRsi(closes, period = 14) {
  if (!Array.isArray(closes) || closes.length <= period || period <= 0) {
    return null;
  }

  let gains = 0;
  let losses = 0;

  for (let index = 1; index <= period; index += 1) {
    const change = closes[index] - closes[index - 1];
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let index = period + 1; index < closes.length; index += 1) {
    const change = closes[index] - closes[index - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;
    averageGain = ((averageGain * (period - 1)) + gain) / period;
    averageLoss = ((averageLoss * (period - 1)) + loss) / period;
  }

  if (averageLoss === 0) {
    return averageGain === 0 ? 50 : 100;
  }

  const relativeStrength = averageGain / averageLoss;
  return 100 - (100 / (1 + relativeStrength));
}

/**
 * Calculates Average True Range (ATR) using Wilder's smoothing method.
 * @param {Array<{high: number, low: number, close: number}>} rows - OHLC rows sorted chronologically
 * @param {number} period - ATR period (default 14)
 * @returns {number | null} ATR value or null if insufficient data
 */
export function calculateAtr(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length <= period || period <= 0) {
    return null;
  }

  // Compute true ranges
  const trueRanges = [];
  for (let i = 1; i < rows.length; i += 1) {
    const current = rows[i];
    const previous = rows[i - 1];
    if (
      typeof current.high !== 'number' ||
      typeof current.low !== 'number' ||
      typeof previous.close !== 'number'
    ) {
      continue;
    }
    const tr = Math.max(
      current.high - current.low,
      Math.abs(current.high - previous.close),
      Math.abs(current.low - previous.close)
    );
    trueRanges.push(tr);
  }

  if (trueRanges.length < period) {
    return null;
  }

  // Initial ATR = simple average of first `period` TRs
  let atr = trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;

  // Wilder's smoothing for remaining TRs
  for (let i = period; i < trueRanges.length; i += 1) {
    atr = ((atr * (period - 1)) + trueRanges[i]) / period;
  }

  return Number.isFinite(atr) ? atr : null;
}

