import { useEffect, useMemo, useRef, useState } from 'react';
import { buildAccountValueComparisons, upsertDailyAccountValueSnapshot } from './lib/accountValueHistory';
import { buildSummaryText, calculatePortfolioMetrics } from './lib/calculations';
import { applyOptionCloseCash, applyOptionOpenCash, applyStockBuyCash, applyStockSellCash } from './lib/cashFlows';
import { formatCurrency, formatPercent } from './lib/formatters';
import { compareOptionRowsByLossPct, getAttentionLevel, getAttentionReasons, isOptionLossAtTwoXCredit } from './lib/optionAlerts';
import { parseJsonResponseText } from './lib/quoteRefresh';
import { buildTopIvRankStocks } from './lib/dashboardSignals';
import { buildCapitalAllocationChart, buildRiskCalculator, buildRiskCurvePoints, buildTickerAllocationItems } from './lib/dashboardPortfolio';
import { analyzeVixTrend } from './lib/vixTrend';
import {
  buildAppStateSnapshot,
  applyPutPositionsImportPayload,
  loadScenario,
  loadVixHistory,
  parseAppStateSnapshot,
  parsePutPositionsImportPayload,
  saveConfig,
  saveClosedTrades,
  saveDeletedPositionIds,
  saveDeletedTickers,
  savePuts,
  saveScenario,
  saveStockTrades,
  saveAccountValueHistory,
  saveTickerList,
  saveVixHistory
} from './lib/storage';
import {
  buildClosedTradeEditPreview,
  buildPutCandidateFromPreTrade,
  closeOpenPosition,
  deleteOpenPositionAndPruneTicker,
  ensureTickerExists,
  expireOpenPositions,
  parseClosedTradeEditPreview,
  shouldApplySellPutRiskGate,
  shouldAllowForceSellOnCheckError,
  shouldClearPreTradeState,
  updateClosedTrade,
  upsertPutPosition
} from './lib/putWorkflow';
import {
  addTickerEntry,
  buyTickerShares,
  normalizeTickerSymbol,
  removeTickerEntry,
  sellTickerShares,
  updateTickerEntry,
  type TickerDraft
} from './lib/tickerWorkflow';
import { validateConfig, validatePut, type ValidationErrors } from './lib/validation';
import type {
  AccountValueSnapshot,
  ClosedPutTrade,
  Config,
  PutPosition,
  PutRiskRow,
  ScoreLevel,
  StockTradeHistory,
  StressScenario,
  TickerEntry,
  VixHistoryPoint
} from './types';

const DEFAULT_STRESS_SCENARIO: StressScenario = 0.1;

const DEFAULT_CONFIG: Config = {
  cash: 0,
  risk_limit_pct: 0.2,
  warning_threshold_pct: 0.8
};

type VixSnapshot = {
  value: number;
  asOf: string;
  fearGreedScore: number | null;
  fearGreedRating: string | null;
  fearGreedStatus: string | null;
  fearGreedError: string | null;
  storageDriver: string | null;
  cacheWriteOk: boolean | null;
  cacheWriteError: string | null;
};

type TickerEditDraftValues = Pick<TickerDraft, 'beta' | 'shares' | 'averageCostBasis' | 'downsideTolerancePct'>;

function createTickerEditDraft(entry: TickerEntry): TickerEditDraftValues {
  return {
    beta: entry.beta == null ? '' : String(entry.beta),
    shares: entry.shares == null ? '' : String(entry.shares),
    averageCostBasis: entry.average_cost_basis == null ? '' : String(entry.average_cost_basis),
    downsideTolerancePct:
      entry.downside_tolerance_pct == null ? '' : (entry.downside_tolerance_pct * 100).toFixed(1).replace(/\.0$/, '')
  };
}

type BackgroundRefreshStatus = {
  status: 'idle' | 'running' | 'success' | 'error';
  source: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string | null;
  marketOpen: boolean | null;
  force: boolean;
  includeVix: boolean;
  totalSteps: number;
  completedSteps: number;
  refreshedTickers: number;
  refreshedOptions: number;
  currentLabel: string | null;
  message: string | null;
  error: string | null;
};

type AppTab = 'dashboard' | 'sell' | 'positions' | 'history' | 'stocks' | 'calculator';
type HistoryFilter = 'all' | 'profit' | 'loss';

const SEEDED_VIX_HISTORY_RAW = `
2026-01-02	14.51
2026-01-05	14.90
2026-01-06	14.75
2026-01-07	15.38
2026-01-08	15.45
2026-01-09	14.49
2026-01-12	15.12
2026-01-13	15.98
2026-01-14	16.75
2026-01-15	15.84
2026-01-16	15.86
2026-01-19	18.84
2026-01-20	20.09
2026-01-21	16.90
2026-01-22	15.64
2026-01-23	16.09
2026-01-26	16.15
2026-01-27	16.35
2026-01-28	16.35
2026-01-29	16.88
2026-01-30	17.44
2026-02-02	16.34
2026-02-03	18.00
2026-02-04	18.64
2026-02-05	21.77
2026-02-06	17.76
2026-02-09	17.36
2026-02-10	17.79
2026-02-11	17.65
2026-02-12	20.82
2026-02-13	20.60
2026-02-16	21.20
2026-02-17	20.29
2026-02-18	19.62
2026-02-19	20.23
2026-02-20	19.09
2026-02-23	21.01
2026-02-24	19.55
2026-02-25	17.93
2026-02-26	18.63
2026-02-27	19.86
2026-03-02	21.44
2026-03-03	23.57
2026-03-04	21.15
2026-03-05	23.75
2026-03-06	29.49
2026-03-09	25.50
2026-03-10	24.93
2026-03-11	24.23
2026-03-12	27.29
2026-03-13	27.19
2026-03-16	23.51
2026-03-17	22.37
2026-03-18	25.09
2026-03-19	24.06
`.trim();

function getTodayDateInput(): string {
  const now = new Date();
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function getFutureDateInput(daysFromToday: number): string {
  const now = new Date();
  now.setDate(now.getDate() + daysFromToday);
  const offsetMs = now.getTimezoneOffset() * 60 * 1000;
  return new Date(now.getTime() - offsetMs).toISOString().slice(0, 10);
}

function isExpiredDate(expirationDate: string, today = getTodayDateInput()): boolean {
  return expirationDate !== '' && expirationDate < today;
}

function createEmptyPut(): PutPosition {
  return {
    id: '',
    ticker: '',
    option_side: 'put',
    put_strike: 0,
    premium_per_share: 0,
    contracts: 1,
    iv_rank: 0,
    date_sold: getTodayDateInput(),
    expiration_date: getFutureDateInput(45),
    option_market_price_per_share: null,
    option_market_price_updated: null,
    option_theta_per_share: null,
    decision_rationale: '',
    decision_snapshot: null
  };
}

function getOptionSideLabel(side?: 'put' | 'call'): string {
  return side === 'call' ? 'Covered Call' : 'Sell Put';
}

function formatGeminiError(error: unknown, fallbackMessage: string) {
  const message = error instanceof Error ? error.message : fallbackMessage;

  if (message.includes('upstream returned HTML')) {
    return 'Gemini 服务暂时返回了异常页面，请稍后重试。';
  }

  if (message.includes('接口返回了 HTML')) {
    return '卖前信息接口暂时返回了异常页面，请稍后重试。';
  }

  return message || fallbackMessage;
}

const PRE_TRADE_IV_OPTIONS = [
  { value: 'IV高，权利金有吸引力', label: 'IV 高，值得卖' },
  { value: 'IV一般，但收益尚可接受', label: 'IV 一般，可接受' },
  { value: 'IV偏低，这笔单主要不是为了高IV', label: 'IV 偏低，谨慎做' }
];

const PRE_TRADE_EVENT_OPTIONS = [
  { value: '无明显特殊事件窗口，可以正常评估', label: '无明显事件窗口' },
  { value: '有事件窗口，但我接受波动并继续执行', label: '有事件但可接受' },
  { value: '事件太近，优先谨慎或暂缓', label: '事件太近，先谨慎' }
];

function getReversalPlanOptions(optionSide?: 'put' | 'call') {
  return optionSide === 'call'
    ? [
        { value: '接近行权价先回补或滚仓', label: '接近行权价先回补/滚仓' },
        { value: '愿意被行权，不主动回补', label: '愿意被行权' },
        { value: '若浮亏扩大到阈值，直接止损退出', label: '达到阈值止损' }
      ]
    : [
        { value: '跌破关键位后接货，不急着止损', label: '跌破后接货' },
        { value: '接近行权价先回补或滚仓', label: '接近行权价先回补/滚仓' },
        { value: '若浮亏扩大到阈值，直接止损退出', label: '达到阈值止损' }
      ];
}

function getTradeGoalOptions(optionSide?: 'put' | 'call') {
  return optionSide === 'call'
    ? [
        { value: '在目标价卖出现股并顺便收取权利金', label: '目标价卖股' },
        { value: '以收租为主，降低持仓成本', label: '收租降成本' },
        { value: '在震荡里提升持股收益', label: '震荡中增强收益' }
      ]
    : [
        { value: '以折价建仓为主，顺便赚取权利金', label: '折价建仓' },
        { value: '以权利金收入为主，不急着接货', label: '纯收租' },
        { value: '在想买的价格附近分批建仓', label: '分批建仓' }
      ];
}

const PRE_TRADE_EXIT_RULE_OPTIONS = [
  { value: '收到50%权利金就回补', label: '收到 50% 回补' },
  { value: '收到70%权利金就回补', label: '收到 70% 回补' },
  { value: '接近 Strike roll 期权', label: '接近 Strike roll 期权' },
  { value: '剩余DTE很少就不再硬扛', label: '剩余 DTE 很少就处理' },
  { value: '亏损达到权利金2倍就退出', label: '亏损到 2x 权利金退出' }
];

function isPreTradeQuestionnaireComplete(questionnaire: PreTradeQuestionnaire) {
  return Object.values(questionnaire).every((value) => value.trim() !== '');
}

function buildPreTradeRationale(candidate: PutPosition, questionnaire: PreTradeQuestionnaire) {
  const optionLabel = getOptionSideLabel(candidate.option_side);
  return [
    `交易类型：${optionLabel}`,
    `当前 IV 判断：${questionnaire.ivView}`,
    `事件窗口判断：${questionnaire.eventWindowView}`,
    `反向走势处理计划：${questionnaire.reversalPlan}`,
    `交易目的：${questionnaire.tradeGoal}`,
    `退出条件：${questionnaire.exitRule}`
  ].join('；');
}

function renderPreTradeSources(sources?: Array<{ title: string; url: string }>) {
  if (!sources || sources.length === 0) {
    return null;
  }

  return (
    <div className="analysis-sources">
      <span>来源</span>
      {sources.map((source) => (
        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
          {source.title}
        </a>
      ))}
    </div>
  );
}

function parseDecisionRationale(rationale: string) {
  return rationale
    .split('；')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const separatorIndex = item.indexOf('：');
      if (separatorIndex === -1) {
        return { label: '备注', value: item };
      }

      return {
        label: item.slice(0, separatorIndex).trim(),
        value: item.slice(separatorIndex + 1).trim()
      };
    });
}

function getOptionSideBadge(side?: 'put' | 'call'): string {
  return side === 'call' ? 'CALL' : 'PUT';
}

function isRowInTheMoney(
  row: Pick<PutPosition, 'option_side' | 'put_strike'>,
  currentPrice: number | null | undefined
): boolean {
  if (currentPrice === null || currentPrice === undefined || currentPrice <= 0) {
    return false;
  }

  return row.option_side === 'call' ? currentPrice > row.put_strike : currentPrice < row.put_strike;
}

function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function getInitialScenario(): StressScenario {
  const storedScenario = loadScenario();
  if (typeof storedScenario === 'number' && Number.isFinite(storedScenario) && storedScenario > 0) {
    return storedScenario;
  }

  return DEFAULT_STRESS_SCENARIO;
}

function getScoreLabel(level: ScoreLevel): string {
  if (level === 'green') return '安全';
  if (level === 'yellow') return '警戒';
  return '偏高';
}

function toInputNumber(value: string): number {
  return value === '' ? 0 : Number(value);
}

function decimalToPercentInput(value: number): number {
  return Number((value * 100).toFixed(2));
}

function formatSignedCurrency(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '-';
  }

  return `${value >= 0 ? '+' : '-'}${formatCurrency(Math.abs(value))}`;
}

function formatSignedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return '-';
  }

  return `${value >= 0 ? '+' : '-'}${formatPercent(Math.abs(value))}`;
}

function calculateHoldingStockRisk(entry: TickerEntry | undefined): number {
  if (!entry) {
    return 0;
  }

  const shares = entry.shares ?? 0;
  const currentPrice = entry.current_price ?? 0;
  if (shares <= 0 || currentPrice <= 0) {
    return 0;
  }

  const rawBeta = typeof entry.beta === 'number' && Number.isFinite(entry.beta) ? entry.beta : 1;
  const clampedBeta = Math.min(Math.max(rawBeta, 0.6), 2.5);
  const rawTolerancePct =
    typeof entry.downside_tolerance_pct === 'number' && Number.isFinite(entry.downside_tolerance_pct)
      ? entry.downside_tolerance_pct
      : 0;
  const clampedTolerancePct = Math.min(Math.max(rawTolerancePct, 0), 0.2);
  const toleranceFactor = Math.max(1 - clampedTolerancePct / 0.2, 0.3);
  const stockValue = shares * currentPrice;
  const stockRiskFloor = stockValue * 0.02;

  return Math.max(stockValue * 0.1 * clampedBeta * toleranceFactor, stockRiskFloor);
}

function percentInputToDecimal(value: string): number {
  return toInputNumber(value) / 100;
}

function buildSmoothLinePath(points: Array<{ x: number; y: number }>): string {
  if (points.length === 0) {
    return '';
  }

  if (points.length === 1) {
    return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
  }

  let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;

  for (let index = 0; index < points.length - 1; index += 1) {
    const current = points[index];
    const next = points[index + 1];
    const controlX = ((current.x + next.x) / 2).toFixed(2);
    path += ` Q ${controlX} ${current.y.toFixed(2)} ${next.x.toFixed(2)} ${next.y.toFixed(2)}`;
  }

  return path;
}

function FieldError({ message }: { message?: string }) {
  if (!message) return null;
  return <div className="field-error">{message}</div>;
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  return parseJsonResponseText<T>(text, response.status, response.statusText);
}

function normalizeTicker(ticker: string): string {
  return normalizeTickerSymbol(ticker);
}

function getRsiLabel(rsi: number | null): string {
  if (rsi === null) return '未刷新';
  if (rsi <= 30) return '超卖';
  if (rsi >= 70) return '超买';
  return '中性';
}

function getRsiTone(rsi: number | null): 'muted' | 'green' | 'red' | 'yellow' {
  if (rsi === null) return 'muted';
  if (rsi <= 30) return 'green';
  if (rsi >= 70) return 'red';
  return 'yellow';
}

type StockExtremeSignal = {
  ticker: string;
  direction: 'overbought' | 'oversold';
  score: number;
  severity: 'watch' | 'strong' | 'extreme';
  rsiDaily: number | null;
  rsiHourly: number | null;
  currentPrice: number;
  ma21: number | null;
  ma200: number | null;
  priceVsMa21Pct: number | null;
  priceVsMa200Pct: number | null;
  ma21VsMa200Pct: number | null;
  label: string;
  note: string;
  tone: 'yellow' | 'red';
};

function getPercentDistanceFromAverage(price: number | null, average: number | null): number | null {
  if (price === null || average === null || !Number.isFinite(price) || !Number.isFinite(average) || average <= 0) {
    return null;
  }

  return ((price - average) / average) * 100;
}

function getPercentDistanceToStrike(
  price: number | null | undefined,
  strike: number | null | undefined,
  optionSide: 'put' | 'call'
): number | null {
  if (
    price === null ||
    price === undefined ||
    strike === null ||
    strike === undefined ||
    !Number.isFinite(price) ||
    !Number.isFinite(strike) ||
    price <= 0
  ) {
    return null;
  }

  return optionSide === 'call' ? (strike - price) / price : (price - strike) / price;
}

function formatDistanceToStrikeLabel(distancePct: number, optionSide: 'put' | 'call'): string {
  if (distancePct < 0) {
    return `ITM ${formatPercent(Math.abs(distancePct))}`;
  }

  return `${optionSide === 'call' ? 'OTM' : ''}${optionSide === 'call' ? ' ' : ''}${formatPercent(distancePct)}`.trim();
}

function buildStockExtremeSignal(entry: TickerEntry): StockExtremeSignal | null {
  if (entry.current_price === null || (entry.rsi_14 === null && entry.rsi_14_1h === null)) {
    return null;
  }

  const priceVsMa21Pct = getPercentDistanceFromAverage(entry.current_price, entry.ma_21);
  const priceVsMa200Pct = getPercentDistanceFromAverage(entry.current_price, entry.ma_200);
  const ma21VsMa200Pct = getPercentDistanceFromAverage(entry.ma_21, entry.ma_200);
  const dailyRsi = entry.rsi_14;
  const hourlyRsi = entry.rsi_14_1h;
  const overboughtScore =
    (hourlyRsi !== null && hourlyRsi >= 85 ? 4 : hourlyRsi !== null && hourlyRsi >= 80 ? 3 : hourlyRsi !== null && hourlyRsi >= 70 ? 2 : 0) +
    (dailyRsi !== null && dailyRsi >= 75 ? 4 : dailyRsi !== null && dailyRsi >= 70 ? 3 : dailyRsi !== null && dailyRsi >= 60 ? 2 : 0) +
    (priceVsMa21Pct !== null && priceVsMa21Pct >= 8 ? 2 : priceVsMa21Pct !== null && priceVsMa21Pct >= 5 ? 1 : 0) +
    (priceVsMa200Pct !== null && priceVsMa200Pct >= 15 ? 2 : priceVsMa200Pct !== null && priceVsMa200Pct >= 8 ? 1 : 0) +
    (ma21VsMa200Pct !== null && ma21VsMa200Pct >= 8 ? 2 : ma21VsMa200Pct !== null && ma21VsMa200Pct >= 3 ? 1 : 0);

  const oversoldScore =
    (hourlyRsi !== null && hourlyRsi <= 15 ? 4 : hourlyRsi !== null && hourlyRsi <= 20 ? 3 : hourlyRsi !== null && hourlyRsi <= 30 ? 2 : 0) +
    (dailyRsi !== null && dailyRsi <= 25 ? 4 : dailyRsi !== null && dailyRsi <= 30 ? 3 : dailyRsi !== null && dailyRsi <= 40 ? 2 : 0) +
    (priceVsMa21Pct !== null && priceVsMa21Pct <= -8 ? 2 : priceVsMa21Pct !== null && priceVsMa21Pct <= -5 ? 1 : 0) +
    (priceVsMa200Pct !== null && priceVsMa200Pct <= -15 ? 2 : priceVsMa200Pct !== null && priceVsMa200Pct <= -8 ? 1 : 0) +
    (ma21VsMa200Pct !== null && ma21VsMa200Pct <= -8 ? 2 : ma21VsMa200Pct !== null && ma21VsMa200Pct <= -3 ? 1 : 0);

  const hasOverboughtSignal = overboughtScore >= 4;
  const hasOversoldSignal = oversoldScore >= 4;

  if (!hasOverboughtSignal && !hasOversoldSignal) {
    return null;
  }

  if (hasOverboughtSignal && overboughtScore >= oversoldScore) {
    const severity: StockExtremeSignal['severity'] = overboughtScore >= 10 ? 'extreme' : overboughtScore >= 7 ? 'strong' : 'watch';
    const extensionBits = [
      dailyRsi !== null ? `1D RSI ${dailyRsi.toFixed(1)}` : null,
      hourlyRsi !== null ? `1H RSI ${hourlyRsi.toFixed(1)}` : null,
      priceVsMa21Pct !== null
        ? `${priceVsMa21Pct >= 0 ? '高于' : '低于'} MA21 ${Math.abs(priceVsMa21Pct).toFixed(1)}%`
        : null,
      priceVsMa200Pct !== null
        ? `${priceVsMa200Pct >= 0 ? '高于' : '低于'} MA200 ${Math.abs(priceVsMa200Pct).toFixed(1)}%`
        : null,
      ma21VsMa200Pct !== null
        ? `${ma21VsMa200Pct >= 0 ? 'MA21 高于' : 'MA21 低于'} MA200 ${Math.abs(ma21VsMa200Pct).toFixed(1)}%`
        : null
    ].filter(Boolean);

    return {
      ticker: entry.ticker,
      direction: 'overbought',
      score: overboughtScore,
      severity,
      rsiDaily: dailyRsi,
      rsiHourly: hourlyRsi,
      currentPrice: entry.current_price,
      ma21: entry.ma_21,
      ma200: entry.ma_200,
      priceVsMa21Pct,
      priceVsMa200Pct,
      ma21VsMa200Pct,
      label: severity === 'extreme' ? '极端超买' : severity === 'strong' ? '强超买' : '偏超买',
      note: `共振强度 ${overboughtScore}/14 · ${extensionBits.join('，')}`,
      tone: severity === 'extreme' ? 'red' : 'yellow'
    };
  }

  const severity: StockExtremeSignal['severity'] = oversoldScore >= 10 ? 'extreme' : oversoldScore >= 7 ? 'strong' : 'watch';
  const extensionBits = [
    dailyRsi !== null ? `1D RSI ${dailyRsi.toFixed(1)}` : null,
    hourlyRsi !== null ? `1H RSI ${hourlyRsi.toFixed(1)}` : null,
    priceVsMa21Pct !== null
      ? `${priceVsMa21Pct >= 0 ? '高于' : '低于'} MA21 ${Math.abs(priceVsMa21Pct).toFixed(1)}%`
      : null,
    priceVsMa200Pct !== null
      ? `${priceVsMa200Pct >= 0 ? '高于' : '低于'} MA200 ${Math.abs(priceVsMa200Pct).toFixed(1)}%`
      : null,
    ma21VsMa200Pct !== null
      ? `${ma21VsMa200Pct >= 0 ? 'MA21 高于' : 'MA21 低于'} MA200 ${Math.abs(ma21VsMa200Pct).toFixed(1)}%`
      : null
  ].filter(Boolean);

  return {
    ticker: entry.ticker,
    direction: 'oversold',
    score: oversoldScore,
    severity,
    rsiDaily: dailyRsi,
    rsiHourly: hourlyRsi,
    currentPrice: entry.current_price,
    ma21: entry.ma_21,
    ma200: entry.ma_200,
    priceVsMa21Pct,
    priceVsMa200Pct,
    ma21VsMa200Pct,
    label: severity === 'extreme' ? '极端超卖' : severity === 'strong' ? '强超卖' : '偏超卖',
    note: `共振强度 ${oversoldScore}/14 · ${extensionBits.join('，')}`,
    tone: severity === 'extreme' ? 'red' : 'yellow'
  };
}

function getIvTone(currentIv: number | null): 'muted' | 'green' | 'red' | 'yellow' {
  if (currentIv === null) return 'muted';
  if (currentIv < 0.25) return 'green';
  if (currentIv < 0.45) return 'yellow';
  return 'red';
}

function getPcrTone(putCallRatio: number | null): 'muted' | 'green' | 'red' | 'yellow' {
  if (putCallRatio === null) return 'muted';
  if (putCallRatio < 0.7) return 'green';
  if (putCallRatio <= 1.1) return 'yellow';
  return 'red';
}

function getIvRankTone(ivRank: number | null): 'muted' | 'green' | 'red' | 'yellow' {
  if (ivRank === null) return 'muted';
  if (ivRank < 30) return 'green';
  if (ivRank < 60) return 'yellow';
  return 'red';
}

function getSuggestedActionTone(score: number | null | undefined): 'green' | 'orange' | 'gray' | 'red' {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return 'gray';
  }

  if (score < 15) return 'green';
  if (score < 20) return 'orange';
  if (score > 80) return 'red';
  return 'gray';
}

function getSellingScoreLevel(score: number): ScoreLevel {
  if (score < 60) return 'green';
  if (score < 80) return 'yellow';
  return 'red';
}

function getRegimeAdjustment(fearGreedScore: number | null | undefined): number {
  if (fearGreedScore === null || fearGreedScore === undefined || !Number.isFinite(fearGreedScore)) {
    return 0;
  }

  if (fearGreedScore <= 15) return -15;
  if (fearGreedScore <= 20) return -12;
  if (fearGreedScore < 30) return -5;
  if (fearGreedScore < 40) return 0;
  if (fearGreedScore < 60) return 5;
  if (fearGreedScore < 80) return 10;
  return 20;
}

type QuotesPayload = {
  quotes?: Record<string, number>;
  rsi?: Record<string, number>;
  rsi1h?: Record<string, number>;
  ma21?: Record<string, number>;
  ma200?: Record<string, number>;
  currentIv?: Record<string, number>;
  nextEarningsDate?: Record<string, string>;
  historicalIv?: Record<string, number>;
  ivRank?: Record<string, number>;
  ivPercentile?: Record<string, number>;
  putCallRatio?: Record<string, number>;
  errors?: Record<string, string>;
  error?: string;
  as_of?: string;
};

type QuoteRefreshMode = 'full' | 'price-only';

type PositionRiskTone = 'green' | 'yellow' | 'red';

function getPositionRiskAssessment(
  row: PutRiskRow,
  tickerEntry: TickerEntry | undefined
): { label: string; tone: PositionRiskTone; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];
  const isCall = row.option_side === 'call';

  if (row.riskPctOfCash >= 0.015) {
    score += 2;
    reasons.push('单笔现金风险占比偏高');
  } else if (row.riskPctOfCash >= 0.008) {
    score += 1;
    reasons.push('单笔现金风险占比偏高');
  }

  if (tickerEntry?.current_price !== null && tickerEntry?.current_price !== undefined) {
    if (isCall) {
      if (tickerEntry.ma_200 !== null && tickerEntry.ma_200 !== undefined && tickerEntry.current_price > tickerEntry.ma_200) {
        score += 1;
        reasons.push('股价在 MA200 上方');
      } else if (tickerEntry.ma_21 !== null && tickerEntry.ma_21 !== undefined && tickerEntry.current_price > tickerEntry.ma_21) {
        score += 1;
        reasons.push('股价站上 MA21');
      }
    } else if (tickerEntry.ma_200 !== null && tickerEntry.ma_200 !== undefined && tickerEntry.current_price < tickerEntry.ma_200) {
      score += 2;
      reasons.push('股价在 MA200 下方');
    } else if (tickerEntry.ma_21 !== null && tickerEntry.ma_21 !== undefined && tickerEntry.current_price < tickerEntry.ma_21) {
      score += 1;
      reasons.push('股价跌到 MA21 下方');
    }
  }

  if (tickerEntry?.rsi_14 !== null && tickerEntry?.rsi_14 !== undefined) {
    if (tickerEntry.rsi_14 >= 65) {
      score += 2;
      reasons.push(isCall ? 'RSI 偏热，接近行权' : 'RSI 偏热');
    } else if (tickerEntry.rsi_14 >= 55) {
      score += 1;
      reasons.push(isCall ? 'RSI 偏高，需留意行权' : 'RSI 偏高');
    }
  }

  if (tickerEntry?.current_iv !== null && tickerEntry?.current_iv !== undefined && tickerEntry.current_iv >= 0.5) {
    score += 1;
    reasons.push('波动率偏高');
  }

  if (tickerEntry?.put_call_ratio !== null && tickerEntry?.put_call_ratio !== undefined && tickerEntry.put_call_ratio >= 1.2) {
    score += 1;
    reasons.push('PCR 偏高');
  }

  if (isCall) {
    if (row.distance_pct < 0) {
      score += 3;
      reasons.push('Call 已 ITM');
    } else if (row.distance_pct < 0.04) {
      score += 2;
      reasons.push('Call 接近 Strike');
    }
  } else if (row.distance_pct < 0) {
    score += 3;
    reasons.push('Put 已 ITM');
  } else if (row.distance_pct < 0.04) {
    score += 1;
    reasons.push('Strike 缓冲偏薄');
  }

  if (score >= 4) {
    return { label: '高风险', tone: 'red', reasons: reasons.slice(0, 3) };
  }
  if (score >= 2) {
    return { label: '偏高', tone: 'yellow', reasons: reasons.slice(0, 3) };
  }
  return {
    label: '正常',
    tone: 'green',
    reasons: reasons.length > 0 ? reasons.slice(0, 2) : ['当前指标整体正常']
  };
}

const CURRENT_IV_CACHE_MS = 24 * 60 * 60 * 1000;
const AUTO_PRICE_REFRESH_MS = 20 * 60 * 1000;
const AUTO_PRICE_REFRESH_CHECK_MS = 20 * 60 * 1000;
const AUTO_OPTION_REFRESH_MS = 30 * 60 * 1000;
const AUTO_OPTION_REFRESH_CHECK_MS = 30 * 60 * 1000;
const PRICE_REFRESH_GAP_MS = 15 * 1000;
const PRICE_REFRESH_RETRY_GAP_MS = 20 * 1000;
const VIX_STRESS_Z = 1.45;

function isFreshWithin(timestamp: string | null, ttlMs: number): boolean {
  if (!timestamp) {
    return false;
  }

  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) {
    return false;
  }

  return Date.now() - value < ttlMs;
}

function isPriceRefreshStale(timestamp: string | null): boolean {
  return !isFreshWithin(timestamp, AUTO_PRICE_REFRESH_MS);
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isMinuteLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('current minute') ||
    normalized.includes('api credits for the current minute') ||
    normalized.includes('minute limit')
  );
}

function getNewYorkTimeParts(date = new Date()): {
  weekday: string;
  hour: number;
  minute: number;
} {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Mon';
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? '0');

  return { weekday, hour, minute };
}

function isUsMarketOpen(date = new Date()): boolean {
  const { weekday, hour, minute } = getNewYorkTimeParts(date);

  if (weekday === 'Sat' || weekday === 'Sun') {
    return false;
  }

  const minutes = hour * 60 + minute;
  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;

  return minutes >= marketOpen && minutes < marketClose;
}

function shouldRunDailyOptionRefresh(date = new Date()): boolean {
  return isUsMarketOpen(date);
}

function isOptionRefreshStale(timestamp: string | null): boolean {
  if (!timestamp) {
    return true;
  }

  return !isFreshWithin(timestamp, AUTO_OPTION_REFRESH_MS);
}

function getAutoStressByVix(vix: number): StressScenario {
  const annualizedVol = vix / 100;
  const monthlyStress = (VIX_STRESS_Z * annualizedVol) / Math.sqrt(12);
  return Math.min(Math.max(monthlyStress, 0.1), 0.25);
}

function getFearGreedStressAdjustment(score: number | null | undefined): number {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return 0;
  }

  if (score > 20) {
    return 0;
  }

  if (score <= 12) {
    return -0.05;
  }

  // Use a convex curve so the reduction accelerates as the score moves closer to 12,
  // while keeping mid-teen values closer to a ~2% reduction.
  const t = (20 - score) / (20 - 12);
  return -(0.01 + Math.pow(t, 3.5) * 0.04);
}

function getFearGreedStatusLabel(snapshot: VixSnapshot | null): string {
  if (!snapshot) {
    return '';
  }

  switch (snapshot.fearGreedStatus) {
    case 'cached':
      return 'Fear & Greed 来自缓存';
    case 'stale-cache':
      return 'Fear & Greed 使用旧缓存';
    case 'fetched-live':
      return 'Fear & Greed 本次实时抓取成功';
    case 'fetch-failed-used-cache':
      return 'Fear & Greed 抓取失败，当前使用旧缓存';
    case 'fetch-failed-no-cache':
      return 'Fear & Greed 抓取失败，且当前无缓存';
    case 'no-cache':
      return 'Fear & Greed 当前无缓存';
    default:
      return 'Fear & Greed 状态未知';
  }
}

function getHistoryDayKey(timestamp: string): string {
  return timestamp.slice(0, 10);
}

function buildSeededVixHistory(): VixHistoryPoint[] {
  return SEEDED_VIX_HISTORY_RAW.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [date, rawValue] = line.split('\t');
      const value = Number(rawValue);
      return {
        timestamp: `${date}T16:00:00.000Z`,
        value,
        stress: getAutoStressByVix(value)
      };
    })
    .filter((item) => Number.isFinite(item.value));
}

function mergeSeededVixHistory(history: VixHistoryPoint[]): VixHistoryPoint[] {
  return compressVixHistory([...buildSeededVixHistory(), ...history]);
}

function compressVixHistory(history: VixHistoryPoint[]): VixHistoryPoint[] {
  const byDay = new Map<string, VixHistoryPoint>();

  for (const item of history) {
    byDay.set(getHistoryDayKey(item.timestamp), item);
  }

  return [...byDay.values()]
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    .slice(-180);
}

