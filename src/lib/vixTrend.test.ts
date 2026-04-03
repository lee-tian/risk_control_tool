import { describe, expect, it } from 'vitest';

import type { VixHistoryPoint } from '../types';
import { analyzeVixTrend } from './vixTrend';

function point(day: number, value: number): VixHistoryPoint {
  return {
    timestamp: `2026-03-${String(day).padStart(2, '0')}`,
    value,
    stress: 0
  };
}

describe('analyzeVixTrend', () => {
  it('classifies a steady climb as rising', () => {
    const history = [18, 19, 20, 21, 22, 23, 24, 25, 26, 27].map((value, index) => point(index + 1, value));
    const result = analyzeVixTrend(history);

    expect(result.mode).toBe('rising');
    expect(result.note).toContain('上行');
  });

  it('classifies a steady decline as falling', () => {
    const history = [31, 30, 29, 28, 27, 26, 25, 24, 23, 22].map((value, index) => point(index + 1, value));
    const result = analyzeVixTrend(history);

    expect(result.mode).toBe('falling');
    expect(result.note).toContain('回落');
  });

  it('classifies a tight range as sideways', () => {
    const history = [25.1, 25.4, 25.0, 25.3, 25.2, 25.5, 25.1, 25.4, 25.2, 25.3].map((value, index) =>
      point(index + 1, value)
    );
    const result = analyzeVixTrend(history);

    expect(result.mode).toBe('sideways');
    expect(result.note).toContain('区间震荡');
  });
});
