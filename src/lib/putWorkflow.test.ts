import { describe, expect, it } from 'vitest';

import type { PutPosition, TickerEntry } from '../types';
import {
  buildClosedTradeEditPreview,
  buildPutCandidateFromPreTrade,
  closeOpenPosition,
  createClosedTradeFromPosition,
  deleteOpenPositionAndPruneTicker,
  ensureTickerExists,
  expireOpenPositions,
  parseClosedTradeEditPreview,
  removePutPosition,
  shouldApplySellPutRiskGate,
  shouldAllowForceSellOnCheckError,
  shouldClearPreTradeState,
  updateClosedTrade,
  upsertPutPosition
} from './putWorkflow';

const basePut: PutPosition = {
  id: 'put-1',
  ticker: 'NVDA',
  put_strike: 160,
  premium_per_share: 4.3,
  contracts: 1,
  iv_rank: 0,
  date_sold: '2026-03-26',
  expiration_date: '2026-05-08'
};

const baseCall: PutPosition = {
  ...basePut,
  id: 'call-1',
  ticker: 'AAPL',
  option_side: 'call',
  put_strike: 220
};

describe('buildPutCandidateFromPreTrade', () => {
  it('parses IV rank from analysis payload', () => {
    const candidate = buildPutCandidateFromPreTrade(basePut, '愿意接股', {
      analysis: {
        verdict: '需要谨慎',
        summary: '测试摘要',
        rationale_check: '测试理由检查',
        worst_case: '测试最坏情况',
        fundamental_note: '测试基本面',
        fundamental_events: ['事件A'],
        current_iv_rank: '58.4',
        iv_rank_note: 'IV Rank 偏高',
        iv_rank_source: 'Example',
        iv_rank_time: '2026-03-26',
        iv_rank_link: 'https://example.com',
        action: '继续观察',
        key_risks: ['风险A'],
        calc: {
          max_profit: '$430',
          risk_at_10pct_drop: '$1200'
        }
      },
      asOf: '2026-03-26T12:00:00Z'
    });

    expect(candidate.iv_rank).toBe(58.4);
    expect(candidate.decision_snapshot?.current_iv_rank).toBe('58.4');
    expect(candidate.decision_rationale).toBe('愿意接股');
  });

  it('trims rationale text and preserves call-specific pre-trade snapshots', () => {
    const candidate = buildPutCandidateFromPreTrade(baseCall, '  收租并接近行权价时滚仓  ', {
      analysis: {
        verdict: '可以考虑',
        summary: 'call 分析摘要',
        rationale_check: '计划清晰',
        worst_case: '上涨收益被封顶',
        fundamental_note: '关注竞争压力',
        fundamental_events: ['2026-Q1 指引偏弱'],
        current_iv_rank: '41.2',
        iv_rank_note: 'IV 中性偏高',
        iv_rank_source: 'Barchart',
        iv_rank_time: '2026-04-01T10:00:00Z',
        iv_rank_link: 'https://example.com/ivr',
        action: '等待检查',
        key_risks: ['被提前行权'],
        calc: {
          max_profit: '$240',
          risk_at_10pct_drop: '$950'
        }
      },
      asOf: '2026-04-01T12:00:00Z'
    });

    expect(candidate.option_side).toBe('call');
    expect(candidate.decision_rationale).toBe('收租并接近行权价时滚仓');
    expect(candidate.decision_snapshot).toMatchObject({
      summary: 'call 分析摘要',
      action: '等待检查',
      analyzed_at: '2026-04-01T12:00:00Z'
    });
  });

  it('falls back to 0 when IV rank is unavailable', () => {
    const candidate = buildPutCandidateFromPreTrade(basePut, '愿意接股', {
      analysis: {
        verdict: '',
        summary: '',
        rationale_check: '',
        worst_case: '',
        fundamental_note: '',
        fundamental_events: [],
        current_iv_rank: '未确认',
        iv_rank_note: '',
        iv_rank_source: '',
        iv_rank_time: '',
        iv_rank_link: '',
        action: '',
        key_risks: [],
        calc: {
          max_profit: '',
          risk_at_10pct_drop: ''
        }
      },
      asOf: '2026-03-26T12:00:00Z'
    });

    expect(candidate.iv_rank).toBe(0);
  });
});

