import { fileURLToPath } from 'node:url';

import {
  getMoomooUnderlying,
  normalizeOptionSide,
  parseNumericValue,
  resolveMoomooScriptPath,
  runMoomooJsonScript
} from './moomooScripts.mjs';
import { analyzeKlineLevels, extractMoomooKlineRows } from './marketIndicators.mjs';

const DEFAULT_OPTION_CHAIN_SCRIPT =
  process.env.MOOMOO_GET_OPTION_CHAIN_SCRIPT ||
  resolveMoomooScriptPath('quote/get_option_chain.py');
const DEFAULT_OPTION_EXPIRATIONS_SCRIPT =
  process.env.MOOMOO_GET_OPTION_EXPIRATION_DATE_SCRIPT ||
  resolveMoomooScriptPath('quote/get_option_expiration_date.py');
const DEFAULT_OPTION_SNAPSHOTS_SCRIPT =
  process.env.MOOMOO_GET_OPTION_SNAPSHOTS_SCRIPT ||
  fileURLToPath(new URL('./scripts/get_moomoo_option_snapshots.py', import.meta.url));
const DEFAULT_KLINE_SCRIPT =
  process.env.MOOMOO_GET_KLINE_SCRIPT ||
  resolveMoomooScriptPath('quote/get_kline.py');

const TARGET_RECOMMENDATION_DTE = Number(process.env.PRE_TRADE_TARGET_DTE ?? 45);
const MIN_RECOMMENDATION_DTE = Number(process.env.PRE_TRADE_MIN_DTE ?? 35);
const MAX_RECOMMENDATION_DTE = Number(process.env.PRE_TRADE_MAX_DTE ?? 60);
const MIN_TARGET_DELTA = Number(process.env.PRE_TRADE_MIN_DELTA ?? 0.1);
const MAX_TARGET_DELTA = Number(process.env.PRE_TRADE_MAX_DELTA ?? 0.2);
const MIN_TARGET_OTM_PCT = Number(process.env.PRE_TRADE_MIN_OTM_PCT ?? 5);
const MAX_TARGET_OTM_PCT = Number(process.env.PRE_TRADE_MAX_OTM_PCT ?? 10);
const KLINE_LOOKBACK_DAYS = Number(process.env.PRE_TRADE_KLINE_LOOKBACK_DAYS ?? 180);

function pickPrice(row) {
  const last = parseNumericValue(row?.last_price);
  const bid = parseNumericValue(row?.bid_price ?? row?.bid);
  const ask = parseNumericValue(row?.ask_price ?? row?.ask);

  if (last !== null && last > 0) {
    return last;
  }
  if (bid !== null && bid > 0 && ask !== null && ask > 0) {
    return (bid + ask) / 2;
  }
  if (ask !== null && ask > 0) {
    return ask;
  }
  if (bid !== null && bid > 0) {
    return bid;
  }
  return null;
}

function normalizeSnapshotRow(row) {
  const side = normalizeOptionSide(row?.option_type);
  const strike = parseNumericValue(row?.option_strike_price ?? row?.strike_price ?? row?.strike);
  if (!side || strike === null) {
    return null;
  }

  const bid = parseNumericValue(row?.bid_price ?? row?.bid);
  const ask = parseNumericValue(row?.ask_price ?? row?.ask);
  const price = pickPrice(row);
  const mid = bid !== null && ask !== null && bid > 0 && ask > 0 ? (bid + ask) / 2 : price;
  const spreadAbs = bid !== null && ask !== null && ask >= bid ? ask - bid : null;
  const spreadPct = mid !== null && mid > 0 && spreadAbs !== null ? (spreadAbs / mid) * 100 : null;

  return {
    code: typeof row?.code === 'string' ? row.code.trim() : '',
    side,
    strike,
    expirationDate: typeof row?.strike_time === 'string' ? row.strike_time.trim().slice(0, 10) : '',
    openInterest: parseNumericValue(row?.option_open_interest ?? row?.open_interest) ?? 0,
    impliedVolatility: parseNumericValue(row?.option_implied_volatility ?? row?.implied_volatility),
    delta: parseNumericValue(row?.option_delta ?? row?.delta),
    gamma: parseNumericValue(row?.option_gamma ?? row?.gamma),
    theta: parseNumericValue(row?.option_theta ?? row?.theta),
    volume: parseNumericValue(row?.volume) ?? 0,
    bid,
    ask,
    lastPrice: parseNumericValue(row?.last_price),
    price,
    spreadPct,
    updateTime: typeof row?.update_time === 'string' ? row.update_time.trim() : ''
  };
}

