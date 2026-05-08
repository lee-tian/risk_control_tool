import type { TickerEntry } from '../types';

export type QuoteRefreshPayload = {
  quotes?: Record<string, number>;
  rsi?: Record<string, number>;
  rsi1h?: Record<string, number>;
  ma21?: Record<string, number>;
  ma200?: Record<string, number>;
  atr14?: Record<string, number>;
  currentIv?: Record<string, number>;
  nextEarningsDate?: Record<string, string>;
  historicalIv?: Record<string, number>;
  ivRank?: Record<string, number>;
  ivPercentile?: Record<string, number>;
  putCallRatio?: Record<string, number>;
  as_of?: string;
};

export function parseJsonResponseText<T>(text: string, status: number, statusText = ''): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    if (text.trim().startsWith('<')) {
      throw new Error(`接口返回了 HTML，状态 ${status} ${statusText}`.trim());
    }

    throw new Error(text.trim() || `接口返回了无效响应，状态 ${status}`);
  }
}

export function applyTickerPcrRefresh(
  tickerList: TickerEntry[],
  ticker: string,
  putCallRatio: number,
  refreshedAt: string
): TickerEntry[] {
  return tickerList.map((entry) =>
    entry.ticker === ticker
      ? {
          ...entry,
          put_call_ratio: putCallRatio,
          put_call_ratio_updated: refreshedAt
        }
      : entry
  );
}

function isFutureOrTodayDate(value: string, referenceDate = new Date()): boolean {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) {
    return false;
  }

  const referenceDay = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate())
  );
  return parsed.getTime() >= referenceDay.getTime();
}

export function applyQuoteRefreshToTickerList(
  tickerList: TickerEntry[],
  payload: QuoteRefreshPayload,
  requestedTickers: string[]
): TickerEntry[] {
  const quotes = payload.quotes ?? {};
  const rsi = payload.rsi ?? {};
  const rsi1h = payload.rsi1h ?? {};
  const ma21 = payload.ma21 ?? {};
  const ma200 = payload.ma200 ?? {};
  const atr14 = payload.atr14 ?? {};
  const currentIv = payload.currentIv ?? {};
  const nextEarningsDate = payload.nextEarningsDate ?? {};
  const historicalIv = payload.historicalIv ?? {};
  const ivRank = payload.ivRank ?? {};
  const ivPercentile = payload.ivPercentile ?? {};
  const putCallRatio = payload.putCallRatio ?? {};
  const refreshedAt = payload.as_of ?? new Date().toISOString();

  return tickerList.map((entry) => {
    if (!requestedTickers.includes(entry.ticker)) {
      return entry;
    }

    const hasQuote = typeof quotes[entry.ticker] === 'number';
    const hasRsi = typeof rsi[entry.ticker] === 'number';
    const hasRsi1h = typeof rsi1h[entry.ticker] === 'number';
    const hasMa21 = typeof ma21[entry.ticker] === 'number';
    const hasMa200 = typeof ma200[entry.ticker] === 'number';
    const hasAtr14 = typeof atr14[entry.ticker] === 'number';
    const hasCurrentIv = typeof currentIv[entry.ticker] === 'number';
    const hasHistoricalIv = typeof historicalIv[entry.ticker] === 'number';
    const hasIvRank = typeof ivRank[entry.ticker] === 'number';
    const hasIvPercentile = typeof ivPercentile[entry.ticker] === 'number';
    const hasPutCallRatio = typeof putCallRatio[entry.ticker] === 'number';
    const hasEarningsDate =
      typeof nextEarningsDate[entry.ticker] === 'string' && nextEarningsDate[entry.ticker] !== '';
    const shouldClearStaleEarningsDate =
      !hasEarningsDate &&
      typeof entry.next_earnings_date === 'string' &&
      entry.next_earnings_date !== '' &&
      !isFutureOrTodayDate(entry.next_earnings_date);
    const hasAnyMarketDataUpdate =
      hasQuote ||
      hasRsi ||
      hasMa21 ||
      hasMa200 ||
      hasAtr14 ||
      hasCurrentIv ||
      hasHistoricalIv ||
      hasIvRank ||
      hasIvPercentile ||
      hasPutCallRatio ||
      hasEarningsDate;

    return {
      ...entry,
      current_price: hasQuote ? quotes[entry.ticker] : entry.current_price,
      last_updated: hasAnyMarketDataUpdate ? refreshedAt : entry.last_updated,
      next_earnings_date: hasEarningsDate
        ? nextEarningsDate[entry.ticker]
        : shouldClearStaleEarningsDate
          ? null
          : entry.next_earnings_date,
      rsi_14: hasRsi ? rsi[entry.ticker] : entry.rsi_14,
      rsi_14_1h: hasRsi1h ? rsi1h[entry.ticker] : entry.rsi_14_1h,
      rsi_updated: hasRsi ? refreshedAt : entry.rsi_updated,
      ma_21: hasMa21 ? ma21[entry.ticker] : entry.ma_21,
      ma_200: hasMa200 ? ma200[entry.ticker] : entry.ma_200,
      atr_14: hasAtr14 ? atr14[entry.ticker] : entry.atr_14,
      current_iv: hasCurrentIv ? currentIv[entry.ticker] : entry.current_iv,
      current_iv_updated: hasCurrentIv ? refreshedAt : entry.current_iv_updated,
      historical_iv: hasHistoricalIv ? historicalIv[entry.ticker] : entry.historical_iv,
      iv_rank: hasIvRank ? ivRank[entry.ticker] : entry.iv_rank,
      iv_percentile: hasIvPercentile ? ivPercentile[entry.ticker] : entry.iv_percentile,
      put_call_ratio: hasPutCallRatio ? putCallRatio[entry.ticker] : entry.put_call_ratio,
      put_call_ratio_updated: hasPutCallRatio ? refreshedAt : entry.put_call_ratio_updated
    };
  });
}
