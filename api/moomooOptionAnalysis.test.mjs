import { describe, expect, it, vi } from 'vitest';

import {
  fetchMoomooDailyKline,
  fetchMoomooOptionChainSnapshot,
  fetchRecommendedMoomooOptionPlan,
  summarizeMoomooOptionChain
} from './moomooOptionAnalysis.mjs';

describe('summarizeMoomooOptionChain', () => {
  it('prefers farther OTM candidates that stay outside key support', () => {
    const summary = summarizeMoomooOptionChain(
      [
        {
          code: 'US.AAPL260515P200000',
          side: 'put',
          strike: 200,
          expirationDate: '2026-05-15',
          openInterest: 42000,
          impliedVolatility: 31.2,
          delta: -0.12,
          gamma: 0.01,
          theta: -0.05,
          volume: 25000,
          bid: 3.1,
          ask: 3.25,
          lastPrice: 3.2,
          price: 3.2,
          spreadPct: 4.76,
          updateTime: '2026-04-08 15:42:20'
        },
        {
          code: 'US.AAPL260515P205000',
          side: 'put',
          strike: 205,
          expirationDate: '2026-05-15',
          openInterest: 38000,
          impliedVolatility: 30.7,
          delta: -0.14,
          gamma: 0.01,
          theta: -0.05,
          volume: 1800,
          bid: 3.6,
          ask: 4.2,
          lastPrice: 4.0,
          price: 4.0,
          spreadPct: 15,
          updateTime: '2026-04-08 15:42:20'
        },
        {
          code: 'US.AAPL260515C240000',
          side: 'call',
          strike: 240,
          expirationDate: '2026-05-15',
          openInterest: 51000,
          impliedVolatility: 33.5,
          delta: 0.12,
          gamma: 0.01,
          theta: -0.12,
          volume: 600,
          bid: 2.4,
          ask: 2.5,
          lastPrice: 2.45,
          price: 2.45,
          spreadPct: 4.08,
          updateTime: '2026-04-08 15:42:20'
        }
      ],
      'put',
      220,
      {
        nearestSupport: { price: 202, strength: 3, source: '20D low + swing low' },
        nearestResistance: { price: 240, strength: 2, source: '20D high' },
        supportLevels: [{ price: 202, strength: 3, source: '20D low + swing low' }],
        resistanceLevels: [{ price: 240, strength: 2, source: '20D high' }]
      }
    );

    expect(summary.supportCluster).toEqual({ strike: 200, openInterest: 42000 });
    expect(summary.resistanceCluster).toEqual({ strike: 240, openInterest: 51000 });
    expect(summary.recommendedCandidate?.code).toBe('US.AAPL260515P200000');
    expect(summary.recommendedCandidate?.distancePct).toBeCloseTo(9.09, 2);
    expect(summary.recommendedCandidate?.outsideLevel).toBe(true);
    expect(summary.recommendedCandidate?.selectionBasis).toEqual(
      expect.arrayContaining(['Delta 0.12', '9.09% OTM', '位于支撑外侧'])
    );
    expect(summary.candidates).toHaveLength(2);
    expect(summary.warnings).toContain('该合约成交量 25000 / OI 42000，成交偏热。');
  });
});

