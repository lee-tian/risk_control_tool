import { describe, expect, it } from 'vitest';

import type { Config, PutPosition } from '../types';
import { applyOptionCloseCash, applyOptionOpenCash, applyStockBuyCash, applyStockSellCash } from './cashFlows';

const baseConfig: Config = {
  cash: 100000,
  risk_limit_pct: 0.2,
  warning_threshold_pct: 0.8
};

const samplePosition: PutPosition = {
  id: 'put-1',
  ticker: 'MSFT',
  option_side: 'put',
  put_strike: 390,
  premium_per_share: 12.57,
  contracts: 1,
  iv_rank: 35,
  date_sold: '2026-04-01',
  expiration_date: '2026-05-01',
  option_market_price_per_share: null,
  option_market_price_updated: null,
  option_theta_per_share: null,
  decision_rationale: '',
  decision_snapshot: null
};

const sampleCallPosition: PutPosition = {
  ...samplePosition,
  id: 'call-1',
  option_side: 'call',
  put_strike: 400,
  premium_per_share: 6.95,
  contracts: 2
};

describe('cashFlows', () => {
  it('adds premium to cash when opening a new option', () => {
    expect(applyOptionOpenCash(baseConfig, baseConfig, samplePosition, false).cash).toBe(101257);
  });

  it('adds call premium to cash when opening a covered call', () => {
    expect(applyOptionOpenCash(baseConfig, baseConfig, sampleCallPosition, false).cash).toBe(101390);
  });

  it('does not change cash when editing an option', () => {
    expect(applyOptionOpenCash(baseConfig, baseConfig, samplePosition, true).cash).toBe(100000);
  });

  it('subtracts buyback cost from cash when closing an option', () => {
    expect(applyOptionCloseCash(baseConfig, baseConfig, 3.2, 2).cash).toBe(99360);
  });

  it('falls back to the provided config values when current config is null', () => {
    expect(applyStockSellCash(null, baseConfig, 8400).cash).toBe(108400);
    expect(applyStockBuyCash(null, baseConfig, 12500).cash).toBe(87500);
    expect(applyOptionCloseCash(null, baseConfig, 3.2, 2).cash).toBe(99360);
  });

  it('adds stock sale proceeds to cash', () => {
    expect(applyStockSellCash(baseConfig, baseConfig, 8400).cash).toBe(108400);
  });

  it('subtracts stock purchase cost from cash', () => {
    expect(applyStockBuyCash(baseConfig, baseConfig, 12500).cash).toBe(87500);
  });
});
