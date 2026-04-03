import type { VixHistoryPoint } from '../types';

export type VixTrendMode = 'rising' | 'falling' | 'sideways' | 'neutral';

export type VixTrendAnalysis = {
  adjustment: number;
  mode: VixTrendMode;
  note: string;
  action: string;
  sevenDayAverage: number | null;
};

function average(points: VixHistoryPoint[]): number | null {
  if (points.length === 0) {
    return null;
  }
  return points.reduce((sum, point) => sum + point.value, 0) / points.length;
}

export function analyzeVixTrend(history: VixHistoryPoint[]): VixTrendAnalysis {
  const latest = history[history.length - 1];
  if (!latest) {
    return { adjustment: 0, mode: 'neutral', note: '等待 VIX 历史数据', action: '请先刷新 VIX', sevenDayAverage: null };
  }

  const lastSeven = history.slice(-7);
  const lastFive = history.slice(-5);
  const lastTwenty = history.slice(-20);
  const latestValue = latest.value;
  const sevenDayAverage = average(lastSeven);
  const shortAverage = average(lastFive) ?? latestValue;
  const longAverage = average(lastTwenty) ?? shortAverage;
  const shortStart = lastFive[0]?.value ?? latestValue;
  const shortSlopePct = shortStart > 0 ? (latestValue - shortStart) / shortStart : 0;
  const spreadPct = longAverage > 0 ? (shortAverage - longAverage) / longAverage : 0;
  const recentValues = lastFive.map((point) => point.value);
  const recentMax = recentValues.length > 0 ? Math.max(...recentValues) : latestValue;
  const recentMin = recentValues.length > 0 ? Math.min(...recentValues) : latestValue;
  const recentRangePct = shortAverage > 0 ? (recentMax - recentMin) / shortAverage : 0;

  let mode: VixTrendMode = 'sideways';
  if ((spreadPct >= 0.04 && shortSlopePct >= 0.03) || shortSlopePct >= 0.08) {
    mode = 'rising';
  } else if ((spreadPct <= -0.04 && shortSlopePct <= -0.03) || shortSlopePct <= -0.08) {
    mode = 'falling';
  } else if (recentRangePct <= 0.09 && Math.abs(shortSlopePct) < 0.035 && Math.abs(spreadPct) < 0.04) {
    mode = 'sideways';
  } else if (shortSlopePct > 0.02 || spreadPct > 0.03) {
    mode = 'rising';
  } else if (shortSlopePct < -0.02 || spreadPct < -0.03) {
    mode = 'falling';
  }

  let adjustment = 0;
  if (latestValue < 20) {
    adjustment += 0.04;
  } else if (latestValue < 25) {
    adjustment += 0.015;
  } else if (latestValue < 30) {
    adjustment += 0;
  } else if (latestValue >= 40) {
    adjustment += 0.04;
  }

  if (mode === 'rising') {
    adjustment += 0.02;
  } else if (mode === 'falling') {
    adjustment -= 0.015;
  }

  const trendLabel =
    mode === 'rising'
      ? spreadPct > 0.08
        ? 'VIX 明显上行'
        : 'VIX 温和上行'
      : mode === 'falling'
        ? spreadPct < -0.08
          ? 'VIX 明显回落'
          : 'VIX 温和回落'
        : 'VIX 区间震荡';

  const action =
    latestValue < 20
      ? '低 VIX（<20）：尽量不要卖'
      : latestValue < 25
        ? mode === 'rising'
          ? 'VIX 20-25 且上行：少卖'
          : mode === 'falling'
            ? 'VIX 20-25 且回落：中性偏谨慎'
            : 'VIX 20-25：少卖'
        : latestValue < 30
          ? mode === 'sideways'
            ? 'VIX 25-30 且区间震荡：可以多卖一些 put'
            : mode === 'falling'
              ? 'VIX 25-30 且回落：可以多卖一点'
              : 'VIX 25-30 且上行：偏保守，少卖'
          : latestValue < 40
            ? mode === 'rising'
              ? 'VIX 30-40 且上行：偏保守，少卖'
              : mode === 'falling'
                ? 'VIX 30-40 且回落：可以多卖一点'
                : 'VIX 30-40 且震荡：中性，择机卖'
            : 'VIX > 40：先不要卖，等确认回落';

  return {
    adjustment,
    mode,
    note: `${trendLabel}，5D/20D 均线差 ${spreadPct >= 0 ? '+' : ''}${(spreadPct * 100).toFixed(1)}%，7 天均值 ${
      sevenDayAverage === null ? '-' : sevenDayAverage.toFixed(2)
    }`,
    action,
    sevenDayAverage
  };
}
