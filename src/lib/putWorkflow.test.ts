import { describe, expect, it } from 'vitest';

import type { PutPosition, TickerEntry } from '../types';
import {
  buildDirectOptionPosition,
  buildClosedTradeEditPreview,
  closeOpenPosition,
  createClosedTradeFromPosition,
  deleteOpenPositionAndPruneTicker,
  ensureTickerExists,
  expireOpenPositions,
  hasExpectedPersistedClosedTrade,
  hasExpectedPersistedPositionState,
  parseClosedTradeEditPreview,
  removeClosedTrade,
  removePutPosition,
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

describe('buildDirectOptionPosition', () => {
  it('drops recommendation metadata for direct sell flow', () => {
    const direct = buildDirectOptionPosition({
      ...basePut,
      decision_rationale: '旧建议',
      decision_snapshot: {
        verdict: '可以考虑',
        summary: '旧摘要',
        current_iv_rank: '58.4',
        premium_view: '旧 premium 判断',
        support_level: '150',
        resistance_level: '190',
        recommended_strike: '155',
        recommendation_reason: '旧建议原因',
        candidate_focus: 'US.NVDA260619P155000',
        trade_action: '等待检查',
        key_risks: ['风险A'],
        warnings: ['警告A'],
        analyzed_at: '2026-03-26T12:00:00Z'
      }
    });

    expect(direct).toMatchObject({
      ticker: 'NVDA',
      put_strike: 160,
      premium_per_share: 4.3,
      decision_rationale: '',
      decision_snapshot: null
    });
  });

  it('preserves covered call fields while clearing decision metadata', () => {
    const direct = buildDirectOptionPosition({
      ...baseCall,
      decision_rationale: '旧 call 建议',
      decision_snapshot: {
        verdict: '可以考虑',
        summary: 'call 摘要',
        current_iv_rank: '41.2',
        premium_view: 'IV 中性偏高',
        support_level: '205',
        resistance_level: '235',
        recommended_strike: '235',
        recommendation_reason: '高于压力位更安全',
        candidate_focus: 'US.AAPL260508C235000',
        trade_action: '等待检查',
        key_risks: ['被提前行权'],
        warnings: [],
        analyzed_at: '2026-04-01T12:00:00Z'
      }
    });

    expect(direct.option_side).toBe('call');
    expect(direct.decision_rationale).toBe('');
    expect(direct.decision_snapshot).toBeNull();
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

  it('creates a new put and then deletes it cleanly', () => {
    const created = upsertPutPosition([], basePut, null, () => 'generated-put');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      id: 'generated-put',
      ticker: 'NVDA'
    });

    const next = removePutPosition(created, 'generated-put');
    expect(next).toEqual([]);
  });

  it('replaces an existing position when editing', () => {
    const current = [{ ...basePut, id: 'existing' }];
    const next = upsertPutPosition(current, { ...basePut, id: 'existing', premium_per_share: 5.2 }, 'existing', () => 'ignored');
    expect(next).toHaveLength(1);
    expect(next[0].premium_per_share).toBe(5.2);
  });

  it('updates only the targeted put row during edit flow and does not append a duplicate', () => {
    const untouched = { ...basePut, id: 'other-put', ticker: 'MSFT', premium_per_share: 2.1 };
    const current = [{ ...basePut, id: 'existing' }, untouched];

    const next = upsertPutPosition(
      current,
      {
        ...basePut,
        id: 'existing',
        ticker: 'NVDA',
        premium_per_share: 5.2,
        contracts: 2
      },
      'existing',
      () => 'ignored'
    );

    expect(next).toHaveLength(2);
    expect(next[0]).toMatchObject({
      id: 'existing',
      ticker: 'NVDA',
      premium_per_share: 5.2,
      contracts: 2
    });
    expect(next[1]).toEqual(untouched);
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

  it('preserves call-specific fields when editing an existing covered call', () => {
    const current = [
      {
        ...baseCall,
        id: 'existing-call',
        premium_per_share: 6.95,
        date_sold: '2026-04-01',
        decision_snapshot: {
          verdict: '可以考虑',
          summary: '旧摘要',
          current_iv_rank: '41.2',
          premium_view: '旧 premium 判断',
          support_level: '205.00 (OI 8000)',
          resistance_level: '235.00 (OI 9100)',
          recommended_strike: '235',
          recommendation_reason: '旧原因',
          candidate_focus: 'US.AAPL260508C235000',
          trade_action: '继续观察',
          key_risks: ['被提前行权'],
          warnings: [],
          analyzed_at: '2026-04-01T12:00:00Z'
        }
      }
    ];

    const next = upsertPutPosition(
      current,
      {
        ...baseCall,
        id: 'existing-call',
        premium_per_share: 7.25,
        contracts: 2,
        date_sold: '2026-04-03',
        decision_snapshot: current[0].decision_snapshot
      },
      'existing-call',
      () => 'ignored'
    );

    expect(next).toEqual([
      expect.objectContaining({
        id: 'existing-call',
        option_side: 'call',
        premium_per_share: 7.25,
        contracts: 2,
        date_sold: '2026-04-03',
        decision_snapshot: current[0].decision_snapshot
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

describe('hasExpectedPersistedPositionState', () => {
  it('returns true when a fully closed position is absent from persisted puts', () => {
    expect(hasExpectedPersistedPositionState([], [], 'put-1')).toBe(true);
  });

  it('returns true when a partial close persists the updated contract count', () => {
    expect(
      hasExpectedPersistedPositionState(
        [{ ...basePut, contracts: 2 }],
        [{ ...basePut, contracts: 2 }],
        'put-1'
      )
    ).toBe(true);
  });

  it('returns false when the persisted snapshot still has the old open contracts', () => {
    expect(
      hasExpectedPersistedPositionState(
        [{ ...basePut, contracts: 3 }],
        [{ ...basePut, contracts: 2 }],
        'put-1'
      )
    ).toBe(false);
  });
});

describe('hasExpectedPersistedClosedTrade', () => {
  it('returns true when the expected closed trade exists in persisted history', () => {
    const trade = createClosedTradeFromPosition(baseCall, 0.48, '2026-04-06', 'take profit', 'manual', () => 'trade-1', 2);
    expect(hasExpectedPersistedClosedTrade([trade], [trade], 'trade-1')).toBe(true);
  });

  it('returns false when the new closed trade is missing from persisted history', () => {
    const trade = createClosedTradeFromPosition(baseCall, 0.48, '2026-04-06', 'take profit', 'manual', () => 'trade-1', 2);
    expect(hasExpectedPersistedClosedTrade([], [trade], 'trade-1')).toBe(false);
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

  it('removes a closed trade by id', () => {
    const current = [
      createClosedTradeFromPosition(baseCall, 1.5, '2026-04-01', '', 'manual', () => 'trade-1'),
      createClosedTradeFromPosition(basePut, 0, '2026-05-08', '', 'expired', () => 'trade-2')
    ];

    expect(removeClosedTrade(current, 'trade-1')).toEqual([current[1]]);
    expect(removeClosedTrade(current, 'missing-id')).toEqual(current);
  });
});
