type OptionAlertLikeRow = {
  premiumIncome: number;
  unrealizedPnl: number | null;
  premiumCapturedPct: number | null;
  expiration_date: string;
};

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
