import type {
  AccountValueSnapshot,
  AppStateSnapshot,
  ClosedPutTrade,
  Config,
  PutPosition,
  PutPositionsExportPayload,
  RiskScorePoint,
  StockTradeHistory,
  StressMode,
  StressScenario,
  TickerEntry,
  VixHistoryPoint
} from '../types';

const STORAGE_KEYS = {
  config: 'risk-tool-config',
  puts: 'risk-tool-puts',
  deletedPositionIds: 'risk-tool-deleted-position-ids',
  tickerList: 'risk-tool-ticker-list',
  deletedTickers: 'risk-tool-deleted-tickers',
  closedTrades: 'risk-tool-closed-trades',
  stockTrades: 'risk-tool-stock-trades',
  scenario: 'risk-tool-scenario',
  stressMode: 'risk-tool-stress-mode',
  scoreHistory: 'risk-tool-score-history',
  vixHistory: 'risk-tool-vix-history',
  accountValueHistory: 'risk-tool-account-value-history'
} as const;

const DEFAULT_BETA_BY_TICKER: Record<string, number> = {
  AAPL: 0.87,
  AMZN: 1.31,
  AXP: 1.34,
  'BRK.B': 0.36,
  BRKB: 0.36,
  GLD: 0.19,
  GOOGL: 0.72,
  MSFT: 1.08,
  NVDA: 2.17,
  QQQ: 1.12
};

const DEFAULT_PROVIDER_BY_TICKER: Record<string, { exchange: string | null; mic_code: string | null }> = {
  GLD: {
    exchange: 'NYSE',
    mic_code: 'ARCX'
  }
};

function normalizeOptionSide(value: unknown): 'put' | 'call' {
  return value === 'call' ? 'call' : 'put';
}

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return fallback;
    }

    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function saveJson<T>(key: string, value: T): void {
  window.localStorage.setItem(key, JSON.stringify(value));
}

export function loadConfig(): Config | null {
  const rawConfig = loadJson<Record<string, unknown> | null>(STORAGE_KEYS.config, null);
  if (!rawConfig) {
    return null;
  }

  return {
    cash: typeof rawConfig.cash === 'number'
      ? rawConfig.cash
      : typeof rawConfig.total_cash === 'number'
        ? rawConfig.total_cash
        : 0,
    risk_limit_pct: typeof rawConfig.risk_limit_pct === 'number' ? rawConfig.risk_limit_pct : 0.2,
    warning_threshold_pct:
      typeof rawConfig.warning_threshold_pct === 'number' ? rawConfig.warning_threshold_pct : 0.8
  };
}

export function saveConfig(config: Config): void {
  saveJson(STORAGE_KEYS.config, config);
}

export function clearCoreAppStateCache(): void {
  for (const key of [
    STORAGE_KEYS.config,
    STORAGE_KEYS.puts,
    STORAGE_KEYS.deletedPositionIds,
    STORAGE_KEYS.tickerList,
    STORAGE_KEYS.deletedTickers,
    STORAGE_KEYS.closedTrades,
    STORAGE_KEYS.stockTrades,
    STORAGE_KEYS.scenario,
    STORAGE_KEYS.vixHistory,
    STORAGE_KEYS.accountValueHistory
  ]) {
    window.localStorage.removeItem(key);
  }
}

