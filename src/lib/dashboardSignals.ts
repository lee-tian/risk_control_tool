import type { TickerEntry } from '../types';

export type OptionCapitalUsageRow = {
  ticker: string;
  nominalExposure: number;
  option_side?: 'put' | 'call';
};

export type TopIvRankStock = {
  ticker: string;
  ivRank: number;
  currentIv: number | null;
  earningsDate: string | null;
  marketValue: number;
  optionCapitalUsage: number;
  totalCapitalUsage: number;
  capitalUsagePct: number | null;
  shares: number | null;
};

export function buildOptionCapitalUsageByTicker(rows: OptionCapitalUsageRow[]): Record<string, number> {
  return rows.reduce<Record<string, number>>((accumulator, row) => {
    if (row.option_side === 'call') {
      return accumulator;
    }

    accumulator[row.ticker] = (accumulator[row.ticker] ?? 0) + row.nominalExposure;
    return accumulator;
  }, {});
}

export function buildTopIvRankStocks(
  entries: TickerEntry[],
  totalCapitalBase = 0,
  optionCapitalUsageByTicker: Record<string, number> = {},
  limit = 5
): TopIvRankStock[] {
  return entries
    .filter((entry): entry is TickerEntry & { iv_rank: number } => typeof entry.iv_rank === 'number' && Number.isFinite(entry.iv_rank))
    .map((entry) => {
      const marketValue =
        typeof entry.shares === 'number' &&
        Number.isFinite(entry.shares) &&
        typeof entry.current_price === 'number' &&
        Number.isFinite(entry.current_price)
          ? entry.shares * entry.current_price
          : 0;
      const optionCapitalUsage = optionCapitalUsageByTicker[entry.ticker] ?? 0;
      const totalCapitalUsage = marketValue + optionCapitalUsage;

      return {
        ticker: entry.ticker,
        ivRank: entry.iv_rank,
        currentIv: entry.current_iv,
        earningsDate: entry.next_earnings_date ?? null,
        marketValue,
        optionCapitalUsage,
        totalCapitalUsage,
        capitalUsagePct: totalCapitalBase > 0 && totalCapitalUsage > 0 ? totalCapitalUsage / totalCapitalBase : null,
        shares: entry.shares
      };
    })
    .sort((a, b) => {
      if (b.ivRank !== a.ivRank) {
        return b.ivRank - a.ivRank;
      }
      if ((b.currentIv ?? -1) !== (a.currentIv ?? -1)) {
        return (b.currentIv ?? -1) - (a.currentIv ?? -1);
      }
      if (b.totalCapitalUsage !== a.totalCapitalUsage) {
        return b.totalCapitalUsage - a.totalCapitalUsage;
      }
      return a.ticker.localeCompare(b.ticker);
    })
    .slice(0, limit);
}
