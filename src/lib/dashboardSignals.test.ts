import { describe, expect, it } from 'vitest';
import { buildTopIvRankStocks } from './dashboardSignals';
import type { TickerEntry } from '../types';

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

describe('buildTopIvRankStocks', () => {
  it('sorts by iv rank descending and keeps top 5 with earnings info', () => {
    const result = buildTopIvRankStocks([
      makeTicker({ ticker: 'AAPL', iv_rank: 45, current_iv: 0.31, next_earnings_date: '2026-05-01' }),
      makeTicker({ ticker: 'MSFT', iv_rank: 82, current_iv: 0.28, next_earnings_date: '2026-04-20' }),
      makeTicker({ ticker: 'NVDA', iv_rank: 82, current_iv: 0.41, next_earnings_date: '2026-04-25' }),
      makeTicker({ ticker: 'AMZN', iv_rank: 60, current_iv: 0.33, next_earnings_date: '2026-05-07' }),
      makeTicker({ ticker: 'META', iv_rank: 58, current_iv: 0.29, next_earnings_date: '2026-04-29' }),
      makeTicker({ ticker: 'NFLX', iv_rank: 39, current_iv: 0.27, next_earnings_date: '2026-04-18' }),
      makeTicker({ ticker: 'GOOGL', iv_rank: null, current_iv: 0.22 })
    ]);

    expect(result.map((item) => item.ticker)).toEqual(['NVDA', 'MSFT', 'AMZN', 'META', 'AAPL']);
    expect(result[0]).toMatchObject({
      ticker: 'NVDA',
      ivRank: 82,
      currentIv: 0.41,
      earningsDate: '2026-04-25'
    });
  });

  it('uses current iv and market value as tie breakers', () => {
    const result = buildTopIvRankStocks([
      makeTicker({ ticker: 'AAPL', iv_rank: 70, current_iv: 0.32, shares: 100, current_price: 200 }),
      makeTicker({ ticker: 'MSFT', iv_rank: 70, current_iv: 0.32, shares: 50, current_price: 300 }),
      makeTicker({ ticker: 'AMZN', iv_rank: 70, current_iv: 0.35, shares: 10, current_price: 100 })
    ]);

    expect(result.map((item) => item.ticker)).toEqual(['AMZN', 'AAPL', 'MSFT']);
  });
});