export function loadPuts(): PutPosition[] {
  const rawPuts = loadJson<Array<Record<string, unknown>>>(STORAGE_KEYS.puts, []);

  return rawPuts.map((put) => ({
    id: typeof put.id === 'string' ? put.id : '',
    ticker: typeof put.ticker === 'string' ? put.ticker.trim().toUpperCase() : '',
    option_side: normalizeOptionSide(put.option_side),
    put_strike: typeof put.put_strike === 'number' ? put.put_strike : 0,
    premium_per_share: typeof put.premium_per_share === 'number' ? put.premium_per_share : 0,
    contracts: typeof put.contracts === 'number' ? put.contracts : 1,
    iv_rank: typeof put.iv_rank === 'number' ? put.iv_rank : 0,
    date_sold: typeof put.date_sold === 'string' ? put.date_sold : '',
    expiration_date: typeof put.expiration_date === 'string' ? put.expiration_date : '',
    option_market_price_per_share:
      typeof put.option_market_price_per_share === 'number' ? put.option_market_price_per_share : null,
    option_market_price_updated:
      typeof put.option_market_price_updated === 'string' ? put.option_market_price_updated : null,
    option_theta_per_share:
      typeof put.option_theta_per_share === 'number' ? put.option_theta_per_share : null,
    decision_rationale: typeof put.decision_rationale === 'string' ? put.decision_rationale : '',
    decision_snapshot:
      typeof put.decision_snapshot === 'object' && put.decision_snapshot !== null
        ? {
            verdict:
              typeof (put.decision_snapshot as Record<string, unknown>).verdict === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).verdict as string)
                : '',
            summary:
              typeof (put.decision_snapshot as Record<string, unknown>).summary === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).summary as string)
                : '',
            rationale_check:
              typeof (put.decision_snapshot as Record<string, unknown>).rationale_check === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).rationale_check as string)
                : '',
            worst_case:
              typeof (put.decision_snapshot as Record<string, unknown>).worst_case === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).worst_case as string)
                : '',
            fundamental_note:
              typeof (put.decision_snapshot as Record<string, unknown>).fundamental_note === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).fundamental_note as string)
                : '',
            fundamental_events: Array.isArray((put.decision_snapshot as Record<string, unknown>).fundamental_events)
              ? (((put.decision_snapshot as Record<string, unknown>).fundamental_events as unknown[]).filter(
                  (item): item is string => typeof item === 'string'
                ))
              : [],
            current_iv_rank:
              typeof (put.decision_snapshot as Record<string, unknown>).current_iv_rank === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).current_iv_rank as string)
                : '',
            iv_rank_note:
              typeof (put.decision_snapshot as Record<string, unknown>).iv_rank_note === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).iv_rank_note as string)
                : '',
            iv_rank_source:
              typeof (put.decision_snapshot as Record<string, unknown>).iv_rank_source === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).iv_rank_source as string)
                : '',
            iv_rank_time:
              typeof (put.decision_snapshot as Record<string, unknown>).iv_rank_time === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).iv_rank_time as string)
                : '',
            iv_rank_link:
              typeof (put.decision_snapshot as Record<string, unknown>).iv_rank_link === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).iv_rank_link as string)
                : '',
            action:
              typeof (put.decision_snapshot as Record<string, unknown>).action === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).action as string)
                : '',
            key_risks: Array.isArray((put.decision_snapshot as Record<string, unknown>).key_risks)
              ? (((put.decision_snapshot as Record<string, unknown>).key_risks as unknown[]).filter(
                  (item): item is string => typeof item === 'string'
                ))
              : [],
            max_profit:
              typeof (put.decision_snapshot as Record<string, unknown>).max_profit === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).max_profit as string)
                : '',
            risk_at_10pct_drop:
              typeof (put.decision_snapshot as Record<string, unknown>).risk_at_10pct_drop === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).risk_at_10pct_drop as string)
                : '',
            analyzed_at:
              typeof (put.decision_snapshot as Record<string, unknown>).analyzed_at === 'string'
                ? ((put.decision_snapshot as Record<string, unknown>).analyzed_at as string)
                : ''
          }
        : null
  }));
}

export function savePuts(puts: PutPosition[]): void {
  saveJson(STORAGE_KEYS.puts, puts);
}

export function loadDeletedPositionIds(): string[] {
  const raw = loadJson<unknown[]>(STORAGE_KEYS.deletedPositionIds, []);
  return [...new Set(raw.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean))].sort();
}

export function saveDeletedPositionIds(ids: string[]): void {
  const normalized = [...new Set(ids.map((item) => item.trim()).filter(Boolean))].sort();
  saveJson(STORAGE_KEYS.deletedPositionIds, normalized);
}

export function filterDeletedPutPositions(puts: PutPosition[], deletedIds: string[]): PutPosition[] {
  if (deletedIds.length === 0) {
    return puts;
  }

  const deletedSet = new Set(deletedIds.map((item) => item.trim()).filter(Boolean));
  return puts.filter((put) => !deletedSet.has(put.id));
}

export function reconcileHydratedOpenPositions(
  snapshotPuts: PutPosition[],
  localPuts: PutPosition[],
  deletedIds: string[],
  closedTrades: ClosedPutTrade[]
): PutPosition[] {
  const localOpenIds = new Set(localPuts.map((put) => put.id).filter(Boolean));
  const closedPositionIds = new Set(
    closedTrades
      .map((trade) => trade.position_id.trim())
      .filter((id) => id !== '' && !localOpenIds.has(id))
  );

  return mergePutPositionsPreservingLocal(
    filterDeletedPutPositions(snapshotPuts, deletedIds).filter((put) => !closedPositionIds.has(put.id)),
    filterDeletedPutPositions(localPuts, deletedIds)
  );
}

export function mergePutPositionsPreservingLocal(snapshotPuts: PutPosition[], localPuts: PutPosition[]): PutPosition[] {
  const snapshotById = new Map(snapshotPuts.filter((put) => put.id !== '').map((put) => [put.id, put]));
  const localById = new Map(localPuts.filter((put) => put.id !== '').map((put) => [put.id, put]));
  const mergedById = new Map<string, PutPosition>();

  for (const id of new Set([...snapshotById.keys(), ...localById.keys()])) {
    const snapshotPut = snapshotById.get(id);
    const localPut = localById.get(id);

    if (snapshotPut && localPut) {
      mergedById.set(id, {
        ...snapshotPut,
        ...localPut,
        option_market_price_per_share: snapshotPut.option_market_price_per_share ?? localPut.option_market_price_per_share,
        option_market_price_updated: snapshotPut.option_market_price_updated ?? localPut.option_market_price_updated,
        option_theta_per_share: snapshotPut.option_theta_per_share ?? localPut.option_theta_per_share,
        decision_rationale: localPut.decision_rationale || snapshotPut.decision_rationale,
        decision_snapshot: snapshotPut.decision_snapshot ?? localPut.decision_snapshot
      });
      continue;
    }

    if (snapshotPut) {
      mergedById.set(id, snapshotPut);
      continue;
    }

    if (localPut) {
      mergedById.set(id, localPut);
    }
  }

  return [...mergedById.values()].sort((a, b) => {
    if (a.ticker !== b.ticker) {
      return a.ticker.localeCompare(b.ticker);
    }

    if (a.expiration_date !== b.expiration_date) {
      return a.expiration_date.localeCompare(b.expiration_date);
    }

    return a.id.localeCompare(b.id);
  });
}

