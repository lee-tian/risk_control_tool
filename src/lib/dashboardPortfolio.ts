import type { PutPosition, PutRiskRow, TickerEntry } from '../types';

type ChartSegment = {
  ticker: string;
  exposure: number;
  color: string;
  share: number;
  dash: number;
  gap: number;
  offset: number;
};

export type CapitalAllocationChart = {
  totalExposure: number;
  segments: ChartSegment[];
  legendSegments: ChartSegment[];
};

export type TickerAllocationItem = {
  ticker: string;
  exposure: number;
  color: string;
  share: number;
};

export type TickerDeltaItem = {
  ticker: string;
  delta: number;
  exposure: number;
  color: string;
  share: number;
};

export type RiskCalculatorRow = {
  ticker: string;
  stockChange: number;
  putChange: number;
  callChange: number;
  netChange: number;
  netChangePctOfCapital: number | null;
  scenarioCapital: number | null;
  shockedPrice: number | null;
  currentPrice: number | null;
};

export type RiskCalculatorResult = {
  shockMultiplier: number;
  scenarioPct: number;
  capitalBase: number;
  totalStockChange: number;
  totalPutChange: number;
  totalCallChange: number;
  totalNetChange: number;
  totalNetChangePctOfCapital: number | null;
  scenarioCapital: number;
  rows: RiskCalculatorRow[];
};

export type RiskCurvePoint = {
  scenarioPct: number;
  capital: number;
  netChange: number;
};

export type HoldingDeltaSummary = {
  stockDelta: number;
  optionDelta: number;
  totalDelta: number;
};

export function buildRiskCurvePoints(
  puts: PutPosition[],
  tickerList: TickerEntry[],
  capitalBaseInput: number
): RiskCurvePoint[] {
  const scenarioPercents = Array.from({ length: 121 }, (_, index) => -0.3 + index * 0.005);

  return scenarioPercents.map((scenarioPct) => {
    const result = buildRiskCalculator(puts, tickerList, scenarioPct, capitalBaseInput);
    return {
      scenarioPct,
      capital: result.scenarioCapital,
      netChange: result.totalNetChange
    };
  });
}

export function buildHoldingDeltaSummary(
  stockShares: number,
  optionRows: Array<Pick<PutPosition, 'contracts' | 'option_delta'>>
): HoldingDeltaSummary {
  const stockDelta = stockShares;
  const optionDelta = optionRows.reduce((sum, row) => {
    if (typeof row.option_delta !== 'number') {
      return sum;
    }

    // Stored deltas are contract greeks for a long option. These positions are sold,
    // so the portfolio delta contribution is the inverse sign.
    return sum - row.option_delta * row.contracts * 100;
  }, 0);

  return {
    stockDelta,
    optionDelta,
    totalDelta: stockDelta + optionDelta
  };
}

const TICKER_ALLOCATION_PALETTE = ['#124e66', '#1f7a8c', '#d6a300', '#7c9a92', '#6f9aa8', '#c97a63'];

export function buildCapitalAllocationChart(
  totalStockMarketValue: number,
  totalNominalPutExposure: number,
  remainingCashAmount: number
): CapitalAllocationChart {
  const chartItems = [
    {
      ticker: '股票',
      exposure: totalStockMarketValue,
      color: '#124e66'
    },
    {
      ticker: '期权',
      exposure: totalNominalPutExposure,
      color: '#d6a300'
    },
    {
      ticker: '现金',
      exposure: remainingCashAmount,
      color: '#7c9a92'
    }
  ].filter((item) => item.exposure > 0);

  const totalExposure = chartItems.reduce((sum, item) => sum + item.exposure, 0);
  const radius = 54;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  const segments = chartItems.map((item) => {
    const share = totalExposure > 0 ? item.exposure / totalExposure : 0;
    const dash = share * circumference;
    const gap = circumference - dash;
    const offset = -cumulative * circumference;
    cumulative += share;

    return {
      ...item,
      share,
      dash,
      gap,
      offset
    };
  });

  return {
    totalExposure,
    segments,
    legendSegments: segments
  };
}

