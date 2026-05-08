import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./moomooOptionQuotes.mjs', () => ({
  fetchMoomooOptionQuote: vi.fn()
}));

async function importFresh(modulePath) {
  return import(`${modulePath}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function createRequest(method, url, headers = {}) {
  const stream = Readable.from([]);
  stream.method = method;
  stream.url = url;
  stream.headers = { host: 'localhost', ...headers };
  return stream;
}

function createResponseCapture() {
  return {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk = '') {
      this.body += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    }
  };
}

describe('/api/option-price integration', () => {
  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('returns a moomoo-backed option quote through the HTTP handler', async () => {
    const { fetchMoomooOptionQuote } = await import('./moomooOptionQuotes.mjs');
    fetchMoomooOptionQuote.mockResolvedValueOnce({
      price: 10.9,
      theta: -0.08,
      delta: 0.33,
      gamma: 0.02,
      source: 'Moomoo snapshot'
    });

    const { handleApiRequest } = await importFresh('./server.mjs');
    const req = createRequest(
      'GET',
      '/api/option-price?symbol=AAPL&expiration_date=2026-05-15&strike=240&side=call'
    );
    const res = createResponseCapture();

    await handleApiRequest(req, res);

    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({
      symbol: 'AAPL',
      expiration_date: '2026-05-15',
      strike: 240,
      side: 'call',
      option_price_per_share: 10.9,
      theta_per_share: -0.08,
      delta: 0.33,
      gamma: 0.02,
      source: 'Moomoo snapshot'
    });
    expect(fetchMoomooOptionQuote).toHaveBeenCalledWith('AAPL', '2026-05-15', 240, 'call');
  });
});
