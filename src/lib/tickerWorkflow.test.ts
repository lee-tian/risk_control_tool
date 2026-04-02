import { describe, expect, it } from 'vitest';

import type { TickerEntry } from '../types';
import {
  addTickerEntry,
  createTickerEntryFromDraft,
  findTickerEntry,
  removeTickerEntry,
  sellTickerShares,
  updateTickerEntry
} from './tickerWorkflow';

const baseEntries: TickerEntry[] = [
  {
    ticker: 'AAPL',
    beta: 0.9,
    shares: 100,
    average_cost_basis: 180,
    downside_tolerance_pct: 0.12,
    current_price: 195,
    last_updated: '2026-04-01T00:00:00.000Z',
    current_iv: 0.28,
    current_iv_updated: '2026-04-01T00:00:00.000Z',
    put_call_ratio: 0.7,
    put_call_ratio_updated: '2026-04-01T00:00:00.000Z',
    provider_exchange: 'NASDAQ',
    provider_mic_code: 'XNAS',
    rsi_14: 55,
    rsi_14_1h: 51,
    rsi_updated: '2026-04-01T00:00:00.000Z',
    ma_21: 192,
    ma_200: 180
  }
];

describe('tickerWorkflow', () => {
  it('creates a stock entry from draft input for add flow', () => {
    expect(
      createTickerEntryFromDraft({
        ticker: ' nvda ',
        beta: '2.1',
        shares: '100',
        averageCostBasis: '830.5',
        downsideTolerancePct: '15',
        providerExchange: 'nasdaq',
        providerMicCode: 'xnas'
      })
    ).toEqual({
      ticker: 'NVDA',
      beta: 2.1,
      shares: 100,
      average_cost_basis: 830.5,
      downside_tolerance_pct: 0.15,
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
      provider_exchange: 'NASDAQ',
      provider_mic_code: 'XNAS',
      rsi_14: null,
      rsi_14_1h: null,
      rsi_updated: null,
      ma_21: null,
      ma_200: null
    });
  });

  it('adds a stock once and keeps the list sorted', () => {
    const next = addTickerEntry(baseEntries, {
      ticker: 'msft',
      beta: '1.1',
      shares: '50',
      averageCostBasis: '420',
      downsideTolerancePct: '8',
      providerExchange: '',
      providerMicCode: ''
    });

    expect(next.map((entry) => entry.ticker)).toEqual(['AAPL', 'MSFT']);
    expect(next[1]).toMatchObject({
      ticker: 'MSFT',
      beta: 1.1,
      shares: 50,
      average_cost_basis: 420,
      downside_tolerance_pct: 0.08
    });
  });

  it('does not add a duplicate stock ticker', () => {
    const next = addTickerEntry(baseEntries, {
      ticker: ' aapl ',
      beta: '1.2',
      shares: '10',
      averageCostBasis: '150',
      downsideTolerancePct: '5',
      providerExchange: '',
      providerMicCode: ''
    });

    expect(next).toEqual(baseEntries);
  });

  it('finds a stock by ticker during read flow', () => {
    expect(findTickerEntry(baseEntries, ' aapl ')).toEqual(baseEntries[0]);
    expect(findTickerEntry(baseEntries, 'NVDA')).toBeNull();
  });

  it('updates stock fields during edit flow without touching other rows', () => {
    const next = updateTickerEntry(baseEntries, 'AAPL', {
      shares: 150,
      average_cost_basis: 175,
      downside_tolerance_pct: 0.1
    });

    expect(next).toEqual([
      expect.objectContaining({
        ticker: 'AAPL',
        shares: 150,
        average_cost_basis: 175,
        downside_tolerance_pct: 0.1,
        current_price: 195
      })
    ]);
  });

  it('allows clearing manual stock fields during save flow', () => {
    const next = updateTickerEntry(baseEntries, 'AAPL', {
      beta: null,
      shares: null,
      average_cost_basis: null,
      downside_tolerance_pct: null
    });

    expect(next).toEqual([
      expect.objectContaining({
        ticker: 'AAPL',
        beta: null,
        shares: null,
        average_cost_basis: null,
        downside_tolerance_pct: null,
        current_price: 195
      })
    ]);
  });

  it('deletes the requested stock row during remove flow', () => {
    const next = removeTickerEntry(
      [
        ...baseEntries,
        {
          ...baseEntries[0],
          ticker: 'MSFT'
        }
      ],
      ' msft '
    );

    expect(next).toEqual([baseEntries[0]]);
  });

  it('sells part of a stock position and returns proceeds', () => {
    const result = sellTickerShares(baseEntries, 'AAPL', 40, 210);

    expect(result).toEqual({
      nextEntries: [
        expect.objectContaining({
          ticker: 'AAPL',
          shares: 60,
          average_cost_basis: 180
        })
      ],
      proceeds: 8400,
      remainingShares: 60
    });
  });

  it('clears average cost after selling the entire position', () => {
    const result = sellTickerShares(baseEntries, 'AAPL', 100, 200);

    expect(result).toEqual({
      nextEntries: [
        expect.objectContaining({
          ticker: 'AAPL',
          shares: 0,
          average_cost_basis: null
        })
      ],
      proceeds: 20000,
      remainingShares: 0
    });
  });
});
