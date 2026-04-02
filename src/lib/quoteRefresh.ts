import type { TickerEntry } from '../types';

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
