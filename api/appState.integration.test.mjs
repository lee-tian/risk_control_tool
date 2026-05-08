import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyOptionCloseCash, applyStockBuyCash, applyStockSellCash } from '../src/lib/cashFlows.ts';
import { closeOpenPosition, deleteOpenPositionAndPruneTicker, upsertPutPosition } from '../src/lib/putWorkflow.ts';
import { applyQuoteRefreshToTickerList } from '../src/lib/quoteRefresh.ts';
import { addTickerEntry, buyTickerShares, removeTickerEntry, sellTickerShares } from '../src/lib/tickerWorkflow.ts';

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

function parseResponseJson(response) {
  return JSON.parse(response.body);
}

function expectSqliteSaveResponse(response, expectedSaveMode = 'replace') {
  expect(response.statusCode, response.body).toBe(200);
  const payload = parseResponseJson(response);
  expect(payload).toMatchObject({
    ok: true,
    save_mode: expectedSaveMode,
    storage: {
      driver: 'sqlite',
      appStateTarget: 'kv_store:app-state'
    }
  });
  return payload;
}

function readPersistedAppStateFromSqlite(dataDir) {
  const dbPath = path.join(dataDir, 'risk-tool.sqlite');
  const db = new DatabaseSync(dbPath);
  try {
    const row = db.prepare('SELECT value FROM kv_store WHERE key = ?').get('app-state');
    return row?.value ? JSON.parse(row.value) : null;
  } finally {
    db.close();
  }
}

function expectPersistedSnapshotToMatchGet(dataDir, getResponse) {
  const getPayload = parseResponseJson(getResponse);
  expect(readPersistedAppStateFromSqlite(dataDir)).toEqual(getPayload.snapshot);
  return getPayload;
}

async function expectOptionAddDeleteFlow({
  handleApiRequest,
  dataDir,
  baseSnapshot,
  openPosition,
  addedAt,
  deletedAt
}) {
  const addSnapshot = {
    ...baseSnapshot,
    exported_at: addedAt,
    data: {
      ...baseSnapshot.data,
      puts: upsertPutPosition(baseSnapshot.data.puts, openPosition, null, () => openPosition.id)
    }
  };

  const addReq = createJsonRequest('POST', '/api/app-state', addSnapshot, {
    'x-app-state-save-mode': 'replace'
  });
  const addRes = createResponseCapture();
  await handleApiRequest(addReq, addRes);
  expectSqliteSaveResponse(addRes);

  const afterAddReq = createJsonRequest('GET', '/api/app-state');
  const afterAddRes = createResponseCapture();
  await handleApiRequest(afterAddReq, afterAddRes);
  expect(afterAddRes.statusCode).toBe(200);

  const afterAddPayload = expectPersistedSnapshotToMatchGet(dataDir, afterAddRes);
  expect(afterAddPayload.snapshot.data.puts).toEqual([
    expect.objectContaining({
      id: openPosition.id,
      ticker: openPosition.ticker,
      contracts: openPosition.contracts,
      put_strike: openPosition.put_strike
    })
  ]);
  expect(afterAddPayload.snapshot.data.tickerList).toEqual([
    expect.objectContaining({
      ticker: openPosition.ticker
    })
  ]);

  const deleteResult = deleteOpenPositionAndPruneTicker(
    afterAddPayload.snapshot.data.puts,
    afterAddPayload.snapshot.data.tickerList,
    openPosition.id
  );
  const deleteSnapshot = {
    ...afterAddPayload.snapshot,
    exported_at: deletedAt,
    data: {
      ...afterAddPayload.snapshot.data,
      puts: deleteResult.nextPuts,
      tickerList: deleteResult.nextTickerList
    }
  };

  const deleteReq = createJsonRequest('POST', '/api/app-state', deleteSnapshot, {
    'x-app-state-save-mode': 'replace',
    'x-app-state-allow-destructive': 'true'
  });
  const deleteRes = createResponseCapture();
  await handleApiRequest(deleteReq, deleteRes);
  expectSqliteSaveResponse(deleteRes);

  const finalGetReq = createJsonRequest('GET', '/api/app-state');
  const finalGetRes = createResponseCapture();
  await handleApiRequest(finalGetReq, finalGetRes);
  expect(finalGetRes.statusCode).toBe(200);

  const finalPayload = expectPersistedSnapshotToMatchGet(dataDir, finalGetRes);
  expect(finalPayload.snapshot.data.puts).toEqual([]);
  expect(finalPayload.snapshot.data.tickerList).toEqual([]);
}