export function loadClosedTrades(): ClosedPutTrade[] {
  const rawTrades = loadJson<Array<Record<string, unknown>>>(STORAGE_KEYS.closedTrades, []);

  return rawTrades
    .map((trade) => {
      const closeReason: ClosedPutTrade['close_reason'] = trade.close_reason === 'expired' ? 'expired' : 'manual';

      return {
        id: typeof trade.id === 'string' ? trade.id : '',
        position_id: typeof trade.position_id === 'string' ? trade.position_id : '',
        ticker: typeof trade.ticker === 'string' ? trade.ticker.trim().toUpperCase() : '',
        option_side: normalizeOptionSide(trade.option_side),
        put_strike: typeof trade.put_strike === 'number' ? trade.put_strike : 0,
        premium_sold_per_share: typeof trade.premium_sold_per_share === 'number' ? trade.premium_sold_per_share : 0,
        premium_bought_back_per_share:
          typeof trade.premium_bought_back_per_share === 'number' ? trade.premium_bought_back_per_share : 0,
        contracts: typeof trade.contracts === 'number' ? trade.contracts : 1,
        date_sold: typeof trade.date_sold === 'string' ? trade.date_sold : '',
        expiration_date: typeof trade.expiration_date === 'string' ? trade.expiration_date : '',
        closed_at: typeof trade.closed_at === 'string' ? trade.closed_at : '',
        close_reason: closeReason,
        realized_pnl: typeof trade.realized_pnl === 'number' ? trade.realized_pnl : 0,
        reflection_notes: typeof trade.reflection_notes === 'string' ? trade.reflection_notes : ''
      };
    })
    .filter((trade) => trade.id !== '' && trade.ticker !== '');
}

export function saveClosedTrades(trades: ClosedPutTrade[]): void {
  saveJson(STORAGE_KEYS.closedTrades, trades);
}

export function loadStockTrades(): StockTradeHistory[] {
  const rawTrades = loadJson<Array<Record<string, unknown>>>(STORAGE_KEYS.stockTrades, []);

  return rawTrades
    .map<StockTradeHistory>((trade) => ({
      id: typeof trade.id === 'string' ? trade.id : '',
      ticker: typeof trade.ticker === 'string' ? trade.ticker.trim().toUpperCase() : '',
      action: trade.action === 'buy' ? 'buy' : 'sell',
      shares: typeof trade.shares === 'number' ? trade.shares : 0,
      price_per_share: typeof trade.price_per_share === 'number' ? trade.price_per_share : 0,
      traded_at: typeof trade.traded_at === 'string' ? trade.traded_at : '',
      cash_change: typeof trade.cash_change === 'number' ? trade.cash_change : 0,
      realized_pnl: typeof trade.realized_pnl === 'number' ? trade.realized_pnl : 0
    }))
    .filter((trade) => trade.id !== '' && trade.ticker !== '' && trade.traded_at !== '');
}

export function saveStockTrades(trades: StockTradeHistory[]): void {
  saveJson(STORAGE_KEYS.stockTrades, trades);
}

export function mergeStockTradesPreservingLocal(
  snapshotTrades: StockTradeHistory[],
  localTrades: StockTradeHistory[]
): StockTradeHistory[] {
  const mergedById = new Map<string, StockTradeHistory>();

  for (const trade of snapshotTrades) {
    mergedById.set(trade.id, trade);
  }

  for (const trade of localTrades) {
    mergedById.set(trade.id, trade);
  }

  return [...mergedById.values()].sort((a, b) => b.traded_at.localeCompare(a.traded_at));
}

export function mergeClosedTradesPreservingLocal(
  snapshotTrades: ClosedPutTrade[],
  localTrades: ClosedPutTrade[]
): ClosedPutTrade[] {
  const mergedById = new Map<string, ClosedPutTrade>();

  for (const trade of snapshotTrades) {
    if (trade.id !== '') {
      mergedById.set(trade.id, trade);
    }
  }

  for (const trade of localTrades) {
    if (trade.id !== '') {
      mergedById.set(trade.id, trade);
    }
  }

  return [...mergedById.values()].sort((a, b) => b.closed_at.localeCompare(a.closed_at));
}

