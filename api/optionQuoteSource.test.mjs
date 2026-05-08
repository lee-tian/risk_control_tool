import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./moomooOptionQuotes.mjs', () => ({
  fetchMoomooOptionQuote: vi.fn()
}));

function createHeaders({ setCookie = [], values = {} } = {}) {
  return {
    get(name) {
      return values[name.toLowerCase()] ?? null;
    },
    getSetCookie() {
      return setCookie;
    }
  };
}

function createResponse(body, { status = 200, setCookie = [], headers = {} } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: createHeaders({ setCookie, values: headers }),
    async text() {
      return text;
    }
  };
}

describe('fetchCurrentOptionQuote', () => {
  afterEach(() => {
    delete process.env.MARKETDATA_TOKEN;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('prefers the Barchart webpage-backed option quote before falling back', async () => {
    const { fetchMoomooOptionQuote } = await import('./moomooOptionQuotes.mjs');
    fetchMoomooOptionQuote.mockRejectedValueOnce(new Error('moomoo unavailable'));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        createResponse('<script id="bc-dynamic-config">{"currentSymbol":{"raw":{"symbol":"AAPL"}}}</script>', {
          setCookie: ['laravel_session=session123; Path=/', 'XSRF-TOKEN=test-token; Path=/']
        })
      )
      .mockResolvedValueOnce(
        createResponse({
          data: [
            {
              optionType: 'Call',
              strikePrice: 210,
              expirationDate: '2026-06-19',
              lastPrice: 2.25,
              delta: 0.31,
              gamma: 0.018,
              theta: -0.07,
              tradeTime: '11:22 ET'
            }
          ]
        })
      );

    vi.stubGlobal('fetch', fetchMock);
    const { fetchCurrentOptionQuote } = await import('./server.mjs');
    const quote = await fetchCurrentOptionQuote('AAPL', '2026-06-19', 210, 'call');

    expect(quote).toEqual({
      price: 2.25,
      theta: -0.07,
      delta: 0.31,
      gamma: 0.018,
      asOf: '11:22 ET',
      source: 'Barchart options/get'
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/proxies/core-api/v1/options/get');
  });

  it('falls back to MarketData when the Barchart option quote request fails', async () => {
    process.env.MARKETDATA_TOKEN = 'test-token';
    const { fetchMoomooOptionQuote } = await import('./moomooOptionQuotes.mjs');
    fetchMoomooOptionQuote.mockRejectedValueOnce(new Error('moomoo unavailable'));

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createResponse('<html>blocked</html>', { status: 500 }))
      .mockResolvedValueOnce(
        createResponse({
          mid: [2.4],
          bid: [2.3],
          ask: [2.5],
          theta: [-0.08],
          delta: [0.31],
          gamma: [0.014]
        })
      );

    vi.stubGlobal('fetch', fetchMock);
    const { fetchCurrentOptionQuote } = await import('./server.mjs');
    const quote = await fetchCurrentOptionQuote('AAPL', '2026-06-19', 210, 'call');

    expect(quote).toEqual({
      price: 2.4,
      theta: -0.08,
      delta: 0.31,
      gamma: 0.014,
      source: 'MarketData.app /options/quotes'
    });
    expect(String(fetchMock.mock.calls[1][0])).toContain('/v1/options/quotes/');
  });

  it('uses Moomoo before any web fallback when it returns a quote', async () => {
    const { fetchMoomooOptionQuote } = await import('./moomooOptionQuotes.mjs');
    fetchMoomooOptionQuote.mockResolvedValueOnce({
      price: 3.15,
      theta: -0.05,
      delta: 0.29,
      gamma: 0.01,
      source: 'Moomoo snapshot'
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { fetchCurrentOptionQuote } = await import('./server.mjs');
    const quote = await fetchCurrentOptionQuote('AAPL', '2026-06-19', 210, 'call');

    expect(quote).toEqual({
      price: 3.15,
      theta: -0.05,
      delta: 0.29,
      gamma: 0.01,
      source: 'Moomoo snapshot'
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
