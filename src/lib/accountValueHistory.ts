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

function findLatestBefore(history: AccountValueSnapshot[], beforeDate: string): AccountValueSnapshot | null {
  const candidates = history.filter((item) => item.date < beforeDate);
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
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

  const baselines = [
    {
      label: '对比昨天',
      baseline: findLatestBefore(history, today)
    },
    {
      label: '对比上月',
      baseline: findLatestBefore(history, currentMonthStart)
    },
    {
      label: 'YTD',
      baseline: findLatestBefore(history, currentYearStart)
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
