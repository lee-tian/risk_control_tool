import type { PutRiskRow } from '../types';

export type PositionSortField = 'DEFAULT' | 'EXPIRATION' | 'PUT_RISK' | 'LOSS_PCT' | 'ANNUALIZED_YIELD';
export type PositionSortDirection = 'ASC' | 'DESC';

export function comparePositionRows(
  a: PutRiskRow,
  b: PutRiskRow,
  sortField: PositionSortField,
  sortDirection: PositionSortDirection
): number {
  const direction = sortDirection === 'ASC' ? 1 : -1;

  if (sortField === 'DEFAULT') {
    const tickerCompare = a.ticker.localeCompare(b.ticker);
    if (tickerCompare !== 0) {
      return direction * tickerCompare;
    }

    const expirationCompare = a.expiration_date.localeCompare(b.expiration_date);
    if (expirationCompare !== 0) {
      return direction * expirationCompare;
    }

    return direction * a.id.localeCompare(b.id);
  }

  if (sortField === 'EXPIRATION') {
    const expirationCompare = a.expiration_date.localeCompare(b.expiration_date);
    if (expirationCompare !== 0) {
      return direction * expirationCompare;
    }

    const tickerCompare = a.ticker.localeCompare(b.ticker);
    if (tickerCompare !== 0) {
      return tickerCompare;
    }

    return a.id.localeCompare(b.id);
  }

  if (sortField === 'PUT_RISK') {
    if (a.putRisk !== b.putRisk) {
      return direction * (a.putRisk - b.putRisk);
    }

    return a.expiration_date.localeCompare(b.expiration_date);
  }

  if (sortField === 'LOSS_PCT') {
    const aLossPct = typeof a.premiumCapturedPct === 'number' ? a.premiumCapturedPct : Number.POSITIVE_INFINITY;
    const bLossPct = typeof b.premiumCapturedPct === 'number' ? b.premiumCapturedPct : Number.POSITIVE_INFINITY;

    if (aLossPct !== bLossPct) {
      return direction * (aLossPct - bLossPct);
    }

    return b.putRisk - a.putRisk;
  }

  if (a.annualizedYield !== b.annualizedYield) {
    return direction * (a.annualizedYield - b.annualizedYield);
  }

  return b.putRisk - a.putRisk;
}
