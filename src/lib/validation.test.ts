import { describe, expect, it } from 'vitest';

import type { Config, PutPosition } from '../types';
import { validateConfig, validatePut } from './validation';

describe('validateConfig', () => {
  it('accepts valid config values', () => {
    const config: Config = {
      cash: 100000,
      risk_limit_pct: 0.2,
      warning_threshold_pct: 0.8
    };

    expect(validateConfig(config)).toEqual({});
  });

  it('rejects out-of-range config values', () => {
    const config: Config = {
      cash: -1,
      risk_limit_pct: 1.2,
      warning_threshold_pct: -0.1
    };

    expect(validateConfig(config)).toEqual({
      cash: '现金必须大于等于 0',
      risk_limit_pct: '风险上限必须在 0 到 1 之间',
      warning_threshold_pct: '预警阈值必须在 0 到 1 之间'
    });
  });
});

describe('validatePut', () => {
  it('accepts a valid put position', () => {
    const put: PutPosition = {
      id: 'put-1',
      ticker: 'NVDA',
      put_strike: 160,
      premium_per_share: 4.3,
      contracts: 1,
      iv_rank: 58.4,
      date_sold: '2026-03-26',
      expiration_date: '2026-05-08'
    };

    expect(validatePut(put)).toEqual({});
  });

  it('accepts a valid covered call position', () => {
    const put: PutPosition = {
      id: 'call-1',
      ticker: 'AMZN',
      option_side: 'call',
      put_strike: 220,
      premium_per_share: 2.94,
      contracts: 3,
      iv_rank: 41.2,
      date_sold: '2026-04-01',
      expiration_date: '2026-05-15'
    };

    expect(validatePut(put)).toEqual({});
  });

  it('rejects blank and invalid numeric fields', () => {
    const put: PutPosition = {
      id: 'put-1',
      ticker: '   ',
      put_strike: -1,
      premium_per_share: -0.5,
      contracts: 0,
      iv_rank: 120,
      date_sold: '',
      expiration_date: ''
    };

    expect(validatePut(put)).toEqual({
      ticker: 'Ticker 不能为空',
      put_strike: 'Strike 必须大于等于 0',
      premium_per_share: 'Premium 必须大于等于 0',
      contracts: '合约数必须是大于等于 1 的整数',
      iv_rank: 'IV Rank 必须在 0 到 100 之间',
      date_sold: 'Date Sold 不能为空',
      expiration_date: 'Expiration Date 不能为空'
    });
  });

  it('rejects expiration dates earlier than the sold date', () => {
    const put: PutPosition = {
      id: 'put-1',
      ticker: 'AAPL',
      put_strike: 200,
      premium_per_share: 3.1,
      contracts: 2,
      iv_rank: 35,
      date_sold: '2026-05-08',
      expiration_date: '2026-05-01'
    };

    expect(validatePut(put)).toEqual({
      expiration_date: 'Expiration Date 不能早于 Date Sold'
    });
  });
});