function buildCluster(rows, side) {
  const candidates = rows.filter((row) => row.side === side && row.openInterest > 0);
  if (candidates.length === 0) {
    return null;
  }

  const top = [...candidates].sort((left, right) => {
    if (right.openInterest !== left.openInterest) {
      return right.openInterest - left.openInterest;
    }
    return left.strike - right.strike;
  })[0];

  return {
    strike: top.strike,
    openInterest: top.openInterest
  };
}

function normalizeDeltaForSide(row, side) {
  if (row.delta === null) {
    return null;
  }

  return side === 'put' ? Math.abs(row.delta) : row.delta;
}

function calculateOtmPct(row, side, currentPrice) {
  if (currentPrice === null || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    return null;
  }

  if (side === 'put') {
    return ((currentPrice - row.strike) / currentPrice) * 100;
  }

  return ((row.strike - currentPrice) / currentPrice) * 100;
}

function scoreDelta(deltaAbs) {
  if (deltaAbs === null) {
    return 0;
  }

  if (deltaAbs >= MIN_TARGET_DELTA && deltaAbs <= MAX_TARGET_DELTA) {
    return 70 + ((MAX_TARGET_DELTA - deltaAbs) / Math.max(MAX_TARGET_DELTA - MIN_TARGET_DELTA, 0.001)) * 30;
  }
  if (deltaAbs < MIN_TARGET_DELTA) {
    return Math.max(0, 65 - ((MIN_TARGET_DELTA - deltaAbs) / MIN_TARGET_DELTA) * 35);
  }

  return Math.max(0, 65 - ((deltaAbs - MAX_TARGET_DELTA) / MAX_TARGET_DELTA) * 65);
}

function scoreOtm(otmPct) {
  if (otmPct === null) {
    return 0;
  }
  if (otmPct <= 0) {
    return 0;
  }
  if (otmPct < MIN_TARGET_OTM_PCT) {
    return (otmPct / MIN_TARGET_OTM_PCT) * 60;
  }
  if (otmPct <= MAX_TARGET_OTM_PCT) {
    return 60 + ((otmPct - MIN_TARGET_OTM_PCT) / Math.max(MAX_TARGET_OTM_PCT - MIN_TARGET_OTM_PCT, 0.001)) * 40;
  }
  if (otmPct <= MAX_TARGET_OTM_PCT + 5) {
    return 100 - ((otmPct - MAX_TARGET_OTM_PCT) / 5) * 20;
  }

  return Math.max(0, 80 - (otmPct - (MAX_TARGET_OTM_PCT + 5)) * 5);
}

function getReferenceLevel(side, klineLevels, cluster) {
  if (side === 'put') {
    return klineLevels?.nearestSupport?.price ?? cluster?.strike ?? null;
  }

  return klineLevels?.nearestResistance?.price ?? cluster?.strike ?? null;
}

function getReferenceLevelType(side, klineLevels, cluster) {
  if (side === 'put') {
    if (klineLevels?.nearestSupport?.price != null) {
      return 'support';
    }
    return cluster ? 'support' : null;
  }

  if (klineLevels?.nearestResistance?.price != null) {
    return 'resistance';
  }
  return cluster ? 'resistance' : null;
}

function scoreReferenceLevel(row, side, referenceLevel) {
  if (referenceLevel === null || !Number.isFinite(referenceLevel) || referenceLevel <= 0) {
    return {
      score: 50,
      outsideLevel: null,
      distancePct: null
    };
  }

  const distancePct =
    side === 'put'
      ? ((referenceLevel - row.strike) / referenceLevel) * 100
      : ((row.strike - referenceLevel) / referenceLevel) * 100;
  const outsideLevel = distancePct >= 0;

  if (outsideLevel) {
    return {
      score: 75 + Math.min(distancePct, 5) * 5,
      outsideLevel,
      distancePct
    };
  }

  return {
    score: Math.max(0, 55 + distancePct * 20),
    outsideLevel,
    distancePct
  };
}

function scoreLiquidity(row, maxOpenInterest) {
  const oiScore = maxOpenInterest > 0 ? (row.openInterest / maxOpenInterest) * 100 : 0;
  const spread = row.spreadPct ?? 20;
  const spreadScore = spread <= 3 ? 100 : spread <= 5 ? 85 : spread <= 10 ? 60 : Math.max(0, 60 - (spread - 10) * 5);
  return oiScore * 0.7 + spreadScore * 0.3;
}

