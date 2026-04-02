import { describe, expect, it } from 'vitest';

import { calculateRsi, calculateSma, extractCloseSeries } from './marketIndicators.mjs';

describe('extractCloseSeries', () => {
  it('extracts numeric closes from a MarketData candles payload', () => {
    expect(
      extractCloseSeries({
        s: 'ok',
        c: ['100.5', 101, '102.25', 'bad', null]
      })
    ).toEqual([100.5, 101, 102.25]);
  });

  it('returns an empty array for invalid payloads', () => {
    expect(extractCloseSeries({ s: 'error' })).toEqual([]);
    expect(extractCloseSeries(null)).toEqual([]);
  });
});

describe('calculateSma', () => {
  it('calculates the trailing simple moving average', () => {
    expect(calculateSma([1, 2, 3, 4, 5], 3)).toBe(4);
  });

  it('returns null when there is not enough history', () => {
    expect(calculateSma([1, 2], 3)).toBeNull();
  });
});

describe('calculateRsi', () => {
  it('returns 100 for a strictly rising series', () => {
    expect(calculateRsi([1, 2, 3, 4, 5, 6], 5)).toBe(100);
  });

  it('returns 0 for a strictly falling series', () => {
    expect(calculateRsi([6, 5, 4, 3, 2, 1], 5)).toBe(0);
  });

  it('returns null when there is not enough history', () => {
    expect(calculateRsi([1, 2, 3], 14)).toBeNull();
  });

  it('returns 50 when there is no movement', () => {
    expect(calculateRsi(new Array(20).fill(10), 14)).toBe(50);
  });
});
