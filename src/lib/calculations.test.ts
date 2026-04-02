import { describe, expect, it } from 'vitest';

import type { Config, PutPosition, TickerEntry } from '../types';
import { buildSummaryText, calculatePortfolioMetrics } from './calculations';

const config: Config = {
  cash: 100000,
  risk_limit_pct: 0.2,
  warning_threshold_pct: 0.8
};

const puts: PutPosition[] = [
  {
    id: 'put-1',
    ticker: 'NVDA',
    put_strike: 160,
    premium_per_share: 4,
    contracts: 2,
    iv_rank: 42,
    date_sold: '2026-03-01',
    expiration_date: '2026-04-01',
    option_market_price_per_share: 1.5,
    option_theta_per_share: -0.12
  },
  {
    id: 'put-2',
    ticker: 'AAPL',
    put_strike: 240,
    premium_per_share: 3,
    contracts: 1,
    iv_rank: 28,
    date_sold: '2026-03-01',
    expiration_date: '2026-05-01',
    option_market_price_per_share: 2,
    option_theta_per_share: -0.05
  },
  {
    id: 'call-1',
    ticker: 'NVDA',
    option_side: 'call',
    put_strike: 220,
    premium_per_share: 2,
    contracts: 1,
    iv_rank: 35,
    date_sold: '2026-03-01',
    expiration_date: '2026-04-15',
    option_market_price_per_share: 1.2,
    option_theta_per_share: -0.03
  }
];

const tickerList: TickerEntry[] = [
  {
    ticker: 'NVDA',
    beta: 2,
    shares: 100,
    average_cost_basis: 150,
    downside_tolerance_pct: 0.2,
    current_price: 200,
    last_updated: '2026-03-26T22:55:00.000Z',
    current_iv: 0.34,
    current_iv_updated: '2026-03-26T22:55:00.000Z',
    put_call_ratio: 0.89,
    put_call_ratio_updated: '2026-03-26T22:55:00.000Z',
    provider_exchange: null,
    provider_mic_code: null,
    rsi_14: 48,
    rsi_14_1h: 52,
    rsi_updated: '2026-03-26T22:55:00.000Z',
    ma_21: 195,
    ma_200: 180
  },
  {
    ticker: 'AAPL',
    beta: 1,
    shares: 50,
    average_cost_basis: 180,
    downside_tolerance_pct: 0.15,
    current_price: 250,
    last_updated: '2026-03-26T22:55:00.000Z',
    current_iv: 0.26,
    current_iv_updated: '2026-03-26T22:55:00.000Z',
    put_call_ratio: 0.69,
    put_call_ratio_updated: '2026-03-26T22:55:00.000Z',
    provider_exchange: null,
    provider_mic_code: null,
    rsi_14: 47,
    rsi_14_1h: 63,
    rsi_updated: '2026-03-26T22:55:00.000Z',
    ma_21: 257,
    ma_200: 247
  }
];

