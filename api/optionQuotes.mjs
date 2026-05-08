import { normalizeProviderSymbol } from './providerSymbols.mjs';

export function pickOptionQuoteSample(data, targetStrike) {
  const strikeList = Array.isArray(data?.strike) ? data.strike : [];
  const bidList = Array.isArray(data?.bid) ? data.bid : [];
  const askList = Array.isArray(data?.ask) ? data.ask : [];
  const midList = Array.isArray(data?.mid) ? data.mid : [];
  const lastList = Array.isArray(data?.last) ? data.last : [];
  const thetaList = Array.isArray(data?.theta) ? data.theta : [];
  const deltaList = Array.isArray(data?.delta) ? data.delta : [];
  const gammaList = Array.isArray(data?.gamma) ? data.gamma : [];

  let bestSample = null;

  for (let index = 0; index < strikeList.length; index += 1) {
    const strike = Number(strikeList[index]);
    if (!Number.isFinite(strike)) {
      continue;
    }

    const strikeDistance = Math.abs(strike - targetStrike);
    const bid = Number(bidList[index]);
    const ask = Number(askList[index]);
    const mid = Number(midList[index]);
    const last = Number(lastList[index]);
    const theta = Number(thetaList[index]);
    const delta = Number(deltaList[index]);
    const gamma = Number(gammaList[index]);

    let price = null;
    if (Number.isFinite(mid) && mid > 0) {
      price = mid;
    } else if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
      price = (bid + ask) / 2;
    } else if (Number.isFinite(last) && last > 0) {
      price = last;
    } else if (Number.isFinite(ask) && ask > 0) {
      price = ask;
    } else if (Number.isFinite(bid) && bid > 0) {
      price = bid;
    }

    if (!Number.isFinite(price) || price === null || price <= 0) {
      continue;
    }

    if (bestSample === null || strikeDistance < bestSample.strikeDistance) {
      bestSample = {
        strike,
        price,
        strikeDistance,
        theta: Number.isFinite(theta) ? theta : null,
        delta: Number.isFinite(delta) ? delta : null,
        gamma: Number.isFinite(gamma) ? gamma : null
      };
    }
  }

  return bestSample;
}

export function formatOptionSymbol(symbol, expirationDate, strike, side = 'put') {
  const normalizedSymbol = normalizeProviderSymbol(symbol).replace(/[^A-Z]/g, '').toUpperCase();
  const expiration = expirationDate.replaceAll('-', '');

  if (normalizedSymbol === '' || !/^\d{8}$/.test(expiration) || !Number.isFinite(strike) || strike <= 0) {
    throw new Error(`Invalid option contract parameters for ${symbol} ${expirationDate} ${strike} ${side}`);
  }

  const yy = expiration.slice(2, 4);
  const mm = expiration.slice(4, 6);
  const dd = expiration.slice(6, 8);
  const optionSide = side.toLowerCase() === 'call' ? 'C' : 'P';
  const strikeComponent = Math.round(strike * 1000)
    .toString()
    .padStart(8, '0');

  return `${normalizedSymbol}${yy}${mm}${dd}${optionSide}${strikeComponent}`;
}

export function pickOptionQuotePrice(data) {
  const mid = Array.isArray(data?.mid) ? Number(data.mid[0]) : Number.NaN;
  const bid = Array.isArray(data?.bid) ? Number(data.bid[0]) : Number.NaN;
  const ask = Array.isArray(data?.ask) ? Number(data.ask[0]) : Number.NaN;
  const last = Array.isArray(data?.last) ? Number(data.last[0]) : Number.NaN;

  if (Number.isFinite(mid) && mid > 0) {
    return mid;
  }
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
    return (bid + ask) / 2;
  }
  if (Number.isFinite(last) && last > 0) {
    return last;
  }
  if (Number.isFinite(ask) && ask > 0) {
    return ask;
  }
  if (Number.isFinite(bid) && bid > 0) {
    return bid;
  }

  return null;
}

export function pickOptionQuoteTheta(data) {
  const theta = Array.isArray(data?.theta) ? Number(data.theta[0]) : Number.NaN;
  if (!Number.isFinite(theta)) {
    return null;
  }

  if (Math.abs(theta) < 0.000001) {
    return null;
  }

  return theta;
}

