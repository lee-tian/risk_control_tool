import type { TickerEntry } from '../types';

export type TickerDraft = {
  ticker: string;
  beta: string;
  shares: string;
  averageCostBasis: string;
  downsideTolerancePct: string;
  providerExchange: string;
  providerMicCode: string;
};

export function normalizeTickerSymbol(ticker: string): string {
  return ticker.trim().toUpperCase();
}

function toNullableNumber(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
}

export function createTickerEntryFromDraft(draft: TickerDraft): TickerEntry | null {
  const ticker = normalizeTickerSymbol(draft.ticker);
  if (ticker === '') {
    return null;
  }

  return {
    ticker,
    beta: toNullableNumber(draft.beta),
    shares: toNullableNumber(draft.shares),
    average_cost_basis: toNullableNumber(draft.averageCostBasis),
    downside_tolerance_pct:
      draft.downsideTolerancePct.trim() === '' ? null : toNullableNumber(draft.downsideTolerancePct) === null
        ? null
        : Number(draft.downsideTolerancePct) / 100,
    current_price: null,
    last_updated: null,
    next_earnings_date: null,
    current_iv: null,
    current_iv_updated: null,
    historical_iv: null,
    iv_rank: null,
    iv_percentile: null,
    put_call_ratio: null,
    put_call_ratio_updated: null,
    provider_exchange: draft.providerExchange.trim() === '' ? null : draft.providerExchange.trim().toUpperCase(),
    provider_mic_code: draft.providerMicCode.trim() === '' ? null : draft.providerMicCode.trim().toUpperCase(),
    rsi_14: null,
    rsi_14_1h: null,
    rsi_updated: null,
    ma_21: null,
    ma_200: null
  };
}

export function addTickerEntry(entries: TickerEntry[], draft: TickerDraft): TickerEntry[] {
  const nextEntry = createTickerEntryFromDraft(draft);
  if (!nextEntry) {
    return entries;
  }

  if (entries.some((entry) => entry.ticker === nextEntry.ticker)) {
    return entries;
  }

  return [...entries, nextEntry].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function findTickerEntry(entries: TickerEntry[], ticker: string): TickerEntry | null {
  const normalized = normalizeTickerSymbol(ticker);
  return entries.find((entry) => entry.ticker === normalized) ?? null;
}

export function updateTickerEntry(
  entries: TickerEntry[],
  ticker: string,
  patch: Partial<
    Pick<
      TickerEntry,
      'beta' | 'shares' | 'average_cost_basis' | 'downside_tolerance_pct' | 'provider_exchange' | 'provider_mic_code'
    >
  >
): TickerEntry[] {
  const normalized = normalizeTickerSymbol(ticker);
  return entries.map((entry) => (entry.ticker === normalized ? { ...entry, ...patch } : entry));
}

export function removeTickerEntry(entries: TickerEntry[], ticker: string): TickerEntry[] {
  const normalized = normalizeTickerSymbol(ticker);
  return entries.filter((entry) => entry.ticker !== normalized);
}