describe('/api/app-state integration', () => {
  let tempDir = '';

  afterEach(async () => {
    vi.resetModules();
    delete process.env.APP_DATA_DIR;
    if (tempDir !== '') {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('persists refreshed option greeks and returns them after a reload', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-app-state-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest, refreshAppStateSnapshot } = await importFresh('./server.mjs');

    const refreshed = await refreshAppStateSnapshot(
      {
        version: 1,
        exported_at: '2026-04-06T00:00:00.000Z',
        data: {
          config: null,
          closedTrades: [],
          stockTrades: [],
          scenario: null,
          vixHistory: [],
          accountValueHistory: [],
          tickerList: [],
          puts: [
            {
              id: 'put-1',
              ticker: 'AXP',
              option_side: 'put',
              put_strike: 280,
              premium_per_share: 4.5,
              contracts: 1,
              iv_rank: 0,
              date_sold: '2026-03-10',
              expiration_date: '2026-04-10',
              option_market_price_per_share: 1.295,
              option_market_price_updated: null,
              option_theta_per_share: null,
              option_delta: null,
              option_gamma: null
            }
          ]
        }
      },
      {
        now: new Date('2026-04-06T00:33:36.554Z'),
        force: true,
        fetchQuoteBundleFn: vi.fn(async () => ({
          quoteResult: { ok: false },
          rsiResult: { ok: false },
          rsi1hResult: { ok: false },
          ma21Result: { ok: false },
          ma200Result: { ok: false },
          currentIvResult: { ok: false },
          marketMetricsResult: { ok: false }
        })),
        fetchCurrentOptionQuoteFn: vi.fn(async () => ({
          price: 1.295,
          theta: -0.2273,
          delta: -0.1256,
          gamma: 0.0103
        })),
        refreshVixFn: vi.fn(async () => ({ value: 24.9 })),
        sleepFn: vi.fn(async () => {})
      }
    );

    const postReq = createJsonRequest('POST', '/api/app-state', refreshed.snapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const postRes = createResponseCapture();
    await handleApiRequest(postReq, postRes);

    expectSqliteSaveResponse(postRes);

    const getReq = createJsonRequest('GET', '/api/app-state');
    const getRes = createResponseCapture();
    await handleApiRequest(getReq, getRes);

    expect(getRes.statusCode).toBe(200);
    const payload = expectPersistedSnapshotToMatchGet(tempDir, getRes);
    expect(payload.snapshot.data.puts[0]).toMatchObject({
      ticker: 'AXP',
      option_market_price_per_share: 1.295,
      option_theta_per_share: -0.2273,
      option_delta: -0.1256,
      option_gamma: 0.0103
    });
  });

  it('persists stock buy, stock sell, and final ticker deletion into sqlite', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-stock-flow-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T01:00:00.000Z',
      data: {
        config: {
          cash: 100000,
          risk_limit_pct: 0.2,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [],
        stockTrades: [],
        tickerList: [],
        scenario: null,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const addedTickerList = addTickerEntry(baseSnapshot.data.tickerList, {
      ticker: 'AAPL',
      beta: '0.87',
      shares: '',
      averageCostBasis: '',
      downsideTolerancePct: '',
      providerExchange: '',
      providerMicCode: ''
    });

    const addTickerSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T01:01:00.000Z',
      data: {
        ...baseSnapshot.data,
        tickerList: addedTickerList
      }
    };

    const addReq = createJsonRequest('POST', '/api/app-state', addTickerSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const addRes = createResponseCapture();
    await handleApiRequest(addReq, addRes);
    expectSqliteSaveResponse(addRes);

    const bought = buyTickerShares(addedTickerList, 'AAPL', 100, 200);
    expect(bought).not.toBeNull();
    const afterBuyConfig = applyStockBuyCash(addTickerSnapshot.data.config, addTickerSnapshot.data.config, bought.cost);
    const buySnapshot = {
      ...addTickerSnapshot,
      exported_at: '2026-04-06T01:02:00.000Z',
      data: {
        ...addTickerSnapshot.data,
        config: afterBuyConfig,
        tickerList: bought.nextEntries,
        stockTrades: [
          {
            id: 'buy-1',
            ticker: 'AAPL',
            action: 'buy',
            shares: 100,
            price_per_share: 200,
            traded_at: '2026-04-06',
            cash_change: -bought.cost,
            realized_pnl: 0
          }
        ]
      }
    };

    const buyReq = createJsonRequest('POST', '/api/app-state', buySnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const buyRes = createResponseCapture();
    await handleApiRequest(buyReq, buyRes);
    expectSqliteSaveResponse(buyRes);

    const afterBuyGetReq = createJsonRequest('GET', '/api/app-state');
    const afterBuyGetRes = createResponseCapture();
    await handleApiRequest(afterBuyGetReq, afterBuyGetRes);
    const afterBuyPayload = expectPersistedSnapshotToMatchGet(tempDir, afterBuyGetRes);
    expect(afterBuyPayload.snapshot.data.config.cash).toBe(80000);
    expect(afterBuyPayload.snapshot.data.tickerList[0]).toMatchObject({
      ticker: 'AAPL',
      shares: 100,
      average_cost_basis: 200
    });
    const sold = sellTickerShares(bought.nextEntries, 'AAPL', 100, 200);
    expect(sold).not.toBeNull();
    const afterSellConfig = applyStockSellCash(afterBuyConfig, afterBuyConfig, sold.proceeds);
    const sellSnapshot = {
      ...buySnapshot,
      exported_at: '2026-04-06T01:03:00.000Z',
      data: {
        ...buySnapshot.data,
        config: afterSellConfig,
        tickerList: sold.nextEntries,
        stockTrades: [
          {
            id: 'sell-1',
            ticker: 'AAPL',
            action: 'sell',
            shares: 100,
            price_per_share: 200,
            traded_at: '2026-04-06',
            cash_change: sold.proceeds,
            realized_pnl: 0
          },
          ...buySnapshot.data.stockTrades
        ]
      }
    };

    const sellReq = createJsonRequest('POST', '/api/app-state', sellSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const sellRes = createResponseCapture();
    await handleApiRequest(sellReq, sellRes);
    expectSqliteSaveResponse(sellRes);

    const afterSellGetReq = createJsonRequest('GET', '/api/app-state');
    const afterSellGetRes = createResponseCapture();
    await handleApiRequest(afterSellGetReq, afterSellGetRes);
    const afterSellPayload = expectPersistedSnapshotToMatchGet(tempDir, afterSellGetRes);
    expect(afterSellPayload.snapshot.data.config.cash).toBe(100000);
    expect(afterSellPayload.snapshot.data.tickerList[0]).toMatchObject({
      ticker: 'AAPL',
      shares: 0
    });
    const deleteSnapshot = {
      ...sellSnapshot,
      exported_at: '2026-04-06T01:04:00.000Z',
      data: {
        ...sellSnapshot.data,
        tickerList: removeTickerEntry(sold.nextEntries, 'AAPL')
      }
    };

    const deleteReq = createJsonRequest('POST', '/api/app-state', deleteSnapshot, {
      'x-app-state-save-mode': 'replace',
      'x-app-state-allow-destructive': 'true'
    });
    const deleteRes = createResponseCapture();
    await handleApiRequest(deleteReq, deleteRes);
    expectSqliteSaveResponse(deleteRes);

    const finalGetReq = createJsonRequest('GET', '/api/app-state');
    const finalGetRes = createResponseCapture();
    await handleApiRequest(finalGetReq, finalGetRes);
    const finalPayload = expectPersistedSnapshotToMatchGet(tempDir, finalGetRes);
    expect(finalPayload.snapshot.data.config.cash).toBe(100000);
    expect(finalPayload.snapshot.data.tickerList).toEqual([]);
    expect(finalPayload.snapshot.data.stockTrades).toHaveLength(2);
  });

  it('persists refreshed ticker market data after a successful write', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-ticker-refresh-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseTickerList = addTickerEntry([], {
      ticker: 'TSLA',
      beta: '1.92',
      shares: '',
      averageCostBasis: '',
      downsideTolerancePct: '',
      providerExchange: '',
      providerMicCode: ''
    });

    const refreshedTickerList = applyQuoteRefreshToTickerList(
      baseTickerList,
      {
        quotes: { TSLA: 255.92 },
        currentIv: { TSLA: 0.285 },
        historicalIv: { TSLA: 0.209 },
        ivRank: { TSLA: 23.4 },
        ivPercentile: { TSLA: 48.6 },
        nextEarningsDate: { TSLA: '2026-05-07' },
        as_of: '2026-04-06T05:45:00.000Z'
      },
      ['TSLA']
    );

    const snapshot = {
      version: 1,
      exported_at: '2026-04-06T05:45:10.000Z',
      data: {
        config: {
          cash: 100000,
          risk_limit_pct: 0.2,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [],
        stockTrades: [],
        tickerList: refreshedTickerList,
        scenario: null,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const postReq = createJsonRequest('POST', '/api/app-state', snapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const postRes = createResponseCapture();
    await handleApiRequest(postReq, postRes);
    expectSqliteSaveResponse(postRes);

    const getReq = createJsonRequest('GET', '/api/app-state');
    const getRes = createResponseCapture();
    await handleApiRequest(getReq, getRes);
    expect(getRes.statusCode).toBe(200);

    const payload = expectPersistedSnapshotToMatchGet(tempDir, getRes);
    expect(payload.snapshot.data.tickerList[0]).toMatchObject({
      ticker: 'TSLA',
      current_price: 255.92,
      last_updated: '2026-04-06T05:45:00.000Z',
      current_iv: 0.285,
      current_iv_updated: '2026-04-06T05:45:00.000Z',
      historical_iv: 0.209,
      iv_rank: 23.4,
      iv_percentile: 48.6,
      next_earnings_date: '2026-05-07'
    });
  });

  it('persists adding an option and then deleting that option', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-option-add-delete-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-07T18:00:00.000Z',
      data: {
        config: {
          cash: 100000,
          risk_limit_pct: 0.2,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [],
        stockTrades: [],
        tickerList: addTickerEntry([], {
          ticker: 'AAPL',
          beta: '',
          shares: '',
          averageCostBasis: '',
          downsideTolerancePct: '',
          providerExchange: '',
          providerMicCode: ''
        }),
        scenario: null,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const openPosition = {
      id: 'put-aapl-190',
      ticker: 'AAPL',
      option_side: 'put',
      put_strike: 190,
      premium_per_share: 2.35,
      contracts: 1,
      iv_rank: 24.8,
      date_sold: '2026-04-07',
      expiration_date: '2026-05-15',
      option_market_price_per_share: 2.1,
      option_market_price_updated: '2026-04-07T18:00:00.000Z',
      option_theta_per_share: -0.081,
      option_delta: -0.24,
      option_gamma: 0.018
    };

    await expectOptionAddDeleteFlow({
      handleApiRequest,
      dataDir: tempDir,
      baseSnapshot,
      openPosition,
      addedAt: '2026-04-07T18:01:00.000Z',
      deletedAt: '2026-04-07T18:02:00.000Z'
    });
  });

  it('persists a covered call write into sqlite and returns it after reload', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-covered-call-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const snapshot = {
      version: 1,
      exported_at: '2026-04-09T00:36:00.000Z',
      data: {
        config: {
          cash: 621610.36,
          risk_limit_pct: 0.04,
          warning_threshold_pct: 0.8
        },
        puts: [
          {
            id: 'googl-call-325',
            ticker: 'GOOGL',
            option_side: 'call',
            put_strike: 325,
            premium_per_share: 15.74,
            contracts: 2,
            iv_rank: 0,
            date_sold: '2026-04-08',
            expiration_date: '2026-06-18',
            option_market_price_per_share: null,
            option_market_price_updated: null,
            option_theta_per_share: null,
            option_delta: null,
            option_gamma: null
          }
        ],
        closedTrades: [],
        stockTrades: [],
        tickerList: [
          {
            ticker: 'GOOGL',
            beta: 0.72,
            shares: 200,
            average_cost_basis: 315,
            downside_tolerance_pct: 0.2,
            current_price: 317.32,
            last_updated: '2026-04-09T00:34:57.452Z',
            next_earnings_date: null,
            current_iv: 0.3505,
            current_iv_updated: '2026-04-09T00:34:57.452Z',
            historical_iv: 0.2947,
            iv_rank: 34.14,
            iv_percentile: 72,
            put_call_ratio: 0.8,
            put_call_ratio_updated: '2026-04-07T18:29:21.830Z',
            provider_exchange: null,
            provider_mic_code: null,
            rsi_14: 61.99967356446242,
            rsi_14_1h: 68.32500892411255,
            rsi_updated: '2026-04-09T00:34:57.452Z',
            ma_21: 297.7314285714286,
            ma_200: 265.94339999999977
          }
        ],
        scenario: 0.1,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const postReq = createJsonRequest('POST', '/api/app-state', snapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const postRes = createResponseCapture();
    await handleApiRequest(postReq, postRes);
    expectSqliteSaveResponse(postRes);

    const getReq = createJsonRequest('GET', '/api/app-state');
    const getRes = createResponseCapture();
    await handleApiRequest(getReq, getRes);
    const payload = expectPersistedSnapshotToMatchGet(tempDir, getRes);

    expect(payload.snapshot.data.puts).toEqual([
      expect.objectContaining({
        id: 'googl-call-325',
        ticker: 'GOOGL',
        option_side: 'call',
        put_strike: 325,
        premium_per_share: 15.74,
        contracts: 2
      })
    ]);
    expect(payload.snapshot.data.tickerList).toEqual([
      expect.objectContaining({
        ticker: 'GOOGL',
        shares: 200,
        average_cost_basis: 315
      })
    ]);
  });

  it('persists a force-continued option save and then deleting that option', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-option-force-add-delete-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-07T21:12:20.000Z',
      data: {
        config: {
          cash: 100000,
          risk_limit_pct: 0.2,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [],
        stockTrades: [],
        tickerList: addTickerEntry([], {
          ticker: 'AAPL',
          beta: '0.87',
          shares: '',
          averageCostBasis: '',
          downsideTolerancePct: '',
          providerExchange: '',
          providerMicCode: ''
        }),
        scenario: null,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const openPosition = {
      id: 'put-aapl-240-force',
      ticker: 'AAPL',
      option_side: 'put',
      put_strike: 240,
      premium_per_share: 4.15,
      contracts: 1,
      iv_rank: 28.8,
      date_sold: '2026-04-07',
      expiration_date: '2026-05-22',
      option_market_price_per_share: 4.15,
      option_market_price_updated: '2026-04-07T21:12:20.000Z',
      option_theta_per_share: -0.115,
      option_delta: -0.29,
      option_gamma: 0.017
    };

    await expectOptionAddDeleteFlow({
      handleApiRequest,
      dataDir: tempDir,
      baseSnapshot,
      openPosition,
      addedAt: '2026-04-07T21:12:27.000Z',
      deletedAt: '2026-04-07T21:12:45.000Z'
    });
  });

  it('persists a closed option and can roll the snapshot back to restore the open position', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-close-rollback-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const openPosition = {
      id: 'put-axp-1',
      ticker: 'AXP',
      option_side: 'put',
      put_strike: 280,
      premium_per_share: 3.22,
      contracts: 2,
      iv_rank: 38.9,
      date_sold: '2026-03-17',
      expiration_date: '2026-04-10',
      option_market_price_per_share: 0.48,
      option_market_price_updated: '2026-04-06T18:30:00.000Z',
      option_theta_per_share: -0.0952,
      option_delta: -0.1105,
      option_gamma: 0.0239
    };

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T18:35:00.000Z',
      data: {
        config: {
          cash: 100000,
          risk_limit_pct: 0.2,
          warning_threshold_pct: 0.8
        },
        puts: [openPosition],
        closedTrades: [],
        stockTrades: [],
        tickerList: [
          {
            ticker: 'AXP',
            beta: 1.34,
            shares: null,
            average_cost_basis: null,
            downside_tolerance_pct: null,
            current_price: 303.23,
            last_updated: '2026-04-06T18:30:00.000Z',
            next_earnings_date: '2026-04-24',
            current_iv: 0.405,
            current_iv_updated: '2026-04-06T18:30:00.000Z',
            historical_iv: 0.321,
            iv_rank: 38.9,
            iv_percentile: 52.4,
            put_call_ratio: 0.53,
            put_call_ratio_updated: '2026-04-06T18:30:00.000Z',
            provider_exchange: null,
            provider_mic_code: null,
            rsi_14: 47.5,
            rsi_14_1h: 51.2,
            rsi_updated: '2026-04-06T18:30:00.000Z',
            ma_21: 301.11,
            ma_200: 309.88
          }
        ],
        scenario: 0.1,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const openReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const openRes = createResponseCapture();
    await handleApiRequest(openReq, openRes);
    expect(openRes.statusCode).toBe(200);

    const closeResult = closeOpenPosition(
      baseSnapshot.data.puts,
      baseSnapshot.data.closedTrades,
      openPosition,
      0.48,
      '2026-04-06',
      'take profit',
      () => 'closed-axp-1',
      2
    );
    const closedSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T18:36:00.000Z',
      data: {
        ...baseSnapshot.data,
        config: applyOptionCloseCash(baseSnapshot.data.config, baseSnapshot.data.config, 0.48, 2),
        puts: closeResult.nextPuts,
        closedTrades: closeResult.nextClosedTrades
      }
    };

    const closeReq = createJsonRequest('POST', '/api/app-state', closedSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const closeRes = createResponseCapture();
    await handleApiRequest(closeReq, closeRes);
    expect(closeRes.statusCode).toBe(200);

    const afterCloseReq = createJsonRequest('GET', '/api/app-state');
    const afterCloseRes = createResponseCapture();
    await handleApiRequest(afterCloseReq, afterCloseRes);
    const afterClosePayload = JSON.parse(afterCloseRes.body);
    expect(afterClosePayload.snapshot.data.puts).toEqual([]);
    expect(afterClosePayload.snapshot.data.closedTrades).toHaveLength(1);
    expect(afterClosePayload.snapshot.data.closedTrades[0]).toMatchObject({
      position_id: 'put-axp-1',
      ticker: 'AXP',
      contracts: 2,
      premium_bought_back_per_share: 0.48
    });
    expect(afterClosePayload.snapshot.data.config.cash).toBe(99904);

    const rollbackReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace',
      'x-app-state-allow-destructive': 'true'
    });
    const rollbackRes = createResponseCapture();
    await handleApiRequest(rollbackReq, rollbackRes);
    expect(rollbackRes.statusCode).toBe(200);

    const afterRollbackReq = createJsonRequest('GET', '/api/app-state');
    const afterRollbackRes = createResponseCapture();
    await handleApiRequest(afterRollbackReq, afterRollbackRes);
    const afterRollbackPayload = JSON.parse(afterRollbackRes.body);
    expect(afterRollbackPayload.snapshot.data.puts).toHaveLength(1);
    expect(afterRollbackPayload.snapshot.data.puts[0]).toMatchObject({
      id: 'put-axp-1',
      ticker: 'AXP',
      contracts: 2,
      option_market_price_per_share: 0.48
    });
    expect(afterRollbackPayload.snapshot.data.closedTrades).toEqual([]);
    expect(afterRollbackPayload.snapshot.data.config.cash).toBe(100000);
  });

  it('keeps a newly closed option when a later stale merge snapshot still contains the old open position', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-stale-merge-close-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const openPosition = {
      id: 'call-amzn-220',
      ticker: 'AMZN',
      option_side: 'call',
      put_strike: 220,
      premium_per_share: 3.22,
      contracts: 2,
      iv_rank: 38.9,
      date_sold: '2026-03-17',
      expiration_date: '2026-04-10',
      option_market_price_per_share: 0.48,
      option_market_price_updated: '2026-04-06T18:30:00.000Z',
      option_theta_per_share: -0.0952,
      option_delta: 0.1105,
      option_gamma: 0.0239
    };

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T18:35:00.000Z',
      data: {
        config: {
          cash: 100000,
          risk_limit_pct: 0.2,
          warning_threshold_pct: 0.8
        },
        puts: [openPosition],
        closedTrades: [],
        stockTrades: [],
        tickerList: [],
        scenario: 0.1,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const openReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const openRes = createResponseCapture();
    await handleApiRequest(openReq, openRes);
    expect(openRes.statusCode).toBe(200);

    const closeResult = closeOpenPosition(
      baseSnapshot.data.puts,
      baseSnapshot.data.closedTrades,
      openPosition,
      0.48,
      '2026-04-06',
      'take profit',
      () => 'closed-amzn-220',
      2
    );
    const closedSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T18:36:00.000Z',
      data: {
        ...baseSnapshot.data,
        config: applyOptionCloseCash(baseSnapshot.data.config, baseSnapshot.data.config, 0.48, 2),
        puts: closeResult.nextPuts,
        closedTrades: closeResult.nextClosedTrades
      }
    };

    const closeReq = createJsonRequest('POST', '/api/app-state', closedSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const closeRes = createResponseCapture();
    await handleApiRequest(closeReq, closeRes);
    expect(closeRes.statusCode).toBe(200);

    const staleMergeReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'merge'
    });
    const staleMergeRes = createResponseCapture();
    await handleApiRequest(staleMergeReq, staleMergeRes);
    expect(staleMergeRes.statusCode).toBe(200);

    const finalGetReq = createJsonRequest('GET', '/api/app-state');
    const finalGetRes = createResponseCapture();
    await handleApiRequest(finalGetReq, finalGetRes);
    const finalPayload = JSON.parse(finalGetRes.body);
    expect(finalPayload.snapshot.data.puts).toEqual([]);
    expect(finalPayload.snapshot.data.closedTrades).toEqual([
      expect.objectContaining({
        id: 'closed-amzn-220',
        position_id: 'call-amzn-220',
        ticker: 'AMZN',
        option_side: 'call',
        contracts: 2
      })
    ]);
  });

  it('persists option contract edits from 1 to 2 and then from 2 back to 1', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-option-edit-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const originalPosition = {
      id: 'put-nvda-145',
      ticker: 'NVDA',
      option_side: 'put',
      put_strike: 145,
      premium_per_share: 3.35,
      contracts: 1,
      iv_rank: 24.2,
      date_sold: '2026-04-01',
      expiration_date: '2026-05-15',
      option_market_price_per_share: 1.0,
      option_market_price_updated: '2026-04-07T05:00:00.000Z',
      option_theta_per_share: -0.0487,
      option_delta: -0.078,
      option_gamma: 0.0054
    };

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-07T05:01:00.000Z',
      data: {
        config: {
          cash: 100000,
          risk_limit_pct: 0.2,
          warning_threshold_pct: 0.8
        },
        puts: [originalPosition],
        closedTrades: [],
        stockTrades: [],
        tickerList: [
          {
            ticker: 'NVDA',
            beta: 2.17,
            shares: 300,
            average_cost_basis: 179.3,
            downside_tolerance_pct: null,
            current_price: 177.23,
            last_updated: '2026-04-07T05:00:00.000Z',
            next_earnings_date: '2026-05-28',
            current_iv: 0.374,
            current_iv_updated: '2026-04-07T05:00:00.000Z',
            historical_iv: 0.312,
            iv_rank: 24.2,
            iv_percentile: 52,
            put_call_ratio: 0.87,
            put_call_ratio_updated: '2026-04-07T05:00:00.000Z',
            provider_exchange: null,
            provider_mic_code: null,
            rsi_14: 47.6,
            rsi_14_1h: 53.2,
            rsi_updated: '2026-04-07T05:00:00.000Z',
            ma_21: 178.18,
            ma_200: 179.64
          }
        ],
        scenario: null,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const baseReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const baseRes = createResponseCapture();
    await handleApiRequest(baseReq, baseRes);
    expect(baseRes.statusCode).toBe(200);

    const updatedToTwoContracts = upsertPutPosition(
      baseSnapshot.data.puts,
      { ...originalPosition, contracts: 2 },
      originalPosition.id,
      () => 'ignored'
    );
    const updateToTwoSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-07T05:02:00.000Z',
      data: {
        ...baseSnapshot.data,
        puts: updatedToTwoContracts
      }
    };

    const updateToTwoReq = createJsonRequest('POST', '/api/app-state', updateToTwoSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const updateToTwoRes = createResponseCapture();
    await handleApiRequest(updateToTwoReq, updateToTwoRes);
    expect(updateToTwoRes.statusCode).toBe(200);

    const afterTwoReq = createJsonRequest('GET', '/api/app-state');
    const afterTwoRes = createResponseCapture();
    await handleApiRequest(afterTwoReq, afterTwoRes);
    const afterTwoPayload = JSON.parse(afterTwoRes.body);
    expect(afterTwoPayload.snapshot.data.puts).toHaveLength(1);
    expect(afterTwoPayload.snapshot.data.puts[0]).toMatchObject({
      id: originalPosition.id,
      ticker: 'NVDA',
      contracts: 2,
      put_strike: 145,
      option_theta_per_share: -0.0487,
      option_delta: -0.078,
      option_gamma: 0.0054
    });

    const updatedBackToOne = upsertPutPosition(
      afterTwoPayload.snapshot.data.puts,
      { ...originalPosition, contracts: 1 },
      originalPosition.id,
      () => 'ignored'
    );
    const updateBackSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-07T05:03:00.000Z',
      data: {
        ...afterTwoPayload.snapshot.data,
        puts: updatedBackToOne
      }
    };

    const updateBackReq = createJsonRequest('POST', '/api/app-state', updateBackSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const updateBackRes = createResponseCapture();
    await handleApiRequest(updateBackReq, updateBackRes);
    expect(updateBackRes.statusCode).toBe(200);

    const finalReq = createJsonRequest('GET', '/api/app-state');
    const finalRes = createResponseCapture();
    await handleApiRequest(finalReq, finalRes);
    const finalPayload = JSON.parse(finalRes.body);
    expect(finalPayload.snapshot.data.puts).toHaveLength(1);
    expect(finalPayload.snapshot.data.puts[0]).toMatchObject({
      id: originalPosition.id,
      ticker: 'NVDA',
      contracts: 1,
      put_strike: 145,
      option_market_price_per_share: 1.0,
      option_theta_per_share: -0.0487,
      option_delta: -0.078,
      option_gamma: 0.0054
    });
    expect(finalPayload.snapshot.data.closedTrades).toEqual([]);
    expect(finalPayload.snapshot.data.stockTrades).toEqual([]);
  });

  it('preserves an existing cash config when a later snapshot accidentally sends config as null', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-config-guard-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T02:00:00.000Z',
      data: {
        config: {
          cash: 622679.03,
          risk_limit_pct: 0.04,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [],
        stockTrades: [],
        tickerList: [],
        scenario: 0.1,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const firstReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const firstRes = createResponseCapture();
    await handleApiRequest(firstReq, firstRes);
    expect(firstRes.statusCode).toBe(200);

    const badSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T02:05:00.000Z',
      data: {
        ...baseSnapshot.data,
        config: null,
        tickerList: [
          {
            ticker: 'TSLA',
            beta: 1.92,
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
        ]
      }
    };

    const badReq = createJsonRequest('POST', '/api/app-state', badSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const badRes = createResponseCapture();
    await handleApiRequest(badReq, badRes);
    expect(badRes.statusCode).toBe(200);

    const getReq = createJsonRequest('GET', '/api/app-state');
    const getRes = createResponseCapture();
    await handleApiRequest(getReq, getRes);
    expect(getRes.statusCode).toBe(200);

    const payload = JSON.parse(getRes.body);
    expect(payload.snapshot.data.config).toEqual(baseSnapshot.data.config);
    expect(payload.snapshot.data.tickerList[0].ticker).toBe('TSLA');
  });

  it('preserves existing history arrays when a later thin snapshot accidentally sends them back empty', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-history-guard-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T03:00:00.000Z',
      data: {
        config: {
          cash: 622679.03,
          risk_limit_pct: 0.04,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [
          {
            id: 'closed-1',
            ticker: 'AAPL',
            option_side: 'put',
            put_strike: 245,
            premium_per_share: 7.98,
            contracts: 1,
            opened_at: '2026-03-20',
            closed_at: '2026-04-02',
            close_reason: 'manual',
            realized_pnl: 325.5
          }
        ],
        stockTrades: [
          {
            id: 'stock-1',
            ticker: 'NVDA',
            action: 'buy',
            shares: 300,
            price_per_share: 179.3,
            traded_at: '2026-03-18',
            cash_change: -53790,
            realized_pnl: 0
          }
        ],
        tickerList: [
          {
            ticker: 'NVDA',
            beta: 2.17,
            shares: 300,
            average_cost_basis: 179.3,
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
        scenario: null,
        vixHistory: [],
        accountValueHistory: [{ date: '2026-04-05', total_capital: 622679.03, as_of: '2026-04-05T20:00:00.000Z' }]
      }
    };

    const firstReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const firstRes = createResponseCapture();
    await handleApiRequest(firstReq, firstRes);
    expect(firstRes.statusCode).toBe(200);

    const thinSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T03:05:00.000Z',
      data: {
        ...baseSnapshot.data,
        closedTrades: [],
        stockTrades: [],
        accountValueHistory: [],
        tickerList: baseSnapshot.data.tickerList.map((entry) => ({
          ...entry,
          current_price: 181.02,
          last_updated: '2026-04-06T03:05:00.000Z'
        }))
      }
    };

    const thinReq = createJsonRequest('POST', '/api/app-state', thinSnapshot, {
      'x-app-state-save-mode': 'merge'
    });
    const thinRes = createResponseCapture();
    await handleApiRequest(thinReq, thinRes);
    expect(thinRes.statusCode).toBe(200);

    const getReq = createJsonRequest('GET', '/api/app-state');
    const getRes = createResponseCapture();
    await handleApiRequest(getReq, getRes);
    expect(getRes.statusCode).toBe(200);

    const payload = JSON.parse(getRes.body);
    expect(payload.snapshot.data.closedTrades).toEqual(baseSnapshot.data.closedTrades);
    expect(payload.snapshot.data.stockTrades).toEqual(baseSnapshot.data.stockTrades);
    expect(payload.snapshot.data.accountValueHistory).toEqual(baseSnapshot.data.accountValueHistory);
    expect(payload.snapshot.data.tickerList[0]).toMatchObject({
      ticker: 'NVDA',
      current_price: 181.02,
      last_updated: '2026-04-06T03:05:00.000Z'
    });
  });

  it('preserves existing tickers during merge-mode refresh saves while still updating refreshed fields', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-ticker-merge-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T04:00:00.000Z',
      data: {
        config: {
          cash: 622679.03,
          risk_limit_pct: 0.04,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [],
        stockTrades: [],
        tickerList: [
          {
            ticker: 'MSFT',
            beta: 1.08,
            shares: null,
            average_cost_basis: null,
            downside_tolerance_pct: null,
            current_price: 372.51,
            last_updated: '2026-04-06T03:40:00.000Z',
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
          },
          {
            ticker: 'QQQI',
            beta: 0.88,
            shares: 500,
            average_cost_basis: 52.6,
            downside_tolerance_pct: 0.2,
            current_price: 50.26,
            last_updated: '2026-04-06T03:40:00.000Z',
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
        scenario: null,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const firstReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const firstRes = createResponseCapture();
    await handleApiRequest(firstReq, firstRes);
    expect(firstRes.statusCode).toBe(200);

    const mergeSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T04:05:00.000Z',
      data: {
        ...baseSnapshot.data,
        tickerList: [
          {
            ...baseSnapshot.data.tickerList[0],
            current_price: 375.12,
            last_updated: '2026-04-06T04:05:00.000Z'
          }
        ]
      }
    };

    const mergeReq = createJsonRequest('POST', '/api/app-state', mergeSnapshot, {
      'x-app-state-save-mode': 'merge'
    });
    const mergeRes = createResponseCapture();
    await handleApiRequest(mergeReq, mergeRes);
    expect(mergeRes.statusCode).toBe(200);

    const getReq = createJsonRequest('GET', '/api/app-state');
    const getRes = createResponseCapture();
    await handleApiRequest(getReq, getRes);
    expect(getRes.statusCode).toBe(200);

    const payload = JSON.parse(getRes.body);
    expect(payload.snapshot.data.tickerList).toHaveLength(2);
    expect(payload.snapshot.data.tickerList.find((entry) => entry.ticker === 'MSFT')).toMatchObject({
      ticker: 'MSFT',
      current_price: 375.12,
      last_updated: '2026-04-06T04:05:00.000Z'
    });
    expect(payload.snapshot.data.tickerList.find((entry) => entry.ticker === 'QQQI')).toMatchObject({
      ticker: 'QQQI',
      shares: 500,
      average_cost_basis: 52.6
    });
  });

  it('persists deleting option and stock history records', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-history-delete-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T05:00:00.000Z',
      data: {
        config: {
          cash: 100000,
          risk_limit_pct: 0.2,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [
          {
            id: 'closed-1',
            ticker: 'AAPL',
            option_side: 'put',
            put_strike: 245,
            premium_sold_per_share: 7.98,
            premium_bought_back_per_share: 4.73,
            contracts: 1,
            date_sold: '2026-03-13',
            expiration_date: '2026-05-01',
            closed_at: '2026-04-03',
            close_reason: 'manual',
            realized_pnl: 325.5,
            reflection_notes: ''
          }
        ],
        stockTrades: [
          {
            id: 'stock-1',
            ticker: 'NVDA',
            action: 'sell',
            shares: 100,
            price_per_share: 180,
            traded_at: '2026-04-02',
            cash_change: 18000,
            realized_pnl: 700
          }
        ],
        tickerList: [],
        scenario: null,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const firstReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const firstRes = createResponseCapture();
    await handleApiRequest(firstReq, firstRes);
    expect(firstRes.statusCode).toBe(200);

    const deleteSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T05:03:00.000Z',
      data: {
        ...baseSnapshot.data,
        closedTrades: [],
        stockTrades: []
      }
    };

    const deleteReq = createJsonRequest('POST', '/api/app-state', deleteSnapshot, {
      'x-app-state-save-mode': 'replace',
      'x-app-state-allow-destructive': 'true'
    });
    const deleteRes = createResponseCapture();
    await handleApiRequest(deleteReq, deleteRes);
    expect(deleteRes.statusCode).toBe(200);

    const getReq = createJsonRequest('GET', '/api/app-state');
    const getRes = createResponseCapture();
    await handleApiRequest(getReq, getRes);
    expect(getRes.statusCode).toBe(200);

    const payload = JSON.parse(getRes.body);
    expect(payload.snapshot.data.closedTrades).toEqual([]);
    expect(payload.snapshot.data.stockTrades).toEqual([]);
  });

  it('persists a full option close and removes the open position from app state', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-close-option-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T06:00:00.000Z',
      data: {
        config: {
          cash: 618597.36,
          risk_limit_pct: 0.04,
          warning_threshold_pct: 0.8
        },
        puts: [
          {
            id: 'put-axp-1',
            ticker: 'AXP',
            option_side: 'put',
            put_strike: 280,
            premium_per_share: 4.5,
            contracts: 1,
            iv_rank: 0,
            date_sold: '2026-03-10',
            expiration_date: '2026-04-10',
            option_market_price_per_share: 1.03,
            option_market_price_updated: '2026-04-06T05:45:00.000Z',
            option_theta_per_share: -0.2273,
            option_delta: -0.1144,
            option_gamma: 0.0108
          }
        ],
        closedTrades: [],
        stockTrades: [],
        tickerList: [
          {
            ticker: 'AXP',
            beta: 1.34,
            shares: null,
            average_cost_basis: null,
            downside_tolerance_pct: null,
            current_price: 303.23,
            last_updated: '2026-04-06T05:45:00.000Z',
            next_earnings_date: null,
            current_iv: 0.405,
            current_iv_updated: '2026-04-06T05:45:00.000Z',
            historical_iv: null,
            iv_rank: null,
            iv_percentile: null,
            put_call_ratio: 0.53,
            put_call_ratio_updated: '2026-04-06T05:45:00.000Z',
            provider_exchange: null,
            provider_mic_code: null,
            rsi_14: 47.5,
            rsi_14_1h: null,
            rsi_updated: '2026-04-06T05:45:00.000Z',
            ma_21: null,
            ma_200: null
          }
        ],
        scenario: null,
        vixHistory: [],
        accountValueHistory: []
      }
    };

    const seedReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const seedRes = createResponseCapture();
    await handleApiRequest(seedReq, seedRes);
    expect(seedRes.statusCode).toBe(200);

    const closeSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T06:05:00.000Z',
      data: {
        ...baseSnapshot.data,
        config: {
          ...baseSnapshot.data.config,
          cash: 618552.36
        },
        puts: [],
        closedTrades: [
          {
            id: 'closed-axp-1',
            position_id: 'put-axp-1',
            ticker: 'AXP',
            option_side: 'put',
            put_strike: 280,
            premium_sold_per_share: 4.5,
            premium_bought_back_per_share: 0.45,
            contracts: 1,
            date_sold: '2026-03-10',
            expiration_date: '2026-04-10',
            closed_at: '2026-04-06',
            close_reason: 'manual',
            realized_pnl: 405,
            reflection_notes: ''
          }
        ]
      }
    };

    const closeReq = createJsonRequest('POST', '/api/app-state', closeSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const closeRes = createResponseCapture();
    await handleApiRequest(closeReq, closeRes);
    expect(closeRes.statusCode).toBe(200);

    const getReq = createJsonRequest('GET', '/api/app-state');
    const getRes = createResponseCapture();
    await handleApiRequest(getReq, getRes);
    expect(getRes.statusCode).toBe(200);

    const payload = JSON.parse(getRes.body);
    expect(payload.snapshot.data.puts).toEqual([]);
    expect(payload.snapshot.data.closedTrades[0]).toMatchObject({
      ticker: 'AXP',
      premium_bought_back_per_share: 0.45,
      realized_pnl: 405,
      closed_at: '2026-04-06'
    });
    expect(payload.snapshot.data.config.cash).toBe(618552.36);
  });

  it('rejects suspicious destructive replace writes that try to wipe core history without explicit approval', async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'risk-tool-suspicious-overwrite-'));
    process.env.APP_DATA_DIR = tempDir;

    const { handleApiRequest } = await importFresh('./server.mjs');

    const baseSnapshot = {
      version: 1,
      exported_at: '2026-04-06T07:00:00.000Z',
      data: {
        config: {
          cash: 618597.36,
          risk_limit_pct: 0.04,
          warning_threshold_pct: 0.8
        },
        puts: [],
        closedTrades: [{ id: 'closed-1', ticker: 'AAPL' }],
        stockTrades: [{ id: 'stock-1', ticker: 'NVDA' }],
        tickerList: [
          { ticker: 'AAPL', beta: 0.87 },
          { ticker: 'AMZN', beta: 1.21 },
          { ticker: 'MSFT', beta: 1.08 },
          { ticker: 'NVDA', beta: 2.17 }
        ],
        scenario: null,
        vixHistory: [],
        accountValueHistory: [
          { date: '2026-04-05', total_capital: 900000, as_of: '2026-04-05T20:00:00.000Z' },
          { date: '2026-04-06', total_capital: 905000, as_of: '2026-04-06T20:00:00.000Z' }
        ]
      }
    };

    const seedReq = createJsonRequest('POST', '/api/app-state', baseSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const seedRes = createResponseCapture();
    await handleApiRequest(seedReq, seedRes);
    expect(seedRes.statusCode).toBe(200);

    const suspiciousSnapshot = {
      ...baseSnapshot,
      exported_at: '2026-04-06T07:05:00.000Z',
      data: {
        ...baseSnapshot.data,
        closedTrades: [],
        stockTrades: [],
        tickerList: [{ ticker: 'AAPL', beta: 0.87 }],
        accountValueHistory: []
      }
    };

    const suspiciousReq = createJsonRequest('POST', '/api/app-state', suspiciousSnapshot, {
      'x-app-state-save-mode': 'replace'
    });
    const suspiciousRes = createResponseCapture();
    await handleApiRequest(suspiciousReq, suspiciousRes);
    expect(suspiciousRes.statusCode).toBe(409);

    const payload = JSON.parse(suspiciousRes.body);
    expect(payload.code).toBe('SUSPICIOUS_SNAPSHOT_SHRINK');
    expect(payload.issues).toEqual(
      expect.arrayContaining([
        'closedTrades 1 -> 0',
        'stockTrades 1 -> 0',
        'accountValueHistory 2 -> 0',
        'tickerList 4 -> 1'
      ])
    );
  });
});
