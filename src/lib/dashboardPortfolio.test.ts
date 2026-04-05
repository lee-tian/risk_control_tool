import { describe, expect, it } from 'vitest';

import type { PutPosition, PutRiskRow, TickerEntry } from '../types';
import {
  buildCapitalAllocationChart,
  buildHoldingDeltaSummary,
  buildRiskCalculator,
  buildRiskCurvePoints,
  buildTickerDeltaItems,
  buildTickerAllocationItems
} from './dashboardPortfolio';

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
    optionDelta: null,
    optionGamma: null,
    gammaThetaRatio: null,
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

describe('buildTickerDeltaItems', () => {
  it('builds delta allocation shares from absolute total delta while preserving signed values', () => {
    const result = buildTickerDeltaItems([
      { ticker: 'MSFT', totalDelta: 42.7 },
      { ticker: 'NVDA', totalDelta: -120.2 },
      { ticker: 'AAPL', totalDelta: 0 }
    ]);

    expect(result.map((item) => [item.ticker, item.delta, item.exposure])).toEqual([
      ['NVDA', -120.2, 120.2],
      ['MSFT', 42.7, 42.7]
    ]);
    expect(result[0]?.share).toBeCloseTo(120.2 / (120.2 + 42.7), 6);
  });

  it('collapses remaining delta names into Other positions after top five', () => {
    const result = buildTickerDeltaItems([
      { ticker: 'A', totalDelta: 100 },
      { ticker: 'B', totalDelta: 90 },
      { ticker: 'C', totalDelta: 80 },
      { ticker: 'D', totalDelta: 70 },
      { ticker: 'E', totalDelta: 60 },
      { ticker: 'F', totalDelta: -50 }
    ]);

    expect(result.map((item) => item.ticker)).toEqual(['A', 'B', 'C', 'D', 'E', 'Other positions']);
    expect(result[result.length - 1]).toMatchObject({
      ticker: 'Other positions',
      delta: -50,
      exposure: 50
    });
  });
});

describe('buildHoldingDeltaSummary', () => {
  it('combines stock delta with short option deltas', () => {
    const result = buildHoldingDeltaSummary(300, [
      { contracts: 1, option_delta: -0.22 },
      { contracts: 2, option_delta: 0.31 },
      { contracts: 1, option_delta: null }
    ]);

    expect(result.stockDelta).toBe(300);
    expect(result.optionDelta).toBeCloseTo(-40, 6);
    expect(result.totalDelta).toBeCloseTo(260, 6);
  });

  it('returns stock-only delta when option greeks are unavailable', () => {
    const result = buildHoldingDeltaSummary(100, [{ contracts: 1, option_delta: null }]);

    expect(result).toEqual({
      stockDelta: 100,
      optionDelta: 0,
      totalDelta: 100
    });
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
    const result = buildRiskCalculator(puts, tickers, -0.1, 100000);

    expect(result.shockMultiplier).toBe(0.9);
    expect(result.totalStockChange).toBe(-2000);
    expect(result.totalPutChange).toBe(-4000);
    expect(result.totalCallChange).toBe(200);
    expect(result.totalNetChange).toBe(-5800);
    expect(result.totalNetChangePctOfCapital).toBeCloseTo(-0.058, 6);
    expect(result.scenarioCapital).toBe(94200);

    expect(result.rows[0]).toMatchObject({
      ticker: 'AMZN',
      stockChange: 0,
      putChange: -3400,
      callChange: 0,
      netChange: -3400
    });
    expect(result.rows[1]).toMatchObject({
      ticker: 'GOOGL',
      stockChange: -2000,
      putChange: -600,
      callChange: 200,
      netChange: -2400
    });
  });

  it('returns null capital percentages when capital base is zero', () => {
    const result = buildRiskCalculator(puts, tickers, -0.1, 0);

    expect(result.totalNetChangePctOfCapital).toBeNull();
    expect(result.rows.every((row) => row.netChangePctOfCapital === null)).toBe(true);
  });

  it('supports an up scenario with positive stock change and zero put loss', () => {
    const result = buildRiskCalculator(puts, tickers, 0.1, 100000);

    expect(result.shockMultiplier).toBe(1.1);
    expect(result.totalStockChange).toBe(2000);
    expect(result.totalPutChange).toBe(0);
    expect(result.totalCallChange).toBe(200);
    expect(result.totalNetChange).toBe(2200);
    expect(result.scenarioCapital).toBe(102200);
  });
});

describe('buildRiskCurvePoints', () => {
  it('returns ordered curve points spanning down and up scenarios', () => {
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

    const points = buildRiskCurvePoints(puts, tickers, 100000);

    expect(points[0]?.scenarioPct).toBe(-0.3);
    expect(points[points.length - 1]?.scenarioPct).toBe(0.3);
    expect(points.find((point) => point.scenarioPct === 0)?.capital).toBe(98700);
    expect(points.some((point) => Math.abs(point.scenarioPct + 0.1) < 1e-9 && point.capital === 94200)).toBe(true);
  });
});