export function buildTickerAllocationItems(
  stockHoldings: Array<{ ticker: string; marketValue: number }>,
  putRows: Array<Pick<PutRiskRow, 'ticker' | 'nominalExposure' | 'option_side'>>
): TickerAllocationItem[] {
  const exposureMap = new Map<string, number>();

  for (const holding of stockHoldings) {
    if (holding.marketValue > 0) {
      exposureMap.set(holding.ticker, (exposureMap.get(holding.ticker) ?? 0) + holding.marketValue);
    }
  }

  for (const row of putRows) {
    if (row.option_side === 'call') {
      continue;
    }
    exposureMap.set(row.ticker, (exposureMap.get(row.ticker) ?? 0) + row.nominalExposure);
  }

  const sorted = [...exposureMap.entries()]
    .map(([ticker, exposure], index) => ({
      ticker,
      exposure,
      color: TICKER_ALLOCATION_PALETTE[index % TICKER_ALLOCATION_PALETTE.length]
    }))
    .sort((a, b) => b.exposure - a.exposure);

  const topFive = sorted.slice(0, 5);
  const totalExposure = sorted.reduce((sum, item) => sum + item.exposure, 0);
  const otherExposure = Math.max(totalExposure - topFive.reduce((sum, item) => sum + item.exposure, 0), 0);

  return [
    ...topFive.map((item) => ({
      ...item,
      share: totalExposure > 0 ? item.exposure / totalExposure : 0
    })),
    ...(otherExposure > 0
      ? [
          {
            ticker: 'Other positions',
            exposure: otherExposure,
            color: '#6f9aa8',
            share: totalExposure > 0 ? otherExposure / totalExposure : 0
          }
        ]
      : [])
  ];
}

export function buildTickerDeltaItems(
  holdings: Array<{ ticker: string; totalDelta: number }>
): TickerDeltaItem[] {
  const items = holdings
    .filter((holding) => Math.abs(holding.totalDelta) > 0.0001)
    .map((holding, index) => ({
      ticker: holding.ticker,
      delta: holding.totalDelta,
      exposure: Math.abs(holding.totalDelta),
      color: TICKER_ALLOCATION_PALETTE[index % TICKER_ALLOCATION_PALETTE.length]
    }))
    .sort((a, b) => b.exposure - a.exposure);

  const topFive = items.slice(0, 5);
  const totalExposure = items.reduce((sum, item) => sum + item.exposure, 0);
  const otherExposure = Math.max(totalExposure - topFive.reduce((sum, item) => sum + item.exposure, 0), 0);
  const otherDelta = items.slice(5).reduce((sum, item) => sum + item.delta, 0);

  return [
    ...topFive.map((item) => ({
      ...item,
      share: totalExposure > 0 ? item.exposure / totalExposure : 0
    })),
    ...(otherExposure > 0
      ? [
          {
            ticker: 'Other positions',
            delta: otherDelta,
            exposure: otherExposure,
            color: '#6f9aa8',
            share: totalExposure > 0 ? otherExposure / totalExposure : 0
          }
        ]
      : [])
  ];
}

