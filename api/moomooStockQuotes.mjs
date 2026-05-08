import { resolveMoomooScriptPath, runMoomooJsonScript } from './moomooScripts.mjs';

/**
 * Fetches real-time stock quote data from Moomoo.
 * @param {string} symbol - The standard stock ticker (e.g. US.AAPL)
 * @returns {Promise<Object>} The quote object
 */
export async function fetchMoomooStockQuote(symbol) {
  const scriptPath = resolveMoomooScriptPath('quote/get_stock_quote.py');
  const payload = await runMoomooJsonScript(scriptPath, [symbol, '--json']);

  const data = payload?.data?.[0];
  if (!data || typeof data.last_price !== 'number') {
    throw new Error(`Data format error or no quote available from Moomoo for ${symbol}`);
  }

  return data;
}

/**
 * Fetches historical K-line data from Moomoo.
 * @param {string} symbol - The standard stock ticker (e.g. US.AAPL)
 * @param {string} ktype - Interval (e.g., '1d', '60m')
 * @param {number} num - Max number of candlesticks
 * @returns {Promise<Object>} The payload containing 'data' array
 */
export async function fetchMoomooKline(symbol, ktype = '1d', num = 200) {
  const scriptPath = resolveMoomooScriptPath('quote/get_kline.py');
  const payload = await runMoomooJsonScript(scriptPath, [
    symbol,
    '--ktype', ktype,
    '--num', String(num),
    '--json'
  ]);

  if (!Array.isArray(payload?.data)) {
    throw new Error(`K-line data format error from Moomoo for ${symbol}`);
  }

  return payload;
}
