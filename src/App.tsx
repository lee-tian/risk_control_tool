import { useEffect, useMemo, useRef, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceDot, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import {
  filterAccountValueChartData,
  getAccountValueChartDomain,
  type AccountValueChartPoint,
  type AccountValueRange
} from './lib/accountValueChart';
import { buildAccountValueComparisons, upsertDailyAccountValueSnapshot } from './lib/accountValueHistory';
import { buildSummaryText, calculatePortfolioMetrics } from './lib/calculations';
import { applyOptionCloseCash, applyOptionOpenCash, applyStockBuyCash, applyStockSellCash } from './lib/cashFlows';
import { formatCurrency, formatPercent } from './lib/formatters';
import { getHistoryAnnualizedYield, getHistoryHoldingDays, getHistoryProfitPct } from './lib/historyMetrics';
import { compareOptionRowsByLossPct, getAttentionLevel, getAttentionReasons, isOptionLossAtTwoXCredit } from './lib/optionAlerts';
import { comparePositionRows, type PositionSortDirection, type PositionSortField } from './lib/positionSorting';
import { applyQuoteRefreshToTickerList, parseJsonResponseText } from './lib/quoteRefresh';
import { assessRewardRiskRatio, calculateRewardRiskRatio } from './lib/rewardRisk';
import { buildOptionCapitalUsageByTicker, buildTopIvRankStocks } from './lib/dashboardSignals';
import {
  buildCapitalAllocationChart,
  buildHoldingDeltaSummary,
  buildRiskCalculator,
  buildRiskCurvePoints,
  buildTickerAllocationItems
} from './lib/dashboardPortfolio';
import { analyzeVixTrend } from './lib/vixTrend';
import {
  buildAppStateSnapshot,
  applyPutPositionsImportPayload,
  clearCoreAppStateCache,
  loadScenario,
  loadVixHistory,
  mergeTickerListsPreservingManualFields,
  normalizeImportedTickerList,
  parseAppStateSnapshot,
  parsePutPositionsImportPayload,
} from './lib/storage';
import {
  buildDirectOptionPosition,
  buildClosedTradeEditPreview,
  closeOpenPosition,
  deleteOpenPositionAndPruneTicker,
  ensureTickerExists,
  expireOpenPositions,
  hasExpectedPersistedClosedTrade,
  hasExpectedPersistedPositionState,
  parseClosedTradeEditPreview,
  removeClosedTrade,
  updateClosedTrade,
  upsertPutPosition
} from './lib/putWorkflow';
import {
  addTickerEntry,
  buyTickerShares,
  normalizeTickerSymbol,
  removeTickerEntry,
  sellTickerShares,
  updateTickerEntry
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
const ATR_MULTIPLIERS = [0.5, 1.0, 1.5, 2.0] as const;

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

type TickerEditDraftValues = {
  beta: string;
  shares: string;
  averageCostBasis: string;
  targetTrimPrice: string;
  buyRsiAlert: string;
};

function createTickerEditDraft(entry: TickerEntry): TickerEditDraftValues {
  return {
    beta: entry.beta == null ? '' : String(entry.beta),
    shares: entry.shares == null ? '' : String(entry.shares),
    averageCostBasis: entry.average_cost_basis == null ? '' : String(entry.average_cost_basis),
    targetTrimPrice: entry.target_trim_price == null ? '' : String(entry.target_trim_price),
    buyRsiAlert: entry.buy_rsi_alert == null ? '' : String(entry.buy_rsi_alert)
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

type AppTab = 'dashboard' | 'risk_first' | 'sell' | 'positions' | 'history' | 'stocks' | 'calculator';
type HistoryFilter = 'all' | 'profit' | 'loss';
type StockTradeType = '短线' | '中线' | '长线';

type RiskFirstDecision = {
  allowed: boolean;
  recommendedPositionPct: number;
  tradeType: StockTradeType;
  stopLossPct: number | null;
  expectedReturnPct: number | null;
  riskRewardRatio: number | null;
  importanceLevel: '短期' | '中期' | '长期';
  doorType: '双向门' | '单向门';
  reasons: string[];
  warnings: string[];
  positionReason: string;
  riskControl: string;
  asymmetric: string;
};

const ACCOUNT_VALUE_RANGE_OPTIONS: AccountValueRange[] = ['7D', '1M', '3M', 'YTD', 'All'];

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


function getRiskFirstImportanceLevel(tradeType: StockTradeType): RiskFirstDecision['importanceLevel'] {
  if (tradeType === '长线') return '长期';
  if (tradeType === '中线') return '中期';
  return '短期';
}

function getRiskFirstRecommendedPct(
  importanceLevel: RiskFirstDecision['importanceLevel'],
  riskRewardRatio: number | null,
  isOneWayDoor: boolean
): number {
  const basePct = importanceLevel === '长期' && riskRewardRatio !== null && riskRewardRatio >= 3
    ? 0.5
    : importanceLevel === '中期'
      ? 0.3
      : 0.2;

  return Math.min(basePct, isOneWayDoor ? 0.2 : 0.5);
}

function buildRiskFirstDecision(input: {
  ticker: string;
  tradeType: StockTradeType;
  expectedReturnPct: number | null;
  maxLossPct: number | null;
  totalCapital: number;
  resultingPositionValue: number;
  existingShares: number;
  currentPrice: number | null;
  averageCostBasis: number | null;
  investmentLogic: string;
  plannedHoldingTime: string;
  exitStrategy: string;
  isOneWayDoor: boolean;
  isAddingToLoss: boolean;
}): RiskFirstDecision {
  const importanceLevel = getRiskFirstImportanceLevel(input.tradeType);
  const riskRewardRatio =
    input.maxLossPct !== null && input.maxLossPct > 0 && input.expectedReturnPct !== null
      ? input.expectedReturnPct / input.maxLossPct
      : null;
  const recommendedPositionPct = getRiskFirstRecommendedPct(importanceLevel, riskRewardRatio, input.isOneWayDoor);
  const positionPct = input.totalCapital > 0 ? input.resultingPositionValue / input.totalCapital : 0;
  const reasons: string[] = [];
  const warnings: string[] = [];

  if (positionPct > 0.5) {
    reasons.push('单一标的仓位超过 50% 上限');
    warnings.push('仓位过大');
  }
  if (positionPct > recommendedPositionPct) {
    reasons.push(`仓位超过系统建议的 ${formatPercent(recommendedPositionPct)}`);
    warnings.push('建议降低仓位');
  }
  if (input.maxLossPct === null || input.maxLossPct <= 0) {
    reasons.push('未定义有效止损');
    warnings.push('不符合止损纪律');
  }
  if (input.exitStrategy.trim() === '') {
    reasons.push('缺少退出策略');
    warnings.push('不符合系统纪律');
  }
  if (riskRewardRatio === null || riskRewardRatio < 2) {
    reasons.push('风险收益比低于 1:2');
    warnings.push('不符合风险收益纪律');
  }
  if (input.isOneWayDoor && positionPct > 0.2) {
    reasons.push('单向门交易仓位必须 ≤20%');
    warnings.push('单向门仓位过大');
  }
  if (input.isAddingToLoss) {
    reasons.push('当前持仓亏损时不允许补仓摊平亏损');
    warnings.push('存在补仓摊平亏损风险');
  }
  if (input.investmentLogic.trim() === '') {
    warnings.push('投资逻辑未填写，容易变成情绪交易');
  }
  if (input.plannedHoldingTime.trim() === '') {
    warnings.push('计划持有时间未填写');
  }
  if (input.maxLossPct !== null && input.maxLossPct >= 0.2) {
    warnings.push('亏损 20% 可能影响判断，请降低仓位');
  }

  return {
    allowed: reasons.length === 0,
    recommendedPositionPct,
    tradeType: input.tradeType,
    stopLossPct: input.maxLossPct,
    expectedReturnPct: input.expectedReturnPct,
    riskRewardRatio,
    importanceLevel,
    doorType: input.isOneWayDoor ? '单向门' : '双向门',
    reasons,
    warnings: [...new Set(warnings)],
    positionReason:
      `当前/交易后仓位约 ${formatPercent(positionPct)}；${importanceLevel}重要性对应建议上限 ${formatPercent(recommendedPositionPct)}。`,
    riskControl:
      input.maxLossPct === null || input.maxLossPct <= 0
        ? '未定义有效止损，系统拒绝交易。'
        : `买入前以 -${formatPercent(input.maxLossPct)} 为最大亏损线；退出策略：${input.exitStrategy.trim() || '未填写'}`,
    asymmetric:
      riskRewardRatio !== null && riskRewardRatio >= 2
        ? `是，预期收益约为最大亏损的 ${riskRewardRatio.toFixed(1)} 倍。`
        : '否，未达到至少 1:2 的非对称要求。'
  };
}

function renderAccountValueAxisTick(value: number) {
  if (!Number.isFinite(value)) {
    return '';
  }

  if (Math.abs(value) >= 1_000_000) {
    return `$${(value / 1_000_000).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1_000) {
    return `$${(value / 1_000).toFixed(0)}K`;
  }
  return formatCurrency(value);
}

function AccountValueTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: AccountValueChartPoint }> }) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }

  return (
    <div className="account-value-tooltip">
      <strong>{point.shortDate}</strong>
      <span>{formatCurrency(point.totalCapital)}</span>
      <small>日变化 {formatSignedCurrency(point.changeAmount)} · {formatSignedPercent(point.changePct)}</small>
    </div>
  );
}

function RiskCurveTooltip({
  active,
  payload
}: {
  active?: boolean;
  payload?: Array<{ payload: { scenarioPct: number; capital: number; netChange: number } }>;
}) {
  const point = payload?.[0]?.payload;
  if (!active || !point) {
    return null;
  }

  return (
    <div className="account-value-tooltip">
      <strong>{`情景 ${formatSignedPercent(point.scenarioPct)}`}</strong>
      <span>{formatCurrency(point.capital)}</span>
      <small>{`净变化 ${formatSignedCurrency(point.netChange)}`}</small>
    </div>
  );
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

async function readPersistedAppStateSnapshot() {
  const response = await fetch('/api/app-state', { cache: 'no-store' });
  const payload = await readJsonResponse<{ snapshot?: unknown; error?: string }>(response);

  if (!response.ok || payload.error || !payload.snapshot) {
    throw new Error(payload.error ?? '读取保存后的快照失败');
  }

  return parseAppStateSnapshot(JSON.stringify(payload.snapshot));
}

async function waitForPersistedAppStateSnapshot(
  predicate: (snapshot: ReturnType<typeof parseAppStateSnapshot>) => boolean,
  failureMessage: string
) {
  const retryDelays = [0, 120, 300, 700];
  let latestSnapshot: ReturnType<typeof parseAppStateSnapshot> | null = null;

  for (const delay of retryDelays) {
    if (delay > 0) {
      await sleep(delay);
    }

    latestSnapshot = await readPersistedAppStateSnapshot();
    if (predicate(latestSnapshot)) {
      return latestSnapshot;
    }
  }

  throw new Error(failureMessage);
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

function formatPersistSuccessMessage(
  baseMessage: string | undefined,
  storage?: { driver?: string | null } | null
): string | undefined {
  if (!baseMessage) {
    return baseMessage;
  }

  if ((storage?.driver ?? '').toLowerCase() === 'sqlite') {
    return `${baseMessage}，已写入 SQLite`;
  }

  return baseMessage;
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
  atr14?: Record<string, number>;
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

const PRICE_REFRESH_GAP_MS = 2 * 1000;
const PRICE_REFRESH_RETRY_GAP_MS = 20 * 1000;
const BACKGROUND_REFRESH_STATUS_POLL_MS = 10 * 60 * 1000;
const OPTION_REFRESH_ALL_CONCURRENCY = 1;
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



function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatFetchFailure(error: unknown, fallback = '保存失败') {
  if (error instanceof TypeError && error.message === 'Failed to fetch') {
    return '无法连接到本地服务，请刷新页面后重试';
  }

  if (
    error instanceof Error &&
    (error.message.includes("Unexpected token '<'") || error.message.includes('接口返回了 HTML'))
  ) {
    return '本地服务返回了错误页面，请刷新页面后重试';
  }

  return error instanceof Error ? error.message : fallback;
}

function isMinuteLimitError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes('current minute') ||
    normalized.includes('api credits for the current minute') ||
    normalized.includes('minute limit')
  );
}

function getTickerLastUpdated(entry: TickerEntry): string | null {
  const timestamps = [
    entry.last_updated,
    entry.current_iv_updated,
    entry.rsi_updated,
    entry.put_call_ratio_updated
  ].filter((value): value is string => typeof value === 'string' && value !== '');

  if (timestamps.length === 0) {
    return null;
  }

  return timestamps.reduce((latest, current) => (current > latest ? current : latest));
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

type OptionDraftState = {
  putForm: PutPosition;
  editingPutId: string | null;
};

const ACTIVE_TAB_STORAGE_KEY = 'risk-tool-active-tab';
const OPTION_DRAFT_STORAGE_KEY = 'risk-tool-option-draft';

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

function loadOptionDraftState(): OptionDraftState {
  const draft = loadDraftJson<Partial<OptionDraftState>>(OPTION_DRAFT_STORAGE_KEY);

  return {
    putForm: draft?.putForm ? { ...createEmptyPut(), ...draft.putForm } : createEmptyPut(),
    editingPutId: typeof draft?.editingPutId === 'string' ? draft.editingPutId : null
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

function getStopLossColor(current: number | null, stop: number | null) {
  if (current == null || stop == null) return undefined;
  if (current <= stop) return '#c53030'; // Red
  if (current <= stop * 1.02) return '#d97706'; // Yellow (within 2%)
  return '#2f855a'; // Green
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
  const [isEditingConfig, setIsEditingConfig] = useState(false);
  const [putForm, setPutForm] = useState<PutPosition>(initialOptionDraft.putForm);
  const [putErrors, setPutErrors] = useState<ValidationErrors<PutPosition>>({});
  const [editingPutId, setEditingPutId] = useState<string | null>(initialOptionDraft.editingPutId);
  const [newTicker, setNewTicker] = useState('');
  const [newTickerBeta, setNewTickerBeta] = useState('');
  const [newTickerBuyRsiAlert, setNewTickerBuyRsiAlert] = useState('');
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

  const [pendingPositionScrollId, setPendingPositionScrollId] = useState<string | null>(null);
  const [pendingStockScrollTicker, setPendingStockScrollTicker] = useState<string | null>(null);
  const [refreshingTicker, setRefreshingTicker] = useState<string | null>(null);
  const [isRefreshingAllTickers, setIsRefreshingAllTickers] = useState(false);
  const [isSavingPut, setIsSavingPut] = useState(false);
  const [analysisPositionId, setAnalysisPositionId] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<PositionAnalysisResult | null>(null);
  const [analysisError, setAnalysisError] = useState('');
  const [refreshingOptionPriceId, setRefreshingOptionPriceId] = useState<string | null>(null);
  const [isRefreshingAllOptions, setIsRefreshingAllOptions] = useState(false);
  const [refreshAllOptionsProgress, setRefreshAllOptionsProgress] = useState<{
    current: number;
    total: number;
    successCount: number;
    failureCount: number;
    ticker: string;
  } | null>(null);

  const putsRef = useRef<PutPosition[]>(puts);
  const tickerListRef = useRef<TickerEntry[]>(tickerList);
  const positionCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const stockRowRefs = useRef<Record<string, HTMLElement | null>>({});
  const refreshingOptionPriceIdRef = useRef<string | null>(refreshingOptionPriceId);
  const isRefreshingAllOptionsRef = useRef(isRefreshingAllOptions);
  const [optionPriceOverrides, setOptionPriceOverrides] = useState<
    Record<string, { price: number; theta: number | null; delta: number | null; gamma: number | null; updatedAt: string }>
  >({});
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
  const [closePreviewError, setClosePreviewError] = useState('');
  const [isClosingPosition, setIsClosingPosition] = useState(false);
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
    tradeType: StockTradeType;
    investmentLogic: string;
    expectedUpsidePct: string;
    maxLossPct: string;
    plannedHoldingTime: string;
    exitStrategy: string;
    isOneWayDoor: boolean;
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
  const [positionSort, setPositionSort] = useState<PositionSortField>('DEFAULT');
  const [positionSortDirection, setPositionSortDirection] = useState<PositionSortDirection>('ASC');
  const [riskCalculatorDropInput, setRiskCalculatorDropInput] = useState('0');
  // --- Position Size Calculator (1% Risk Model) ---
  const [posSizeAccountEquity, setPosSizeAccountEquity] = useState('');
  const [posSizeEntryPrice, setPosSizeEntryPrice] = useState('');
  const [posSizeStopPrice, setPosSizeStopPrice] = useState('');
  // --- ATR Stop System ---
  const [atrSupportLevel, setAtrSupportLevel] = useState('');
  const [atrValue, setAtrValue] = useState('');
  const [atrMultiplier, setAtrMultiplier] = useState('1.0');
  const [accountValueRange, setAccountValueRange] = useState<AccountValueRange>('7D');
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
  const lastAutoSavedSnapshotRef = useRef<string>('');
  const latestBackgroundRefreshFinishedAtRef = useRef<string | null>(null);
  const isEditingConfigRef = useRef(false);
  const [isSnapshotHydrated, setIsSnapshotHydrated] = useState(false);

  function applyRemoteSnapshot(snapshotPayload: unknown, successMessage?: string) {
    const snapshot = parseAppStateSnapshot(JSON.stringify(snapshotPayload));
    const rawSnapshot = typeof snapshotPayload === 'object' && snapshotPayload !== null
      ? snapshotPayload as { data?: { tickerList?: unknown[] } }
      : null;
    const parsedTickerList =
      snapshot.data.tickerList.length === 0 && Array.isArray(rawSnapshot?.data?.tickerList)
        ? normalizeImportedTickerList(rawSnapshot.data.tickerList)
        : snapshot.data.tickerList;
    const mergedTickerList = mergeTickerListsPreservingManualFields(parsedTickerList, tickerListRef.current);
    const normalizedSnapshotText = JSON.stringify({
      ...snapshot,
      data: {
        ...snapshot.data,
        tickerList: mergedTickerList
      }
    });
    hasLoadedRemoteSnapshotRef.current = true;
    lastAutoSavedSnapshotRef.current = normalizedSnapshotText;

    setConfig(snapshot.data.config);
    if (!isEditingConfigRef.current) {
      setConfigForm(snapshot.data.config ?? DEFAULT_CONFIG);
      setIsEditingConfig(false);
    }
    clearCoreAppStateCache();
    setPuts(snapshot.data.puts);
    setClosedTrades(snapshot.data.closedTrades);
    setStockTrades(snapshot.data.stockTrades);
    tickerListRef.current = mergedTickerList;
    setTickerList(mergedTickerList);
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
  const putsWithOverrides = useMemo(
    () =>
      puts.map((put) => {
        const override = optionPriceOverrides[put.id];
        if (!override) {
          return put;
        }

        return {
          ...put,
          option_market_price_per_share: override.price,
          option_market_price_updated: override.updatedAt,
          option_theta_per_share: override.theta,
          option_delta: override.delta,
          option_gamma: override.gamma
        };
      }),
    [optionPriceOverrides, puts]
  );
  const metrics = useMemo(
    () => calculatePortfolioMetrics(config, putsWithOverrides, tickerList, activeScenario),
    [activeScenario, config, putsWithOverrides, tickerList]
  );
  const tickerMap = useMemo(() => new Map(tickerList.map((entry) => [entry.ticker, entry])), [tickerList]);

  useEffect(() => {
    putsRef.current = puts;
  }, [puts]);

  useEffect(() => {
    tickerListRef.current = tickerList;
  }, [tickerList]);

  useEffect(() => {
    isEditingConfigRef.current = isEditingConfig;
  }, [isEditingConfig]);

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
      editingPutId === null;

    if (isFreshForm) {
      saveDraftJson(OPTION_DRAFT_STORAGE_KEY, null);
      return;
    }

    saveDraftJson(OPTION_DRAFT_STORAGE_KEY, {
      putForm,
      editingPutId
    } satisfies OptionDraftState);
  }, [editingPutId, putForm]);

  useEffect(() => {
    let ignore = false;

    async function hydrateSavedSnapshot() {
      try {
        const response = await fetch('/api/app-state');
        const payload = (await response.json()) as { snapshot?: unknown; error?: string };

        if (!response.ok || payload.error || !payload.snapshot || ignore) {
          return;
        }

        applyRemoteSnapshot(payload.snapshot);
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
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    function scheduleNextBackgroundRefreshPoll() {
      if (cancelled || timer !== null) {
        return;
      }

      timer = window.setTimeout(() => {
        timer = null;
        void pollBackgroundRefreshStatus();
      }, BACKGROUND_REFRESH_STATUS_POLL_MS);
    }

    async function pollBackgroundRefreshStatus() {
      try {
        const response = await fetch('/api/refresh-status', { cache: 'no-store' });
        const payload = (await response.json()) as { status?: unknown; error?: string };
        if (!response.ok || payload.error || cancelled) {
          return;
        }

        const nextStatus = normalizeBackgroundRefreshStatus(payload.status);
        if (cancelled) {
          return;
        }

        if (nextStatus.status === 'running') {
          scheduleNextBackgroundRefreshPoll();
          return;
        }

        if (
          nextStatus.finishedAt &&
          nextStatus.finishedAt !== latestBackgroundRefreshFinishedAtRef.current
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

    return () => {
      cancelled = true;
      if (timer !== null) {
        window.clearTimeout(timer);
      }
    };
  }, []);

  useEffect(() => {
    void handleRefreshVix(true);
  }, []);

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
    const optionTickers = [...new Set(putsWithOverrides.map((row) => row.ticker))];
    const holdingTickers = [...new Set([...stockEntries.map((entry) => entry.ticker), ...optionTickers])];

    return holdingTickers
      .map((ticker) => {
        const stockEntry = tickerList.find((entry) => entry.ticker === ticker);
        const callRows = putsWithOverrides.filter((row) => row.ticker === ticker && row.option_side === 'call');
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
        const deltaSummary = buildHoldingDeltaSummary(
          shares,
          [...callRows, ...putsWithOverrides.filter((row) => row.ticker === ticker && row.option_side !== 'call')]
        );

        return {
          ticker,
          shares,
          averageCost: stockEntry?.average_cost_basis,
          currentPrice,
          callRows: [...callRows]
            .map((row) => ({
              ...row,
              premiumIncome: row.premium_per_share * row.contracts * 100,
              optionDelta: typeof row.option_delta === 'number' ? row.option_delta : null,
              optionGamma: typeof row.option_gamma === 'number' ? row.option_gamma : null,
              gammaThetaRatio:
                typeof row.option_gamma === 'number' &&
                typeof row.option_theta_per_share === 'number' &&
                Math.abs(row.option_theta_per_share) > 0.000001
                  ? Math.abs(row.option_gamma / row.option_theta_per_share)
                  : null,
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
          stockDelta: deltaSummary.stockDelta,
          optionDelta: deltaSummary.optionDelta,
          totalDelta: deltaSummary.totalDelta,
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
  }, [putsWithOverrides, tickerList]);
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
  const topIvRankStocks = useMemo(
    () =>
      buildTopIvRankStocks(
        tickerList,
        metrics.totalCapitalBase,
        buildOptionCapitalUsageByTicker(metrics.putRows),
        5
      ),
    [metrics.putRows, metrics.totalCapitalBase, tickerList]
  );

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
    const thetaMap = new Map(metrics.groupedTickerTheta.map((item) => [item.ticker, item.dailyThetaIncome]));
    const tickers = [...new Set([...riskTickersWithOptionLoss.map((item) => item.ticker), ...stockHoldings.map((item) => item.ticker)])];

    return tickers
      .map((ticker) => {
        const putHolding = putMap.get(ticker) ?? null;
        const stockHolding = stockMap.get(ticker) ?? null;
        const tickerEntry = tickerMap.get(ticker) ?? null;
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
        const totalDeltaOnePctImpact =
          stockHolding != null &&
          typeof stockHolding.totalDelta === 'number' &&
          typeof stockHolding.currentPrice === 'number' &&
          Number.isFinite(stockHolding.currentPrice) &&
          stockHolding.currentPrice > 0
            ? stockHolding.totalDelta * stockHolding.currentPrice * 0.01 * (tickerEntry?.beta ?? 1)
            : null;
        const totalOptionThetaIncomePerDay = thetaMap.get(ticker) ?? null;
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
          totalDeltaOnePctImpact,
          totalOptionThetaIncomePerDay,
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
  }, [metrics.groupedTickerTheta, riskTickersWithOptionLoss, stockHoldings, stockLossAlertThreshold]);
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
  const totalUnrealizedOptionPnl = metrics.putRows.reduce((sum, row) => sum + (row.unrealizedPnl ?? 0), 0);
  const accountEquity = (config?.cash ?? 0) + totalStockMarketValue + totalUnrealizedOptionPnl;
  const accountCapitalBase =
    accountEquity > 0
      ? accountEquity
      : metrics.totalCapitalBase > 0
        ? metrics.totalCapitalBase
        : overallCapitalAmount;
  const currentStockRiskFirstDecisions = useMemo(
    () =>
      tickerList
        .filter((entry) => (entry.shares ?? 0) > 0)
        .map((entry) => {
          const shares = entry.shares ?? 0;
          const referencePrice = entry.current_price ?? entry.average_cost_basis;
          const positionValue =
            typeof referencePrice === 'number' && Number.isFinite(referencePrice)
              ? shares * referencePrice
              : 0;
          const atr14 = typeof entry.atr_14 === 'number' && Number.isFinite(entry.atr_14) ? entry.atr_14 : null;
          const currentPriceVal = typeof entry.current_price === 'number' && Number.isFinite(entry.current_price) ? entry.current_price : null;
          const costBasis = typeof entry.average_cost_basis === 'number' && Number.isFinite(entry.average_cost_basis) && entry.average_cost_basis > 0 ? entry.average_cost_basis : null;
          // 1% Risk Stop: the price at which the unrealized loss = 1% of total account equity
          // Anchored to cost basis: stop = costBasis - (accountEquity × 1%) / shares
          const onePercentStopPrice =
            costBasis !== null && shares > 0 && accountCapitalBase > 0
              ? costBasis - (accountCapitalBase * 0.01) / shares
              : null;
          const atrBasisPrice = shares > 0 && costBasis !== null ? costBasis : currentPriceVal;
          const atrBasisLabel = shares > 0 && costBasis !== null ? '平均价' : '现价';
          const atrStopPrice = atr14 !== null && atrBasisPrice !== null ? atrBasisPrice - atr14 : null;
          return {
            ticker: entry.ticker,
            shares,
            positionValue,
            positionPct: accountCapitalBase > 0 ? positionValue / accountCapitalBase : 0,
            currentPrice: entry.current_price,
            averageCostBasis: entry.average_cost_basis,
            atr14,
            onePercentStopPrice,
            atrStopPrice,
            atrBasisPrice,
            atrBasisLabel,
            ma21: typeof entry.ma_21 === 'number' ? entry.ma_21 : null,
            unrealizedPnlPct:
              typeof entry.current_price === 'number' &&
              typeof entry.average_cost_basis === 'number' &&
              entry.average_cost_basis > 0
                ? (entry.current_price - entry.average_cost_basis) / entry.average_cost_basis
                : null,
            decision: buildRiskFirstDecision({
              ticker: entry.ticker,
              tradeType: '中线',
              expectedReturnPct: null,
              maxLossPct: entry.downside_tolerance_pct,
              totalCapital: accountCapitalBase,
              resultingPositionValue: positionValue,
              existingShares: shares,
              currentPrice: entry.current_price,
              averageCostBasis: entry.average_cost_basis,
              investmentLogic: '',
              plannedHoldingTime: '',
              exitStrategy:
                typeof entry.downside_tolerance_pct === 'number'
                  ? `跌破 -${formatPercent(entry.downside_tolerance_pct)} 止损或逻辑失效退出`
                  : '',
              isOneWayDoor: false,
              isAddingToLoss: false
            })
          };
        })
        .sort((a, b) => {
          if (a.decision.allowed !== b.decision.allowed) {
            return a.decision.allowed ? 1 : -1;
          }
          return b.positionValue - a.positionValue;
        }),
    [accountCapitalBase, tickerList]
  );

  const riskCurveCapitalBase = accountCapitalBase;
  const accountValueComparisons = useMemo(
    () => buildAccountValueComparisons(accountValueHistory, accountEquity),
    [accountEquity, accountValueHistory]
  );
  const accountValueChartData = useMemo(
    () => filterAccountValueChartData(accountValueHistory, accountValueRange),
    [accountValueHistory, accountValueRange]
  );
  const accountValueChartSummary = useMemo(() => {
    const firstPoint = accountValueChartData[0] ?? null;
    const lastPoint = accountValueChartData[accountValueChartData.length - 1] ?? null;
    const changeAmount = firstPoint && lastPoint ? lastPoint.totalCapital - firstPoint.totalCapital : null;
    const changePct =
      firstPoint && lastPoint && firstPoint.totalCapital > 0 && changeAmount !== null
        ? changeAmount / firstPoint.totalCapital
        : null;

    return {
      firstPoint,
      lastPoint,
      changeAmount,
      changePct
    };
  }, [accountValueChartData]);
  const accountValueChartDomain = useMemo(
    () => getAccountValueChartDomain(accountValueChartData),
    [accountValueChartData]
  );
  useEffect(() => {
    if (!isSnapshotHydrated) {
      return;
    }

    setAccountValueHistory((current) => upsertDailyAccountValueSnapshot(current, accountEquity));
  }, [accountEquity, isSnapshotHydrated]);
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
    () => buildRiskCalculator(puts, tickerList, riskCalculatorDropPct, riskCurveCapitalBase),
    [puts, riskCalculatorDropPct, riskCurveCapitalBase, tickerList]
  );
  const riskCurvePoints = useMemo(
    () => buildRiskCurvePoints(puts, tickerList, riskCurveCapitalBase),
    [puts, riskCurveCapitalBase, tickerList]
  );

  // --- Position Size Calculator (1% Risk Model) ---
  const posSizeResult = useMemo(() => {
    const equity = Number(posSizeAccountEquity);
    const entry = Number(posSizeEntryPrice);
    const stop = Number(posSizeStopPrice);
    if (!Number.isFinite(equity) || equity <= 0) return null;
    if (!Number.isFinite(entry) || entry <= 0) return null;
    if (!Number.isFinite(stop) || stop <= 0) return null;
    const riskPerShare = Math.abs(entry - stop);
    if (riskPerShare < 0.0001) return null;
    const dollarRisk = equity * 0.01;
    const positionSize = Math.floor(dollarRisk / riskPerShare);
    return { entryPrice: entry, stopPrice: stop, riskPerShare, positionSize, dollarRisk };
  }, [posSizeAccountEquity, posSizeEntryPrice, posSizeStopPrice]);

  // --- ATR Stop System ---
  const atrStopResult = useMemo(() => {
    const support = Number(atrSupportLevel);
    const atr = Number(atrValue);
    const mult = Number(atrMultiplier);
    if (!Number.isFinite(support) || support <= 0) return null;
    if (!Number.isFinite(atr) || atr <= 0) return null;
    const scenarios = ATR_MULTIPLIERS.map((m) => ({
      multiplier: m,
      stopLevel: support - atr * m,
      buffer: atr * m,
    }));
    const activeStop = Number.isFinite(mult) && mult > 0 ? support - atr * mult : null;
    return { support, atr, activeStop, scenarios };
  }, [atrSupportLevel, atrValue, atrMultiplier]);

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
    .sort((a, b) => comparePositionRows(a, b, positionSort, positionSortDirection));

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
      const response = await fetch(silent ? '/api/vix?cache_only=true' : '/api/vix');
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
    await handleSaveAppState(configForm);
    setIsEditingConfig(false);
  }

  function handleStartConfigEdit() {
    setConfigForm(config ?? DEFAULT_CONFIG);
    setConfigErrors({});
    setIsEditingConfig(true);
  }

  function handleCancelConfigEdit() {
    setConfigForm(config ?? DEFAULT_CONFIG);
    setConfigErrors({});
    setIsEditingConfig(false);
  }

  async function persistPutPosition(normalized: PutPosition, targetEditingPutId: string | null) {
    const directPosition = buildDirectOptionPosition(normalized);
    const nextPuts = upsertPutPosition(puts, directPosition, targetEditingPutId, generateId);
    const nextTickerList = ensureTickerExists(tickerList, directPosition.ticker);
    const nextConfig = applyOptionOpenCash(config, configForm ?? DEFAULT_CONFIG, directPosition, targetEditingPutId !== null);
    

    const persistedPosition =
      nextPuts.find((item) => item.id === targetEditingPutId) ??
      nextPuts.find((item) => !puts.some((existing) => existing.id === item.id)) ??
      null;

    if (!persistedPosition) {
      throw new Error(`未能构建 ${directPosition.ticker} ${getOptionSideLabel(directPosition.option_side)} 的持久化快照`);
    }

    await persistAppStateSnapshot(
      buildAppStateSnapshot({
        config: nextConfig,
        puts: nextPuts,
        closedTrades,
        stockTrades,
        tickerList: nextTickerList,
        scenario,
        vixHistory,
        accountValueHistory
      }),
      targetEditingPutId
        ? `已更新 ${directPosition.ticker} ${getOptionSideLabel(directPosition.option_side)}`
        : `已保存 ${directPosition.ticker} ${getOptionSideLabel(directPosition.option_side)}`,
      targetEditingPutId ? '更新期权失败' : '保存期权失败'
    );

    // Optimistic update: update local state immediately after first success
    setPuts(nextPuts);
    setTickerList(nextTickerList);
    setConfig(nextConfig);
    setConfigForm(nextConfig);
    setConfigErrors({});
    setActiveTab('positions');
    window.localStorage.setItem(ACTIVE_TAB_STORAGE_KEY, 'positions');
    setPutForm(createEmptyPut());
    setPutErrors({});
    setEditingPutId(null);

    // Still wait for verification in the background to ensure consistency with server truth
    const persistedSnapshot = await waitForPersistedAppStateSnapshot(
      (snapshot) => hasExpectedPersistedPositionState(snapshot.data.puts, nextPuts, persistedPosition.id),
      targetEditingPutId ? '期权更新保存确认超时，请刷新页面检查' : '期权保存确认超时，请刷新页面检查'
    );

    // Final sync with server truth
    setPuts(persistedSnapshot.data.puts);
    setTickerList(persistedSnapshot.data.tickerList);
    setConfig(persistedSnapshot.data.config);
    setConfigForm(persistedSnapshot.data.config ?? DEFAULT_CONFIG);
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

    setIsSavingPut(true);
    try {
      await persistPutPosition(normalized, editingPutId);
    } catch (error) {
      setImportExportMessage(error instanceof Error ? error.message : editingPutId ? '更新期权失败' : '保存期权失败');
    } finally {
      setIsSavingPut(false);
    }
  }

  function handleEditPut(put: PutPosition) {
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
    setClosePreviewError('');
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
      | 'id'
      | 'ticker'
      | 'expiration_date'
      | 'put_strike'
      | 'option_side'
      | 'option_market_price_per_share'
      | 'option_market_price_updated'
      | 'option_theta_per_share'
      | 'option_delta'
      | 'option_gamma'
    >,
    silent = false,
    persistAfterRefresh = true
  ) {
    const livePosition = putsRef.current.find((item) => item.id === position.id) ?? position;
    const response = await fetch(
      `/api/option-price?symbol=${encodeURIComponent(livePosition.ticker)}&expiration_date=${encodeURIComponent(livePosition.expiration_date)}&strike=${encodeURIComponent(String(livePosition.put_strike))}&side=${encodeURIComponent(livePosition.option_side === 'call' ? 'call' : 'put')}`
    );
    const payload = (await response.json()) as {
      option_price_per_share?: number;
      theta_per_share?: number | null;
      delta?: number | null;
      gamma?: number | null;
      as_of?: string;
      error?: string;
    };

    if (!response.ok || payload.error || typeof payload.option_price_per_share !== 'number') {
      throw new Error(payload.error ?? `${livePosition.ticker} 当前期权价格刷新失败`);
    }

    const updatedAt = payload.as_of ?? new Date().toISOString();
    const refreshedOptionPrice = payload.option_price_per_share;
    const preservedTheta = typeof livePosition.option_theta_per_share === 'number' ? livePosition.option_theta_per_share : null;
    const preservedDelta = typeof livePosition.option_delta === 'number' ? livePosition.option_delta : null;
    const preservedGamma = typeof livePosition.option_gamma === 'number' ? livePosition.option_gamma : null;
    const receivedGreeks = typeof payload.delta === 'number' && typeof payload.gamma === 'number';
    const refreshedTheta = typeof payload.theta_per_share === 'number' ? payload.theta_per_share : preservedTheta;
    const refreshedDelta = typeof payload.delta === 'number' ? payload.delta : preservedDelta;
    const refreshedGamma = typeof payload.gamma === 'number' ? payload.gamma : preservedGamma;
    const hasPersistedGreeks = typeof refreshedDelta === 'number' && typeof refreshedGamma === 'number';

    setOptionPriceOverrides((current) => ({
      ...current,
      [livePosition.id]: {
        price: refreshedOptionPrice,
        theta: refreshedTheta,
        delta: refreshedDelta,
        gamma: refreshedGamma,
        updatedAt
      }
    }));
    setOptionPriceMessages((current) => ({
      ...current,
      [livePosition.id]: {
        tone: receivedGreeks || hasPersistedGreeks ? 'success' : 'info',
        text:
          receivedGreeks || hasPersistedGreeks
            ? `已更新 ${formatCurrency(refreshedOptionPrice)}/share`
            : `已更新 ${formatCurrency(refreshedOptionPrice)}/share，但未返回 Delta/Gamma`
      }
    }));

    const nextPuts = putsRef.current.map((item) =>
      item.id === livePosition.id
        ? {
            ...item,
            option_market_price_per_share: refreshedOptionPrice,
            option_market_price_updated: updatedAt,
            option_theta_per_share: refreshedTheta,
            option_delta: refreshedDelta,
            option_gamma: refreshedGamma
          }
        : item
    );
    putsRef.current = nextPuts;
    setPuts(nextPuts);

    if (persistAfterRefresh) {
      try {
        await persistAppStateSnapshot(
          buildAppStateSnapshot({
            config,
            puts: nextPuts,
            closedTrades,
            stockTrades,
            tickerList,
            scenario,
            vixHistory,
            accountValueHistory
          }),
          undefined,
          '刷新期权后保存失败',
          { saveMode: 'merge' }
        );
      } catch (error) {
        setImportExportMessage(error instanceof Error ? error.message : '刷新期权后保存失败');
      }
    }

    if (!silent) {
      setImportExportMessage(
        receivedGreeks || hasPersistedGreeks
          ? `${livePosition.ticker} ${getOptionSideBadge(livePosition.option_side)} 当前期权价格已更新为 ${formatCurrency(refreshedOptionPrice)}/share`
          : `${livePosition.ticker} ${getOptionSideBadge(livePosition.option_side)} 价格已更新为 ${formatCurrency(refreshedOptionPrice)}/share，但本次未返回 Delta/Gamma`
      );
    }

    return {
      ...payload,
      receivedGreeks,
      hasPersistedGreeks,
      nextPuts
    };
  }

  async function refreshSingleOptionPriceWithRetry(
    position: Pick<
      PutPosition,
      | 'id'
      | 'ticker'
      | 'expiration_date'
      | 'put_strike'
      | 'option_side'
      | 'option_market_price_per_share'
      | 'option_market_price_updated'
      | 'option_theta_per_share'
      | 'option_delta'
      | 'option_gamma'
    >,
    silent = false,
    persistAfterRefresh = true
  ) {
    try {
      return await refreshSingleOptionPrice(position, silent, persistAfterRefresh);
    } catch (error) {
      const message = error instanceof Error ? error.message : '当前期权价格刷新失败';
      if (!isMinuteLimitError(message)) {
        throw error;
      }

      setImportExportMessage(`${position.ticker} 遇到分钟限额，正在放慢节奏后重试...`);
      await sleep(PRICE_REFRESH_RETRY_GAP_MS);
      return refreshSingleOptionPrice(position, silent, persistAfterRefresh);
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
    let priceOnlyCount = 0;
    const failureMessages: string[] = [];

    try {
      let completedCount = 0;
      const updateProgress = (ticker: string) => {
        setRefreshAllOptionsProgress({
          current: completedCount,
          total: positions.length,
          successCount,
          failureCount,
          ticker
        });
      };

      for (let startIndex = 0; startIndex < positions.length; startIndex += OPTION_REFRESH_ALL_CONCURRENCY) {
        const batch = positions.slice(startIndex, startIndex + OPTION_REFRESH_ALL_CONCURRENCY);

        batch.forEach((position) => {
          setOptionPriceMessages((current) => ({
            ...current,
            [position.id]: {
              tone: 'info',
              text: '正在刷新期权价格...'
            }
          }));
        });

        await Promise.all(
          batch.map(async (position) => {
            updateProgress(position.ticker);

        try {
          const result = await refreshSingleOptionPriceWithRetry(position, true, false);
          successCount += 1;
          if (!result.receivedGreeks && !result.hasPersistedGreeks) {
            priceOnlyCount += 1;
            failureMessages.push(`${position.ticker}: 仅更新价格，未返回 Delta/Gamma`);
          }
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
              completedCount += 1;
              updateProgress(position.ticker);
            }
          })
        );

        if (startIndex + OPTION_REFRESH_ALL_CONCURRENCY < positions.length) {
          await sleep(PRICE_REFRESH_GAP_MS);
        }
      }

      setImportExportMessage(
        failureCount > 0 || priceOnlyCount > 0
          ? `已刷新 ${successCount} 笔期权，失败 ${failureCount} 笔，只有价格更新 ${priceOnlyCount} 笔：${failureMessages.slice(0, 3).join('；')}${failureMessages.length > 3 ? '……' : ''}`
          : `已刷新全部 ${successCount} 笔期权价格和 Greeks`
      );

      if (successCount > 0) {
        try {
          await persistAppStateSnapshot(
            buildAppStateSnapshot({
              config,
              puts: putsRef.current,
              closedTrades,
              stockTrades,
              tickerList,
              scenario,
              vixHistory,
              accountValueHistory
            }),
            undefined,
            '全部刷新后保存失败',
            { saveMode: 'merge' }
          );
        } catch (error) {
          setImportExportMessage(`部分期权刷新成功，但整体保存失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
      }
    } finally {
      setRefreshAllOptionsProgress(null);
      setIsRefreshingAllOptions(false);
      setRefreshingOptionPriceId(null);
    }
  }

  async function confirmDeletePut() {
    if (!deletePreview) {
      return;
    }

    const deleteResult = deleteOpenPositionAndPruneTicker(puts, tickerList, deletePreview.id);
    const nextDeletedPositionIds = [...deletedPositionIds.filter((item) => item !== deletePreview.id), deletePreview.id].sort();
    const nextDeletedTickersForRemoval = deleteResult.removedTicker
      ? [...deletedTickers.filter((item) => item !== deleteResult.removedTicker), deleteResult.removedTicker].sort()
      : deletedTickers;

    const nextSnapshot = buildAppStateSnapshot({
      config,
      puts: deleteResult.nextPuts,
      closedTrades,
      stockTrades,
      tickerList: deleteResult.removedTicker ? deleteResult.nextTickerList : tickerList,
      scenario,
      vixHistory,
      accountValueHistory
    });

    try {
      await persistAppStateSnapshot(nextSnapshot, `已删除 ${deletePreview.ticker}`, '删除期权后保存失败', {
        allowDestructiveWrite: true
      });
      setPuts(deleteResult.nextPuts);
      setDeletedPositionIds(nextDeletedPositionIds);
      if (deleteResult.removedTicker) {
        setTickerList(deleteResult.nextTickerList);
        setDeletedTickers(nextDeletedTickersForRemoval);
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
    } catch (error) {
      setImportExportMessage(error instanceof Error ? error.message : '删除期权后保存失败');
    }
  }

  async function confirmClosePut() {
    if (!closePreview) {
      return;
    }

    setClosePreviewError('');
    const contractsToClose = Number(closePreview.contractsToClose);
    const buybackPremiumPerShare = Number(closePreview.buybackPremiumPerShare);
    if (!Number.isFinite(contractsToClose) || contractsToClose <= 0 || contractsToClose > closePreview.row.contracts) {
      const message = `平仓张数请输入 1 到 ${closePreview.row.contracts} 之间的有效数字`;
      setImportExportMessage(message);
      setClosePreviewError(message);
      return;
    }
    if (!Number.isFinite(buybackPremiumPerShare) || buybackPremiumPerShare < 0) {
      const message = '买回权利金请输入有效数字';
      setImportExportMessage(message);
      setClosePreviewError(message);
      return;
    }
    if (closePreview.closedAt.trim() === '') {
      const message = '请选择平仓日期';
      setImportExportMessage(message);
      setClosePreviewError(message);
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

    const nextConfig = applyOptionCloseCash(config, configForm ?? DEFAULT_CONFIG, buybackPremiumPerShare, contractsToClose);

    const isFullyClosed = contractsToClose >= closePreview.row.contracts;
    const nextDeletedPositionIds = isFullyClosed
      ? [...deletedPositionIds.filter((item) => item !== closePreview.row.id), closePreview.row.id].sort()
      : deletedPositionIds;

    const nextSnapshot = buildAppStateSnapshot({
      config: nextConfig,
      puts: closeResult.nextPuts,
      closedTrades: closeResult.nextClosedTrades,
      stockTrades,
      tickerList,
      scenario,
      vixHistory,
      accountValueHistory
    });

    const successMessage = `已平仓 ${closePreview.row.ticker} ${contractsToClose} 张，已实现盈亏 ${formatCurrency(
      (closePreview.row.premium_per_share - buybackPremiumPerShare) * contractsToClose * 100
    )}`;
    const expectedClosedTradeId = closeResult.nextClosedTrades[0]?.id ?? null;
    const previousClosedTrades = closedTrades;
    const previousPuts = puts;
    const previousConfig = config;
    const previousConfigForm = configForm;
    const previousDeletedPositionIds = deletedPositionIds;
    const previousEditingPutId = editingPutId;
    const previousPutForm = putForm;
    const previousPutErrors = putErrors;

    try {
      setIsClosingPosition(true);
      setImportExportMessage(`正在保存 ${closePreview.row.ticker} 平仓记录...`);
      setClosedTrades(closeResult.nextClosedTrades);
      setPuts(closeResult.nextPuts);
      setConfig(nextConfig);
      setConfigForm(nextConfig);
      setConfigErrors({});
      if (isFullyClosed) {
        setDeletedPositionIds(nextDeletedPositionIds);
      }
      if (editingPutId === closePreview.row.id && isFullyClosed) {
        setEditingPutId(null);
        setPutForm(createEmptyPut());
        setPutErrors({});
      }
      await persistAppStateSnapshot(nextSnapshot, successMessage, '平仓后保存失败');

      setClosePreview(null);

      // Verify in background
      const persistedSnapshot = await waitForPersistedAppStateSnapshot(
        (snapshot) =>
          hasExpectedPersistedPositionState(
            snapshot.data.puts,
            closeResult.nextPuts,
            closePreview.row.id
          ) &&
          (
            expectedClosedTradeId === null ||
            hasExpectedPersistedClosedTrade(
              snapshot.data.closedTrades,
              closeResult.nextClosedTrades,
              expectedClosedTradeId
            )
          ),
        '平仓保存确认超时，请刷新页面检查'
      );

      // Final sync with server truth
      setPuts(persistedSnapshot.data.puts);
      setClosedTrades(persistedSnapshot.data.closedTrades);
      setTickerList(persistedSnapshot.data.tickerList);
      setConfig(persistedSnapshot.data.config);
      setConfigForm(persistedSnapshot.data.config ?? DEFAULT_CONFIG);
    } catch (error) {
      setClosedTrades(previousClosedTrades);
      setPuts(previousPuts);
      setConfig(previousConfig);
      setConfigForm(previousConfigForm);
      setDeletedPositionIds(previousDeletedPositionIds);
      if (previousEditingPutId === closePreview.row.id) {
        setEditingPutId(previousEditingPutId);
        setPutForm(previousPutForm);
        setPutErrors(previousPutErrors);
      }
      const message = error instanceof Error ? error.message : '平仓后保存失败';
      console.error('confirmClosePut failed', error);
      setImportExportMessage(message);
      setClosePreviewError(message);
    } finally {
      setIsClosingPosition(false);
    }
  }

  function handleEditClosedTrade(trade: ClosedPutTrade) {
    setHistoryEditPreview(buildClosedTradeEditPreview(trade));
  }

  async function confirmEditClosedTrade() {
    if (!historyEditPreview) {
      return;
    }

    const parsedPreview = parseClosedTradeEditPreview(historyEditPreview);

    if (!parsedPreview.ok) {
      setImportExportMessage('历史记录编辑失败：请输入有效的行权价、权利金和合约数');
      return;
    }

    const nextClosedTrades = updateClosedTrade(closedTrades, {
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
    });

    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config,
          puts,
          closedTrades: nextClosedTrades,
          stockTrades,
          tickerList,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        `已更新 ${normalizeTicker(historyEditPreview.ticker)} 的历史记录`,
        '历史记录编辑保存失败'
      );
      setClosedTrades(nextClosedTrades);
      setHistoryEditPreview(null);
    } catch (error) {
      setImportExportMessage(error instanceof Error ? error.message : '历史记录编辑保存失败');
    }
  }

  function handleUpdateClosedTradeReflection(tradeId: string, reflectionNotes: string) {
    setClosedTrades((current) =>
      current.map((trade) => (trade.id === tradeId ? { ...trade, reflection_notes: reflectionNotes } : trade))
    );
  }

  async function handleDeleteClosedTrade(trade: ClosedPutTrade) {
    if (!window.confirm(`确定删除 ${trade.ticker} 的这条期权历史记录吗？`)) {
      return;
    }

    const nextClosedTrades = removeClosedTrade(closedTrades, trade.id);

    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config,
          puts,
          closedTrades: nextClosedTrades,
          stockTrades,
          tickerList,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        `已删除 ${trade.ticker} 的期权历史记录`,
        '删除历史记录失败',
        { allowDestructiveWrite: true }
      );
      setClosedTrades(nextClosedTrades);
    } catch (error) {
      setImportExportMessage(error instanceof Error ? error.message : '删除历史记录失败');
    }
  }

  async function handleDeleteStockTrade(trade: StockTradeHistory) {
    if (!window.confirm(`确定删除 ${trade.ticker} 的这条股票交易记录吗？`)) {
      return;
    }

    const nextStockTrades = stockTrades.filter((item) => item.id !== trade.id);

    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config,
          puts,
          closedTrades,
          stockTrades: nextStockTrades,
          tickerList,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        `已删除 ${trade.ticker} 的股票交易记录`,
        '删除股票交易记录失败',
        { allowDestructiveWrite: true }
      );
      setStockTrades(nextStockTrades);
    } catch (error) {
      setImportExportMessage(error instanceof Error ? error.message : '删除股票交易记录失败');
    }
  }

  async function handleAddTicker() {
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

    const nextTickerList = addTickerEntry(tickerList, {
      ticker: newTicker,
      beta: newTickerBeta,
      buyRsiAlert: newTickerBuyRsiAlert
    });
    tickerListRef.current = nextTickerList;
    setTickerList(nextTickerList);

    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config,
          puts,
          closedTrades,
          stockTrades,
          tickerList: nextTickerList,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        `已添加 ${normalized}`,
        '添加股票标的失败',
        { saveMode: 'merge' }
      );
      setDeletedTickers((current) => current.filter((item) => item !== normalized));
      setPutForm((current) => ({ ...current, ticker: normalized }));
      setNewTicker('');
      setNewTickerBeta('');
      setNewTickerBuyRsiAlert('');
      setTickerMessage(`已添加 ${normalized}`);
    } catch (error) {
      tickerListRef.current = tickerList;
      setTickerList(tickerList);
      setTickerMessage(error instanceof Error ? error.message : '添加股票标的失败');
    }
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
        ...(current[ticker] ?? {
          beta: '',
          shares: '',
          averageCostBasis: '',
          targetTrimPrice: '',
          buyRsiAlert: ''
        }),
        [field]: value
      }
    }));
  }

  async function handleSaveTickerEdit(ticker: string) {
    const draft = tickerDrafts[ticker];
    if (!draft) {
      return;
    }

    const nextTickerList = updateTickerEntry(tickerList, ticker, {
      beta: draft.beta.trim() === '' ? null : Number(draft.beta),
      shares: draft.shares.trim() === '' ? null : Number(draft.shares),
      average_cost_basis: draft.averageCostBasis.trim() === '' ? null : Number(draft.averageCostBasis),
      target_trim_price: draft.targetTrimPrice.trim() === '' ? null : Number(draft.targetTrimPrice),
      buy_rsi_alert: draft.buyRsiAlert.trim() === '' ? null : Number(draft.buyRsiAlert)
    });

    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config,
          puts,
          closedTrades,
          stockTrades,
          tickerList: nextTickerList,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        `已保存 ${ticker}`,
        '保存股票配置失败'
      );
      setTickerList(nextTickerList);
      handleCancelTickerEdit(ticker);
      setTickerMessage(`已保存 ${ticker}`);
    } catch (error) {
      setTickerMessage(error instanceof Error ? error.message : '保存股票配置失败');
    }
  }

  async function handleDeleteTicker(ticker: string) {
    const hasOpenPut = puts.some((put) => put.ticker === ticker);
    if (hasOpenPut) {
      setTickerMessage(`无法删除 ${ticker}：还有 Option 仓位在使用它`);
      return;
    }

    const nextTickerList = removeTickerEntry(tickerList, ticker);
    const nextDeletedTickers = [...deletedTickers.filter((item) => item !== ticker), ticker].sort();

    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config,
          puts,
          closedTrades,
          stockTrades,
          tickerList: nextTickerList,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        `已删除 ${ticker}`,
        '删除股票后保存失败',
        { allowDestructiveWrite: true }
      );
      setTickerList(nextTickerList);
      setDeletedTickers(nextDeletedTickers);
      if (putForm.ticker === ticker) {
        setPutForm((current) => ({ ...current, ticker: '' }));
      }
    } catch (error) {
      setTickerMessage(error instanceof Error ? error.message : '删除股票后保存失败');
      return;
    }
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
    const defaultLossPct =
      typeof entry.downside_tolerance_pct === 'number' && Number.isFinite(entry.downside_tolerance_pct)
        ? (entry.downside_tolerance_pct * 100).toFixed(1).replace(/\.0$/, '')
        : '10';

    setBuyStockPreview({
      ticker: entry.ticker,
      currentShares: entry.shares ?? 0,
      sharesToBuy: '100',
      buyPricePerShare:
        typeof entry.current_price === 'number' && Number.isFinite(entry.current_price)
          ? entry.current_price.toFixed(2)
          : typeof entry.average_cost_basis === 'number' && Number.isFinite(entry.average_cost_basis)
            ? entry.average_cost_basis.toFixed(2)
            : '',
      tradeType: '中线',
      investmentLogic: '',
      expectedUpsidePct: '',
      maxLossPct: defaultLossPct,
      plannedHoldingTime: '',
      exitStrategy: `跌破 -${defaultLossPct}% 止损，或买入逻辑失效时退出`,
      isOneWayDoor: false
    });
  }

  async function confirmSellStock() {
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

    const averageCostBasis =
      tickerList.find((entry) => entry.ticker === sellStockPreview.ticker)?.average_cost_basis ?? 0;
    const realizedPnl = (sellPricePerShare - averageCostBasis) * sharesToSell;
    const nextStockTrades: StockTradeHistory[] = [
      {
        id: generateId(),
        ticker: sellStockPreview.ticker,
        action: 'sell' as const,
        shares: sharesToSell,
        price_per_share: sellPricePerShare,
        traded_at: new Date().toISOString().slice(0, 10),
        cash_change: sellResult.proceeds,
        realized_pnl: realizedPnl
      },
      ...stockTrades
    ];

    const nextConfig = applyStockSellCash(config, configForm ?? DEFAULT_CONFIG, sellResult.proceeds);
    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config: nextConfig,
          puts,
          closedTrades,
          stockTrades: nextStockTrades,
          tickerList: sellResult.nextEntries,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        `已卖出 ${sellStockPreview.ticker} ${sharesToSell} 股，回笼现金 ${formatCurrency(sellResult.proceeds)}`,
        '卖出股票后保存失败'
      );
      setTickerList(sellResult.nextEntries);
      setStockTrades(nextStockTrades);
      setConfig(nextConfig);
      setConfigForm(nextConfig);
      setConfigErrors({});
      setSellStockPreview(null);
      setTickerMessage(
        `已卖出 ${sellStockPreview.ticker} ${sharesToSell} 股，回笼现金 ${formatCurrency(sellResult.proceeds)}`
      );
    } catch (error) {
      setTickerMessage(error instanceof Error ? error.message : '卖出股票后保存失败');
    }
  }

  async function confirmBuyStock() {
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

    const nextStockTrades: StockTradeHistory[] = [
      {
        id: generateId(),
        ticker: buyStockPreview.ticker,
        action: 'buy' as const,
        shares: sharesToBuy,
        price_per_share: buyPricePerShare,
        traded_at: new Date().toISOString().slice(0, 10),
        cash_change: -buyResult.cost,
        realized_pnl: 0
      },
      ...stockTrades
    ];

    const nextConfig = applyStockBuyCash(config, configForm ?? DEFAULT_CONFIG, buyResult.cost);
    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config: nextConfig,
          puts,
          closedTrades,
          stockTrades: nextStockTrades,
          tickerList: buyResult.nextEntries,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        `已买入 ${buyStockPreview.ticker} ${sharesToBuy} 股，现金减少 ${formatCurrency(buyResult.cost)}`,
        '买入股票后保存失败'
      );
      setTickerList(buyResult.nextEntries);
      setStockTrades(nextStockTrades);
      setConfig(nextConfig);
      setConfigForm(nextConfig);
      setConfigErrors({});
      setBuyStockPreview(null);
      setTickerMessage(
        `已买入 ${buyStockPreview.ticker} ${sharesToBuy} 股，现金减少 ${formatCurrency(buyResult.cost)}`
      );
    } catch (error) {
      setTickerMessage(error instanceof Error ? error.message : '买入股票后保存失败');
    }
  }

  function applyQuotesPayload(payload: QuotesPayload, requestedTickers: string[]) {
    const baseTickerList = tickerListRef.current.length > 0 ? tickerListRef.current : tickerList;
    const nextTickerList = applyQuoteRefreshToTickerList(baseTickerList, payload, requestedTickers);
    tickerListRef.current = nextTickerList;
    setTickerList(nextTickerList);
    return nextTickerList;
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

    const nextTickerList = applyQuotesPayload(payload, entries.map((entry) => entry.ticker));
    return { payload, nextTickerList };
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
    const { payload, nextTickerList } = await refreshTickerQuotesWithRetry(entry, mode);
    return { payload, nextTickerList, pcrUpdated: typeof payload.putCallRatio?.[entry.ticker] === 'number', pcrError: '' };
  }

  async function handleRefreshTicker(entry: TickerEntry) {
    if (entry.ticker === '') {
      setPriceRefreshMessage('没有可刷新的股票代码');
      return;
    }

    setRefreshingTicker(entry.ticker);
    setPriceRefreshMessage('');

    try {
      const { payload, nextTickerList, pcrUpdated, pcrError } = await refreshTickerMarketData(entry, 'full');
      const quotes = payload.quotes ?? {};

      if (typeof quotes[entry.ticker] === 'number') {
        await persistAppStateSnapshot(
          buildAppStateSnapshot({
            config,
            puts,
            closedTrades,
            stockTrades,
            tickerList: nextTickerList,
            scenario,
            vixHistory,
            accountValueHistory
          }),
          undefined,
          `${entry.ticker} 刷新后保存失败`,
          { saveMode: 'merge' }
        );
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

  async function handleToggleOptionSnapshot(entry: TickerEntry) {
    const nowEnabled = entry.option_snapshot_enabled === true;
    const nextEnabled = !nowEnabled;
    const nextTickerList = tickerList.map((item) =>
      item.ticker === entry.ticker
        ? { ...item, option_snapshot_enabled: nextEnabled }
        : item
    );
    try {
      await persistAppStateSnapshot(
        buildAppStateSnapshot({
          config,
          puts,
          closedTrades,
          stockTrades,
          tickerList: nextTickerList,
          scenario,
          vixHistory,
          accountValueHistory
        }),
        nextEnabled
          ? `已为 ${entry.ticker} 启用期权快照采集`
          : `已为 ${entry.ticker} 停用期权快照采集`,
        '保存期权快照设置失败'
      );
      setTickerList(nextTickerList);
    } catch (error) {
      setPriceRefreshMessage(error instanceof Error ? error.message : '保存期权快照设置失败');
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

    if (tickerListRef.current.length === 0) {
      tickerListRef.current = entries;
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

      if (successCount > 0) {
        try {
          await persistAppStateSnapshot(
            buildAppStateSnapshot({
              config,
              puts,
              closedTrades,
              stockTrades,
              tickerList: tickerListRef.current,
              scenario,
              vixHistory,
              accountValueHistory
            }),
            undefined,
            '全部刷新后保存失败',
            { saveMode: 'merge' }
          );
        } catch (error) {
          setPriceRefreshMessage(`部分股票刷新成功，但整体保存失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
      }
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
    failureFallback = '保存失败',
    options?: { saveMode?: 'merge' | 'replace'; allowDestructiveWrite?: boolean }
  ) {
    const headers = {
      'Content-Type': 'application/json',
      'X-App-State-Save-Mode': options?.saveMode === 'merge' ? 'merge' : 'replace',
      'X-App-State-Allow-Destructive': options?.allowDestructiveWrite ? 'true' : 'false'
    };

    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch('/api/app-state', {
          method: 'POST',
      headers,
      body: JSON.stringify(snapshot)
        });
        const payload = await readJsonResponse<{ ok?: boolean; error?: string; storage?: { driver?: string | null } }>(response);

        if (!response.ok || payload.error) {
          throw new Error(payload.error ?? failureFallback);
        }

        hasLoadedRemoteSnapshotRef.current = true;
        lastAutoSavedSnapshotRef.current = JSON.stringify(snapshot);
        clearCoreAppStateCache();
        if (successMessage) {
          setImportExportMessage(formatPersistSuccessMessage(successMessage, payload.storage) ?? successMessage);
        }
        return;
      } catch (error) {
        lastError = error;
        if (!(error instanceof TypeError && error.message === 'Failed to fetch') || attempt === 1) {
          break;
        }
        await sleep(400);
      }
    }

    throw new Error(formatFetchFailure(lastError, failureFallback));
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
        setIsEditingConfig(false);
        clearCoreAppStateCache();
        setPuts(snapshot.data.puts);
        setClosedTrades(snapshot.data.closedTrades);
        setStockTrades(snapshot.data.stockTrades);
        setAccountValueHistory(snapshot.data.accountValueHistory);
        tickerListRef.current = snapshot.data.tickerList;
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
        tickerListRef.current = imported.tickerList;
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
  const riskCurveMinCapital = Math.min(...riskCurvePoints.map((point) => point.capital), riskCurveCapitalBase || 0);
  const riskCurveMaxCapital = Math.max(...riskCurvePoints.map((point) => point.capital), riskCurveCapitalBase || 0);
  const currentRiskCurvePoint = useMemo(
    () =>
      riskCurvePoints.find((point) => Math.abs(point.scenarioPct - riskCalculatorDropPct) < 0.000001) ?? {
        scenarioPct: riskCalculatorDropPct,
        capital: riskCalculator.scenarioCapital,
        netChange: riskCalculator.totalNetChange
      },
    [riskCalculator.scenarioCapital, riskCalculator.totalNetChange, riskCalculatorDropPct, riskCurvePoints]
  );

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
          className={`segment ${activeTab === 'risk_first' ? 'active' : ''}`}
          onClick={() => setActiveTab('risk_first')}
          type="button"
          role="tab"
          aria-selected={activeTab === 'risk_first'}
        >
          Stop Loss
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
                            <div className="stock-holding-summary-strip stock-holding-summary-strip-secondary">
                              <span>
                                <small>股票 Delta</small>
                                <strong>{holding == null ? '-' : holding.stockDelta.toFixed(1)}</strong>
                              </span>
                              <span>
                                <small>期权 Delta</small>
                                <strong className={holding != null && holding.optionDelta < 0 ? 'value-negative' : holding != null && holding.optionDelta > 0 ? 'value-positive' : ''}>
                                  {holding == null ? '-' : `${holding.optionDelta >= 0 ? '+' : ''}${holding.optionDelta.toFixed(1)}`}
                                </strong>
                              </span>
                              <span>
                                <small>总 Delta</small>
                                <strong className={holding != null && holding.totalDelta < 0 ? 'value-negative' : holding != null && holding.totalDelta > 0 ? 'value-positive' : ''}>
                                  {holding == null ? '-' : `${holding.totalDelta >= 0 ? '+' : ''}${holding.totalDelta.toFixed(1)}`}
                                </strong>
                              </span>
                              <span>
                                <small>价格变化 1%</small>
                                <strong className={item.totalDeltaOnePctImpact != null && item.totalDeltaOnePctImpact < 0 ? 'value-negative' : item.totalDeltaOnePctImpact != null && item.totalDeltaOnePctImpact > 0 ? 'value-positive' : ''}>
                                  {item.totalDeltaOnePctImpact == null ? '-' : formatSignedCurrency(item.totalDeltaOnePctImpact)}
                                </strong>
                              </span>
                              <span>
                                <small>期权 Theta / day</small>
                                <strong className={item.totalOptionThetaIncomePerDay != null && item.totalOptionThetaIncomePerDay > 0 ? 'value-positive' : ''}>
                                  {item.totalOptionThetaIncomePerDay == null ? '-' : formatCurrency(item.totalOptionThetaIncomePerDay)}
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
                                              <small>Delta</small>
                                              <strong>{row.optionDelta == null ? '-' : row.optionDelta.toFixed(3)}</strong>
                                              <small>Gamma</small>
                                              <strong>{row.optionGamma == null ? '-' : row.optionGamma.toFixed(4)}</strong>
                                              <small>距 Strike</small>
                                              <strong className={isItm || isNearStrike ? 'value-negative' : ''}>
                                                {strikeDistancePct === null
                                                  ? '-'
                                                  : strikeDistancePct < 0
                                                    ? `ITM ${formatPercent(Math.abs(strikeDistancePct))}`
                                                    : formatPercent(strikeDistancePct)}
                                              </strong>
                                              <small>Gamma / Theta 比例</small>
                                              <strong className={row.gammaThetaRatio != null && row.gammaThetaRatio >= 12 ? 'value-negative' : ''}>
                                                {row.gammaThetaRatio == null ? '-' : row.gammaThetaRatio.toFixed(2)}
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
                                              <small>Delta</small>
                                              <strong>{row.optionDelta == null ? '-' : row.optionDelta.toFixed(3)}</strong>
                                              <small>Gamma</small>
                                              <strong>{row.optionGamma == null ? '-' : row.optionGamma.toFixed(4)}</strong>
                                              <small>距 Strike</small>
                                              <strong className={isItm || isNearStrike ? 'value-negative' : ''}>
                                                {strikeDistancePct === null
                                                  ? '-'
                                                  : strikeDistancePct < 0
                                                    ? `ITM ${formatPercent(Math.abs(strikeDistancePct))}`
                                                    : formatPercent(strikeDistancePct)}
                                              </strong>
                                              <small>Gamma / Theta 比例</small>
                                              <strong className={row.gammaThetaRatio != null && row.gammaThetaRatio >= 12 ? 'value-negative' : ''}>
                                                {row.gammaThetaRatio == null ? '-' : row.gammaThetaRatio.toFixed(2)}
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
            <div className="trend-card account-value-card">
              <div className="account-value-card-header">
                <div>
                  <p className="section-kicker">Portfolio Value</p>
                  <h3>Daily Equity Curve</h3>
                </div>
                <div className="account-value-range-switch" role="tablist" aria-label="Portfolio value range">
                  {ACCOUNT_VALUE_RANGE_OPTIONS.map((range) => (
                    <button
                      key={range}
                      type="button"
                      className={`range-chip ${accountValueRange === range ? 'active' : ''}`}
                      onClick={() => setAccountValueRange(range)}
                    >
                      {range}
                    </button>
                  ))}
                </div>
              </div>
              <div className="account-value-summary">
                <div className="trend-summary-item">
                  <span>Latest</span>
                  <strong>
                    {accountValueChartSummary.lastPoint ? formatCurrency(accountValueChartSummary.lastPoint.totalCapital) : '暂无数据'}
                  </strong>
                  <small>{accountValueChartSummary.lastPoint?.date || '等待日历史生成'}</small>
                </div>
                <div className="trend-summary-item">
                  <span>{accountValueRange} change</span>
                  <strong
                    className={
                      accountValueChartSummary.changeAmount == null
                        ? ''
                        : accountValueChartSummary.changeAmount >= 0
                          ? 'value-positive'
                          : 'value-negative'
                    }
                  >
                    {formatSignedCurrency(accountValueChartSummary.changeAmount)}
                  </strong>
                  <small>{formatSignedPercent(accountValueChartSummary.changePct)}</small>
                </div>
                <div className="trend-summary-item">
                  <span>Points</span>
                  <strong>{accountValueChartData.length}</strong>
                  <small>{accountValueChartData.length > 1 ? '按日资产快照' : '需要更多历史点位'}</small>
                </div>
              </div>
              {accountValueChartData.length > 0 ? (
                <div className="account-value-chart-shell">
                  <ResponsiveContainer width="100%" height={290}>
                    <AreaChart data={accountValueChartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                      <defs>
                        <linearGradient id="accountValueFill" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="#0f766e" stopOpacity={0.34} />
                          <stop offset="55%" stopColor="#1d8f84" stopOpacity={0.16} />
                          <stop offset="100%" stopColor="#d7f3ee" stopOpacity={0.02} />
                        </linearGradient>
                      </defs>
                      <CartesianGrid stroke="rgba(148, 163, 184, 0.18)" vertical={false} />
                      <XAxis
                        dataKey="shortDate"
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#6b7b8c', fontSize: 12 }}
                        minTickGap={28}
                      />
                      <YAxis
                        axisLine={false}
                        tickLine={false}
                        tick={{ fill: '#6b7b8c', fontSize: 12 }}
                        width={76}
                        domain={accountValueChartDomain ?? ['auto', 'auto']}
                        tickFormatter={renderAccountValueAxisTick}
                      />
                      <Tooltip content={<AccountValueTooltip />} cursor={{ stroke: 'rgba(15, 118, 110, 0.16)', strokeWidth: 1 }} />
                      <Area
                        type="monotone"
                        dataKey="totalCapital"
                        stroke="#0f5f73"
                        strokeWidth={3}
                        fill="url(#accountValueFill)"
                        dot={false}
                        activeDot={{ r: 5, strokeWidth: 2, stroke: '#ffffff', fill: '#0f766e' }}
                      />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="dashboard-empty-state account-value-empty-state">
                  <strong>还没有足够的资产历史</strong>
                  <span>等今天的组合快照写入后，这里会开始显示每天的净资产变化。</span>
                </div>
              )}
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
              <div className="account-value-chart-shell risk-curve-chart-shell">
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={riskCurvePoints} margin={{ top: 8, right: 14, left: 6, bottom: 8 }}>
                    <defs>
                      <linearGradient id="riskCurveFillRecharts" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#2563eb" stopOpacity={0.24} />
                        <stop offset="58%" stopColor="#60a5fa" stopOpacity={0.12} />
                        <stop offset="100%" stopColor="#dbeafe" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="rgba(148, 163, 184, 0.18)" vertical={false} />
                    <XAxis
                      dataKey="scenarioPct"
                      type="number"
                      domain={[-0.3, 0.3]}
                      ticks={[-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3]}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fill: '#6b7b8c', fontSize: 12 }}
                      tickFormatter={(value) => formatSignedPercent(value)}
                      label={{ value: '涨跌幅情景（横轴）', position: 'insideBottom', offset: -2, fill: '#6b7b8c', fontSize: 12 }}
                    />
                    <YAxis
                      type="number"
                      domain={[Math.floor(riskCurveMinCapital), Math.ceil(riskCurveMaxCapital)]}
                      axisLine={false}
                      tickLine={false}
                      width={76}
                      tick={{ fill: '#6b7b8c', fontSize: 12 }}
                      tickFormatter={renderAccountValueAxisTick}
                    />
                    <Tooltip content={<RiskCurveTooltip />} cursor={{ stroke: 'rgba(37, 99, 235, 0.16)', strokeWidth: 1 }} />
                    <ReferenceLine
                      y={riskCalculator.capitalBase}
                      stroke="rgba(100, 116, 139, 0.55)"
                      strokeDasharray="5 5"
                    />
                    <ReferenceLine
                      x={currentRiskCurvePoint.scenarioPct}
                      stroke="rgba(214, 163, 0, 0.82)"
                      strokeDasharray="5 5"
                    />
                    <ReferenceDot
                      x={currentRiskCurvePoint.scenarioPct}
                      y={currentRiskCurvePoint.capital}
                      r={5}
                      fill="#d6a300"
                      stroke="#ffffff"
                      strokeWidth={2}
                    />
                    <Area
                      type="monotone"
                      dataKey="capital"
                      stroke="#2563eb"
                      strokeWidth={3}
                      fill="url(#riskCurveFillRecharts)"
                      dot={false}
                      activeDot={{ r: 5, strokeWidth: 2, stroke: '#ffffff', fill: '#2563eb' }}
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
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
                    <div key={`iv-rank-${item.ticker}`} className="ticker-risk-item top-iv-rank-item">
                      <div className="ticker-risk-main">
                        <span>{`${index + 1}. ${item.ticker}`}</span>
                        <small>
                          {`财报日 ${item.earningsDate ?? '未确认'}`}
                          {item.currentIv == null ? '' : ` · Current IV ${(item.currentIv * 100).toFixed(1)}%`}
                        </small>
                      </div>
                      <div className="ticker-risk-main top-iv-rank-meta">
                        <span className={`pill-badge ${getIvRankTone(item.ivRank)}`}>{`IV Rank ${item.ivRank.toFixed(1)}`}</span>
                        {item.totalCapitalUsage > 0 ? (
                          <div className="top-iv-rank-usage">
                            <span><strong>股票</strong>{formatCurrency(item.marketValue)}</span>
                            <span><strong>期权占用</strong>{formatCurrency(item.optionCapitalUsage)}</span>
                            <span><strong>占总资金</strong>{item.capitalUsagePct == null ? '-' : formatPercent(item.capitalUsagePct)}</span>
                          </div>
                        ) : (
                          <small>未录入持仓金额</small>
                        )}
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
                          {' · '}
                          剩余年化收益 {formatPercent(row.annualizedYield)}
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
              <span>Current cash balance</span>
              <strong>{formatCurrency(config?.cash ?? 0)}</strong>
            </article>
            <article className="summary-card">
              <span>Account equity</span>
              <strong>{formatCurrency(accountEquity)}</strong>
            </article>
            <article className="summary-card">
              <span>Unrealized option P/L</span>
              <strong className={totalUnrealizedOptionPnl > 0 ? 'value-positive' : totalUnrealizedOptionPnl < 0 ? 'value-negative' : ''}>
                {formatSignedCurrency(totalUnrealizedOptionPnl)}
              </strong>
            </article>
            <article className="summary-card">
              <span>Total capital base</span>
              <strong>{formatCurrency(metrics.totalCapitalBase)}</strong>
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
            <article className="summary-card">
              <span>Total nominal put exposure</span>
              <strong>{formatCurrency(metrics.totalNominalPutExposure)}</strong>
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

        {activeTab === 'risk_first' && (
        <section className="card risk-first-system">
          <div className="section-header">
            <div>
              <p className="section-kicker">止损价计算</p>
              <h2>Stop Loss</h2>
            </div>
          </div>
          {copyMessage && <div className="copy-message">{copyMessage}</div>}
          <div className="section-subhead">
            <h3>现有股票持仓检查</h3>
          </div>
          {currentStockRiskFirstDecisions.length === 0 ? (
            <div className="empty-state compact-empty">当前没有股票持仓可分析。</div>
          ) : (
            <div className="risk-first-holdings">
              {currentStockRiskFirstDecisions.map((item) => {
                const isTriggered = 
                  (item.onePercentStopPrice != null && item.currentPrice != null && item.currentPrice <= item.onePercentStopPrice) ||
                  (item.atrStopPrice != null && item.currentPrice != null && item.currentPrice <= item.atrStopPrice);
                const isApproached =
                  !isTriggered &&
                  ((item.onePercentStopPrice != null && item.currentPrice != null && item.currentPrice <= item.onePercentStopPrice * 1.02) ||
                  (item.atrStopPrice != null && item.currentPrice != null && item.currentPrice <= item.atrStopPrice * 1.02));
                  
                let cardClass = '';
                let badgeText = 'SAFE';
                let badgeColor = 'green';
                let customStyle = {};

                if (isTriggered) {
                  cardClass = 'risk-first-block';
                  badgeText = 'STOP';
                  badgeColor = 'red';
                } else if (isApproached) {
                  badgeText = 'WARN';
                  badgeColor = 'yellow';
                  customStyle = { borderColor: 'rgba(245, 158, 11, 0.4)', backgroundColor: 'rgba(245, 158, 11, 0.05)' };
                } else {
                  cardClass = 'risk-first-pass';
                }

                return (
                  <article
                    key={`risk-first-${item.ticker}`}
                    className={`risk-first-decision-card ${cardClass}`}
                    style={customStyle}
                  >
                    <div className="risk-first-decision-head">
                      <div>
                        <strong>{item.ticker}</strong>
                        <small>
                          {item.shares} 股 · 仓位 {formatPercent(item.positionPct)}
                          {item.unrealizedPnlPct === null ? '' : ` · 当前盈亏 ${formatSignedPercent(item.unrealizedPnlPct)}`}
                          {item.currentPrice != null ? ` · 现价 $${item.currentPrice.toFixed(2)}` : ''}
                        </small>
                      </div>
                      <span className={`pill-badge ${badgeColor}`}>
                        {badgeText}
                      </span>
                    </div>

                  {/* ── Risk Metrics Row ── */}
                  <div className="rf-risk-metrics-grid">
                    {/* 1% Risk Stop */}
                    <div className="rf-risk-metric rf-risk-metric--primary">
                      <div className="rf-risk-metric-label">
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.5"/>
                          <path d="M6 4v3M6 8.5v.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                        </svg>
                        1% 风险止损价
                      </div>
                      <div className="rf-risk-metric-value" style={{ color: getStopLossColor(item.currentPrice, item.onePercentStopPrice) }}>
                        {item.onePercentStopPrice != null
                          ? `$${item.onePercentStopPrice.toFixed(2)}`
                          : '–'}
                      </div>
                      {item.onePercentStopPrice != null && item.averageCostBasis != null && (
                        <div className="rf-risk-metric-sub">
                          {`较成本 $${item.averageCostBasis.toFixed(2)} 跌 ${(((item.averageCostBasis - item.onePercentStopPrice) / item.averageCostBasis) * 100).toFixed(1)}%`}
                          {' · 亏损 ≤ 账户 1%'}
                        </div>
                      )}
                    </div>

                    {/* ATR Stop */}
                    <div className="rf-risk-metric rf-risk-metric--atr">
                      <div className="rf-risk-metric-label">
                        <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                          <path d="M1 9 L3 5 L5 7 L7 3 L9 6 L11 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                        ATR(14) 止损价
                      </div>
                      <div className="rf-risk-metric-value" style={{ color: getStopLossColor(item.currentPrice, item.atrStopPrice) }}>
                        {item.atrStopPrice != null
                          ? `$${item.atrStopPrice.toFixed(2)}`
                          : item.atr14 == null ? '待刷新数据' : '–'}
                      </div>
                      {item.atr14 != null && (
                        <div className="rf-risk-metric-sub">
                          {`ATR = $${item.atr14.toFixed(2)}`}
                          {item.atrBasisPrice != null ? ` · 基于${item.atrBasisLabel} $${item.atrBasisPrice.toFixed(2)}` : ''}
                          {item.atrStopPrice != null && item.currentPrice != null
                            ? ` · 跌 ${(((item.currentPrice - item.atrStopPrice) / item.currentPrice) * 100).toFixed(1)}%`
                            : ''}
                        </div>
                      )}
                    </div>
                  </div>
                </article>
              )})}
            </div>
          )}
        </section>
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
            <button className="primary-button" onClick={handleSavePut} type="button" disabled={isSavingPut}>
              {isSavingPut ? 'Saving...' : editingPutId ? 'Update option' : '卖出'}
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
              <span>Sort by</span>
              <select
                className="ticker-filter-select"
                value={positionSort}
                onChange={(event) => setPositionSort(event.target.value as PositionSortField)}
              >
                <option value="DEFAULT">Ticker / expiration</option>
                <option value="EXPIRATION">Expiration date</option>
                <option value="PUT_RISK">Risk</option>
                <option value="LOSS_PCT">Loss %</option>
                <option value="ANNUALIZED_YIELD">Annualized yield</option>
              </select>
            </label>
            <label className="filter-chip">
              <span>Direction</span>
              <select
                className="ticker-filter-select"
                value={positionSortDirection}
                onChange={(event) => setPositionSortDirection(event.target.value as PositionSortDirection)}
              >
                <option value="ASC">Ascending / Low to high</option>
                <option value="DESC">Descending / High to low</option>
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
                    const displayedOptionDelta = optionPriceOverride?.delta ?? row.optionDelta ?? null;
                    const displayedOptionGamma = optionPriceOverride?.gamma ?? row.optionGamma ?? null;
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
                    const displayedGammaThetaRatio =
                      typeof displayedOptionGamma === 'number' &&
                      typeof displayedOptionTheta === 'number' &&
                      Math.abs(displayedOptionTheta) > 0.000001
                        ? Math.abs(displayedOptionGamma / displayedOptionTheta)
                        : row.gammaThetaRatio ?? null;
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
                        disabled={isRefreshingAllOptions || refreshingOptionPriceId !== null}
                      >
                        {refreshingOptionPriceId === row.id
                          ? 'Refreshing option...'
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

                  <div className="position-highlights">
                    <div className="position-highlight">
                      <span>Delta</span>
                      <strong>{displayedOptionDelta == null ? '-' : displayedOptionDelta.toFixed(3)}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Gamma</span>
                      <strong>{displayedOptionGamma == null ? '-' : displayedOptionGamma.toFixed(4)}</strong>
                    </div>
                    <div className="position-highlight">
                      <span>Gamma / Theta 比例</span>
                      <strong className={displayedGammaThetaRatio != null && displayedGammaThetaRatio >= 12 ? 'value-negative' : ''}>
                        {displayedGammaThetaRatio == null ? '-' : displayedGammaThetaRatio.toFixed(2)}
                      </strong>
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
                          <small>
                            盈利百分比 {formatPercent(getHistoryProfitPct(item.trade))}
                            {' · '}
                            持有时间 {getHistoryHoldingDays(item.trade.date_sold, item.trade.closed_at)} 天
                            {' · '}
                            年化收益 {formatPercent(getHistoryAnnualizedYield(item.trade))}
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
                        <button type="button" className="ghost-button" onClick={() => void handleDeleteClosedTrade(item.trade)}>
                          Delete
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
                        <button type="button" className="ghost-button" onClick={() => void handleDeleteStockTrade(item.trade)}>
                          Delete
                        </button>
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
              {closePreviewError !== '' && <div className="copy-message">{closePreviewError}</div>}
              <div className="modal-actions">
                <button
                  className="ghost-button"
                  onClick={() => {
                    setClosePreview(null);
                    setClosePreviewError('');
                  }}
                  type="button"
                  disabled={isClosingPosition}
                >
                  Cancel
                </button>
                <button className="primary-button" onClick={confirmClosePut} type="button" disabled={isClosingPosition}>
                  {isClosingPosition ? 'Saving...' : 'Confirm Close'}
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
              className="modal-card modal-wide"
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
              className="modal-card modal-wide"
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
                <label>
                  <span>交易类型</span>
                  <select
                    value={buyStockPreview.tradeType}
                    onChange={(event) =>
                      setBuyStockPreview((current) =>
                        current ? { ...current, tradeType: event.target.value as StockTradeType } : current
                      )
                    }
                  >
                    <option value="短线">短线</option>
                    <option value="中线">中线</option>
                    <option value="长线">长线</option>
                  </select>
                </label>
                <label>
                  <span>预期上涨空间 %</span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={buyStockPreview.expectedUpsidePct}
                    onChange={(event) =>
                      setBuyStockPreview((current) =>
                        current ? { ...current, expectedUpsidePct: event.target.value } : current
                      )
                    }
                    placeholder="例如 25"
                  />
                </label>
                <label>
                  <span>最大可承受亏损 / 止损 %</span>
                  <input
                    type="number"
                    min="0"
                    step="0.1"
                    value={buyStockPreview.maxLossPct}
                    onChange={(event) =>
                      setBuyStockPreview((current) =>
                        current ? { ...current, maxLossPct: event.target.value } : current
                      )
                    }
                    placeholder="例如 10"
                  />
                </label>
              </div>

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
              {!isEditingConfig ? (
                <button className="primary-button" onClick={handleStartConfigEdit} type="button">
                  Edit
                </button>
              ) : (
                <span className="config-edit-pill">编辑中</span>
              )}
            </div>
          </div>
          {importExportMessage && <div className="copy-message">{importExportMessage}</div>}

          <div className="form-grid">
            <label>
              <span>当前现金余额</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={configForm.cash}
                disabled={!isEditingConfig}
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
                disabled={!isEditingConfig}
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
                disabled={!isEditingConfig}
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
          {isEditingConfig && (
            <div className="config-edit-actions">
              <div className="copy-message">编辑完成后，点击 Save 保存到 NAS / Docker 后端文件。</div>
              <div className="inline-actions">
                <button className="ghost-button" onClick={handleCancelConfigEdit} type="button">
                  Cancel
                </button>
                <button className="primary-button" onClick={() => void handleSaveConfig()} type="button">
                  Save
                </button>
              </div>
            </div>
          )}
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

        {/* ── Section 2: Position Size Calculator (1% Risk Model) ── */}
        {activeTab === 'calculator' && (
        <section className="card pos-size-card">
          <div className="section-header">
            <div>
              <p className="section-kicker">Section 2</p>
              <h2>动态仓位计算器 <span className="section-kicker-badge">1% 风险模型</span></h2>
            </div>
          </div>
          <div className="copy-message">
            单笔交易最大亏损不超过账户总资金的 <strong>1%</strong>。根据止损距离动态决定仓位大小：止损越近仓位越大，止损越远仓位越小。
          </div>
          <div className="form-grid compact pos-size-grid">
            <label>
              <span>账户总资金 (Account Equity)</span>
              <div className="input-with-prefix">
                <span className="input-prefix">$</span>
                <input
                  id="pos-size-equity"
                  type="number"
                  min="0"
                  step="1000"
                  placeholder="例如 100000"
                  value={posSizeAccountEquity}
                  onChange={(e) => setPosSizeAccountEquity(e.target.value)}
                />
              </div>
            </label>
            <label>
              <span>入场价格 (Entry Price)</span>
              <div className="input-with-prefix">
                <span className="input-prefix">$</span>
                <input
                  id="pos-size-entry"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="例如 150.00"
                  value={posSizeEntryPrice}
                  onChange={(e) => setPosSizeEntryPrice(e.target.value)}
                />
              </div>
            </label>
            <label>
              <span>初始止损价 (Initial Stop Price)</span>
              <div className="input-with-prefix">
                <span className="input-prefix">$</span>
                <input
                  id="pos-size-stop"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="例如 142.00"
                  value={posSizeStopPrice}
                  onChange={(e) => setPosSizeStopPrice(e.target.value)}
                />
              </div>
            </label>
          </div>

          {posSizeResult == null ? (
            <div className="pos-size-placeholder">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M9 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-3"/>
                <path d="M9 15h3l8.5-8.5a2.121 2.121 0 0 0-3-3L9 12v3"/>
                <line x1="16" y1="5" x2="19" y2="8"/>
              </svg>
              <span>请输入账户总资金、入场价格和止损价格</span>
            </div>
          ) : (
            <>
              <div className="pos-size-formula-banner">
                <span className="pos-size-formula-text">
                  PositionSize = AccountEquity × 1% ÷ |EntryPrice − StopPrice|
                </span>
                <span className="pos-size-formula-values">
                  = {formatCurrency(posSizeResult.dollarRisk)} ÷ {formatCurrency(posSizeResult.riskPerShare)} = <strong>{posSizeResult.positionSize} 股</strong>
                </span>
              </div>
              <div className="summary-grid pos-size-result-grid">
                <article className="summary-card emphasized pos-size-highlight">
                  <span>建议仓位 (Position Size)</span>
                  <strong className="pos-size-big-number">{posSizeResult.positionSize.toLocaleString()} <em>股</em></strong>
                  <small className="summary-card-footnote">市值约 {formatCurrency(posSizeResult.positionSize * posSizeResult.entryPrice)}</small>
                </article>
                <article className="summary-card">
                  <span>入场价 (Entry Price)</span>
                  <strong>{formatCurrency(posSizeResult.entryPrice)}</strong>
                </article>
                <article className="summary-card">
                  <span>止损价 (Stop Price)</span>
                  <strong>{formatCurrency(posSizeResult.stopPrice)}</strong>
                </article>
                <article className="summary-card">
                  <span>每股风险 (Risk Per Share)</span>
                  <strong>{formatCurrency(posSizeResult.riskPerShare)}</strong>
                </article>
                <article className="summary-card pos-size-dollar-risk">
                  <span>最大风险金额 (Dollar Risk)</span>
                  <strong className="value-negative">{formatCurrency(posSizeResult.dollarRisk)}</strong>
                  <small className="summary-card-footnote">= 账户 × 1%</small>
                </article>
              </div>
              <div className="pos-size-tip">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                止损越远 → 每股风险越大 → 仓位越小；止损越近 → 每股风险越小 → 仓位越大。
              </div>
            </>
          )}
        </section>
        )}

        {/* ── Section 3: ATR Structural Stop System ── */}
        {activeTab === 'calculator' && (
        <section className="card atr-stop-card">
          <div className="section-header">
            <div>
              <p className="section-kicker">Section 3</p>
              <h2>ATR 结构止损系统 <span className="section-kicker-badge">支撑位 + 波动率缓冲</span></h2>
            </div>
          </div>
          <div className="copy-message">
            基于支撑位和 ATR 波动率设置智能止损，避免被正常市场波动洗出，同时保留足够的趋势空间。
            公式：<strong>Stop = SupportLevel − ATR × Multiplier</strong>
          </div>

          <div className="form-grid compact atr-stop-grid">
            <label>
              <span>支撑位价格 (Support Level)</span>
              <div className="input-with-prefix">
                <span className="input-prefix">$</span>
                <input
                  id="atr-support"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="例如 148.00"
                  value={atrSupportLevel}
                  onChange={(e) => setAtrSupportLevel(e.target.value)}
                />
              </div>
            </label>
            <label>
              <span>ATR 值 (Average True Range)</span>
              <div className="input-with-prefix">
                <span className="input-prefix">$</span>
                <input
                  id="atr-value"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="例如 3.50"
                  value={atrValue}
                  onChange={(e) => setAtrValue(e.target.value)}
                />
              </div>
            </label>
            <label>
              <span>ATR 倍数 (Multiplier)</span>
              <select
                id="atr-multiplier"
                value={atrMultiplier}
                onChange={(e) => setAtrMultiplier(e.target.value)}
              >
                <option value="0.5">0.5× ATR（止损更近）</option>
                <option value="1.0">1.0× ATR（默认）</option>
                <option value="1.5">1.5× ATR（中等空间）</option>
                <option value="2.0">2.0× ATR（止损更远）</option>
              </select>
            </label>
          </div>

          {atrStopResult == null ? (
            <div className="pos-size-placeholder">
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
              </svg>
              <span>请输入支撑位价格和 ATR 值</span>
            </div>
          ) : (
            <>
              {atrStopResult.activeStop != null && (
                <div className="atr-active-stop-banner">
                  <div className="atr-active-stop-label">当前止损价</div>
                  <div className="atr-active-stop-value">{formatCurrency(atrStopResult.activeStop)}</div>
                  <div className="atr-active-stop-meta">
                    支撑位 {formatCurrency(atrStopResult.support)} − {atrMultiplier}× ATR ({formatCurrency(atrStopResult.atr)}) = {formatCurrency(atrStopResult.activeStop)}
                  </div>
                </div>
              )}

              <div className="atr-scenarios-header">
                <span>参数化对比测试</span>
                <small>不同 ATR 倍数下的止损位置</small>
              </div>
              <div className="atr-scenarios-grid">
                {atrStopResult.scenarios.map((s) => {
                  const isActive = String(s.multiplier) === atrMultiplier;
                  return (
                    <article
                      key={s.multiplier}
                      className={`atr-scenario-card${isActive ? ' atr-scenario-active' : ''}`}
                      onClick={() => setAtrMultiplier(String(s.multiplier))}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setAtrMultiplier(String(s.multiplier)); }}
                    >
                      <div className="atr-scenario-top">
                        <span className="atr-scenario-mult">{s.multiplier}× ATR</span>
                        {isActive && <span className="atr-scenario-badge">当前</span>}
                      </div>
                      <strong className="atr-scenario-stop">{formatCurrency(s.stopLevel)}</strong>
                      <div className="atr-scenario-meta">
                        <span>缓冲区</span>
                        <em>{formatCurrency(s.buffer)}</em>
                      </div>
                      <div className="atr-scenario-bar-wrap">
                        <div
                          className="atr-scenario-bar"
                          style={{ width: `${Math.min((s.multiplier / 2) * 100, 100)}%` }}
                        />
                      </div>
                      <small className="atr-scenario-note">
                        {s.multiplier <= 0.5 ? '⚠️ 易被波动洗出' : s.multiplier >= 2 ? '✅ 趋势空间充足' : '✅ 较为合理'}
                      </small>
                    </article>
                  );
                })}
              </div>
            </>
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
              <span>Buy RSI Alert</span>
              <input
                type="number"
                step="1"
                min="1"
                max="100"
                value={newTickerBuyRsiAlert}
                onChange={(event) => setNewTickerBuyRsiAlert(event.target.value)}
                placeholder="例如 35"
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
          <div className="copy-message">
            <div style={{ marginBottom: '4px' }}>
              <strong>最后刷新时间：</strong>
              {(() => {
                const timestamps = tickerList.map(getTickerLastUpdated).filter((t): t is string => typeof t === 'string');
                const latest = timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : null;
                return latest ? new Date(latest).toLocaleString() : '尚未刷新';
              })()}
            </div>
            {refreshAllProgress ? (
              <div style={{ color: 'var(--text-secondary)' }}>
                <strong>刷新进度：</strong> 正在刷新第 {refreshAllProgress.current}/{refreshAllProgress.total} 个股票
                {refreshAllProgress.ticker ? `（${refreshAllProgress.ticker}）` : ''}
                。已成功 {refreshAllProgress.successCount}，失败 {refreshAllProgress.failureCount}
              </div>
            ) : priceRefreshMessage ? (
              <div style={{ color: 'var(--text-secondary)' }}>
                <strong>刷新明细：</strong> {priceRefreshMessage}
              </div>
            ) : (
              <div style={{ color: 'var(--text-muted)' }}>
                手动全量刷新会慢速逐只进行。可以点击单只股票右侧的 Refresh 单独刷新。
              </div>
            )}
          </div>
          {metrics.missingStockBetaTickers.length > 0 && (
            <div className="copy-message">
              Beta 忘记输入了：{metrics.missingStockBetaTickers.join('、')}。当前股票风险先按 Beta 1.00 估算。
            </div>
          )}
          {tickerMessage && <div className="copy-message">{tickerMessage}</div>}
          {tickerList.length === 0 ? (
            <div className="empty-state">当前还没有股票列表。先加几个 ticker，后面新增 Put 时可以直接下拉选择。</div>
          ) : (
            <div className="ticker-list-grid">
              {[...tickerList]
                .sort((a, b) => {
                  const aAlert = typeof a.buy_rsi_alert === 'number' ? a.buy_rsi_alert : null;
                  const bAlert = typeof b.buy_rsi_alert === 'number' ? b.buy_rsi_alert : null;
                  const aRsi = typeof a.rsi_14 === 'number' ? a.rsi_14 : null;
                  const bRsi = typeof b.rsi_14 === 'number' ? b.rsi_14 : null;
                  const aProximity = aAlert !== null && aRsi !== null ? aRsi - aAlert : null;
                  const bProximity = bAlert !== null && bRsi !== null ? bRsi - bAlert : null;
                  if (aProximity !== null && bProximity !== null) return aProximity - bProximity;
                  if (aProximity !== null) return -1;
                  if (bProximity !== null) return 1;
                  return a.ticker.localeCompare(b.ticker);
                })
                .map((entry) => {
                const isEditingTicker = editingTickers[entry.ticker] === true;
                const tickerDraft = tickerDrafts[entry.ticker] ?? createTickerEditDraft(entry);
                const averageCost = entry.average_cost_basis;
                const currentPrice = entry.current_price;
                const shares = entry.shares;
                const atr14 = typeof entry.atr_14 === 'number' && Number.isFinite(entry.atr_14) ? entry.atr_14 : null;
                const hasStockHolding = typeof shares === 'number' && shares > 0;
                const atrBasisPrice =
                  hasStockHolding && typeof averageCost === 'number' && Number.isFinite(averageCost) && averageCost > 0
                    ? averageCost
                    : typeof currentPrice === 'number' && Number.isFinite(currentPrice)
                      ? currentPrice
                      : null;
                const atrBasisLabel =
                  hasStockHolding && typeof averageCost === 'number' && Number.isFinite(averageCost) && averageCost > 0
                    ? '平均价'
                    : '现价';
                const atrStopPrice = atr14 !== null && atrBasisPrice !== null ? atrBasisPrice - atr14 : null;
                const rewardRiskStopPrice =
                  atr14 !== null && typeof currentPrice === 'number' && Number.isFinite(currentPrice)
                    ? currentPrice - atr14
                    : null;
                const targetTrimPrice =
                  typeof entry.target_trim_price === 'number' && Number.isFinite(entry.target_trim_price)
                    ? entry.target_trim_price
                    : null;
                const rewardRiskRatio = calculateRewardRiskRatio({
                  entryPrice: currentPrice,
                  stopPrice: rewardRiskStopPrice,
                  targetPrice: targetTrimPrice
                });
                const rewardRiskAssessment = assessRewardRiskRatio(rewardRiskRatio);

                const rsi14 = typeof entry.rsi_14 === 'number' ? entry.rsi_14 : null;
                const buyRsiAlert = typeof entry.buy_rsi_alert === 'number' ? entry.buy_rsi_alert : null;
                const rsiAlertState: 'triggered' | 'near' | 'approaching' | 'normal' | null =
                  buyRsiAlert !== null && rsi14 !== null
                    ? rsi14 <= buyRsiAlert
                      ? 'triggered'
                      : rsi14 <= buyRsiAlert + 5
                        ? 'near'
                        : rsi14 <= buyRsiAlert + 10
                          ? 'approaching'
                          : 'normal'
                    : null;

                const unrealizedPnlAmount =
                  typeof averageCost === 'number' && typeof currentPrice === 'number' && typeof shares === 'number'
                    ? (currentPrice - averageCost) * shares
                    : null;
                const unrealizedPnlPct =
                  typeof averageCost === 'number' && averageCost > 0 && typeof currentPrice === 'number'
                    ? (currentPrice - averageCost) / averageCost
                    : null;
                const displayedTickerUpdatedAt = getTickerLastUpdated(entry);

                return (
                <div
                  key={entry.ticker}
                  className={['ticker-list-row', rsiAlertState === 'triggered' ? 'rsi-alert-triggered' : rsiAlertState === 'near' ? 'rsi-alert-near' : rsiAlertState === 'approaching' ? 'rsi-alert-approaching' : ''].filter(Boolean).join(' ')}
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
                  <button
                    className={`ghost-button ticker-refresh-button ticker-option-snapshot-toggle${entry.option_snapshot_enabled === true ? ' ticker-option-snapshot-toggle--on' : ''}`}
                    onClick={() => handleToggleOptionSnapshot(entry)}
                    type="button"
                    disabled={refreshingTicker !== null || isRefreshingAllTickers}
                    title={
                      entry.option_snapshot_enabled === true
                        ? `期权快照已启用（Delta 0.20 / 0.30 / 0.50）${entry.option_snapshot_updated ? `\n最近采集：${entry.option_snapshot_updated.slice(0, 16).replace('T', ' ')}` : ''}`
                        : '点击启用期权快照采集（DTE≈45，Delta 0.20 / 0.30 / 0.50）'
                    }
                  >
                    {entry.option_snapshot_enabled === true ? '📊 Option ON' : '📊 Option OFF'}
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
                    <span>减仓目标价</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={tickerDraft.targetTrimPrice}
                      onChange={(event) => handleChangeTickerDraft(entry.ticker, 'targetTrimPrice', event.target.value)}
                      disabled={!isEditingTicker}
                      placeholder="到价清仓"
                    />
                  </label>
                  <label className="beta-field buy-rsi-alert-field">
                    <span>Buy RSI Alert</span>
                    <div className="buy-rsi-alert-control">
                      <input
                        type="number"
                        step="1"
                        min="1"
                        max="100"
                        value={tickerDraft.buyRsiAlert}
                        onChange={(event) => handleChangeTickerDraft(entry.ticker, 'buyRsiAlert', event.target.value)}
                        disabled={!isEditingTicker}
                        placeholder="e.g. 35"
                      />
                      {!isEditingTicker && buyRsiAlert !== null && rsiAlertState !== null && (
                        <small className={`rsi-alert-badge rsi-alert-badge--${rsiAlertState}`}>
                          {rsiAlertState === 'triggered' && `🔔 RSI ${rsi14?.toFixed(1)} ≤ ${buyRsiAlert} — Buy alert!`}
                          {rsiAlertState === 'near' && `⚠️ RSI ${rsi14?.toFixed(1)} near ${buyRsiAlert}`}
                          {rsiAlertState === 'approaching' && `📉 RSI ${rsi14?.toFixed(1)} approaching ${buyRsiAlert}`}
                          {rsiAlertState === 'normal' && `RSI ${rsi14?.toFixed(1)} / alert ${buyRsiAlert}`}
                        </small>
                      )}
                    </div>
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
                    <span>ATR 止损价</span>
                    <strong className="field-value">
                      {atrStopPrice === null
                        ? '-'
                        : `${formatCurrency(atrStopPrice)} (${atrBasisLabel} ${formatCurrency(atrBasisPrice ?? 0)} - ATR ${formatCurrency(atr14 ?? 0)})`}
                    </strong>
                  </div>
                  <div className="beta-field">
                    <span>收益风险比</span>
                    <strong className={rewardRiskAssessment === null ? 'field-value' : `pill-badge ${rewardRiskAssessment.tone}`}>
                      {rewardRiskRatio === null ? '-' : `${rewardRiskRatio.toFixed(2)} : 1 · ${rewardRiskAssessment?.label}`}
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
                    <strong className="field-value">{displayedTickerUpdatedAt ? new Date(displayedTickerUpdatedAt).toLocaleString() : '-'}</strong>
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