describe('fetchRecommendedMoomooOptionPlan', () => {
  it('chooses the nearest expiry around 45 DTE and enriches the plan with kline levels', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [{ strike_time: '2026-05-22' }, { strike_time: '2026-06-05' }]
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [
            { time: '2026-03-26 00:00:00', open: 208, high: 211, low: 206, close: 210, volume: 1000 },
            { time: '2026-03-27 00:00:00', open: 210, high: 212, low: 205, close: 206, volume: 1000 },
            { time: '2026-03-30 00:00:00', open: 206, high: 214, low: 206, close: 213, volume: 1000 },
            { time: '2026-03-31 00:00:00', open: 213, high: 216, low: 212, close: 215, volume: 1000 },
            { time: '2026-04-01 00:00:00', open: 215, high: 218, low: 214, close: 217, volume: 1000 },
            { time: '2026-04-02 00:00:00', open: 217, high: 221, low: 216, close: 220, volume: 1000 },
            { time: '2026-04-03 00:00:00', open: 220, high: 222, low: 218, close: 219, volume: 1000 },
            { time: '2026-04-06 00:00:00', open: 219, high: 224, low: 218, close: 223, volume: 1000 },
            { time: '2026-04-07 00:00:00', open: 223, high: 225, low: 221, close: 224, volume: 1000 },
            { time: '2026-04-08 00:00:00', open: 224, high: 226, low: 222, close: 223.5, volume: 1000 }
          ]
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [{ code: 'US.AAPL260522P200000', option_type: 'PUT', strike_time: '2026-05-22' }]
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [
            {
              code: 'US.AAPL260522P200000',
              option_type: 'PUT',
              strike_time: '2026-05-22',
              option_strike_price: 200,
              option_open_interest: 42000,
              option_implied_volatility: 31.2,
              option_delta: -0.12,
              option_theta: -0.05,
              volume: 1200,
              bid_price: 3.1,
              ask_price: 3.25,
              last_price: 3.2,
              update_time: '2026-04-08 15:42:20'
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [{ code: 'US.AAPL260605P195000', option_type: 'PUT', strike_time: '2026-06-05' }]
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [
            {
              code: 'US.AAPL260605P195000',
              option_type: 'PUT',
              strike_time: '2026-06-05',
              option_strike_price: 195,
              option_open_interest: 42000,
              option_implied_volatility: 31.2,
              option_delta: -0.12,
              option_theta: -0.05,
              volume: 1200,
              bid_price: 4.1,
              ask_price: 4.25,
              last_price: 4.2,
              update_time: '2026-04-08 15:42:20'
            }
          ]
        })
      });

    const plan = await fetchRecommendedMoomooOptionPlan('AAPL', 'put', '2026-04-08', 223.5, { execFileImpl });

    expect(plan.expirationDate).toBe('2026-05-22');
    expect(plan.dte).toBe(44);
    expect(plan.klineSnapshot).toMatchObject({
      underlying: 'US.AAPL',
      interval: '1d'
    });
    expect(plan.summary.klineLevels?.nearestSupport).toEqual(
      expect.objectContaining({
        price: expect.any(Number)
      })
    );
    expect(plan.summary.recommendedCandidate?.code).toBe('US.AAPL260522P200000');
    expect(execFileImpl).toHaveBeenCalledTimes(4);
  });
});

describe('fetchMoomooDailyKline', () => {
  it('loads historical daily candles through the moomoo script wrapper', async () => {
    const execFileImpl = vi.fn().mockResolvedValueOnce({
      stdout: JSON.stringify({
        data: [
          { time: '2026-04-07 00:00:00', open: 220, high: 224, low: 218, close: 223, volume: 1000 },
          { time: '2026-04-08 00:00:00', open: 223, high: 225, low: 221, close: 224, volume: 900 }
        ]
      })
    });

    const snapshot = await fetchMoomooDailyKline('AAPL', '2026-04-08', { execFileImpl });

    expect(snapshot.underlying).toBe('US.AAPL');
    expect(snapshot.interval).toBe('1d');
    expect(snapshot.rows).toHaveLength(2);
    expect(execFileImpl).toHaveBeenCalledTimes(1);
  });
});

describe('fetchMoomooOptionChainSnapshot', () => {
  it('loads chain definitions first and then option snapshots for the same expiry', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          code: 'US.AAPL',
          data: [
            { code: 'US.AAPL260515P200000', option_type: 'PUT', strike_time: '2026-05-15', strike_price: 200 },
            { code: 'US.AAPL260515C240000', option_type: 'CALL', strike_time: '2026-05-15', strike_price: 240 }
          ]
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [
            {
              code: 'US.AAPL260515P200000',
              option_type: 'PUT',
              strike_time: '2026-05-15',
              option_strike_price: 200,
              option_open_interest: 42000,
              option_implied_volatility: 31.2,
              option_delta: -0.12,
              option_theta: -0.05,
              volume: 1200,
              bid_price: 3.1,
              ask_price: 3.25,
              last_price: 3.2,
              update_time: '2026-04-08 15:42:20'
            }
          ]
        })
      });

    const snapshot = await fetchMoomooOptionChainSnapshot('AAPL', '2026-05-15', { execFileImpl });

    expect(snapshot.underlying).toBe('US.AAPL');
    expect(snapshot.rows).toEqual([
      expect.objectContaining({
        code: 'US.AAPL260515P200000',
        side: 'put',
        strike: 200,
        openInterest: 42000,
        delta: -0.12
      })
    ]);
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });
});