function formatSelectionBasis(deltaAbs, otmPct, outsideLevel, referenceLevelType) {
  const basis = [];

  if (deltaAbs !== null && deltaAbs >= MIN_TARGET_DELTA && deltaAbs <= MAX_TARGET_DELTA) {
    basis.push(`Delta ${deltaAbs.toFixed(2)}`);
  }
  if (otmPct !== null && otmPct >= MIN_TARGET_OTM_PCT && otmPct <= MAX_TARGET_OTM_PCT) {
    basis.push(`${otmPct.toFixed(2)}% OTM`);
  }
  if (outsideLevel === true && referenceLevelType) {
    basis.push(referenceLevelType === 'support' ? '位于支撑外侧' : '位于压力外侧');
  }

  return basis;
}

function scoreSideCandidate(row, side, currentPrice, maxOpenInterest, supportCluster, resistanceCluster, klineLevels) {
  const deltaAbs = normalizeDeltaForSide(row, side);
  const otmPct = calculateOtmPct(row, side, currentPrice);
  const referenceCluster = side === 'put' ? supportCluster : resistanceCluster;
  const referenceLevel = getReferenceLevel(side, klineLevels, referenceCluster);
  const referenceLevelType = getReferenceLevelType(side, klineLevels, referenceCluster);
  const referenceLevelScore = scoreReferenceLevel(row, side, referenceLevel);
  const scoreBreakdown = {
    delta_score: scoreDelta(deltaAbs),
    otm_score: scoreOtm(otmPct),
    level_score: referenceLevelScore.score,
    liquidity_score: scoreLiquidity(row, maxOpenInterest)
  };
  const totalScore =
    scoreBreakdown.delta_score * 0.3 +
    scoreBreakdown.otm_score * 0.35 +
    scoreBreakdown.level_score * 0.2 +
    scoreBreakdown.liquidity_score * 0.15;

  return {
    ...row,
    deltaAbs,
    distancePct: otmPct,
    score: Number(totalScore.toFixed(2)),
    scoreBreakdown: Object.fromEntries(
      Object.entries(scoreBreakdown).map(([key, value]) => [key, Number(value.toFixed(2))])
    ),
    outsideLevel: referenceLevelScore.outsideLevel,
    referenceLevel,
    referenceLevelType,
    levelDistancePct: referenceLevelScore.distancePct,
    selectionBasis: formatSelectionBasis(deltaAbs, otmPct, referenceLevelScore.outsideLevel, referenceLevelType)
  };
}

function rankSideCandidates(rows, side, currentPrice, supportCluster, resistanceCluster, klineLevels) {
  const candidates = rows.filter((row) => row.side === side && row.openInterest > 0);
  const maxOpenInterest = candidates.reduce((best, row) => Math.max(best, row.openInterest), 0);

  return candidates
    .map((row) => scoreSideCandidate(row, side, currentPrice, maxOpenInterest, supportCluster, resistanceCluster, klineLevels))
    .filter((row) => row.distancePct === null || row.distancePct > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if ((right.distancePct ?? -1) !== (left.distancePct ?? -1)) {
        return (right.distancePct ?? -1) - (left.distancePct ?? -1);
      }
      if (right.openInterest !== left.openInterest) {
        return right.openInterest - left.openInterest;
      }
      const leftSpread = left.spreadPct ?? Number.POSITIVE_INFINITY;
      const rightSpread = right.spreadPct ?? Number.POSITIVE_INFINITY;
      if (leftSpread !== rightSpread) {
        return leftSpread - rightSpread;
      }
      return side === 'put' ? left.strike - right.strike : right.strike - left.strike;
    });
}

