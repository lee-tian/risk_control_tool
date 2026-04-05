import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ClosedPutTrade, PutPosition } from '../types';
import {
  applyPutPositionsImportPayload,
  buildAppStateSnapshot,
  filterDeletedPutPositions,
  filterDeletedTickers,
  loadConfig,
  loadClosedTrades,
  loadAccountValueHistory,
  loadDeletedPositionIds,
  loadDeletedTickers,
  loadPuts,
  loadStockTrades,
  loadTickerList,
  mergeClosedTradesPreservingLocal,
  mergePutPositionsPreservingLocal,
  mergeTickerListsPreservingManualFields,
  parseAppStateSnapshot,
  parsePutPositionsImportPayload,
  reconcileHydratedOpenPositions,
  saveConfig,
  saveClosedTrades,
  saveAccountValueHistory,
  saveDeletedPositionIds,
  savePuts,
  saveStockTrades,
  saveDeletedTickers,
  saveTickerList
} from './storage';

class LocalStorageMock {
  private store = new Map<string, string>();

  getItem(key: string) {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string) {
    this.store.set(key, value);
  }

  removeItem(key: string) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }
}

describe('storage helpers', () => {
  const localStorage = new LocalStorageMock();

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('window', { localStorage });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('loads config with legacy total_cash fallback and saves normalized config', () => {
    localStorage.setItem(
      'risk-tool-config',
      JSON.stringify({
        total_cash: 75000,
        risk_limit_pct: 0.25
      })
    );

    expect(loadConfig()).toEqual({
      cash: 75000,
      risk_limit_pct: 0.25,
      warning_threshold_pct: 0.8
    });

    saveConfig({
      cash: 90000,
      risk_limit_pct: 0.2,
      warning_threshold_pct: 0.7
    });

    expect(JSON.parse(localStorage.getItem('risk-tool-config') ?? '{}')).toEqual({
      cash: 90000,
      risk_limit_pct: 0.2,
      warning_threshold_pct: 0.7
    });
  });

  it('loads put positions with option side normalized', () => {
    localStorage.setItem(
      'risk-tool-puts',
      JSON.stringify([
        {
          id: 'call-1',
          ticker: 'nvda',
          option_side: 'call',
          put_strike: 220,
          premium_per_share: 2.4,
          contracts: 1,
          iv_rank: 40,
          date_sold: '2026-03-01',
          expiration_date: '2026-04-01'
        },
        {
          id: 'put-1',
          ticker: 'aapl',
          put_strike: 200,
          premium_per_share: 3.1,
          contracts: 1,
          iv_rank: 25,
          date_sold: '2026-03-01',
          expiration_date: '2026-04-01'
        }
      ])
    );

    expect(loadPuts()).toEqual([
      expect.objectContaining({ ticker: 'NVDA', option_side: 'call' }),
      expect.objectContaining({ ticker: 'AAPL', option_side: 'put' })
    ]);
  });

  it('saves and reloads option positions with decision snapshots and option greeks intact', () => {
    savePuts([
      {
        id: 'call-1',
        ticker: 'amzn',
        option_side: 'call',
        put_strike: 220,
        premium_per_share: 2.94,
        contracts: 3,
        iv_rank: 41.2,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        option_market_price_per_share: 1.45,
        option_market_price_updated: '2026-04-01T18:00:00.000Z',
        option_theta_per_share: -0.06,
        option_delta: 0.24,
        option_gamma: 0.018,
        decision_rationale: '交易类型：Covered Call；当前 IV 判断：IV高，权利金有吸引力',
        decision_snapshot: {
          verdict: '可以考虑',
          summary: '适合收租',
          rationale_check: '计划清晰',
          worst_case: '上涨收益受限',
          fundamental_note: '关注利润率',
          fundamental_events: ['2026-Q1 指引偏弱', 2 as never].filter((item): item is string => typeof item === 'string'),
          current_iv_rank: '41.2',
          iv_rank_note: '中性偏高',
          iv_rank_source: 'Barchart',
          iv_rank_time: '2026-04-01T18:00:00.000Z',
          iv_rank_link: 'https://example.com/ivr',
          action: '继续检查',
          key_risks: ['被提前行权'],
          max_profit: '$882',
          risk_at_10pct_drop: '$1200',
          analyzed_at: '2026-04-01T18:05:00.000Z'
        }
      }
    ] as PutPosition[]);

    expect(loadPuts()).toEqual([
      expect.objectContaining({
        ticker: 'AMZN',
        option_side: 'call',
        option_market_price_per_share: 1.45,
        option_theta_per_share: -0.06,
        option_delta: 0.24,
        option_gamma: 0.018,
        decision_snapshot: expect.objectContaining({
          summary: '适合收租',
          action: '继续检查',
          analyzed_at: '2026-04-01T18:05:00.000Z'
        })
      })
    ]);
  });

  it('filters malformed snapshot arrays when loading saved option positions', () => {
    localStorage.setItem(
      'risk-tool-puts',
      JSON.stringify([
        {
          id: 'put-1',
          ticker: 'msft',
          option_side: 'put',
          put_strike: 300,
          premium_per_share: 4.2,
          contracts: 1,
          iv_rank: 28,
          date_sold: '2026-04-01',
          expiration_date: '2026-05-15',
          decision_snapshot: {
            verdict: '需要谨慎',
            summary: '测试',
            rationale_check: '测试',
            worst_case: '测试',
            fundamental_note: '测试',
            fundamental_events: ['事件A', 123, null],
            current_iv_rank: '28.0',
            iv_rank_note: '测试',
            iv_rank_source: 'Barchart',
            iv_rank_time: '2026-04-01',
            iv_rank_link: '',
            action: '等待',
            key_risks: ['风险A', { label: '风险B' }],
            max_profit: '$420',
            risk_at_10pct_drop: '$900',
            analyzed_at: '2026-04-01T18:00:00.000Z'
          }
        }
      ])
    );

    expect(loadPuts()).toEqual([
      expect.objectContaining({
        decision_snapshot: expect.objectContaining({
          fundamental_events: ['事件A'],
          key_risks: ['风险A']
        })
      })
    ]);
  });

  it('merges snapshot puts with local puts and preserves local covered calls', () => {
    const snapshotPuts = [
      {
        id: 'put-1',
        ticker: 'AAPL',
        option_side: 'put',
        put_strike: 200,
        premium_per_share: 3.1,
        contracts: 1,
        iv_rank: 25,
        date_sold: '2026-03-01',
        expiration_date: '2026-04-01',
        option_market_price_per_share: null,
        option_market_price_updated: null,
        option_theta_per_share: null,
        decision_rationale: '',
        decision_snapshot: null
      }
    ] as PutPosition[];
    const localPuts = [
      {
        id: 'put-1',
        ticker: 'AAPL',
        option_side: 'put',
        put_strike: 200,
        premium_per_share: 3.1,
        contracts: 1,
        iv_rank: 25,
        date_sold: '2026-03-01',
        expiration_date: '2026-04-01',
        option_market_price_per_share: null,
        option_market_price_updated: null,
        option_theta_per_share: null,
        decision_rationale: '',
        decision_snapshot: null
      },
      {
        id: 'call-1',
        ticker: 'NFLX',
        option_side: 'call',
        put_strike: 100,
        premium_per_share: 2.94,
        contracts: 3,
        iv_rank: 38,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        option_market_price_per_share: null,
        option_market_price_updated: null,
        option_theta_per_share: null,
        decision_rationale: '',
        decision_snapshot: null
      }
    ] as PutPosition[];

    expect(mergePutPositionsPreservingLocal(snapshotPuts, localPuts)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'put-1', option_side: 'put' }),
        expect.objectContaining({ id: 'call-1', option_side: 'call', contracts: 3 })
      ])
    );
  });

  it('keeps partially closed positions during hydration even when a closed trade shares the same position id', () => {
    const localPuts = [
      {
        id: 'call-1',
        ticker: 'MSFT',
        option_side: 'call',
        put_strike: 400,
        premium_per_share: 6.95,
        contracts: 2,
        iv_rank: 38,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        option_market_price_per_share: null,
        option_market_price_updated: null,
        option_theta_per_share: null,
        decision_rationale: '',
        decision_snapshot: null
      }
    ] as PutPosition[];

    expect(reconcileHydratedOpenPositions([], localPuts, [], [])).toEqual([
      expect.objectContaining({ id: 'call-1', contracts: 2, option_side: 'call' })
    ]);
  });

  it('prefers refreshed snapshot market fields while preserving local position metadata', () => {
    const snapshotPuts = [
      {
        id: 'call-1',
        ticker: 'MSFT',
        option_side: 'call',
        put_strike: 400,
        premium_per_share: 6.95,
        contracts: 2,
        iv_rank: 38,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        option_market_price_per_share: 2.4,
        option_market_price_updated: '2026-04-03T20:00:00.000Z',
        option_theta_per_share: -0.06,
        decision_rationale: '',
        decision_snapshot: null
      }
    ] as PutPosition[];

    const localPuts = [
      {
        id: 'call-1',
        ticker: 'MSFT',
        option_side: 'call',
        put_strike: 400,
        premium_per_share: 6.95,
        contracts: 2,
        iv_rank: 38,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        option_market_price_per_share: 3.1,
        option_market_price_updated: '2026-04-02T15:00:00.000Z',
        option_theta_per_share: -0.04,
        decision_rationale: 'keep local rationale',
        decision_snapshot: null
      }
    ] as PutPosition[];

    expect(mergePutPositionsPreservingLocal(snapshotPuts, localPuts)).toEqual([
      expect.objectContaining({
        id: 'call-1',
        option_market_price_per_share: 2.4,
        option_market_price_updated: '2026-04-03T20:00:00.000Z',
        option_theta_per_share: -0.06,
        decision_rationale: 'keep local rationale'
      })
    ]);
  });

  it('removes fully deleted positions during hydration reconciliation', () => {
    const localPuts = [
      {
        id: 'put-1',
        ticker: 'MSFT',
        option_side: 'put',
        put_strike: 390,
        premium_per_share: 12.57,
        contracts: 2,
        iv_rank: 30,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        option_market_price_per_share: null,
        option_market_price_updated: null,
        option_theta_per_share: null,
        decision_rationale: '',
        decision_snapshot: null
      }
    ] as PutPosition[];

    expect(reconcileHydratedOpenPositions(localPuts, localPuts, ['put-1'], [])).toEqual([]);
  });

  it('filters stale snapshot rows for fully closed positions while keeping partially closed rows', () => {
    const snapshotPuts = [
      {
        id: 'call-1',
        ticker: 'MSFT',
        option_side: 'call',
        put_strike: 400,
        premium_per_share: 6.95,
        contracts: 3,
        iv_rank: 38,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        option_market_price_per_share: null,
        option_market_price_updated: null,
        option_theta_per_share: null,
        decision_rationale: '',
        decision_snapshot: null
      },
      {
        id: 'put-1',
        ticker: 'AAPL',
        option_side: 'put',
        put_strike: 200,
        premium_per_share: 3.1,
        contracts: 1,
        iv_rank: 25,
        date_sold: '2026-03-01',
        expiration_date: '2026-04-01',
        option_market_price_per_share: null,
        option_market_price_updated: null,
        option_theta_per_share: null,
        decision_rationale: '',
        decision_snapshot: null
      }
    ] as PutPosition[];

    const localPuts = [
      {
        id: 'call-1',
        ticker: 'MSFT',
        option_side: 'call',
        put_strike: 400,
        premium_per_share: 6.95,
        contracts: 2,
        iv_rank: 38,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        option_market_price_per_share: null,
        option_market_price_updated: null,
        option_theta_per_share: null,
        decision_rationale: '',
        decision_snapshot: null
      }
    ] as PutPosition[];

    const closedTrades: ClosedPutTrade[] = [
      {
        id: 'trade-1',
        position_id: 'call-1',
        ticker: 'MSFT',
        option_side: 'call',
        put_strike: 400,
        premium_sold_per_share: 6.95,
        premium_bought_back_per_share: 1,
        contracts: 1,
        date_sold: '2026-04-01',
        expiration_date: '2026-05-15',
        closed_at: '2026-04-02',
        close_reason: 'manual',
        realized_pnl: 595,
        reflection_notes: ''
      },
      {
        id: 'trade-2',
        position_id: 'put-1',
        ticker: 'AAPL',
        option_side: 'put',
        put_strike: 200,
        premium_sold_per_share: 3.1,
        premium_bought_back_per_share: 1.2,
        contracts: 1,
        date_sold: '2026-03-01',
        expiration_date: '2026-04-01',
        closed_at: '2026-03-15',
        close_reason: 'manual',
        realized_pnl: 190,
        reflection_notes: ''
      }
    ];

    expect(reconcileHydratedOpenPositions(snapshotPuts, localPuts, [], closedTrades)).toEqual([
      expect.objectContaining({ id: 'call-1', contracts: 2, option_side: 'call' })
    ]);
  });

  it('merges snapshot closed trades with local trades and preserves local call history', () => {
    const merged = mergeClosedTradesPreservingLocal(
      [
        {
          id: 'trade-1',
          position_id: 'put-1',
          ticker: 'AAPL',
          option_side: 'put',
          put_strike: 200,
          premium_sold_per_share: 3.1,
          premium_bought_back_per_share: 1.2,
          contracts: 1,
          date_sold: '2026-03-01',
          expiration_date: '2026-04-01',
          closed_at: '2026-03-15',
          close_reason: 'manual',
          realized_pnl: 190,
          reflection_notes: ''
        }
      ],
      [
        {
          id: 'trade-2',
          position_id: 'call-1',
          ticker: 'NFLX',
          option_side: 'call',
          put_strike: 100,
          premium_sold_per_share: 2.94,
          premium_bought_back_per_share: 0,
          contracts: 3,
          date_sold: '2026-04-01',
          expiration_date: '2026-05-15',
          closed_at: '2026-04-01',
          close_reason: 'manual',
          realized_pnl: 882,
          reflection_notes: ''
        }
      ]
    );

    expect(merged).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'trade-1', option_side: 'put' }),
        expect.objectContaining({ id: 'trade-2', option_side: 'call', contracts: 3 })
      ])
    );
  });

  it('saves and loads deleted tickers in normalized form', () => {
    saveDeletedTickers([' nvda ', 'AAPL', 'nvda']);

    expect(loadDeletedTickers()).toEqual(['AAPL', 'NVDA']);
  });

  it('saves and loads deleted position ids in normalized form', () => {
    saveDeletedPositionIds([' put-2 ', 'put-1', 'put-2']);

    expect(loadDeletedPositionIds()).toEqual(['put-1', 'put-2']);
  });

  it('filters deleted tickers out of merged ticker lists', () => {
    const filtered = filterDeletedTickers(
      [
        {
          ticker: 'AAPL', beta: 0.87, shares: null, average_cost_basis: null, downside_tolerance_pct: null,
          current_price: null, last_updated: null, current_iv: null, current_iv_updated: null,
          put_call_ratio: null, put_call_ratio_updated: null, provider_exchange: null, provider_mic_code: null,
          rsi_14: null, rsi_14_1h: null, rsi_updated: null, ma_21: null, ma_200: null
        },
        {
          ticker: 'NVDA', beta: 2.17, shares: null, average_cost_basis: null, downside_tolerance_pct: null,
          current_price: null, last_updated: null, current_iv: null, current_iv_updated: null,
          put_call_ratio: null, put_call_ratio_updated: null, provider_exchange: null, provider_mic_code: null,
          rsi_14: null, rsi_14_1h: null, rsi_updated: null, ma_21: null, ma_200: null
        }
      ],
      ['nvda']
    );

    expect(filtered).toEqual([
      expect.objectContaining({ ticker: 'AAPL' })
    ]);
  });

  it('filters deleted open positions out of snapshot puts before merge', () => {
    const filtered = filterDeletedPutPositions(
      [
        {
          id: 'put-1',
          ticker: 'AAPL',
          option_side: 'put',
          put_strike: 200,
          premium_per_share: 3.1,
          contracts: 1,
          iv_rank: 25,
          date_sold: '2026-03-01',
          expiration_date: '2026-04-01',
          option_market_price_per_share: null,
          option_market_price_updated: null,
          option_theta_per_share: null,
          decision_rationale: '',
          decision_snapshot: null
        },
        {
          id: 'put-2',
          ticker: 'NVDA',
          option_side: 'put',
          put_strike: 145,
          premium_per_share: 2.9,
          contracts: 1,
          iv_rank: 23.9,
          date_sold: '2026-04-01',
          expiration_date: '2026-05-08',
          option_market_price_per_share: 2.73,
          option_market_price_updated: '2026-04-01T22:00:00.000Z',
          option_theta_per_share: -0.084,
          decision_rationale: '',
          decision_snapshot: null
        }
      ],
      ['put-2']
    );

    expect(filtered).toEqual([
      expect.objectContaining({ id: 'put-1', ticker: 'AAPL' })
    ]);
  });

  it('loads and normalizes ticker list from legacy strings and mixed records', () => {
    localStorage.setItem(
      'risk-tool-ticker-list',
      JSON.stringify([
        ' nvda ',
        'GLD',
        {
          ticker: 'aapl',
          beta: 0.9,
          current_price: 200,
          iv_rank: 0.33,
          provider_exchange: 'nasdaq',
          provider_mic_code: 'xnas'
        },
        {
          ticker: 'GLD',
          beta: 0.25
        },
        {
          ticker: ' '
        }
      ])
    );

    expect(loadTickerList()).toEqual([
      {
        ticker: 'AAPL',
        beta: 0.9,
        shares: null,
        average_cost_basis: null,
        downside_tolerance_pct: null,
        current_price: 200,
        last_updated: null,
        next_earnings_date: null,
        current_iv: 0.33,
        current_iv_updated: null,
        historical_iv: null,
        iv_rank: 0.33,
        iv_percentile: null,
        put_call_ratio: null,
        put_call_ratio_updated: null,
        provider_exchange: 'NASDAQ',
        provider_mic_code: 'XNAS',
        rsi_14: null,
        rsi_14_1h: null,
        rsi_updated: null,
        ma_21: null,
        ma_200: null
      },
      {
        ticker: 'GLD',
        beta: 0.19,
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
        provider_exchange: 'NYSE',
        provider_mic_code: 'ARCX',
        rsi_14: null,
        rsi_14_1h: null,
        rsi_updated: null,
        ma_21: null,
        ma_200: null
      },
      {
        ticker: 'NVDA',
        beta: 2.17,
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
    ]);
  });

  it('saves ticker list in normalized sorted uppercase form', () => {
    saveTickerList([
      {
        ticker: ' nvda ',
        beta: 2.17,
        shares: 100,
        average_cost_basis: 150,
        downside_tolerance_pct: 0.3,
        current_price: 171.24,
        last_updated: '2026-03-26T22:55:00.000Z',
        next_earnings_date: null,
        current_iv: 0.34,
        current_iv_updated: '2026-03-26T22:55:00.000Z',
        historical_iv: null,
        iv_rank: null,
        iv_percentile: null,
        put_call_ratio: 0.89,
        put_call_ratio_updated: '2026-03-26T22:55:00.000Z',
        provider_exchange: 'nasdaq',
        provider_mic_code: 'xnas',
        rsi_14: 48,
        rsi_14_1h: 52,
        rsi_updated: '2026-03-26T22:55:00.000Z',
        ma_21: 190,
        ma_200: 180
      },
      {
        ticker: ' ',
        beta: null,
        shares: null,
        average_cost_basis: null,
        downside_tolerance_pct: null,
        current_price: null,
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
    ]);

    expect(JSON.parse(localStorage.getItem('risk-tool-ticker-list') ?? '[]')).toEqual([
      {
        ticker: 'NVDA',
        beta: 2.17,
        shares: 100,
        average_cost_basis: 150,
        downside_tolerance_pct: 0.3,
        current_price: 171.24,
        last_updated: '2026-03-26T22:55:00.000Z',
        next_earnings_date: null,
        current_iv: 0.34,
        current_iv_updated: '2026-03-26T22:55:00.000Z',
        historical_iv: null,
        iv_rank: null,
        iv_percentile: null,
        put_call_ratio: 0.89,
        put_call_ratio_updated: '2026-03-26T22:55:00.000Z',
        provider_exchange: 'NASDAQ',
        provider_mic_code: 'XNAS',
        rsi_14: 48,
        rsi_14_1h: 52,
        rsi_updated: '2026-03-26T22:55:00.000Z',
        ma_21: 190,
        ma_200: 180
      }
    ]);
  });

  it('persists and reloads barchart market metrics on ticker entries', () => {
    saveTickerList([
      {
        ticker: 'nvda',
        beta: 2.17,
        shares: 300,
        average_cost_basis: 165,
        downside_tolerance_pct: 0.2,
        current_price: 175.75,
        last_updated: '2026-04-01T22:55:00.000Z',
        next_earnings_date: '2026-05-27',
        current_iv: 0.3673,
        current_iv_updated: '2026-04-01T22:55:00.000Z',
        historical_iv: 0.3741,
        iv_rank: 11.57,
        iv_percentile: 32,
        put_call_ratio: 0.87,
        put_call_ratio_updated: '2026-04-01T22:55:00.000Z',
        provider_exchange: 'nasdaq',
        provider_mic_code: 'xnas',
        rsi_14: 47.6,
        rsi_14_1h: 66.9,
        rsi_updated: '2026-04-01T22:55:00.000Z',
        ma_21: 178.17,
        ma_200: 179.63
      }
    ]);

    expect(loadTickerList()).toEqual([
      expect.objectContaining({
        ticker: 'NVDA',
        next_earnings_date: '2026-05-27',
        current_iv: 0.3673,
        historical_iv: 0.3741,
        iv_rank: 11.57,
        iv_percentile: 32,
        put_call_ratio: 0.87
      })
    ]);
  });

  it('parses imported put payloads and rejects invalid files', () => {
    const payload = parsePutPositionsImportPayload(
      JSON.stringify({
        version: 1,
        exported_at: '2026-03-26T12:00:00.000Z',
        data: {
          puts: [{ ticker: 'nvda', put_strike: 160 }]
        }
      })
    );

    expect(payload.version).toBe(1);
    expect(payload.data.puts).toHaveLength(1);

    expect(() => parsePutPositionsImportPayload(JSON.stringify({ version: 2, data: {} }))).toThrow('导入文件格式不正确');
  });

  it('parses app snapshots with normalization for imported data', () => {
    const snapshot = parseAppStateSnapshot(
      JSON.stringify({
        version: 1,
        exported_at: '2026-03-26T12:00:00.000Z',
        data: {
          config: { total_cash: 88000, warning_threshold_pct: 0.7 },
          puts: [{ id: 'put-1', ticker: ' msft ', put_strike: 300, premium_per_share: 5, contracts: 1 }],
          closedTrades: [{ id: 'trade-1', ticker: ' msft ', option_side: 'call', closed_at: '2026-03-20', close_reason: 'expired' }],
          stockTrades: [{ id: 'stock-1', ticker: ' aapl ', action: 'sell', shares: 10, price_per_share: 210, traded_at: '2026-03-24', cash_change: 2100, realized_pnl: 150 }],
          tickerList: [{ ticker: ' gld ' }, { ticker: 'aapl', beta: 0.9 }],
          scenario: 0.12,
          vixHistory: [{ timestamp: '2026-03-26', value: 25.18, stress: 0.1 }, { timestamp: '', value: 0, stress: 0 }],
          accountValueHistory: [
            { date: '2026-03-26', total_capital: 100500, as_of: '2026-03-26T20:00:00.000Z' },
            { date: '', total_capital: 0, as_of: '' }
          ]
        }
      })
    );

    expect(snapshot.data.config).toEqual({
      cash: 88000,
      risk_limit_pct: 0.2,
      warning_threshold_pct: 0.7
    });
    expect(snapshot.data.puts[0]).toMatchObject({
      id: 'put-1',
      ticker: 'MSFT',
      put_strike: 300,
      premium_per_share: 5,
      contracts: 1
    });
    expect(snapshot.data.closedTrades[0]).toMatchObject({
      id: 'trade-1',
      ticker: 'MSFT',
      option_side: 'call',
      close_reason: 'expired'
    });
    expect(snapshot.data.stockTrades).toEqual([
      expect.objectContaining({
        id: 'stock-1',
        ticker: 'AAPL',
        action: 'sell',
        shares: 10,
        price_per_share: 210,
        cash_change: 2100,
        realized_pnl: 150
      })
    ]);
    expect(snapshot.data.tickerList).toEqual([
      expect.objectContaining({ ticker: 'AAPL', beta: 0.9 }),
      expect.objectContaining({ ticker: 'GLD', beta: 0.19, provider_exchange: 'NYSE', provider_mic_code: 'ARCX' })
    ]);
    expect(snapshot.data.scenario).toBe(0.12);
    expect(snapshot.data.vixHistory).toEqual([{ timestamp: '2026-03-26', value: 25.18, stress: 0.1 }]);
    expect(snapshot.data.accountValueHistory).toEqual([
      { date: '2026-03-26', total_capital: 100500, as_of: '2026-03-26T20:00:00.000Z' }
    ]);

    expect(() => parseAppStateSnapshot(JSON.stringify({ version: 2, data: {} }))).toThrow('应用快照格式不正确');
  });

  it('applies imported put payloads and persists derived ticker list', () => {
    const payload: { version: 1; exported_at: string; data: { puts: PutPosition[] } } = {
      version: 1,
      exported_at: '2026-03-26T12:00:00.000Z',
      data: {
        puts: [
          {
            id: 'put-1',
            ticker: 'nvda',
            put_strike: 160,
            premium_per_share: 4,
            contracts: 1,
            iv_rank: 40,
            date_sold: '2026-03-26',
            expiration_date: '2026-05-08'
          },
          {
            id: 'put-2',
            ticker: 'gld',
            put_strike: 280,
            premium_per_share: 2,
            contracts: 1,
            iv_rank: 20,
            date_sold: '2026-03-26',
            expiration_date: '2026-05-08'
          }
        ]
      }
    };

    const result = applyPutPositionsImportPayload(payload);

    expect(result.puts).toHaveLength(2);
    expect(result.tickerList).toEqual([
      expect.objectContaining({ ticker: 'GLD', beta: 0.19, provider_exchange: 'NYSE', provider_mic_code: 'ARCX' }),
      expect.objectContaining({ ticker: 'NVDA', beta: 2.17 })
    ]);
    expect(JSON.parse(localStorage.getItem('risk-tool-puts') ?? '[]')).toHaveLength(2);
    expect(JSON.parse(localStorage.getItem('risk-tool-ticker-list') ?? '[]')).toHaveLength(2);
  });

  it('builds app snapshots from current in-memory state', () => {
    const snapshot = buildAppStateSnapshot({
      config: { cash: 100000, risk_limit_pct: 0.2, warning_threshold_pct: 0.8 },
      puts: [],
      closedTrades: [],
      stockTrades: [],
      tickerList: [],
      scenario: 0.1,
      vixHistory: [{ timestamp: '2026-03-26', value: 25.18, stress: 0.1 }],
      accountValueHistory: [{ date: '2026-03-26', total_capital: 100000, as_of: '2026-03-26T20:00:00.000Z' }]
    });

    expect(snapshot.version).toBe(1);
    expect(snapshot.data.config?.cash).toBe(100000);
    expect(snapshot.data.scenario).toBe(0.1);
    expect(snapshot.data.vixHistory).toEqual([{ timestamp: '2026-03-26', value: 25.18, stress: 0.1 }]);
    expect(snapshot.data.accountValueHistory).toEqual([
      { date: '2026-03-26', total_capital: 100000, as_of: '2026-03-26T20:00:00.000Z' }
    ]);
    expect(typeof snapshot.exported_at).toBe('string');
  });

  it('loads and saves stock trade history', () => {
    saveStockTrades([
      {
        id: 'stock-buy-1',
        ticker: 'msft',
        action: 'buy',
        shares: 50,
        price_per_share: 300,
        traded_at: '2026-04-01',
        cash_change: -15000,
        realized_pnl: 0
      },
      {
        id: 'stock-sell-1',
        ticker: 'aapl',
        action: 'sell',
        shares: 20,
        price_per_share: 220,
        traded_at: '2026-04-02',
        cash_change: 4400,
        realized_pnl: 180
      }
    ]);

    expect(loadStockTrades()).toEqual([
      expect.objectContaining({
        id: 'stock-buy-1',
        ticker: 'MSFT',
        action: 'buy',
        cash_change: -15000
      }),
      expect.objectContaining({
        id: 'stock-sell-1',
        ticker: 'AAPL',
        action: 'sell',
        realized_pnl: 180
      })
    ]);
  });

  it('loads and saves account value history', () => {
    saveAccountValueHistory([
      {
        date: '2026-04-02',
        total_capital: 120500,
        as_of: '2026-04-02T20:00:00.000Z'
      }
    ]);

    expect(loadAccountValueHistory()).toEqual([
      {
        date: '2026-04-02',
        total_capital: 120500,
        as_of: '2026-04-02T20:00:00.000Z'
      }
    ]);
  });

  it('loads and saves closed trade reflection notes', () => {
    saveClosedTrades([
      {
        id: 'trade-1',
        position_id: 'put-1',
        ticker: 'msft',
        option_side: 'call',
        put_strike: 390,
        premium_sold_per_share: 12.57,
        premium_bought_back_per_share: 29.85,
        contracts: 1,
        date_sold: '2026-03-17',
        expiration_date: '2026-05-01',
        closed_at: '2026-03-28',
        close_reason: 'manual',
        realized_pnl: -1728,
        reflection_notes: '卖得太早，没等 IV 扩张结束。'
      }
    ]);

    expect(loadClosedTrades()).toEqual([
      expect.objectContaining({
        ticker: 'MSFT',
        option_side: 'call',
        reflection_notes: '卖得太早，没等 IV 扩张结束。'
      })
    ]);
  });

  it('preserves local manual ticker fields when snapshot values are empty', () => {
    expect(
      mergeTickerListsPreservingManualFields(
        [
          {
            ticker: 'AMZN',
            beta: null,
            shares: 500,
            average_cost_basis: null,
            downside_tolerance_pct: null,
            current_price: 201.09,
            last_updated: '2026-03-27T17:02:20.337Z',
            current_iv: 0.4188,
            current_iv_updated: '2026-03-26T19:40:35.403Z',
            put_call_ratio: 0.7129,
            put_call_ratio_updated: '2026-03-23T05:33:46.021Z',
            provider_exchange: null,
            provider_mic_code: null,
            rsi_14: 47.9,
            rsi_14_1h: 50.9,
            rsi_updated: '2026-03-26T16:38:18.601Z',
            ma_21: 210.96,
            ma_200: 224.77
          }
        ],
        [
          {
            ticker: 'AMZN',
            beta: 1.31,
            shares: 500,
            average_cost_basis: 207.5,
            downside_tolerance_pct: 0.25,
            current_price: null,
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
        ]
      )
    ).toEqual([
      expect.objectContaining({
        ticker: 'AMZN',
        beta: 1.31,
        shares: 500,
        average_cost_basis: 207.5,
        downside_tolerance_pct: 0.25,
        current_price: 201.09,
        current_iv: 0.4188,
        ma_200: 224.77
      })
    ]);
  });

  it('preserves local market metrics when snapshot omits them', () => {
    expect(
      mergeTickerListsPreservingManualFields(
        [
          {
            ticker: 'NVDA',
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
        ],
        [
          {
            ticker: 'NVDA',
            beta: 2.17,
            shares: 300,
            average_cost_basis: 165,
            downside_tolerance_pct: 0.2,
            current_price: 175.75,
            last_updated: '2026-04-01T22:55:00.000Z',
            next_earnings_date: '2026-05-27',
            current_iv: 0.3673,
            current_iv_updated: '2026-04-01T22:55:00.000Z',
            historical_iv: 0.3741,
            iv_rank: 11.57,
            iv_percentile: 32,
            put_call_ratio: 0.87,
            put_call_ratio_updated: '2026-04-01T22:55:00.000Z',
            provider_exchange: 'NASDAQ',
            provider_mic_code: 'XNAS',
            rsi_14: 47.6,
            rsi_14_1h: 66.9,
            rsi_updated: '2026-04-01T22:55:00.000Z',
            ma_21: 178.17,
            ma_200: 179.63
          }
        ]
      )
    ).toEqual([
      expect.objectContaining({
        ticker: 'NVDA',
        beta: 2.17,
        shares: 300,
        current_price: 175.75,
        next_earnings_date: '2026-05-27',
        current_iv: 0.3673,
        historical_iv: 0.3741,
        iv_rank: 11.57,
        iv_percentile: 32,
        put_call_ratio: 0.87,
        ma_200: 179.63
      })
    ]);
  });

  it('keeps local manual fields when they are already populated and includes local-only tickers', () => {
    expect(
      mergeTickerListsPreservingManualFields(
        [
          {
            ticker: 'AMZN',
            beta: 1.2,
            shares: 300,
            average_cost_basis: 190,
            downside_tolerance_pct: 0.2,
            current_price: 201.09,
            last_updated: '2026-03-27T17:02:20.337Z',
            current_iv: 0.4188,
            current_iv_updated: '2026-03-26T19:40:35.403Z',
            put_call_ratio: 0.7129,
            put_call_ratio_updated: '2026-03-23T05:33:46.021Z',
            provider_exchange: null,
            provider_mic_code: null,
            rsi_14: 47.9,
            rsi_14_1h: 50.9,
            rsi_updated: '2026-03-26T16:38:18.601Z',
            ma_21: 210.96,
            ma_200: 224.77
          }
        ],
        [
          {
            ticker: 'AMZN',
            beta: 1.31,
            shares: 500,
            average_cost_basis: 207.5,
            downside_tolerance_pct: 0.25,
            current_price: null,
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
          },
          {
            ticker: 'NVDA',
            beta: 2.17,
            shares: 100,
            average_cost_basis: 150,
            downside_tolerance_pct: 0.3,
            current_price: 171.24,
            last_updated: '2026-03-26T22:55:00.000Z',
            current_iv: 0.34,
            current_iv_updated: '2026-03-26T22:55:00.000Z',
            put_call_ratio: 0.89,
            put_call_ratio_updated: '2026-03-26T22:55:00.000Z',
            provider_exchange: null,
            provider_mic_code: null,
            rsi_14: 48,
            rsi_14_1h: 52,
            rsi_updated: '2026-03-26T22:55:00.000Z',
            ma_21: 190,
            ma_200: 180
          }
        ]
      )
    ).toEqual([
      expect.objectContaining({
        ticker: 'AMZN',
        beta: 1.31,
        shares: 500,
        average_cost_basis: 207.5,
        downside_tolerance_pct: 0.25
      }),
      expect.objectContaining({
        ticker: 'NVDA',
        shares: 100,
        average_cost_basis: 150
      })
    ]);
  });
});