export function loadTickerList(): TickerEntry[] {
  const rawTickers = loadJson<unknown[]>(STORAGE_KEYS.tickerList, []);
  const mappedEntries: Array<TickerEntry | null> = rawTickers.map((item): TickerEntry | null => {
      if (typeof item === 'string') {
        const ticker = item.trim().toUpperCase();
        return ticker === ''
          ? null
          : {
              ticker,
              beta: DEFAULT_BETA_BY_TICKER[ticker] ?? null,
              shares: null,
              average_cost_basis: null,
              downside_tolerance_pct: null,
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
              provider_exchange: DEFAULT_PROVIDER_BY_TICKER[ticker]?.exchange ?? null,
              provider_mic_code: DEFAULT_PROVIDER_BY_TICKER[ticker]?.mic_code ?? null,
              rsi_14: null,
              rsi_14_1h: null,
              rsi_updated: null,
              ma_21: null,
              ma_200: null
            };
      }

      if (typeof item === 'object' && item !== null) {
        const record = item as Record<string, unknown>;
        const ticker = typeof record.ticker === 'string' ? record.ticker.trim().toUpperCase() : '';
        if (ticker === '') {
          return null;
        }

        return {
          ticker,
          beta: typeof record.beta === 'number' ? record.beta : DEFAULT_BETA_BY_TICKER[ticker] ?? null,
          shares: typeof record.shares === 'number' ? record.shares : null,
          average_cost_basis: typeof record.average_cost_basis === 'number' ? record.average_cost_basis : null,
          downside_tolerance_pct:
            typeof record.downside_tolerance_pct === 'number' ? record.downside_tolerance_pct : null,
          current_price: typeof record.current_price === 'number' ? record.current_price : null,
          last_updated: typeof record.last_updated === 'string' ? record.last_updated : null,
          next_earnings_date: typeof record.next_earnings_date === 'string' ? record.next_earnings_date : null,
          current_iv: typeof record.current_iv === 'number'
            ? record.current_iv
            : typeof record.iv_rank === 'number'
              ? record.iv_rank
              : null,
          current_iv_updated: typeof record.current_iv_updated === 'string' ? record.current_iv_updated : null,
          historical_iv: typeof record.historical_iv === 'number' ? record.historical_iv : null,
          iv_rank: typeof record.iv_rank === 'number' ? record.iv_rank : null,
          iv_percentile: typeof record.iv_percentile === 'number' ? record.iv_percentile : null,
          put_call_ratio: typeof record.put_call_ratio === 'number' ? record.put_call_ratio : null,
          put_call_ratio_updated:
            typeof record.put_call_ratio_updated === 'string' ? record.put_call_ratio_updated : null,
          provider_exchange:
            typeof record.provider_exchange === 'string'
              ? record.provider_exchange.trim().toUpperCase()
              : DEFAULT_PROVIDER_BY_TICKER[ticker]?.exchange ?? null,
          provider_mic_code:
            typeof record.provider_mic_code === 'string'
              ? record.provider_mic_code.trim().toUpperCase()
              : DEFAULT_PROVIDER_BY_TICKER[ticker]?.mic_code ?? null,
          rsi_14: typeof record.rsi_14 === 'number' ? record.rsi_14 : null,
          rsi_14_1h: typeof record.rsi_14_1h === 'number' ? record.rsi_14_1h : null,
          rsi_updated: typeof record.rsi_updated === 'string' ? record.rsi_updated : null,
          ma_21: typeof record.ma_21 === 'number' ? record.ma_21 : null,
          ma_200: typeof record.ma_200 === 'number' ? record.ma_200 : null
        };
      }

      return null;
    });

  const normalizedEntries = mappedEntries.filter((entry): entry is TickerEntry => entry !== null);

  return normalizedEntries
    .filter((entry, index, list) => list.findIndex((candidate) => candidate.ticker === entry.ticker) === index)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function saveTickerList(entries: TickerEntry[]): void {
  const normalized = entries
    .map((entry) => ({
      ticker: entry.ticker.trim().toUpperCase(),
      beta: typeof entry.beta === 'number' ? entry.beta : null,
      shares: typeof entry.shares === 'number' ? entry.shares : null,
      average_cost_basis: typeof entry.average_cost_basis === 'number' ? entry.average_cost_basis : null,
      downside_tolerance_pct:
        typeof entry.downside_tolerance_pct === 'number' ? entry.downside_tolerance_pct : null,
      current_price: typeof entry.current_price === 'number' ? entry.current_price : null,
      last_updated: typeof entry.last_updated === 'string' ? entry.last_updated : null,
      next_earnings_date: typeof entry.next_earnings_date === 'string' ? entry.next_earnings_date : null,
      current_iv: typeof entry.current_iv === 'number' ? entry.current_iv : null,
      current_iv_updated: typeof entry.current_iv_updated === 'string' ? entry.current_iv_updated : null,
      historical_iv: typeof entry.historical_iv === 'number' ? entry.historical_iv : null,
      iv_rank: typeof entry.iv_rank === 'number' ? entry.iv_rank : null,
      iv_percentile: typeof entry.iv_percentile === 'number' ? entry.iv_percentile : null,
      put_call_ratio: typeof entry.put_call_ratio === 'number' ? entry.put_call_ratio : null,
      put_call_ratio_updated: typeof entry.put_call_ratio_updated === 'string' ? entry.put_call_ratio_updated : null,
      provider_exchange: typeof entry.provider_exchange === 'string' ? entry.provider_exchange.trim().toUpperCase() : null,
      provider_mic_code: typeof entry.provider_mic_code === 'string' ? entry.provider_mic_code.trim().toUpperCase() : null,
      rsi_14: typeof entry.rsi_14 === 'number' ? entry.rsi_14 : null,
      rsi_14_1h: typeof entry.rsi_14_1h === 'number' ? entry.rsi_14_1h : null,
      rsi_updated: typeof entry.rsi_updated === 'string' ? entry.rsi_updated : null,
      ma_21: typeof entry.ma_21 === 'number' ? entry.ma_21 : null,
      ma_200: typeof entry.ma_200 === 'number' ? entry.ma_200 : null
    }))
    .filter((entry, index, list) => entry.ticker !== '' && list.findIndex((candidate) => candidate.ticker === entry.ticker) === index)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));

  saveJson(STORAGE_KEYS.tickerList, normalized);
}

