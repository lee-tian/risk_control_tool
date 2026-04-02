export const SYMBOL_ALIASES = {
  BRKB: 'BRK.B'
};

export function normalizeProviderSymbol(symbol) {
  return SYMBOL_ALIASES[symbol] ?? symbol;
}
