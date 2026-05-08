import type { AccountValueSnapshot } from '../types';

export type AccountValueRange = '7D' | '1M' | '3M' | 'YTD' | 'All';

export type AccountValueChartPoint = {
  date: string;
  shortDate: string;
  totalCapital: number;
  asOf: string;
  changeAmount: number | null;
  changePct: number | null;
};

export type AccountValueChartDomain = [number, number];

function shiftDate(dateInput: string, days: number): string {
  const [year, month, day] = dateInput.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function getStartDate(range: AccountValueRange, today: string): string | null {
  if (range === 'All') {
    return null;
  }
  if (range === 'YTD') {
    return `${today.slice(0, 4)}-01-01`;
  }
  if (range === '7D') {
    return shiftDate(today, -6);
  }
  if (range === '3M') {
    return shiftDate(today, -89);
  }
  return shiftDate(today, -29);
}

function formatShortDate(dateInput: string): string {
  const date = new Date(`${dateInput}T00:00:00`);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(date);
}

export function formatAccountValueChartData(history: AccountValueSnapshot[]): AccountValueChartPoint[] {
  const normalized = history
    .filter(
      (item) =>
        typeof item?.date === 'string' &&
        item.date !== '' &&
        typeof item?.as_of === 'string' &&
        item.as_of !== '' &&
        typeof item?.total_capital === 'number' &&
        Number.isFinite(item.total_capital)
    )
    .sort((left, right) => left.date.localeCompare(right.date) || left.as_of.localeCompare(right.as_of));

  return normalized.map((item, index) => {
    const previous = index > 0 ? normalized[index - 1] : null;
    const changeAmount = previous ? item.total_capital - previous.total_capital : null;
    const changePct =
      previous && previous.total_capital > 0 && changeAmount !== null ? changeAmount / previous.total_capital : null;

    return {
      date: item.date,
      shortDate: formatShortDate(item.date),
      totalCapital: item.total_capital,
      asOf: item.as_of,
      changeAmount,
      changePct
    };
  });
}

export function filterAccountValueChartData(
  history: AccountValueSnapshot[],
  range: AccountValueRange,
  now = new Date()
): AccountValueChartPoint[] {
  const chartData = formatAccountValueChartData(history);
  if (chartData.length === 0) {
    return [];
  }

  const today = now.toISOString().slice(0, 10);
  const startDate = getStartDate(range, today);
  if (!startDate) {
    return chartData;
  }

  const filtered = chartData.filter((point) => point.date >= startDate);
  return filtered.length > 0 ? filtered : chartData;
}

function roundDown(value: number, step: number): number {
  return Math.floor(value / step) * step;
}

function roundUp(value: number, step: number): number {
  return Math.ceil(value / step) * step;
}

export function getAccountValueChartDomain(points: AccountValueChartPoint[]): AccountValueChartDomain | null {
  if (!Array.isArray(points) || points.length === 0) {
    return null;
  }

  const values = points
    .map((point) => point.totalCapital)
    .filter((value) => Number.isFinite(value));
  if (values.length === 0) {
    return null;
  }

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const spread = Math.max(maxValue - minValue, maxValue * 0.01, 1);
  const padding = Math.max(spread * 0.2, maxValue * 0.01);

  const roughMin = Math.max(0, minValue - padding);
  const roughMax = maxValue + padding;
  const magnitude = Math.max(Math.abs(roughMax), Math.abs(roughMin), 1);
  const step = magnitude >= 1_000_000 ? 25_000 : magnitude >= 250_000 ? 10_000 : magnitude >= 100_000 ? 5_000 : 1_000;

  let domainMin = roundDown(roughMin, step);
  let domainMax = roundUp(roughMax, step);

  if (domainMin === domainMax) {
    domainMin = Math.max(0, domainMin - step);
    domainMax += step;
  }

  return [domainMin, domainMax];
}