export function loadDeletedTickers(): string[] {
  const raw = loadJson<unknown[]>(STORAGE_KEYS.deletedTickers, []);
  return raw
    .map((item) => (typeof item === 'string' ? item.trim().toUpperCase() : ''))
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .sort();
}

export function saveDeletedTickers(tickers: string[]): void {
  const normalized = tickers
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean)
    .filter((item, index, list) => list.indexOf(item) === index)
    .sort();
  saveJson(STORAGE_KEYS.deletedTickers, normalized);
}

export function filterDeletedTickers(entries: TickerEntry[], deletedTickers: string[]): TickerEntry[] {
  const deletedSet = new Set(deletedTickers.map((item) => item.trim().toUpperCase()).filter(Boolean));
  if (deletedSet.size === 0) {
    return entries;
  }

  return entries.filter((entry) => !deletedSet.has(entry.ticker));
}

export function mergeTickerListsPreservingManualFields(
  snapshotEntries: TickerEntry[],
  localEntries: TickerEntry[]
): TickerEntry[] {
  const snapshotByTicker = new Map(snapshotEntries.map((entry) => [entry.ticker, entry]));
  const localByTicker = new Map(localEntries.map((entry) => [entry.ticker, entry]));
  const mergedTickers = new Set([...snapshotByTicker.keys(), ...localByTicker.keys()]);

  return [...mergedTickers]
    .map((ticker) => {
      const snapshotEntry = snapshotByTicker.get(ticker);
      const localEntry = localByTicker.get(ticker);

      if (!snapshotEntry) {
        return localEntry ?? null;
      }

      if (!localEntry) {
        return snapshotEntry;
      }

      return {
        ...snapshotEntry,
        beta: localEntry.beta ?? snapshotEntry.beta,
        shares: localEntry.shares ?? snapshotEntry.shares,
        average_cost_basis: localEntry.average_cost_basis ?? snapshotEntry.average_cost_basis,
        downside_tolerance_pct: localEntry.downside_tolerance_pct ?? snapshotEntry.downside_tolerance_pct,
        current_price: snapshotEntry.current_price ?? localEntry.current_price,
        last_updated: snapshotEntry.last_updated ?? localEntry.last_updated,
        next_earnings_date: snapshotEntry.next_earnings_date ?? localEntry.next_earnings_date,
        current_iv: snapshotEntry.current_iv ?? localEntry.current_iv,
        current_iv_updated: snapshotEntry.current_iv_updated ?? localEntry.current_iv_updated,
        historical_iv: snapshotEntry.historical_iv ?? localEntry.historical_iv,
        iv_rank: snapshotEntry.iv_rank ?? localEntry.iv_rank,
        iv_percentile: snapshotEntry.iv_percentile ?? localEntry.iv_percentile,
        put_call_ratio: snapshotEntry.put_call_ratio ?? localEntry.put_call_ratio,
        put_call_ratio_updated: snapshotEntry.put_call_ratio_updated ?? localEntry.put_call_ratio_updated,
        provider_exchange: snapshotEntry.provider_exchange ?? localEntry.provider_exchange,
        provider_mic_code: snapshotEntry.provider_mic_code ?? localEntry.provider_mic_code,
        rsi_14: snapshotEntry.rsi_14 ?? localEntry.rsi_14,
        rsi_14_1h: snapshotEntry.rsi_14_1h ?? localEntry.rsi_14_1h,
        rsi_updated: snapshotEntry.rsi_updated ?? localEntry.rsi_updated,
        ma_21: snapshotEntry.ma_21 ?? localEntry.ma_21,
        ma_200: snapshotEntry.ma_200 ?? localEntry.ma_200
      };
    })
    .filter((entry): entry is TickerEntry => entry !== null)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function loadScenario(): StressScenario | null {
  return loadJson<StressScenario | null>(STORAGE_KEYS.scenario, null);
}

export function saveScenario(scenario: StressScenario): void {
  saveJson(STORAGE_KEYS.scenario, scenario);
}

export function loadStressMode(): StressMode {
  const mode = loadJson<StressMode | null>(STORAGE_KEYS.stressMode, null);
  return mode === 'auto' ? 'auto' : 'manual';
}

export function saveStressMode(mode: StressMode): void {
  saveJson(STORAGE_KEYS.stressMode, mode);
}

export function loadScoreHistory(): RiskScorePoint[] {
  return loadJson<RiskScorePoint[]>(STORAGE_KEYS.scoreHistory, []);
}

export function saveScoreHistory(history: RiskScorePoint[]): void {
  saveJson(STORAGE_KEYS.scoreHistory, history);
}

export function loadVixHistory(): VixHistoryPoint[] {
  const rawHistory = loadJson<Array<Record<string, unknown>>>(STORAGE_KEYS.vixHistory, []);
  return rawHistory
    .map((item) => ({
      timestamp: typeof item.timestamp === 'string' ? item.timestamp : '',
      value: typeof item.value === 'number' ? item.value : NaN,
      stress: typeof item.stress === 'number' ? item.stress : NaN
    }))
    .filter((item) => item.timestamp !== '' && Number.isFinite(item.value) && Number.isFinite(item.stress));
}

export function saveVixHistory(history: VixHistoryPoint[]): void {
  saveJson(STORAGE_KEYS.vixHistory, history);
}

export function loadAccountValueHistory(): AccountValueSnapshot[] {
  const rawHistory = loadJson<Array<Record<string, unknown>>>(STORAGE_KEYS.accountValueHistory, []);
  return rawHistory
    .map((item) => ({
      date: typeof item.date === 'string' ? item.date : '',
      total_capital: typeof item.total_capital === 'number' ? item.total_capital : NaN,
      as_of: typeof item.as_of === 'string' ? item.as_of : ''
    }))
    .filter((item) => item.date !== '' && Number.isFinite(item.total_capital) && item.as_of !== '')
    .sort((a, b) => a.date.localeCompare(b.date) || a.as_of.localeCompare(b.as_of));
}

export function saveAccountValueHistory(history: AccountValueSnapshot[]): void {
  const normalized = history
    .filter(
      (item) =>
        item.date.trim() !== '' &&
        Number.isFinite(item.total_capital) &&
        item.as_of.trim() !== ''
    )
    .sort((a, b) => a.date.localeCompare(b.date) || a.as_of.localeCompare(b.as_of));
  saveJson(STORAGE_KEYS.accountValueHistory, normalized);
}

export function buildPutPositionsExportPayload(): PutPositionsExportPayload {
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    data: {
      puts: loadPuts()
    }
  };
}

