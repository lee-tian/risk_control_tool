export type Config = {
  cash: number;
  risk_limit_pct: number;
  warning_threshold_pct: number;
};

export type PutPosition = {
  id: string;
  ticker: string;
  option_side?: 'put' | 'call';
  put_strike: number;
  premium_per_share: number;
  contracts: number;
  iv_rank: number;
  date_sold: string;
  expiration_date: string;
  option_market_price_per_share?: number | null;
  option_market_price_updated?: string | null;
  option_theta_per_share?: number | null;
  decision_rationale?: string;
  decision_snapshot?: {
    verdict: string;
    summary: string;
    rationale_check: string;
    worst_case: string;
    fundamental_note: string;
    fundamental_events: string[];
    current_iv_rank: string;
    iv_rank_note: string;
    iv_rank_source: string;
    iv_rank_time: string;
    iv_rank_link: string;
    action: string;
    key_risks: string[];
    max_profit: string;
    risk_at_10pct_drop: string;
    analyzed_at: string;
  } | null;
};

export type ClosedPutTrade = {
  id: string;
  position_id: string;
  ticker: string;
  option_side?: 'put' | 'call';
  put_strike: number;
  premium_sold_per_share: number;
  premium_bought_back_per_share: number;
  contracts: number;
  date_sold: string;
  expiration_date: string;
  closed_at: string;
  close_reason: 'manual' | 'expired';
  realized_pnl: number;
  reflection_notes?: string;
};

export type TickerEntry = {
  ticker: string;
  beta: number | null;
  shares: number | null;
  average_cost_basis: number | null;
  downside_tolerance_pct: number | null;
  current_price: number | null;
  last_updated: string | null;
  next_earnings_date?: string | null;
  current_iv: number | null;
  current_iv_updated: string | null;
  historical_iv?: number | null;
  iv_rank?: number | null;
  iv_percentile?: number | null;
  put_call_ratio: number | null;
  put_call_ratio_updated: string | null;
  provider_exchange: string | null;
  provider_mic_code: string | null;
  rsi_14: number | null;
  rsi_14_1h: number | null;
  rsi_updated: string | null;
  ma_21: number | null;
  ma_200: number | null;
};

export type RiskStatus = 'Safe' | 'Near Limit' | 'Exceeded';
export type PositioningStatus = 'Light' | 'Normal' | 'Heavy' | 'Overloaded';
export type ScoreLevel = 'green' | 'yellow' | 'red';

export type StressScenario = number;
export type StressMode = 'manual' | 'auto';

export type PutRiskRow = PutPosition & {
  distance_pct: number;
  beta: number;
  baseStressAfterDistancePct: number;
  effectiveStressPct: number;
  nominalExposure: number;
  premiumIncome: number;
  daysToExpiration: number;
  annualizedYield: number;
  breakevenPrice: number;
  netCostBasis: number;
  putRisk: number;
  riskPctOfCash: number;
  optionCloseCost: number | null;
  unrealizedPnl: number | null;
  premiumCapturedPct: number | null;
  optionThetaPerShare: number | null;
  thetaIncomePerDay: number | null;
};

export type RiskScorePoint = {
  timestamp: string;
  score: number;
  label: string;
};

export type VixHistoryPoint = {
  timestamp: string;
  value: number;
  stress: number;
};

export type PortfolioMetrics = {
  weightedAverageBeta: number;
  weightedAverageEffectiveStressPct: number;
  totalNominalPutExposure: number;
  totalPremiumIncome: number;
  totalCallPremiumIncome: number;
  totalCapitalBase: number;
  weightedAverageDaysToExpiration: number;
  portfolioAnnualizedYield: number;
  annualizedYieldOnTotalCash: number;
  estimatedThetaIncomePerDay: number;
  estimatedThetaIncomePerWeek: number;
  estimatedThetaIncomePerMonth: number;
  totalPutRisk: number;
  totalStockRisk: number;
  totalCoveredCallOffset: number;
  totalRisk: number;
  portfolioRiskPctOfCash: number;
  riskLimitAmount: number;
  remainingRiskBudget: number;
  riskStatus: RiskStatus;
  positioningStatus: PositioningStatus;
  riskUsagePct: number;
  riskScore: number;
  scoreLevel: ScoreLevel;
  putRows: PutRiskRow[];
  highestRiskTicker: string;
  groupedTickerRisk: Array<{ ticker: string; risk: number }>;
  canAddMoreRisk: boolean;
};

export type PutPositionsExportPayload = {
  version: 1;
  exported_at: string;
  data: {
    puts: PutPosition[];
  };
};

export type AppStateSnapshot = {
  version: 1;
  exported_at: string;
  data: {
    config: Config | null;
    puts: PutPosition[];
    closedTrades: ClosedPutTrade[];
    tickerList: TickerEntry[];
    scenario: StressScenario | null;
    vixHistory: VixHistoryPoint[];
  };
};
