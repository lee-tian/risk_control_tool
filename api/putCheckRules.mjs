function getOtmRangeByBeta(beta) {
  if (beta < 0.9) {
    return { min: 0.05, max: 0.07 };
  }
  if (beta <= 1.3) {
    return { min: 0.06, max: 0.09 };
  }
  if (beta <= 1.8) {
    return { min: 0.08, max: 0.12 };
  }
  return { min: 0.1, max: 0.15 };
}

function calculateDaysBetween(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const ms = end.getTime() - start.getTime();
  if (!Number.isFinite(ms)) {
    return null;
  }
  return Math.ceil(ms / (1000 * 60 * 60 * 24));
}

export function buildPutEntryChecks({
  side,
  strike,
  currentPrice,
  beta,
  dateSold,
  expirationDate,
  ma20,
  rsi,
  vix,
  ivRank
}) {
  const otmPct = side === 'call' ? (strike - currentPrice) / currentPrice : (currentPrice - strike) / currentPrice;
  const otmRange = getOtmRangeByBeta(beta);
  const dte = calculateDaysBetween(dateSold, expirationDate);

  const checks = side === 'call'
    ? [
        {
          id: 'otm_call',
          label: 'Covered Call 行权价高于现价',
          passed: strike >= currentPrice,
          detail: `当前现价 ${currentPrice.toFixed(2)} / Strike ${strike.toFixed(2)}`
        },
        {
          id: 'dte',
          label: '到期日大于 7D',
          passed: dte !== null && dte > 7,
          detail: `当前 DTE ${dte ?? '-'}`
        },
        {
          id: 'strike_above_ma20',
          label: 'Covered Call 行权价在 20 日均线上方',
          passed: strike > ma20,
          detail: `Strike ${strike.toFixed(2)} / MA20 ${ma20.toFixed(2)}`
        }
      ]
    : [
        {
          id: 'otm_by_beta',
          label: 'Strike 符合 beta 对应的 OTM 区间',
          passed: otmPct >= otmRange.min && otmPct <= otmRange.max,
          detail: `当前 OTM ${(otmPct * 100).toFixed(2)}% / 目标 ${(otmRange.min * 100).toFixed(0)}%–${(otmRange.max * 100).toFixed(0)}%`
        },
        {
          id: 'vix_window',
          label: 'VIX 在适合卖 Put 的区间',
          passed: typeof vix === 'number' && Number.isFinite(vix) && vix >= 20 && vix < 40,
          detail: `当前 VIX ${typeof vix === 'number' && Number.isFinite(vix) ? vix.toFixed(2) : '-'} / 目标 20.00–39.99`
        },
        {
          id: 'iv_rank',
          label: 'IV Rank 不低于 30',
          passed: typeof ivRank === 'number' && Number.isFinite(ivRank) && ivRank >= 30,
          detail: `当前 IV Rank ${typeof ivRank === 'number' && Number.isFinite(ivRank) ? ivRank.toFixed(1) : '-'}`
        },
        {
          id: 'dte',
          label: '到期日大于 40D',
          passed: dte !== null && dte > 40,
          detail: `当前 DTE ${dte ?? '-'}`
        },
        {
          id: 'strike_below_ma20',
          label: 'Strike 在 20 日均线下方',
          passed: strike < ma20,
          detail: `Strike ${strike.toFixed(2)} / MA20 ${ma20.toFixed(2)}`
        },
        {
          id: 'oversold',
          label: 'RSI(14) 已进入超卖区',
          passed: rsi <= 30,
          detail: `当前 RSI ${rsi.toFixed(1)} / 超卖阈值 30.0`
        }
      ];

  return {
    checks,
    dte,
    otmPct
  };
}
