import { describe, expect, it } from 'vitest';

import {
  extractOptionQuoteFromChain,
  extractOptionQuoteFromSnapshot,
  formatOptionSymbol,
  pickOptionQuoteGamma,
  pickOptionQuoteSample,
  pickOptionQuoteDelta,
  pickOptionQuoteTheta
} from './optionQuotes.mjs';

describe('optionQuotes call support', () => {
  it('formats a covered call contract symbol with the call flag', () => {
    expect(formatOptionSymbol('AAPL', '2026-06-19', 210, 'call')).toBe('AAPL260619C00210000');
  });

  it('extracts current call premium and theta from a quote snapshot', () => {
    const quote = extractOptionQuoteFromSnapshot({
      mid: [2.4],
      bid: [2.3],
      ask: [2.5],
      theta: [-0.08],
      delta: [0.31],
      gamma: [0.014]
    });

    expect(quote).toEqual({
      price: 2.4,
      theta: -0.08,
      delta: 0.31,
      gamma: 0.014
    });
  });

  it('falls back to the nearest call strike in chain data and keeps theta', () => {
    const quote = extractOptionQuoteFromChain(
      {
        strike: [205, 210, 215],
        bid: [3.9, 2.15, 1.45],
        ask: [4.1, 2.25, 1.55],
        mid: [4.0, 2.2, 1.5],
        last: [4.05, 2.18, 1.48],
        theta: [-0.11, -0.07, -0.05],
        delta: [0.45, 0.31, 0.24],
        gamma: [0.011, 0.018, 0.015]
      },
      210
    );

    expect(quote).toEqual({
      price: 2.2,
      theta: -0.07,
      delta: 0.31,
      gamma: 0.018
    });
  });

  it('keeps delta and gamma when extracting a single exact contract sample', () => {
    const quote = extractOptionQuoteFromChain(
      {
        strike: [210],
        bid: [2.1],
        ask: [2.3],
        mid: [2.2],
        last: [2.18],
        theta: [-0.07],
        delta: [0.31],
        gamma: [0.018]
      },
      210
    );

    expect(quote).toEqual({
      price: 2.2,
      theta: -0.07,
      delta: 0.31,
      gamma: 0.018
    });
  });

  it('treats near-zero theta as unavailable instead of returning noise', () => {
    expect(pickOptionQuoteTheta({ theta: [0] })).toBeNull();
    expect(pickOptionQuoteTheta({ theta: [0.00000001] })).toBeNull();
  });

  it('prefers the nearest valid call sample even when one strike has no usable price', () => {
    const sample = pickOptionQuoteSample(
      {
        strike: [210, 211],
        bid: [0, 1.2],
        ask: [0, 1.4],
        mid: [0, 0],
        last: [0, 0],
        theta: [-0.2, -0.09],
        delta: [0.4, 0.22],
        gamma: [0.01, 0.019]
      },
      210
    );

    expect(sample?.strike).toBe(211);
    expect(sample?.price).toBeCloseTo(1.3, 10);
    expect(sample?.strikeDistance).toBe(1);
    expect(sample?.theta).toBe(-0.09);
    expect(sample?.delta).toBe(0.22);
    expect(sample?.gamma).toBe(0.019);
  });

  it('returns null for unavailable delta and gamma values', () => {
    expect(pickOptionQuoteDelta({ delta: ['bad'] })).toBeNull();
    expect(pickOptionQuoteGamma({ gamma: [undefined] })).toBeNull();
  });
});
