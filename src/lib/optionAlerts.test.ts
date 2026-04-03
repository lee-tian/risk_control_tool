import { describe, expect, it } from 'vitest';

import { compareOptionRowsByLossPct, getAttentionLevel, getAttentionReasons, isOptionLossAtTwoXCredit } from './optionAlerts';

describe('option alert helpers', () => {
  it('flags options whose unrealized loss reaches 2x premium income', () => {
    expect(
      isOptionLossAtTwoXCredit({
        premiumIncome: 1257,
        unrealizedPnl: -2514
      })
    ).toBe(true);

    expect(
      isOptionLossAtTwoXCredit({
        premiumIncome: 1257,
        unrealizedPnl: -1728
      })
    ).toBe(false);
  });

  it('sorts ITM rows by worst loss percentage first', () => {
    const rows = [
      {
        premiumIncome: 1025,
        unrealizedPnl: -847,
        premiumCapturedPct: -0.8268,
        expiration_date: '2026-05-01'
      },
      {
        premiumIncome: 1257,
        unrealizedPnl: -1728,
        premiumCapturedPct: -1.3747,
        expiration_date: '2026-05-01'
      },
      {
        premiumIncome: 480,
        unrealizedPnl: -415,
        premiumCapturedPct: -0.8646,
        expiration_date: '2026-04-10'
      }
    ];

    expect(rows.sort(compareOptionRowsByLossPct).map((row) => row.premiumCapturedPct)).toEqual([-1.3747, -0.8646, -0.8268]);
  });

  it('classifies attention rows into yellow and red levels', () => {
    expect(getAttentionLevel({ daysToExpiration: 18, premiumCapturedPct: 0.2 })).toBe('yellow');
    expect(getAttentionLevel({ daysToExpiration: 40, premiumCapturedPct: 0.55 })).toBe('yellow');
    expect(getAttentionLevel({ daysToExpiration: 6, premiumCapturedPct: 0.2 })).toBe('red');
    expect(getAttentionLevel({ daysToExpiration: 40, premiumCapturedPct: 0.75 })).toBe('red');
    expect(getAttentionLevel({ daysToExpiration: 30, premiumCapturedPct: 0.4 })).toBeNull();
  });

  it('builds attention reasons using the new threshold wording', () => {
    expect(getAttentionReasons({ daysToExpiration: 5, premiumCapturedPct: 0.72 })).toEqual([
      '到期日小于 7 天',
      '盈利百分比超过 70%'
    ]);

    expect(getAttentionReasons({ daysToExpiration: 18, premiumCapturedPct: 0.55 })).toEqual([
      '到期日小于 21 天',
      '盈利百分比超过 50%'
    ]);
  });
});
