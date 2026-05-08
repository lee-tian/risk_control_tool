import {
  normalizeOptionSide,
  parseNumericValue,
  resolveMoomooScriptPath,
  runMoomooJsonScript,
  getMoomooUnderlying
} from './moomooScripts.mjs';

const DEFAULT_OPTION_CHAIN_SCRIPT =
  process.env.MOOMOO_GET_OPTION_CHAIN_SCRIPT ||
  resolveMoomooScriptPath('quote/get_option_chain.py');
const DEFAULT_OPTION_SNAPSHOTS_SCRIPT =
  process.env.MOOMOO_GET_OPTION_SNAPSHOTS_SCRIPT ||
  '/app/api/scripts/get_moomoo_option_snapshots.py';

function pickMoomooPrice(row) {
  const mid = parseNumericValue(row?.mid_price ?? row?.mid ?? row?.middle_price);
  const last = parseNumericValue(row?.last_price ?? row?.last);
  const bid = parseNumericValue(row?.bid_price ?? row?.bid);
  const ask = parseNumericValue(row?.ask_price ?? row?.ask);

  if (mid !== null && mid > 0) {
    return mid;
  }
  if (last !== null && last > 0) {
    return last;
  }
  if (bid !== null && bid > 0 && ask !== null && ask > 0) {
    return (bid + ask) / 2;
  }
  if (ask !== null && ask > 0) {
    return ask;
  }
  if (bid !== null && bid > 0) {
    return bid;
  }

  return null;
}

function parseGreek(row, keys) {
  for (const key of keys) {
    const numeric = parseNumericValue(row?.[key]);
    if (numeric !== null) {
      return numeric;
    }
  }

  return null;
}

export function extractOptionQuoteFromMoomooChain(payload, targetStrike, expirationDate, side = 'put') {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const normalizedSide = normalizeOptionSide(side) ?? 'put';

  for (const row of rows) {
    const rowStrike = parseNumericValue(row?.strike_price ?? row?.strike);
    if (rowStrike === null || Math.abs(rowStrike - targetStrike) >= 0.001) {
      continue;
    }

    const rowExpiration = typeof row?.strike_time === 'string' ? row.strike_time.trim().slice(0, 10) : null;
    if (rowExpiration && rowExpiration !== expirationDate) {
      continue;
    }

    const rowSide = normalizeOptionSide(row?.option_type ?? row?.type);
    if (rowSide && rowSide !== normalizedSide) {
      continue;
    }

    return {
      code: typeof row?.code === 'string' && row.code.trim() !== '' ? row.code.trim() : null,
      price: pickMoomooPrice(row),
      theta: parseGreek(row, ['theta', 'theta_value', 'option_theta']),
      delta: parseGreek(row, ['delta', 'delta_value', 'option_delta']),
      gamma: parseGreek(row, ['gamma', 'gamma_value', 'option_gamma'])
    };
  }

  return null;
}

export function extractOptionQuoteFromMoomooSnapshot(payload, optionCode) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const matchedRow =
    rows.find((row) => typeof row?.code === 'string' && row.code.trim() === optionCode) ??
    rows[0] ??
    null;

  if (!matchedRow) {
    return null;
  }

  const price = pickMoomooPrice(matchedRow);
  if (price === null) {
    return null;
  }

  return {
    price,
    theta: parseGreek(matchedRow, ['option_theta', 'theta', 'theta_value']),
    delta: parseGreek(matchedRow, ['option_delta', 'delta', 'delta_value']),
    gamma: parseGreek(matchedRow, ['option_gamma', 'gamma', 'gamma_value'])
  };
}

export async function fetchMoomooOptionQuote(
  symbol,
  expirationDate,
  strike,
  side = 'put',
  { execFileImpl } = {}
) {
  const underlying = getMoomooUnderlying(symbol);
  const chainPayload = await runMoomooJsonScript(
    DEFAULT_OPTION_CHAIN_SCRIPT,
    [underlying, '--start', expirationDate, '--end', expirationDate, '--json'],
    { execFileImpl }
  );

  const chainQuote = extractOptionQuoteFromMoomooChain(chainPayload, strike, expirationDate, side);
  if (!chainQuote?.code) {
    throw new Error(`Moomoo option chain unavailable for ${underlying} ${expirationDate} ${strike} ${side}`);
  }

  let snapshotQuote = null;
  try {
    const snapshotPayload = await runMoomooJsonScript(
      DEFAULT_OPTION_SNAPSHOTS_SCRIPT,
      [chainQuote.code, '--json'],
      { execFileImpl }
    );
    snapshotQuote = extractOptionQuoteFromMoomooSnapshot(snapshotPayload, chainQuote.code);
  } catch {
    snapshotQuote = null;
  }

  const price = snapshotQuote?.price ?? chainQuote.price;
  if (price === null || !Number.isFinite(price) || price <= 0) {
    throw new Error(`Moomoo option quote unavailable for ${underlying} ${expirationDate} ${strike} ${side}`);
  }

  return {
    price,
    theta: snapshotQuote?.theta ?? chainQuote.theta,
    delta: snapshotQuote?.delta ?? chainQuote.delta,
    gamma: snapshotQuote?.gamma ?? chainQuote.gamma,
    source: snapshotQuote ? 'Moomoo snapshot' : 'Moomoo option chain'
  };
}
