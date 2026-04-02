import { describe, expect, it } from 'vitest';

import { buildPutEntryChecks } from './putCheckRules.mjs';

describe('buildPutEntryChecks', () => {
  it('adds VIX, IV Rank, and oversold checks for sell puts', () => {
    const result = buildPutEntryChecks({
      side: 'put',
      strike: 184,
      currentPrice: 200,
      beta: 1.1,
      dateSold: '2026-04-01',
      expirationDate: '2026-05-20',
      ma20: 205,
      rsi: 28,
      vix: 24,
      ivRank: 42
    });

    expect(result.checks.map((item) => item.id)).toEqual([
      'otm_by_beta',
      'vix_window',
      'iv_rank',
      'dte',
      'strike_below_ma20',
      'oversold'
    ]);
    expect(result.checks.every((item) => item.passed)).toBe(true);
  });

  it('keeps covered call checks focused on strike and DTE only', () => {
    const result = buildPutEntryChecks({
      side: 'call',
      strike: 220,
      currentPrice: 200,
      beta: 1.1,
      dateSold: '2026-04-01',
      expirationDate: '2026-04-20',
      ma20: 195,
      rsi: 52,
      vix: 16,
      ivRank: 18
    });

    expect(result.checks.map((item) => item.id)).toEqual([
      'otm_call',
      'dte',
      'strike_above_ma20'
    ]);
    expect(result.checks.every((item) => item.passed)).toBe(true);
  });

  it('fails sell put checks when VIX is too low, IV Rank is too low, and RSI is not oversold', () => {
    const result = buildPutEntryChecks({
      side: 'put',
      strike: 185,
      currentPrice: 200,
      beta: 1.1,
      dateSold: '2026-04-01',
      expirationDate: '2026-05-20',
      ma20: 205,
      rsi: 44,
      vix: 17,
      ivRank: 21
    });

    expect(result.checks.find((item) => item.id === 'vix_window')?.passed).toBe(false);
    expect(result.checks.find((item) => item.id === 'iv_rank')?.passed).toBe(false);
    expect(result.checks.find((item) => item.id === 'oversold')?.passed).toBe(false);
  });
});