function getDynamicStressAdjustment(history: VixHistoryPoint[]): {
  adjustment: number;
  mode: 'rising' | 'falling' | 'sideways' | 'neutral';
  note: string;
  action: string;
  sevenDayAverage: number | null;
} {
  return analyzeVixTrend(compressVixHistory(history));
}

function getDaysToExpirationForPreview(dateSold: string, expirationDate: string): number {
  if (!dateSold || !expirationDate) {
    return 0;
  }

  const sold = new Date(dateSold);
  const expiration = new Date(expirationDate);
  const diffInMs = expiration.getTime() - sold.getTime();
  const millisecondsPerDay = 1000 * 60 * 60 * 24;

  if (!Number.isFinite(diffInMs) || diffInMs <= 0) {
    return 0;
  }

  return Math.ceil(diffInMs / millisecondsPerDay);
}

function closeAnalysisModal(
  setAnalysisResult: React.Dispatch<React.SetStateAction<PositionAnalysisResult | null>>,
  setAnalysisError: React.Dispatch<React.SetStateAction<string>>
) {
  setAnalysisResult(null);
  setAnalysisError('');
}

type PutEntryCheckResponse = {
  ok: boolean;
  summary: string;
  failures: string[];
  metrics?: {
    current_price: number;
    rsi_14: number;
    ma_20: number;
    current_iv: number | null;
    otm_pct: number;
    dte: number | null;
    as_of: string;
  };
};

type PositionAnalysisResult = {
  ticker: string;
  analysis: {
    verdict: string;
    summary: string;
    key_risks: string[];
    recent_change: string;
    fundamental_note: string;
    calc: {
      breakeven: string;
      buffer_pct: string;
      max_profit: string;
      annualized_yield_pct: string;
      rsi_display: string;
    };
  };
  sources: Array<{ title: string; url: string }>;
  asOf: string;
};

type PreTradeAnalysisResult = {
  analysis: {
    verdict: string;
    summary: string;
    rationale_check: string;
    key_risks: string[];
    worst_case: string;
    fundamental_note: string;
    fundamental_events: string[];
    current_iv_rank: string;
    iv_rank_note: string;
    iv_rank_source: string;
    iv_rank_time: string;
    iv_rank_link: string;
    current_iv_check: string;
    marsi_check: string;
    rsi_check: string;
    ma200_check: string;
    next_earnings_date: string;
    earnings_warning: string;
    calc: {
      max_profit: string;
      risk_at_10pct_drop: string;
    };
    action: string;
  };
  sources: Array<{ title: string; url: string }>;
  marketContext?: {
    current_price: number | null;
    current_price_date: string | null;
    current_iv: number | null;
    historical_iv: number | null;
    iv_rank: number | null;
    iv_percentile: number | null;
    next_earnings_date: string | null;
    put_call_ratio: number | null;
    source: {
      current_price: string | null;
      next_earnings_date: string | null;
      current_iv: string | null;
      historical_iv: string | null;
      iv_rank: string | null;
      iv_percentile: string | null;
      put_call_ratio: string | null;
    };
  };
  asOf: string;
};

type PreTradeContextResult = {
  summary: {
    iv_assessment: string;
    earnings_assessment: string;
    special_window_assessment: string;
    fundamental_risk_assessment: string;
    key_flags: string[];
  };
  source_map?: {
    iv_assessment?: Array<{ title: string; url: string }>;
    earnings_assessment?: Array<{ title: string; url: string }>;
    special_window_assessment?: Array<{ title: string; url: string }>;
    fundamental_risk_assessment?: Array<{ title: string; url: string }>;
  };
  marketContext?: {
    current_price: number | null;
    current_price_date: string | null;
    current_iv: number | null;
    historical_iv: number | null;
    iv_rank: number | null;
    iv_percentile: number | null;
    next_earnings_date: string | null;
    put_call_ratio: number | null;
    source: {
      current_price: string | null;
      next_earnings_date: string | null;
      current_iv: string | null;
      historical_iv: string | null;
      iv_rank: string | null;
      iv_percentile: string | null;
      put_call_ratio: string | null;
    };
  };
  partial?: boolean;
  sources: Array<{ title: string; url: string }>;
  asOf: string;
};

type PreTradeQuestionnaire = {
  ivView: string;
  eventWindowView: string;
  reversalPlan: string;
  tradeGoal: string;
  exitRule: string;
};

type OptionDraftState = {
  putForm: PutPosition;
  editingPutId: string | null;
  preTradeCandidate: PutPosition | null;
  preTradeQuestionnaire: PreTradeQuestionnaire;
  preTradeAnalysis: PreTradeAnalysisResult | null;
};

const ACTIVE_TAB_STORAGE_KEY = 'risk-tool-active-tab';
const OPTION_DRAFT_STORAGE_KEY = 'risk-tool-option-draft';

function createEmptyPreTradeQuestionnaire(): PreTradeQuestionnaire {
  return {
    ivView: '',
    eventWindowView: '',
    reversalPlan: '',
    tradeGoal: '',
    exitRule: ''
  };
}

function loadDraftJson<T>(key: string): T | null {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function saveDraftJson(key: string, value: unknown): void {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    if (value === null) {
      window.localStorage.removeItem(key);
      return;
    }

    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore draft persistence failures.
  }
}

function savePutPosition(
  normalized: PutPosition,
  editingPutId: string | null,
  setPuts: React.Dispatch<React.SetStateAction<PutPosition[]>>,
  setTickerList: React.Dispatch<React.SetStateAction<TickerEntry[]>>
) {
  setTickerList((current) => {
    const nextTickerList = ensureTickerExists(current, normalized.ticker);
    saveTickerList(nextTickerList);
    return nextTickerList;
  });
  setPuts((current) => {
    const nextPuts = upsertPutPosition(current, normalized, editingPutId, generateId);
    savePuts(nextPuts);
    return nextPuts;
  });
}

function loadOptionDraftState(): OptionDraftState {
  const draft = loadDraftJson<Partial<OptionDraftState>>(OPTION_DRAFT_STORAGE_KEY);

  return {
    putForm: draft?.putForm ? { ...createEmptyPut(), ...draft.putForm } : createEmptyPut(),
    editingPutId: typeof draft?.editingPutId === 'string' ? draft.editingPutId : null,
    preTradeCandidate: draft?.preTradeCandidate ? { ...draft.preTradeCandidate } as PutPosition : null,
    preTradeQuestionnaire:
      draft?.preTradeQuestionnaire && typeof draft.preTradeQuestionnaire === 'object'
        ? { ...createEmptyPreTradeQuestionnaire(), ...draft.preTradeQuestionnaire as PreTradeQuestionnaire }
        : createEmptyPreTradeQuestionnaire(),
    preTradeAnalysis:
      draft?.preTradeAnalysis && typeof draft.preTradeAnalysis === 'object'
        ? draft.preTradeAnalysis as PreTradeAnalysisResult
        : null
  };
}

function normalizeBackgroundRefreshStatus(raw: unknown): BackgroundRefreshStatus {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const status = record.status;

  return {
    status: status === 'running' || status === 'success' || status === 'error' ? status : 'idle',
    source: typeof record.source === 'string' ? record.source : null,
    startedAt: typeof record.started_at === 'string' ? record.started_at : null,
    finishedAt: typeof record.finished_at === 'string' ? record.finished_at : null,
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
    marketOpen: typeof record.market_open === 'boolean' ? record.market_open : null,
    force: record.force === true,
    includeVix: record.include_vix !== false,
    totalSteps: typeof record.total_steps === 'number' ? record.total_steps : 0,
    completedSteps: typeof record.completed_steps === 'number' ? record.completed_steps : 0,
    refreshedTickers: typeof record.refreshed_tickers === 'number' ? record.refreshed_tickers : 0,
    refreshedOptions: typeof record.refreshed_options === 'number' ? record.refreshed_options : 0,
    currentLabel: typeof record.current_label === 'string' ? record.current_label : null,
    message: typeof record.message === 'string' ? record.message : null,
    error: typeof record.error === 'string' ? record.error : null
  };
}

