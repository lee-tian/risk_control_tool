import type { ClosedPutTrade } from '../types';

function safeDivide(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) {
    return 0;
  }

  return numerator / denominator;
}

export function getHistoryHoldingDays(dateSold: string, closedAt: string): number {
  if (!dateSold || !closedAt) {
    return 0;
  }

  const opened = new Date(dateSold);
  const closed = new Date(closedAt);
  const millisecondsPerDay = 1000 * 60 * 60 * 24;
  const diffInMs = closed.getTime() - opened.getTime();

  if (!Number.isFinite(diffInMs) || diffInMs < 0) {
    return 0;
  }

  return Math.max(1, Math.ceil(diffInMs / millisecondsPerDay));
}

export function getHistoryCapitalUsage(trade: ClosedPutTrade): number {
  return trade.put_strike * trade.contracts * 100;
}

export function getHistoryProfitPct(trade: ClosedPutTrade): number {
  const premiumIncome = trade.premium_sold_per_share * trade.contracts * 100;
  return safeDivide(trade.realized_pnl, premiumIncome);
}

export function getHistoryAnnualizedYield(trade: ClosedPutTrade): number {
  const capitalUsage = getHistoryCapitalUsage(trade);
  const holdingDays = getHistoryHoldingDays(trade.date_sold, trade.closed_at);
  return safeDivide(trade.realized_pnl, capitalUsage) * safeDivide(365, holdingDays);
}
