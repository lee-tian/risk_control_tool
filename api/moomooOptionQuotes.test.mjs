import { describe, expect, it, vi } from 'vitest';

import {
  extractOptionQuoteFromMoomooChain,
  extractOptionQuoteFromMoomooSnapshot,
  fetchMoomooOptionQuote
} from './moomooOptionQuotes.mjs';

describe('extractOptionQuoteFromMoomooChain', () => {
  it('matches the exact expiry, strike, and side from chain data', () => {
    const quote = extractOptionQuoteFromMoomooChain(
      {
        data: [
          {
            code: 'US.AAPL260515C235000',
            option_type: 'CALL',
            strike_price: 235,
            strike_time: '2026-05-15',
            last_price: 12.3
          },
          {
            code: 'US.AAPL260515C240000',
            option_type: 'CALL',
            strike_price: 240,
            strike_time: '2026-05-15',
            last_price: 10.6,
            delta: 0.33,
            gamma: 0.02,
            theta: -0.08
          }
        ]
      },
      240,
      '2026-05-15',
      'call'
    );

    expect(quote).toEqual({
      code: 'US.AAPL260515C240000',
      price: 10.6,
      theta: -0.08,
      delta: 0.33,
      gamma: 0.02
    });
  });
});

describe('extractOptionQuoteFromMoomooSnapshot', () => {
  it('prefers snapshot last price and reads greeks from option snapshot fields', () => {
    expect(
      extractOptionQuoteFromMoomooSnapshot(
        {
          data: [
            {
              code: 'US.AAPL260515C240000',
              last_price: 10.8,
              bid_price: 10.7,
              ask_price: 10.9,
              option_theta: -0.07,
              option_delta: 0.31,
              option_gamma: 0.018
            }
          ]
        },
        'US.AAPL260515C240000'
      )
    ).toEqual({
      price: 10.8,
      theta: -0.07,
      delta: 0.31,
      gamma: 0.018
    });

    expect(
      extractOptionQuoteFromMoomooSnapshot(
        {
          data: [
            {
              code: 'US.AAPL260515C240000',
              last_price: 0,
              bid_price: 10.7,
              ask_price: 10.9,
              option_theta: -0.07,
              option_delta: 0.31,
              option_gamma: 0.018
            }
          ]
        },
        'US.AAPL260515C240000'
      )
    ).toEqual({
      price: 10.8,
      theta: -0.07,
      delta: 0.31,
      gamma: 0.018
    });
  });
});

describe('fetchMoomooOptionQuote', () => {
  it('uses the option chain code and then refreshes price from snapshot', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: [
          '2026-04-08 16:57:46,533 | log line before json',
          JSON.stringify({
            code: 'US.AAPL',
            data: [
              {
                code: 'US.AAPL260515C240000',
                option_type: 'CALL',
                strike_price: 240,
                strike_time: '2026-05-15',
                last_price: 10.6,
                delta: 0.33,
                gamma: 0.02,
                theta: -0.08
              }
            ]
          })
        ].join('\n')
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: [
            {
              code: 'US.AAPL260515C240000',
              last_price: 10.9,
              bid_price: 10.8,
              ask_price: 11.0,
              option_theta: -0.06,
              option_delta: 0.35,
              option_gamma: 0.021
            }
          ]
        })
      });

    const quote = await fetchMoomooOptionQuote('AAPL', '2026-05-15', 240, 'call', { execFileImpl });

    expect(quote).toEqual({
      price: 10.9,
      theta: -0.06,
      delta: 0.35,
      gamma: 0.021,
      source: 'Moomoo snapshot'
    });
    expect(execFileImpl).toHaveBeenCalledTimes(2);
  });

  it('falls back to chain pricing when snapshot fails', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          code: 'US.AAPL',
          data: [
            {
              code: 'US.AAPL260515P240000',
              option_type: 'PUT',
              strike_price: 240,
              strike_time: '2026-05-15',
              bid_price: 8.1,
              ask_price: 8.5
            }
          ]
        })
      })
      .mockRejectedValueOnce(new Error('snapshot unavailable'));

    const quote = await fetchMoomooOptionQuote('AAPL', '2026-05-15', 240, 'put', { execFileImpl });

    expect(quote).toEqual({
      price: 8.3,
      theta: null,
      delta: null,
      gamma: null,
      source: 'Moomoo option chain'
    });
  });

  it('adds the US market prefix for aliased tickers like BRKB before calling moomoo', async () => {
    const execFileImpl = vi
      .fn()
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          code: 'US.BRK.B',
          data: [
            {
              code: 'US.BRK.B260424P470000',
              option_type: 'PUT',
              strike_price: 470,
              strike_time: '2026-04-24',
              bid_price: 4.5,
              ask_price: 4.7
            }
          ]
        })
      })
      .mockRejectedValueOnce(new Error('snapshot unavailable'));

    await fetchMoomooOptionQuote('BRKB', '2026-04-24', 470, 'put', { execFileImpl });

    expect(execFileImpl).toHaveBeenCalledWith(
      'python3',
      expect.arrayContaining([
        expect.stringContaining('get_option_chain.py'),
        'US.BRK.B',
        '--start',
        '2026-04-24',
        '--end',
        '2026-04-24',
        '--json'
      ]),
      expect.any(Object)
    );
  });
});
