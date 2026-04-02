import { describe, expect, it } from 'vitest';

import { normalizeProviderSymbol } from './providerSymbols.mjs';

describe('normalizeProviderSymbol', () => {
  it('maps provider-specific ticker aliases', () => {
    expect(normalizeProviderSymbol('BRKB')).toBe('BRK.B');
  });

  it('leaves standard symbols unchanged', () => {
    expect(normalizeProviderSymbol('AAPL')).toBe('AAPL');
  });
});