export function buildRiskCalculator(
  puts: PutPosition[],
  tickerList: TickerEntry[],
  scenarioPct: number,
  capitalBaseInput: number
): RiskCalculatorResult {
  const shockMultiplier = 1 + scenarioPct;
  const capitalBase = capitalBaseInput > 0 ? capitalBaseInput : 0;
  const tickerMap = new Map(tickerList.map((entry) => [entry.ticker, entry]));
  const rowsByTicker = new Map<string, RiskCalculatorRow>();
  const callPositionsByTicker = new Map<string, PutPosition[]>();

  for (const position of puts) {
    if (position.option_side !== 'call') {
      continue;
    }

    const bucket = callPositionsByTicker.get(position.ticker) ?? [];
    bucket.push(position);
    callPositionsByTicker.set(position.ticker, bucket);
  }

  const ensureRow = (ticker: string): RiskCalculatorRow => {
    const existing = rowsByTicker.get(ticker);
    if (existing) {
      return existing;
    }

    const tickerEntry = tickerMap.get(ticker);
    const nextRow: RiskCalculatorRow = {
      ticker,
      stockChange: 0,
      putChange: 0,
      callChange: 0,
      netChange: 0,
      netChangePctOfCapital: null,
      scenarioCapital: null,
      currentPrice: tickerEntry?.current_price ?? null,
      shockedPrice:
        typeof tickerEntry?.current_price === 'number' && tickerEntry.current_price > 0
          ? tickerEntry.current_price * shockMultiplier
          : null
    };
    rowsByTicker.set(ticker, nextRow);
    return nextRow;
  };

  for (const entry of tickerList) {
    const shares = entry.shares ?? 0;
    const currentPrice = entry.current_price ?? 0;
    if (shares <= 0 || currentPrice <= 0) {
      continue;
    }

    const row = ensureRow(entry.ticker);
    const shockedPrice = currentPrice * shockMultiplier;
    const callRows = [...(callPositionsByTicker.get(entry.ticker) ?? [])].sort((a, b) => a.put_strike - b.put_strike);
    let remainingCoveredShares = shares;

    if (scenarioPct >= 0 && callRows.length > 0) {
      for (const callRow of callRows) {
        if (remainingCoveredShares <= 0) {
          break;
        }

        const coveredShares = Math.min(remainingCoveredShares, callRow.contracts * 100);
        const cappedScenarioPrice = Math.min(shockedPrice, callRow.put_strike);
        row.stockChange += coveredShares * (cappedScenarioPrice - currentPrice);
        remainingCoveredShares -= coveredShares;
      }
    }

    if (remainingCoveredShares > 0) {
      row.stockChange += remainingCoveredShares * (shockedPrice - currentPrice);
    }
  }

  for (const position of puts) {
    const row = ensureRow(position.ticker);
    const contractsShares = position.contracts * 100;
    const premiumIncome = position.premium_per_share * contractsShares;

    if (position.option_side === 'call') {
      row.callChange += premiumIncome;
      continue;
    }

    const currentPrice = row.currentPrice;
    if (currentPrice === null || currentPrice <= 0) {
      continue;
    }

    const shockedPrice = currentPrice * shockMultiplier;
    const intrinsicLoss = Math.max(position.put_strike - shockedPrice, 0) * contractsShares;
    row.putChange += premiumIncome - intrinsicLoss;
  }

  const rows = [...rowsByTicker.values()]
    .map((row) => {
      const netChange = row.stockChange + row.putChange + row.callChange;
      return {
        ...row,
        netChange,
        netChangePctOfCapital: capitalBase > 0 ? netChange / capitalBase : null,
        scenarioCapital: capitalBase > 0 ? capitalBase + netChange : null
      };
    })
    .sort((a, b) => a.netChange - b.netChange || a.putChange - b.putChange || a.stockChange - b.stockChange || a.ticker.localeCompare(b.ticker));

  const totalStockChange = rows.reduce((sum, row) => sum + row.stockChange, 0);
  const totalPutChange = rows.reduce((sum, row) => sum + row.putChange, 0);
  const totalCallChange = rows.reduce((sum, row) => sum + row.callChange, 0);
  const totalNetChange = rows.reduce((sum, row) => sum + row.netChange, 0);
  const scenarioCapital = capitalBase + totalNetChange;

  return {
    shockMultiplier,
    scenarioPct,
    capitalBase,
    totalStockChange,
    totalPutChange,
    totalCallChange,
    totalNetChange,
    totalNetChangePctOfCapital: capitalBase > 0 ? totalNetChange / capitalBase : null,
    scenarioCapital,
    rows
  };
}
