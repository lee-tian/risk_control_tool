import { describe, expect, it } from 'vitest';

import type { PutPosition, PutRiskRow, TickerEntry } from '../types';
import { buildCapitalAllocationChart, buildRiskCalculator, buildTickerAllocationItems } from './dashboardPortfolio';

function makeTicker(overrides: Partial<TickerEntry>): TickerEntry {
  return {
    ticker: 'AAPL',
    beta: null,
    shares: null,
    average_cost_basis: null,
    downside_tolerance_pct: null,
    current_price: null,
    last_updated: null,
    next_earnings_date: null,
    current_iv: null,
    current_iv_updated: null,
    historical_iv: null,
    iv_rank: null,
    iv_percentile: null,
    put_call_ratio: null,
    put_call_ratio_updated: null,
    provider_exchange: null,
    provider_mic_code: null,
    rsi_14: null,
    rsi_14_1h: null,
    rsi_updated: null,
    ma_21: null,
    ma_200: null,
    ...overrides
  };
}

function makePutRow(overrides: Partial<PutRiskRow>): PutRiskRow {
  return {
    id: 'row-1',
    ticker: 'AAPL',
    put_strike: 180,
    premium_per_share: 2,
    contracts: 1,
    iv_rank: 30,
    date_sold: '2026-03-01',
    expiration_date: '2026-04-01',
    option_side: 'put',
    distance_pct: 0.1,
    beta: 1,
    baseStressAfterDistancePct: 0.02,
    effectiveStressPct: 0.02,
    nominalExposure: 18000,
    premiumIncome: 200,
    daysToExpiration: 31,
    annualizedYield: 0.13,
    breakevenPrice: 178,
    netCostBasis: 17800,
    putRisk: 356,
    riskPctOfCash: 0.01,
    optionCloseCost: null,
    unrealizedPnl: 0,
    premiumCapturedPct: 0,
    optionThetaPerShare: null,
    thetaIncomePerDay: null,
    ...overrides
  };
}

describe('buildCapitalAllocationChart', () => {
  it('builds stock, option, and cash segments with proportional shares', () => {
    const result = buildCapitalAllocationChart(30000, 50000, 20000);

    expect(result.totalExposure).toBe(100000);
    expect(result.legendSegments.map((item) => item.ticker)).toEqual(['股票', '期权', '现金']);
    expect(result.legendSegments.map((item) => item.share)).toEqual([0.3, 0.5, 0.2]);
  });

  it('omits empty categories', () => {
    const result = buildCapitalAllocationChart(0, 50000, 0);

    expect(result.legendSegments).toHaveLength(1);
    expect(result.legendSegments[0].ticker).toBe('期权');
  });
});

describe('buildTickerAllocationItems', () => {
  it('combines stock market value with put nominal exposure and excludes calls', () => {
    const result = buildTickerAllocationItems(
      [
        { ticker: 'GOOGL', marketValue: 60000 },
        { ticker: 'AMZN', marketValue: 25000 }
      ],
      [
        makePutRow({ ticker: 'GOOGL', nominalExposure: 30000, option_side: 'put' }),
        makePutRow({ ticker: 'AMZN', nominalExposure: 10000, option_side: 'put' }),
        makePutRow({ ticker: 'GOOGL', nominalExposure: 20000, option_side: 'call' })
      ]
    );

    expect(result.map((item) => [item.ticker, item.exposure])).toEqual([
      ['GOOGL', 90000],
      ['AMZN', 35000]
    ]);
    expect(result[0].share).toBeCloseTo(90000 / 125000, 6);
  });

  it('collapses remaining names into Other positions after the top five', () => {
    const result = buildTickerAllocationItems(
      [
        { ticker: 'A', marketValue: 100 },
        { ticker: 'B', marketValue: 90 },
        { ticker: 'C', marketValue: 80 },
        { ticker: 'D', marketValue: 70 },
        { ticker: 'E', marketValue: 60 },
        { ticker: 'F', marketValue: 50 }
      ],
      []
    );

    expect(result.map((item) => item.ticker)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other positions']);
    expect(result[result.length - 1]?.exposure).toBe(50);
  });
});

describe('buildRiskCalculator', () => {
  const tickers: TickerEntry[] = [
    makeTicker({ ticker: 'GOOGL', shares: 100, current_price: 200 }),
    makeTicker({ ticker: 'AMZN', shares: null, current_price: 150 })
  ];
  const puts: PutPosition[] = [
    {
      id: 'put-1',
      ticker: 'GOOGL',
      option_side: 'put',
      put_strike: 190,
      premium_per_share: 4,
      contracts: 1,
      iv_rank: 30,
      date_sold: '2026-03-01',
      expiration_date: '2026-05-01'
    },
    {
      id: 'call-1',
      ticker: 'GOOGL',
      option_side: 'call',
      put_strike: 220,
      premium_per_share: 2,
      contracts: 1,
      iv_rank: 25,
      date_sold: '2026-03-01',
      expiration_date: '2026-05-01'
    },
    {
      id: 'put-2',
      ticker: 'AMZN',
      option_side: 'put',
      put_strike: 170,
      premium_per_share: 1,
      contracts: 1,
      iv_rank: 25,
      date_sold: '2026-03-01',
      expiration_date: '2026-05-01'
    }
  ];

  it('applies stock loss, put loss, and call premium offsets under a down scenario', () => {
    const result = buildRiskCalculator(puts, tickers, 0.1, 100000);

    expect(result.shockMultiplier).toBe(0.9);
    expect(result.totalStockLoss).toBe(2000);
    expect(result.totalPutLoss).toBe(4000);
    expect(result.totalCallOffset).toBe(200);
    expect(result.totalNetLoss).toBe(5800);
    expect(result.totalNetLossPctOfCapital).toBeCloseTo(0.058, 6);

    expect(result.rows[0]).toMatchObject({
      ticker: 'AMZN',
      stockLoss: 0,
      putLoss: 3400,
      callOffset: 0,
      netLoss: 3400
    });
    expect(result.rows[1]).toMatchObject({
      ticker: 'GOOGL',
      stockLoss: 2000,
      putLoss: 600,
      callOffset: 200,
      netLoss: 2400
    });
  });

  it('returns null capital percentages when capital base is zero', () => {
    const result = buildRiskCalculator(puts, tickers, 0.1, 0);

    expect(result.totalNetLossPctOfCapital).toBeNull();
    expect(result.rows.every((row) => row.netLossPctOfCapital === null)).toBe(true);
  });
});