function buildRiskWarnings(recommended, supportCluster, resistanceCluster, currentPrice, klineLevels) {
  const warnings = [];
  if (!recommended) {
    warnings.push('当前到期日没有找到同时满足 Delta、OTM、或关键位外侧条件的可推荐合约。');
    return warnings;
  }

  if (recommended.spreadPct !== null && recommended.spreadPct > 5) {
    warnings.push(`该合约买卖价差约 ${recommended.spreadPct.toFixed(2)}%，偏宽。`);
  }
  if (recommended.openInterest > 0 && recommended.volume / recommended.openInterest >= 0.5) {
    warnings.push(`该合约成交量 ${Math.round(recommended.volume)} / OI ${Math.round(recommended.openInterest)}，成交偏热。`);
  }
  if (recommended.deltaAbs !== null && (recommended.deltaAbs < MIN_TARGET_DELTA || recommended.deltaAbs > MAX_TARGET_DELTA)) {
    warnings.push(`该合约 Delta ${recommended.deltaAbs.toFixed(2)} 未落在 ${MIN_TARGET_DELTA.toFixed(2)}-${MAX_TARGET_DELTA.toFixed(2)} 目标区间。`);
  }
  if (
    recommended.distancePct !== null &&
    (recommended.distancePct < MIN_TARGET_OTM_PCT || recommended.distancePct > MAX_TARGET_OTM_PCT)
  ) {
    warnings.push(`该合约距现价 ${recommended.distancePct.toFixed(2)}%，未落在 ${MIN_TARGET_OTM_PCT}-${MAX_TARGET_OTM_PCT}% OTM 理想区间。`);
  }

  const nearestSupport = klineLevels?.nearestSupport?.price ?? supportCluster?.strike ?? null;
  const nearestResistance = klineLevels?.nearestResistance?.price ?? resistanceCluster?.strike ?? null;
  if (currentPrice !== null && recommended.side === 'put' && nearestSupport !== null && recommended.strike > nearestSupport) {
    warnings.push('候选 Put 行权价仍在关键支撑上方，卖出会更激进。');
  }
  if (currentPrice !== null && recommended.side === 'call' && nearestResistance !== null && recommended.strike < nearestResistance) {
    warnings.push('候选 Call 行权价仍在关键压力下方，卖出会更激进。');
  }

  return warnings;
}

function normalizeExpirationDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return trimmed;
  }

  const parsed = new Date(trimmed);
  if (!Number.isFinite(parsed.getTime())) {
    return null;
  }

  return parsed.toISOString().slice(0, 10);
}

function getDte(expirationDate, tradeDate) {
  const expiry = new Date(`${expirationDate}T00:00:00Z`);
  const base = new Date(`${tradeDate}T00:00:00Z`);
  const diffMs = expiry.getTime() - base.getTime();
  if (!Number.isFinite(diffMs)) {
    return null;
  }

  return Math.round(diffMs / (1000 * 60 * 60 * 24));
}

