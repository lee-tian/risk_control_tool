import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as moomooOptionAnalysis from './moomooOptionAnalysis.mjs';

vi.mock('./moomooOptionAnalysis.mjs', () => ({
  fetchMoomooOptionChainSnapshot: vi.fn(),
  fetchRecommendedMoomooOptionPlan: vi.fn(),
  summarizeMoomooOptionChain: vi.fn()
}));

async function importFresh(modulePath) {
  return import(`${modulePath}?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function createJsonRequest(method, url, payload, headers = {}) {
  const body = payload == null ? '' : JSON.stringify(payload);
  const stream = Readable.from(body === '' ? [] : [Buffer.from(body)]);
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

describe('/api/pre-trade-analysis integration', () => {
  beforeEach(() => {
    process.env.GEMINI_API_KEY = 'test-gemini-key';
    process.env.OPENAI_API_KEY = 'test-openai-key';
    process.env.OPENAI_PRETRADE_MODEL = 'gpt-4.1-mini';
  });

  afterEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    delete process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_PRETRADE_MODEL;
  });

  it('returns a moomoo-backed trade analysis through the HTTP handler', async () => {
    vi.mocked(moomooOptionAnalysis.fetchRecommendedMoomooOptionPlan).mockResolvedValue({
      expirationDate: '2026-05-15',
      dte: 37,
      snapshot: {
        underlying: 'US.AAPL',
        expirationDate: '2026-05-15',
        rows: [{ code: 'US.AAPL260515P200000' }]
      },
      klineSnapshot: {
        underlying: 'US.AAPL',
        endDate: '2026-04-08',
        rows: [{ close: 223.5 }]
      },
      summary: {
        supportCluster: { strike: 200, openInterest: 42000 },
        resistanceCluster: { strike: 240, openInterest: 51000 },
        klineLevels: {
          asOf: '2026-04-08',
          nearestSupport: { price: 202, source: '20D low + swing low', strength: 4 },
          nearestResistance: { price: 240, source: '20D high', strength: 3 }
        },
        recommendedCandidate: {
          code: 'US.AAPL260515P200000',
          side: 'put',
          strike: 200,
          price: 3.2,
          delta: -0.12,
          deltaAbs: 0.12,
          distancePct: 10.51,
          outsideLevel: true,
          levelDistancePct: 1,
          selectionBasis: ['Delta 0.12', '位于支撑外侧'],
          openInterest: 42000,
          volume: 1200,
          bid: 3.1,
          ask: 3.25,
          spreadPct: 4.76,
          impliedVolatility: 31.2
        },
        candidates: [
          {
            code: 'US.AAPL260515P200000',
            side: 'put',
            strike: 200,
            price: 3.2,
            delta: -0.12,
            openInterest: 42000,
            volume: 1200,
            bid: 3.1,
            ask: 3.25,
            spreadPct: 4.76,
            impliedVolatility: 31.2
          }
        ],
        warnings: ['该合约买卖价差约 4.76%，偏宽。']
      }
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (resource) => {
        const url = typeof resource === 'string' ? resource : resource.toString();

        if (url.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          verdict: '可以卖',
                          summary: '支撑和 Delta 候选都比较友好',
                          recommended_expiration: '2026-05-15',
                          recommended_dte: '37',
                          premium_view: 'IV Rank 中性偏高，权利金可接受',
                          support_level: '202.00 (20D low + swing low, 强度 4.0)',
                          resistance_level: '240.00 (20D high, 强度 3.0)',
                          recommended_strike: '200',
                          recommended_premium: '3.20',
                          recommended_distance: '+10.51%',
                          recommendation_reason: '低于支撑位附近的 Put 更稳健',
                          candidate_focus: 'US.AAPL260515P200000',
                          trade_action: '优先考虑 200 Put',
                          key_risks: ['财报日接近'],
                          warnings: []
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('VIX_History.csv')) {
          return new Response('DATE,OPEN,HIGH,LOW,CLOSE\n2026-04-07,20,21,19,20.55\n', { status: 200 });
        }

        if (url.includes('VXN_History.csv')) {
          return new Response('DATE,OPEN,HIGH,LOW,CLOSE\n2026-04-07,24,25,23,24.80\n', { status: 200 });
        }

        return new Response('upstream unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
    );

    const { handleApiRequest } = await importFresh('./server.mjs');
    const req = createJsonRequest('POST', '/api/pre-trade-analysis', {
      ticker: 'AAPL',
      option_side: 'put',
      date_sold: '2026-04-08',
      current_price: '223.50',
      user_rationale: '如果跌破支撑位就不做'
    });
    const res = createResponseCapture();

    await handleApiRequest(req, res);

    expect(res.statusCode, res.body).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.analysis).toMatchObject({
      verdict: '可以卖',
      recommended_expiration: '2026-05-15',
      support_level: '202.00 (20D low + swing low, 强度 4.0)',
      recommended_strike: '200',
      trade_action: '优先考虑 200 Put'
    });
    expect(payload.analysis.kline_rationale).toContain('日K支撑 202.00');
    expect(payload.analysis.kline_rationale).toContain('位于关键位外侧');
    expect(payload.option_chain).toMatchObject({
      underlying: 'US.AAPL',
      expiration_date: '2026-05-15',
      technical_support: { price: 202, source: '20D low + swing low', strength: 4 },
      kline_as_of: '2026-04-08'
    });
    expect(payload.market_context).toMatchObject({
      current_price: 223.5,
      vix: { value: 20.55, asOf: '2026-04-07' },
      vxn: { value: 24.8, asOf: '2026-04-07' }
    });
    expect(payload.source).toBe('Gemini 2.5 Flash + moomoo option snapshots + historical kline');
  });

  it('sanitizes put analysis when Gemini drifts into call-side reasoning', async () => {
    vi.mocked(moomooOptionAnalysis.fetchRecommendedMoomooOptionPlan).mockResolvedValue({
      expirationDate: '2026-05-15',
      dte: 37,
      snapshot: {
        underlying: 'US.AAPL',
        expirationDate: '2026-05-15',
        rows: [{ code: 'US.AAPL260515P200000' }]
      },
      klineSnapshot: {
        underlying: 'US.AAPL',
        endDate: '2026-04-08',
        rows: [{ close: 223.5 }]
      },
      summary: {
        supportCluster: { strike: 200, openInterest: 42000 },
        resistanceCluster: { strike: 240, openInterest: 51000 },
        klineLevels: {
          asOf: '2026-04-08',
          nearestSupport: { price: 202, source: '20D low', label: '20D low' },
          nearestResistance: { price: 240, source: '20D high', label: '20D high' }
        },
        recommendedCandidate: {
          code: 'US.AAPL260515P200000',
          side: 'put',
          strike: 200,
          price: 3.2,
          delta: -0.12,
          openInterest: 42000,
          volume: 1200,
          bid: 3.1,
          ask: 3.25,
          spreadPct: 4.76,
          impliedVolatility: 31.2
        },
        candidates: [
          {
            code: 'US.AAPL260515P200000',
            side: 'put',
            strike: 200,
            price: 3.2,
            delta: -0.12,
            openInterest: 42000,
            volume: 1200,
            bid: 3.1,
            ask: 3.25,
            spreadPct: 4.76,
            impliedVolatility: 31.2
          }
        ],
        warnings: []
      }
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (resource) => {
        const url = typeof resource === 'string' ? resource : resource.toString();

        if (url.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          verdict: '需要谨慎',
                          summary: '计划行权价240低于强支撑250，且位于Call OI峰值，风险较高，需要谨慎。',
                          recommended_expiration: '2026-05-15',
                          recommended_dte: '37',
                          premium_view: 'IV 尚可',
                          support_level: '200.00 (OI 42000)',
                          resistance_level: '240.00 (OI 51000)',
                          recommended_strike: '200',
                          recommended_premium: '3.20',
                          recommended_distance: '+10.51%',
                          recommendation_reason: '位于压力位更安全，优先看 Call OI 峰值。',
                          candidate_focus: 'US.AAPL260515C240000',
                          trade_action: '优先考虑 240 Call',
                          key_risks: ['财报日接近'],
                          warnings: ['Call OI 峰值附近波动更大']
                        })
                      }
                    ]
                  }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('VIX_History.csv')) {
          return new Response('DATE,OPEN,HIGH,LOW,CLOSE\n2026-04-07,20,21,19,20.55\n', { status: 200 });
        }

        if (url.includes('VXN_History.csv')) {
          return new Response('DATE,OPEN,HIGH,LOW,CLOSE\n2026-04-07,24,25,23,24.80\n', { status: 200 });
        }

        return new Response('upstream unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
    );

    const { handleApiRequest } = await importFresh('./server.mjs');
    const req = createJsonRequest('POST', '/api/pre-trade-analysis', {
      ticker: 'AAPL',
      option_side: 'put',
      date_sold: '2026-04-08',
      current_price: '223.50',
      user_rationale: '只做 Sell Put'
    });
    const res = createResponseCapture();

    await handleApiRequest(req, res);

    expect(res.statusCode, res.body).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.analysis.summary).toBe('请结合 45 DTE、日K支撑位外侧与 put 候选再确认。');
    expect(payload.analysis.recommendation_reason).toBe(
      '请优先选择 35-60 DTE 内最接近 45 天、位于日K支撑位外侧且更远 OTM 的 put 合约。'
    );
    expect(payload.analysis.candidate_focus).toBe('US.AAPL260515P200000 是当前更贴近 Put 侧筛选条件的候选。');
    expect(payload.analysis.trade_action).toBe('优先考虑更低行权价、位于支撑位外侧的 Put。');
    expect(payload.analysis.warnings).not.toContain('Call OI 峰值附近波动更大');
  });

  it('falls back to OpenAI when Gemini is rate limited', async () => {
    vi.mocked(moomooOptionAnalysis.fetchRecommendedMoomooOptionPlan).mockResolvedValue({
      expirationDate: '2026-05-15',
      dte: 37,
      snapshot: {
        underlying: 'US.TSLA',
        expirationDate: '2026-05-15',
        rows: [{ code: 'US.TSLA260515P240000' }]
      },
      klineSnapshot: {
        underlying: 'US.TSLA',
        endDate: '2026-04-09',
        rows: [{ close: 270 }]
      },
      summary: {
        supportCluster: { strike: 240, openInterest: 39000 },
        resistanceCluster: { strike: 310, openInterest: 44000 },
        klineLevels: {
          asOf: '2026-04-09',
          nearestSupport: { price: 245, source: '20D low', label: '20D low' },
          nearestResistance: { price: 310, source: '20D high', label: '20D high' }
        },
        recommendedCandidate: {
          code: 'US.TSLA260515P240000',
          side: 'put',
          strike: 240,
          price: 5.1,
          delta: -0.14,
          openInterest: 39000,
          volume: 1800,
          bid: 5.0,
          ask: 5.15,
          spreadPct: 3.0,
          impliedVolatility: 47.3
        },
        candidates: [
          {
            code: 'US.TSLA260515P240000',
            side: 'put',
            strike: 240,
            price: 5.1,
            delta: -0.14,
            openInterest: 39000,
            volume: 1800,
            bid: 5.0,
            ask: 5.15,
            spreadPct: 3.0,
            impliedVolatility: 47.3
          }
        ],
        warnings: []
      }
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (resource) => {
        const url = typeof resource === 'string' ? resource : resource.toString();

        if (url.includes('generativelanguage.googleapis.com')) {
          return new Response(
            JSON.stringify({
              error: {
                message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.'
              }
            }),
            { status: 429, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('api.openai.com/v1/chat/completions')) {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      verdict: '可以卖',
                      summary: 'Put 支撑和 Delta 候选匹配度较好',
                      recommended_expiration: '2026-05-15',
                      recommended_dte: '37',
                      premium_view: 'IV 中性偏高，权利金尚可',
                      support_level: '245.00 (20D low)',
                      resistance_level: '310.00 (20D high)',
                      recommended_strike: '240',
                      recommended_premium: '5.10',
                      recommended_distance: '+11.2%',
                      recommendation_reason: '优先选择支撑位下方且 Delta 0.10-0.20 的 Put',
                      candidate_focus: 'US.TSLA260515P240000',
                      trade_action: '优先考虑 240 Put',
                      key_risks: ['财报临近可能放大波动'],
                      warnings: []
                    })
                  }
                }
              ]
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          );
        }

        if (url.includes('VIX_History.csv')) {
          return new Response('DATE,OPEN,HIGH,LOW,CLOSE\n2026-04-07,20,21,19,20.55\n', { status: 200 });
        }

        if (url.includes('VXN_History.csv')) {
          return new Response('DATE,OPEN,HIGH,LOW,CLOSE\n2026-04-07,24,25,23,24.80\n', { status: 200 });
        }

        return new Response('upstream unavailable', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      })
    );

    const { handleApiRequest } = await importFresh('./server.mjs');
    const req = createJsonRequest('POST', '/api/pre-trade-analysis', {
      ticker: 'TSLA',
      option_side: 'put',
      date_sold: '2026-04-09'
    });
    const res = createResponseCapture();

    await handleApiRequest(req, res);

    expect(res.statusCode, res.body).toBe(200);
    const payload = JSON.parse(res.body);
    expect(payload.analysis).toMatchObject({
      verdict: '可以卖',
      recommended_strike: '240',
      trade_action: '优先考虑 240 Put'
    });
    expect(payload.source).toBe('OpenAI gpt-4.1-mini + moomoo option snapshots + historical kline');
  });
});
