import assert from 'node:assert/strict';
import { fetchJson, UpstreamError, isGeoBlocked } from '../src/lib/datasources/http.ts';
import { fetchCandlesWithSource, fetchCandleWindow, fetchTickers, resolveExchange } from '../src/lib/datasources/market.ts';
import { GET as getKlines } from '../src/app/api/market/klines/route.ts';

const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const binanceRow = (time = 1_700_000_000_000) => [time, '100', '103', '99', '102', '20', time + 59_999, '2000', 3, '10'];
const okxRow = (time) => [String(time), '100', '103', '99', '102', '20', '20', '2000', '1'];
const exchangeInfo = { symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' }] };
const calls = [];
function reset(fn) {
  for (const key of ['crypto-radar.http.cache', 'crypto-radar.http.inflight', 'crypto-radar.market.sources']) globalThis[Symbol.for(key)]?.clear();
  delete globalThis[Symbol.for('crypto-radar.market.registry')];
  calls.length = 0;
  globalThis.fetch = async (input, options) => {
    const url = new URL(String(input)); calls.push(url);
    return fn(url, options);
  };
}
try {
  let release;
  reset(() => new Promise((r) => { release = r; }));
  const first = fetchJson('https://unit.invalid/shared', { ttlMs: 1000 });
  const second = fetchJson('https://unit.invalid/shared', { ttlMs: 1000 });
  release(json({ value: 1 }));
  assert.deepEqual(await Promise.all([first, second]), [{ value: 1 }, { value: 1 }]);
  assert.equal(calls.length, 1, 'concurrent cache misses share a single upstream request');

  reset((url) => url.pathname.endsWith('/exchangeInfo') ? json(exchangeInfo) : json([binanceRow()]));
  const candles = await fetchCandlesWithSource('BTCUSDT', '1h', 300);
  assert.equal(candles.source, 'binance');
  assert.equal(candles.candles.length, 1);
  assert.equal(calls.some((u) => u.hostname.includes('okx')), false, 'Binance-listed coins must not wait for OKX registry');

  reset((url) => {
    if (url.pathname.endsWith('/exchangeInfo')) return json(exchangeInfo);
    if (url.hostname.includes('binance')) return json({ error: 'outage' }, 503);
    return json({ code: '0', data: [okxRow(1_700_000_000_000)] });
  });
  const fallback = await fetchCandlesWithSource('BTCUSDT', '1h', 300);
  assert.equal(fallback.source, 'okx', 'provenance follows the actual fallback');
  assert.equal(await resolveExchange('BTCUSDT'), 'okx');

  reset((url) => url.pathname.endsWith('/exchangeInfo') ? json(exchangeInfo) : json([binanceRow()]));
  await fetchCandlesWithSource('BTCUSDT', '1h', 300);
  const beforeFresh = calls.filter((u) => u.pathname.endsWith('/klines')).length;
  await Promise.all([
    fetchCandlesWithSource('BTCUSDT', '1h', 300, { fresh: true }),
    fetchCandlesWithSource('BTCUSDT', '1h', 300, { fresh: true }),
  ]);
  assert.equal(calls.filter((u) => u.pathname.endsWith('/klines')).length, beforeFresh + 2,
    'fresh prediction inputs bypass both cached values and concurrent observations');

  const day = 86_400_000, start = 1_699_920_000_000, end = start + day;
  reset(() => json({ code: '0', data: [okxRow(end + day), okxRow(end), okxRow(start), okxRow(start - day)] }));
  assert.deepEqual((await fetchCandleWindow('BTCUSDT', '1d', start, end, 'okx')).map((c) => c.time), [start, end]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].pathname, '/api/v5/market/history-candles');
  assert.equal(calls[0].searchParams.get('bar'), '1Dutc');
  assert.equal(calls[0].searchParams.get('before'), String(start - 1));
  assert.equal(calls[0].searchParams.get('after'), String(end + 1));
  assert.equal(calls[0].searchParams.get('limit'), '2');

  reset(() => json([binanceRow(start), binanceRow(end)]));
  await fetchCandleWindow('BTCUSDT', '1d', start, end, 'binance');
  assert.equal(calls[0].searchParams.get('startTime'), String(start));
  assert.equal(calls[0].searchParams.get('endTime'), String(end));
  assert.equal(calls[0].searchParams.get('limit'), '2');

  reset(() => json({ code: '50011', msg: 'rate limit', data: [] }));
  await assert.rejects(() => fetchCandleWindow('BTCUSDT', '1h', start, end, 'okx'), /OKX/);
  assert.equal(calls.length, 1, 'history must never silently switch exchanges');

  reset((url) => url.pathname.endsWith('/exchangeInfo') ? json(exchangeInfo) : json({ error: 'outage' }, 503));
  await assert.rejects(() => fetchTickers(['BTCUSDT']), UpstreamError, 'a total ticker outage must not look like empty successful data');

  reset(() => json([[start, 'bad', '103', '99', '102', '20', end, '2000', 3, '10']]));
  await assert.rejects(() => fetchCandleWindow('BTCUSDT', '1d', start, end, 'binance'), /K 线数据无效/);
  assert.equal(isGeoBlocked(new UpstreamError('forbidden', 403)), false);
  assert.equal(isGeoBlocked(new UpstreamError('restricted', 451)), true);

  for (const limit of ['-2', '0', '1.5', 'NaN', '1001', '']) {
    const response = await getKlines(new Request(`http://localhost/api/market/klines?symbol=BTCUSDT&interval=1h&limit=${limit}`));
    assert.equal(response.status, 400, `reject malformed limit: ${limit}`);
  }
  console.log('✓ market requests: coalescing, fast Binance routing, fallback provenance, pinned history, UTC bars, validation, explicit failures');
} finally {
  globalThis.fetch = realFetch;
}
