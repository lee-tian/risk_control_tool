import { describe, expect, it } from 'vitest';
import { buildAccountValueComparisons, upsertDailyAccountValueSnapshot } from './accountValueHistory';

describe('upsertDailyAccountValueSnapshot', () => {
  it('overwrites the same day with the latest total capital', () => {
    const history = upsertDailyAccountValueSnapshot(
      [{ date: '2026-04-02', total_capital: 100000, as_of: '2026-04-02T20:00:00.000Z' }],
      101500,
      new Date('2026-04-02T23:00:00.000Z')
    );

    expect(history).toEqual([
      { date: '2026-04-02', total_capital: 101500, as_of: '2026-04-02T23:00:00.000Z' }
    ]);
  });
});

describe('buildAccountValueComparisons', () => {
  it('computes vs yesterday, previous month, and YTD from daily snapshots', () => {
    const comparisons = buildAccountValueComparisons(
      [
        { date: '2025-12-31', total_capital: 90000, as_of: '2025-12-31T21:00:00.000Z' },
        { date: '2026-03-31', total_capital: 100000, as_of: '2026-03-31T21:00:00.000Z' },
        { date: '2026-04-02', total_capital: 110000, as_of: '2026-04-02T21:00:00.000Z' }
      ],
      112500,
      new Date('2026-04-03T18:00:00.000Z')
    );

    expect(comparisons[0]).toMatchObject({
      label: '对比昨天',
      changeAmount: 2500,
      changePct: 2500 / 110000
    });
    expect(comparisons[1]).toMatchObject({
      label: '对比上月',
      changeAmount: 12500,
      changePct: 12500 / 100000
    });
    expect(comparisons[2]).toMatchObject({
      label: 'YTD',
      changeAmount: 22500,
      changePct: 22500 / 90000
    });
  });
});
