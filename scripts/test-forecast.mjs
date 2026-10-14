import assert from 'node:assert/strict';
import { buildForecast, FORECAST_WINDOWS } from '../src/lib/indicators/forecast.ts';
import { GET } from '../src/app/api/market/forecast/route.ts';

const now = Date.now();
function candles(config, drift = 0.001, count = 1000) {
  const end = Math.floor(now / config.barMs) * config.barMs;
  return Array.from({ length: count }, (_, i) => {
    const open = 100 * Math.exp(i * drift);
    const close = 100 * Math.exp((i + 1) * drift);
    return { time: end - (count - i) * config.barMs, open, close,
      high: Math.max(open, close) * 1.002, low: Math.min(open, close) * 0.998, volume: 1000 };
  });
}

for (const config of FORECAST_WINDOWS) {
  for (const [drift, bias] of [[0.001, 'bullish'], [-0.001, 'bearish'], [0, 'neutral']]) {
    const input = candles(config, drift);
    const copy = structuredClone(input);
    const result = buildForecast(input, config, now);
    assert.equal(result.status, 'ready');
    assert.equal(result.bias, bias);
    assert.ok(result.range[0] <= result.target && result.target <= result.range[1]);
    assert.ok(result.nonOverlappingSamples >= 3);
    assert.ok(Math.abs(result.target / result.referencePrice - Math.exp(config.bars * drift)) < 0.002);
    assert.deepEqual(input, copy, '计算不能修改源行情');
    if (bias === 'neutral') {
      assert.equal(result.invalidation, null);
      assert.equal(result.touchHours, null);
      assert.equal(result.rewardRisk, null);
    } else {
      assert.ok(result.rewardRisk > 0);
      assert.ok(bias === 'bullish' ? result.invalidation < result.referencePrice : result.invalidation > result.referencePrice);
      assert.ok(result.touchHours[0] > 0 && result.touchHours[1] <= config.bars * config.barMs / 3_600_000);
      assert.ok(result.touchSamples <= result.samples);
    }
    const unclosed = { ...input.at(-1), time: input.at(-1).time + config.barMs, close: 1e10, high: 1e10 };
    assert.deepEqual(buildForecast([...input, unclosed], config, now), result, '未收盘蜡烛不得影响推算');
    const cutoff = input[599].time + config.barMs;
    assert.deepEqual(buildForecast(input, config, cutoff), buildForecast(input.slice(0, 600), config, cutoff), '历史时点不得读取未来数据');
    assert.equal(buildForecast(input, config, now + 2 * config.barMs).status, 'unavailable', '过期数据不得冒充当前预测');
  }
}

const config = FORECAST_WINDOWS[0];
const input = candles(config);
assert.equal(buildForecast([], config, now).status, 'unavailable');
assert.equal(buildForecast(input.slice(-70), config, now).status, 'unavailable');
assert.equal(buildForecast(input.slice(-100), config, now).status, 'unavailable', '重叠观测不能冒充足够多的不重叠窗口');
for (const mutate of [
  (cs) => cs.splice(500, 1),
  (cs) => { cs[500].close = NaN; },
  (cs) => { cs[500].time = NaN; },
  (cs) => { cs[500].low = -1; },
  (cs) => { cs[500].high = cs[500].low; },
  (cs) => cs.reverse(),
]) {
  const bad = structuredClone(input);
  mutate(bad);
  assert.equal(buildForecast(bad, config, now).status, 'unavailable');
}
const flat = candles(config, 0).map((c) => ({ ...c, high: 100, low: 100 }));
assert.equal(buildForecast(flat, config, now).status, 'unavailable');

// 用真实路由和受控上游验证响应、单周期失败和交易所分流，离线可运行。
for (const symbol of ['', 'BTC/USDT', '!!', 'a'.repeat(21)]) {
  const response = await GET(new Request(`http://localhost/api/market/forecast?symbol=${encodeURIComponent(symbol)}`));
  assert.equal(response.status, 400);
}
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith('exchangeInfo')) return Response.json({ symbols: [
    { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING' },
  ] });
  if (u.pathname.endsWith('instruments')) return Response.json({ code: '0', data: [{ instId: 'HYPE-USDT', state: 'live', quoteCcy: 'USDT' }] });
  if (u.pathname.endsWith('klines')) {
    if (u.searchParams.get('interval') === '4h') return new Response('', { status: 403 });
    const window = FORECAST_WINDOWS.find((w) => w.interval === u.searchParams.get('interval'));
    return Response.json(candles(window).map((c) => [c.time, `${c.open}`, `${c.high}`, `${c.low}`, `${c.close}`, `${c.volume}`, c.time + window.barMs - 1, '1000', 1, '500']));
  }
  if (u.pathname.endsWith('candles')) {
    const window = FORECAST_WINDOWS.find((w) => w.interval.toUpperCase() === u.searchParams.get('bar')?.replace(/utc$/, ''));
    return Response.json({ code: '0', data: candles(window, 0.001, 300).reverse().map((c) => [c.time, c.open, c.high, c.low, c.close, c.volume, 1000, 1000, 1].map(String)) });
  }
  throw new Error(`未预期的上游 ${u.pathname}`);
};
try {
  const response = await GET(new Request('http://localhost/api/market/forecast?symbol=btcusdt'));
  const data = await response.json();
  assert.equal(data.symbol, 'BTCUSDT');
  assert.equal(data.source, 'binance');
  assert.equal(data.rows.length, 3);
  assert.equal(data.rows[0].status, 'ready');
  assert.equal(data.rows[1].status, 'unavailable');
  assert.equal(data.rows[2].status, 'ready');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const okx = await (await GET(new Request('http://localhost/api/market/forecast?symbol=HYPEUSDT'))).json();
  assert.equal(okx.source, 'okx');
  assert.equal(okx.rows[0].status, 'ready');
} finally {
  globalThis.fetch = originalFetch;
}
console.log('✓ 趋势预判：方向/时间/失效价、不读取未来、异常数据、样本不足、接口降级及交易所分流');
