import { describe, expect, it } from 'vitest';

import { extractFinvizEarningsInfo } from './server.mjs';

describe('extractFinvizEarningsInfo', () => {
  it('parses next earnings date and time code from Finviz snapshot HTML', () => {
    const html = `
      <td class="snapshot-td2 cursor-pointer w-[7%]" align="left">
        <div class="snapshot-td-label"><a href="quote.ashx?t=AXP&ta=1&p=d&ty=ea">Earnings</a></div>
      </td>
      <td class="snapshot-td2 w-[8%]" align="left">
        <div class="snapshot-td-content"><a href="quote.ashx?t=AXP&ta=1&p=d&ty=ea"><b><small class="xl:text-2xs">Apr 23 BMO</small></b></a></div>
      </td>
    `;

    expect(extractFinvizEarningsInfo(html, new Date('2026-04-09T00:00:00.000Z'))).toEqual({
      next_earnings_date: '2026-04-23',
      earnings_time_code: 'BMO'
    });
  });

  it('rolls month-day values into the next year when the date already passed', () => {
    const html = `
      <div class="snapshot-td-label">Earnings</div>
      <div class="snapshot-td-content"><b><small>Jan 03 AMC</small></b></div>
    `;

    expect(extractFinvizEarningsInfo(html, new Date('2026-10-09T00:00:00.000Z'))).toEqual({
      next_earnings_date: '2027-01-03',
      earnings_time_code: 'AMC'
    });
  });

  it('drops stale Finviz earnings values when the parsed date is already in the past', () => {
    const html = `
      <div class="snapshot-td-label">Earnings</div>
      <div class="snapshot-td-content"><b><small>Feb 04 AMC</small></b></div>
    `;

    expect(extractFinvizEarningsInfo(html, new Date('2026-04-09T00:00:00.000Z'))).toEqual({
      next_earnings_date: null,
      earnings_time_code: 'AMC'
    });
  });
});