describe('calculatePortfolioMetrics', () => {
  it('computes per-position risk metrics and portfolio rollups', () => {
    const metrics = calculatePortfolioMetrics(config, puts, tickerList, 0.1);

    expect(metrics.putRows).toHaveLength(3);
    expect(metrics.totalNominalPutExposure).toBe(56000);
    expect(metrics.totalPremiumIncome).toBe(1300);
    expect(metrics.totalCallPremiumIncome).toBe(200);
    expect(metrics.totalPutRisk).toBeCloseTo(2670, 6);
    expect(metrics.totalStockRisk).toBe(0);
    expect(metrics.totalCoveredCallOffset).toBe(200);
    expect(metrics.totalRisk).toBeCloseTo(2670, 6);
    expect(metrics.weightedAverageBeta).toBeCloseTo(1.571428, 5);
    expect(metrics.weightedAverageEffectiveStressPct).toBeCloseTo(0.048571, 5);
    expect(metrics.weightedAverageDaysToExpiration).toBeCloseTo(44.179487, 5);
    expect(metrics.portfolioAnnualizedYield).toBeCloseTo(0.164573, 5);
    expect(metrics.totalCapitalBase).toBe(133120);
    expect(metrics.annualizedYieldOnTotalCash).toBeCloseTo(0.080681, 5);
    expect(metrics.estimatedThetaIncomePerDay).toBe(32);
    expect(metrics.estimatedThetaIncomePerWeek).toBe(224);
    expect(metrics.estimatedThetaIncomePerMonth).toBe(960);
    expect(metrics.riskLimitAmount).toBe(20000);
    expect(metrics.remainingRiskBudget).toBeCloseTo(17330, 6);
    expect(metrics.portfolioRiskPctOfCash).toBeCloseTo(0.0267, 6);
    expect(metrics.riskUsagePct).toBeCloseTo(0.1335, 6);
    expect(metrics.riskScore).toBe(13);
    expect(metrics.riskStatus).toBe('Safe');
    expect(metrics.positioningStatus).toBe('Light');
    expect(metrics.scoreLevel).toBe('green');
    expect(metrics.highestRiskTicker).toBe('AAPL');
    expect(metrics.groupedTickerRisk).toEqual([
      { ticker: 'AAPL', risk: 1422 },
      { ticker: 'NVDA', risk: 1248 }
    ]);
    expect(metrics.canAddMoreRisk).toBe(true);

    expect(metrics.putRows[0]).toMatchObject({
      ticker: 'NVDA',
      distance_pct: 0.2,
      baseStressAfterDistancePct: 0.02,
      effectiveStressPct: 0.04,
      nominalExposure: 32000,
      premiumIncome: 800,
      daysToExpiration: 31,
      breakevenPrice: 156,
      netCostBasis: 31200,
      putRisk: 1248,
      optionCloseCost: 300,
      unrealizedPnl: 500,
      premiumCapturedPct: 0.625,
      thetaIncomePerDay: 24
    });
  });

  it('flags overloaded risk when cash or limit is insufficient', () => {
    const metrics = calculatePortfolioMetrics(
      { cash: 0, risk_limit_pct: 0, warning_threshold_pct: 0.8 },
      [
        {
          id: 'put-1',
          ticker: 'MSFT',
          put_strike: 300,
          premium_per_share: 5,
          contracts: 1,
          iv_rank: 20,
          date_sold: '2026-03-01',
          expiration_date: '2026-04-01'
        }
      ],
      [
        {
          ticker: 'MSFT',
          beta: 1,
          shares: null,
          average_cost_basis: null,
          downside_tolerance_pct: null,
          current_price: 310,
          last_updated: null,
          current_iv: null,
          current_iv_updated: null,
          put_call_ratio: null,
          put_call_ratio_updated: null,
          provider_exchange: null,
          provider_mic_code: null,
          rsi_14: null,
          rsi_14_1h: null,
          rsi_updated: null,
          ma_21: null,
          ma_200: null
        }
      ],
      0.1
    );

    expect(metrics.riskUsagePct).toBe(1.5);
    expect(metrics.riskStatus).toBe('Exceeded');
    expect(metrics.positioningStatus).toBe('Overloaded');
    expect(metrics.scoreLevel).toBe('red');
    expect(metrics.canAddMoreRisk).toBe(false);
  });

  it('keeps internal covered call offsets in total risk while ticker risk stays put-only', () => {
    const metrics = calculatePortfolioMetrics(
      config,
      [
        {
          id: 'put-1',
          ticker: 'TSLA',
          put_strike: 240,
          premium_per_share: 4,
          contracts: 1,
          iv_rank: 30,
          date_sold: '2026-03-01',
          expiration_date: '2026-04-01'
        },
        {
          id: 'call-1',
          ticker: 'TSLA',
          option_side: 'call',
          put_strike: 310,
          premium_per_share: 1.5,
          contracts: 1,
          iv_rank: 22,
          date_sold: '2026-03-01',
          expiration_date: '2026-04-01'
        }
      ],
      [
        {
          ticker: 'TSLA',
          beta: 1,
          shares: 100,
          average_cost_basis: 260,
          downside_tolerance_pct: null,
          current_price: 200,
          last_updated: null,
          current_iv: null,
          current_iv_updated: null,
          put_call_ratio: null,
          put_call_ratio_updated: null,
          provider_exchange: null,
          provider_mic_code: null,
          rsi_14: null,
          rsi_14_1h: null,
          rsi_updated: null,
          ma_21: null,
          ma_200: null
        }
      ],
      0.1
    );

    expect(metrics.totalPutRisk).toBeCloseTo(2360, 6);
    expect(metrics.totalStockRisk).toBe(7000);
    expect(metrics.totalCoveredCallOffset).toBe(150);
    expect(metrics.totalRisk).toBeCloseTo(9210, 6);
    expect(metrics.groupedTickerRisk).toEqual([{ ticker: 'TSLA', risk: 2360 }]);
  });

  it('counts covered call size by contracts rather than position rows', () => {
    const metrics = calculatePortfolioMetrics(
      { cash: 100000, risk_limit_pct: 0.2, warning_threshold_pct: 0.8 },
      [
        {
          id: 'call-agg',
          ticker: 'AMZN',
          option_side: 'call',
          put_strike: 220,
          premium_per_share: 3.22,
          contracts: 3,
          iv_rank: 39,
          date_sold: '2026-04-01',
          expiration_date: '2026-05-16'
        }
      ],
      [
        {
          ticker: 'AMZN',
          beta: 1.31,
          shares: 500,
          average_cost_basis: 136,
          downside_tolerance_pct: 0.2,
          current_price: 211.49,
          last_updated: '2026-04-01T19:40:56.693Z',
          current_iv: 0.3,
          current_iv_updated: '2026-04-01T19:40:56.693Z',
          put_call_ratio: 0.61,
          put_call_ratio_updated: '2026-03-31T21:18:26.618Z',
          provider_exchange: null,
          provider_mic_code: null,
          rsi_14: 51.18,
          rsi_14_1h: 58.52,
          rsi_updated: '2026-04-01T19:40:56.693Z',
          ma_21: 210.06,
          ma_200: 224.58
        }
      ],
      0.1
    );

    expect(metrics.totalCallPremiumIncome).toBe(966);
    expect(metrics.totalCoveredCallOffset).toBe(966);
  });
});

describe('buildSummaryText', () => {
  it('includes the key portfolio metrics in a deploy-visible summary', () => {
    const metrics = calculatePortfolioMetrics(config, puts, tickerList, 0.1);
    const summary = buildSummaryText(config, 0.1, metrics);

    expect(summary).toContain('Option Risk Control Tool Summary');
    expect(summary).toContain('Stress Scenario: 10%');
    expect(summary).toContain('Weighted Average Beta: 1.57');
    expect(summary).toContain('Annualized Yield On Total Capital:');
    expect(summary).toContain('Covered Call Offset: 200.00');
    expect(summary).toContain('Total Risk: 2670.00');
    expect(summary).toContain('Risk Status: Safe');
    expect(summary).toContain('Positioning Status: Light');
    expect(summary).toContain('Risk Score: 13');
  });
});
