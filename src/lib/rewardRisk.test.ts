import { describe, expect, it } from 'vitest';
import { assessRewardRiskRatio, calculateRewardRiskRatio } from './rewardRisk';

describe('calculateRewardRiskRatio', () => {
  it('uses current price as entry price and returns reward divided by risk', () => {
    expect(
      calculateRewardRiskRatio({
        entryPrice: 275.75,
        stopPrice: 269.74,
        targetPrice: 300
      })
    ).toBeCloseTo(4.0349, 4);
  });

  it('returns null when a required price is missing', () => {
    expect(calculateRewardRiskRatio({ entryPrice: null, stopPrice: 269.74, targetPrice: 300 })).toBeNull();
    expect(calculateRewardRiskRatio({ entryPrice: 275.75, stopPrice: null, targetPrice: 300 })).toBeNull();
    expect(calculateRewardRiskRatio({ entryPrice: 275.75, stopPrice: 269.74, targetPrice: null })).toBeNull();
  });

  it('returns null when risk or reward is not positive', () => {
    expect(calculateRewardRiskRatio({ entryPrice: 275.75, stopPrice: 276, targetPrice: 300 })).toBeNull();
    expect(calculateRewardRiskRatio({ entryPrice: 275.75, stopPrice: 269.74, targetPrice: 270 })).toBeNull();
  });
});

describe('assessRewardRiskRatio', () => {
  it('labels common trading reward/risk bands', () => {
    expect(assessRewardRiskRatio(1.2)).toEqual({ label: '偏弱', tone: 'red' });
    expect(assessRewardRiskRatio(1.8)).toEqual({ label: '一般', tone: 'yellow' });
    expect(assessRewardRiskRatio(2.4)).toEqual({ label: '合格', tone: 'yellow' });
    expect(assessRewardRiskRatio(3.5)).toEqual({ label: '好', tone: 'green' });
    expect(assessRewardRiskRatio(4.1)).toEqual({ label: '优秀', tone: 'green' });
  });

  it('returns null when the ratio is missing', () => {
    expect(assessRewardRiskRatio(null)).toBeNull();
    expect(assessRewardRiskRatio(Number.NaN)).toBeNull();
  });
});
