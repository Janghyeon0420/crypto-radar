import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createForecast, forecastHistory, reviewForecasts } from '../src/lib/forecast/service.ts';
import { INTERVAL_MS } from '../src/lib/forecast/types.ts';

const dir = await mkdtemp(path.join(tmpdir(), 'crypto-forecast-service-'));
process.env.FORECAST_DATA_DIR = dir;
const realFetch = globalThis.fetch;
const realNow = Date.now;
const dt = INTERVAL_MS['1m'];
let now = 190 * dt - 2_000;
let calls = 0;
let record;
let historyMissing = false;
let historicalCalls = 0;
Date.now = () => now;
const row = c => [c.time, `${c.open}`, `${c.high}`, `${c.low}`, `${c.close}`, `${c.volume}`, c.time + dt - 1, '0', 10, '0'];
globalThis.fetch = async (url) => {
  const u = new URL(String(url));
  if (u.pathname.endsWith('exchangeInfo')) return Response.json({ symbols: [{ symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', status: 'TRADING', isSpotTradingAllowed: true }] });
  assert.ok(u.hostname.includes('binance'), '生成和复盘保持原交易所');
  assert.ok(u.pathname.endsWith('klines'));
  if (u.searchParams.has('startTime')) {
    historicalCalls++;
    assert.equal(Number(u.searchParams.get('startTime')), record.candles[0].time);
    assert.equal(Number(u.searchParams.get('endTime')), record.targetEndTime);
    return Response.json((historyMissing ? record.candles.slice(1) : record.candles).map(row));
  }
  calls++;
  now = 190 * dt + 1000;
  const candles = Array.from({ length: 190 }, (_, i) => ({ time: i * dt, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 100 }));
  if (calls === 1) candles[189].close = 289.25; // 首次请求开始时这根尚未收盘
  return Response.json(candles.map(row));
};

try {
  const result = await createForecast('BTCUSDT', '1m');
  record = result.record;
  assert.equal(calls, 2, '请求跨收盘边界必须绕过缓存重新取快照');
  assert.equal(record.anchorPrice, 290, '保存最终收盘价，不保存部分成交价');
  assert.equal(record.inputCutoffAt, 190 * dt + 1000);
  assert.equal((await createForecast('BTCUSDT', '1m')).reused, true);
  let history = await forecastHistory({ symbol: 'BTCUSDT', interval: '1m' });
  assert.equal(history.records.length, 1);
  assert.equal(history.stats.pending, 1);
  assert.equal((await reviewForecasts()).evaluated, 0);
  assert.equal(historicalCalls, 0, '尚未到期不拉取评估行情');
  now = record.targetEndTime;
  historyMissing = true;
  const incomplete = await reviewForecasts();
  assert.equal(incomplete.evaluated, 0);
  assert.equal(incomplete.evaluationErrors.length, 1);
  assert.equal((await forecastHistory({})).stats.hitRate, null);
  historyMissing = false;
  // 同一历史窗口首次缺数据时不应被长期缓存；越过适配器的短缓存后可补复盘。
  now += 6000;
  assert.equal((await reviewForecasts()).evaluated, 1);
  history = await forecastHistory({ symbol: 'BTCUSDT', interval: '1m' });
  assert.equal(history.stats.hitRate, 100);
  assert.equal(history.stats.pending, 0);
  assert.deepEqual(history.records[0].candles, record.candles, '复盘不改变预测');
  const count = historicalCalls;
  assert.equal((await reviewForecasts()).evaluated, 0);
  assert.equal(historicalCalls, count, '已完成复盘不重复取数');
  assert.equal((await forecastHistory({ symbol: 'BTCUSDT', interval: '1h' })).records.length, 0);
  console.log('✓ 收盘边界强制重取、服务存档去重、到期历史窗口、缺数据重试与周期隔离通过');
} finally {
  globalThis.fetch = realFetch;
  Date.now = realNow;
  delete process.env.FORECAST_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
}