export function buildAppStateSnapshot(input: {
  config: Config | null;
  puts: PutPosition[];
  closedTrades: ClosedPutTrade[];
  stockTrades: StockTradeHistory[];
  tickerList: TickerEntry[];
  scenario: StressScenario | null;
  vixHistory: VixHistoryPoint[];
  accountValueHistory: AccountValueSnapshot[];
}): AppStateSnapshot {
  return {
    version: 1,
    exported_at: new Date().toISOString(),
    data: {
      config: input.config,
      puts: input.puts,
      closedTrades: input.closedTrades,
      stockTrades: input.stockTrades,
      tickerList: input.tickerList,
      scenario: input.scenario,
      vixHistory: input.vixHistory,
      accountValueHistory: input.accountValueHistory
    }
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parsePutPositionsImportPayload(raw: string): PutPositionsExportPayload {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.data)) {
    throw new Error('导入文件格式不正确');
  }

  const data = parsed.data;
  const puts = Array.isArray(data.puts) ? data.puts : [];

  return {
    version: 1,
    exported_at: typeof parsed.exported_at === 'string' ? parsed.exported_at : new Date().toISOString(),
    data: {
      puts: puts as PutPosition[]
    }
  };
}

export function parseAppStateSnapshot(raw: string): AppStateSnapshot {
  const parsed = JSON.parse(raw) as unknown;

  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.data)) {
    throw new Error('应用快照格式不正确');
  }

  const data = parsed.data;

  return {
    version: 1,
    exported_at: typeof parsed.exported_at === 'string' ? parsed.exported_at : new Date().toISOString(),
    data: {
      config: isRecord(data.config) ? loadConfigFromRecord(data.config) : null,
      puts: normalizeImportedPuts(Array.isArray(data.puts) ? data.puts : []),
      closedTrades: normalizeImportedClosedTrades(Array.isArray(data.closedTrades) ? data.closedTrades : []),
      stockTrades: normalizeImportedStockTrades(Array.isArray(data.stockTrades) ? data.stockTrades : []),
      tickerList: normalizeImportedTickerList(Array.isArray(data.tickerList) ? data.tickerList : []),
      scenario: typeof data.scenario === 'number' ? data.scenario : null,
      vixHistory: normalizeImportedVixHistory(Array.isArray(data.vixHistory) ? data.vixHistory : []),
      accountValueHistory: normalizeImportedAccountValueHistory(
        Array.isArray(data.accountValueHistory) ? data.accountValueHistory : []
      )
    }
  };
}

