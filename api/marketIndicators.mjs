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
