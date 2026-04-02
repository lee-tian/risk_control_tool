import { describe, expect, it } from 'vitest';
import { readJsonFromResponse } from './httpResponses.mjs';

describe('readJsonFromResponse', () => {
  it('parses valid JSON payloads', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    await expect(readJsonFromResponse(response, 'Failed to parse JSON')).resolves.toEqual({ ok: true });
  });

  it('reports upstream HTML clearly instead of leaking a JSON syntax error', async () => {
    const response = new Response('<html><h1>502 Bad Gateway</h1></html>', {
      headers: {
        'Content-Type': 'text/html'
      }
    });

    await expect(readJsonFromResponse(response, 'Gemini pre-trade analysis failed')).rejects.toThrow(
      'Gemini pre-trade analysis failed: upstream returned HTML'
    );
  });
});