function loadConfigFromRecord(rawConfig: Record<string, unknown>): Config {
  return {
    cash: typeof rawConfig.cash === 'number'
      ? rawConfig.cash
      : typeof rawConfig.total_cash === 'number'
        ? rawConfig.total_cash
        : 0,
    risk_limit_pct: typeof rawConfig.risk_limit_pct === 'number' ? rawConfig.risk_limit_pct : 0.2,
    warning_threshold_pct:
      typeof rawConfig.warning_threshold_pct === 'number' ? rawConfig.warning_threshold_pct : 0.8
  };
}

function normalizeImportedPuts(rawPuts: unknown[]): PutPosition[] {
  return rawPuts.map((put) => {
    const record = (typeof put === 'object' && put !== null ? put : {}) as Record<string, unknown>;
    return {
      id: typeof record.id === 'string' && record.id !== '' ? record.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      ticker: typeof record.ticker === 'string' ? record.ticker.trim().toUpperCase() : '',
      option_side: normalizeOptionSide(record.option_side),
      put_strike: typeof record.put_strike === 'number' ? record.put_strike : 0,
      premium_per_share: typeof record.premium_per_share === 'number' ? record.premium_per_share : 0,
      contracts: typeof record.contracts === 'number' ? record.contracts : 1,
      iv_rank: typeof record.iv_rank === 'number' ? record.iv_rank : 0,
      date_sold: typeof record.date_sold === 'string' ? record.date_sold : '',
      expiration_date: typeof record.expiration_date === 'string' ? record.expiration_date : '',
      option_market_price_per_share:
        typeof record.option_market_price_per_share === 'number' ? record.option_market_price_per_share : null,
      option_market_price_updated:
        typeof record.option_market_price_updated === 'string' ? record.option_market_price_updated : null,
      option_theta_per_share:
        typeof record.option_theta_per_share === 'number' ? record.option_theta_per_share : null
    };
  });
}

