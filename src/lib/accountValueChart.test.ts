import { describe, expect, it } from 'vitest';

import { filterAccountValueChartData, formatAccountValueChartData, getAccountValueChartDomain } from './accountValueChart';

describe('formatAccountValueChartData', () => {
  it('sorts snapshots and computes daily changes', () => {
    const result = formatAccountValueChartData([
      { date: '2026-04-03', total_capital: 102500, as_of: '2026-04-03T21:00:00.000Z' },
      { date: '2026-04-01', total_capital: 100000, as_of: '2026-04-01T21:00:00.000Z' },
      { date: '2026-04-02', total_capital: 101000, as_of: '2026-04-02T21:00:00.000Z' }
    ]);

    expect(result.map((item) => item.date)).toEqual(['2026-04-01', '2026-04-02', '2026-04-03']);
    expect(result[0].changeAmount).toBeNull();
    expect(result[1].changeAmount).toBe(1000);
    expect(result[1].changePct).toBe(0.01);
    expect(result[2].changeAmount).toBe(1500);
  });
});

describe('filterAccountValueChartData', () => {
  it('filters to the selected range when matching points exist', () => {
    const history = [
      { date: '2026-01-10', total_capital: 95000, as_of: '2026-01-10T21:00:00.000Z' },
      { date: '2026-03-15', total_capital: 100000, as_of: '2026-03-15T21:00:00.000Z' },
      { date: '2026-04-01', total_capital: 101500, as_of: '2026-04-01T21:00:00.000Z' },
      { date: '2026-04-08', total_capital: 103200, as_of: '2026-04-08T21:00:00.000Z' }
    ];

    expect(filterAccountValueChartData(history, '1M', new Date('2026-04-08T18:00:00.000Z')).map((item) => item.date)).toEqual([
      '2026-03-15',
      '2026-04-01',
      '2026-04-08'
    ]);
    expect(filterAccountValueChartData(history, '7D', new Date('2026-04-08T18:00:00.000Z')).map((item) => item.date)).toEqual([
      '2026-04-08'
    ]);
    expect(filterAccountValueChartData(history, 'YTD', new Date('2026-04-08T18:00:00.000Z')).map((item) => item.date)).toEqual([
      '2026-01-10',
      '2026-03-15',
      '2026-04-01',
      '2026-04-08'
    ]);
  });
});

describe('getAccountValueChartDomain', () => {
  it('builds a padded dynamic domain around visible points', () => {
    const domain = getAccountValueChartDomain([
      { date: '2026-04-05', shortDate: 'Apr 5', totalCapital: 907361.2, asOf: '2026-04-05T21:00:00.000Z', changeAmount: null, changePct: null },
      { date: '2026-04-06', shortDate: 'Apr 6', totalCapital: 907361.2, asOf: '2026-04-06T21:00:00.000Z', changeAmount: 0, changePct: 0 },
      { date: '2026-04-07', shortDate: 'Apr 7', totalCapital: 904181.4, asOf: '2026-04-07T21:00:00.000Z', changeAmount: -3179.8, changePct: -0.0035 },
      { date: '2026-04-10', shortDate: 'Apr 10', totalCapital: 909784.03, asOf: '2026-04-10T21:00:00.000Z', changeAmount: 5602.63, changePct: 0.0062 }
    ]);

    expect(domain).toEqual([890000, 920000]);
  });

  it('returns null when there are no valid points', () => {
    expect(getAccountValueChartDomain([])).toBeNull();
  });
});
