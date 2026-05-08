import { describe, expect, it } from 'vitest';

import type { PutRiskRow } from '../types';
import { comparePositionRows } from './positionSorting';

function createRow(overrides: Partial<PutRiskRow>): PutRiskRow {
  return {
    id: overrides.id ?? 'row',
    ticker: overrides.ticker ?? 'AAA',
    put_strike: overrides.put_strike ?? 100,
    premium_per_share: overrides.premium_per_share ?? 1,
    contracts: overrides.contracts ?? 1,
    iv_rank: overrides.iv_rank ?? 20,
    date_sold: overrides.date_sold ?? '2026-04-01',
    expiration_date: overrides.expiration_date ?? '2026-05-01',
    option_side: overrides.option_side ?? 'put',
    distance_pct: overrides.distance_pct ?? 0.1,
    beta: overrides.beta ?? 1,
    baseStressAfterDistancePct: overrides.baseStressAfterDistancePct ?? 0.05,
    effectiveStressPct: overrides.effectiveStressPct ?? 0.05,
    nominalExposure: overrides.nominalExposure ?? 10000,
    premiumIncome: overrides.premiumIncome ?? 100,
    daysToExpiration: overrides.daysToExpiration ?? 30,
    annualizedYield: overrides.annualizedYield ?? 0.1,
    breakevenPrice: overrides.breakevenPrice ?? 99,
    netCostBasis: overrides.netCostBasis ?? 9900,
    putRisk: overrides.putRisk ?? 500,
    riskPctOfCash: overrides.riskPctOfCash ?? 0.01,
    optionCloseCost: overrides.optionCloseCost ?? 50,
    unrealizedPnl: overrides.unrealizedPnl ?? 50,
    premiumCapturedPct: overrides.premiumCapturedPct ?? 0.5,
    optionThetaPerShare: overrides.optionThetaPerShare ?? -0.05,
    optionDelta: overrides.optionDelta ?? -0.2,
    optionGamma: overrides.optionGamma ?? 0.01,
    gammaThetaRatio: overrides.gammaThetaRatio ?? 0.2,
    thetaIncomePerDay: overrides.thetaIncomePerDay ?? 5
  };
}

describe('comparePositionRows', () => {
  it('sorts annualized yield in both directions', () => {
    const low = createRow({ id: 'low', annualizedYield: 0.08 });
    const high = createRow({ id: 'high', annualizedYield: 0.22 });

    expect(comparePositionRows(low, high, 'ANNUALIZED_YIELD', 'ASC')).toBeLessThan(0);
    expect(comparePositionRows(low, high, 'ANNUALIZED_YIELD', 'DESC')).toBeGreaterThan(0);
  });

  it('sorts default ticker/expiration in both directions', () => {
    const a = createRow({ id: 'a', ticker: 'AAPL', expiration_date: '2026-05-01' });
    const b = createRow({ id: 'b', ticker: 'NVDA', expiration_date: '2026-04-01' });

    expect(comparePositionRows(a, b, 'DEFAULT', 'ASC')).toBeLessThan(0);
    expect(comparePositionRows(a, b, 'DEFAULT', 'DESC')).toBeGreaterThan(0);
  });

  it('sorts risk and loss percent in both directions', () => {
    const safer = createRow({ id: 'safer', putRisk: 200, premiumCapturedPct: 0.7 });
    const riskier = createRow({ id: 'riskier', putRisk: 900, premiumCapturedPct: 0.1 });

    expect(comparePositionRows(safer, riskier, 'PUT_RISK', 'ASC')).toBeLessThan(0);
    expect(comparePositionRows(safer, riskier, 'PUT_RISK', 'DESC')).toBeGreaterThan(0);
    expect(comparePositionRows(safer, riskier, 'LOSS_PCT', 'ASC')).toBeGreaterThan(0);
    expect(comparePositionRows(safer, riskier, 'LOSS_PCT', 'DESC')).toBeLessThan(0);
  });
});
