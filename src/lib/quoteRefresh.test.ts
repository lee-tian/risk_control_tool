import { describe, expect, it } from 'vitest';

import type { TickerEntry } from '../types';
import { applyTickerPcrRefresh, parseJsonResponseText } from './quoteRefresh';

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