function App() {
  const initialOptionDraft = loadOptionDraftState();
  const [config, setConfig] = useState<Config | null>(null);
  const [puts, setPuts] = useState<PutPosition[]>([]);
  const [closedTrades, setClosedTrades] = useState<ClosedPutTrade[]>([]);
  const [stockTrades, setStockTrades] = useState<StockTradeHistory[]>([]);
  const [tickerList, setTickerList] = useState<TickerEntry[]>([]);
  const [scenario, setScenario] = useState<StressScenario>(getInitialScenario());
  const [configForm, setConfigForm] = useState<Config>(DEFAULT_CONFIG);
  const [configErrors, setConfigErrors] = useState<ValidationErrors<Config>>({});
  const [putForm, setPutForm] = useState<PutPosition>(initialOptionDraft.putForm);
  const [putErrors, setPutErrors] = useState<ValidationErrors<PutPosition>>({});
  const [editingPutId, setEditingPutId] = useState<string | null>(initialOptionDraft.editingPutId);
  const [newTicker, setNewTicker] = useState('');
  const [newTickerBeta, setNewTickerBeta] = useState('');
  const [newTickerShares, setNewTickerShares] = useState('');
  const [newTickerAverageCost, setNewTickerAverageCost] = useState('');
  const [newTickerTolerancePct, setNewTickerTolerancePct] = useState('');
  const [newTickerExchange, setNewTickerExchange] = useState('');
  const [newTickerMicCode, setNewTickerMicCode] = useState('');
  const [editingTickers, setEditingTickers] = useState<Record<string, boolean>>({});
  const [tickerDrafts, setTickerDrafts] = useState<Record<string, TickerEditDraftValues>>({});
  const [tickerMessage, setTickerMessage] = useState('');
  const [priceRefreshMessage, setPriceRefreshMessage] = useState('');
  const [refreshAllProgress, setRefreshAllProgress] = useState<{
    current: number;
    total: number;
    successCount: number;
    failureCount: number;
    ticker: string;
  } | null>(null);
  const [vixMessage, setVixMessage] = useState('');
  const [vixSnapshot, setVixSnapshot] = useState<VixSnapshot | null>(null);
  const [backgroundRefreshStatus, setBackgroundRefreshStatus] = useState<BackgroundRefreshStatus | null>(null);
  const [pendingPositionScrollId, setPendingPositionScrollId] = useState<string | null>(null);
  const [pendingStockScrollTicker, setPendingStockScrollTicker] = useState<string | null>(null);
  const [refreshingTicker, setRefreshingTicker] = useState<string | null>(null);
  const [isRefreshingAllTickers, setIsRefreshingAllTickers] = useState(false);
  const [isCheckingPut, setIsCheckingPut] = useState(false);
  const [putCheckResult, setPutCheckResult] = useState<PutEntryCheckResponse | null>(null);
  const [forceSellCandidate, setForceSellCandidate] = useState<PutPosition | null>(null);
  const [analysisPositionId, setAnalysisPositionId] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<PositionAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [refreshingOptionPriceId, setRefreshingOptionPriceId] = useState<string | null>(null);
  const [autoRefreshingOptionPriceId, setAutoRefreshingOptionPriceId] = useState<string | null>(null);
  const [isRefreshingAllOptions, setIsRefreshingAllOptions] = useState(false);
  const [refreshAllOptionsProgress, setRefreshAllOptionsProgress] = useState<{
    current: number;
    total: number;
    successCount: number;
    failureCount: number;
    ticker: string;
  } | null>(null);
  const [autoRefreshOptionsProgress, setAutoRefreshOptionsProgress] = useState<{
    current: number;
    total: number;
    successCount: number;
    failureCount: number;
    ticker: string;
  } | null>(null);
  const putsRef = useRef<PutPosition[]>(puts);
  const positionCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const stockRowRefs = useRef<Record<string, HTMLElement | null>>({});
  const refreshingOptionPriceIdRef = useRef<string | null>(refreshingOptionPriceId);
  const autoRefreshingOptionPriceIdRef = useRef<string | null>(autoRefreshingOptionPriceId);
  const isRefreshingAllOptionsRef = useRef(isRefreshingAllOptions);
  const [optionPriceOverrides, setOptionPriceOverrides] = useState<Record<string, { price: number; theta: number | null; updatedAt: string }>>({});
  const [optionPriceMessages, setOptionPriceMessages] = useState<
    Record<string, { tone: 'success' | 'error' | 'info'; text: string }>
  >({});
  const [hoveredExposureSegment, setHoveredExposureSegment] = useState<{
    ticker: string;
    exposure: number;
    share: number;
    x: number;
    y: number;
  } | null>(null);
  const [preTradeCandidate, setPreTradeCandidate] = useState<PutPosition | null>(initialOptionDraft.preTradeCandidate);
  const [preTradeQuestionnaire, setPreTradeQuestionnaire] = useState<PreTradeQuestionnaire>(
    initialOptionDraft.preTradeQuestionnaire
  );
  const [preTradeError, setPreTradeError] = useState('');
  const [preTradeAnalysis, setPreTradeAnalysis] = useState<PreTradeAnalysisResult | null>(initialOptionDraft.preTradeAnalysis);
  const [preTradeContext, setPreTradeContext] = useState<PreTradeContextResult | null>(null);
  const [isLoadingPreTradeContext, setIsLoadingPreTradeContext] = useState(false);
  const [isEnrichingPreTradeContext, setIsEnrichingPreTradeContext] = useState(false);
  const [isPreTradeAnalyzing, setIsPreTradeAnalyzing] = useState(false);
  const [deletePreview, setDeletePreview] = useState<{
    id: string;
    ticker: string;
    currentScore: number;
    nextScore: number;
  } | null>(null);
  const [closePreview, setClosePreview] = useState<{
    row: PutRiskRow;
    contractsToClose: string;
    buybackPremiumPerShare: string;
    closedAt: string;
    reflectionNotes: string;
  } | null>(null);
  const [sellStockPreview, setSellStockPreview] = useState<{
    ticker: string;
    currentShares: number;
    sharesToSell: string;
    sellPricePerShare: string;
    coveredCallShares: number;
  } | null>(null);
  const [buyStockPreview, setBuyStockPreview] = useState<{
    ticker: string;
    currentShares: number;
    sharesToBuy: string;
    buyPricePerShare: string;
  } | null>(null);
  const [historyEditPreview, setHistoryEditPreview] = useState<{
    tradeId: string;
    ticker: string;
    optionSide: 'put' | 'call';
    putStrike: string;
    premiumSoldPerShare: string;
    premiumBoughtBackPerShare: string;
    contracts: string;
    dateSold: string;
    expirationDate: string;
    closedAt: string;
    closeReason: ClosedPutTrade['close_reason'];
    reflectionNotes: string;
  } | null>(null);
  const [positionTickerFilter, setPositionTickerFilter] = useState<string>('ALL');
  const [positionFilter, setPositionFilter] = useState<'ALL' | 'WITHIN_7_DAYS' | 'PROFIT_OVER_60'>('ALL');
  const [positionOptionTypeFilter, setPositionOptionTypeFilter] = useState<'ALL' | 'PUT' | 'CALL'>('ALL');
  const [moneynessFilter, setMoneynessFilter] = useState<'ALL' | 'ITM' | 'OTM'>('ALL');
  const [positionSort, setPositionSort] = useState<'DEFAULT' | 'EXPIRATION' | 'PUT_RISK' | 'LOSS_PCT' | 'ANNUALIZED_YIELD'>('DEFAULT');
  const [riskCalculatorDropInput, setRiskCalculatorDropInput] = useState('0');
  const [vixHistory, setVixHistory] = useState<VixHistoryPoint[]>(() => mergeSeededVixHistory(loadVixHistory()));
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all');
  const [copyMessage, setCopyMessage] = useState('');
  const [importExportMessage, setImportExportMessage] = useState('');
  const [accountValueHistory, setAccountValueHistory] = useState<AccountValueSnapshot[]>([]);
  const [deletedTickers, setDeletedTickers] = useState<string[]>([]);
  const [deletedPositionIds, setDeletedPositionIds] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<AppTab>(() => {
    if (typeof window === 'undefined') {
      return 'dashboard';
    }

    const raw = window.localStorage.getItem(ACTIVE_TAB_STORAGE_KEY);
    if (
      raw === 'dashboard' ||
      raw === 'sell' ||
      raw === 'positions' ||
      raw === 'history' ||
      raw === 'stocks' ||
      raw === 'calculator'
    ) {
      return raw;
    }

    return 'dashboard';
  });
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const addPutSectionRef = useRef<HTMLElement | null>(null);
  const hasHydratedSnapshotRef = useRef(false);
  const hasLoadedRemoteSnapshotRef = useRef(false);
  const latestBackgroundRefreshFinishedAtRef = useRef<string | null>(null);
  const [isSnapshotHydrated, setIsSnapshotHydrated] = useState(false);

  function applyRemoteSnapshot(snapshotPayload: unknown, successMessage?: string) {
    const snapshot = parseAppStateSnapshot(JSON.stringify(snapshotPayload));
    hasLoadedRemoteSnapshotRef.current = true;

    setConfig(snapshot.data.config);
    setConfigForm(snapshot.data.config ?? DEFAULT_CONFIG);
    setPuts(snapshot.data.puts);
    setClosedTrades(snapshot.data.closedTrades);
    setStockTrades(snapshot.data.stockTrades);
    setTickerList(snapshot.data.tickerList);
    setScenario(snapshot.data.scenario ?? DEFAULT_STRESS_SCENARIO);
    setVixHistory(mergeSeededVixHistory(snapshot.data.vixHistory));
    setAccountValueHistory(snapshot.data.accountValueHistory);
    setDeletedTickers([]);
    setDeletedPositionIds([]);
    if (successMessage) {
      setImportExportMessage(successMessage);
    }
  }

  const stressAdjustment = useMemo(() => getDynamicStressAdjustment(vixHistory), [vixHistory]);
  const baseVixForStress = stressAdjustment.sevenDayAverage ?? vixSnapshot?.value ?? null;
  const autoScenario = baseVixForStress === null ? null : getAutoStressByVix(baseVixForStress);
  const fearGreedStressAdjustment = getFearGreedStressAdjustment(vixSnapshot?.fearGreedScore);
  const suggestedActionTone = getSuggestedActionTone(vixSnapshot?.fearGreedScore);
  const activeScenario = Math.max((autoScenario ?? scenario) + stressAdjustment.adjustment + fearGreedStressAdjustment, 0.08);
  const metrics = useMemo(
    () => calculatePortfolioMetrics(config, puts, tickerList, activeScenario),
    [activeScenario, config, puts, tickerList]
  );
  const tickerMap = useMemo(() => new Map(tickerList.map((entry) => [entry.ticker, entry])), [tickerList]);

  useEffect(() => {
    savePuts(puts);
  }, [puts]);

  useEffect(() => {
    putsRef.current = puts;
  }, [puts]);

  useEffect(() => {
    saveClosedTrades(closedTrades);
  }, [closedTrades]);

  useEffect(() => {
    saveStockTrades(stockTrades);
  }, [stockTrades]);

  useEffect(() => {
    saveTickerList(tickerList);
  }, [tickerList]);

  useEffect(() => {
    saveDeletedTickers(deletedTickers);
  }, [deletedTickers]);

  useEffect(() => {
    saveDeletedPositionIds(deletedPositionIds);
  }, [deletedPositionIds]);

  useEffect(() => {
    saveScenario(scenario);
  }, [scenario]);

  useEffect(() => {
    saveVixHistory(vixHistory);
  }, [vixHistory]);

  useEffect(() => {
    saveAccountValueHistory(accountValueHistory);
  }, [accountValueHistory]);

  useEffect(() => {
    if (copyMessage === '') return;
    const timer = window.setTimeout(() => setCopyMessage(''), 2000);
    return () => window.clearTimeout(timer);
  }, [copyMessage]);

  useEffect(() => {
    if (importExportMessage === '') return;
    const timer = window.setTimeout(() => setImportExportMessage(''), 2600);
    return () => window.clearTimeout(timer);
  }, [importExportMessage]);

  useEffect(() => {
    if (tickerMessage === '') return;
    const timer = window.setTimeout(() => setTickerMessage(''), 2000);
    return () => window.clearTimeout(timer);
  }, [tickerMessage]);

  useEffect(() => {
    if (priceRefreshMessage === '' || isRefreshingAllTickers) return;
    const timer = window.setTimeout(() => setPriceRefreshMessage(''), 2600);
    return () => window.clearTimeout(timer);
  }, [priceRefreshMessage, isRefreshingAllTickers]);

  useEffect(() => {
    if (vixMessage === '') return;
    const timer = window.setTimeout(() => setVixMessage(''), 2600);
    return () => window.clearTimeout(timer);
  }, [vixMessage]);

  useEffect(() => {
    refreshingOptionPriceIdRef.current = refreshingOptionPriceId;
  }, [refreshingOptionPriceId]);

  useEffect(() => {
    autoRefreshingOptionPriceIdRef.current = autoRefreshingOptionPriceId;
  }, [autoRefreshingOptionPriceId]);

  useEffect(() => {
    isRefreshingAllOptionsRef.current = isRefreshingAllOptions;
  }, [isRefreshingAllOptions]);

  useEffect(() => {
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, activeTab);
  }, [activeTab]);

  useEffect(() => {
    const isFreshForm =
      putForm.ticker === '' &&
      putForm.put_strike === 0 &&
      putForm.premium_per_share === 0 &&
      putForm.contracts === 1 &&
      preTradeCandidate === null &&
      !isPreTradeQuestionnaireComplete(preTradeQuestionnaire) &&
      preTradeAnalysis === null &&
      editingPutId === null;

    if (isFreshForm) {
      saveDraftJson(OPTION_DRAFT_STORAGE_KEY, null);
      return;
    }

    saveDraftJson(OPTION_DRAFT_STORAGE_KEY, {
      putForm,
      editingPutId,
      preTradeCandidate,
      preTradeQuestionnaire,
      preTradeAnalysis
    } satisfies OptionDraftState);
  }, [editingPutId, preTradeAnalysis, preTradeCandidate, preTradeQuestionnaire, putForm]);

  useEffect(() => {
    setPutCheckResult(null);
  }, [putForm, editingPutId]);

  useEffect(() => {
    if (!preTradeCandidate) {
      setPreTradeContext(null);
      setIsLoadingPreTradeContext(false);
      setIsEnrichingPreTradeContext(false);
      return;
    }

    const candidate = preTradeCandidate;

    let cancelled = false;

    async function fetchPreTradeContext() {
      setIsLoadingPreTradeContext(true);
      setIsEnrichingPreTradeContext(false);

      try {
        const response = await fetch('/api/pre-trade-context', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ticker: candidate.ticker,
            option_side: candidate.option_side ?? 'put',
            expiration_date: candidate.expiration_date,
            include_search: false
          })
        });

        const payloadText = await response.text();
        const payload = parseJsonResponseText<PreTradeContextResult & { error?: string }>(
          payloadText,
          response.status,
          response.statusText
        );

        if (!response.ok || payload.error || typeof payload.summary !== 'object' || payload.summary === null) {
          throw new Error(payload.error ?? '卖前事件信息读取失败');
        }

        if (!cancelled) {
          setPreTradeContext(payload);
        }

        if (!cancelled) {
          setIsEnrichingPreTradeContext(true);
          void (async () => {
            try {
              const enrichResponse = await fetch('/api/pre-trade-context', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  ticker: candidate.ticker,
                  option_side: candidate.option_side ?? 'put',
                  expiration_date: candidate.expiration_date,
                  include_search: true
                })
              });
              const enrichText = await enrichResponse.text();
              const enrichPayload = parseJsonResponseText<PreTradeContextResult & { error?: string }>(
                enrichText,
                enrichResponse.status,
                enrichResponse.statusText
              );

              if (!enrichResponse.ok || enrichPayload.error || typeof enrichPayload.summary !== 'object' || enrichPayload.summary === null) {
                throw new Error(enrichPayload.error ?? '卖前补充信息读取失败');
              }

              if (!cancelled) {
                setPreTradeContext((current) => ({
                  ...(current ?? enrichPayload),
                  ...enrichPayload
                }));
              }
            } catch {
              // Keep the immediate website snapshot if Gemini enrichment fails.
            } finally {
              if (!cancelled) {
                setIsEnrichingPreTradeContext(false);
              }
            }
          })();
        }
      } catch (error) {
        if (!cancelled) {
          setPreTradeContext(null);
          setPreTradeError(formatGeminiError(error, '卖前事件信息读取失败'));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingPreTradeContext(false);
        }
      }
    }

    void fetchPreTradeContext();

    return () => {
      cancelled = true;
    };
  }, [preTradeCandidate]);

  useEffect(() => {
    let ignore = false;

    async function hydrateSavedSnapshot() {
      try {
        const response = await fetch('/api/app-state');
        const payload = (await response.json()) as { snapshot?: unknown; error?: string };

        if (!response.ok || payload.error || !payload.snapshot || ignore) {
          return;
        }

        applyRemoteSnapshot(payload.snapshot, '已加载本地保存的数据');
      } catch {
        // Keep browser localStorage state if no saved snapshot is available.
      } finally {
        if (!ignore) {
          hasHydratedSnapshotRef.current = true;
          setIsSnapshotHydrated(true);
        }
      }
    }

    void hydrateSavedSnapshot();

    return () => {
      ignore = true;
    };
  }, [deletedPositionIds, deletedTickers]);

  useEffect(() => {
    let cancelled = false;

    async function pollBackgroundRefreshStatus() {
      try {
        const response = await fetch('/api/refresh-status');
        const payload = (await response.json()) as { status?: unknown; error?: string };
        if (!response.ok || payload.error || cancelled) {
          return;
        }

        const nextStatus = normalizeBackgroundRefreshStatus(payload.status);
        if (cancelled) {
          return;
        }

        setBackgroundRefreshStatus(nextStatus);

        if (
          nextStatus.finishedAt &&
          nextStatus.finishedAt !== latestBackgroundRefreshFinishedAtRef.current &&
          nextStatus.status !== 'running'
        ) {
          latestBackgroundRefreshFinishedAtRef.current = nextStatus.finishedAt;
          const snapshotResponse = await fetch('/api/app-state');
          const snapshotPayload = (await snapshotResponse.json()) as { snapshot?: unknown; error?: string };
          if (!snapshotResponse.ok || snapshotPayload.error || !snapshotPayload.snapshot || cancelled) {
            return;
          }

          applyRemoteSnapshot(snapshotPayload.snapshot, '已同步后台刷新后的市场数据');
        }
      } catch {
        // Keep the UI quiet if the background status endpoint is temporarily unavailable.
      }
    }

    void pollBackgroundRefreshStatus();
    const timer = window.setInterval(() => {
      void pollBackgroundRefreshStatus();
    }, 15 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [deletedPositionIds, deletedTickers]);

  useEffect(() => {
    void handleRefreshVix(true);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void handleRefreshVix(true);
    }, 10 * 60 * 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!hasHydratedSnapshotRef.current || !hasLoadedRemoteSnapshotRef.current) {
      return;
    }

    let cancelled = false;

    async function autoRefreshMarketPrices() {
      if (cancelled || isRefreshingAllTickers || refreshingTicker !== null) {
        return;
      }

      if (!isUsMarketOpen()) {
        return;
      }

      const staleEntries = tickerList.filter((entry) => entry.ticker !== '' && isPriceRefreshStale(entry.last_updated));

      if (staleEntries.length === 0) {
        return;
      }

      setPriceRefreshMessage(`当前处于盘中，检测到 ${staleEntries.length} 个股票价格超过 20 分钟未更新，正在自动刷新价格...`);

      for (let index = 0; index < staleEntries.length; index += 1) {
        if (cancelled) {
          return;
        }

        try {
          await refreshTickerMarketData(staleEntries[index], 'price-only');
        } catch {
          // Keep existing value and wait for the next in-session check.
        }

        if (index < staleEntries.length - 1) {
          await sleep(PRICE_REFRESH_GAP_MS);
        }
      }

      if (!cancelled) {
        setPriceRefreshMessage(`盘中自动行情刷新完成，共处理 ${staleEntries.length} 个股票`);
      }
    }

    void autoRefreshMarketPrices();
    const timer = window.setInterval(() => {
      void autoRefreshMarketPrices();
    }, AUTO_PRICE_REFRESH_CHECK_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [tickerList, isRefreshingAllTickers, refreshingTicker]);

  useEffect(() => {
    let cancelled = false;

    async function autoRefreshOptionPrices() {
      if (!hasHydratedSnapshotRef.current) {
        return;
      }

      if (
        cancelled ||
        isRefreshingAllOptionsRef.current ||
        refreshingOptionPriceIdRef.current !== null ||
        autoRefreshingOptionPriceIdRef.current !== null
      ) {
        return;
      }

      if (!shouldRunDailyOptionRefresh()) {
        return;
      }

      const stalePositions = putsRef.current.filter(
        (put) => !isExpiredDate(put.expiration_date) && isOptionRefreshStale(put.option_market_price_updated ?? null)
      );

      if (stalePositions.length === 0) {
        return;
      }

      let successCount = 0;
      let failureCount = 0;
      setAutoRefreshOptionsProgress({
        current: 0,
        total: stalePositions.length,
        successCount: 0,
        failureCount: 0,
        ticker: ''
      });

      try {
        for (let index = 0; index < stalePositions.length; index += 1) {
          const position = stalePositions[index];

          if (cancelled) {
            return;
          }

          setAutoRefreshOptionsProgress({
            current: index + 1,
            total: stalePositions.length,
            successCount,
            failureCount,
            ticker: position.ticker
          });

          try {
            setAutoRefreshingOptionPriceId(position.id);
            setOptionPriceMessages((current) => ({
              ...current,
              [position.id]: {
                tone: 'info',
                text: '系统正在自动刷新期权价格...'
              }
            }));
            await refreshSingleOptionPriceWithRetry(position, true);
            successCount += 1;
          } catch {
            failureCount += 1;
            // Keep existing option price and retry on the next scheduled check.
          } finally {
            if (!cancelled) {
              setAutoRefreshingOptionPriceId(null);
            }
          }

          setAutoRefreshOptionsProgress({
            current: index + 1,
            total: stalePositions.length,
            successCount,
            failureCount,
            ticker: position.ticker
          });

          if (index < stalePositions.length - 1) {
            await sleep(PRICE_REFRESH_GAP_MS);
          }
        }
      } finally {
        if (!cancelled) {
          setAutoRefreshOptionsProgress(null);
        }
      }
    }

    void autoRefreshOptionPrices();
    const timer = window.setInterval(() => {
      void autoRefreshOptionPrices();
    }, AUTO_OPTION_REFRESH_CHECK_MS);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!hasHydratedSnapshotRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      const snapshot = buildAppStateSnapshot({
        config,
        puts,
        closedTrades,
        stockTrades,
        tickerList,
        scenario,
        vixHistory,
        accountValueHistory
      });

      void fetch('/api/app-state', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(snapshot)
      }).catch(() => {
        // Keep the UI quiet; manual Save remains available if the backend write fails.
      });
    }, 800);

    return () => window.clearTimeout(timer);
  }, [accountValueHistory, closedTrades, config, puts, tickerList, scenario, vixHistory]);

  useEffect(() => {
    if (!hasHydratedSnapshotRef.current || puts.length === 0) {
      return;
    }

    const today = getTodayDateInput();
    const { expiredRows, nextPuts, nextClosedTrades } = expireOpenPositions(puts, closedTrades, today, generateId);

    if (expiredRows.length === 0) {
      return;
    }

    const nextDeletedPositionIds = [...deletedPositionIds, ...expiredRows.map((put) => put.id)]
      .filter(Boolean)
      .filter((value, index, array) => array.indexOf(value) === index)
      .sort();
    saveClosedTrades(nextClosedTrades);
    savePuts(nextPuts);
    saveDeletedPositionIds(nextDeletedPositionIds);
    setClosedTrades(nextClosedTrades);
    setPuts(nextPuts);
    setDeletedPositionIds(nextDeletedPositionIds);

    if (editingPutId && expiredRows.some((put) => put.id === editingPutId)) {
      setEditingPutId(null);
      setPutForm(createEmptyPut());
      setPutErrors({});
    }

    setImportExportMessage(`已自动按到期处理 ${expiredRows.length} 笔 Put，并记入历史记录`);
  }, [closedTrades, deletedPositionIds, editingPutId, puts]);

  const stockHoldings = useMemo(() => {
    const stockEntries = tickerList.filter((entry) => (entry.shares ?? 0) > 0);
    const callTickers = [...new Set(puts.filter((row) => row.option_side === 'call').map((row) => row.ticker))];
    const holdingTickers = [...new Set([...stockEntries.map((entry) => entry.ticker), ...callTickers])];

    return holdingTickers
      .map((ticker) => {
        const stockEntry = tickerList.find((entry) => entry.ticker === ticker);
        const callRows = puts.filter((row) => row.ticker === ticker && row.option_side === 'call');
        const distinctStrikes = [...new Set(callRows.map((row) => row.put_strike))].sort((a, b) => a - b);
        const callContracts = callRows.reduce((sum, row) => sum + row.contracts, 0);
        const callPremiumIncome = callRows.reduce(
          (sum, row) => sum + row.premium_per_share * row.contracts * 100,
          0
        );
        const callUnrealizedPnl = callRows.reduce((sum, row) => {
          if (typeof row.option_market_price_per_share !== 'number') {
            return sum;
          }

          return sum + (row.premium_per_share - row.option_market_price_per_share) * row.contracts * 100;
        }, 0);
        const coveredCallShares = callRows.reduce((sum, row) => sum + row.contracts * 100, 0);
        const shares = stockEntry?.shares ?? 0;
        const currentPrice = stockEntry?.current_price ?? null;
        const marketValue = shares * (currentPrice ?? 0);
        const stockRisk = calculateHoldingStockRisk(stockEntry);
        const stockRiskFloor = marketValue * 0.02;
        const coveredRatio = shares > 0 ? Math.min(coveredCallShares / shares, 1) : 0;
        const callOffset = callPremiumIncome * coveredRatio;
        const netStockRisk = shares > 0 ? Math.max(stockRisk - callOffset, stockRiskFloor) : 0;
        const strikeDistances = callRows
          .map((row) => getPercentDistanceToStrike(currentPrice, row.put_strike, 'call'))
          .filter((value): value is number => value !== null);

        return {
          ticker,
          shares,
          averageCost: stockEntry?.average_cost_basis,
          currentPrice,
          callRows: [...callRows]
            .map((row) => ({
              ...row,
              premiumIncome: row.premium_per_share * row.contracts * 100,
              unrealizedPnl:
                typeof row.option_market_price_per_share === 'number'
                  ? (row.premium_per_share - row.option_market_price_per_share) * row.contracts * 100
                  : null
            }))
            .sort((a, b) => {
              const aDistance = Math.abs(getPercentDistanceToStrike(currentPrice, a.put_strike, 'call') ?? Number.POSITIVE_INFINITY);
              const bDistance = Math.abs(getPercentDistanceToStrike(currentPrice, b.put_strike, 'call') ?? Number.POSITIVE_INFINITY);
              return aDistance - bDistance;
            }),
          hasStockHolding: shares > 0,
          marketValue,
          summaryValue: shares > 0 ? marketValue : callPremiumIncome,
          stockRisk,
          callOffset,
          netStockRisk,
          unrealizedPnlAmount:
            typeof stockEntry?.average_cost_basis === 'number' &&
            typeof currentPrice === 'number' &&
            shares > 0
              ? (currentPrice - stockEntry.average_cost_basis) * shares
              : null,
          unrealizedPnlPct:
            typeof stockEntry?.average_cost_basis === 'number' &&
            stockEntry.average_cost_basis > 0 &&
            typeof currentPrice === 'number' &&
            shares > 0
              ? (currentPrice - stockEntry.average_cost_basis) / stockEntry.average_cost_basis
              : null,
          callCount: callContracts,
          coveredCallShares,
          callPremiumIncome,
          nearestStrikeDistancePct: strikeDistances.length > 0 ? Math.min(...strikeDistances) : null,
          callUnrealizedPnl: callRows.some((row) => typeof row.option_market_price_per_share === 'number')
            ? callUnrealizedPnl
            : null,
          callSectionLabel: 'Call 持仓',
          callStrikeLabel:
            distinctStrikes.length === 0
              ? ''
              : distinctStrikes.length === 1
                ? String(distinctStrikes[0])
                : distinctStrikes.slice(0, 2).join(' / ')
        };
      })
      .sort((a, b) => {
        const aNearStrike = a.nearestStrikeDistancePct !== null && a.nearestStrikeDistancePct <= 0.02;
        const bNearStrike = b.nearestStrikeDistancePct !== null && b.nearestStrikeDistancePct <= 0.02;
        if (aNearStrike !== bNearStrike) {
          return aNearStrike ? -1 : 1;
        }
        if ((a.nearestStrikeDistancePct ?? Number.POSITIVE_INFINITY) !== (b.nearestStrikeDistancePct ?? Number.POSITIVE_INFINITY)) {
          return (a.nearestStrikeDistancePct ?? Number.POSITIVE_INFINITY) - (b.nearestStrikeDistancePct ?? Number.POSITIVE_INFINITY);
        }
        if (b.summaryValue !== a.summaryValue) {
          return b.summaryValue - a.summaryValue;
        }
        if (b.shares !== a.shares) {
          return b.shares - a.shares;
        }
        if (b.callCount !== a.callCount) {
          return b.callCount - a.callCount;
        }
        return a.ticker.localeCompare(b.ticker);
      });
  }, [puts, tickerList]);
  const totalStockMarketValue = useMemo(
    () => stockHoldings.reduce((sum, holding) => sum + holding.marketValue, 0),
    [stockHoldings]
  );
  const stockExtremeSignals = useMemo(
    () =>
      tickerList
        .map((entry) => buildStockExtremeSignal(entry))
        .filter((item): item is StockExtremeSignal => item !== null)
        .sort((a, b) => b.score - a.score),
    [tickerList]
  );
  const mostOverboughtStocks = useMemo(
    () => stockExtremeSignals.filter((item) => item.direction === 'overbought').slice(0, 3),
    [stockExtremeSignals]
  );
  const mostOversoldStocks = useMemo(
    () => stockExtremeSignals.filter((item) => item.direction === 'oversold').slice(0, 3),
    [stockExtremeSignals]
  );
  const topIvRankStocks = useMemo(() => buildTopIvRankStocks(tickerList, 5), [tickerList]);

  const riskTickersWithOptionLoss = useMemo(() => {
    const putRows = metrics.putRows.filter((row) => row.option_side !== 'call');
    const optionLossByTicker = new Map<string, number>();
    const premiumIncomeByTicker = new Map<string, number>();
    const putRowsByTicker = new Map<string, PutRiskRow[]>();

    for (const row of putRows) {
      const unrealizedPnl = row.unrealizedPnl ?? 0;
      const lossAmount = unrealizedPnl < 0 ? Math.abs(unrealizedPnl) : 0;
      optionLossByTicker.set(row.ticker, (optionLossByTicker.get(row.ticker) ?? 0) + lossAmount);
      premiumIncomeByTicker.set(row.ticker, (premiumIncomeByTicker.get(row.ticker) ?? 0) + row.premiumIncome);
      putRowsByTicker.set(row.ticker, [...(putRowsByTicker.get(row.ticker) ?? []), row]);
    }

    return metrics.groupedTickerRisk
      .map((item) => ({
        ticker: item.ticker,
        risk: item.risk,
        nearestStrikeDistancePct: (() => {
          const positions = putRowsByTicker.get(item.ticker) ?? [];
          const distances = positions
            .map((row) => getPercentDistanceToStrike(tickerList.find((entry) => entry.ticker === item.ticker)?.current_price, row.put_strike, 'put'))
            .filter((value): value is number => value !== null);

          return distances.length > 0 ? Math.min(...distances) : null;
        })(),
        totalOptionPnl: putRows
          .filter((row) => row.ticker === item.ticker)
          .reduce((sum, row) => sum + (row.unrealizedPnl ?? 0), 0),
        totalOptionLoss: optionLossByTicker.get(item.ticker) ?? 0,
        totalPremiumIncome: premiumIncomeByTicker.get(item.ticker) ?? 0,
        positions: [...(putRowsByTicker.get(item.ticker) ?? [])].sort((a, b) => {
          const distanceDiff =
            (getPercentDistanceToStrike(tickerList.find((entry) => entry.ticker === item.ticker)?.current_price, a.put_strike, 'put') ?? Number.POSITIVE_INFINITY) -
            (getPercentDistanceToStrike(tickerList.find((entry) => entry.ticker === item.ticker)?.current_price, b.put_strike, 'put') ?? Number.POSITIVE_INFINITY);
          if (distanceDiff !== 0) {
            return distanceDiff;
          }
          if (b.putRisk !== a.putRisk) {
            return b.putRisk - a.putRisk;
          }
          if (b.put_strike !== a.put_strike) {
            return b.put_strike - a.put_strike;
          }
          return a.expiration_date.localeCompare(b.expiration_date);
        })
      }))
      .sort((a, b) => {
        const aNearStrike = a.nearestStrikeDistancePct !== null && a.nearestStrikeDistancePct <= 0.02;
        const bNearStrike = b.nearestStrikeDistancePct !== null && b.nearestStrikeDistancePct <= 0.02;
        if (aNearStrike !== bNearStrike) {
          return aNearStrike ? -1 : 1;
        }
        if ((a.nearestStrikeDistancePct ?? Number.POSITIVE_INFINITY) !== (b.nearestStrikeDistancePct ?? Number.POSITIVE_INFINITY)) {
          return (a.nearestStrikeDistancePct ?? Number.POSITIVE_INFINITY) - (b.nearestStrikeDistancePct ?? Number.POSITIVE_INFINITY);
        }
        return b.risk - a.risk;
      });
  }, [metrics.groupedTickerRisk, metrics.putRows, tickerList]);
  const stockLossAlertThreshold = (config?.cash ?? 0) * 0.01;

  const combinedHoldings = useMemo(() => {
    const putMap = new Map(riskTickersWithOptionLoss.map((item) => [item.ticker, item]));
    const stockMap = new Map(stockHoldings.map((item) => [item.ticker, item]));
    const tickers = [...new Set([...riskTickersWithOptionLoss.map((item) => item.ticker), ...stockHoldings.map((item) => item.ticker)])];

    return tickers
      .map((ticker) => {
        const putHolding = putMap.get(ticker) ?? null;
        const stockHolding = stockMap.get(ticker) ?? null;
        const totalOptionPremiumIncome = (putHolding?.totalPremiumIncome ?? 0) + (stockHolding?.callPremiumIncome ?? 0);
        const putPnl = putHolding?.totalOptionPnl ?? 0;
        const callPnl = stockHolding?.callUnrealizedPnl ?? 0;
        const stockPnl = stockHolding?.unrealizedPnlAmount ?? 0;
        const stockCostBasis =
          stockHolding && stockHolding.hasStockHolding && stockHolding.averageCost != null
            ? stockHolding.averageCost * stockHolding.shares
            : 0;
        const totalPnl = stockPnl + putPnl + callPnl;
        const totalPnlBasis = stockCostBasis + totalOptionPremiumIncome;
        const totalPnlPct = totalPnlBasis > 0 ? totalPnl / totalPnlBasis : null;
        const currentValue = (stockHolding?.marketValue ?? 0) + putPnl + callPnl;
        const nearestStrikeCandidates = [putHolding?.nearestStrikeDistancePct ?? null, stockHolding?.nearestStrikeDistancePct ?? null]
          .filter((value): value is number => value !== null);
        const nearestStrikeDistancePct =
          nearestStrikeCandidates.length > 0
            ? nearestStrikeCandidates.reduce((best, current) =>
                Math.abs(current) < Math.abs(best) ? current : best
              )
            : null;
        const displayValue =
          stockHolding?.hasStockHolding
            ? stockHolding.summaryValue
            : totalOptionPremiumIncome > 0
              ? totalOptionPremiumIncome
              : putHolding?.risk ?? 0;
        const isAlert =
          (putHolding !== null &&
            putHolding.totalOptionLoss >= putHolding.totalPremiumIncome * 2 &&
            putHolding.totalOptionLoss > 0) ||
          (stockHolding !== null &&
            stockHolding.unrealizedPnlAmount !== null &&
            stockHolding.unrealizedPnlAmount < 0 &&
            Math.abs(stockHolding.unrealizedPnlAmount) >= stockLossAlertThreshold);

        return {
          ticker,
          putHolding,
          stockHolding,
          totalOptionPremiumIncome,
          putPnl,
          callPnl,
          stockPnl,
          totalPnlPct,
          currentValue,
          displayValue,
          nearestStrikeDistancePct,
          isAlert
        };
      })
      .sort((a, b) => {
        const aPutRisk = a.putHolding?.risk ?? -1;
        const bPutRisk = b.putHolding?.risk ?? -1;
        if (aPutRisk !== bPutRisk) {
          return bPutRisk - aPutRisk;
        }
        if (a.displayValue !== b.displayValue) {
          return b.displayValue - a.displayValue;
        }
        return a.ticker.localeCompare(b.ticker);
      });
  }, [riskTickersWithOptionLoss, stockHoldings, stockLossAlertThreshold]);
  const sortedClosedTrades = useMemo(
    () => [...closedTrades].sort((a, b) => b.closed_at.localeCompare(a.closed_at)),
    [closedTrades]
  );
  const unifiedHistory = useMemo(() => {
    const optionItems = sortedClosedTrades.map((trade) => ({
      kind: 'option' as const,
      id: trade.id,
      timestamp: trade.closed_at,
      realizedPnl: trade.realized_pnl,
      trade
    }));
    const stockItems = stockTrades.map((trade) => ({
      kind: 'stock' as const,
      id: trade.id,
      timestamp: trade.traded_at,
      realizedPnl: trade.realized_pnl,
      trade
    }));

    return [...optionItems, ...stockItems].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }, [sortedClosedTrades, stockTrades]);
  const visibleHistoryItems = useMemo(() => {
    if (historyFilter === 'profit') {
      return unifiedHistory.filter((item) => item.realizedPnl > 0);
    }

    if (historyFilter === 'loss') {
      return unifiedHistory.filter((item) => item.realizedPnl < 0);
    }

    return unifiedHistory;
  }, [historyFilter, unifiedHistory]);
  const historySummary = useMemo(() => {
    const totalRealizedPnl = unifiedHistory.reduce((sum, item) => sum + item.realizedPnl, 0);
    const totalClosed = unifiedHistory.length;
    const wins = unifiedHistory.filter((item) => item.realizedPnl > 0).length;
    const losses = unifiedHistory.filter((item) => item.realizedPnl < 0).length;
    const breakEven = totalClosed - wins - losses;

    return {
      totalRealizedPnl,
      totalClosed,
      wins,
      losses,
      breakEven,
      winRate: totalClosed > 0 ? wins / totalClosed : 0
    };
  }, [unifiedHistory]);
  const dailyVixHistory = useMemo(() => compressVixHistory(vixHistory), [vixHistory]);
  const visibleVixHistory = useMemo(() => dailyVixHistory.slice(-30), [dailyVixHistory]);
  const latestVixPoint = dailyVixHistory[dailyVixHistory.length - 1] ?? null;
  const attentionRows = useMemo(
    () =>
      metrics.putRows
        .map((row) => {
          const level = getAttentionLevel(row);
          if (!level) {
            return null;
          }

          return {
            row,
            level,
            reasons: getAttentionReasons(row)
          };
        })
        .filter((item): item is { row: PutRiskRow; level: 'red' | 'yellow'; reasons: string[] } => item !== null)
        .sort((a, b) => {
          const levelRank = { red: 0, yellow: 1 };
          if (levelRank[a.level] !== levelRank[b.level]) {
            return levelRank[a.level] - levelRank[b.level];
          }

          const dteGap = a.row.daysToExpiration - b.row.daysToExpiration;
          if (dteGap !== 0) {
            return dteGap;
          }

          return (b.row.premiumCapturedPct ?? 0) - (a.row.premiumCapturedPct ?? 0);
        }),
    [metrics.putRows]
  );
  const inTheMoneyRows = useMemo(
    () =>
      metrics.putRows
        .filter((row) => {
          const tickerEntry = tickerMap.get(row.ticker);
          return isRowInTheMoney(row, tickerEntry?.current_price);
        })
        .sort(compareOptionRowsByLossPct),
    [metrics.putRows, tickerMap]
  );
  const peakVixPoint = useMemo(
    () => visibleVixHistory.reduce<VixHistoryPoint | null>((peak, point) => (!peak || point.value > peak.value ? point : peak), null),
    [visibleVixHistory]
  );
  const remainingCashAmount = Math.max((config?.cash ?? 0) - metrics.totalNominalPutExposure, 0);
  const overallCapitalAmount = remainingCashAmount + metrics.totalNominalPutExposure + totalStockMarketValue;
  const remainingCashPct = overallCapitalAmount > 0 ? remainingCashAmount / overallCapitalAmount : 0;
  const accountCapitalBase = metrics.totalCapitalBase > 0 ? metrics.totalCapitalBase : overallCapitalAmount;
  const accountValueComparisons = useMemo(
    () => buildAccountValueComparisons(accountValueHistory, accountCapitalBase),
    [accountCapitalBase, accountValueHistory]
  );
  useEffect(() => {
    if (!isSnapshotHydrated) {
      return;
    }

    setAccountValueHistory((current) => upsertDailyAccountValueSnapshot(current, accountCapitalBase));
  }, [accountCapitalBase, isSnapshotHydrated]);
  const insightLines = useMemo(() => {
    return [
      ...accountValueComparisons.map((item) =>
        item.changeAmount === null
          ? `${item.label}：暂无历史基线`
          : `${item.label}：${formatSignedCurrency(item.changeAmount)}（${formatSignedPercent(item.changePct ?? 0)}）`
      ),
      ...(metrics.missingStockBetaTickers.length > 0
        ? [`Beta 忘记输入了：${metrics.missingStockBetaTickers.join('、')}`]
        : []),
      mostOverboughtStocks.length > 0
        ? `${mostOverboughtStocks[0].ticker}（1D ${mostOverboughtStocks[0].rsiDaily?.toFixed(1) ?? '-'} / 1H ${mostOverboughtStocks[0].rsiHourly?.toFixed(1) ?? '-'}）`
        : '当前没有明显超买股票',
      mostOversoldStocks.length > 0
        ? `${mostOversoldStocks[0].ticker}（1D ${mostOversoldStocks[0].rsiDaily?.toFixed(1) ?? '-'} / 1H ${mostOversoldStocks[0].rsiHourly?.toFixed(1) ?? '-'}）`
        : '当前没有明显超卖股票',
      metrics.canAddMoreRisk
        ? `还可增加 Put 风险：${formatCurrency(metrics.remainingRiskBudget)}`
        : '当前已超过风险预算，建议暂停新增 Option 仓位',
      `Put Risk % of Cash：${formatPercent(metrics.portfolioRiskPctOfCash)}`,
      `Total Risk % of Total Capital：${formatPercent(metrics.totalRiskPctOfTotalCapital)}`,
      `目前年化收益率（总资金）：${formatPercent(metrics.annualizedYieldOnTotalCash)}`,
      `Total option premium income：${formatCurrency(metrics.totalPremiumIncome)}`,
      `Option theta income / day：${formatCurrency(metrics.estimatedThetaIncomePerDay)}`,
      `Option theta income / month：${formatCurrency(metrics.estimatedThetaIncomePerMonth)}`
    ];
  }, [accountValueComparisons, metrics, mostOverboughtStocks, mostOversoldStocks]);

  const compactInsightLines = insightLines;
  const capitalAllocationChart = useMemo(
    () => buildCapitalAllocationChart(totalStockMarketValue, metrics.totalNominalPutExposure, remainingCashAmount),
    [metrics.totalNominalPutExposure, remainingCashAmount, totalStockMarketValue]
  );
  const tickerAllocationItems = useMemo(
    () => buildTickerAllocationItems(stockHoldings, metrics.putRows),
    [metrics.putRows, stockHoldings]
  );
  const riskCalculatorDropPct = useMemo(() => {
    const raw = percentInputToDecimal(riskCalculatorDropInput);
    if (!Number.isFinite(raw)) {
      return 0;
    }

    return Math.min(Math.max(raw, -0.3), 0.3);
  }, [riskCalculatorDropInput]);
  const riskCalculator = useMemo(
    () => buildRiskCalculator(puts, tickerList, riskCalculatorDropPct, accountCapitalBase),
    [accountCapitalBase, puts, riskCalculatorDropPct, tickerList]
  );
  const riskCurvePoints = useMemo(
    () => buildRiskCurvePoints(puts, tickerList, accountCapitalBase),
    [accountCapitalBase, puts, tickerList]
  );
  const baseRiskScore = metrics.riskScore;
  const regimeAdjustment = getRegimeAdjustment(vixSnapshot?.fearGreedScore ?? null);
  const finalSellingScore = Math.max(0, baseRiskScore + regimeAdjustment);
  const finalSellingScoreLevel = getSellingScoreLevel(finalSellingScore);
  const availablePositionTickers = [...new Set(metrics.putRows.map((row) => row.ticker))].sort();
  const compactSuggestedActionLabel = stressAdjustment.action;
  const visiblePutRows = metrics.putRows
    .filter((row) => positionTickerFilter === 'ALL' || row.ticker === positionTickerFilter)
    .filter((row) => {
      if (positionOptionTypeFilter === 'ALL') {
        return true;
      }

      return positionOptionTypeFilter === 'CALL' ? row.option_side === 'call' : row.option_side !== 'call';
    })
    .filter((row) => {
      if (positionFilter === 'ALL') {
        return true;
      }

      if (positionFilter === 'WITHIN_7_DAYS') {
        return row.daysToExpiration >= 0 && row.daysToExpiration <= 7;
      }

      return (row.premiumCapturedPct ?? 0) >= 0.6;
    })
    .filter((row) => {
      if (moneynessFilter === 'ALL') {
        return true;
      }

      const tickerEntry = tickerMap.get(row.ticker);
      if (!tickerEntry?.current_price || tickerEntry.current_price <= 0) {
        return false;
      }

      const isInTheMoney = isRowInTheMoney(row, tickerEntry.current_price);
      return moneynessFilter === 'ITM' ? isInTheMoney : !isInTheMoney;
    })
    .sort((a, b) => {
      if (positionSort === 'EXPIRATION') {
        return a.expiration_date.localeCompare(b.expiration_date) || a.ticker.localeCompare(b.ticker);
      }

      if (positionSort === 'PUT_RISK') {
        if (b.putRisk !== a.putRisk) {
          return b.putRisk - a.putRisk;
        }
        return a.expiration_date.localeCompare(b.expiration_date);
      }

      if (positionSort === 'LOSS_PCT') {
        const aLossPct = typeof a.premiumCapturedPct === 'number' ? a.premiumCapturedPct : Number.POSITIVE_INFINITY;
        const bLossPct = typeof b.premiumCapturedPct === 'number' ? b.premiumCapturedPct : Number.POSITIVE_INFINITY;
        if (aLossPct !== bLossPct) {
          return aLossPct - bLossPct;
        }
        return b.putRisk - a.putRisk;
      }

      if (positionSort === 'ANNUALIZED_YIELD') {
        if (b.annualizedYield !== a.annualizedYield) {
          return b.annualizedYield - a.annualizedYield;
        }
        return b.putRisk - a.putRisk;
      }

      if (a.ticker !== b.ticker) {
        return a.ticker.localeCompare(b.ticker);
      }
      return a.expiration_date.localeCompare(b.expiration_date);
    });

  useEffect(() => {
    if (activeTab !== 'positions' || pendingPositionScrollId === null) {
      return;
    }

    const target = positionCardRefs.current[pendingPositionScrollId];
    if (!target) {
      return;
    }

    const timer = window.setTimeout(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setPendingPositionScrollId(null);
    }, 80);

    return () => window.clearTimeout(timer);
  }, [activeTab, pendingPositionScrollId, visiblePutRows]);

  useEffect(() => {
    if (activeTab !== 'stocks' || pendingStockScrollTicker === null) {
      return;
    }

    const target = stockRowRefs.current[pendingStockScrollTicker];
    if (!target) {
      return;
    }

    const timer = window.setTimeout(() => {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setPendingStockScrollTicker(null);
    }, 80);

    return () => window.clearTimeout(timer);
  }, [activeTab, pendingStockScrollTicker, tickerList]);
  const putFormDaysToExpiration = getDaysToExpirationForPreview(putForm.date_sold, putForm.expiration_date);
  const putFormNominalExposure = putForm.put_strike * putForm.contracts * 100;
  const putFormPremiumIncome = putForm.premium_per_share * putForm.contracts * 100;
  const putFormAnnualizedYield =
    putFormNominalExposure > 0 && putFormDaysToExpiration > 0
      ? (putFormPremiumIncome / putFormNominalExposure) * (365 / putFormDaysToExpiration)
      : 0;

  async function handleRefreshVix(silent = false) {
    if (!silent) {
      setVixMessage('');
    }

    try {
      const response = await fetch('/api/vix');
      const payload = (await response.json()) as {
        value?: number;
        as_of?: string;
        fear_greed_score?: number | null;
        fear_greed_rating?: string | null;
        fear_greed_status?: string | null;
        fear_greed_error?: string | null;
        storage_driver?: string | null;
        cache_write_ok?: boolean | null;
        cache_write_error?: string | null;
        error?: string;
      };

      if (!response.ok || payload.error || typeof payload.value !== 'number') {
        throw new Error(payload.error ?? 'VIX 刷新失败');
      }

      setVixSnapshot({
        value: payload.value,
        asOf: payload.as_of ?? new Date().toISOString(),
        fearGreedScore: typeof payload.fear_greed_score === 'number' ? payload.fear_greed_score : null,
        fearGreedRating: typeof payload.fear_greed_rating === 'string' ? payload.fear_greed_rating : null,
        fearGreedStatus: typeof payload.fear_greed_status === 'string' ? payload.fear_greed_status : null,
        fearGreedError: typeof payload.fear_greed_error === 'string' ? payload.fear_greed_error : null,
        storageDriver: typeof payload.storage_driver === 'string' ? payload.storage_driver : null,
        cacheWriteOk: typeof payload.cache_write_ok === 'boolean' ? payload.cache_write_ok : null,
        cacheWriteError: typeof payload.cache_write_error === 'string' ? payload.cache_write_error : null
      });

      const nextHistoryPoint: VixHistoryPoint = {
        timestamp: payload.as_of ?? new Date().toISOString(),
        value: payload.value,
        stress: getAutoStressByVix(payload.value)
      };
      setVixHistory((current) => compressVixHistory([...current, nextHistoryPoint]));

      if (!silent) {
        setVixMessage(`已更新 VIX ${payload.value.toFixed(2)}`);
      }
    } catch (error) {
      if (!silent) {
        setVixMessage(error instanceof Error ? error.message : 'VIX 刷新失败');
      }
    }
  }

  async function handleSaveConfig() {
    const errors = validateConfig(configForm);
    setConfigErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setConfig(configForm);
    saveConfig(configForm);
    await handleSaveAppState(configForm);
  }

  async function runPutChecksAndSave(normalized: PutPosition): Promise<'saved' | 'blocked' | 'error'> {
    const nextPuts = editingPutId
      ? puts.map((item) => (item.id === editingPutId ? normalized : item))
      : [...puts, { ...normalized, id: normalized.id || generateId() }];
    const nextMetrics = calculatePortfolioMetrics(config, nextPuts, tickerList, activeScenario);
    const shouldApplyRiskGate = shouldApplySellPutRiskGate(normalized.option_side);
    const nextRegimeAdjustment = getRegimeAdjustment(vixSnapshot?.fearGreedScore ?? null);
    const nextFinalSellingScore = Math.max(0, nextMetrics.riskScore + nextRegimeAdjustment);
    const exceedsRiskScoreLimit = shouldApplyRiskGate && nextFinalSellingScore > 80;
    const currentVixValue = vixSnapshot?.value ?? latestVixPoint?.value ?? null;
    const isLowVixRegime = currentVixValue !== null && currentVixValue < 20;
    const isRisingLowMidVixRegime =
      currentVixValue !== null && currentVixValue >= 20 && currentVixValue < 25 && stressAdjustment.mode === 'rising';
    const shouldBlockOnLowVixAndRiskScore =
      shouldApplyRiskGate && (isLowVixRegime || isRisingLowMidVixRegime) && nextFinalSellingScore > 60;

    setIsCheckingPut(true);
    setPutCheckResult(null);

    try {
      const selectedTicker = tickerList.find((entry) => entry.ticker === normalized.ticker) ?? null;
      const query = new URLSearchParams({
        symbol: normalized.ticker,
        strike: String(normalized.put_strike),
        beta: String(selectedTicker?.beta ?? ''),
        date_sold: normalized.date_sold,
        expiration_date: normalized.expiration_date
      });

      if (selectedTicker?.current_price !== null && selectedTicker?.current_price !== undefined) {
        query.set('cached_current_price', String(selectedTicker.current_price));
      }
      if (selectedTicker?.rsi_14 !== null && selectedTicker?.rsi_14 !== undefined) {
        query.set('cached_rsi_14', String(selectedTicker.rsi_14));
      }
      if (selectedTicker?.ma_21 !== null && selectedTicker?.ma_21 !== undefined) {
        query.set('cached_ma_20', String(selectedTicker.ma_21));
      }
      if (selectedTicker?.current_iv !== null && selectedTicker?.current_iv !== undefined) {
        query.set('cached_current_iv', String(selectedTicker.current_iv));
      }

      if (selectedTicker?.provider_exchange) {
        query.set('exchange', selectedTicker.provider_exchange);
      }
      if (selectedTicker?.provider_mic_code) {
        query.set('mic_code', selectedTicker.provider_mic_code);
      }

      query.set('side', normalized.option_side === 'call' ? 'call' : 'put');

      const response = await fetch(`/api/put-check?${query.toString()}`);
      const payload = (await response.json()) as PutEntryCheckResponse & { error?: string; failures?: string[] };

      if (!response.ok || payload.error) {
        throw new Error(payload.error ?? payload.failures?.[0] ?? `${getOptionSideLabel(normalized.option_side)} 检查失败`);
      }

      setPutCheckResult(payload);

      if (payload.metrics) {
        const nextEntry: TickerEntry = {
          ticker: normalized.ticker,
          beta: selectedTicker?.beta ?? null,
          shares: selectedTicker?.shares ?? null,
          average_cost_basis: selectedTicker?.average_cost_basis ?? null,
          downside_tolerance_pct: selectedTicker?.downside_tolerance_pct ?? null,
          current_price: payload.metrics.current_price,
          last_updated: payload.metrics.as_of,
          next_earnings_date: selectedTicker?.next_earnings_date ?? null,
          current_iv: payload.metrics.current_iv,
          current_iv_updated: payload.metrics.current_iv === null ? selectedTicker?.current_iv_updated ?? null : payload.metrics.as_of,
          historical_iv: selectedTicker?.historical_iv ?? null,
          iv_rank: selectedTicker?.iv_rank ?? null,
          iv_percentile: selectedTicker?.iv_percentile ?? null,
          put_call_ratio: selectedTicker?.put_call_ratio ?? null,
          put_call_ratio_updated: selectedTicker?.put_call_ratio_updated ?? null,
          provider_exchange: selectedTicker?.provider_exchange ?? null,
          provider_mic_code: selectedTicker?.provider_mic_code ?? null,
          rsi_14: payload.metrics.rsi_14,
          rsi_14_1h: selectedTicker?.rsi_14_1h ?? null,
          rsi_updated: payload.metrics.as_of,
          ma_21: selectedTicker?.ma_21 ?? null,
          ma_200: selectedTicker?.ma_200 ?? null
        };

        setTickerList((current) =>
          current.some((entry) => entry.ticker === normalized.ticker)
            ? current.map((entry) => (entry.ticker === normalized.ticker ? { ...entry, ...nextEntry } : entry))
            : [...current, nextEntry].sort((a, b) => a.ticker.localeCompare(b.ticker))
        );
      }

      if (exceedsRiskScoreLimit) {
        setPutCheckResult({
          ok: false,
          summary: 'Final selling score 高于 80，默认不能卖',
          failures: [
            `这笔${getOptionSideLabel(normalized.option_side)}保存后，Base score ${nextMetrics.riskScore} + Regime adjustment ${nextRegimeAdjustment >= 0 ? '+' : ''}${nextRegimeAdjustment} = ${nextFinalSellingScore}`,
            '默认禁止交易；如果你确认要执行，需要点 Process Anyway'
          ]
        });
        setForceSellCandidate(normalized);
        return 'blocked';
      }

      if (shouldBlockOnLowVixAndRiskScore) {
        setPutCheckResult({
          ok: false,
          summary: '当前低波动环境下，Risk Score 高于 60，默认不要卖',
          failures: [
            currentVixValue !== null
              ? `当前 VIX ${currentVixValue.toFixed(2)}，属于${isLowVixRegime ? '低波动区' : '20-25 且持续上升区'}`
              : `当前 VIX 环境偏不利于继续做${getOptionSideLabel(normalized.option_side)}`,
            `这笔${getOptionSideLabel(normalized.option_side)}保存后，Base score ${nextMetrics.riskScore} + Regime adjustment ${nextRegimeAdjustment >= 0 ? '+' : ''}${nextRegimeAdjustment} = ${nextFinalSellingScore}`,
            '低波动或低中波动上升环境下，Final selling score 超过 60 时建议停止新增仓位；如需继续，请点 Process Anyway'
          ]
        });
        setForceSellCandidate(normalized);
        return 'blocked';
      }

      if (!payload.ok) {
        setForceSellCandidate(normalized);
        return 'blocked';
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : `${getOptionSideLabel(normalized.option_side)} 检查失败`;

      if (shouldAllowForceSellOnCheckError(message)) {
        setPutCheckResult({
          ok: false,
          summary: '检查服务异常，已切换为人工确认',
          failures: [
            message,
            `检查过程中出现脚本错误；如果你确认这笔${getOptionSideLabel(normalized.option_side)}仍然要做，可以点 Process Anyway 继续。`
          ]
        });
        setForceSellCandidate(normalized);
        return 'blocked';
      }

      setPutCheckResult({
        ok: false,
        summary: '有提示风险，不建议执行',
        failures: [message]
      });
      return 'error';
    } finally {
      setIsCheckingPut(false);
    }

    savePutPosition(normalized, editingPutId, setPuts, setTickerList);
    const nextConfig = applyOptionOpenCash(config, configForm ?? DEFAULT_CONFIG, normalized, editingPutId !== null);
    saveConfig(nextConfig);
    setConfig(nextConfig);
    setConfigForm(nextConfig);
    setConfigErrors({});
    setImportExportMessage(`风险检查通过，已保存 ${normalized.ticker} ${getOptionSideLabel(normalized.option_side)}`);
    setActiveTab('positions');
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, 'positions');

    setPutForm(createEmptyPut());
    setPutErrors({});
    setEditingPutId(null);
    return 'saved';
  }

  async function handleSavePut() {
    const normalized = {
      ...putForm,
      ticker: normalizeTicker(putForm.ticker),
      date_sold: putForm.date_sold
    };
    const errors = validatePut(normalized);
    setPutErrors(errors);
    if (Object.keys(errors).length > 0) return;

    setPreTradeCandidate(normalized);
    setPreTradeQuestionnaire(createEmptyPreTradeQuestionnaire());
    setPreTradeError('');
    setPreTradeAnalysis(null);
    setPreTradeContext(null);
  }

  function handleEditPut(put: PutPosition) {
    setPreTradeCandidate(null);
    setPreTradeQuestionnaire(createEmptyPreTradeQuestionnaire());
    setPreTradeError('');
    setPreTradeAnalysis(null);
    setPreTradeContext(null);
    setPutCheckResult(null);
    setEditingPutId(put.id);
    setPutForm(put);
    setImportExportMessage(`正在编辑 ${put.ticker}，已切换到 ${getOptionSideLabel(put.option_side)}`);
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, 'sell');
    setActiveTab('sell');
  }

  useEffect(() => {
    if (!editingPutId) {
      return;
    }

    if (activeTab !== 'sell') {
      setActiveTab('sell');
      return;
    }

    const retryDelays = [80, 220, 420];
    const timers = retryDelays.map((delay) =>
      window.setTimeout(() => {
        addPutSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, delay)
    );

    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [activeTab, editingPutId]);

  function handleDeletePut(id: string) {
    const target = puts.find((item) => item.id === id);
    if (!target) {
      return;
    }

    const nextPuts = puts.filter((item) => item.id !== id);
    const nextMetrics = calculatePortfolioMetrics(config, nextPuts, tickerList, activeScenario);
    setDeletePreview({
      id,
      ticker: target.ticker,
      currentScore: metrics.riskScore,
      nextScore: nextMetrics.riskScore
    });
  }

  function handleOpenClosePut(row: PutRiskRow) {
    setClosePreview({
      row,
      contractsToClose: row.contracts.toString(),
      buybackPremiumPerShare:
        row.option_market_price_per_share != null ? row.option_market_price_per_share.toString() : row.premium_per_share.toString(),
      closedAt: getTodayDateInput(),
      reflectionNotes: ''
    });
  }

  async function refreshSingleOptionPrice(
    position: Pick<
      PutPosition,
      'id' | 'ticker' | 'expiration_date' | 'put_strike' | 'option_side' | 'option_market_price_per_share' | 'option_market_price_updated' | 'option_theta_per_share'
    >,
    silent = false
  ) {
    const response = await fetch(
      `/api/option-price?symbol=${encodeURIComponent(position.ticker)}&expiration_date=${encodeURIComponent(position.expiration_date)}&strike=${encodeURIComponent(String(position.put_strike))}&side=${encodeURIComponent(position.option_side === 'call' ? 'call' : 'put')}`
    );
    const payload = (await response.json()) as {
      option_price_per_share?: number;
      theta_per_share?: number | null;
      as_of?: string;
      error?: string;
    };

    if (!response.ok || payload.error || typeof payload.option_price_per_share !== 'number') {
      throw new Error(payload.error ?? `${position.ticker} 当前期权价格刷新失败`);
    }

    const updatedAt = payload.as_of ?? new Date().toISOString();
    const refreshedOptionPrice = payload.option_price_per_share;
    const preservedTheta = typeof position.option_theta_per_share === 'number' ? position.option_theta_per_share : null;
    const refreshedTheta = typeof payload.theta_per_share === 'number' ? payload.theta_per_share : preservedTheta;

    setOptionPriceOverrides((current) => ({
      ...current,
      [position.id]: {
        price: refreshedOptionPrice,
        theta: refreshedTheta,
        updatedAt
      }
    }));
    setOptionPriceMessages((current) => ({
      ...current,
      [position.id]: {
        tone: 'success',
        text: `已更新 ${formatCurrency(refreshedOptionPrice)}/share`
      }
    }));

    setPuts((current) =>
      current.map((item) =>
        item.id === position.id
          ? {
              ...item,
              option_market_price_per_share: refreshedOptionPrice,
              option_market_price_updated: updatedAt,
              option_theta_per_share: refreshedTheta
            }
          : item
      )
    );

    if (!silent) {
      setImportExportMessage(
        `${position.ticker} ${getOptionSideBadge(position.option_side)} 当前期权价格已更新为 ${formatCurrency(refreshedOptionPrice)}/share`
      );
    }

    return payload;
  }

  async function refreshSingleOptionPriceWithRetry(
    position: Pick<
      PutPosition,
      'id' | 'ticker' | 'expiration_date' | 'put_strike' | 'option_side' | 'option_market_price_per_share' | 'option_market_price_updated' | 'option_theta_per_share'
    >,
    silent = false
  ) {
    try {
      return await refreshSingleOptionPrice(position, silent);
    } catch (error) {
      const message = error instanceof Error ? error.message : '当前期权价格刷新失败';
      if (!isMinuteLimitError(message)) {
        throw error;
      }

      setImportExportMessage(`${position.ticker} 遇到分钟限额，正在放慢节奏后重试...`);
      await sleep(PRICE_REFRESH_RETRY_GAP_MS);
      return refreshSingleOptionPrice(position, silent);
    }
  }

  async function handleRefreshOptionPrice(row: PutRiskRow) {
    setRefreshingOptionPriceId(row.id);
    setImportExportMessage(`正在刷新 ${row.ticker} 期权价格...`);
    setOptionPriceMessages((current) => ({
      ...current,
      [row.id]: {
        tone: 'info',
        text: '正在刷新期权价格...'
      }
    }));

    try {
      const [payload] = await Promise.all([
        refreshSingleOptionPriceWithRetry(row, false),
        new Promise((resolve) => window.setTimeout(resolve, 700))
      ]);
      const refreshedPrice =
        typeof payload.option_price_per_share === 'number'
          ? payload.option_price_per_share
          : row.option_market_price_per_share;
      const unchanged =
        typeof refreshedPrice === 'number' &&
        row.option_market_price_per_share != null &&
        Math.abs(refreshedPrice - row.option_market_price_per_share) < 0.0001;

      setOptionPriceMessages((current) => ({
        ...current,
        [row.id]: {
          tone: 'success',
          text: unchanged
            ? `已刷新，当前期权价格维持 ${formatCurrency(refreshedPrice)}/share`
            : `已更新为 ${formatCurrency(refreshedPrice ?? 0)}/share`
        }
      }));

      if (unchanged && typeof refreshedPrice === 'number') {
        setImportExportMessage(
          `${row.ticker} 期权价格已刷新，当前仍为 ${formatCurrency(refreshedPrice)}/share`
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '当前期权价格刷新失败';
      setImportExportMessage(message);
      setOptionPriceMessages((current) => ({
        ...current,
        [row.id]: {
          tone: 'error',
          text: message
        }
      }));
    } finally {
      setRefreshingOptionPriceId(null);
    }
  }

  async function handleRefreshAllOptionPrices() {
    if (refreshingOptionPriceId !== null) {
      setImportExportMessage('当前有单笔期权正在刷新，请稍后再试全量刷新');
      return;
    }

    if (autoRefreshingOptionPriceId !== null) {
      setImportExportMessage('系统正在自动刷新期权，请稍后再试全量刷新');
      return;
    }

    const positions = puts.filter((put) => !isExpiredDate(put.expiration_date));
    if (positions.length === 0) {
      setImportExportMessage('没有可刷新的期权持仓');
      return;
    }

    setIsRefreshingAllOptions(true);
    setRefreshAllOptionsProgress({
      current: 0,
      total: positions.length,
      successCount: 0,
      failureCount: 0,
      ticker: ''
    });
    setImportExportMessage('');

    let successCount = 0;
    let failureCount = 0;
    const failureMessages: string[] = [];

    try {
      for (let index = 0; index < positions.length; index += 1) {
        const position = positions[index];
        setRefreshAllOptionsProgress({
          current: index + 1,
          total: positions.length,
          successCount,
          failureCount,
          ticker: position.ticker
        });
        setRefreshingOptionPriceId(position.id);
        setOptionPriceMessages((current) => ({
          ...current,
          [position.id]: {
            tone: 'info',
            text: '正在刷新期权价格...'
          }
        }));

        try {
          await refreshSingleOptionPriceWithRetry(position, true);
          successCount += 1;
        } catch (error) {
          failureCount += 1;
          const message = error instanceof Error ? error.message : `${position.ticker} 当前期权价格刷新失败`;
          failureMessages.push(`${position.ticker}: ${message}`);
          setOptionPriceMessages((current) => ({
            ...current,
            [position.id]: {
              tone: 'error',
              text: message
            }
          }));
        } finally {
          setRefreshingOptionPriceId(null);
        }

        setRefreshAllOptionsProgress({
          current: index + 1,
          total: positions.length,
          successCount,
          failureCount,
          ticker: position.ticker
        });

        if (index < positions.length - 1) {
          await sleep(PRICE_REFRESH_GAP_MS);
        }
      }

      setImportExportMessage(
        failureCount > 0
          ? `已刷新 ${successCount} 笔期权，${failureCount} 笔失败：${failureMessages.slice(0, 3).join('；')}${failureMessages.length > 3 ? '……' : ''}`
          : `已刷新全部 ${successCount} 笔期权价格`
      );
    } finally {
      setRefreshAllOptionsProgress(null);
      setIsRefreshingAllOptions(false);
      setRefreshingOptionPriceId(null);
    }
  }

  function confirmDeletePut() {
    if (!deletePreview) {
      return;
    }

    const deleteResult = deleteOpenPositionAndPruneTicker(puts, tickerList, deletePreview.id);
    const nextDeletedPositionIds = [...deletedPositionIds.filter((item) => item !== deletePreview.id), deletePreview.id].sort();
    savePuts(deleteResult.nextPuts);
    saveDeletedPositionIds(nextDeletedPositionIds);
    setPuts(deleteResult.nextPuts);
    setDeletedPositionIds(nextDeletedPositionIds);
    if (deleteResult.removedTicker) {
      saveTickerList(deleteResult.nextTickerList);
      setTickerList(deleteResult.nextTickerList);
      const removedTicker = deleteResult.removedTicker;
      const nextDeletedTickers = [...deletedTickers.filter((item) => item !== removedTicker), removedTicker].sort();
      saveDeletedTickers(nextDeletedTickers);
      setDeletedTickers(nextDeletedTickers);
      if (putForm.ticker === deleteResult.removedTicker) {
        setPutForm((current) => ({ ...current, ticker: '' }));
      }
    }
    if (editingPutId === deletePreview.id) {
      setEditingPutId(null);
      setPutForm(createEmptyPut());
      setPutErrors({});
    }
    setDeletePreview(null);
  }

  async function confirmClosePut() {
    if (!closePreview) {
      return;
    }

    const contractsToClose = Number(closePreview.contractsToClose);
    const buybackPremiumPerShare = Number(closePreview.buybackPremiumPerShare);
    if (!Number.isFinite(contractsToClose) || contractsToClose <= 0 || contractsToClose > closePreview.row.contracts) {
      setImportExportMessage(`平仓张数请输入 1 到 ${closePreview.row.contracts} 之间的有效数字`);
      return;
    }
    if (!Number.isFinite(buybackPremiumPerShare) || buybackPremiumPerShare < 0) {
      setImportExportMessage('买回权利金请输入有效数字');
      return;
    }

    const closeResult = closeOpenPosition(
      puts,
      closedTrades,
      closePreview.row,
      buybackPremiumPerShare,
      closePreview.closedAt,
      closePreview.reflectionNotes,
      generateId,
      contractsToClose
    );
    saveClosedTrades(closeResult.nextClosedTrades);
    savePuts(closeResult.nextPuts);
    setClosedTrades(closeResult.nextClosedTrades);
    setPuts(closeResult.nextPuts);

    const nextConfig = applyOptionCloseCash(config, configForm ?? DEFAULT_CONFIG, buybackPremiumPerShare, contractsToClose);
    saveConfig(nextConfig);
    setConfig(nextConfig);
    setConfigForm(nextConfig);
    setConfigErrors({});

    const isFullyClosed = contractsToClose >= closePreview.row.contracts;
    if (isFullyClosed) {
      const nextDeletedPositionIds = [...deletedPositionIds.filter((item) => item !== closePreview.row.id), closePreview.row.id].sort();
      saveDeletedPositionIds(nextDeletedPositionIds);
      setDeletedPositionIds(nextDeletedPositionIds);
    }

    if (editingPutId === closePreview.row.id && isFullyClosed) {
      setEditingPutId(null);
      setPutForm(createEmptyPut());
      setPutErrors({});
    }

    const successMessage = `已平仓 ${closePreview.row.ticker} ${contractsToClose} 张，已实现盈亏 ${formatCurrency(
      (closePreview.row.premium_per_share - buybackPremiumPerShare) * contractsToClose * 100
    )}`;
    setClosePreview(null);

    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config: nextConfig,
          puts: closeResult.nextPuts,
          closedTrades: closeResult.nextClosedTrades,
          stockTrades,
          tickerList,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        successMessage,
        '平仓后保存失败'
      );
    } catch (error) {
      setImportExportMessage(error instanceof Error ? error.message : '平仓后保存失败');
    }
  }

  function handleEditClosedTrade(trade: ClosedPutTrade) {
    setHistoryEditPreview(buildClosedTradeEditPreview(trade));
  }

  function confirmEditClosedTrade() {
    if (!historyEditPreview) {
      return;
    }

    const parsedPreview = parseClosedTradeEditPreview(historyEditPreview);

    if (!parsedPreview.ok) {
      setImportExportMessage('历史记录编辑失败：请输入有效的行权价、权利金和合约数');
      return;
    }

    setClosedTrades((current) =>
      updateClosedTrade(current, {
        tradeId: historyEditPreview.tradeId,
        ticker: normalizeTicker(historyEditPreview.ticker),
        option_side: historyEditPreview.optionSide,
        putStrike: parsedPreview.values.putStrike,
        premiumSoldPerShare: parsedPreview.values.premiumSoldPerShare,
        premiumBoughtBackPerShare: parsedPreview.values.premiumBoughtBackPerShare,
        contracts: parsedPreview.values.contracts,
        dateSold: historyEditPreview.dateSold,
        expirationDate: historyEditPreview.expirationDate,
        closedAt: historyEditPreview.closedAt,
        closeReason: historyEditPreview.closeReason,
        reflectionNotes: historyEditPreview.reflectionNotes
      })
    );

    setImportExportMessage(`已更新 ${normalizeTicker(historyEditPreview.ticker)} 的历史记录`);
    setHistoryEditPreview(null);
  }

  function handleUpdateClosedTradeReflection(tradeId: string, reflectionNotes: string) {
    setClosedTrades((current) =>
      current.map((trade) => (trade.id === tradeId ? { ...trade, reflection_notes: reflectionNotes } : trade))
    );
  }

  function handleAddTicker() {
    const normalized = normalizeTicker(newTicker);
    if (normalized === '') {
      setTickerMessage('请输入股票代码');
      return;
    }

    if (tickerList.some((entry) => entry.ticker === normalized)) {
      setTickerMessage('该股票已在列表中');
      setDeletedTickers((current) => current.filter((item) => item !== normalized));
      setPutForm((current) => ({ ...current, ticker: normalized }));
      return;
    }

    setTickerList((current) =>
      addTickerEntry(current, {
        ticker: newTicker,
        beta: newTickerBeta,
        shares: newTickerShares,
        averageCostBasis: newTickerAverageCost,
        downsideTolerancePct: newTickerTolerancePct,
        providerExchange: newTickerExchange,
        providerMicCode: newTickerMicCode
      })
    );
    setDeletedTickers((current) => current.filter((item) => item !== normalized));
    setPutForm((current) => ({ ...current, ticker: normalized }));
    setNewTicker('');
    setNewTickerBeta('');
    setNewTickerShares('');
    setNewTickerAverageCost('');
    setNewTickerTolerancePct('');
    setNewTickerExchange('');
    setNewTickerMicCode('');
    setTickerMessage(`已添加 ${normalized}`);
  }

  function handleStartTickerEdit(entry: TickerEntry) {
    setEditingTickers((current) => ({ ...current, [entry.ticker]: true }));
    setTickerDrafts((current) => ({ ...current, [entry.ticker]: createTickerEditDraft(entry) }));
  }

  function handleCancelTickerEdit(ticker: string) {
    setEditingTickers((current) => {
      const next = { ...current };
      delete next[ticker];
      return next;
    });
    setTickerDrafts((current) => {
      const next = { ...current };
      delete next[ticker];
      return next;
    });
  }

  function handleChangeTickerDraft(
    ticker: string,
    field: keyof TickerEditDraftValues,
    value: string
  ) {
    setTickerDrafts((current) => ({
      ...current,
      [ticker]: {
        ...(current[ticker] ?? { beta: '', shares: '', averageCostBasis: '', downsideTolerancePct: '' }),
        [field]: value
      }
    }));
  }

  function handleSaveTickerEdit(ticker: string) {
    const draft = tickerDrafts[ticker];
    if (!draft) {
      return;
    }

    setTickerList((current) => {
      const nextTickerList = updateTickerEntry(current, ticker, {
        beta: draft.beta.trim() === '' ? null : Number(draft.beta),
        shares: draft.shares.trim() === '' ? null : Number(draft.shares),
        average_cost_basis: draft.averageCostBasis.trim() === '' ? null : Number(draft.averageCostBasis),
        downside_tolerance_pct: draft.downsideTolerancePct.trim() === '' ? null : Number(draft.downsideTolerancePct) / 100
      });
      saveTickerList(nextTickerList);
      return nextTickerList;
    });

    handleCancelTickerEdit(ticker);
    setTickerMessage(`已保存 ${ticker}`);
  }

  function handleDeleteTicker(ticker: string) {
    const hasOpenPut = puts.some((put) => put.ticker === ticker);
    if (hasOpenPut) {
      setTickerMessage(`无法删除 ${ticker}：还有 Option 仓位在使用它`);
      return;
    }

    setTickerList((current) => removeTickerEntry(current, ticker));
    setDeletedTickers((current) => [...current.filter((item) => item !== ticker), ticker].sort());
    if (putForm.ticker === ticker) {
      setPutForm((current) => ({ ...current, ticker: '' }));
    }
    setTickerMessage(`已删除 ${ticker}`);
  }

  function handleOpenSellStock(entry: TickerEntry) {
    const currentShares = entry.shares ?? 0;
    if (currentShares <= 0) {
      setTickerMessage(`${entry.ticker} 当前没有可卖出的持股`);
      return;
    }

    const coveredCallShares = puts
      .filter((row) => row.ticker === entry.ticker && row.option_side === 'call')
      .reduce((sum, row) => sum + row.contracts * 100, 0);

    setSellStockPreview({
      ticker: entry.ticker,
      currentShares,
      sharesToSell: String(currentShares),
      sellPricePerShare:
        typeof entry.current_price === 'number' && Number.isFinite(entry.current_price) ? entry.current_price.toFixed(2) : '',
      coveredCallShares
    });
  }

  function handleOpenBuyStock(entry: TickerEntry) {
    setBuyStockPreview({
      ticker: entry.ticker,
      currentShares: entry.shares ?? 0,
      sharesToBuy: '100',
      buyPricePerShare:
        typeof entry.current_price === 'number' && Number.isFinite(entry.current_price)
          ? entry.current_price.toFixed(2)
          : typeof entry.average_cost_basis === 'number' && Number.isFinite(entry.average_cost_basis)
            ? entry.average_cost_basis.toFixed(2)
            : ''
    });
  }

  function confirmSellStock() {
    if (!sellStockPreview) {
      return;
    }

    const sharesToSell = Number(sellStockPreview.sharesToSell);
    const sellPricePerShare = Number(sellStockPreview.sellPricePerShare);
    const maxSharesToSell = Math.max(sellStockPreview.currentShares - sellStockPreview.coveredCallShares, 0);

    if (!Number.isFinite(sharesToSell) || sharesToSell <= 0 || sharesToSell > sellStockPreview.currentShares) {
      setTickerMessage(`卖出股数请输入 1 到 ${sellStockPreview.currentShares} 之间的有效数字`);
      return;
    }
    if (sellStockPreview.coveredCallShares > 0 && sharesToSell > maxSharesToSell) {
      setTickerMessage(
        `${sellStockPreview.ticker} 还有 ${sellStockPreview.coveredCallShares} 股被 Covered Call 覆盖，最多只能卖出 ${maxSharesToSell} 股`
      );
      return;
    }
    if (!Number.isFinite(sellPricePerShare) || sellPricePerShare < 0) {
      setTickerMessage('卖出价格请输入有效数字');
      return;
    }

    const sellResult = sellTickerShares(tickerList, sellStockPreview.ticker, sharesToSell, sellPricePerShare);
    if (!sellResult) {
      setTickerMessage(`无法卖出 ${sellStockPreview.ticker}，请检查卖出股数和价格`);
      return;
    }

    saveTickerList(sellResult.nextEntries);
    setTickerList(sellResult.nextEntries);

    const averageCostBasis =
      tickerList.find((entry) => entry.ticker === sellStockPreview.ticker)?.average_cost_basis ?? 0;
    const realizedPnl = (sellPricePerShare - averageCostBasis) * sharesToSell;
    setStockTrades((current) => [
      {
        id: generateId(),
        ticker: sellStockPreview.ticker,
        action: 'sell',
        shares: sharesToSell,
        price_per_share: sellPricePerShare,
        traded_at: new Date().toISOString().slice(0, 10),
        cash_change: sellResult.proceeds,
        realized_pnl: realizedPnl
      },
      ...current
    ]);

    const nextConfig = applyStockSellCash(config, configForm ?? DEFAULT_CONFIG, sellResult.proceeds);
    saveConfig(nextConfig);
    setConfig(nextConfig);
    setConfigForm(nextConfig);
    setConfigErrors({});

    setSellStockPreview(null);
    setTickerMessage(
      `已卖出 ${sellStockPreview.ticker} ${sharesToSell} 股，回笼现金 ${formatCurrency(sellResult.proceeds)}`
    );
  }

  function confirmBuyStock() {
    if (!buyStockPreview) {
      return;
    }

    const sharesToBuy = Number(buyStockPreview.sharesToBuy);
    const buyPricePerShare = Number(buyStockPreview.buyPricePerShare);
    if (!Number.isFinite(sharesToBuy) || sharesToBuy <= 0) {
      setTickerMessage('买入股数请输入有效数字');
      return;
    }
    if (!Number.isFinite(buyPricePerShare) || buyPricePerShare < 0) {
      setTickerMessage('买入价格请输入有效数字');
      return;
    }

    const buyResult = buyTickerShares(tickerList, buyStockPreview.ticker, sharesToBuy, buyPricePerShare);
    if (!buyResult) {
      setTickerMessage(`无法买入 ${buyStockPreview.ticker}，请检查买入股数和价格`);
      return;
    }

    const cashBase = config ?? configForm ?? DEFAULT_CONFIG;
    if (buyResult.cost > (cashBase.cash ?? 0)) {
      setTickerMessage(`现金不足：买入 ${buyStockPreview.ticker} 需要 ${formatCurrency(buyResult.cost)}`);
      return;
    }

    saveTickerList(buyResult.nextEntries);
    setTickerList(buyResult.nextEntries);

    setStockTrades((current) => [
      {
        id: generateId(),
        ticker: buyStockPreview.ticker,
        action: 'buy',
        shares: sharesToBuy,
        price_per_share: buyPricePerShare,
        traded_at: new Date().toISOString().slice(0, 10),
        cash_change: -buyResult.cost,
        realized_pnl: 0
      },
      ...current
    ]);

    const nextConfig = applyStockBuyCash(config, configForm ?? DEFAULT_CONFIG, buyResult.cost);
    saveConfig(nextConfig);
    setConfig(nextConfig);
    setConfigForm(nextConfig);
    setConfigErrors({});

    setBuyStockPreview(null);
    setTickerMessage(
      `已买入 ${buyStockPreview.ticker} ${sharesToBuy} 股，现金减少 ${formatCurrency(buyResult.cost)}`
    );
  }

  function applyQuotesPayload(payload: QuotesPayload, requestedTickers: string[]) {
    const quotes = payload.quotes ?? {};
    const rsi = payload.rsi ?? {};
    const rsi1h = payload.rsi1h ?? {};
    const ma21 = payload.ma21 ?? {};
    const ma200 = payload.ma200 ?? {};
    const currentIv = payload.currentIv ?? {};
    const nextEarningsDate = payload.nextEarningsDate ?? {};
    const historicalIv = payload.historicalIv ?? {};
    const ivRank = payload.ivRank ?? {};
    const ivPercentile = payload.ivPercentile ?? {};
    const putCallRatio = payload.putCallRatio ?? {};
    const refreshedAt = payload.as_of ?? new Date().toISOString();

    setTickerList((current) =>
      current.map((entry) => {
        if (!requestedTickers.includes(entry.ticker)) {
          return entry;
        }

        const hasQuote = typeof quotes[entry.ticker] === 'number';
        const hasRsi = typeof rsi[entry.ticker] === 'number';
        const hasRsi1h = typeof rsi1h[entry.ticker] === 'number';
        const hasMa21 = typeof ma21[entry.ticker] === 'number';
        const hasMa200 = typeof ma200[entry.ticker] === 'number';
        const hasCurrentIv = typeof currentIv[entry.ticker] === 'number';
        const hasHistoricalIv = typeof historicalIv[entry.ticker] === 'number';
        const hasIvRank = typeof ivRank[entry.ticker] === 'number';
        const hasIvPercentile = typeof ivPercentile[entry.ticker] === 'number';
        const hasPutCallRatio = typeof putCallRatio[entry.ticker] === 'number';
        const hasEarningsDate = typeof nextEarningsDate[entry.ticker] === 'string' && nextEarningsDate[entry.ticker] !== '';
        const hasAnyMarketDataUpdate =
          hasQuote || hasRsi || hasMa21 || hasMa200 || hasCurrentIv || hasHistoricalIv || hasIvRank || hasIvPercentile || hasPutCallRatio || hasEarningsDate;

        return {
          ...entry,
          current_price: hasQuote ? quotes[entry.ticker] : entry.current_price,
          last_updated: hasAnyMarketDataUpdate ? refreshedAt : entry.last_updated,
          next_earnings_date: hasEarningsDate ? nextEarningsDate[entry.ticker] : entry.next_earnings_date,
          rsi_14: hasRsi ? rsi[entry.ticker] : entry.rsi_14,
          rsi_14_1h: hasRsi1h ? rsi1h[entry.ticker] : entry.rsi_14_1h,
          rsi_updated: hasRsi ? refreshedAt : entry.rsi_updated,
          ma_21: hasMa21 ? ma21[entry.ticker] : entry.ma_21,
          ma_200: hasMa200 ? ma200[entry.ticker] : entry.ma_200,
          current_iv: hasCurrentIv ? currentIv[entry.ticker] : entry.current_iv,
          current_iv_updated: hasCurrentIv ? refreshedAt : entry.current_iv_updated,
          historical_iv: hasHistoricalIv ? historicalIv[entry.ticker] : entry.historical_iv,
          iv_rank: hasIvRank ? ivRank[entry.ticker] : entry.iv_rank,
          iv_percentile: hasIvPercentile ? ivPercentile[entry.ticker] : entry.iv_percentile,
          put_call_ratio: hasPutCallRatio ? putCallRatio[entry.ticker] : entry.put_call_ratio,
          put_call_ratio_updated: hasPutCallRatio ? refreshedAt : entry.put_call_ratio_updated
        };
      })
    );
  }

  async function fetchQuotesForEntries(entries: TickerEntry[], mode: QuoteRefreshMode = 'full') {
    const items = entries.map((entry) => ({
      symbol: entry.ticker,
      exchange: entry.provider_exchange,
      mic_code: entry.provider_mic_code,
      include_rsi: mode === 'full',
      include_ma: mode === 'full',
      include_market_metrics: mode === 'full',
      include_current_iv:
        mode === 'full' && !(isFreshWithin(entry.current_iv_updated, CURRENT_IV_CACHE_MS) && entry.current_iv !== null)
    }));
    const response = await fetch(`/api/quotes?items=${encodeURIComponent(JSON.stringify(items))}`);
    const payload = await readJsonResponse<QuotesPayload>(response);

    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? '价格刷新失败');
    }

    applyQuotesPayload(payload, entries.map((entry) => entry.ticker));
    return payload;
  }

  async function refreshTickerQuotesWithRetry(entry: TickerEntry, mode: QuoteRefreshMode) {
    try {
      return await fetchQuotesForEntries([entry], mode);
    } catch (error) {
      const message = error instanceof Error ? error.message : '价格刷新失败';
      if (!isMinuteLimitError(message)) {
        throw error;
      }

      setPriceRefreshMessage(`${entry.ticker} 遇到分钟限额，正在放慢节奏后重试...`);
      await sleep(PRICE_REFRESH_RETRY_GAP_MS);
      return fetchQuotesForEntries([entry], mode);
    }
  }

  async function refreshTickerMarketData(entry: TickerEntry, mode: QuoteRefreshMode) {
    const payload = await refreshTickerQuotesWithRetry(entry, mode);
    return { payload, pcrUpdated: typeof payload.putCallRatio?.[entry.ticker] === 'number', pcrError: '' };
  }

  async function handleRefreshTicker(entry: TickerEntry) {
    if (entry.ticker === '') {
      setPriceRefreshMessage('没有可刷新的股票代码');
      return;
    }

    setRefreshingTicker(entry.ticker);
    setPriceRefreshMessage('');

    try {
      const { payload, pcrUpdated, pcrError } = await refreshTickerMarketData(entry, 'full');
      const quotes = payload.quotes ?? {};

      if (typeof quotes[entry.ticker] === 'number') {
        const errorMessage = payload.errors?.[entry.ticker];
        setPriceRefreshMessage(
          errorMessage || pcrError
            ? `${entry.ticker} 已部分更新：${[errorMessage, pcrError].filter(Boolean).join('；')}`
            : `已更新 ${entry.ticker} 的价格、技术指标${pcrUpdated ? '和 PCR' : ''}`
        );
      } else {
        const errorMessage = payload.errors?.[entry.ticker] ?? `${entry.ticker} 刷新失败`;
        setPriceRefreshMessage(`${entry.ticker} 刷新失败：${errorMessage}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '价格刷新失败';
      setPriceRefreshMessage(`${entry.ticker} 刷新失败：${message}`);
    } finally {
      setRefreshingTicker(null);
    }
  }

  async function handleRefreshAllTickers() {
    if (tickerList.length === 0) {
      setPriceRefreshMessage('没有可刷新的股票代码');
      return;
    }

    const entries = [...tickerList].filter((entry) => entry.ticker !== '');
    if (entries.length === 0) {
      setPriceRefreshMessage('没有可刷新的股票代码');
      return;
    }

    setIsRefreshingAllTickers(true);
    setPriceRefreshMessage('');
    setRefreshAllProgress({
      current: 0,
      total: entries.length,
      successCount: 0,
      failureCount: 0,
      ticker: ''
    });

    let successCount = 0;
    let partialFailures = 0;
    const failureMessages: string[] = [];

    try {
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        setRefreshAllProgress({
          current: index + 1,
          total: entries.length,
          successCount,
          failureCount: partialFailures,
          ticker: entry.ticker
        });

        try {
          const { payload, pcrError } = await refreshTickerMarketData(entry, 'full');
          const quotes = payload.quotes ?? {};
          const errors = payload.errors ?? {};
          const updated = typeof quotes[entry.ticker] === 'number';

          if (updated) {
            successCount += 1;
            if (pcrError) {
              partialFailures += 1;
              failureMessages.push(`${entry.ticker} PCR: ${pcrError}`);
            }
          } else if (errors[entry.ticker]) {
            partialFailures += 1;
            failureMessages.push(`${entry.ticker}: ${errors[entry.ticker]}`);
          }
        } catch {
          partialFailures += 1;
          failureMessages.push(`${entry.ticker}: 请求失败`);
        }

        setRefreshAllProgress({
          current: index + 1,
          total: entries.length,
          successCount,
          failureCount: partialFailures,
          ticker: entry.ticker
        });

        if (index < entries.length - 1) {
          await sleep(PRICE_REFRESH_GAP_MS);
        }
      }

      setPriceRefreshMessage(
        partialFailures > 0
          ? `已慢速刷新 ${successCount} 个股票价格，${partialFailures} 个未成功更新：${failureMessages.slice(0, 4).join('；')}${failureMessages.length > 4 ? '……' : ''}`
          : `已慢速刷新全部 ${successCount} 个股票价格`
      );
    } finally {
      setRefreshAllProgress(null);
      setIsRefreshingAllTickers(false);
    }
  }

  async function handleCopySummary() {
    const text = buildSummaryText(config, activeScenario, metrics);
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage('摘要已复制');
    } catch {
      setCopyMessage('复制失败');
    }
  }

  async function handleAnalyzePosition(row: (typeof metrics.putRows)[number]) {
    const tickerEntry = tickerMap.get(row.ticker);
    setAnalysisPositionId(row.id);
    setAnalysisError('');
    setAnalysisResult(null);

    try {
      const response = await fetch('/api/position-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ticker: row.ticker,
          option_side: row.option_side ?? 'put',
          contracts: row.contracts,
          put_strike: row.put_strike,
          premium_per_share: row.premium_per_share,
          expiration_date: row.expiration_date,
          date_sold: row.date_sold,
          annualized_yield: row.annualizedYield.toFixed(6),
          put_risk: row.putRisk.toFixed(2),
          risk_pct_of_cash: row.riskPctOfCash.toFixed(6),
          active_stress_pct: activeScenario.toFixed(6),
          current_price: tickerEntry?.current_price?.toFixed(2) ?? '-',
          beta: tickerEntry?.beta?.toFixed(2) ?? '-',
          rsi_14: tickerEntry?.rsi_14?.toFixed(1) ?? '-',
          ma_21: tickerEntry?.ma_21?.toFixed(2) ?? '-',
          ma_200: tickerEntry?.ma_200?.toFixed(2) ?? '-',
          current_iv:
            tickerEntry?.current_iv === null || tickerEntry?.current_iv === undefined
              ? '-'
              : tickerEntry.current_iv.toFixed(6),
          put_call_ratio:
            tickerEntry?.put_call_ratio === null || tickerEntry?.put_call_ratio === undefined
              ? '-'
              : tickerEntry.put_call_ratio.toFixed(2)
        })
      });

      const payload = (await response.json()) as {
        analysis?: PositionAnalysisResult['analysis'];
        sources?: Array<{ title: string; url: string }>;
        as_of?: string;
        error?: string;
      };

      if (!response.ok || payload.error || typeof payload.analysis !== 'object' || payload.analysis === null) {
        throw new Error(payload.error ?? 'Gemini 分析失败');
      }

      setAnalysisResult({
        ticker: row.ticker,
        analysis: payload.analysis,
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        asOf: payload.as_of ?? new Date().toISOString()
      });
    } catch (error) {
      setAnalysisError(formatGeminiError(error, 'Gemini 分析失败'));
    } finally {
      setAnalysisPositionId(null);
    }
  }

  async function handleAnalyzePreTrade() {
    if (!preTradeCandidate) {
      return;
    }

    if (!isPreTradeQuestionnaireComplete(preTradeQuestionnaire)) {
      setPreTradeError('请先完成所有卖前选择题');
      return;
    }

    const rationale = buildPreTradeRationale(preTradeCandidate, preTradeQuestionnaire);
    const tickerEntry = tickerMap.get(preTradeCandidate.ticker);
    setIsPreTradeAnalyzing(true);
    setPreTradeError('');
    setPreTradeAnalysis(null);

    try {
      const response = await fetch('/api/pre-trade-analysis', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ticker: preTradeCandidate.ticker,
          option_side: preTradeCandidate.option_side ?? 'put',
          contracts: preTradeCandidate.contracts,
          put_strike: preTradeCandidate.put_strike,
          premium_per_share: preTradeCandidate.premium_per_share,
          expiration_date: preTradeCandidate.expiration_date,
          date_sold: preTradeCandidate.date_sold,
          current_price: tickerEntry?.current_price?.toFixed(2) ?? '-',
          beta: tickerEntry?.beta?.toFixed(2) ?? '-',
          rsi_14: tickerEntry?.rsi_14?.toFixed(1) ?? '-',
          ma_21: tickerEntry?.ma_21?.toFixed(2) ?? '-',
          ma_200: tickerEntry?.ma_200?.toFixed(2) ?? '-',
          current_iv:
            tickerEntry?.current_iv === null || tickerEntry?.current_iv === undefined
              ? '-'
              : tickerEntry.current_iv.toFixed(6),
          user_rationale: rationale
        })
      });

      const payload = (await response.json()) as {
        analysis?: PreTradeAnalysisResult['analysis'];
        sources?: Array<{ title: string; url: string }>;
        market_context?: PreTradeAnalysisResult['marketContext'];
        as_of?: string;
        error?: string;
      };

      if (!response.ok || payload.error || typeof payload.analysis !== 'object' || payload.analysis === null) {
        throw new Error(payload.error ?? 'Gemini 卖前分析失败');
      }

      setPreTradeAnalysis({
        analysis: payload.analysis,
        sources: Array.isArray(payload.sources) ? payload.sources : [],
        marketContext: payload.market_context && typeof payload.market_context === 'object' ? payload.market_context : undefined,
        asOf: payload.as_of ?? new Date().toISOString()
      });
    } catch (error) {
      setPreTradeError(formatGeminiError(error, 'Gemini 卖前分析失败'));
    } finally {
      setIsPreTradeAnalyzing(false);
    }
  }

  async function handleConfirmPreTrade() {
    if (!preTradeCandidate) {
      return;
    }

    if (!preTradeAnalysis) {
      setPreTradeError('请先完成 Gemini 卖前分析，再决定是否继续');
      return;
    }

    try {
      const candidate = buildPutCandidateFromPreTrade(
        preTradeCandidate,
        buildPreTradeRationale(preTradeCandidate, preTradeQuestionnaire),
        preTradeAnalysis
      );
      const result = await runPutChecksAndSave(candidate);

      if (shouldClearPreTradeState(result)) {
        setPreTradeCandidate(null);
        setPreTradeQuestionnaire(createEmptyPreTradeQuestionnaire());
        setPreTradeError('');
        setPreTradeAnalysis(null);
        setPreTradeContext(null);
      }
    } catch (error) {
      setPreTradeError(error instanceof Error ? error.message : '进入风险检查时发生异常，已保留当前输入');
    }
  }

  function handleExportData() {
    const payload = buildAppStateSnapshot({
      config: configForm ?? config,
      puts,
      closedTrades,
      stockTrades,
      tickerList,
      scenario,
      vixHistory,
      accountValueHistory
    });
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    const exportDate = new Date().toISOString().slice(0, 10);
    anchor.href = url;
    anchor.download = `option-and-stocks-${exportDate}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    setImportExportMessage('已导出全部股票与期权数据');
  }

  function handleOpenImport() {
    importInputRef.current?.click();
  }

  function handleOpenPositionFromDashboard(positionId: string) {
    setActiveTab('positions');
    setPendingPositionScrollId(positionId);
  }

  function handleOpenStockFromDashboard(ticker: string) {
    setActiveTab('stocks');
    setPendingStockScrollTicker(ticker);
  }

  function handleOpenCallFromDashboard(ticker: string) {
    const candidate = metrics.putRows
      .filter((row) => row.ticker === ticker && row.option_side === 'call')
      .sort((a, b) => Math.abs(a.distance_pct) - Math.abs(b.distance_pct))[0];

    if (candidate) {
      handleOpenPositionFromDashboard(candidate.id);
      return;
    }

    handleOpenStockFromDashboard(ticker);
  }

  async function persistAppStateSnapshot(
    snapshot: ReturnType<typeof buildAppStateSnapshot>,
    successMessage?: string,
    failureFallback = '保存失败'
  ) {
    const response = await fetch('/api/app-state', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(snapshot)
    });
    const payload = (await response.json()) as { ok?: boolean; error?: string };

    if (!response.ok || payload.error) {
      throw new Error(payload.error ?? failureFallback);
    }

    hasLoadedRemoteSnapshotRef.current = true;
    if (successMessage) {
      setImportExportMessage(successMessage);
    }
  }

  async function handleSaveAppState(configOverride?: Config | null) {
    try {
      const snapshot = buildAppStateSnapshot({
        config: configOverride ?? config,
        puts,
        closedTrades,
        stockTrades,
        tickerList,
        scenario,
        vixHistory,
        accountValueHistory
      });

      await persistAppStateSnapshot(snapshot, '已保存当前全部数据到本地文件');
    } catch (error) {
      setImportExportMessage(error instanceof Error ? error.message : '保存失败');
    }
  }

  async function handleImportFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const raw = await file.text();
      try {
        const snapshot = parseAppStateSnapshot(raw);
        setConfig(snapshot.data.config);
        setConfigForm(snapshot.data.config ?? DEFAULT_CONFIG);
        setConfigErrors({});
        setPuts(snapshot.data.puts);
        setClosedTrades(snapshot.data.closedTrades);
        setStockTrades(snapshot.data.stockTrades);
        setAccountValueHistory(snapshot.data.accountValueHistory);
        setTickerList(snapshot.data.tickerList);
        setDeletedTickers([]);
        setDeletedPositionIds([]);
        setScenario(snapshot.data.scenario ?? DEFAULT_STRESS_SCENARIO);
        setVixHistory(mergeSeededVixHistory(snapshot.data.vixHistory));
        hasLoadedRemoteSnapshotRef.current = true;
        setImportExportMessage('股票、期权、现金配置与历史记录导入成功');
      } catch {
        const payload = parsePutPositionsImportPayload(raw);
        const imported = applyPutPositionsImportPayload(payload);
        setPuts(imported.puts);
        setTickerList(imported.tickerList);
        setDeletedTickers([]);
        setImportExportMessage('Option 数据导入成功');
      }
    } catch {
      setImportExportMessage('导入失败，文件格式不正确');
    } finally {
      event.target.value = '';
    }
  }

  const maxVix = Math.max(40, ...visibleVixHistory.map((point) => point.value));
  const minVix = Math.min(12, ...visibleVixHistory.map((point) => point.value));
  const chartWidth = 420;
  const chartHeight = 220;
  const chartLeft = 26;
  const chartRight = 18;
  const chartTop = 16;
  const chartBottom = 34;
  const plotWidth = chartWidth - chartLeft - chartRight;
  const plotHeight = chartHeight - chartTop - chartBottom;
  const vixRange = Math.max(maxVix - minVix, 10);
  const chartPoints = visibleVixHistory.map((point, index) => {
    const x = visibleVixHistory.length === 1 ? chartLeft + plotWidth / 2 : chartLeft + (index / (visibleVixHistory.length - 1)) * plotWidth;
    const y = chartTop + ((maxVix - point.value) / vixRange) * plotHeight;
    return { ...point, x, y };
  });
  const linePath = buildSmoothLinePath(chartPoints);
  const areaPath =
    chartPoints.length === 0
      ? ''
      : `${linePath} L ${chartPoints[chartPoints.length - 1].x.toFixed(2)} ${(chartTop + plotHeight).toFixed(2)} L ${chartPoints[0].x.toFixed(2)} ${(chartTop + plotHeight).toFixed(2)} Z`;
  const peakChartPoint = peakVixPoint ? chartPoints.find((point) => point.timestamp === peakVixPoint.timestamp) ?? null : null;
  const latestChartPoint = latestVixPoint ? chartPoints.find((point) => point.timestamp === latestVixPoint.timestamp) ?? null : null;
  const xAxisLabels = chartPoints.length === 0
    ? []
    : [
        chartPoints[0],
        chartPoints[Math.floor((chartPoints.length - 1) / 2)],
        chartPoints[chartPoints.length - 1]
      ].filter((point, index, list) => list.findIndex((candidate) => candidate.timestamp === point.timestamp) === index);
  const riskCurveMinCapital = Math.min(...riskCurvePoints.map((point) => point.capital), metrics.totalCapitalBase || overallCapitalAmount || 0);
  const riskCurveMaxCapital = Math.max(...riskCurvePoints.map((point) => point.capital), metrics.totalCapitalBase || overallCapitalAmount || 0);
  const riskCurveRange = Math.max(riskCurveMaxCapital - riskCurveMinCapital, Math.max((metrics.totalCapitalBase || overallCapitalAmount || 0) * 0.05, 1));
  const riskCurvePointsChart = riskCurvePoints.map((point, index) => {
    const x = riskCurvePoints.length === 1 ? chartLeft + plotWidth / 2 : chartLeft + (index / (riskCurvePoints.length - 1)) * plotWidth;
    const y = chartTop + ((riskCurveMaxCapital - point.capital) / riskCurveRange) * plotHeight;
    return { ...point, x, y };
  });
  const riskCurveLinePath = buildSmoothLinePath(riskCurvePointsChart);
  const riskCurveAreaPath =
    riskCurvePointsChart.length === 0
      ? ''
      : `${riskCurveLinePath} L ${riskCurvePointsChart[riskCurvePointsChart.length - 1].x.toFixed(2)} ${(chartTop + plotHeight).toFixed(2)} L ${riskCurvePointsChart[0].x.toFixed(2)} ${(chartTop + plotHeight).toFixed(2)} Z`;
  const riskCurveMinScenarioPct = riskCurvePoints[0]?.scenarioPct ?? -0.3;
  const riskCurveMaxScenarioPct = riskCurvePoints[riskCurvePoints.length - 1]?.scenarioPct ?? 0.3;
  const currentRiskCurvePoint = (() => {
    const capital = riskCalculator.scenarioCapital;
    const clampedPct = Math.min(Math.max(riskCalculatorDropPct, -1), 1);
    const scenarioSpan = Math.max(riskCurveMaxScenarioPct - riskCurveMinScenarioPct, 0.0001);
    const x = chartLeft + ((clampedPct - riskCurveMinScenarioPct) / scenarioSpan) * plotWidth;
    const y = chartTop + ((riskCurveMaxCapital - capital) / riskCurveRange) * plotHeight;
    return { x: Math.min(chartLeft + plotWidth, Math.max(chartLeft, x)), y, capital };
  })();

  return (
    <div className="app-shell">
      <header className="hero">
        <div>
          <p className="eyebrow">Option Risk Budgeting</p>
          <h1>Option Risk Control Tool</h1>
        </div>
        <div className="hero-badges">
          <div className="score-badge history-badge">
            <span className="score-label">期权历史总盈利</span>
            <strong>{formatCurrency(historySummary.totalRealizedPnl)}</strong>
            <span>{historySummary.totalClosed} 笔已平仓</span>
          </div>
          <div className="score-badge cash-badge">
            <span className="score-label">Option Cash Remaining</span>
            <strong>{formatPercent(remainingCashPct)}</strong>
            <span>{formatCurrency(remainingCashAmount)} left</span>
          </div>
          <div className={`score-badge score-${finalSellingScoreLevel}`}>
            <span className="score-label">Final Selling Score</span>
            <strong>{finalSellingScore}</strong>
            <span>
              Base {baseRiskScore} {regimeAdjustment >= 0 ? '+' : ''}{regimeAdjustment} · {getScoreLabel(finalSellingScoreLevel)}
            </span>
          </div>
        </div>
      </header>

      <div className="segmented-control page-tabs" role="tablist" aria-label="Main views">
        <button
          className={`segment ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
          type="button"
          role="tab"
          aria-selected={activeTab === 'dashboard'}
        >
          Dashboard
        </button>
        <button
          className={`segment ${activeTab === 'sell' ? 'active' : ''}`}
          onClick={() => setActiveTab('sell')}
          type="button"
          role="tab"
          aria-selected={activeTab === 'sell'}
        >
          Sell Option
        </button>
        <button
          className={`segment ${activeTab === 'positions' ? 'active' : ''}`}
          onClick={() => setActiveTab('positions')}
          type="button"
          role="tab"
          aria-selected={activeTab === 'positions'}
        >
          Option Positions
        </button>
        <button
          className={`segment ${activeTab === 'history' ? 'active' : ''}`}
          onClick={() => setActiveTab('history')}
          type="button"
          role="tab"
          aria-selected={activeTab === 'history'}
        >
          History
        </button>
        <button
          className={`segment ${activeTab === 'stocks' ? 'active' : ''}`}
          onClick={() => setActiveTab('stocks')}
          type="button"
          role="tab"
          aria-selected={activeTab === 'stocks'}
        >
          Stocks
        </button>
        <button
          className={`segment ${activeTab === 'calculator' ? 'active' : ''}`}
          onClick={() => setActiveTab('calculator')}
          type="button"
          role="tab"
          aria-selected={activeTab === 'calculator'}
        >
          Risk Calculator
        </button>
      </div>

      <main className="layout">
        {activeTab === 'dashboard' && (
          <>
        <section className="card dashboard-grid">
          <div className="dashboard-left">
            <div className="dashboard-stack dashboard-stack-compact">
              <div className="dashboard-subcard dashboard-subcard-wide">
                <div className="section-subhead">
                  <h3>持仓总览</h3>
                </div>
                {combinedHoldings.length === 0 ? (
                  <div className="empty-state compact-empty">当前还没有录入股票、Call 或 Sell Put 仓位。</div>
                ) : (
                  <div className="ticker-risk-list">
                    {combinedHoldings.map((item) => {
                      const holding = item.stockHolding;
                      const putHolding = item.putHolding;
                      const stockSectionAlert =
                        !!holding?.hasStockHolding &&
                        holding.unrealizedPnlAmount !== null &&
                        holding.unrealizedPnlAmount < 0 &&
                        Math.abs(holding.unrealizedPnlAmount) >= stockLossAlertThreshold;
                      const callSectionWarning =
                        !!holding?.callCount &&
                        holding.nearestStrikeDistancePct !== null &&
                        Math.abs(holding.nearestStrikeDistancePct) <= 0.02;
                      const putSectionWarning =
                        !!putHolding &&
                        putHolding.nearestStrikeDistancePct !== null &&
                        Math.abs(putHolding.nearestStrikeDistancePct) <= 0.02;

                      return (
                        <div
                          key={`combined-${item.ticker}`}
                          className={`ticker-risk-item stock-holding-card combined-holding-card ${item.isAlert ? 'ticker-risk-alert' : ''}`}
                        >
                          <div className="ticker-risk-main">
                            <div className="stock-holding-topline">
                              <div className="stock-holding-heading">
                                <span>{item.ticker}</span>
                                <small>
                                  {holding?.hasStockHolding
                                    ? `${holding.shares} shares`
                                    : holding?.callCount
                                      ? 'Call only'
                                      : putHolding
                                        ? `${putHolding.positions.length} 笔 Sell Put`
                                        : ''}
                                </small>
                              </div>
                              <div className="stock-holding-value-group">
                                <small>目前价值</small>
                                <strong className="stock-holding-value">{formatCurrency(item.currentValue)}</strong>
                              </div>
                            </div>
                            <div className="stock-holding-summary-strip">
                              <span>
                                <small>股票盈亏</small>
                                <strong className={item.stockPnl > 0 ? 'value-positive' : item.stockPnl < 0 ? 'value-negative' : ''}>
                                  {formatSignedCurrency(item.stockPnl)}
                                </strong>
                              </span>
                              <span>
                                <small>Put 盈亏</small>
                                <strong className={item.putPnl > 0 ? 'value-positive' : item.putPnl < 0 ? 'value-negative' : ''}>
                                  {formatSignedCurrency(item.putPnl)}
                                </strong>
                              </span>
                              <span>
                                <small>Call 盈亏</small>
                                <strong className={item.callPnl > 0 ? 'value-positive' : item.callPnl < 0 ? 'value-negative' : ''}>
                                  {formatSignedCurrency(item.callPnl)}
                                </strong>
                              </span>
                              <span>
                                <small>总盈亏 %</small>
                                <strong className={item.totalPnlPct != null && item.totalPnlPct > 0 ? 'value-positive' : item.totalPnlPct != null && item.totalPnlPct < 0 ? 'value-negative' : ''}>
                                  {item.totalPnlPct == null ? '-' : formatSignedPercent(item.totalPnlPct)}
                                </strong>
                              </span>
                            </div>

                            {holding?.hasStockHolding ? (
                              <button
                                className={`stock-holding-section dashboard-section-button ${stockSectionAlert ? 'dashboard-section-warning' : ''}`}
                                type="button"
                                onClick={() => handleOpenStockFromDashboard(item.ticker)}
                              >
                                <small className="stock-section-label">股票持仓</small>
                                <div className="stock-holding-grid">
                                  <small>现价</small>
                                  <strong>{holding.currentPrice == null ? '-' : formatCurrency(holding.currentPrice)}</strong>
                                  <small>持仓均价</small>
                                  <strong>{holding.averageCost == null ? '-' : formatCurrency(holding.averageCost)}</strong>
                                  <small>Stock Risk</small>
                                  <strong>{formatCurrency(holding.stockRisk)}</strong>
                                  <small>股票盈亏</small>
                                  <strong
                                    className={
                                      holding.unrealizedPnlAmount == null
                                        ? ''
                                        : holding.unrealizedPnlAmount > 0
                                          ? 'value-positive'
                                          : holding.unrealizedPnlAmount < 0
                                            ? 'value-negative'
                                            : ''
                                    }
                                  >
                                    {formatSignedCurrency(holding.unrealizedPnlAmount)}
                                  </strong>
                                  <small>股票盈亏 %</small>
                                  <strong
                                    className={
                                      holding.unrealizedPnlPct == null
                                        ? ''
                                        : holding.unrealizedPnlPct > 0
                                          ? 'value-positive'
                                          : holding.unrealizedPnlPct < 0
                                            ? 'value-negative'
                                            : ''
                                    }
                                  >
                                    {formatSignedPercent(holding.unrealizedPnlPct)}
                                  </strong>
                                </div>
                              </button>
                            ) : null}

                            {(putHolding || holding?.callCount) ? (
                              <div className={`holding-option-columns ${putHolding && holding?.callCount ? 'holding-option-columns-split' : ''}`}>
                                {putHolding ? (
                                  <div className="stock-holding-section risk-put-section holding-option-column holding-option-panel">
                                    <button
                                      className={`dashboard-section-button risk-section-button section-summary-card ${putSectionWarning ? 'dashboard-section-warning' : ''}`}
                                      type="button"
                                      onClick={() => handleOpenPositionFromDashboard(putHolding.positions[0].id)}
                                    >
                                      <small className="stock-section-label">Put 持仓</small>
                                      {putHolding.nearestStrikeDistancePct !== null ? (
                                        <small className={putSectionWarning ? 'strike-warning-text' : ''}>
                                          {putHolding.nearestStrikeDistancePct < 0
                                            ? `最近 Strike 已 ITM ${formatPercent(Math.abs(putHolding.nearestStrikeDistancePct))} · 已进入 ITM`
                                            : `最近 Strike ${formatPercent(putHolding.nearestStrikeDistancePct)}${putSectionWarning ? ' · 接近 Strike' : ''}`}
                                        </small>
                                      ) : null}
                                      <div className="stock-holding-grid">
                                        <small>Sell Put 风险</small>
                                        <strong>{formatCurrency(putHolding.risk)}</strong>
                                        <small>当前盈亏</small>
                                        <strong className={putHolding.totalOptionPnl > 0 ? 'value-positive' : putHolding.totalOptionPnl < 0 ? 'value-negative' : ''}>
                                          {formatSignedCurrency(putHolding.totalOptionPnl)}
                                        </strong>
                                        <small>总权利金</small>
                                        <strong>{formatCurrency(putHolding.totalPremiumIncome)}</strong>
                                      </div>
                                    </button>
                                    <div className="risk-put-details-list">
                                      {putHolding.positions.map((row) => {
                                        const currentPrice = tickerList.find((entry) => entry.ticker === row.ticker)?.current_price;
                                        const strikeDistancePct = getPercentDistanceToStrike(currentPrice, row.put_strike, 'put');
                                        const isItm = strikeDistancePct !== null && strikeDistancePct < 0;
                                        const isNearStrike = strikeDistancePct !== null && Math.abs(strikeDistancePct) <= 0.02;
                                        const exceedsCloseThreshold =
                                          row.unrealizedPnl != null &&
                                          row.unrealizedPnl < 0 &&
                                          Math.abs(row.unrealizedPnl) >= row.premiumIncome * 2;
                                        const detailToneClass = exceedsCloseThreshold
                                          ? 'risk-put-detail-row-danger'
                                          : isItm || isNearStrike
                                            ? 'risk-put-detail-row-warning'
                                            : '';

                                        return (
                                          <button
                                            key={row.id}
                                            className={`risk-put-detail-row risk-put-detail-button ${detailToneClass}`}
                                            type="button"
                                            onClick={() => handleOpenPositionFromDashboard(row.id)}
                                          >
                                            <div className="risk-put-detail-main">
                                              <strong>{`$${row.put_strike.toFixed(2)} strike`}</strong>
                                              <small>{`${row.expiration_date} · ${row.contracts} 张`}</small>
                                            </div>
                                            <div className="risk-put-detail-grid">
                                              <small>现价</small>
                                              <strong>{currentPrice == null ? '-' : formatCurrency(currentPrice)}</strong>
                                              <small>Break Even</small>
                                              <strong>{formatCurrency(row.put_strike - row.premium_per_share)}</strong>
                                              <small>距 Strike</small>
                                              <strong className={isItm || isNearStrike ? 'value-negative' : ''}>
                                                {strikeDistancePct === null
                                                  ? '-'
                                                  : strikeDistancePct < 0
                                                    ? `ITM ${formatPercent(Math.abs(strikeDistancePct))}`
                                                    : formatPercent(strikeDistancePct)}
                                              </strong>
                                              <small>权利金</small>
                                              <strong>{formatCurrency(row.premiumIncome)}</strong>
                                              <small>当前盈亏</small>
                                              <strong className={row.unrealizedPnl != null && row.unrealizedPnl > 0 ? 'value-positive' : row.unrealizedPnl != null && row.unrealizedPnl < 0 ? 'value-negative' : ''}>
                                                {formatSignedCurrency(row.unrealizedPnl)}
                                              </strong>
                                            </div>
                                          </button>
                                        );
                                      })}
                                    </div>
                                    {putHolding.totalOptionLoss >= putHolding.totalPremiumIncome * 2 && putHolding.totalOptionLoss > 0 ? (
                                      <small>2x 止损线：{formatCurrency(putHolding.totalPremiumIncome * 2)}</small>
                                    ) : null}
                                  </div>
                                ) : null}

                                {holding?.callCount ? (
                                  <div className="stock-holding-section stock-call-section holding-option-column holding-option-panel">
                                    <button
                                      className={`dashboard-section-button risk-section-button section-summary-card ${callSectionWarning ? 'dashboard-section-warning' : ''}`}
                                      type="button"
                                      onClick={() => handleOpenCallFromDashboard(item.ticker)}
                                    >
                                      <small className="stock-section-label">{holding.callSectionLabel}</small>
                                      {holding.nearestStrikeDistancePct !== null ? (
                                        <small className={callSectionWarning ? 'strike-warning-text' : ''}>
                                          {holding.nearestStrikeDistancePct < 0
                                            ? `最近 Strike 已 ITM ${formatPercent(Math.abs(holding.nearestStrikeDistancePct))} · 已进入 ITM`
                                            : `最近 Strike ${formatPercent(holding.nearestStrikeDistancePct)}${callSectionWarning ? ' · 接近 Strike' : ''}`}
                                        </small>
                                      ) : null}
                                      <div className="stock-holding-grid">
                                        <small>{holding.hasStockHolding ? '覆盖股数' : '状态'}</small>
                                        <strong>{holding.hasStockHolding ? `${holding.coveredCallShares} shares` : '未覆盖'}</strong>
                                        {holding.hasStockHolding ? (
                                          <>
                                            <small>Call Offset</small>
                                            <strong>{formatCurrency(holding.callOffset)}</strong>
                                          </>
                                        ) : null}
                                        <small>总权利金</small>
                                        <strong>{formatCurrency(holding.callPremiumIncome)}</strong>
                                      </div>
                                      <div className="stock-holding-grid stock-call-pnl-grid">
                                        {holding.hasStockHolding ? (
                                          <>
                                            <small>Net Stock Risk</small>
                                            <strong>{formatCurrency(holding.netStockRisk)}</strong>
                                          </>
                                        ) : null}
                                        <small>当前盈亏</small>
                                        <strong
                                          className={
                                            holding.callUnrealizedPnl == null
                                              ? ''
                                              : holding.callUnrealizedPnl > 0
                                                ? 'value-positive'
                                                : holding.callUnrealizedPnl < 0
                                                  ? 'value-negative'
                                                  : ''
                                          }
                                        >
                                          {formatSignedCurrency(holding.callUnrealizedPnl)}
                                        </strong>
                                      </div>
                                    </button>
                                    <div className="risk-put-details-list">
                                      {holding.callRows.map((row) => {
                                        const strikeDistancePct = getPercentDistanceToStrike(holding.currentPrice, row.put_strike, 'call');
                                        const isItm = strikeDistancePct !== null && strikeDistancePct < 0;
                                        const isNearStrike = strikeDistancePct !== null && Math.abs(strikeDistancePct) <= 0.02;
                                        const exceedsCloseThreshold =
                                          row.unrealizedPnl != null &&
                                          row.unrealizedPnl < 0 &&
                                          Math.abs(row.unrealizedPnl) >= row.premiumIncome * 2;
                                        const detailToneClass = exceedsCloseThreshold
                                          ? 'risk-put-detail-row-danger'
                                          : isItm || isNearStrike
                                            ? 'risk-put-detail-row-warning'
                                            : '';

                                        return (
                                          <button
                                            key={row.id}
                                            className={`risk-put-detail-row risk-put-detail-button ${detailToneClass}`}
                                            type="button"
                                            onClick={() => handleOpenPositionFromDashboard(row.id)}
                                          >
                                            <div className="risk-put-detail-main">
                                              <strong>{`$${row.put_strike.toFixed(2)} strike`}</strong>
                                              <small>{`${row.expiration_date} · ${row.contracts} 张`}</small>
                                            </div>
                                            <div className="risk-put-detail-grid">
                                              <small>现价</small>
                                              <strong>{holding.currentPrice == null ? '-' : formatCurrency(holding.currentPrice)}</strong>
                                              <small>Break Even</small>
                                              <strong>{formatCurrency(row.put_strike + row.premium_per_share)}</strong>
                                              <small>距 Strike</small>
                                              <strong className={isItm || isNearStrike ? 'value-negative' : ''}>
                                                {strikeDistancePct === null
                                                  ? '-'
                                                  : strikeDistancePct < 0
                                                    ? `ITM ${formatPercent(Math.abs(strikeDistancePct))}`
                                                    : formatPercent(strikeDistancePct)}
                                              </strong>
                                              <small>权利金</small>
                                              <strong>{formatCurrency(row.premiumIncome)}</strong>
                                              <small>当前盈亏</small>
                                              <strong className={row.unrealizedPnl != null && row.unrealizedPnl > 0 ? 'value-positive' : row.unrealizedPnl != null && row.unrealizedPnl < 0 ? 'value-negative' : ''}>
                                                {formatSignedCurrency(row.unrealizedPnl)}
                                              </strong>
                                            </div>
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

            </div>
            {vixMessage && <div className="copy-message">{vixMessage}</div>}
          </div>

          <div className="dashboard-right">
            <div className="section-header">
              <div>
                <p className="section-kicker">Section 1</p>
                <h2>Insights</h2>
              </div>
            </div>
            <div className="insights-metric-grid">
              {compactInsightLines.map((line) => (
                <div key={line} className="insight-item">
                  {line}
                </div>
              ))}
            </div>
            <div className="section-header">
              <div>
                <p className="section-kicker">Scenario</p>
                <h2>Risk Curve</h2>
              </div>
            </div>
            <div className="trend-card risk-curve-card">
              <div className="trend-summary">
                <div className="trend-summary-item">
                  <span>{`变化${formatSignedPercent(riskCalculator.scenarioPct)}`}</span>
                  <strong>{formatCurrency(riskCalculator.capitalBase)}</strong>
                  <small>现有资金</small>
                </div>
                <div className="trend-summary-item">
                  <span>变化幅度 %</span>
                  <input
                    className="trend-summary-input"
                    type="number"
                    min="-30"
                    max="30"
                    step="1"
                    value={riskCalculatorDropInput}
                    onChange={(event) => setRiskCalculatorDropInput(event.target.value)}
                  />
                  <small
                    className={
                      riskCalculator.totalPutChange + riskCalculator.totalCallChange > 0
                        ? 'value-positive'
                        : riskCalculator.totalPutChange + riskCalculator.totalCallChange < 0
                          ? 'value-negative'
                          : ''
                    }
                  >
                    {`期权盈利 ${formatSignedCurrency(riskCalculator.totalPutChange + riskCalculator.totalCallChange)}`}
                  </small>
                </div>
                <div className="trend-summary-item">
                  <span>Total</span>
                  <strong>{formatCurrency(riskCalculator.scenarioCapital)}</strong>
                  <small
                    className={
                      riskCalculator.totalNetChange > 0
                        ? 'value-positive'
                        : riskCalculator.totalNetChange < 0
                          ? 'value-negative'
                          : ''
                    }
                  >
                    {formatSignedCurrency(riskCalculator.totalNetChange)}
                  </small>
                  <small
                    className={
                      (riskCalculator.totalNetChangePctOfCapital ?? 0) > 0
                        ? 'value-positive'
                        : (riskCalculator.totalNetChangePctOfCapital ?? 0) < 0
                          ? 'value-negative'
                          : ''
                    }
                  >
                    {`盈利百分比 ${formatSignedPercent(riskCalculator.totalNetChangePctOfCapital ?? 0)}`}
                  </small>
                </div>
              </div>
              <svg className="trend-chart trend-chart-rich" viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" role="img" aria-label="Risk curve">
                <defs>
                  <linearGradient id="riskCurveFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(37, 99, 235, 0.22)" />
                    <stop offset="100%" stopColor="rgba(37, 99, 235, 0.02)" />
                  </linearGradient>
                </defs>
                <rect x="0" y="0" width={chartWidth} height={chartHeight} className="trend-surface" />
                {[0.25, 0.5, 0.75].map((step) => {
                  const y = chartTop + plotHeight * step;
                  return <line key={step} x1={chartLeft} y1={y} x2={chartLeft + plotWidth} y2={y} className="grid-line" />;
                })}
                {[-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3].map((pct) => {
                  const scenarioSpan = Math.max(riskCurvePoints[riskCurvePoints.length - 1].scenarioPct - riskCurvePoints[0].scenarioPct, 0.0001);
                  const x = chartLeft + ((pct - riskCurvePoints[0].scenarioPct) / scenarioSpan) * plotWidth;
                  return (
                    <g key={pct}>
                      <line x1={x} y1={chartTop} x2={x} y2={chartTop + plotHeight} className="grid-line vertical" />
                      <text x={x} y={chartHeight - 10} textAnchor="middle" className="chart-axis-label">
                        {formatSignedPercent(pct)}
                      </text>
                    </g>
                  );
                })}
                {[riskCurveMaxCapital, riskCalculator.capitalBase, riskCurveMinCapital].map((capital, index) => {
                  const y = chartTop + ((riskCurveMaxCapital - capital) / riskCurveRange) * plotHeight;
                  return (
                    <g key={`${capital}-${index}`}>
                      <text x={chartLeft + 4} y={y - 6} className="chart-label">
                        {formatCurrency(capital)}
                      </text>
                    </g>
                  );
                })}
                {riskCurveAreaPath && <path d={riskCurveAreaPath} className="risk-curve-area" />}
                {riskCurveLinePath && <path d={riskCurveLinePath} className="risk-curve-line" />}
                <g>
                  <line
                    x1={currentRiskCurvePoint.x}
                    y1={currentRiskCurvePoint.y}
                    x2={currentRiskCurvePoint.x}
                    y2={chartTop + plotHeight}
                    className="latest-guide"
                  />
                  <circle cx={currentRiskCurvePoint.x} cy={currentRiskCurvePoint.y} r="6" className="trend-point yellow" />
                  <text x={Math.max(chartLeft + 6, currentRiskCurvePoint.x - 10)} y={currentRiskCurvePoint.y - 12} className="latest-point-label">
                    {formatCurrency(currentRiskCurvePoint.capital)}
                  </text>
                </g>
                <text x={chartLeft + plotWidth / 2} y={chartHeight - 2} textAnchor="middle" className="chart-axis-title">
                  涨跌幅情景（横轴）
                </text>
                <text
                  x={10}
                  y={chartTop + plotHeight / 2}
                  textAnchor="middle"
                  transform={`rotate(-90 10 ${chartTop + plotHeight / 2})`}
                  className="chart-axis-title"
                >
                  总资金（纵轴）
                </text>
              </svg>
              <div className="trend-footnote">
                横轴范围固定为 -30% 到 +30%。黄色圆点表示你当前输入情景对应的总资金。
              </div>
            </div>

            <div className="section-header">
              <div>
                <p className="section-kicker">Trend</p>
                <h2>VIX Trend</h2>
              </div>
            </div>
            {dailyVixHistory.length === 0 ? (
              <div className="empty-state">刷新 VIX 后，这里会记录本地 VIX 历史，并据此动态调整 stress。</div>
            ) : (
              <div className="trend-card">
                <div className="trend-summary">
                  <div className="trend-summary-item">
                    <span>Current VIX</span>
                    <strong>{latestVixPoint?.value.toFixed(2) ?? '-'}</strong>
                  </div>
                  <div className="trend-summary-item">
                    <span>7D Avg VIX</span>
                    <strong>{stressAdjustment.sevenDayAverage === null ? '-' : stressAdjustment.sevenDayAverage.toFixed(2)}</strong>
                  </div>
                  <div className="trend-summary-item">
                    <span>7D Trend</span>
                    <strong>
                      {stressAdjustment.mode === 'rising'
                        ? 'VIX 上行'
                        : stressAdjustment.mode === 'falling'
                          ? 'VIX 回落'
                          : stressAdjustment.mode === 'sideways'
                            ? 'VIX 区间震荡'
                            : '等待数据'}
                    </strong>
                  </div>
                </div>
                <svg className="trend-chart trend-chart-rich" viewBox={`0 0 ${chartWidth} ${chartHeight}`} preserveAspectRatio="none" role="img" aria-label="VIX trend">
                <defs>
                  <linearGradient id="vixAreaFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(15, 118, 110, 0.24)" />
                    <stop offset="100%" stopColor="rgba(15, 118, 110, 0.02)" />
                  </linearGradient>
                </defs>
                  <rect x="0" y="0" width={chartWidth} height={chartHeight} className="trend-surface" />
                  <rect
                    x={chartLeft}
                    y={chartTop + ((maxVix - 40) / vixRange) * plotHeight}
                    width={plotWidth}
                    height={((40 - 30) / vixRange) * plotHeight}
                    className="trend-band band-red"
                  />
                  <rect
                    x={chartLeft}
                    y={chartTop + ((maxVix - 30) / vixRange) * plotHeight}
                    width={plotWidth}
                    height={((30 - 20) / vixRange) * plotHeight}
                    className="trend-band band-yellow"
                  />
                  <rect
                    x={chartLeft}
                    y={chartTop + ((maxVix - 20) / vixRange) * plotHeight}
                    width={plotWidth}
                    height={((20 - minVix) / vixRange) * plotHeight}
                    className="trend-band band-green"
                  />
                  {[20, 30, 40].map((level) => {
                    const y = chartTop + ((maxVix - level) / vixRange) * plotHeight;
                    return (
                      <g key={level}>
                        <line x1={chartLeft} y1={y} x2={chartLeft + plotWidth} y2={y} className={`threshold ${level === 20 ? 'safe' : level === 30 ? 'warning' : 'danger'}`} />
                        <text x={chartLeft + 4} y={y - 6} className="chart-label">
                          {level}
                        </text>
                      </g>
                    );
                  })}
                  {[0.25, 0.5, 0.75].map((step) => {
                    const y = chartTop + plotHeight * step;
                    return <line key={step} x1={chartLeft} y1={y} x2={chartLeft + plotWidth} y2={y} className="grid-line" />;
                  })}
                  {areaPath && <path d={areaPath} className="trend-area" />}
                  {linePath && <path d={linePath} className="trend-line" />}
                  {peakChartPoint && (
                    <g>
                      <circle cx={peakChartPoint.x} cy={peakChartPoint.y} r="4.5" className="trend-point red" />
                      <text x={peakChartPoint.x + 6} y={peakChartPoint.y - 10} className="peak-point-label">
                        Peak {peakChartPoint.value.toFixed(1)}
                      </text>
                    </g>
                  )}
                  {latestChartPoint && (
                    <g>
                      <line
                        x1={latestChartPoint.x}
                        y1={latestChartPoint.y}
                        x2={latestChartPoint.x}
                        y2={chartTop + plotHeight}
                        className="latest-guide"
                      />
                      <circle
                        cx={latestChartPoint.x}
                        cy={latestChartPoint.y}
                        r="6"
                        className={`trend-point ${latestChartPoint.value < 20 ? 'green' : latestChartPoint.value < 30 ? 'yellow' : 'red'}`}
                      />
                      <text x={Math.max(chartLeft + 6, latestChartPoint.x - 10)} y={latestChartPoint.y - 12} className="latest-point-label">
                        {latestChartPoint.value.toFixed(1)}
                      </text>
                    </g>
                  )}
                  {xAxisLabels.map((point) => (
                    <g key={point.timestamp}>
                      <text x={point.x} y={chartHeight - 10} textAnchor="middle" className="chart-axis-label">
                        {point.timestamp.slice(5, 10)}
                      </text>
                    </g>
                  ))}
                </svg>
                <div className="legend">
                  <span>最近 30 天</span>
                  <span><i className="dot green" /> VIX 低于 20</span>
                  <span><i className="dot yellow" /> VIX 20 到 30</span>
                  <span><i className="dot red" /> VIX 高于 30</span>
                </div>
              </div>
            )}
            <div className="dashboard-subcard">
              <div className="section-subhead">
                <h3>Top 股票 IV Rank</h3>
              </div>
              {topIvRankStocks.length === 0 ? (
                <div className="empty-state compact-empty dashboard-empty-state">
                  <strong>当前没有可用的 IV Rank 数据</strong>
                  <span>刷新股票行情后，这里会按当前 IV Rank 从高到低显示前 5 名，并带上财报日。</span>
                </div>
              ) : (
                <div className="ticker-risk-list">
                  {topIvRankStocks.map((item, index) => (
                    <div key={`iv-rank-${item.ticker}`} className="ticker-risk-item">
                      <div className="ticker-risk-main">
                        <span>{`${index + 1}. ${item.ticker}`}</span>
                        <small>
                          {`财报日 ${item.earningsDate ?? '未确认'}`}
                          {item.currentIv == null ? '' : ` · Current IV ${(item.currentIv * 100).toFixed(1)}%`}
                        </small>
                      </div>
                      <div className="ticker-risk-main" style={{ justifyItems: 'end' }}>
                        <span className={`pill-badge ${getIvRankTone(item.ivRank)}`}>{`IV Rank ${item.ivRank.toFixed(1)}`}</span>
                        <small>{item.marketValue > 0 ? `持仓 ${formatCurrency(item.marketValue)}` : '未录入持仓金额'}</small>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="dashboard-subcard">
              <div className="section-subhead">
                <h3>需要注意的股票</h3>
              </div>
              {mostOverboughtStocks.length === 0 && mostOversoldStocks.length === 0 ? (
                <div className="empty-state compact-empty">当前没有足够的 RSI / 均线数据来判断超买或超卖。</div>
              ) : (
                <div className="dashboard-stack">
                  <div>
                    <div className="section-subhead">
                      <h3>最超买</h3>
                    </div>
                    {mostOverboughtStocks.length === 0 ? (
                      <div className="empty-state compact-empty dashboard-empty-state">
                        <strong>当前没有明显超买股票</strong>
                        <span>当 1D / 1H RSI 走高且价格明显高于均线时，会显示在这里。</span>
                      </div>
                    ) : (
                      <div className="ticker-risk-list">
                        {mostOverboughtStocks.map((item) => (
                          <div key={`overbought-${item.ticker}`} className="ticker-risk-item">
                            <div className="ticker-risk-main">
                              <span>{item.ticker}</span>
                              <small>{item.note}</small>
                            </div>
                            <div className="ticker-risk-main" style={{ justifyItems: 'end' }}>
                              <span className={`pill-badge ${item.tone}`}>{`${item.label} · ${item.score}/14`}</span>
                              <small>现价 {formatCurrency(item.currentPrice)}</small>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="section-subhead">
                      <h3>最超卖</h3>
                    </div>
                    {mostOversoldStocks.length === 0 ? (
                      <div className="empty-state compact-empty dashboard-empty-state">
                        <strong>当前没有明显超卖股票</strong>
                        <span>当 1D / 1H RSI 偏低且价格明显低于均线时，会显示在这里。</span>
                      </div>
                    ) : (
                      <div className="ticker-risk-list">
                        {mostOversoldStocks.map((item) => (
                          <div key={`oversold-${item.ticker}`} className="ticker-risk-item">
                            <div className="ticker-risk-main">
                              <span>{item.ticker}</span>
                              <small>{item.note}</small>
                            </div>
                            <div className="ticker-risk-main" style={{ justifyItems: 'end' }}>
                              <span className={`pill-badge ${item.tone}`}>{`${item.label} · ${item.score}/14`}</span>
                              <small>现价 {formatCurrency(item.currentPrice)}</small>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            <div className="dashboard-subcard">
              <div className="section-subhead">
                <h3>需要注意的期权</h3>
              </div>
              {attentionRows.length === 0 ? (
                <div className="empty-state compact-empty dashboard-empty-state">
                  <strong>当前没有需要优先处理的期权</strong>
                  <span>到期日小于 21 天或盈利百分比较高的仓位会显示在这里。</span>
                </div>
              ) : (
                <div className="ticker-risk-list">
                  {attentionRows.map(({ row, level, reasons }) => (
                    <button
                      key={`attention-${row.id}`}
                      className={`ticker-risk-item ticker-risk-button ${level === 'red' ? 'ticker-risk-alert' : 'ticker-risk-warning'}`}
                      type="button"
                      onClick={() => handleOpenPositionFromDashboard(row.id)}
                    >
                      <div className="ticker-risk-main">
                        <span>{row.ticker} · {getOptionSideBadge(row.option_side)} · ${row.put_strike.toFixed(2)} strike</span>
                        <small>
                          卖出价 {formatCurrency(row.premium_per_share)}
                          {' · '}
                          买回价 {row.option_market_price_per_share == null ? '-' : formatCurrency(row.option_market_price_per_share)}
                          {' · '}
                          盈利百分比 {row.premiumCapturedPct == null ? '-' : formatPercent(row.premiumCapturedPct)}
                        </small>
                        <small>
                          {reasons.join(' · ')}
                          {' · '}
                          Breakeven {formatCurrency(row.breakevenPrice)}
                        </small>
                      </div>
                      <div className="ticker-risk-main" style={{ justifyItems: 'end' }}>
                        <span className={`pill-badge ${level === 'red' ? 'red' : 'yellow'}`}>
                          {level === 'red' ? '红色预警' : '黄色提醒'}
                        </span>
                        <strong>{row.expiration_date}</strong>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="dashboard-subcard">
              <div className="section-subhead">
                <h3>ITM 期权摘要</h3>
              </div>
              {inTheMoneyRows.length === 0 ? (
                <div className="empty-state compact-empty dashboard-empty-state">
                  <strong>当前没有价内期权</strong>
                  <span>已进入价内的 PUT / CALL 会集中显示在这里。</span>
                </div>
              ) : (
                <div className="ticker-risk-list">
                  {inTheMoneyRows.map((row) => (
                    <button
                      key={`itm-${row.id}`}
                      className={`ticker-risk-item ticker-risk-button ${isOptionLossAtTwoXCredit(row) ? 'ticker-risk-alert' : ''}`}
                      type="button"
                      onClick={() => handleOpenPositionFromDashboard(row.id)}
                    >
                      <div className="ticker-risk-main">
                        <span>{row.ticker} · {getOptionSideBadge(row.option_side)} · ${row.put_strike.toFixed(2)} strike</span>
                        <small>
                          卖出价 {formatCurrency(row.premium_per_share)}
                          {' · '}
                          买回价 {row.option_market_price_per_share == null ? '-' : formatCurrency(row.option_market_price_per_share)}
                          {' · '}
                          盈利百分比 {row.premiumCapturedPct == null ? '-' : formatPercent(row.premiumCapturedPct)}
                        </small>
                        <small>
                          现价 {tickerMap.get(row.ticker)?.current_price == null ? '-' : formatCurrency(tickerMap.get(row.ticker)?.current_price ?? 0)}
                          {' · '}
                          Breakeven {formatCurrency(row.breakevenPrice)}
                        </small>
                        {isOptionLossAtTwoXCredit(row) ? (
                          <small>已达到权利金 2x 止损线：{formatCurrency(row.premiumIncome * 2)}</small>
                        ) : null}
                      </div>
                      <strong>{row.expiration_date}</strong>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="dashboard-subcard stress-panel">
              <div className="section-subhead">
                <h3>Stress Toggle</h3>
              </div>
              <div className="summary-grid preview-grid stress-summary-grid">
                <article className="summary-card">
                  <span>Base stress</span>
                  <strong>{autoScenario === null ? formatPercent(scenario) : formatPercent(autoScenario)}</strong>
                </article>
                <article className="summary-card emphasized final-stress-card">
                  <span>Final stress</span>
                  <strong>{formatPercent(activeScenario)}</strong>
                </article>
                <article className={`summary-card suggested-action-card suggested-action-${suggestedActionTone}`}>
                  <span>Suggested action</span>
                  <strong>{compactSuggestedActionLabel}</strong>
                </article>
              </div>
              <div className="stress-caption-stack">
                <div className="scenario-caption stress-caption">
                  CNN Fear &amp; Greed:{' '}
                  {vixSnapshot?.fearGreedScore !== null && vixSnapshot?.fearGreedScore !== undefined ? (
                    <>
                      <strong>{vixSnapshot.fearGreedScore.toFixed(1)}</strong>
                      {vixSnapshot.fearGreedRating ? ` (${vixSnapshot.fearGreedRating})` : ''}
                      {fearGreedStressAdjustment < 0
                        ? `，由于恐慌指数较低，额外减少 ${Math.abs(fearGreedStressAdjustment * 100).toFixed(1).replace(/\.0$/, '')}% stress。`
                        : ''}
                    </>
                  ) : (
                    <strong>暂不可用</strong>
                  )}
                </div>
                {(vixSnapshot?.fearGreedError || vixSnapshot?.cacheWriteError || vixSnapshot?.cacheWriteOk === false) && (
                  <div className="scenario-caption stress-caption">
                    <strong>{getFearGreedStatusLabel(vixSnapshot)}</strong>
                    {vixSnapshot?.fearGreedError ? `；fetch error: ${vixSnapshot.fearGreedError}` : ''}
                    {vixSnapshot?.cacheWriteError ? `；cache error: ${vixSnapshot.cacheWriteError}` : ''}
                    {vixSnapshot?.cacheWriteOk === false ? '；cache write failed' : ''}
                  </div>
                )}
                <div className="scenario-caption stress-caption">
                  真实压力按 <strong>{formatPercent(activeScenario)} × Beta</strong> 计算。
                  {baseVixForStress !== null && ` Base stress 参考 7D Avg VIX ${baseVixForStress.toFixed(2)}。`}
                  {vixSnapshot && ` 更新时间：${new Date(vixSnapshot.asOf).toLocaleString()}`}
                </div>
                <div className="scenario-caption stress-caption">
                  <strong>触发原因：</strong>{stressAdjustment.note}
                  {fearGreedStressAdjustment < 0
                    ? `；Fear & Greed ${vixSnapshot?.fearGreedScore?.toFixed(1) ?? '-'} 额外减少 ${Math.abs(fearGreedStressAdjustment * 100).toFixed(1).replace(/\.0$/, '')}%`
                    : vixSnapshot?.fearGreedScore !== null && vixSnapshot?.fearGreedScore !== undefined
                      ? `；Fear & Greed ${vixSnapshot.fearGreedScore.toFixed(1)}`
                      : ''}
                </div>
              </div>
            </div>
          </div>

          <div className="dashboard-subcard dashboard-full-width">
            <div className="section-subhead">
              <h3>总体资金分布</h3>
            </div>
            {capitalAllocationChart.legendSegments.length === 0 ? (
              <div className="empty-state compact-empty">暂无持仓可汇总。</div>
            ) : (
              <div className="exposure-donut-card">
                <div className="exposure-donut-wrap">
                  <svg className="exposure-donut" viewBox="0 0 140 140" role="img" aria-label="Capital allocation pie chart">
                    <circle cx="70" cy="70" r="54" className="donut-track" />
                    {capitalAllocationChart.segments.map((segment) => (
                      <circle
                        key={segment.ticker}
                        cx="70"
                        cy="70"
                        r="54"
                        className="donut-segment"
                        pointerEvents="stroke"
                        style={{
                          stroke: segment.color,
                          strokeDasharray: `${segment.dash} ${segment.gap}`,
                          strokeDashoffset: String(segment.offset)
                        }}
                        onMouseEnter={() =>
                          setHoveredExposureSegment({
                            ticker: segment.ticker,
                            exposure: segment.exposure,
                            share: segment.share,
                            x: 70,
                            y: 8
                          })
                        }
                        onMouseLeave={() => setHoveredExposureSegment(null)}
                      >
                        <title>{`${segment.ticker}: ${formatCurrency(segment.exposure)} (${formatPercent(segment.share)})`}</title>
                      </circle>
                    ))}
                  </svg>
                  <div className="donut-center-label">
                    <span>总资产</span>
                    <strong>{formatCurrency(capitalAllocationChart.totalExposure)}</strong>
                  </div>
                  {hoveredExposureSegment && (
                    <div className="donut-tooltip" role="status" aria-live="polite">
                      <strong>{hoveredExposureSegment.ticker}</strong>
                      <span>{formatCurrency(hoveredExposureSegment.exposure)}</span>
                      <em>{formatPercent(hoveredExposureSegment.share)}</em>
                    </div>
                  )}
                </div>
                <div className="donut-legend-wrap">
                  <div className="capital-summary-grid">
                    {capitalAllocationChart.legendSegments.map((segment) => (
                      <div key={`capital-${segment.ticker}`} className="capital-summary-item">
                        <span>{segment.ticker}</span>
                        <strong>{formatCurrency(segment.exposure)}</strong>
                        <em>{formatPercent(segment.share)}</em>
                      </div>
                    ))}
                  </div>
                  <div className="section-subhead section-subhead-inline">
                    <h3>Ticker 资金占用</h3>
                  </div>
                  <div className="donut-legend">
                    {tickerAllocationItems.map((segment) => (
                      <div key={segment.ticker} className="donut-legend-item">
                        <i className="donut-color" style={{ backgroundColor: segment.color }} />
                        <span>{segment.ticker}</span>
                        <strong>{formatCurrency(segment.exposure)}</strong>
                        <em>{formatPercent(segment.share)}</em>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

        </section>

        <section className="card">
          <div className="section-header">
            <div>
              <p className="section-kicker">Section 2</p>
              <h2>Option Summary</h2>
            </div>
            <div className="section-actions">
              <button className="ghost-button" onClick={handleCopySummary} type="button">
                Copy summary
              </button>
            </div>
          </div>
          {copyMessage && <div className="copy-message">{copyMessage}</div>}
          <div className="summary-grid">
            <article className="summary-card">
              <span>Cash</span>
              <strong>{formatCurrency(config?.cash ?? 0)}</strong>
            </article>
            <article className="summary-card">
              <span>Total capital base</span>
              <strong>{formatCurrency(metrics.totalCapitalBase)}</strong>
            </article>
            <article className="summary-card">
              <span>Total nominal put exposure</span>
              <strong>{formatCurrency(metrics.totalNominalPutExposure)}</strong>
            </article>
            <article className="summary-card">
              <span>Weighted average beta</span>
              <strong>{metrics.weightedAverageBeta.toFixed(2)}</strong>
            </article>
            <article className="summary-card">
              <span>Weighted effective stress</span>
              <strong>{formatPercent(metrics.weightedAverageEffectiveStressPct)}</strong>
            </article>
            <article className="summary-card">
              <span>Total option premium income</span>
              <strong>{formatCurrency(metrics.totalPremiumIncome)}</strong>
            </article>
            <article className="summary-card">
              <span>Portfolio annualized yield</span>
              <strong>{formatPercent(metrics.portfolioAnnualizedYield)}</strong>
            </article>
            <article className="summary-card">
              <span>Annualized yield on total capital</span>
              <strong>{formatPercent(metrics.annualizedYieldOnTotalCash)}</strong>
            </article>
            <article className="summary-card">
              <span>Weighted average days</span>
              <strong>{metrics.weightedAverageDaysToExpiration.toFixed(1)}</strong>
            </article>
            <article className="summary-card emphasized">
              <span>Total put risk</span>
              <strong>{formatCurrency(metrics.totalPutRisk)}</strong>
            </article>
            <article className="summary-card">
              <span>Put risk % of cash</span>
              <strong>{formatPercent(metrics.portfolioRiskPctOfCash)}</strong>
            </article>
            <article className="summary-card">
              <span>Total risk % of total capital</span>
              <strong>{formatPercent(metrics.totalRiskPctOfTotalCapital)}</strong>
            </article>
            <article className="summary-card">
              <span>Risk limit amount</span>
              <strong>{formatCurrency(metrics.riskLimitAmount)}</strong>
            </article>
            <article className="summary-card">
              <span>Remaining risk budget</span>
              <strong>{formatCurrency(metrics.remainingRiskBudget)}</strong>
            </article>
          </div>
        </section>
          </>
        )}

        {activeTab === 'sell' && (
          <>
        <section ref={addPutSectionRef} className="card">
          <div className="section-header">
            <div>
              <p className="section-kicker">Section 1</p>
              <h2>Add Option</h2>
            </div>
          </div>
          <div className="form-grid compact">
            <label>
              <span>Option Type</span>
              <select
                value={putForm.option_side ?? 'put'}
                onChange={(event) =>
                  setPutForm((current) => ({
                    ...current,
                    option_side: event.target.value === 'call' ? 'call' : 'put'
                  }))
                }
              >
                <option value="put">Sell Put</option>
                <option value="call">Covered Call</option>
              </select>
            </label>
            <label>
              <span>Ticker</span>
              <select
                value={putForm.ticker}
                onChange={(event) => setPutForm((current) => ({ ...current, ticker: event.target.value }))}
              >
                <option value="">Select ticker</option>
                {putForm.ticker !== '' && !tickerList.some((entry) => entry.ticker === putForm.ticker) && (
                  <option value={putForm.ticker}>{putForm.ticker}</option>
                )}
                {tickerList.map((entry) => (
                  <option key={entry.ticker} value={entry.ticker}>
                    {entry.ticker}
                  </option>
                ))}
              </select>
              <FieldError message={putErrors.ticker} />
            </label>
            <label>
              <span>Strike</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={putForm.put_strike}
                onChange={(event) => setPutForm((current) => ({ ...current, put_strike: toInputNumber(event.target.value) }))}
              />
              <FieldError message={putErrors.put_strike} />
            </label>
            <label>
              <span>Premium</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={putForm.premium_per_share}
                onChange={(event) =>
                  setPutForm((current) => ({ ...current, premium_per_share: toInputNumber(event.target.value) }))
                }
              />
              <FieldError message={putErrors.premium_per_share} />
            </label>
            <label>
              <span>Contracts</span>
              <input
                type="number"
                min="1"
                step="1"
                value={putForm.contracts}
                onChange={(event) => setPutForm((current) => ({ ...current, contracts: toInputNumber(event.target.value) }))}
              />
              <FieldError message={putErrors.contracts} />
            </label>
            <label>
              <span>Date Sold</span>
              <input
                type="date"
                value={putForm.date_sold}
                onChange={(event) =>
                  setPutForm((current) => ({ ...current, date_sold: event.target.value }))
                }
              />
              <FieldError message={putErrors.date_sold} />
            </label>
            <label>
              <span>Expiration Date</span>
              <input
                type="date"
                value={putForm.expiration_date}
                onChange={(event) =>
                  setPutForm((current) => ({ ...current, expiration_date: event.target.value }))
                }
              />
              <FieldError message={putErrors.expiration_date} />
            </label>
          </div>
          <div className="inline-actions">
            <button className="primary-button" onClick={handleSavePut} type="button" disabled={isCheckingPut}>
              {isCheckingPut ? 'Checking...' : editingPutId ? 'Update option' : 'Add option'}
            </button>
            {editingPutId && (
              <button
                className="ghost-button"
                onClick={() => {
                  setEditingPutId(null);
                  setPutForm(createEmptyPut());
                  setPutErrors({});
                }}
                type="button"
              >
                Cancel edit
              </button>
            )}
          </div>
          {editingPutId && (
            <div className="copy-message">
              当前正在编辑 <strong>{putForm.ticker || `这笔${getOptionSideLabel(putForm.option_side)}`}</strong>，修改后点击 `Update option` 保存。
            </div>
          )}
          <div className="summary-grid preview-grid">
            <article className="summary-card">
              <span>Premium income</span>
              <strong>{formatCurrency(putFormPremiumIncome)}</strong>
            </article>
            <article className="summary-card">
              <span>DTE</span>
              <strong>{putFormDaysToExpiration}</strong>
            </article>
            <article className="summary-card emphasized">
              <span>Annualized yield preview</span>
              <strong>{formatPercent(putFormAnnualizedYield)}</strong>
            </article>
          </div>
          {putCheckResult && (
            <div className={putCheckResult.ok ? 'copy-message' : 'risk-check-banner'}>
              <strong>{putCheckResult.summary}</strong>
              {!putCheckResult.ok && putCheckResult.failures.length > 0 && (
                <ul className="risk-check-list">
                  {putCheckResult.failures.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {preTradeCandidate && (
            <section className="card pretrade-inline" aria-labelledby="pre-trade-title">
              <div className="pretrade-header">
                <p className="section-kicker">Pre-Trade Check</p>
                <h3 id="pre-trade-title">{preTradeCandidate.ticker} {getOptionSideLabel(preTradeCandidate.option_side)} 前确认</h3>
                <div className="copy-message">
                  <strong>第 1 步：</strong> 系统先自动读取财报日、IV、监管/宏观事件摘要
                  <br />
                  <strong>第 2 步：</strong> 完成选择题并点 `开始 Gemini 分析`
                  <br />
                  <strong>第 3 步：</strong> 看完分析后点 `下一步：进入风险检查`
                </div>
              </div>
              <div className="pretrade-intro">
                <p className="modal-copy">
                  先看系统自动抓取的卖前信息，再用下拉选项确认你的计划。系统会把这些选择整理成卖前理由，再结合市场和公司情况做分析。
                </p>
              </div>
              <div className="summary-grid preview-grid">
                <article className="summary-card">
                  <span>Current IV</span>
                  <strong>
                    {preTradeContext?.marketContext?.current_iv == null
                      ? isLoadingPreTradeContext
                        ? '读取中...'
                        : '未确认'
                      : `${(preTradeContext.marketContext.current_iv * 100).toFixed(2)}%`}
                  </strong>
                </article>
                <article className="summary-card">
                  <span>IV Rank</span>
                  <strong>
                    {preTradeContext?.marketContext?.iv_rank == null
                      ? isLoadingPreTradeContext
                        ? '读取中...'
                        : '未确认'
                      : preTradeContext.marketContext.iv_rank.toFixed(1)}
                  </strong>
                </article>
                <article className="summary-card">
                  <span>Put/Call Ratio</span>
                  <strong>
                    {preTradeContext?.marketContext?.put_call_ratio == null
                      ? isLoadingPreTradeContext
                        ? '读取中...'
                        : '未确认'
                      : preTradeContext.marketContext.put_call_ratio.toFixed(2)}
                  </strong>
                </article>
                <article className="summary-card">
                  <span>Next earnings</span>
                  <strong>{preTradeContext?.marketContext?.next_earnings_date ?? (isLoadingPreTradeContext ? '读取中...' : '未确认')}</strong>
                </article>
              </div>
              <div className="analysis-section">
                <h4>系统已读取的卖前重点</h4>
                <div className="analysis-section">
                  <h4>IV 与权利金环境</h4>
                  <p>{preTradeContext?.summary.iv_assessment ?? (isLoadingPreTradeContext ? '正在读取 IV 与权利金环境...' : 'IV 摘要暂不可用')}</p>
                  {renderPreTradeSources(preTradeContext?.source_map?.iv_assessment)}
                </div>
                <div className="analysis-section">
                  <h4>Put/Call Ratio</h4>
                  <p>
                    {preTradeContext?.marketContext?.put_call_ratio == null
                      ? isLoadingPreTradeContext
                        ? '正在读取 Put/Call Ratio...'
                        : 'Put/Call Ratio 暂不可用'
                      : `当前 Put/Call OI Ratio ${preTradeContext.marketContext.put_call_ratio.toFixed(2)}。数值越高，通常表示保护性 Put 或避险需求更强；数值越低，则更偏向 Call 活跃。`}
                  </p>
                  {renderPreTradeSources(
                    preTradeContext?.sources?.filter((source) => source.title.toLowerCase().includes('put/call')) ?? []
                  )}
                </div>
                <div className="analysis-section">
                  <h4>财报窗口</h4>
                  <p>{preTradeContext?.summary.earnings_assessment ?? (isLoadingPreTradeContext ? '正在读取财报日...' : '财报信息暂不可用')}</p>
                  {renderPreTradeSources(preTradeContext?.source_map?.earnings_assessment)}
                </div>
                <div className="analysis-section">
                  <h4>特殊事件窗口</h4>
                  {preTradeContext?.summary.special_window_assessment &&
                  !preTradeContext.summary.special_window_assessment.includes('网站暂未直接提供')
                    ? <p>{preTradeContext.summary.special_window_assessment}</p>
                    : null}
                  {isEnrichingPreTradeContext ? <div className="copy-message">正在补充 Gemini 搜索结果...</div> : null}
                  {renderPreTradeSources(preTradeContext?.source_map?.special_window_assessment)}
                </div>
                <div className="analysis-section">
                  <h4>基本面风险</h4>
                  {preTradeContext?.summary.fundamental_risk_assessment &&
                  !preTradeContext.summary.fundamental_risk_assessment.includes('网站暂未直接提供')
                    ? <p>{preTradeContext.summary.fundamental_risk_assessment}</p>
                    : null}
                  {isEnrichingPreTradeContext ? <div className="copy-message">正在补充 Gemini 搜索结果...</div> : null}
                  {renderPreTradeSources(preTradeContext?.source_map?.fundamental_risk_assessment)}
                </div>
                {preTradeContext?.summary.key_flags && preTradeContext.summary.key_flags.length > 0 ? (
                  <div className="analysis-section">
                    <h4>重点提醒</h4>
                    <ul className="risk-check-list">
                      {preTradeContext.summary.key_flags.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {preTradeContext?.sources && preTradeContext.sources.length > 0 ? (
                  <div className="analysis-sources">
                    <span>系统读取来源</span>
                    {preTradeContext.sources.map((source) => (
                      <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                        {source.title}
                      </a>
                    ))}
                  </div>
                ) : null}
              </div>
              <div className="form-grid compact pretrade-question-grid">
                <label>
                  <span>当前 IV 是否够高？</span>
                  <select
                    value={preTradeQuestionnaire.ivView}
                    onChange={(event) =>
                      setPreTradeQuestionnaire((current) => ({ ...current, ivView: event.target.value }))
                    }
                  >
                    <option value="">请选择</option>
                    {PRE_TRADE_IV_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>现在是不是特殊事件窗口？</span>
                  <select
                    value={preTradeQuestionnaire.eventWindowView}
                    onChange={(event) =>
                      setPreTradeQuestionnaire((current) => ({ ...current, eventWindowView: event.target.value }))
                    }
                  >
                    <option value="">请选择</option>
                    {PRE_TRADE_EVENT_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>如果价格快速反向，我怎么处理？</span>
                  <select
                    value={preTradeQuestionnaire.reversalPlan}
                    onChange={(event) =>
                      setPreTradeQuestionnaire((current) => ({ ...current, reversalPlan: event.target.value }))
                    }
                  >
                    <option value="">请选择</option>
                    {getReversalPlanOptions(preTradeCandidate.option_side).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>这笔交易的目的是什么？</span>
                  <select
                    value={preTradeQuestionnaire.tradeGoal}
                    onChange={(event) =>
                      setPreTradeQuestionnaire((current) => ({ ...current, tradeGoal: event.target.value }))
                    }
                  >
                    <option value="">请选择</option>
                    {getTradeGoalOptions(preTradeCandidate.option_side).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>退出条件是什么？</span>
                  <select
                    value={preTradeQuestionnaire.exitRule}
                    onChange={(event) =>
                      setPreTradeQuestionnaire((current) => ({ ...current, exitRule: event.target.value }))
                    }
                  >
                    <option value="">请选择</option>
                    {PRE_TRADE_EXIT_RULE_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              {preTradeError && <div className="risk-check-banner">{preTradeError}</div>}
              <div className="pretrade-progress">
                {preTradeAnalysis
                  ? 'Gemini 分析已完成，可以进入下一步。'
                  : isLoadingPreTradeContext
                    ? '系统正在读取财报、监管和宏观信息...'
                    : isEnrichingPreTradeContext
                      ? '网站信息已展示，Gemini 搜索结果会稍后自动补上。'
                    : '完成选择题并做完 Gemini 分析后，下一步按钮会解锁。'}
              </div>
              {preTradeAnalysis && (
                <div className="analysis-body">
                  <div className="analysis-topline">
                    <div className="summary-card emphasized">
                      <span>结论</span>
                      <strong>{preTradeAnalysis.analysis.verdict}</strong>
                    </div>
                    <div className="summary-card">
                      <span>一句话总结</span>
                      <strong>{preTradeAnalysis.analysis.summary}</strong>
                    </div>
                  </div>
                  <div className="analysis-section">
                    <h4>你的交易理由</h4>
                    <p>{preTradeAnalysis.analysis.rationale_check}</p>
                  </div>
                  <div className="analysis-section">
                    <h4>核心风险</h4>
                    <ul className="risk-check-list">
                      {preTradeAnalysis.analysis.key_risks.map((risk) => (
                        <li key={risk}>{risk}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="analysis-section">
                    <h4>核心测算</h4>
                    <div className="analysis-calcs">
                      <div className="summary-card">
                        <span>最多盈利</span>
                        <strong>{preTradeAnalysis.analysis.calc.max_profit}</strong>
                      </div>
                      <div className="summary-card">
                        <span>回撤 10% 风险</span>
                        <strong>{preTradeAnalysis.analysis.calc.risk_at_10pct_drop}</strong>
                      </div>
                    </div>
                  </div>
                  <div className="analysis-section">
                    <h4>最坏情况</h4>
                    <p>{preTradeAnalysis.analysis.worst_case}</p>
                  </div>
                  <div className="analysis-section">
                    <h4>基本面提醒</h4>
                    <p>{preTradeAnalysis.analysis.fundamental_note}</p>
                  </div>
                  <div className="analysis-section">
                    <h4>数据快照（Barchart 优先）</h4>
                    <p>
                      IV Rank：{preTradeAnalysis.marketContext?.iv_rank == null ? '未确认' : preTradeAnalysis.marketContext.iv_rank.toFixed(1)}
                      <br />
                      Current IV：
                      {preTradeAnalysis.marketContext?.current_iv == null
                        ? '未确认'
                        : `${(preTradeAnalysis.marketContext.current_iv * 100).toFixed(2)}%`}
                      <br />
                      Historical IV：
                      {preTradeAnalysis.marketContext?.historical_iv == null
                        ? '未确认'
                        : `${(preTradeAnalysis.marketContext.historical_iv * 100).toFixed(2)}%`}
                      <br />
                      IV Percentile：
                      {preTradeAnalysis.marketContext?.iv_percentile == null
                        ? '未确认'
                        : preTradeAnalysis.marketContext.iv_percentile.toFixed(1)}
                      <br />
                      PCR (OI)：
                      {preTradeAnalysis.marketContext?.put_call_ratio == null
                        ? '未确认'
                        : preTradeAnalysis.marketContext.put_call_ratio.toFixed(2)}
                    </p>
                  </div>
                  <div className="analysis-section">
                    <h4>IV Rank 观察（结构化数据参考）</h4>
                    <p>
                      当前 IV Rank：{preTradeAnalysis.analysis.current_iv_rank || '未确认'}
                      <br />
                      {preTradeAnalysis.analysis.iv_rank_note}
                      <br />
                      出处：{preTradeAnalysis.analysis.iv_rank_source || '未确认'}
                      <br />
                      时间：{preTradeAnalysis.analysis.iv_rank_time || '未确认'}
                      {preTradeAnalysis.analysis.iv_rank_link ? (
                        <>
                          <br />
                          <a href={preTradeAnalysis.analysis.iv_rank_link} target="_blank" rel="noreferrer">
                            打开 IV Rank 来源链接
                          </a>
                        </>
                      ) : null}
                    </p>
                  </div>
                  <div className="analysis-section">
                    <h4>Current IV 判断</h4>
                    <p>{preTradeAnalysis.analysis.current_iv_check || '未确认'}</p>
                  </div>
                  <div className="analysis-section">
                    <h4>技术面检查</h4>
                    <p>
                      MA+RSI：{preTradeAnalysis.analysis.marsi_check || '未确认'}
                      <br />
                      RSI 是否超卖：{preTradeAnalysis.analysis.rsi_check || '未确认'}
                      <br />
                      200 日均线：{preTradeAnalysis.analysis.ma200_check || '未确认'}
                    </p>
                  </div>
                  <div className="analysis-section">
                    <h4>财报日预警</h4>
                    <p>
                      下一个财报日：{preTradeAnalysis.analysis.next_earnings_date || '未确认'}
                      <br />
                      {preTradeAnalysis.analysis.earnings_warning}
                    </p>
                  </div>
                  {preTradeAnalysis.analysis.fundamental_events.length > 0 && (
                    <div className="analysis-section">
                      <h4>具体事件</h4>
                      <ul className="risk-check-list">
                        {preTradeAnalysis.analysis.fundamental_events.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="analysis-section">
                    <h4>建议动作</h4>
                    <p>{preTradeAnalysis.analysis.action}</p>
                  </div>
                  {preTradeAnalysis.sources.length > 0 && (
                    <div className="analysis-sources">
                      <span>参考来源</span>
                      {preTradeAnalysis.sources.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="modal-actions pretrade-actions">
                <button
                  className="ghost-button"
                  onClick={() => {
                    setPreTradeCandidate(null);
                    setPreTradeQuestionnaire(createEmptyPreTradeQuestionnaire());
                    setPreTradeError('');
                    setPreTradeAnalysis(null);
                    setPreTradeContext(null);
                  }}
                  type="button"
                >
                  取消
                </button>
                <button
                  className="ghost-button"
                  onClick={() => void handleAnalyzePreTrade()}
                  type="button"
                  disabled={isPreTradeAnalyzing || isLoadingPreTradeContext || !isPreTradeQuestionnaireComplete(preTradeQuestionnaire)}
                >
                  {isPreTradeAnalyzing ? '分析中...' : '开始 Gemini 分析'}
                </button>
                <button
                  className="primary-button"
                  onClick={() => void handleConfirmPreTrade()}
                  type="button"
                  disabled={!preTradeAnalysis || isPreTradeAnalyzing}
                >
                  下一步：进入风险检查
                </button>
              </div>
            </section>
          )}

          {forceSellCandidate && putCheckResult && !putCheckResult.ok && (
            <div className="modal-backdrop" role="presentation">
              <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="force-sell-title">
                <p className="section-kicker">Risk Warning</p>
                <h3 id="force-sell-title">你确定要卖吗？</h3>
                <p className="modal-copy">系统判断这笔交易有提示风险。默认不要执行；如果你确认承担风险，可以强制继续。</p>
                <div className="risk-check-list-wrap">
                  <ul className="risk-check-list">
                    {putCheckResult.failures.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div className="modal-actions">
                  <button
                    className="ghost-button"
                    onClick={() => {
                      setForceSellCandidate(null);
                      setPreTradeCandidate(null);
                      setPreTradeQuestionnaire(createEmptyPreTradeQuestionnaire());
                      setPreTradeError('');
                      setPreTradeAnalysis(null);
                      setPreTradeContext(null);
                    }}
                    type="button"
                  >
                    取消
                  </button>
                  <button
                    className="ghost-button"
                    onClick={() => {
                      setForceSellCandidate(null);
                      setPreTradeCandidate(null);
                      setPreTradeQuestionnaire(createEmptyPreTradeQuestionnaire());
                      setPreTradeError('');
                      setPreTradeAnalysis(null);
                      setPreTradeContext(null);
                      addPutSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                    type="button"
                  >
                    Edit
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => {
                      savePutPosition(forceSellCandidate, editingPutId, setPuts, setTickerList);
                      const nextConfig = applyOptionOpenCash(
                        config,
                        configForm ?? DEFAULT_CONFIG,
                        forceSellCandidate,
                        editingPutId !== null
                      );
                      saveConfig(nextConfig);
                      setConfig(nextConfig);
                      setConfigForm(nextConfig);
                      setConfigErrors({});
                      setForceSellCandidate(null);
                      setPreTradeCandidate(null);
                      setPreTradeQuestionnaire(createEmptyPreTradeQuestionnaire());
                      setPreTradeError('');
                      setPreTradeAnalysis(null);
                      setPreTradeContext(null);
                      setPutForm(createEmptyPut());
                      setPutErrors({});
                      setEditingPutId(null);
                    }}
                    type="button"
                  >
                    Process Anyway
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

          </>
        )}

        {activeTab === 'positions' && (
          <>
        <section className="card">
          <div className="section-header">
            <div>
              <p className="section-kicker">Section 1</p>
              <h2>Option Positions</h2>
            </div>
          </div>
          <div className="filter-bar">
            <label className="filter-chip">
              <span>Ticker</span>
              <select
                className="ticker-filter-select"
                value={positionTickerFilter}
                onChange={(event) => setPositionTickerFilter(event.target.value)}
              >
                <option value="ALL">All tickers</option>
                {availablePositionTickers.map((ticker) => (
                  <option key={ticker} value={ticker}>
                    {ticker}
                  </option>
                ))}
              </select>
            </label>
            <label className="filter-chip">
              <span>Filter</span>
              <select
                className="ticker-filter-select"
                value={positionFilter}
                onChange={(event) =>
                  setPositionFilter(event.target.value as 'ALL' | 'WITHIN_7_DAYS' | 'PROFIT_OVER_60')
                }
              >
                <option value="ALL">All positions</option>
                <option value="WITHIN_7_DAYS">Expiring in 7 days</option>
                <option value="PROFIT_OVER_60">Premium captured over 60%</option>
              </select>
            </label>
            <label className="filter-chip">
              <span>Option Type</span>
              <select
                className="ticker-filter-select"
                value={positionOptionTypeFilter}
                onChange={(event) => setPositionOptionTypeFilter(event.target.value as 'ALL' | 'PUT' | 'CALL')}
              >
                <option value="ALL">All options</option>
                <option value="PUT">Sell Put</option>
                <option value="CALL">Covered Call</option>
              </select>
            </label>
            <label className="filter-chip">
              <span>Moneyness</span>
              <select
                className="ticker-filter-select"
                value={moneynessFilter}
                onChange={(event) => setMoneynessFilter(event.target.value as 'ALL' | 'ITM' | 'OTM')}
              >
                <option value="ALL">All moneyness</option>
                <option value="ITM">In the money</option>
                <option value="OTM">Out of the money</option>
              </select>
            </label>
            <label className="filter-chip">
              <span>Sort</span>
              <select
                className="ticker-filter-select"
                value={positionSort}
                onChange={(event) =>
                  setPositionSort(event.target.value as 'DEFAULT' | 'EXPIRATION' | 'PUT_RISK' | 'LOSS_PCT' | 'ANNUALIZED_YIELD')
                }
              >
                <option value="DEFAULT">Ticker / expiration</option>
                <option value="EXPIRATION">Expiration date</option>
                <option value="PUT_RISK">Risk high to low</option>
                <option value="LOSS_PCT">Loss % worst first</option>
                <option value="ANNUALIZED_YIELD">Annualized yield high to low</option>
              </select>
            </label>
          </div>
          <div className="inline-actions">
            <button
              className="primary-button"
              onClick={() => void handleRefreshAllOptionPrices()}
              type="button"
              disabled={isRefreshingAllOptions}
            >
              {isRefreshingAllOptions ? 'Refreshing all options...' : 'Refresh all options'}
            </button>
          </div>
          {autoRefreshOptionsProgress && (
            <div className="copy-message refresh-progress-card">
              <div className="refresh-progress-header">
                <strong>
                  系统正在自动刷新第 {autoRefreshOptionsProgress.current}/{autoRefreshOptionsProgress.total} 笔期权
                  {autoRefreshOptionsProgress.ticker ? `：${autoRefreshOptionsProgress.ticker}` : ''}
                </strong>
                <span>
                  成功 {autoRefreshOptionsProgress.successCount} · 失败 {autoRefreshOptionsProgress.failureCount}
                </span>
              </div>
              <div className="refresh-progress-bar" aria-hidden="true">
                <div
                  className="refresh-progress-fill"
                  style={{
                    width: `${autoRefreshOptionsProgress.total === 0 ? 0 : (autoRefreshOptionsProgress.current / autoRefreshOptionsProgress.total) * 100}%`
                  }}
                />
              </div>
            </div>
          )}
          {refreshAllOptionsProgress && (
            <div className="copy-message refresh-progress-card">
              <div className="refresh-progress-header">
                <strong>
                  正在刷新第 {refreshAllOptionsProgress.current}/{refreshAllOptionsProgress.total} 笔期权
                  {refreshAllOptionsProgress.ticker ? `：${refreshAllOptionsProgress.ticker}` : ''}
                </strong>
                <span>
                  成功 {refreshAllOptionsProgress.successCount} · 失败 {refreshAllOptionsProgress.failureCount}
                </span>
              </div>
              <div className="refresh-progress-bar" aria-hidden="true">
                <div
                  className="refresh-progress-fill"
                  style={{
                    width: `${refreshAllOptionsProgress.total === 0 ? 0 : (refreshAllOptionsProgress.current / refreshAllOptionsProgress.total) * 100}%`
                  }}
                />
              </div>
            </div>
          )}
          {importExportMessage && <div className="copy-message">{importExportMessage}</div>}
          {metrics.putRows.length === 0 ? (
            <div className="empty-state">暂无 Option 仓位。</div>
          ) : visiblePutRows.length === 0 ? (
            <div className="empty-state">当前筛选下没有持仓。</div>
          ) : (
            <div className="position-list">
              {visiblePutRows.map((row) => (
                <article
                  key={row.id}
                  className="position-card"
                  ref={(element) => {
                    positionCardRefs.current[row.id] = element;
                  }}
                >
                  {(() => {
                    const optionPriceOverride = optionPriceOverrides[row.id];
                    const displayedOptionPrice = optionPriceOverride?.price ?? row.option_market_price_per_share ?? null;
                    const displayedOptionTheta = optionPriceOverride?.theta ?? row.option_theta_per_share ?? null;
                    const displayedOptionUpdatedAt = optionPriceOverride?.updatedAt ?? row.option_market_price_updated ?? null;
                    const displayedOptionCloseCost =
                      typeof displayedOptionPrice === 'number' ? displayedOptionPrice * row.contracts * 100 : null;
                    const displayedUnrealizedPnl =
                      typeof displayedOptionPrice === 'number'
                        ? (row.premium_per_share - displayedOptionPrice) * row.contracts * 100
                        : null;
                    const displayedPremiumCapturedPct =
                      typeof displayedOptionPrice === 'number' && row.premium_per_share > 0
                        ? (row.premium_per_share - displayedOptionPrice) / row.premium_per_share
                        : null;
                    const displayedThetaIncomePerDay =
                      typeof displayedOptionTheta === 'number' ? Math.max(-displayedOptionTheta, 0) * row.contracts * 100 : null;
                    const hasReachedTwoXLoss = isOptionLossAtTwoXCredit({
                      premiumIncome: row.premiumIncome,
                      unrealizedPnl: displayedUnrealizedPnl
                    });
                    const tickerEntry = tickerMap.get(row.ticker);
                    const assessment = getPositionRiskAssessment(row, tickerEntry);
                    return (
                      <>
                  <div className={`position-card-shell ${hasReachedTwoXLoss ? 'position-card-alert' : ''}`}>
                  <div className="position-card-top">
                    <div className="position-title">
                      <div className="position-title-row">
                        <h3>{row.ticker}</h3>
                        <span className="position-chip">{getOptionSideBadge(row.option_side)}</span>
                        <span className="position-chip">
                          {formatCurrency(row.put_strike)} strike
                        </span>
                        <span className={`pill-badge ${assessment.tone}`}>{assessment.label}</span>
                        {hasReachedTwoXLoss ? <span className="pill-badge high-risk">2x 亏损线</span> : null}
                      </div>
                      <p>{row.contracts} contract{row.contracts > 1 ? 's' : ''} · Exp {row.expiration_date || '-'}</p>
                    </div>
                    <div className="position-actions">
                      <button onClick={() => void handleAnalyzePosition(row)} type="button" disabled={analysisPositionId !== null}>
                        {analysisPositionId === row.id ? 'Analyzing...' : 'Analyze'}
                      </button>
                      <button
                        onClick={() => void handleRefreshOptionPrice(row)}
                        type="button"
                        disabled={isRefreshingAllOptions || refreshingOptionPriceId !== null || autoRefreshingOptionPriceId === row.id}
                      >
                        {refreshingOptionPriceId === row.id
                          ? 'Refreshing option...'
                          : autoRefreshingOptionPriceId === row.id
                            ? 'Auto refreshing...'
                            : 'Refresh option'}
                      </button>
                      <button onClick={() => handleEditPut(row)} type="button">
                        Edit
                      </button>
                      <button onClick={() => handleOpenClosePut(row)} type="button">
                        Close
                      </button>
                      <button onClick={() => handleDeletePut(row.id)} type="button">
                        Delete
                      </button>
                    </div>
                  </div>

                  {hasReachedTwoXLoss ? (
                    <div className="position-risk-banner">
                      已达到权利金 2x 止损线：{formatCurrency(row.premiumIncome * 2)}
                    </div>
                  ) : null}

                  <div className="position-highlights">
                    <div className="position-highlight">
                      <span>Risk</span>
                      <strong>{formatCurrency(row.putRisk)}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Annualized yield</span>
                      <strong>{formatPercent(row.annualizedYield)}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Premium income</span>
                      <strong>{formatCurrency(row.premiumIncome)}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Risk % of cash</span>
                      <strong>{formatPercent(row.riskPctOfCash)}</strong>
                    </div>
                  </div>

                  <div className="position-highlights">
                    <div className="position-highlight">
                      <span>Current option price</span>
                      <strong>{displayedOptionPrice == null ? '-' : `${formatCurrency(displayedOptionPrice)}/share`}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Theta</span>
                      <strong>{displayedOptionTheta == null ? '-' : displayedOptionTheta.toFixed(3)}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Theta income / day</span>
                      <strong>{displayedThetaIncomePerDay == null ? '-' : formatCurrency(displayedThetaIncomePerDay)}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Estimated close cost</span>
                      <strong>{displayedOptionCloseCost == null ? '-' : formatCurrency(displayedOptionCloseCost)}</strong>
                    </div>
                  </div>

                  {optionPriceMessages[row.id] && (
                    <div className={`inline-status ${optionPriceMessages[row.id].tone}`}>
                      {optionPriceMessages[row.id].text}
                    </div>
                  )}

                  <div className="position-highlights">
                    <div className="position-highlight">
                      <span>Unrealized P/L</span>
                      <strong>{displayedUnrealizedPnl == null ? '-' : formatCurrency(displayedUnrealizedPnl)}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Premium captured</span>
                      <strong>{displayedPremiumCapturedPct == null ? '-' : formatPercent(displayedPremiumCapturedPct)}</strong>
                    </div>
                  </div>

                  <div className="position-signals">
                    <div className="position-signal"><span>Current price</span><strong>{tickerEntry?.current_price == null ? '-' : tickerEntry.current_price.toFixed(2)}</strong></div>
                    <div className="position-signal"><span>RSI</span><strong>{tickerEntry?.rsi_14 == null ? '-' : tickerEntry.rsi_14.toFixed(1)}</strong></div>
                    <div className="position-signal"><span>IV Rank</span><strong>{row.iv_rank.toFixed(1)}</strong></div>
                    <div className="position-signal"><span>MA21</span><strong>{tickerEntry?.ma_21 == null ? '-' : tickerEntry.ma_21.toFixed(2)}</strong></div>
                    <div className="position-signal"><span>MA200</span><strong>{tickerEntry?.ma_200 == null ? '-' : tickerEntry.ma_200.toFixed(2)}</strong></div>
                    <div className="position-signal"><span>Current IV</span><strong>{tickerEntry?.current_iv == null ? '-' : `${(tickerEntry.current_iv * 100).toFixed(1)}%`}</strong></div>
                    <div className="position-signal"><span>PCR</span><strong>{tickerEntry?.put_call_ratio == null ? '-' : tickerEntry.put_call_ratio.toFixed(2)}</strong></div>
                  </div>

                  <div className="position-judgment">
                    <span>判断依据</span>
                    <strong>{assessment.reasons.join(' · ')}</strong>
                  </div>

                  <div className="position-metrics">
                    <div className="position-metric"><span>Premium / share</span><strong>{formatCurrency(row.premium_per_share)}</strong></div>
                    <div className="position-metric">
                      <span>Distance to strike</span>
                      <strong>{formatDistanceToStrikeLabel(row.distance_pct, row.option_side === 'call' ? 'call' : 'put')}</strong>
                    </div>
                    <div className="position-metric"><span>Date Sold</span><strong>{row.date_sold || '-'}</strong></div>
                    <div className="position-metric"><span>Expiration</span><strong>{row.expiration_date || '-'}</strong></div>
                    <div className="position-metric"><span>Nominal exposure</span><strong>{formatCurrency(row.nominalExposure)}</strong></div>
                    <div className="position-metric"><span>Days</span><strong>{row.daysToExpiration}</strong></div>
                    <div className="position-metric"><span>Beta</span><strong>{row.beta.toFixed(2)}</strong></div>
                    {row.option_side !== 'call' ? (
                      <>
                        <div className="position-metric"><span>Stress after distance</span><strong>{formatPercent(row.baseStressAfterDistancePct)}</strong></div>
                        <div className="position-metric"><span>Effective stress</span><strong>{formatPercent(row.effectiveStressPct)}</strong></div>
                        <div className="position-metric"><span>Breakeven</span><strong>{formatCurrency(row.breakevenPrice)}</strong></div>
                        <div className="position-metric"><span>Net cost basis</span><strong>{formatCurrency(row.netCostBasis)}</strong></div>
                      </>
                    ) : (
                      <div className="position-metric"><span>Call breakeven</span><strong>{formatCurrency(row.breakevenPrice)}</strong></div>
                    )}
                    <div className="position-metric"><span>Option price updated</span><strong>{displayedOptionUpdatedAt ? new Date(displayedOptionUpdatedAt).toLocaleString() : '-'}</strong></div>
                  </div>
                  </div>
                  {row.decision_snapshot && (
                    <div className="analysis-section">
                      <h4>卖出决策记录</h4>
                      <div className="decision-record-header">
                        <div className="summary-card">
                          <span>当时结论</span>
                          <strong>{row.decision_snapshot.verdict}</strong>
                        </div>
                        <div className="summary-card">
                          <span>一句话总结</span>
                          <strong>{row.decision_snapshot.summary}</strong>
                        </div>
                      </div>
                      {row.decision_rationale ? (
                        <div className="decision-record-grid">
                          {parseDecisionRationale(row.decision_rationale).map((item) => (
                            <div className="decision-record-item" key={`${row.id}-${item.label}`}>
                              <span>{item.label}</span>
                              <strong>{item.value || '—'}</strong>
                            </div>
                          ))}
                        </div>
                      ) : null}
                      <div className="decision-record-meta">
                        <p><strong>IV Rank（参考）</strong>{row.decision_snapshot.current_iv_rank || '未确认'} · {row.decision_snapshot.iv_rank_note || '—'}</p>
                        <p><strong>IV Rank 出处</strong>{row.decision_snapshot.iv_rank_source || '未确认'}</p>
                        <p><strong>IV Rank 时间</strong>{row.decision_snapshot.iv_rank_time || '未确认'}</p>
                      </div>
                      {row.decision_snapshot.iv_rank_link ? (
                        <p className="decision-record-link">
                          <strong>IV Rank 链接</strong>
                          <a href={row.decision_snapshot.iv_rank_link} target="_blank" rel="noreferrer">
                            {row.decision_snapshot.iv_rank_link}
                          </a>
                        </p>
                      ) : null}
                      <p><strong>建议动作：</strong>{row.decision_snapshot.action}</p>
                      <div className="analysis-calcs">
                        <div className="summary-card">
                          <span>最多盈利</span>
                          <strong>{row.decision_snapshot.max_profit}</strong>
                        </div>
                        <div className="summary-card">
                          <span>10% 回撤风险</span>
                          <strong>{row.decision_snapshot.risk_at_10pct_drop}</strong>
                        </div>
                      </div>
                      <p><strong>最坏情况：</strong>{row.decision_snapshot.worst_case}</p>
                      <p><strong>基本面提醒：</strong>{row.decision_snapshot.fundamental_note}</p>
                      {row.decision_snapshot.fundamental_events.length > 0 && (
                        <ul className="risk-check-list">
                          {row.decision_snapshot.fundamental_events.map((item) => (
                            <li key={item}>{item}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                      </>
                    );
                  })()}
                </article>
              ))}
            </div>
          )}
        </section>
          </>
        )}

        {activeTab === 'history' && (
          <section className="card">
            <div className="section-header">
              <div>
                <p className="section-kicker">Section 1</p>
                <h2>历史记录</h2>
              </div>
              <div className="inline-actions">
                <select
                  aria-label="History filter"
                  value={historyFilter}
                  onChange={(event) => setHistoryFilter(event.target.value as HistoryFilter)}
                >
                  <option value="all">全部</option>
                  <option value="profit">盈利</option>
                  <option value="loss">亏损</option>
                </select>
              </div>
            </div>
            <div className="summary-grid history-summary-grid">
              <article className="summary-card">
                <span>历史总盈亏</span>
                <strong>{formatCurrency(historySummary.totalRealizedPnl)}</strong>
              </article>
              <article className="summary-card">
                <span>已平仓笔数</span>
                <strong>{historySummary.totalClosed}</strong>
              </article>
              <article className="summary-card">
                <span>盈利笔数</span>
                <strong>{historySummary.wins}</strong>
              </article>
              <article className="summary-card">
                <span>亏损笔数</span>
                <strong>{historySummary.losses}</strong>
              </article>
              <article className="summary-card">
                <span>持平笔数</span>
                <strong>{historySummary.breakEven}</strong>
              </article>
              <article className="summary-card">
                <span>胜率</span>
                <strong>{formatPercent(historySummary.winRate)}</strong>
              </article>
            </div>
            {unifiedHistory.length === 0 ? (
              <div className="empty-state">还没有历史记录。等你平仓期权、买入股票或卖出股票后，这里会开始累计。</div>
            ) : visibleHistoryItems.length === 0 ? (
              <div className="empty-state">当前筛选条件下没有匹配的历史记录。</div>
            ) : (
              <div className="history-list">
                {visibleHistoryItems.map((item) =>
                  item.kind === 'option' ? (
                    <div key={item.id} className="history-row history-trade-row">
                      <div className="history-trade-main">
                        <div className="ticker-risk-main">
                          <span>{item.trade.ticker} · {getOptionSideBadge(item.trade.option_side)} · ${item.trade.put_strike.toFixed(2)} strike</span>
                          <small>
                            卖出 {item.trade.date_sold} · 平仓 {item.trade.closed_at} · {item.trade.contracts} contract{item.trade.contracts > 1 ? 's' : ''}
                          </small>
                          <small>
                            收入 {formatCurrency(item.trade.premium_sold_per_share)}/share · {item.trade.close_reason === 'expired' ? 'Expired 到期（权利金全额回收）' : `买回 ${formatCurrency(item.trade.premium_bought_back_per_share)}/share`}
                          </small>
                        </div>
                        <label className="history-reflection-field">
                          <span>复盘 / 反思总结</span>
                          <textarea
                            value={item.trade.reflection_notes ?? ''}
                            onChange={(event) => handleUpdateClosedTradeReflection(item.trade.id, event.target.value)}
                            placeholder="记录这笔交易做得不好的地方、触发亏损的原因、下次如何避免。"
                          />
                        </label>
                      </div>
                      <div className="history-row-actions">
                        <strong>{formatCurrency(item.trade.realized_pnl)}</strong>
                        <button type="button" className="ghost-button" onClick={() => handleEditClosedTrade(item.trade)}>
                          Edit
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div key={item.id} className="history-row history-trade-row">
                      <div className="history-trade-main">
                        <div className="ticker-risk-main">
                          <span>{item.trade.ticker} · 股票 · {item.trade.action === 'buy' ? '买入' : '卖出'}</span>
                          <small>
                            {item.trade.traded_at} · {item.trade.shares} 股 · {formatCurrency(item.trade.price_per_share)}/share
                          </small>
                          <small>
                            现金变化 {formatSignedCurrency(item.trade.cash_change)}
                            {item.trade.action === 'sell' ? ` · 已实现盈亏 ${formatSignedCurrency(item.trade.realized_pnl)}` : ' · 建仓记录'}
                          </small>
                        </div>
                      </div>
                      <div className="history-row-actions">
                        <strong>{formatCurrency(item.trade.realized_pnl)}</strong>
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </section>
        )}

        {closePreview && (
          <div className="modal-backdrop" role="presentation" onClick={() => setClosePreview(null)}>
            <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="close-position-title" onClick={(event) => event.stopPropagation()}>
              <p className="section-kicker">Close Position</p>
              <h3 id="close-position-title">{closePreview.row.ticker} 平仓记录</h3>
              <div className="form-grid compact">
                <label>
                  <span>Close contracts</span>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    max={closePreview.row.contracts}
                    value={closePreview.contractsToClose}
                    onChange={(event) =>
                      setClosePreview((current) => (current ? { ...current, contractsToClose: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Buyback premium / share</span>
                  <input
                    type="number"
                    step="0.01"
                    value={closePreview.buybackPremiumPerShare}
                    onChange={(event) =>
                      setClosePreview((current) => (current ? { ...current, buybackPremiumPerShare: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Closed date</span>
                  <input
                    type="date"
                    value={closePreview.closedAt}
                    onChange={(event) =>
                      setClosePreview((current) => (current ? { ...current, closedAt: event.target.value } : current))
                    }
                  />
                </label>
                <label className="modal-textarea-field history-reflection-modal-field">
                  <span>复盘 / 反思总结</span>
                  <textarea
                    value={closePreview.reflectionNotes}
                    onChange={(event) =>
                      setClosePreview((current) => (current ? { ...current, reflectionNotes: event.target.value } : current))
                    }
                    placeholder="比如：卖得太激进、仓位太大、忽略了财报/均线/趋势，下一次准备怎么改。"
                  />
                </label>
              </div>
              <div className="scenario-caption">
                这次将平仓 {closePreview.contractsToClose || '0'} / {closePreview.row.contracts} 张：
                卖出 {formatCurrency(closePreview.row.premium_per_share)}/share，当前买回
                {' '}
                {formatCurrency(Number(closePreview.buybackPremiumPerShare || 0))}/share。
              </div>
              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setClosePreview(null)} type="button">
                  Cancel
                </button>
                <button className="primary-button" onClick={confirmClosePut} type="button">
                  Confirm Close
                </button>
              </div>
            </div>
          </div>
        )}

        {historyEditPreview && (
          <div className="modal-backdrop" role="presentation" onClick={() => setHistoryEditPreview(null)}>
            <div className="modal-card" role="dialog" aria-modal="true" aria-labelledby="history-edit-title" onClick={(event) => event.stopPropagation()}>
              <p className="section-kicker">Edit History</p>
              <h3 id="history-edit-title">{historyEditPreview.ticker} 历史记录</h3>
              <div className="form-grid compact">
                <label>
                  <span>Option Type</span>
                  <select
                    value={historyEditPreview.optionSide}
                    onChange={(event) =>
                      setHistoryEditPreview((current) =>
                        current
                          ? { ...current, optionSide: event.target.value === 'call' ? 'call' : 'put' }
                          : current
                      )
                    }
                  >
                    <option value="put">Sell Put</option>
                    <option value="call">Covered Call</option>
                  </select>
                </label>
                <label>
                  <span>Ticker</span>
                  <input
                    type="text"
                    value={historyEditPreview.ticker}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, ticker: event.target.value.toUpperCase() } : current))
                    }
                  />
                </label>
                <label>
                  <span>Strike</span>
                  <input
                    type="number"
                    step="0.01"
                    value={historyEditPreview.putStrike}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, putStrike: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Premium sold / share</span>
                  <input
                    type="number"
                    step="0.01"
                    value={historyEditPreview.premiumSoldPerShare}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, premiumSoldPerShare: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Buyback premium / share</span>
                  <input
                    type="number"
                    step="0.01"
                    value={historyEditPreview.premiumBoughtBackPerShare}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, premiumBoughtBackPerShare: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Contracts</span>
                  <input
                    type="number"
                    step="1"
                    min="1"
                    value={historyEditPreview.contracts}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, contracts: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Date sold</span>
                  <input
                    type="date"
                    value={historyEditPreview.dateSold}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, dateSold: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Expiration</span>
                  <input
                    type="date"
                    value={historyEditPreview.expirationDate}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, expirationDate: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Closed at</span>
                  <input
                    type="date"
                    value={historyEditPreview.closedAt}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, closedAt: event.target.value } : current))
                    }
                  />
                </label>
                <label>
                  <span>Close reason</span>
                  <select
                    value={historyEditPreview.closeReason}
                    onChange={(event) =>
                      setHistoryEditPreview((current) =>
                        current
                          ? { ...current, closeReason: event.target.value === 'expired' ? 'expired' : 'manual' }
                          : current
                      )
                    }
                  >
                    <option value="manual">Manual</option>
                    <option value="expired">Expired</option>
                  </select>
                </label>
                <label className="modal-textarea-field history-reflection-modal-field">
                  <span>复盘 / 反思总结</span>
                  <textarea
                    value={historyEditPreview.reflectionNotes}
                    onChange={(event) =>
                      setHistoryEditPreview((current) => (current ? { ...current, reflectionNotes: event.target.value } : current))
                    }
                    placeholder="记录这笔交易的失误、教训，或者下次准备如何优化。"
                  />
                </label>
              </div>
              <div className="scenario-caption">
                保存后会自动重算这笔历史记录的已实现盈亏，并同步更新顶部历史收益汇总。
              </div>
              <div className="modal-actions">
                <button type="button" className="secondary-button" onClick={() => setHistoryEditPreview(null)}>
                  Cancel
                </button>
                <button type="button" className="primary-button" onClick={confirmEditClosedTrade}>
                  Save changes
                </button>
              </div>
            </div>
          </div>
        )}

        {(analysisResult || analysisError) && (
          <div
            className="modal-backdrop"
            role="presentation"
            onClick={() => closeAnalysisModal(setAnalysisResult, setAnalysisError)}
          >
            <div
              className="modal-card modal-wide modal-scrollable"
              role="dialog"
              aria-modal="true"
              aria-labelledby="analysis-title"
              onClick={(event) => event.stopPropagation()}
            >
              <p className="section-kicker">Gemini Analysis</p>
              <h3 id="analysis-title">{analysisResult ? `${analysisResult.ticker} 仓位分析` : 'Gemini 分析失败'}</h3>
              {analysisError ? (
                <p className="modal-copy">{analysisError}</p>
              ) : (
                <>
                  {analysisResult && (
                    <>
                      <div className="analysis-topline">
                        <div className="summary-card emphasized">
                          <span>结论</span>
                          <strong>{analysisResult.analysis.verdict}</strong>
                        </div>
                        <div className="summary-card">
                          <span>一句话</span>
                          <strong>{analysisResult.analysis.summary}</strong>
                        </div>
                      </div>
                      <div className="analysis-calcs">
                        <div className="summary-card">
                          <span>Breakeven</span>
                          <strong>{analysisResult.analysis.calc.breakeven}</strong>
                        </div>
                        <div className="summary-card">
                          <span>Buffer %</span>
                          <strong>{analysisResult.analysis.calc.buffer_pct}%</strong>
                        </div>
                        <div className="summary-card">
                          <span>Max profit</span>
                          <strong>{analysisResult.analysis.calc.max_profit}</strong>
                        </div>
                        <div className="summary-card">
                          <span>Annualized yield</span>
                          <strong>{analysisResult.analysis.calc.annualized_yield_pct}%</strong>
                        </div>
                        <div className="summary-card">
                          <span>RSI 是否超卖</span>
                          <strong>{analysisResult.analysis.calc.rsi_display}</strong>
                        </div>
                      </div>
                      <div className="analysis-body">
                        <div className="analysis-section">
                          <strong>核心风险</strong>
                          <ul className="risk-check-list">
                            {analysisResult.analysis.key_risks.map((item) => (
                              <li key={item}>{item}</li>
                            ))}
                          </ul>
                        </div>
                        <div className="analysis-section">
                          <strong>近期变化</strong>
                          <p>{analysisResult.analysis.recent_change}</p>
                        </div>
                        <div className="analysis-section">
                          <strong>基本面观察</strong>
                          <p>{analysisResult.analysis.fundamental_note}</p>
                        </div>
                      </div>
                    </>
                  )}
                  {analysisResult && analysisResult.sources.length > 0 && (
                    <div className="analysis-sources">
                      <strong>参考来源</strong>
                      {analysisResult.sources.map((source) => (
                        <a key={source.url} href={source.url} target="_blank" rel="noreferrer">
                          {source.title}
                        </a>
                      ))}
                    </div>
                  )}
                  {analysisResult && (
                    <div className="copy-message">分析时间：{new Date(analysisResult.asOf).toLocaleString()}</div>
                  )}
                </>
              )}
              <div className="modal-actions">
                <button
                  className="primary-button"
                  onClick={() => closeAnalysisModal(setAnalysisResult, setAnalysisError)}
                  type="button"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {deletePreview && (
          <div className="modal-backdrop" role="presentation" onClick={() => setDeletePreview(null)}>
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="delete-preview-title"
              onClick={(event) => event.stopPropagation()}
            >
              <p className="section-kicker">Delete Position</p>
              <h3 id="delete-preview-title">确认删除 {deletePreview.ticker} 这笔期权？</h3>
              <p className="modal-copy">
                删除这笔仓位后，Risk Score 预计从 <strong>{deletePreview.currentScore}</strong> 变为 <strong>{deletePreview.nextScore}</strong>。
              </p>
              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setDeletePreview(null)} type="button">
                  Cancel
                </button>
                <button className="primary-button" onClick={confirmDeletePut} type="button">
                  Confirm Delete
                </button>
              </div>
            </div>
          </div>
        )}

        {sellStockPreview && (
          <div className="modal-backdrop" role="presentation" onClick={() => setSellStockPreview(null)}>
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="sell-stock-title"
              onClick={(event) => event.stopPropagation()}
            >
              <p className="section-kicker">Sell Stock</p>
              <h3 id="sell-stock-title">卖出 {sellStockPreview.ticker} 股票</h3>
              <p className="modal-copy">
                当前持股 <strong>{sellStockPreview.currentShares}</strong> 股
                {sellStockPreview.coveredCallShares > 0
                  ? `，其中 ${sellStockPreview.coveredCallShares} 股已被 Covered Call 覆盖`
                  : ''}
                。
              </p>
              <div className="form-grid compact">
                <label>
                  <span>卖出股数</span>
                  <input
                    type="number"
                    min="1"
                    max={sellStockPreview.currentShares}
                    step="1"
                    value={sellStockPreview.sharesToSell}
                    onChange={(event) =>
                      setSellStockPreview((current) =>
                        current ? { ...current, sharesToSell: event.target.value } : current
                      )
                    }
                  />
                </label>
                <label>
                  <span>卖出价格</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={sellStockPreview.sellPricePerShare}
                    onChange={(event) =>
                      setSellStockPreview((current) =>
                        current ? { ...current, sellPricePerShare: event.target.value } : current
                      )
                    }
                  />
                </label>
              </div>
              <p className="modal-copy">
                预计回笼现金：
                <strong>
                  {formatCurrency(
                    Math.max(Number(sellStockPreview.sharesToSell) || 0, 0) *
                      Math.max(Number(sellStockPreview.sellPricePerShare) || 0, 0)
                  )}
                </strong>
              </p>
              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setSellStockPreview(null)} type="button">
                  Cancel
                </button>
                <button className="primary-button" onClick={confirmSellStock} type="button">
                  Confirm Sell
                </button>
              </div>
            </div>
          </div>
        )}

        {buyStockPreview && (
          <div className="modal-backdrop" role="presentation" onClick={() => setBuyStockPreview(null)}>
            <div
              className="modal-card"
              role="dialog"
              aria-modal="true"
              aria-labelledby="buy-stock-title"
              onClick={(event) => event.stopPropagation()}
            >
              <p className="section-kicker">Buy Stock</p>
              <h3 id="buy-stock-title">买入 {buyStockPreview.ticker} 股票</h3>
              <p className="modal-copy">
                当前持股 <strong>{buyStockPreview.currentShares}</strong> 股。
              </p>
              <div className="form-grid compact">
                <label>
                  <span>买入股数</span>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={buyStockPreview.sharesToBuy}
                    onChange={(event) =>
                      setBuyStockPreview((current) =>
                        current ? { ...current, sharesToBuy: event.target.value } : current
                      )
                    }
                  />
                </label>
                <label>
                  <span>买入价格</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={buyStockPreview.buyPricePerShare}
                    onChange={(event) =>
                      setBuyStockPreview((current) =>
                        current ? { ...current, buyPricePerShare: event.target.value } : current
                      )
                    }
                  />
                </label>
              </div>
              <p className="modal-copy">
                预计占用现金：
                <strong>
                  {formatCurrency(
                    Math.max(Number(buyStockPreview.sharesToBuy) || 0, 0) *
                      Math.max(Number(buyStockPreview.buyPricePerShare) || 0, 0)
                  )}
                </strong>
              </p>
              <div className="modal-actions">
                <button className="ghost-button" onClick={() => setBuyStockPreview(null)} type="button">
                  Cancel
                </button>
                <button className="primary-button" onClick={confirmBuyStock} type="button">
                  Confirm Buy
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'dashboard' && (
        <section className="card">
          <div className="section-header">
            <div>
              <p className="section-kicker">Section 3</p>
              <h2>Config</h2>
            </div>
            <div className="section-actions">
              <input
                ref={importInputRef}
                type="file"
                accept="application/json"
                className="hidden-file-input"
                onChange={handleImportFile}
              />
              <button className="ghost-button" onClick={handleOpenImport} type="button">
                Import
              </button>
              <button className="ghost-button" onClick={handleExportData} type="button">
                Export All Data
              </button>
              <button className="primary-button" onClick={() => void handleSaveConfig()} type="button">
                Save
              </button>
            </div>
          </div>
          {importExportMessage && <div className="copy-message">{importExportMessage}</div>}
          {backgroundRefreshStatus && (
            <div className="refresh-progress-card background-refresh-card">
              <div className="refresh-progress-header">
                <strong>
                  后台刷新
                  {backgroundRefreshStatus.status === 'running'
                    ? '进行中'
                    : backgroundRefreshStatus.status === 'success'
                      ? '已完成'
                      : backgroundRefreshStatus.status === 'error'
                        ? '失败'
                        : '待命'}
                </strong>
                <span>
                  {backgroundRefreshStatus.finishedAt
                    ? `最近完成：${new Date(backgroundRefreshStatus.finishedAt).toLocaleString()}`
                    : backgroundRefreshStatus.startedAt
                      ? `开始于：${new Date(backgroundRefreshStatus.startedAt).toLocaleString()}`
                      : '尚未检测到后台刷新记录'}
                </span>
              </div>
              <div className="refresh-progress-bar" aria-hidden="true">
                <div
                  className="refresh-progress-fill"
                  style={{
                    width: `${
                      backgroundRefreshStatus.totalSteps > 0
                        ? Math.min(
                            100,
                            Math.round((backgroundRefreshStatus.completedSteps / backgroundRefreshStatus.totalSteps) * 100)
                          )
                        : backgroundRefreshStatus.status === 'success'
                          ? 100
                          : 0
                    }%`
                  }}
                />
              </div>
              <div className="background-refresh-meta">
                <span>
                  {backgroundRefreshStatus.message ??
                    (backgroundRefreshStatus.marketOpen === false
                      ? '当前非盘中，后台任务会跳过股票与期权刷新'
                      : '后台任务会按 20 / 30 分钟规则自动刷新')}
                </span>
                <span>
                  已刷新 {backgroundRefreshStatus.refreshedTickers} 个股票，{backgroundRefreshStatus.refreshedOptions} 笔期权
                </span>
              </div>
              {backgroundRefreshStatus.currentLabel && (
                <div className="copy-message">{backgroundRefreshStatus.currentLabel}</div>
              )}
              {backgroundRefreshStatus.error && <div className="validation-message">{backgroundRefreshStatus.error}</div>}
            </div>
          )}
          <div className="form-grid">
            <label>
              <span>当前现金余额</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={configForm.cash}
                onChange={(event) => setConfigForm((current) => ({ ...current, cash: toInputNumber(event.target.value) }))}
              />
              <FieldError message={configErrors.cash} />
            </label>
            <label>
              <span>Risk limit %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={decimalToPercentInput(configForm.risk_limit_pct)}
                onChange={(event) =>
                  setConfigForm((current) => ({ ...current, risk_limit_pct: percentInputToDecimal(event.target.value) }))
                }
              />
              <FieldError message={configErrors.risk_limit_pct} />
            </label>
            <label>
              <span>Warning threshold %</span>
              <input
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={decimalToPercentInput(configForm.warning_threshold_pct)}
                onChange={(event) =>
                  setConfigForm((current) => ({
                    ...current,
                    warning_threshold_pct: percentInputToDecimal(event.target.value)
                  }))
                }
              />
              <FieldError message={configErrors.warning_threshold_pct} />
            </label>
          </div>
          {!config && <div className="empty-banner">尚未保存配置。请先填写可用于卖期权的资金和风险参数。</div>}
        </section>
        )}

        {activeTab === 'calculator' && (
        <section className="card">
          <div className="section-header">
            <div>
              <p className="section-kicker">Section 1</p>
              <h2>Risk Calculator</h2>
            </div>
          </div>
          <div className="copy-message">
            估算“如果整体上涨 / 下跌 X%”时的资金影响。输入正数表示上涨，输入负数表示下跌。口径按你定义的规则：股票按涨跌幅直接变化；Put 在下跌到行权价下方后按差额减去权利金；Call 直接按全拿权利金抵减。
          </div>
          <div className="form-grid compact risk-calculator-grid">
            <label>
              <span>整体涨跌幅度 %</span>
                <input
                  type="number"
                  min="-30"
                  max="30"
                  step="1"
                  value={riskCalculatorDropInput}
                  onChange={(event) => setRiskCalculatorDropInput(event.target.value)}
                />
              </label>
              <div className="risk-calculator-note">
                <span>情景价格</span>
                <strong>按当前股价 × {formatPercent(riskCalculator.shockMultiplier)}</strong>
                <small>支持输入 -30% 到 +30%。正数表示上涨，负数表示下跌。</small>
              </div>
            </div>

          <div className="summary-grid">
            <article className="summary-card emphasized">
              <span>{`${riskCalculator.scenarioPct >= 0 ? '整体上涨' : '整体下跌'} ${formatPercent(Math.abs(riskCalculator.scenarioPct))} 时的情景总资金`}</span>
              <strong>{formatCurrency(riskCalculator.scenarioCapital)}</strong>
              <small className="summary-card-footnote">
                净变化 {formatSignedCurrency(riskCalculator.totalNetChange)} · 占总资金量 {riskCalculator.totalNetChangePctOfCapital == null ? '-' : formatSignedPercent(riskCalculator.totalNetChangePctOfCapital)}
              </small>
            </article>
            <article className="summary-card">
              <span>股票变化</span>
              <strong>{formatSignedCurrency(riskCalculator.totalStockChange)}</strong>
            </article>
            <article className="summary-card">
              <span>Put 变化</span>
              <strong>{formatSignedCurrency(riskCalculator.totalPutChange)}</strong>
            </article>
            <article className="summary-card">
              <span>Call 权利金</span>
              <strong>{formatSignedCurrency(riskCalculator.totalCallChange)}</strong>
            </article>
          </div>

          {riskCalculator.rows.length === 0 ? (
            <div className="empty-state">当前没有股票或期权仓位可供估算。</div>
          ) : (
            <div className="risk-calculator-results">
              {riskCalculator.rows.map((row) => (
                <article key={row.ticker} className="risk-calculator-row">
                  <div className="risk-calculator-row-header">
                    <div>
                      <strong>{row.ticker}</strong>
                      <small>
                        {row.currentPrice && row.shockedPrice
                          ? `现价 ${formatCurrency(row.currentPrice)} → 情景价 ${formatCurrency(row.shockedPrice)}`
                          : '当前缺少现价，部分期权损益可能未计入'}
                      </small>
                    </div>
                    <div className="risk-calculator-row-net">
                      <span>情景总资金</span>
                      <strong>{row.scenarioCapital == null ? '-' : formatCurrency(row.scenarioCapital)}</strong>
                      <small>
                        净变化 {formatSignedCurrency(row.netChange)} · 占总资金量 {row.netChangePctOfCapital == null ? '-' : formatSignedPercent(row.netChangePctOfCapital)}
                      </small>
                    </div>
                  </div>
                  <div className="risk-calculator-breakdown">
                    <div className="risk-calculator-breakdown-item">
                      <span>股票变化</span>
                      <strong>{formatSignedCurrency(row.stockChange)}</strong>
                    </div>
                    <div className="risk-calculator-breakdown-item">
                      <span>Put 变化</span>
                      <strong>{formatSignedCurrency(row.putChange)}</strong>
                    </div>
                    <div className="risk-calculator-breakdown-item">
                      <span>Call 权利金</span>
                      <strong>{formatSignedCurrency(row.callChange)}</strong>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
        )}

        {activeTab === 'stocks' && (
        <section className="card">
          <div className="section-header">
            <div>
              <p className="section-kicker">Section 1</p>
              <h2>Stock List</h2>
            </div>
          </div>
          <div className="form-grid compact">
            <label>
              <span>Add ticker to list</span>
              <input value={newTicker} onChange={(event) => setNewTicker(event.target.value)} placeholder="例如 AAPL" />
            </label>
            <label>
              <span>Default beta</span>
              <input
                type="number"
                step="0.01"
                value={newTickerBeta}
                onChange={(event) => setNewTickerBeta(event.target.value)}
                placeholder="例如 1.08"
              />
            </label>
            <label>
              <span>Shares held</span>
              <input
                type="number"
                step="1"
                min="0"
                value={newTickerShares}
                onChange={(event) => setNewTickerShares(event.target.value)}
                placeholder="例如 100"
              />
            </label>
            <label>
              <span>Average cost</span>
              <input
                type="number"
                step="0.01"
                min="0"
                value={newTickerAverageCost}
                onChange={(event) => setNewTickerAverageCost(event.target.value)}
                placeholder="例如 185.50"
              />
            </label>
            <label>
              <span>Downside tolerance %</span>
              <input
                type="number"
                step="0.1"
                min="0"
                value={newTickerTolerancePct}
                onChange={(event) => setNewTickerTolerancePct(event.target.value)}
                placeholder="例如 30"
              />
            </label>
          </div>
          <div className="inline-actions">
            <button className="primary-button" onClick={handleAddTicker} type="button">
              Add ticker
            </button>
            <button
              className="ghost-button"
              onClick={() => void handleRefreshAllTickers()}
              type="button"
              disabled={isRefreshingAllTickers || refreshingTicker !== null}
            >
              {isRefreshingAllTickers ? 'Refreshing all...' : 'Refresh all'}
            </button>
          </div>
          <div className="copy-message">手动 Refresh 会刷新价格、技术指标，以及来自 Barchart 的 PCR、财报日、IV History、IV Rank、IV Percentage；仅在美股盘中自动刷新股价，每 20 分钟一次；期权价格仅在盘中每 30 分钟自动刷新一次，盘后不会自动刷新。全量刷新会慢速逐只进行。</div>
          {metrics.missingStockBetaTickers.length > 0 && (
            <div className="copy-message">
              Beta 忘记输入了：{metrics.missingStockBetaTickers.join('、')}。当前股票风险先按 Beta 1.00 估算。
            </div>
          )}
          {tickerMessage && <div className="copy-message">{tickerMessage}</div>}
          {refreshAllProgress && (
            <div className="copy-message">
              正在刷新第 {refreshAllProgress.current}/{refreshAllProgress.total} 个股票
              {refreshAllProgress.ticker ? `：${refreshAllProgress.ticker}` : ''}
              。成功 {refreshAllProgress.successCount}，失败 {refreshAllProgress.failureCount}
            </div>
          )}
          {priceRefreshMessage && <div className="copy-message">{priceRefreshMessage}</div>}
          {tickerList.length === 0 ? (
            <div className="empty-state">当前还没有股票列表。先加几个 ticker，后面新增 Put 时可以直接下拉选择。</div>
          ) : (
            <div className="ticker-list-grid">
              {tickerList.map((entry) => {
                const isEditingTicker = editingTickers[entry.ticker] === true;
                const tickerDraft = tickerDrafts[entry.ticker] ?? createTickerEditDraft(entry);
                const averageCost = entry.average_cost_basis;
                const currentPrice = entry.current_price;
                const shares = entry.shares;
                const tolerancePct = entry.downside_tolerance_pct;
                const stopLossPrice =
                  typeof averageCost === 'number' && typeof tolerancePct === 'number'
                    ? averageCost * (1 - tolerancePct)
                    : null;
                const unrealizedPnlAmount =
                  typeof averageCost === 'number' && typeof currentPrice === 'number' && typeof shares === 'number'
                    ? (currentPrice - averageCost) * shares
                    : null;
                const unrealizedPnlPct =
                  typeof averageCost === 'number' && averageCost > 0 && typeof currentPrice === 'number'
                    ? (currentPrice - averageCost) / averageCost
                    : null;

                return (
                <div
                  key={entry.ticker}
                  className="ticker-list-row"
                  ref={(element) => {
                    stockRowRefs.current[entry.ticker] = element;
                  }}
                >
                  <button
                    className={putForm.ticker === entry.ticker ? 'ticker-chip active' : 'ticker-chip'}
                    onClick={() => setPutForm((current) => ({ ...current, ticker: entry.ticker }))}
                    type="button"
                  >
                    {entry.ticker}
                  </button>
                  <button
                    className="ghost-button ticker-refresh-button"
                    onClick={() => (isEditingTicker ? handleSaveTickerEdit(entry.ticker) : handleStartTickerEdit(entry))}
                    type="button"
                    disabled={refreshingTicker !== null || isRefreshingAllTickers}
                  >
                    {isEditingTicker ? 'Save' : 'Edit'}
                  </button>
                  {isEditingTicker ? (
                    <button
                      className="ghost-button ticker-refresh-button"
                      onClick={() => handleCancelTickerEdit(entry.ticker)}
                      type="button"
                      disabled={refreshingTicker !== null || isRefreshingAllTickers}
                    >
                      Cancel
                    </button>
                  ) : null}
                  <button
                    className="ghost-button ticker-refresh-button"
                    onClick={() => handleOpenBuyStock(entry)}
                    type="button"
                    disabled={refreshingTicker !== null || isRefreshingAllTickers}
                  >
                    Buy
                  </button>
                  <button
                    className="ghost-button ticker-refresh-button"
                    onClick={() => handleRefreshTicker(entry)}
                    type="button"
                    disabled={refreshingTicker !== null || isRefreshingAllTickers}
                  >
                    {refreshingTicker === entry.ticker ? 'Refreshing...' : 'Refresh'}
                  </button>
                  {(entry.shares ?? 0) > 0 ? (
                    <button
                      className="ghost-button ticker-refresh-button"
                      onClick={() => handleOpenSellStock(entry)}
                      type="button"
                      disabled={refreshingTicker !== null || isRefreshingAllTickers}
                    >
                      Sell
                    </button>
                  ) : null}
                  <button
                    className="ghost-button ticker-refresh-button"
                    onClick={() => handleDeleteTicker(entry.ticker)}
                    type="button"
                    disabled={refreshingTicker !== null || isRefreshingAllTickers}
                  >
                    Delete
                  </button>
                  <label className="beta-field">
                    <span>Beta</span>
                    <input
                      type="number"
                      step="0.01"
                      value={tickerDraft.beta}
                      onChange={(event) => handleChangeTickerDraft(entry.ticker, 'beta', event.target.value)}
                      disabled={!isEditingTicker}
                    />
                    {(entry.shares ?? 0) > 0 && entry.beta == null ? (
                      <small className="field-warning-text">Beta 忘记输入了</small>
                    ) : null}
                  </label>
                  <label className="beta-field">
                    <span>Shares</span>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      value={tickerDraft.shares}
                      onChange={(event) => handleChangeTickerDraft(entry.ticker, 'shares', event.target.value)}
                      disabled={!isEditingTicker}
                    />
                  </label>
                  <label className="beta-field">
                    <span>Average cost</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={tickerDraft.averageCostBasis}
                      onChange={(event) => handleChangeTickerDraft(entry.ticker, 'averageCostBasis', event.target.value)}
                      disabled={!isEditingTicker}
                    />
                  </label>
                  <label className="beta-field">
                    <span>Downside tolerance %</span>
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={tickerDraft.downsideTolerancePct}
                      onChange={(event) => handleChangeTickerDraft(entry.ticker, 'downsideTolerancePct', event.target.value)}
                      disabled={!isEditingTicker}
                    />
                  </label>
                  <label className="beta-field">
                    <span>Current price</span>
                    <strong className="field-value">
                      {entry.current_price === null ? '-' : entry.current_price.toFixed(2)}
                    </strong>
                  </label>
                  <div className="beta-field">
                    <span>Stock value</span>
                    <strong className="field-value">
                      {entry.current_price === null || entry.shares === null ? '-' : formatCurrency(entry.current_price * entry.shares)}
                    </strong>
                  </div>
                  <div className="beta-field">
                    <span>Stop-loss price</span>
                    <strong className="field-value">
                      {stopLossPrice === null ? '-' : formatCurrency(stopLossPrice)}
                    </strong>
                  </div>
                  <div className="beta-field">
                    <span>Unrealized P/L %</span>
                    <strong className="field-value">
                      {unrealizedPnlPct === null ? '-' : formatPercent(unrealizedPnlPct)}
                    </strong>
                  </div>
                  <div className="beta-field">
                    <span>Unrealized P/L amount</span>
                    <strong className="field-value">
                      {unrealizedPnlAmount === null ? '-' : formatCurrency(unrealizedPnlAmount)}
                    </strong>
                  </div>
                  <div className="beta-field">
                    <span>RSI(14, 1D)</span>
                    <strong className="field-value">{entry.rsi_14 === null ? '-' : entry.rsi_14.toFixed(1)}</strong>
                  </div>
                  <div className="beta-field">
                    <span>RSI(14, 1D) status</span>
                    <strong className={`pill-badge ${getRsiTone(entry.rsi_14)}`}>{getRsiLabel(entry.rsi_14)}</strong>
                  </div>
                  <div className="beta-field">
                    <span>RSI(14, 1h)</span>
                    <strong className="field-value">{entry.rsi_14_1h === null ? '-' : entry.rsi_14_1h.toFixed(1)}</strong>
                  </div>
                  <div className="beta-field">
                    <span>Next earnings</span>
                    <strong className="field-value">{entry.next_earnings_date ?? '-'}</strong>
                  </div>
                  <div className="beta-field">
                    <span>Current IV</span>
                    <strong className={`pill-badge ${getIvTone(entry.current_iv)}`}>
                      {entry.current_iv === null ? '-' : `${(entry.current_iv * 100).toFixed(1)}%`}
                    </strong>
                  </div>
                  <div className="beta-field">
                    <span>IV History</span>
                    <strong className="field-value">
                      {entry.historical_iv == null ? '-' : `${(entry.historical_iv * 100).toFixed(1)}%`}
                    </strong>
                  </div>
                  <div className="beta-field">
                    <span>IV Rank</span>
                    <strong className="field-value">{entry.iv_rank == null ? '-' : entry.iv_rank.toFixed(1)}</strong>
                  </div>
                  <div className="beta-field">
                    <span>IV Percentage</span>
                    <strong className="field-value">{entry.iv_percentile == null ? '-' : entry.iv_percentile.toFixed(1)}</strong>
                  </div>
                  <div className="beta-field">
                    <span>PCR (OI)</span>
                    <strong className={`pill-badge ${getPcrTone(entry.put_call_ratio)}`}>
                      {entry.put_call_ratio === null ? '-' : entry.put_call_ratio.toFixed(2)}
                    </strong>
                  </div>
                  <div className="beta-field">
                    <span>MA21</span>
                    <strong className="field-value">{entry.ma_21 === null ? '-' : entry.ma_21.toFixed(2)}</strong>
                  </div>
                  <div className="beta-field">
                    <span>MA200</span>
                    <strong className="field-value">{entry.ma_200 === null ? '-' : entry.ma_200.toFixed(2)}</strong>
                  </div>
                  <div className="beta-field">
                    <span>Last updated</span>
                    <strong className="field-value">{entry.last_updated ? new Date(entry.last_updated).toLocaleString() : '-'}</strong>
                  </div>
                </div>
                );
              })}
            </div>
          )}
        </section>
        )}

      </main>
    </div>
  );
}

export default App;
