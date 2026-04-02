import type {
  Config,
  PortfolioMetrics,
  PositioningStatus,
  PutPosition,
  RiskStatus,
  ScoreLevel,
  TickerEntry
} from '../types';

function safeDivide(numerator: number, denominator: number): number {
  if (denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

function getRiskStatus(usagePct: number, warningThresholdPct: number): RiskStatus {
  if (usagePct > 1) return 'Exceeded';
  if (usagePct >= warningThresholdPct) return 'Near Limit';
  return 'Safe';
}

function getPositioningStatus(usagePct: number): PositioningStatus {
  if (usagePct > 1) return 'Overloaded';
  if (usagePct >= 0.8) return 'Heavy';
  if (usagePct >= 0.5) return 'Normal';
  return 'Light';
}

function getScoreLevel(score: number): ScoreLevel {
  if (score < 60) return 'green';
  if (score < 80) return 'yellow';
  return 'red';
}

function getDaysBetween(dateSold: string, expirationDate: string): number {
  if (!dateSold || !expirationDate) {
    return 0;
  }

  const sold = new Date(dateSold);
  const expiration = new Date(expirationDate);
  const millisecondsPerDay = 1000 * 60 * 60 * 24;
  const diffInMs = expiration.getTime() - sold.getTime();

  if (!Number.isFinite(diffInMs) || diffInMs <= 0) {
    return 0;
  }

  return Math.ceil(diffInMs / millisecondsPerDay);
}

function getDistanceToStrikePct(
  currentPrice: number,
  strike: number,
  optionSide: 'put' | 'call'
): number {
  if (currentPrice <= 0) {
    return 0;
  }

  return optionSide === 'call' ? (strike - currentPrice) / currentPrice : (currentPrice - strike) / currentPrice;
}

const MIN_PUT_STRESS_FLOOR_PCT = 0.02;
const STOCK_BASE_DRAWDOWN_PCT = 0.1;
const STOCK_MIN_RISK_FLOOR_PCT = 0.02;
const STOCK_BETA_FALLBACK = 1;
const STOCK_BETA_MIN = 0.6;
const STOCK_BETA_MAX = 2.5;
const STOCK_TOLERANCE_MAX_PCT = 0.2;
const STOCK_TOLERANCE_MIN_FACTOR = 0.3;

function getStockRiskFloor(entry: TickerEntry): number {
  const shares = entry.shares ?? 0;
  const currentPrice = entry.current_price ?? 0;
  if (shares <= 0 || currentPrice <= 0) {
    return 0;
  }

  return shares * currentPrice * STOCK_MIN_RISK_FLOOR_PCT;
}

function getAdjustedStockRisk(entry: TickerEntry): number {
  const shares = entry.shares ?? 0;
  const currentPrice = entry.current_price ?? 0;
  if (shares <= 0 || currentPrice <= 0) {
    return 0;
  }

  const rawBeta = typeof entry.beta === 'number' && Number.isFinite(entry.beta) ? entry.beta : STOCK_BETA_FALLBACK;
  const clampedBeta = Math.min(Math.max(rawBeta, STOCK_BETA_MIN), STOCK_BETA_MAX);
  const stockValue = shares * currentPrice;
  const baseStockRisk = stockValue * STOCK_BASE_DRAWDOWN_PCT * clampedBeta;
  const rawTolerancePct =
    typeof entry.downside_tolerance_pct === 'number' && Number.isFinite(entry.downside_tolerance_pct)
      ? entry.downside_tolerance_pct
      : 0;
  const clampedTolerancePct = Math.min(Math.max(rawTolerancePct, 0), STOCK_TOLERANCE_MAX_PCT);
  const toleranceFactor = Math.max(1 - clampedTolerancePct / STOCK_TOLERANCE_MAX_PCT, STOCK_TOLERANCE_MIN_FACTOR);
  const stockRiskFloor = getStockRiskFloor(entry);

  return Math.max(baseStockRisk * toleranceFactor, stockRiskFloor);
}

export function calculatePortfolioMetrics(
  config: Config | null,
  puts: PutPosition[],
  tickerList: TickerEntry[],
  stressDropPct: number
): PortfolioMetrics {
  const tickerMap = new Map(tickerList.map((entry) => [entry.ticker, entry]));

  const putRows = puts.map((put) => {
    const optionSide: 'put' | 'call' = put.option_side === 'call' ? 'call' : 'put';
    const tickerEntry = tickerMap.get(put.ticker);
    const beta = tickerEntry?.beta ?? 1;
    const currentPrice = tickerEntry?.current_price ?? 0;
    const distance_pct = getDistanceToStrikePct(currentPrice, put.put_strike, optionSide);
    const baseStressAfterDistancePct =
      optionSide === 'put' ? Math.max(stressDropPct - distance_pct, MIN_PUT_STRESS_FLOOR_PCT) : 0;
    const effectiveStressPct = optionSide === 'put' ? baseStressAfterDistancePct * beta : 0;
    const nominalExposure = put.put_strike * put.contracts * 100;
    const premiumIncome = put.premium_per_share * put.contracts * 100;
    const daysToExpiration = getDaysBetween(put.date_sold, put.expiration_date);
    const annualizedYield = safeDivide(premiumIncome, nominalExposure) * safeDivide(365, daysToExpiration);
    const breakevenPrice =
      optionSide === 'call' ? put.put_strike + put.premium_per_share : put.put_strike - put.premium_per_share;
    const netCostBasis = breakevenPrice * put.contracts * 100;
    const putRisk = optionSide === 'put' ? netCostBasis * effectiveStressPct : 0;
    const riskPctOfCash = safeDivide(putRisk, config?.cash ?? 0);
    const optionCloseCost =
      typeof put.option_market_price_per_share === 'number' ? put.option_market_price_per_share * put.contracts * 100 : null;
    const unrealizedPnl =
      typeof put.option_market_price_per_share === 'number'
        ? (put.premium_per_share - put.option_market_price_per_share) * put.contracts * 100
        : null;
    const premiumCapturedPct =
      typeof put.option_market_price_per_share === 'number'
        ? safeDivide(put.premium_per_share - put.option_market_price_per_share, put.premium_per_share)
        : null;
    const optionThetaPerShare = typeof put.option_theta_per_share === 'number' ? put.option_theta_per_share : null;
    const thetaIncomePerDay =
      typeof optionThetaPerShare === 'number' ? Math.max(-optionThetaPerShare, 0) * put.contracts * 100 : null;

    return {
      ...put,
      option_side: optionSide,
      distance_pct,
      beta,
      baseStressAfterDistancePct,
      effectiveStressPct,
      nominalExposure,
      premiumIncome,
      daysToExpiration,
      annualizedYield,
      breakevenPrice,
      netCostBasis,
      putRisk,
      riskPctOfCash,
      optionCloseCost,
      unrealizedPnl,
      premiumCapturedPct,
      optionThetaPerShare,
      thetaIncomePerDay
    };
  });

  const putOnlyRows = putRows.filter((row) => row.option_side !== 'call');
  const totalNominalPutExposure = putOnlyRows.reduce((sum, row) => sum + row.nominalExposure, 0);
  const totalExposureWeightedBeta = putOnlyRows.reduce((sum, row) => sum + row.nominalExposure * row.beta, 0);
  const totalExposureWeightedEffectiveStressPct = putOnlyRows.reduce(
    (sum, row) => sum + row.nominalExposure * row.effectiveStressPct,
    0
  );
  const weightedAverageBeta = safeDivide(totalExposureWeightedBeta, totalNominalPutExposure);
  const weightedAverageEffectiveStressPct = safeDivide(
    totalExposureWeightedEffectiveStressPct,
    totalNominalPutExposure
  );
  const totalPremiumIncome = putRows.reduce((sum, row) => sum + row.premiumIncome, 0);
  const totalCallPremiumIncome = putRows
    .filter((row) => row.option_side === 'call')
    .reduce((sum, row) => sum + row.premiumIncome, 0);
  const totalOptionNominalExposure = putRows.reduce((sum, row) => sum + row.nominalExposure, 0);
  const totalExposureWeightedDays = putRows.reduce((sum, row) => sum + row.nominalExposure * row.daysToExpiration, 0);
  const totalExposureWeightedAnnualizedYield = putRows.reduce(
    (sum, row) => sum + row.nominalExposure * row.annualizedYield,
    0
  );
  const weightedAverageDaysToExpiration = safeDivide(totalExposureWeightedDays, totalOptionNominalExposure);
  const portfolioAnnualizedYield = safeDivide(totalExposureWeightedAnnualizedYield, totalOptionNominalExposure);
  const totalPutRisk = putOnlyRows.reduce((sum, row) => sum + row.putRisk, 0);
  const estimatedThetaIncomePerDay = putRows.reduce((sum, row) => sum + (row.thetaIncomePerDay ?? 0), 0);
  const estimatedThetaIncomePerWeek = estimatedThetaIncomePerDay * 7;
  const estimatedThetaIncomePerMonth = estimatedThetaIncomePerDay * 30;
  const cash = config?.cash ?? 0;
  const stockMarketValue = tickerList.reduce(
    (sum, entry) => sum + (entry.current_price ?? 0) * (entry.shares ?? 0),
    0
  );
  const totalOptionMarketValue = putRows.reduce((sum, row) => sum + (row.optionCloseCost ?? 0), 0);
  const totalCapitalBase = cash + stockMarketValue + totalOptionMarketValue;
  const annualizedYieldOnTotalCash = safeDivide(totalPremiumIncome, totalCapitalBase) * safeDivide(365, weightedAverageDaysToExpiration);
  const callOffsetByTicker = new Map<string, number>();
  for (const row of putRows) {
    if (row.option_side === 'call') {
      callOffsetByTicker.set(row.ticker, (callOffsetByTicker.get(row.ticker) ?? 0) + row.premiumIncome);
    }
  }
  const missingStockBetaTickers = tickerList
    .filter((entry) => (entry.shares ?? 0) > 0 && (entry.beta === null || !Number.isFinite(entry.beta)))
    .map((entry) => entry.ticker)
    .sort();
  const totalStockRisk = tickerList.reduce((sum, entry) => {
    return sum + getAdjustedStockRisk(entry);
  }, 0);
  const totalCoveredCallOffset = tickerList.reduce((sum, entry) => {
    const shares = entry.shares ?? 0;
    if (shares <= 0) {
      return sum;
    }

    const totalCoveredShares = putRows
      .filter((row) => row.ticker === entry.ticker && row.option_side === 'call')
      .reduce((coveredShares, row) => coveredShares + row.contracts * 100, 0);
    const coveredRatio = Math.min(totalCoveredShares / shares, 1);

    return sum + (callOffsetByTicker.get(entry.ticker) ?? 0) * coveredRatio;
  }, 0);
  const totalRisk = tickerList.reduce((sum, entry) => {
    const shares = entry.shares ?? 0;
    if (shares <= 0) {
      return sum;
    }

    const stockRisk = getAdjustedStockRisk(entry);
    const stockRiskFloor = getStockRiskFloor(entry);
    const totalCoveredShares = putRows
      .filter((row) => row.ticker === entry.ticker && row.option_side === 'call')
      .reduce((coveredShares, row) => coveredShares + row.contracts * 100, 0);
    const coveredRatio = shares > 0 ? Math.min(totalCoveredShares / shares, 1) : 0;
    const coveredCallOffset = (callOffsetByTicker.get(entry.ticker) ?? 0) * coveredRatio;

    return sum + Math.max(stockRisk - coveredCallOffset, stockRiskFloor);
  }, totalPutRisk);
  const riskLimitAmount = cash * (config?.risk_limit_pct ?? 0);
  const portfolioRiskPctOfCash = safeDivide(totalPutRisk, cash);
  const totalRiskPctOfTotalCapital = safeDivide(totalRisk, totalCapitalBase);
  const remainingRiskBudget = riskLimitAmount - totalPutRisk;
  const riskUsagePct =
    riskLimitAmount <= 0 ? (totalPutRisk > 0 ? 1.5 : 0) : totalPutRisk / riskLimitAmount;
  const riskScore = Math.round(riskUsagePct * 100);
  const riskStatus = getRiskStatus(riskUsagePct, config?.warning_threshold_pct ?? 0.8);
  const positioningStatus = getPositioningStatus(riskUsagePct);
  const scoreLevel = getScoreLevel(riskScore);

  const groupedTickerMap = new Map<string, number>();
  for (const row of putOnlyRows) {
    groupedTickerMap.set(row.ticker, (groupedTickerMap.get(row.ticker) ?? 0) + row.putRisk);
  }

  const groupedTickerRisk = [...groupedTickerMap.entries()]
    .map(([ticker, risk]) => ({ ticker, risk }))
    .sort((a, b) => b.risk - a.risk);

  return {
    weightedAverageBeta,
    weightedAverageEffectiveStressPct,
    totalNominalPutExposure,
    totalPremiumIncome,
    totalCallPremiumIncome,
    totalCapitalBase,
    weightedAverageDaysToExpiration,
    portfolioAnnualizedYield,
    annualizedYieldOnTotalCash,
    estimatedThetaIncomePerDay,
    estimatedThetaIncomePerWeek,
    estimatedThetaIncomePerMonth,
    totalPutRisk,
    totalStockRisk,
    totalCoveredCallOffset,
    totalRisk,
    missingStockBetaTickers,
    portfolioRiskPctOfCash,
    totalRiskPctOfTotalCapital,
    riskLimitAmount,
    remainingRiskBudget,
    riskStatus,
    positioningStatus,
    riskUsagePct,
    riskScore,
    scoreLevel,
    putRows,
    highestRiskTicker: groupedTickerRisk[0]?.ticker ?? '暂无',
    groupedTickerRisk,
    canAddMoreRisk: remainingRiskBudget > 0
  };
}

export function buildSummaryText(
  config: Config | null,
  stressDropPct: number,
  metrics: PortfolioMetrics
): string {
  const lines = [
    'Option Risk Control Tool Summary',
    `Stress Scenario: ${(stressDropPct * 100).toFixed(0)}%`,
    `Weighted Average Beta: ${metrics.weightedAverageBeta.toFixed(2)}`,
    `Weighted Average Effective Stress: ${(metrics.weightedAverageEffectiveStressPct * 100).toFixed(2)}%`,
    `Cash: ${config?.cash ?? 0}`,
    `Total Premium Income: ${metrics.totalPremiumIncome.toFixed(2)}`,
    `Portfolio Annualized Yield: ${(metrics.portfolioAnnualizedYield * 100).toFixed(2)}%`,
    `Annualized Yield On Total Capital: ${(metrics.annualizedYieldOnTotalCash * 100).toFixed(2)}%`,
    `Total Put Risk: ${metrics.totalPutRisk.toFixed(2)}`,
    `Total Stock Risk: ${metrics.totalStockRisk.toFixed(2)}`,
    `Covered Call Offset: ${metrics.totalCoveredCallOffset.toFixed(2)}`,
    `Total Risk: ${metrics.totalRisk.toFixed(2)}`,
    ...(metrics.missingStockBetaTickers.length > 0
      ? [`Missing stock beta: ${metrics.missingStockBetaTickers.join(', ')}`]
      : []),
    `Put Risk % Of Cash: ${(metrics.portfolioRiskPctOfCash * 100).toFixed(2)}%`,
    `Total Risk % Of Total Capital: ${(metrics.totalRiskPctOfTotalCapital * 100).toFixed(2)}%`,
    `Risk Limit Amount: ${metrics.riskLimitAmount.toFixed(2)}`,
    `Remaining Risk Budget: ${metrics.remainingRiskBudget.toFixed(2)}`,
    `Risk Status: ${metrics.riskStatus}`,
    `Positioning Status: ${metrics.positioningStatus}`,
    `Risk Score: ${metrics.riskScore}`
  ];

  return lines.join('\n');
}
