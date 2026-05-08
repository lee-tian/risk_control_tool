import { describe, expect, it } from 'vitest';

import type { ClosedPutTrade } from '../types';
import {
  getHistoryAnnualizedYield,
  getHistoryCapitalUsage,
  getHistoryHoldingDays,
  getHistoryProfitPct
} from './historyMetrics';

const baseTrade: ClosedPutTrade = {
  id: 'closed-1',
  position_id: 'put-1',
  ticker: 'AXP',
  option_side: 'put',
  put_strike: 280,
  premium_sold_per_share: 4.5,
  premium_bought_back_per_share: 0.45,
  contracts: 1,
  date_sold: '2026-03-10',
  expiration_date: '2026-04-10',
  closed_at: '2026-04-06',
  close_reason: 'manual',
  realized_pnl: 405,
  reflection_notes: ''
};

describe('historyMetrics', () => {
  it('calculates holding days from open to close date', () => {
    expect(getHistoryHoldingDays(baseTrade.date_sold, baseTrade.closed_at)).toBe(27);
  });

  it('calculates option capital usage from strike and contracts', () => {
    expect(getHistoryCapitalUsage(baseTrade)).toBe(28000);
  });

  it('calculates realized profit percentage against premium income', () => {
    expect(getHistoryProfitPct(baseTrade)).toBeCloseTo(0.9, 6);
  });

  it('calculates annualized yield from realized pnl, capital usage and holding days', () => {
    expect(getHistoryAnnualizedYield(baseTrade)).toBeCloseTo((405 / 28000) * (365 / 27), 6);
  });
});
