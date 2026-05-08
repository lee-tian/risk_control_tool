import { describe, expect, it } from 'vitest';

import {
  analyzeKlineLevels,
  calculateRsi,
  calculateSma,
  extractCloseSeries,
  extractMoomooKlineRows
} from './marketIndicators.mjs';

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

describe('extractMoomooKlineRows', () => {
  it('normalizes moomoo kline payload rows', () => {
    expect(
      extractMoomooKlineRows({
        data: [
          { time: '2026-04-01 00:00:00', open: '100', high: '105', low: '98', close: '104', volume: '1000' },
          { time: '2026-04-02 00:00:00', open: 104, high: 106, low: 101, close: 102, volume: 900 }
        ]
      })
    ).toEqual([
      { time: '2026-04-01 00:00:00', open: 100, high: 105, low: 98, close: 104, volume: 1000 },
      { time: '2026-04-02 00:00:00', open: 104, high: 106, low: 101, close: 102, volume: 900 }
    ]);
  });
});

describe('analyzeKlineLevels', () => {
  it('finds nearby support and resistance from trailing ranges and swing points', () => {
    const rows = extractMoomooKlineRows({
      data: [
        { time: '2026-03-24 00:00:00', open: 98, high: 101, low: 97, close: 100, volume: 1000 },
        { time: '2026-03-25 00:00:00', open: 100, high: 103, low: 99, close: 102, volume: 1000 },
        { time: '2026-03-26 00:00:00', open: 102, high: 104, low: 100, close: 101, volume: 1000 },
        { time: '2026-03-27 00:00:00', open: 101, high: 105, low: 96, close: 104, volume: 1000 },
        { time: '2026-03-30 00:00:00', open: 104, high: 106, low: 103, close: 105, volume: 1000 },
        { time: '2026-03-31 00:00:00', open: 105, high: 108, low: 104, close: 107, volume: 1000 },
        { time: '2026-04-01 00:00:00', open: 107, high: 109, low: 105, close: 106, volume: 1000 },
        { time: '2026-04-02 00:00:00', open: 106, high: 112, low: 105, close: 111, volume: 1000 },
        { time: '2026-04-03 00:00:00', open: 111, high: 113, low: 109, close: 110, volume: 1000 },
        { time: '2026-04-06 00:00:00', open: 110, high: 114, low: 108, close: 112, volume: 1000 },
        { time: '2026-04-07 00:00:00', open: 112, high: 115, low: 111, close: 114, volume: 1000 },
        { time: '2026-04-08 00:00:00', open: 114, high: 116, low: 112, close: 115, volume: 1000 }
      ]
    });

    const levels = analyzeKlineLevels(rows, 110, { recentWindow: 5, longWindow: 10, pivotWindow: 1, tolerancePct: 0.01 });

    expect(levels.asOf).toBe('2026-04-08');
    expect(levels.nearestSupport).toEqual(
      expect.objectContaining({
        price: expect.any(Number),
        source: expect.stringContaining('swing low')
      })
    );
    expect(levels.nearestResistance).toEqual(
      expect.objectContaining({
        price: expect.any(Number),
        source: expect.stringContaining('high')
      })
    );
    expect(levels.nearestSupport.price).toBeLessThan(110);
    expect(levels.nearestResistance.price).toBeGreaterThan(110);
  });
});
