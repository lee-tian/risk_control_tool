export function calculateRewardRiskRatio({
  entryPrice,
  stopPrice,
  targetPrice
}: {
  entryPrice: number | null | undefined;
  stopPrice: number | null | undefined;
  targetPrice: number | null | undefined;
}): number | null {
  if (
    typeof entryPrice !== 'number' ||
    typeof stopPrice !== 'number' ||
    typeof targetPrice !== 'number' ||
    !Number.isFinite(entryPrice) ||
    !Number.isFinite(stopPrice) ||
    !Number.isFinite(targetPrice)
  ) {
    return null;
  }

  const riskPerShare = entryPrice - stopPrice;
  const rewardPerShare = targetPrice - entryPrice;
  if (riskPerShare <= 0 || rewardPerShare <= 0) {
    return null;
  }

  return rewardPerShare / riskPerShare;
}

export type RewardRiskAssessment = {
  label: string;
  tone: 'red' | 'yellow' | 'green';
};

export function assessRewardRiskRatio(ratio: number | null | undefined): RewardRiskAssessment | null {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) {
    return null;
  }

  if (ratio < 1.5) {
    return { label: '偏弱', tone: 'red' };
  }
  if (ratio < 2) {
    return { label: '一般', tone: 'yellow' };
  }
  if (ratio < 3) {
    return { label: '合格', tone: 'yellow' };
  }
  if (ratio < 4) {
    return { label: '好', tone: 'green' };
  }
  return { label: '优秀', tone: 'green' };
}