describe('ensureTickerExists', () => {
  it('adds a missing ticker', () => {
    const next = ensureTickerExists([], 'NVDA');
    expect(next).toHaveLength(1);
    expect(next[0].ticker).toBe('NVDA');
    expect(next[0].current_price).toBeNull();
  });

  it('does not duplicate an existing ticker', () => {
    const list: TickerEntry[] = [
      {
        ticker: 'NVDA',
        beta: 2.17,
        shares: null,
        average_cost_basis: null,
        downside_tolerance_pct: null,
        current_price: 100,
        last_updated: null,
        current_iv: null,
        current_iv_updated: null,
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
    ];

    const next = ensureTickerExists(list, 'NVDA');
    expect(next).toHaveLength(1);
  });

  it('keeps the ticker list alphabetically sorted when adding a new symbol', () => {
    const next = ensureTickerExists(
      [
        { ticker: 'NVDA', beta: null, shares: null, average_cost_basis: null, downside_tolerance_pct: null, current_price: null, last_updated: null, current_iv: null, current_iv_updated: null, put_call_ratio: null, put_call_ratio_updated: null, provider_exchange: null, provider_mic_code: null, rsi_14: null, rsi_14_1h: null, rsi_updated: null, ma_21: null, ma_200: null },
        { ticker: 'TSLA', beta: null, shares: null, average_cost_basis: null, downside_tolerance_pct: null, current_price: null, last_updated: null, current_iv: null, current_iv_updated: null, put_call_ratio: null, put_call_ratio_updated: null, provider_exchange: null, provider_mic_code: null, rsi_14: null, rsi_14_1h: null, rsi_updated: null, ma_21: null, ma_200: null }
      ],
      'AAPL'
    );

    expect(next.map((entry) => entry.ticker)).toEqual(['AAPL', 'NVDA', 'TSLA']);
  });
});

describe('upsertPutPosition', () => {
  it('appends a new position when not editing', () => {
    const next = upsertPutPosition([], basePut, null, () => 'generated-id');
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe('generated-id');
  });

  it('replaces an existing position when editing', () => {
    const current = [{ ...basePut, id: 'existing' }];
    const next = upsertPutPosition(current, { ...basePut, id: 'existing', premium_per_share: 5.2 }, 'existing', () => 'ignored');
    expect(next).toHaveLength(1);
    expect(next[0].premium_per_share).toBe(5.2);
  });

  it('preserves call option side when adding a covered call', () => {
    const next = upsertPutPosition([], baseCall, null, () => 'generated-call');
    expect(next).toEqual([
      expect.objectContaining({
        id: 'generated-call',
        option_side: 'call',
        ticker: 'AAPL'
      })
    ]);
  });
});

describe('removePutPosition', () => {
  it('deletes the requested position id', () => {
    const next = removePutPosition([basePut, baseCall], 'call-1');
    expect(next).toEqual([basePut]);
  });

  it('creates a covered call and then deletes it cleanly', () => {
    const withCall = upsertPutPosition([], baseCall, null, () => 'generated-call');

    expect(withCall).toEqual([
      expect.objectContaining({
        id: 'generated-call',
        ticker: 'AAPL',
        option_side: 'call'
      })
    ]);

    const afterDelete = removePutPosition(withCall, 'generated-call');
    expect(afterDelete).toEqual([]);
  });
});

describe('deleteOpenPositionAndPruneTicker', () => {
  const emptyHoldingTicker: TickerEntry = {
    ticker: 'AAPL',
    beta: 0.87,
    shares: null,
    average_cost_basis: null,
    downside_tolerance_pct: null,
    current_price: 255.63,
    last_updated: '2026-04-01T18:15:59.000Z',
    next_earnings_date: '2026-05-07',
    current_iv: 0.209,
    current_iv_updated: '2026-04-01T18:15:59.000Z',
    historical_iv: 0.209,
    iv_rank: 23.4,
    iv_percentile: 69,
    put_call_ratio: 0.69,
    put_call_ratio_updated: '2026-04-01T18:15:59.000Z',
    provider_exchange: 'NASDAQ',
    provider_mic_code: 'XNAS',
    rsi_14: 49.1,
    rsi_14_1h: 62.8,
    rsi_updated: '2026-04-01T18:15:59.000Z',
    ma_21: 254.02,
    ma_200: 248.51
  };

  it('removes the last position and prunes an empty derived ticker row', () => {
    const result = deleteOpenPositionAndPruneTicker([baseCall], [emptyHoldingTicker], 'call-1');

    expect(result.nextPuts).toEqual([]);
    expect(result.nextTickerList).toEqual([]);
    expect(result.removedTicker).toBe('AAPL');
  });

  it('keeps the ticker row when there are remaining positions for the same ticker', () => {
    const result = deleteOpenPositionAndPruneTicker(
      [baseCall, { ...baseCall, id: 'call-2' }],
      [emptyHoldingTicker],
      'call-1'
    );

    expect(result.nextPuts).toEqual([{ ...baseCall, id: 'call-2' }]);
    expect(result.nextTickerList).toEqual([emptyHoldingTicker]);
    expect(result.removedTicker).toBeNull();
  });

  it('keeps the ticker row when the user has stock holding data on it', () => {
    const result = deleteOpenPositionAndPruneTicker(
      [baseCall],
      [{ ...emptyHoldingTicker, shares: 100, average_cost_basis: 210 }],
      'call-1'
    );

    expect(result.nextPuts).toEqual([]);
    expect(result.nextTickerList).toEqual([{ ...emptyHoldingTicker, shares: 100, average_cost_basis: 210 }]);
    expect(result.removedTicker).toBeNull();
  });
});

describe('createClosedTradeFromPosition', () => {
  it('creates a manual closed trade for a covered call', () => {
    const trade = createClosedTradeFromPosition(baseCall, 1.25, '2026-04-01', 'call close', 'manual', () => 'trade-1');

    expect(trade).toMatchObject({
      id: 'trade-1',
      position_id: 'call-1',
      option_side: 'call',
      ticker: 'AAPL',
      close_reason: 'manual',
      reflection_notes: 'call close'
    });
    expect(trade.realized_pnl).toBe((baseCall.premium_per_share - 1.25) * baseCall.contracts * 100);
  });
});

describe('closeOpenPosition', () => {
  it('removes the open position and prepends a matching history record', () => {
    const existingHistory = [
      createClosedTradeFromPosition(basePut, 0, '2026-03-01', '', 'expired', () => 'older-trade')
    ];

    const result = closeOpenPosition(
      [basePut, baseCall],
      existingHistory,
      basePut,
      1.1,
      '2026-04-01',
      'manual close',
      () => 'new-trade'
    );

    expect(result.nextPuts).toEqual([baseCall]);
    expect(result.nextClosedTrades).toEqual([
      expect.objectContaining({
        id: 'new-trade',
        position_id: 'put-1',
        ticker: 'NVDA',
        option_side: 'put',
        close_reason: 'manual',
        reflection_notes: 'manual close'
      }),
      existingHistory[0]
    ]);
  });

  it('supports partially closing a multi-contract position', () => {
    const multiContractPut: PutPosition = {
      ...basePut,
      contracts: 3
    };

    const result = closeOpenPosition(
      [multiContractPut],
      [],
      multiContractPut,
      1.1,
      '2026-04-01',
      'partial close',
      () => 'partial-trade',
      1
    );

    expect(result.nextPuts).toEqual([
      expect.objectContaining({
        id: 'put-1',
        contracts: 2
      })
    ]);
    expect(result.nextClosedTrades).toEqual([
      expect.objectContaining({
        id: 'partial-trade',
        position_id: 'put-1',
        contracts: 1,
        realized_pnl: (multiContractPut.premium_per_share - 1.1) * 100
      })
    ]);
  });
});

describe('expireOpenPositions', () => {
  it('moves expired put and call positions into history and keeps side', () => {
    const result = expireOpenPositions(
      [
        { ...basePut, expiration_date: '2026-03-01' },
        { ...baseCall, expiration_date: '2026-03-02' },
        { ...basePut, id: 'active-put', expiration_date: '2026-05-08' }
      ],
      [],
      '2026-04-01',
      () => 'expired-trade'
    );

    expect(result.expiredRows).toHaveLength(2);
    expect(result.nextPuts).toEqual([
      expect.objectContaining({
        id: 'active-put'
      })
    ]);
    expect(result.nextClosedTrades).toEqual([
      expect.objectContaining({ position_id: 'put-1', option_side: 'put', close_reason: 'expired' }),
      expect.objectContaining({ position_id: 'call-1', option_side: 'call', close_reason: 'expired' })
    ]);
  });

  it('does not duplicate history entries for positions that are already closed', () => {
    const alreadyClosed = createClosedTradeFromPosition(
      { ...basePut, expiration_date: '2026-03-01' },
      0,
      '2026-03-01',
      '',
      'expired',
      () => 'trade-existing'
    );

    const result = expireOpenPositions(
      [{ ...basePut, expiration_date: '2026-03-01' }],
      [alreadyClosed],
      '2026-04-01',
      () => 'trade-new'
    );

    expect(result.expiredRows).toEqual([]);
    expect(result.nextPuts).toHaveLength(1);
    expect(result.nextClosedTrades).toEqual([alreadyClosed]);
  });
});

describe('updateClosedTrade', () => {
  it('builds history edit previews with string values for the edit modal', () => {
    const trade = createClosedTradeFromPosition(baseCall, 1.25, '2026-04-01', ' call close ', 'manual', () => 'trade-1');

    expect(buildClosedTradeEditPreview(trade)).toEqual({
      tradeId: 'trade-1',
      ticker: 'AAPL',
      optionSide: 'call',
      putStrike: '220',
      premiumSoldPerShare: '4.3',
      premiumBoughtBackPerShare: '1.25',
      contracts: '1',
      dateSold: '2026-03-26',
      expirationDate: '2026-05-08',
      closedAt: '2026-04-01',
      closeReason: 'manual',
      reflectionNotes: 'call close'
    });
  });

  it('validates and parses history edit modal input before save', () => {
    const parsed = parseClosedTradeEditPreview({
      tradeId: 'trade-1',
      ticker: 'AAPL',
      optionSide: 'call',
      putStrike: '220',
      premiumSoldPerShare: '4.3',
      premiumBoughtBackPerShare: '1.25',
      contracts: '2',
      dateSold: '2026-03-26',
      expirationDate: '2026-05-08',
      closedAt: '2026-04-01',
      closeReason: 'manual',
      reflectionNotes: 'note'
    });

    expect(parsed).toEqual({
      ok: true,
      values: {
        putStrike: 220,
        premiumSoldPerShare: 4.3,
        premiumBoughtBackPerShare: 1.25,
        contracts: 2
      }
    });
  });

  it('rejects invalid history edit modal numbers', () => {
    expect(
      parseClosedTradeEditPreview({
        tradeId: 'trade-1',
        ticker: 'AAPL',
        optionSide: 'call',
        putStrike: '-1',
        premiumSoldPerShare: '4.3',
        premiumBoughtBackPerShare: '1.25',
        contracts: '0',
        dateSold: '2026-03-26',
        expirationDate: '2026-05-08',
        closedAt: '2026-04-01',
        closeReason: 'manual',
        reflectionNotes: 'note'
      })
    ).toEqual({ ok: false });
  });

  it('updates a closed trade and preserves edited option side', () => {
    const current = [
      createClosedTradeFromPosition(basePut, 0, '2026-05-08', '', 'expired', () => 'trade-1')
    ];

    const next = updateClosedTrade(current, {
      tradeId: 'trade-1',
      ticker: 'MSFT',
      option_side: 'call',
      putStrike: 390,
      premiumSoldPerShare: 2.5,
      premiumBoughtBackPerShare: 1.1,
      contracts: 2,
      dateSold: '2026-03-01',
      expirationDate: '2026-04-01',
      closedAt: '2026-03-20',
      closeReason: 'manual',
      reflectionNotes: ' updated '
    });

    expect(next).toEqual([
      expect.objectContaining({
        ticker: 'MSFT',
        option_side: 'call',
        close_reason: 'manual',
        reflection_notes: 'updated',
        realized_pnl: 280
      })
    ]);
  });

  it('leaves trades unchanged when the target id does not exist', () => {
    const current = [
      createClosedTradeFromPosition(baseCall, 1.5, '2026-04-01', '', 'manual', () => 'trade-1')
    ];

    const next = updateClosedTrade(current, {
      tradeId: 'missing-id',
      ticker: 'MSFT',
      option_side: 'put',
      putStrike: 390,
      premiumSoldPerShare: 2.5,
      premiumBoughtBackPerShare: 1.1,
      contracts: 2,
      dateSold: '2026-03-01',
      expirationDate: '2026-04-01',
      closedAt: '2026-03-20',
      closeReason: 'manual',
      reflectionNotes: ' updated '
    });

    expect(next).toEqual(current);
  });
});

describe('shouldClearPreTradeState', () => {
  it('clears pre-trade state only after a successful save', () => {
    expect(shouldClearPreTradeState('saved')).toBe(true);
    expect(shouldClearPreTradeState('blocked')).toBe(false);
    expect(shouldClearPreTradeState('error')).toBe(false);
  });
});

describe('shouldAllowForceSellOnCheckError', () => {
  it('keeps force-sell available for known ivRank script errors', () => {
    expect(shouldAllowForceSellOnCheckError('ivRank is not defined')).toBe(true);
    expect(shouldAllowForceSellOnCheckError('IVRunk is not defined')).toBe(true);
    expect(shouldAllowForceSellOnCheckError('卖 Put 检查失败')).toBe(false);
  });
});

describe('shouldApplySellPutRiskGate', () => {
  it('applies sell-score gates only to sell puts', () => {
    expect(shouldApplySellPutRiskGate('put')).toBe(true);
    expect(shouldApplySellPutRiskGate('call')).toBe(false);
    expect(shouldApplySellPutRiskGate(undefined)).toBe(true);
  });
});
