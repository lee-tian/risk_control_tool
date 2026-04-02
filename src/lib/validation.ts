import type { Config, PutPosition } from '../types';

export type ValidationErrors<T> = Partial<Record<keyof T, string>>;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function isPercent(value: number): boolean {
  return value >= 0 && value <= 1;
}

export function validateConfig(config: Config): ValidationErrors<Config> {
  const errors: ValidationErrors<Config> = {};

  if (config.cash < 0) errors.cash = '现金必须大于等于 0';
  if (!isPercent(config.risk_limit_pct)) errors.risk_limit_pct = '风险上限必须在 0 到 1 之间';
  if (!isPercent(config.warning_threshold_pct)) {
    errors.warning_threshold_pct = '预警阈值必须在 0 到 1 之间';
  }

  return errors;
}

export function validatePut(put: PutPosition): ValidationErrors<PutPosition> {
  const errors: ValidationErrors<PutPosition> = {};

  if (isBlank(put.ticker)) errors.ticker = 'Ticker 不能为空';
  if (put.put_strike < 0) errors.put_strike = 'Strike 必须大于等于 0';
  if (put.premium_per_share < 0) errors.premium_per_share = 'Premium 必须大于等于 0';
  if (!Number.isInteger(put.contracts) || put.contracts < 1) errors.contracts = '合约数必须是大于等于 1 的整数';
  if (put.iv_rank < 0 || put.iv_rank > 100) errors.iv_rank = 'IV Rank 必须在 0 到 100 之间';
  if (isBlank(put.date_sold)) errors.date_sold = 'Date Sold 不能为空';
  if (isBlank(put.expiration_date)) errors.expiration_date = 'Expiration Date 不能为空';
  if (!errors.date_sold && !errors.expiration_date && put.expiration_date < put.date_sold) {
    errors.expiration_date = 'Expiration Date 不能早于 Date Sold';
  }

  return errors;
}