export function pickOptionQuoteDelta(data) {
  const delta = Array.isArray(data?.delta) ? Number(data.delta[0]) : Number.NaN;
  return Number.isFinite(delta) ? delta : null;
}

export function pickOptionQuoteGamma(data) {
  const gamma = Array.isArray(data?.gamma) ? Number(data.gamma[0]) : Number.NaN;
  return Number.isFinite(gamma) ? gamma : null;
}

export function extractOptionQuoteFromSnapshot(data) {
  const price = pickOptionQuotePrice(data);
  if (price === null) {
    return null;
  }

  return {
    price,
    theta: pickOptionQuoteTheta(data),
    delta: pickOptionQuoteDelta(data),
    gamma: pickOptionQuoteGamma(data)
  };
}

export function extractOptionQuoteFromChain(data, targetStrike) {
  const sample = data?.s === 'no_data' ? null : pickOptionQuoteSample(data, targetStrike);
  if (!sample) {
    return null;
  }

  return {
    price: sample.price,
    theta: sample.theta,
    delta: sample.delta,
    gamma: sample.gamma
  };
}

function normalizeBarchartOptionRows(payload) {
  if (Array.isArray(payload?.data)) {
    return payload.data;
  }

  if (Array.isArray(payload?.results)) {
    return payload.results;
  }

  if (Array.isArray(payload)) {
    return payload;
  }

  return [];
}

function normalizeOptionSide(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === 'call' || normalized === 'c') {
    return 'call';
  }
  if (normalized === 'put' || normalized === 'p') {
    return 'put';
  }

  return null;
}

function normalizeOptionDate(value) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
    return trimmed;
  }
  if (/^\d{4}\/\d{2}\/\d{2}$/u.test(trimmed)) {
    return trimmed.replaceAll('/', '-');
  }

  return null;
}

function pickBarchartOptionPrice(row) {
  const last = Number(row?.lastPrice);
  const bid = Number(row?.bidPrice);
  const ask = Number(row?.askPrice);

  if (Number.isFinite(last) && last > 0) {
    return last;
  }
  if (Number.isFinite(bid) && bid > 0 && Number.isFinite(ask) && ask > 0) {
    return (bid + ask) / 2;
  }
  if (Number.isFinite(ask) && ask > 0) {
    return ask;
  }
  if (Number.isFinite(bid) && bid > 0) {
    return bid;
  }

  return null;
}

export function extractOptionQuoteFromBarchart(payload, targetStrike, expirationDate, side = 'put') {
  const rows = normalizeBarchartOptionRows(payload);
  const normalizedSide = normalizeOptionSide(side) ?? 'put';
  const normalizedExpiration = normalizeOptionDate(expirationDate);
  let bestMatch = null;

  for (const row of rows) {
    const rowStrike = Number(row?.strikePrice ?? row?.strike);
    if (!Number.isFinite(rowStrike)) {
      continue;
    }

    const rowSide = normalizeOptionSide(row?.optionType ?? row?.side);
    if (rowSide && rowSide !== normalizedSide) {
      continue;
    }

    const rowExpiration = normalizeOptionDate(row?.expirationDate);
    if (normalizedExpiration && rowExpiration && rowExpiration !== normalizedExpiration) {
      continue;
    }

    const price = pickBarchartOptionPrice(row);
    if (price === null) {
      continue;
    }

    const candidate = {
      strikeDistance: Math.abs(rowStrike - targetStrike),
      tradeTime: row?.tradeTime ?? null,
      price,
      theta: Number.isFinite(Number(row?.theta)) ? Number(row.theta) : null,
      delta: Number.isFinite(Number(row?.delta)) ? Number(row.delta) : null,
      gamma: Number.isFinite(Number(row?.gamma)) ? Number(row.gamma) : null
    };

    if (bestMatch === null || candidate.strikeDistance < bestMatch.strikeDistance) {
      bestMatch = candidate;
    }
  }

  if (!bestMatch) {
    return null;
  }

  return {
    price: bestMatch.price,
    theta: bestMatch.theta,
    delta: bestMatch.delta,
    gamma: bestMatch.gamma,
    asOf: bestMatch.tradeTime
  };
}
