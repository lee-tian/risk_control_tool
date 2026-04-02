import { describe, expect, it } from 'vitest';

import { compareOptionRowsByLossPct, isOptionLossAtTwoXCredit } from './optionAlerts';

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
});
