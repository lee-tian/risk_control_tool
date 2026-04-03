import type { Config, PutPosition } from '../types';

function getBaseConfig(config: Config | null, fallback: Config): Config {
  return {
    cash: config?.cash ?? fallback.cash ?? 0,
    risk_limit_pct: config?.risk_limit_pct ?? fallback.risk_limit_pct,
    warning_threshold_pct: config?.warning_threshold_pct ?? fallback.warning_threshold_pct
  };
}

export function applyOptionOpenCash(
  config: Config | null,
  fallback: Config,
  position: PutPosition,
  isEditing: boolean
): Config {
  const base = getBaseConfig(config, fallback);
  if (isEditing) {
    return base;
  }

  return {
    ...base,
    cash: base.cash + position.premium_per_share * position.contracts * 100
  };
}

export function applyOptionCloseCash(
  config: Config | null,
  fallback: Config,
  buybackPremiumPerShare: number,
  contractsToClose: number
): Config {
  const base = getBaseConfig(config, fallback);
  return {
    ...base,
    cash: base.cash - buybackPremiumPerShare * contractsToClose * 100
  };
}

export function applyStockSellCash(config: Config | null, fallback: Config, proceeds: number): Config {
  const base = getBaseConfig(config, fallback);
  return {
    ...base,
    cash: base.cash + proceeds
  };
}

export function applyStockBuyCash(config: Config | null, fallback: Config, cost: number): Config {
  const base = getBaseConfig(config, fallback);
  return {
    ...base,
    cash: base.cash - cost
  };
}
