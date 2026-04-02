import { describe, expect, it } from 'vitest';

import { buildCookieHeaderFromSetCookie } from './server.mjs';

describe('buildCookieHeaderFromSetCookie', () => {
  it('joins multiple set-cookie values into a request cookie header', () => {
    expect(
      buildCookieHeaderFromSetCookie([
        'countryCode=US; Domain=.cnn.com; Path=/; SameSite=None; Secure',
        'stateCode=WA; Domain=.cnn.com; Path=/; SameSite=None; Secure',
        'wbdFch=abc123; Domain=www.cnn.com; Path=/markets/fear-and-greed; Max-Age=30; SameSite=None; Secure'
      ])
    ).toBe('countryCode=US; stateCode=WA; wbdFch=abc123');
  });

  it('returns an empty string for empty input', () => {
    expect(buildCookieHeaderFromSetCookie([])).toBe('');
    expect(buildCookieHeaderFromSetCookie(null)).toBe('');
  });
});
