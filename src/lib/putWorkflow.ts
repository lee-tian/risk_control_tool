import type { ClosedPutTrade, PutPosition, TickerEntry } from '../types';

export type PreTradeAnalysisSnapshotInput = {
  analysis: {
    verdict: string;
    summary: string;
    rationale_check: string;
    worst_case: string;
    fundamental_note: string;
    fundamental_events: string[];
    current_iv_rank: string;
    iv_rank_note: string;
    iv_rank_source: string;
    iv_rank_time: string;
    iv_rank_link: string;
    action: string;
    key_risks: string[];
    calc: {
      max_profit: string;
      risk_at_10pct_drop: string;
    };
  };
  asOf: string;
};

export function buildPutCandidateFromPreTrade(
  preTradeCandidate: PutPosition,
  rationale: string,
  preTradeAnalysis: PreTradeAnalysisSnapshotInput
): PutPosition {
  return {
    ...preTradeCandidate,
    decision_rationale: rationale.trim(),
    decision_snapshot: {
      verdict: preTradeAnalysis.analysis.verdict,
      summary: preTradeAnalysis.analysis.summary,
      rationale_check: preTradeAnalysis.analysis.rationale_check,
      worst_case: preTradeAnalysis.analysis.worst_case,
      fundamental_note: preTradeAnalysis.analysis.fundamental_note,
      fundamental_events: preTradeAnalysis.analysis.fundamental_events,
      current_iv_rank: preTradeAnalysis.analysis.current_iv_rank,
      iv_rank_note: preTradeAnalysis.analysis.iv_rank_note,
      iv_rank_source: preTradeAnalysis.analysis.iv_rank_source,
      iv_rank_time: preTradeAnalysis.analysis.iv_rank_time,
      iv_rank_link: preTradeAnalysis.analysis.iv_rank_link,
      action: preTradeAnalysis.analysis.action,
      key_risks: preTradeAnalysis.analysis.key_risks,
      max_profit: preTradeAnalysis.analysis.calc.max_profit,
      risk_at_10pct_drop: preTradeAnalysis.analysis.calc.risk_at_10pct_drop,
      analyzed_at: preTradeAnalysis.asOf
    },
    iv_rank: Number.parseFloat(preTradeAnalysis.analysis.current_iv_rank) || 0
  };
}

