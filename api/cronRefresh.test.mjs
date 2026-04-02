import { describe, expect, it, vi } from 'vitest';
import { isRefreshStale, isUsMarketOpenEastern, refreshAppStateSnapshot } from './server.mjs';

describe('isUsMarketOpenEastern', () => {
  it('returns true during regular trading hours in New York', () => {
    expect(isUsMarketOpenEastern(new Date('2026-04-01T15:00:00.000Z'))).toBe(true);
  });

  it('returns false outside trading hours in New York', () => {
    expect(isUsMarketOpenEastern(new Date('2026-04-01T22:30:00.000Z'))).toBe(false);
  });
});

describe('isRefreshStale', () => {
  it('treats missing timestamps as stale', () => {
    expect(isRefreshStale(null, 1000, Date.now())).toBe(true);
  });

  it('treats recent timestamps as fresh', () => {
    const now = new Date('2026-04-01T15:00:00.000Z').getTime();
    expect(isRefreshStale('2026-04-01T14:50:00.000Z', 20 * 60 * 1000, now)).toBe(false);
  });
});

describe('refreshAppStateSnapshot', () => {
  it('refreshes stale ticker and option data during market hours', async () => {
    const result = await refreshAppStateSnapshot(
      {
        version: 1,
        exported_at: '2026-04-01T14:00:00.000Z',
        data: {
          config: null,
          closedTrades: [],
          scenario: null,
          vixHistory: [],
          tickerList: [
            {
              ticker: 'AAPL',
              beta: 0.8,
              shares: 100,
              average_cost_basis: 180,
              downside_tolerance_pct: 0.1,
              current_price: 190,
              last_updated: '2026-04-01T14:00:00.000Z',
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
              ma_200: null
            }
          ],
          puts: [
            {
              id: 'put-1',
              ticker: 'AAPL',
              option_side: 'put',
              put_strike: 175,
              premium_per_share: 4.2,
              contracts: 1,
              iv_rank: 30,
              date_sold: '2026-04-01',
              expiration_date: '2026-05-15',
              option_market_price_per_share: null,
              option_market_price_updated: null,
              option_theta_per_share: null
            }
          ]
        }
      },
      {
        now: new Date('2026-04-01T15:00:00.000Z'),
        includeVix: true,
        fetchQuoteBundleFn: vi.fn(async () => ({
          quoteResult: { ok: true, price: 201.25, as_of: '2026-04-01T15:00:00.000Z' },
          rsiResult: { ok: true, rsi: 48.5 },
          rsi1hResult: { ok: true, rsi: 61.2 },
          ma21Result: { ok: true, sma: 198.4 },
          ma200Result: { ok: true, sma: 182.7 },
          currentIvResult: { ok: true, currentIv: 0.24 },
          marketMetricsResult: {
            ok: true,
            marketMetrics: {
              next_earnings_date: '2026-05-07',
              historical_iv: 0.2,
              iv_rank: 42,
              iv_percentile: 68,
              put_call_ratio: 0.77
            }
          }
        })),
        fetchCurrentOptionQuoteFn: vi.fn(async () => ({ price: 2.15, theta: -0.07 })),
        refreshVixFn: vi.fn(async () => ({ value: 25.1 })),
        sleepFn: vi.fn(async () => {})
      }
    );

    expect(result.marketOpen).toBe(true);
    expect(result.refreshedTickers).toBe(1);
    expect(result.refreshedOptions).toBe(1);
    expect(result.snapshot.data.tickerList[0]).toMatchObject({
      current_price: 201.25,
      rsi_14: 48.5,
      rsi_14_1h: 61.2,
      ma_21: 198.4,
      ma_200: 182.7,
      current_iv: 0.24,
      next_earnings_date: '2026-05-07',
      historical_iv: 0.2,
      iv_rank: 42,
      iv_percentile: 68,
      put_call_ratio: 0.77
    });
    expect(result.snapshot.data.puts[0]).toMatchObject({
      option_market_price_per_share: 2.15,
      option_theta_per_share: -0.07
    });
  });

  it('skips ticker and option refresh when the market is closed unless forced', async () => {
    const fetchQuoteBundleFn = vi.fn();
    const fetchCurrentOptionQuoteFn = vi.fn();

    const result = await refreshAppStateSnapshot(
      {
        version: 1,
        exported_at: '2026-04-01T14:00:00.000Z',
        data: {
          config: null,
          closedTrades: [],
          scenario: null,
          vixHistory: [],
          tickerList: [
            {
              ticker: 'MSFT',
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
              ma_200: null
            }
          ],
          puts: [
            {
              id: 'call-1',
              ticker: 'MSFT',
              option_side: 'call',
              put_strike: 420,
              premium_per_share: 3.1,
              contracts: 1,
              iv_rank: 10,
              date_sold: '2026-04-01',
              expiration_date: '2026-05-08',
              option_market_price_per_share: null,
              option_market_price_updated: null,
              option_theta_per_share: null
            }
          ]
        }
      },
      {
        now: new Date('2026-04-01T22:30:00.000Z'),
        fetchQuoteBundleFn,
        fetchCurrentOptionQuoteFn,
        refreshVixFn: vi.fn(async () => ({ value: 24.9 })),
        sleepFn: vi.fn(async () => {})
      }
    );

    expect(result.marketOpen).toBe(false);
    expect(result.refreshedTickers).toBe(0);
    expect(result.refreshedOptions).toBe(0);
    expect(fetchQuoteBundleFn).not.toHaveBeenCalled();
    expect(fetchCurrentOptionQuoteFn).not.toHaveBeenCalled();
  });
});
