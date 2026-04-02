import type { TickerEntry } from '../types';

export type TopIvRankStock = {
  ticker: string;
  ivRank: number;
  currentIv: number | null;
  earningsDate: string | null;
  marketValue: number;
  shares: number | null;
};

export function buildTopIvRankStocks(entries: TickerEntry[], limit = 5): TopIvRankStock[] {
  return entries
    .filter((entry): entry is TickerEntry & { iv_rank: number } => typeof entry.iv_rank === 'number' && Number.isFinite(entry.iv_rank))
    .map((entry) => ({
      ticker: entry.ticker,
      ivRank: entry.iv_rank,
      currentIv: entry.current_iv,
      earningsDate: entry.next_earnings_date ?? null,
      marketValue:
        typeof entry.shares === 'number' &&
        Number.isFinite(entry.shares) &&
        typeof entry.current_price === 'number' &&
        Number.isFinite(entry.current_price)
          ? entry.shares * entry.current_price
          : 0,
      shares: entry.shares
    }))
    .sort((a, b) => {
      if (b.ivRank !== a.ivRank) {
        return b.ivRank - a.ivRank;
      }
      if ((b.currentIv ?? -1) !== (a.currentIv ?? -1)) {
        return (b.currentIv ?? -1) - (a.currentIv ?? -1);
      }
      if (b.marketValue !== a.marketValue) {
        return b.marketValue - a.marketValue;
      }
      return a.ticker.localeCompare(b.ticker);
    })
    .slice(0, limit);
}