export function rankExpirationCandidates(expirations, tradeDate) {
  return expirations
    .map((expirationDate) => {
      const dte = getDte(expirationDate, tradeDate);
      if (dte === null || dte < 0) {
        return null;
      }

      const inPreferredWindow = dte >= MIN_RECOMMENDATION_DTE && dte <= MAX_RECOMMENDATION_DTE;
      const distanceToTarget = Math.abs(dte - TARGET_RECOMMENDATION_DTE);
      return {
        expirationDate,
        dte,
        inPreferredWindow,
        distanceToTarget
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      if (left.inPreferredWindow !== right.inPreferredWindow) {
        return left.inPreferredWindow ? -1 : 1;
      }
      if (left.distanceToTarget !== right.distanceToTarget) {
        return left.distanceToTarget - right.distanceToTarget;
      }
      return left.expirationDate.localeCompare(right.expirationDate);
    });
}

function scoreRecommendation(summary, dte) {
  const candidate = summary.recommendedCandidate;
  const hasCandidate = candidate ? 1 : 0;
  const dtePenalty = Math.abs(dte - TARGET_RECOMMENDATION_DTE);
  const candidateScore = candidate?.score ?? 0;
  const warningPenalty = summary.warnings.length;

  return hasCandidate * 1_000_000 + candidateScore * 1_000 - dtePenalty * 50 - warningPenalty * 40;
}

export function summarizeMoomooOptionChain(rows, side, currentPrice = null, klineLevels = null) {
  const supportCluster = buildCluster(rows, 'put');
  const resistanceCluster = buildCluster(rows, 'call');
  const sideCandidates = rankSideCandidates(
    rows,
    side,
    currentPrice,
    supportCluster,
    resistanceCluster,
    klineLevels
  ).slice(0, 5);
  const recommendedCandidate = sideCandidates[0] ?? null;

  return {
    supportCluster,
    resistanceCluster,
    klineLevels,
    candidates: sideCandidates,
    recommendedCandidate,
    warnings: buildRiskWarnings(recommendedCandidate, supportCluster, resistanceCluster, currentPrice, klineLevels)
  };
}

export async function fetchMoomooOptionExpirations(symbol, { execFileImpl } = {}) {
  const underlying = getMoomooUnderlying(symbol);
  const payload = await runMoomooJsonScript(DEFAULT_OPTION_EXPIRATIONS_SCRIPT, [underlying, '--json'], { execFileImpl });
  const expirations = (Array.isArray(payload?.data) ? payload.data : [])
    .map((row) => normalizeExpirationDate(row?.strike_time ?? row?.expiration_date ?? row?.date))
    .filter(Boolean);

  if (expirations.length === 0) {
    throw new Error(`Moomoo option expirations unavailable for ${underlying}`);
  }

  return {
    underlying,
    expirations: [...new Set(expirations)].sort((left, right) => left.localeCompare(right))
  };
}

function offsetDate(dateInput, days) {
  const date = new Date(`${dateInput}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function fetchMoomooDailyKline(symbol, tradeDate, { execFileImpl } = {}) {
  const underlying = getMoomooUnderlying(symbol);
  const endDate = normalizeExpirationDate(tradeDate) ?? new Date().toISOString().slice(0, 10);
  const startDate = offsetDate(endDate, -KLINE_LOOKBACK_DAYS);
  const payload = await runMoomooJsonScript(
    DEFAULT_KLINE_SCRIPT,
    [
      underlying,
      '--ktype',
      '1d',
      '--num',
      String(Math.min(Math.max(KLINE_LOOKBACK_DAYS, 30), 1000)),
      '--start',
      startDate,
      '--end',
      endDate,
      '--rehab',
      'forward',
      '--json'
    ],
    { execFileImpl }
  );
  const rows = extractMoomooKlineRows(payload);

  if (rows.length === 0) {
    throw new Error(`Moomoo historical kline unavailable for ${underlying}`);
  }

  return {
    underlying,
    interval: '1d',
    lookbackDays: KLINE_LOOKBACK_DAYS,
    startDate,
    endDate,
    rows
  };
}

export async function fetchRecommendedMoomooOptionPlan(symbol, side, tradeDate, currentPrice = null, { execFileImpl } = {}) {
  const expirationPayload = await fetchMoomooOptionExpirations(symbol, { execFileImpl });
  const rankedExpirations = rankExpirationCandidates(expirationPayload.expirations, tradeDate).slice(0, 6);

  if (rankedExpirations.length === 0) {
    throw new Error(`No future option expirations available for ${expirationPayload.underlying}`);
  }

  const klineSnapshot = await fetchMoomooDailyKline(symbol, tradeDate, { execFileImpl }).catch(() => null);
  const klineLevels = klineSnapshot
    ? analyzeKlineLevels(klineSnapshot.rows, currentPrice, { recentWindow: 20, longWindow: 60, pivotWindow: 2 })
    : null;
  const effectiveCurrentPrice = currentPrice ?? klineLevels?.currentPrice ?? null;
  let fallbackPlan = null;

  for (const item of rankedExpirations) {
    try {
      const snapshot = await fetchMoomooOptionChainSnapshot(symbol, item.expirationDate, { execFileImpl });
      const summary = summarizeMoomooOptionChain(snapshot.rows, side, effectiveCurrentPrice, klineLevels);
      const plan = {
        expirationDate: item.expirationDate,
        dte: item.dte,
        snapshot,
        klineSnapshot,
        summary,
        score: scoreRecommendation(summary, item.dte)
      };

      if (!fallbackPlan) {
        fallbackPlan = plan;
      }

      if (summary.recommendedCandidate) {
        return plan;
      }
    } catch {
      // Try the next expiry candidate.
    }
  }

  if (!fallbackPlan) {
    throw new Error(`Unable to build moomoo recommendation plan for ${expirationPayload.underlying}`);
  }

  return fallbackPlan;
}

export async function fetchMoomooOptionChainSnapshot(symbol, expirationDate, { execFileImpl } = {}) {
  const underlying = getMoomooUnderlying(symbol);
  const chainPayload = await runMoomooJsonScript(
    DEFAULT_OPTION_CHAIN_SCRIPT,
    [underlying, '--start', expirationDate, '--end', expirationDate, '--json'],
    { execFileImpl }
  );

  const codes = (Array.isArray(chainPayload?.data) ? chainPayload.data : [])
    .filter((row) => typeof row?.code === 'string' && row.code.trim() !== '')
    .map((row) => row.code.trim());

  if (codes.length === 0) {
    throw new Error(`Moomoo option chain unavailable for ${underlying} ${expirationDate}`);
  }

  const snapshotPayload = await runMoomooJsonScript(
    DEFAULT_OPTION_SNAPSHOTS_SCRIPT,
    [...codes, '--json'],
    { execFileImpl }
  );

  const rows = (Array.isArray(snapshotPayload?.data) ? snapshotPayload.data : [])
    .map(normalizeSnapshotRow)
    .filter(Boolean)
    .filter((row) => row.expirationDate === expirationDate);

  if (rows.length === 0) {
    throw new Error(`Moomoo option snapshots unavailable for ${underlying} ${expirationDate}`);
  }

  return {
    underlying,
    expirationDate,
    rows
  };
}