function normalizeImportedTickerList(rawTickers: unknown[]): TickerEntry[] {
  return rawTickers
    .map((item): TickerEntry | null => {
      if (typeof item !== 'object' || item === null) {
        return null;
      }

      const record = item as Record<string, unknown>;
      const ticker = typeof record.ticker === 'string' ? record.ticker.trim().toUpperCase() : '';
      if (ticker === '') {
        return null;
      }

      return {
        ticker,
        beta: typeof record.beta === 'number' ? record.beta : DEFAULT_BETA_BY_TICKER[ticker] ?? null,
        shares: typeof record.shares === 'number' ? record.shares : null,
        average_cost_basis: typeof record.average_cost_basis === 'number' ? record.average_cost_basis : null,
        downside_tolerance_pct:
          typeof record.downside_tolerance_pct === 'number' ? record.downside_tolerance_pct : null,
        current_price: typeof record.current_price === 'number' ? record.current_price : null,
        last_updated: typeof record.last_updated === 'string' ? record.last_updated : null,
        next_earnings_date: typeof record.next_earnings_date === 'string' ? record.next_earnings_date : null,
        current_iv: typeof record.current_iv === 'number' ? record.current_iv : null,
        current_iv_updated: typeof record.current_iv_updated === 'string' ? record.current_iv_updated : null,
        historical_iv: typeof record.historical_iv === 'number' ? record.historical_iv : null,
        iv_rank: typeof record.iv_rank === 'number' ? record.iv_rank : null,
        iv_percentile: typeof record.iv_percentile === 'number' ? record.iv_percentile : null,
        put_call_ratio: typeof record.put_call_ratio === 'number' ? record.put_call_ratio : null,
        put_call_ratio_updated: typeof record.put_call_ratio_updated === 'string' ? record.put_call_ratio_updated : null,
        provider_exchange:
          typeof record.provider_exchange === 'string'
            ? record.provider_exchange.trim().toUpperCase()
            : DEFAULT_PROVIDER_BY_TICKER[ticker]?.exchange ?? null,
        provider_mic_code:
          typeof record.provider_mic_code === 'string'
            ? record.provider_mic_code.trim().toUpperCase()
            : DEFAULT_PROVIDER_BY_TICKER[ticker]?.mic_code ?? null,
        rsi_14: typeof record.rsi_14 === 'number' ? record.rsi_14 : null,
        rsi_14_1h: typeof record.rsi_14_1h === 'number' ? record.rsi_14_1h : null,
        rsi_updated: typeof record.rsi_updated === 'string' ? record.rsi_updated : null,
        ma_21: typeof record.ma_21 === 'number' ? record.ma_21 : null,
        ma_200: typeof record.ma_200 === 'number' ? record.ma_200 : null
      };
    })
    .filter((entry): entry is TickerEntry => entry !== null)
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

function normalizeImportedClosedTrades(rawTrades: unknown[]): ClosedPutTrade[] {
  return rawTrades
    .map((item) => {
      const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      const closeReason: ClosedPutTrade['close_reason'] = record.close_reason === 'expired' ? 'expired' : 'manual';

      return {
        id: typeof record.id === 'string' && record.id !== '' ? record.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        position_id: typeof record.position_id === 'string' ? record.position_id : '',
        ticker: typeof record.ticker === 'string' ? record.ticker.trim().toUpperCase() : '',
        option_side: normalizeOptionSide(record.option_side),
        put_strike: typeof record.put_strike === 'number' ? record.put_strike : 0,
        premium_sold_per_share: typeof record.premium_sold_per_share === 'number' ? record.premium_sold_per_share : 0,
        premium_bought_back_per_share:
          typeof record.premium_bought_back_per_share === 'number' ? record.premium_bought_back_per_share : 0,
        contracts: typeof record.contracts === 'number' ? record.contracts : 1,
        date_sold: typeof record.date_sold === 'string' ? record.date_sold : '',
        expiration_date: typeof record.expiration_date === 'string' ? record.expiration_date : '',
        closed_at: typeof record.closed_at === 'string' ? record.closed_at : '',
        close_reason: closeReason,
        realized_pnl: typeof record.realized_pnl === 'number' ? record.realized_pnl : 0,
        reflection_notes: typeof record.reflection_notes === 'string' ? record.reflection_notes : ''
      };
    })
    .filter((trade) => trade.ticker !== '' && trade.id !== '')
    .sort((a, b) => b.closed_at.localeCompare(a.closed_at));
}

function normalizeImportedStockTrades(rawTrades: unknown[]): StockTradeHistory[] {
  return rawTrades
    .map((trade) => {
      const record = (typeof trade === 'object' && trade !== null ? trade : {}) as Record<string, unknown>;
      return {
        id: typeof record.id === 'string' ? record.id : '',
        ticker: typeof record.ticker === 'string' ? record.ticker.trim().toUpperCase() : '',
        action: record.action === 'buy' ? 'buy' : 'sell',
        shares: typeof record.shares === 'number' ? record.shares : 0,
        price_per_share: typeof record.price_per_share === 'number' ? record.price_per_share : 0,
        traded_at: typeof record.traded_at === 'string' ? record.traded_at : '',
        cash_change: typeof record.cash_change === 'number' ? record.cash_change : 0,
        realized_pnl: typeof record.realized_pnl === 'number' ? record.realized_pnl : 0
      } satisfies StockTradeHistory;
    })
    .filter((trade) => trade.id !== '' && trade.ticker !== '' && trade.traded_at !== '');
}

function normalizeImportedVixHistory(rawHistory: unknown[]): VixHistoryPoint[] {
  return rawHistory
    .map((item) => {
      const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      return {
        timestamp: typeof record.timestamp === 'string' ? record.timestamp : '',
        value: typeof record.value === 'number' ? record.value : NaN,
        stress: typeof record.stress === 'number' ? record.stress : NaN
      };
    })
    .filter((item) => item.timestamp !== '' && Number.isFinite(item.value) && Number.isFinite(item.stress));
}

function normalizeImportedAccountValueHistory(rawHistory: unknown[]): AccountValueSnapshot[] {
  return rawHistory
    .map((item) => {
      const record = (typeof item === 'object' && item !== null ? item : {}) as Record<string, unknown>;
      return {
        date: typeof record.date === 'string' ? record.date : '',
        total_capital: typeof record.total_capital === 'number' ? record.total_capital : NaN,
        as_of: typeof record.as_of === 'string' ? record.as_of : ''
      };
    })
    .filter((item) => item.date !== '' && Number.isFinite(item.total_capital) && item.as_of !== '')
    .sort((a, b) => a.date.localeCompare(b.date) || a.as_of.localeCompare(b.as_of));
}

export function applyPutPositionsImportPayload(payload: PutPositionsExportPayload): {
  puts: PutPosition[];
  tickerList: TickerEntry[];
} {
  const puts = (payload.data.puts ?? []).map((put) => ({
    id: typeof put.id === 'string' && put.id !== '' ? put.id : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ticker: typeof put.ticker === 'string' ? put.ticker.trim().toUpperCase() : '',
    option_side: normalizeOptionSide(put.option_side),
    put_strike: typeof put.put_strike === 'number' ? put.put_strike : 0,
    premium_per_share: typeof put.premium_per_share === 'number' ? put.premium_per_share : 0,
    contracts: typeof put.contracts === 'number' ? put.contracts : 1,
    iv_rank: typeof put.iv_rank === 'number' ? put.iv_rank : 0,
    date_sold: typeof put.date_sold === 'string' ? put.date_sold : '',
    expiration_date: typeof put.expiration_date === 'string' ? put.expiration_date : ''
  }));
  const tickerList = [...new Set(puts.map((put) => put.ticker).filter(Boolean))]
    .sort()
    .map((ticker) => ({
      ticker,
      beta: DEFAULT_BETA_BY_TICKER[ticker] ?? null,
      shares: null,
      average_cost_basis: null,
      downside_tolerance_pct: null,
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
      provider_exchange: DEFAULT_PROVIDER_BY_TICKER[ticker]?.exchange ?? null,
      provider_mic_code: DEFAULT_PROVIDER_BY_TICKER[ticker]?.mic_code ?? null,
      rsi_14: null,
      rsi_14_1h: null,
      rsi_updated: null,
      ma_21: null,
      ma_200: null
    }));
  savePuts(puts);
  saveTickerList(tickerList);

  return {
    puts,
    tickerList
  };
}
