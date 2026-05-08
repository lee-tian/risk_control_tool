import { describe, expect, it } from 'vitest';

import type { TickerEntry } from '../types';
import { applyQuoteRefreshToTickerList, applyTickerPcrRefresh, parseJsonResponseText } from './quoteRefresh';

function makeTicker(overrides: Partial<TickerEntry>): TickerEntry {
  return {
    ticker: 'AAPL',
    beta: 0.87,
    shares: 100,
    average_cost_basis: 185.5,
    downside_tolerance_pct: 0.3,
    current_price: 252.89,
    last_updated: '2026-03-26T22:55:00.000Z',
    current_iv: 0.2572,
    current_iv_updated: '2026-03-26T22:55:00.000Z',
    put_call_ratio: 0.67,
    put_call_ratio_updated: '2026-03-26T22:55:00.000Z',
    provider_exchange: null,
    provider_mic_code: null,
    rsi_14: 47.9,
    rsi_14_1h: 63.7,
    rsi_updated: '2026-03-26T22:55:00.000Z',
    ma_21: 257.09,
    ma_200: 247.84,
    ...overrides
  };
}

describe('parseJsonResponseText', () => {
  it('parses valid JSON payloads', () => {
    const payload = parseJsonResponseText<{ quotes: { AAPL: number } }>('{"quotes":{"AAPL":252.89}}', 200, 'OK');

    expect(payload).toEqual({ quotes: { AAPL: 252.89 } });
  });

  it('throws a readable HTML error when the upstream returns a page', () => {
    expect(() => parseJsonResponseText('<!DOCTYPE html><html></html>', 502, 'Bad Gateway')).toThrow(
      '接口返回了 HTML，状态 502 Bad Gateway'
    );
  });

  it('falls back to the raw response text for other invalid payloads', () => {
    expect(() => parseJsonResponseText('temporary upstream failure', 500, 'Server Error')).toThrow(
      'temporary upstream failure'
    );
  });

  it('uses a generic invalid-response error for blank payloads', () => {
    expect(() => parseJsonResponseText('   ', 503, 'Service Unavailable')).toThrow(
      '接口返回了无效响应，状态 503'
    );
  });
});

describe('applyTickerPcrRefresh', () => {
  it('updates only the matching ticker PCR fields', () => {
    const current = [
      makeTicker({ ticker: 'AAPL', put_call_ratio: 0.67, put_call_ratio_updated: '2026-03-26T22:55:00.000Z' }),
      makeTicker({ ticker: 'MSFT', put_call_ratio: 0.59, put_call_ratio_updated: '2026-03-26T22:40:00.000Z' })
    ];

    const next = applyTickerPcrRefresh(current, 'MSFT', 0.71, '2026-03-26T23:15:00.000Z');

    expect(next[0]).toMatchObject({
      ticker: 'AAPL',
      put_call_ratio: 0.67,
      put_call_ratio_updated: '2026-03-26T22:55:00.000Z'
    });
    expect(next[1]).toMatchObject({
      ticker: 'MSFT',
      put_call_ratio: 0.71,
      put_call_ratio_updated: '2026-03-26T23:15:00.000Z'
    });
  });

  it('returns a new array without changing unrelated fields', () => {
    const current = [makeTicker({ ticker: 'NVDA', current_price: 171.24, shares: 100, put_call_ratio: null })];

    const next = applyTickerPcrRefresh(current, 'NVDA', 0.89, '2026-03-26T23:20:00.000Z');

    expect(next).not.toBe(current);
    expect(next[0]).toMatchObject({
      ticker: 'NVDA',
      current_price: 171.24,
      shares: 100,
      put_call_ratio: 0.89,
      put_call_ratio_updated: '2026-03-26T23:20:00.000Z'
    });
  });
});

describe('applyQuoteRefreshToTickerList', () => {
  it('applies refreshed market fields and timestamps to the requested ticker', () => {
    const current = [
      makeTicker({
        ticker: 'TSLA',
        current_price: null,
        last_updated: null,
        current_iv: null,
        current_iv_updated: null,
        historical_iv: null,
        iv_rank: null,
        iv_percentile: null,
        put_call_ratio: null,
        put_call_ratio_updated: null,
        rsi_14: null,
        rsi_14_1h: null,
        rsi_updated: null,
        ma_21: null,
        ma_200: null,
        next_earnings_date: null
      }),
      makeTicker({ ticker: 'AAPL' })
    ];

    const next = applyQuoteRefreshToTickerList(
      current,
      {
        quotes: { TSLA: 255.92 },
        rsi: { TSLA: 48.1 },
        rsi1h: { TSLA: 52.4 },
        ma21: { TSLA: 250.1 },
        ma200: { TSLA: 221.4 },
        atr14: { TSLA: 7.25 },
        currentIv: { TSLA: 0.285 },
        historicalIv: { TSLA: 0.233 },
        ivRank: { TSLA: 23.4 },
        ivPercentile: { TSLA: 51.2 },
        putCallRatio: { TSLA: 0.88 },
        nextEarningsDate: { TSLA: '2026-05-07' },
        as_of: '2026-04-06T05:45:00.000Z'
      },
      ['TSLA']
    );

    expect(next[0]).toMatchObject({
      ticker: 'TSLA',
      current_price: 255.92,
      last_updated: '2026-04-06T05:45:00.000Z',
      current_iv: 0.285,
      current_iv_updated: '2026-04-06T05:45:00.000Z',
      historical_iv: 0.233,
      iv_rank: 23.4,
      iv_percentile: 51.2,
      put_call_ratio: 0.88,
      put_call_ratio_updated: '2026-04-06T05:45:00.000Z',
      rsi_14: 48.1,
      rsi_14_1h: 52.4,
      rsi_updated: '2026-04-06T05:45:00.000Z',
      ma_21: 250.1,
      ma_200: 221.4,
      atr_14: 7.25,
      next_earnings_date: '2026-05-07'
    });
    expect(next[1]).toEqual(current[1]);
  });

  it('clears stale past earnings dates when a requested ticker refresh has no replacement date', () => {
    const current = [
      makeTicker({
        ticker: 'GOOGL',
        current_price: 318.49,
        next_earnings_date: '2026-02-04'
      })
    ];

    const next = applyQuoteRefreshToTickerList(
      current,
      {
        quotes: { GOOGL: 319.12 },
        as_of: '2026-04-09T16:30:00.000Z'
      },
      ['GOOGL']
    );

    expect(next[0]).toMatchObject({
      ticker: 'GOOGL',
      current_price: 319.12,
      next_earnings_date: null
    });
  });
});
