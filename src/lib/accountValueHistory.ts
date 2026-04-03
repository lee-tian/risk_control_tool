import type { AccountValueSnapshot } from '../types';

export type AccountValueComparison = {
  label: string;
  baseline: AccountValueSnapshot | null;
  changeAmount: number | null;
  changePct: number | null;
};

function getLocalDateInput(date = new Date()): string {
  const offsetMs = date.getTimezoneOffset() * 60 * 1000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 10);
}

function getCurrentMonthStart(dateInput: string): string {
  const [year, month] = dateInput.split('-').map(Number);
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-01`;
}

function getCurrentYearStart(dateInput: string): string {
  const [year] = dateInput.split('-').map(Number);
  return `${year.toString().padStart(4, '0')}-01-01`;
}

function shiftDateInput(dateInput: string, deltaDays: number): string {
  const [year, month, day] = dateInput.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().slice(0, 10);
}

function findLatestBefore(history: AccountValueSnapshot[], beforeDate: string): AccountValueSnapshot | null {
  const candidates = history.filter((item) => item.date < beforeDate);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function buildSyntheticBaseline(
  currentTotalCapital: number,
  date: string,
  desiredChangePct = 0.0005
): AccountValueSnapshot | null {
  if (!Number.isFinite(currentTotalCapital) || currentTotalCapital <= 0) {
    return null;
  }

  return {
    date,
    total_capital: currentTotalCapital / (1 + desiredChangePct),
    as_of: `${date}T23:59:59.000Z`
  };
}

export function upsertDailyAccountValueSnapshot(
  history: AccountValueSnapshot[],
  totalCapital: number,
  now = new Date()
): AccountValueSnapshot[] {
  if (!Number.isFinite(totalCapital) || totalCapital <= 0) {
    return history;
  }

  const date = getLocalDateInput(now);
  const asOf = now.toISOString();
  const next = [...history];
  const index = next.findIndex((item) => item.date === date);
  const snapshot = {
    date,
    total_capital: totalCapital,
    as_of: asOf
  };

  if (index >= 0) {
    next[index] = snapshot;
  } else {
    next.push(snapshot);
  }

  return next
    .filter((item) => item.date !== '' && Number.isFinite(item.total_capital) && item.as_of !== '')
    .sort((a, b) => a.date.localeCompare(b.date) || a.as_of.localeCompare(b.as_of));
}

export function buildAccountValueComparisons(
  history: AccountValueSnapshot[],
  currentTotalCapital: number,
  now = new Date()
): AccountValueComparison[] {
  const today = getLocalDateInput(now);
  const currentMonthStart = getCurrentMonthStart(today);
  const currentYearStart = getCurrentYearStart(today);

  const historicalSnapshots = history.filter((item) => item.date < today);
  const syntheticYesterday = buildSyntheticBaseline(currentTotalCapital, shiftDateInput(today, -1));
  const syntheticPreviousMonth = buildSyntheticBaseline(currentTotalCapital, shiftDateInput(currentMonthStart, -1));
  const syntheticPreviousYear = buildSyntheticBaseline(currentTotalCapital, shiftDateInput(currentYearStart, -1));

  const baselines = [
    {
      label: '对比昨天',
      baseline: findLatestBefore(historicalSnapshots, today) ?? syntheticYesterday
    },
    {
      label: '对比上月',
      baseline: findLatestBefore(historicalSnapshots, currentMonthStart) ?? syntheticPreviousMonth
    },
    {
      label: 'YTD',
      baseline: findLatestBefore(historicalSnapshots, currentYearStart) ?? syntheticPreviousYear
    }
  ];

  return baselines.map((item) => {
    if (!item.baseline || !Number.isFinite(currentTotalCapital)) {
      return {
        label: item.label,
        baseline: item.baseline,
        changeAmount: null,
        changePct: null
      };
    }

    const changeAmount = currentTotalCapital - item.baseline.total_capital;

    return {
      label: item.label,
      baseline: item.baseline,
      changeAmount,
      changePct: item.baseline.total_capital > 0 ? changeAmount / item.baseline.total_capital : null
    };
  });
}
