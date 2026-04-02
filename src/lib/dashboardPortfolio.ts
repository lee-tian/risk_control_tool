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

export type RiskCalculatorRow = {
  ticker: string;
  stockLoss: number;
  putLoss: number;
  callOffset: number;
  netLoss: number;
  netLossPctOfCapital: number | null;
  shockedPrice: number | null;
  currentPrice: number | null;
};

export type RiskCalculatorResult = {
  shockMultiplier: number;
  capitalBase: number;
  totalStockLoss: number;
  totalPutLoss: number;
  totalCallOffset: number;
  totalNetLoss: number;
  totalNetLossPctOfCapital: number | null;
  rows: RiskCalculatorRow[];
};

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

export function buildRiskCalculator(
  puts: PutPosition[],
  tickerList: TickerEntry[],
  dropPct: number,
  capitalBaseInput: number
): RiskCalculatorResult {
  const shockMultiplier = 1 - dropPct;
  const capitalBase = capitalBaseInput > 0 ? capitalBaseInput : 0;
  const tickerMap = new Map(tickerList.map((entry) => [entry.ticker, entry]));
  const rowsByTicker = new Map<string, RiskCalculatorRow>();

  const ensureRow = (ticker: string): RiskCalculatorRow => {
    const existing = rowsByTicker.get(ticker);
    if (existing) {
      return existing;
    }

    const tickerEntry = tickerMap.get(ticker);
    const nextRow: RiskCalculatorRow = {
      ticker,
      stockLoss: 0,
      putLoss: 0,
      callOffset: 0,
      netLoss: 0,
      netLossPctOfCapital: null,
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
    row.stockLoss += shares * currentPrice * dropPct;
  }

  for (const position of puts) {
    const row = ensureRow(position.ticker);
    const contractsShares = position.contracts * 100;
    const premiumIncome = position.premium_per_share * contractsShares;

    if (position.option_side === 'call') {
      row.callOffset += premiumIncome;
      continue;
    }

    const currentPrice = row.currentPrice;
    if (currentPrice === null || currentPrice <= 0) {
      continue;
    }

    const shockedPrice = currentPrice * shockMultiplier;
    const intrinsicLoss = Math.max(position.put_strike - shockedPrice, 0) * contractsShares;
    row.putLoss += Math.max(intrinsicLoss - premiumIncome, 0);
  }

  const rows = [...rowsByTicker.values()]
    .map((row) => {
      const netLoss = row.stockLoss + row.putLoss - row.callOffset;
      return {
        ...row,
        netLoss,
        netLossPctOfCapital: capitalBase > 0 ? netLoss / capitalBase : null
      };
    })
    .sort((a, b) => b.netLoss - a.netLoss || b.putLoss - a.putLoss || b.stockLoss - a.stockLoss || a.ticker.localeCompare(b.ticker));

  const totalStockLoss = rows.reduce((sum, row) => sum + row.stockLoss, 0);
  const totalPutLoss = rows.reduce((sum, row) => sum + row.putLoss, 0);
  const totalCallOffset = rows.reduce((sum, row) => sum + row.callOffset, 0);
  const totalNetLoss = rows.reduce((sum, row) => sum + row.netLoss, 0);

  return {
    shockMultiplier,
    capitalBase,
    totalStockLoss,
    totalPutLoss,
    totalCallOffset,
    totalNetLoss,
    totalNetLossPctOfCapital: capitalBase > 0 ? totalNetLoss / capitalBase : null,
    rows
  };
}