export function ensureTickerExists(tickerList: TickerEntry[], ticker: string): TickerEntry[] {
  if (tickerList.some((entry) => entry.ticker === ticker)) {
    return tickerList;
  }

  return [
    ...tickerList,
    {
      ticker,
      beta: null,
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
      provider_exchange: null,
      provider_mic_code: null,
      rsi_14: null,
      rsi_14_1h: null,
      rsi_updated: null,
      ma_21: null,
      ma_200: null
    }
  ].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export function upsertPutPosition(
  puts: PutPosition[],
  normalized: PutPosition,
  editingPutId: string | null,
  generateIdFn: () => string
): PutPosition[] {
  if (editingPutId) {
    return puts.map((item) => (item.id === editingPutId ? normalized : item));
  }

  return [...puts, { ...normalized, id: generateIdFn() }];
}

export function removePutPosition(puts: PutPosition[], id: string): PutPosition[] {
  return puts.filter((item) => item.id !== id);
}

function shouldRemoveTickerAfterLastPosition(entry: TickerEntry | undefined): boolean {
  if (!entry) {
    return false;
  }

  return (
    entry.shares === null &&
    entry.average_cost_basis === null &&
    entry.downside_tolerance_pct === null
  );
}

export function deleteOpenPositionAndPruneTicker(
  puts: PutPosition[],
  tickerList: TickerEntry[],
  id: string
): {
  nextPuts: PutPosition[];
  nextTickerList: TickerEntry[];
  removedTicker: string | null;
} {
  const target = puts.find((item) => item.id === id);
  if (!target) {
    return {
      nextPuts: puts,
      nextTickerList: tickerList,
      removedTicker: null
    };
  }

  const nextPuts = removePutPosition(puts, id);
  const hasRemainingPositionsForTicker = nextPuts.some((item) => item.ticker === target.ticker);

  if (hasRemainingPositionsForTicker) {
    return {
      nextPuts,
      nextTickerList: tickerList,
      removedTicker: null
    };
  }

  const tickerEntry = tickerList.find((entry) => entry.ticker === target.ticker);
  if (!shouldRemoveTickerAfterLastPosition(tickerEntry)) {
    return {
      nextPuts,
      nextTickerList: tickerList,
      removedTicker: null
    };
  }

  return {
    nextPuts,
    nextTickerList: tickerList.filter((entry) => entry.ticker !== target.ticker),
    removedTicker: target.ticker
  };
}

export function createClosedTradeFromPosition(
  position: PutPosition,
  buybackPremiumPerShare: number,
  closedAt: string,
  reflectionNotes: string,
  closeReason: ClosedPutTrade['close_reason'],
  generateIdFn: () => string
): ClosedPutTrade {
  return {
    id: generateIdFn(),
    position_id: position.id,
    ticker: position.ticker,
    option_side: position.option_side === 'call' ? 'call' : 'put',
    put_strike: position.put_strike,
    premium_sold_per_share: position.premium_per_share,
    premium_bought_back_per_share: buybackPremiumPerShare,
    contracts: position.contracts,
    date_sold: position.date_sold,
    expiration_date: position.expiration_date,
    closed_at: closedAt,
    close_reason: closeReason,
    realized_pnl: (position.premium_per_share - buybackPremiumPerShare) * position.contracts * 100,
    reflection_notes: reflectionNotes.trim()
  };
}

export function closeOpenPosition(
  puts: PutPosition[],
  closedTrades: ClosedPutTrade[],
  position: PutPosition,
  buybackPremiumPerShare: number,
  closedAt: string,
  reflectionNotes: string,
  generateIdFn: () => string
): { nextPuts: PutPosition[]; nextClosedTrades: ClosedPutTrade[] } {
  return {
    nextPuts: puts.filter((item) => item.id !== position.id),
    nextClosedTrades: [
      createClosedTradeFromPosition(
        position,
        buybackPremiumPerShare,
        closedAt,
        reflectionNotes,
        'manual',
        generateIdFn
      ),
      ...closedTrades
    ]
  };
}

export function expireOpenPositions(
  puts: PutPosition[],
  closedTrades: ClosedPutTrade[],
  today: string,
  generateIdFn: () => string
): { expiredRows: PutPosition[]; nextPuts: PutPosition[]; nextClosedTrades: ClosedPutTrade[] } {
  const existingClosedIds = new Set(closedTrades.map((trade) => trade.position_id));
  const expiredRows = puts.filter(
    (put) => put.expiration_date !== '' && put.expiration_date < today && !existingClosedIds.has(put.id)
  );

  if (expiredRows.length === 0) {
    return {
      expiredRows: [],
      nextPuts: puts,
      nextClosedTrades: closedTrades
    };
  }

  return {
    expiredRows,
    nextPuts: puts.filter((put) => !expiredRows.some((expired) => expired.id === put.id)),
    nextClosedTrades: [
      ...expiredRows.map((put) =>
        createClosedTradeFromPosition(put, 0, put.expiration_date, '', 'expired', generateIdFn)
      ),
      ...closedTrades
    ]
  };
}

export type ClosedTradeEditInput = {
  tradeId: string;
  ticker: string;
  option_side?: 'put' | 'call';
  putStrike: number;
  premiumSoldPerShare: number;
  premiumBoughtBackPerShare: number;
  contracts: number;
  dateSold: string;
  expirationDate: string;
  closedAt: string;
  closeReason: ClosedPutTrade['close_reason'];
  reflectionNotes: string;
};

export type ClosedTradeEditPreview = {
  tradeId: string;
  ticker: string;
  optionSide: 'put' | 'call';
  putStrike: string;
  premiumSoldPerShare: string;
  premiumBoughtBackPerShare: string;
  contracts: string;
  dateSold: string;
  expirationDate: string;
  closedAt: string;
  closeReason: ClosedPutTrade['close_reason'];
  reflectionNotes: string;
};

export function buildClosedTradeEditPreview(trade: ClosedPutTrade): ClosedTradeEditPreview {
  return {
    tradeId: trade.id,
    ticker: trade.ticker,
    optionSide: trade.option_side === 'call' ? 'call' : 'put',
    putStrike: trade.put_strike.toString(),
    premiumSoldPerShare: trade.premium_sold_per_share.toString(),
    premiumBoughtBackPerShare: trade.premium_bought_back_per_share.toString(),
    contracts: trade.contracts.toString(),
    dateSold: trade.date_sold,
    expirationDate: trade.expiration_date,
    closedAt: trade.closed_at,
    closeReason: trade.close_reason,
    reflectionNotes: trade.reflection_notes ?? ''
  };
}

export function parseClosedTradeEditPreview(preview: ClosedTradeEditPreview): {
  ok: true;
  values: Pick<ClosedTradeEditInput, 'putStrike' | 'premiumSoldPerShare' | 'premiumBoughtBackPerShare' | 'contracts'>;
} | {
  ok: false;
} {
  const putStrike = Number(preview.putStrike);
  const premiumSoldPerShare = Number(preview.premiumSoldPerShare);
  const premiumBoughtBackPerShare = Number(preview.premiumBoughtBackPerShare);
  const contracts = Number(preview.contracts);

  if (
    !Number.isFinite(putStrike) ||
    putStrike < 0 ||
    !Number.isFinite(premiumSoldPerShare) ||
    premiumSoldPerShare < 0 ||
    !Number.isFinite(premiumBoughtBackPerShare) ||
    premiumBoughtBackPerShare < 0 ||
    !Number.isFinite(contracts) ||
    contracts <= 0
  ) {
    return { ok: false };
  }

  return {
    ok: true,
    values: {
      putStrike,
      premiumSoldPerShare,
      premiumBoughtBackPerShare,
      contracts
    }
  };
}

export function updateClosedTrade(
  trades: ClosedPutTrade[],
  input: ClosedTradeEditInput
): ClosedPutTrade[] {
  return trades.map((trade) =>
    trade.id === input.tradeId
      ? {
          ...trade,
          ticker: input.ticker,
          option_side: input.option_side === 'call' ? 'call' : 'put',
          put_strike: input.putStrike,
          premium_sold_per_share: input.premiumSoldPerShare,
          premium_bought_back_per_share: input.premiumBoughtBackPerShare,
          contracts: input.contracts,
          date_sold: input.dateSold,
          expiration_date: input.expirationDate,
          closed_at: input.closedAt,
          close_reason: input.closeReason,
          realized_pnl: (input.premiumSoldPerShare - input.premiumBoughtBackPerShare) * input.contracts * 100,
          reflection_notes: input.reflectionNotes.trim()
        }
      : trade
  );
}

export function shouldClearPreTradeState(result: 'saved' | 'blocked' | 'error'): boolean {
  return result === 'saved';
}

export function shouldAllowForceSellOnCheckError(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return normalized.includes('ivrank is not defined') || normalized.includes('ivrunk is not defined');
}

export function shouldApplySellPutRiskGate(optionSide?: 'put' | 'call'): boolean {
  return optionSide !== 'call';
}
