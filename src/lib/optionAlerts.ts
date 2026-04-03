type OptionAlertLikeRow = {
  premiumIncome: number;
  unrealizedPnl: number | null;
  premiumCapturedPct: number | null;
  expiration_date: string;
  daysToExpiration?: number;
};

export function getAttentionLevel(row: Pick<OptionAlertLikeRow, 'daysToExpiration' | 'premiumCapturedPct'>): 'red' | 'yellow' | null {
  const daysToExpiration = row.daysToExpiration ?? Number.POSITIVE_INFINITY;
  const premiumCapturedPct = row.premiumCapturedPct ?? 0;

  if ((daysToExpiration >= 0 && daysToExpiration < 7) || premiumCapturedPct > 0.7) {
    return 'red';
  }

  if ((daysToExpiration >= 0 && daysToExpiration < 21) || premiumCapturedPct > 0.5) {
    return 'yellow';
  }

  return null;
}

export function getAttentionReasons(row: Pick<OptionAlertLikeRow, 'daysToExpiration' | 'premiumCapturedPct'>): string[] {
  const daysToExpiration = row.daysToExpiration ?? Number.POSITIVE_INFINITY;
  const premiumCapturedPct = row.premiumCapturedPct ?? 0;

  return [
    ...(daysToExpiration >= 0 && daysToExpiration < 7
      ? ['到期日小于 7 天']
      : daysToExpiration >= 0 && daysToExpiration < 21
        ? ['到期日小于 21 天']
        : []),
    ...(premiumCapturedPct > 0.7
      ? ['盈利百分比超过 70%']
      : premiumCapturedPct > 0.5
        ? ['盈利百分比超过 50%']
        : [])
  ];
}

export function isOptionLossAtTwoXCredit(row: Pick<OptionAlertLikeRow, 'premiumIncome' | 'unrealizedPnl'>): boolean {
  return (
    typeof row.unrealizedPnl === 'number' &&
    row.unrealizedPnl < 0 &&
    row.premiumIncome > 0 &&
    Math.abs(row.unrealizedPnl) >= row.premiumIncome * 2
  );
}

export function compareOptionRowsByLossPct(a: OptionAlertLikeRow, b: OptionAlertLikeRow): number {
  const aLossPct = typeof a.premiumCapturedPct === 'number' ? a.premiumCapturedPct : Number.POSITIVE_INFINITY;
  const bLossPct = typeof b.premiumCapturedPct === 'number' ? b.premiumCapturedPct : Number.POSITIVE_INFINITY;

  if (aLossPct !== bLossPct) {
    return aLossPct - bLossPct;
  }

  const aLossAmount = typeof a.unrealizedPnl === 'number' && a.unrealizedPnl < 0 ? Math.abs(a.unrealizedPnl) : 0;
  const bLossAmount = typeof b.unrealizedPnl === 'number' && b.unrealizedPnl < 0 ? Math.abs(b.unrealizedPnl) : 0;

  if (aLossAmount !== bLossAmount) {
    return bLossAmount - aLossAmount;
  }

  return a.expiration_date.localeCompare(b.expiration_date);
}
