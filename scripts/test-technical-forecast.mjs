import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateForecast, PROFILES, ForecastInputError } from '../src/lib/forecast/engine.ts';
import { INTERVAL_MS } from '../src/lib/forecast/types.ts';
import { evaluateForecast, computeForecastStats } from '../src/lib/forecast/evaluate.ts';
import { saveForecast, readForecasts, saveEvaluation } from '../src/lib/forecast/store.ts';
import { forecastRequest, sameOrigin } from '../src/lib/forecast/request.ts';

function fixture(interval, drift = .2) {
  const dt = INTERVAL_MS[interval];
  return Array.from({ length: 190 }, (_, i) => {
    const open = 100 + i * drift;
    const close = open + drift;
    return { time: i * dt, open, close, high: Math.max(open, close) + .7, low: Math.min(open, close) - .7, volume: 100 + i % 7 };
  });
}
function generate(interval = '1h', candles = fixture(interval), now = 190 * INTERVAL_MS[interval] + 1_000) {
  return generateForecast({ symbol: 'BTCUSDT', interval, source: 'binance', candles, now });
}

for (const interval of Object.keys(INTERVAL_MS)) {
  const dt = INTERVAL_MS[interval];
  const now = 190 * dt + 1_000;
  const record = generate(interval);
  assert.equal(record.horizonBars, PROFILES[interval].horizonBars);
  assert.equal(record.candles.length, record.horizonBars);
  assert.ok(record.candles[0].time > now, '目标从下一根完整 K 线开始');
  assert.equal(record.targetEndTime, record.candles.at(-1).time + dt);
  for (let i = 0; i < record.candles.length; i++) {
    const candle = record.candles[i];
    assert.ok(candle.high >= Math.max(candle.open, candle.close));
    assert.ok(candle.low <= Math.min(candle.open, candle.close) && candle.low > 0);
    assert.ok(candle.lower <= candle.close && candle.upper >= candle.close);
    if (i) assert.equal(candle.time - record.candles[i - 1].time, dt);
  }
  assert.equal(generate(interval).id, record.id, '相同锚点必须去重');
  assert.deepEqual(generate(interval).candles, record.candles, '预测可重现');
  const unclosed = { time: 190 * dt, open: 9000, high: 10000, low: 1, close: 9999, volume: 99999 };
  const future = { ...unclosed, time: 220 * dt };
  assert.deepEqual(generate(interval, [...fixture(interval), unclosed, future]).candles, record.candles, '未收盘/未来值不污染预测');
  assert.equal(evaluateForecast(record, record.candles, record.targetEndTime - 1), null, '未完全到期不算错误');
  assert.equal(evaluateForecast(record, record.candles.slice(1), record.targetEndTime), null, '缺目标 K 线不能评估');
  assert.equal(evaluateForecast(record, [...record.candles, record.candles[0]], record.targetEndTime), null, '重复时间不得评估');
  const exact = evaluateForecast(record, record.candles, record.targetEndTime);
  assert.equal(exact.closeMape, 0);
  assert.equal(exact.boundCoverage, 100);
  assert.equal(exact.correct, true);
  const miss = record.candles.map(c => ({ ...c, open: c.open * 2, close: c.close * 2, high: c.high * 2, low: c.low * 2 }));
  assert.equal(evaluateForecast(record, miss, record.targetEndTime).boundCoverage, 0);
}

const original = fixture('1h');
assert.throws(() => generate('1h', original.slice(0, 79)), ForecastInputError);
assert.throws(() => generate('1h', original.filter((_, i) => i !== 100)), /缺口/);
assert.throws(() => generate('1h', original.map((c, i) => i === 100 ? { ...c, close: NaN } : c)), /无效/);
assert.throws(() => generate('1h', original, 192 * INTERVAL_MS['1h']), /过期/);
const flat = fixture('1h', 0).map(c => ({ ...c, high: c.close, low: c.close, volume: 0 }));
const neutral = generate('1h', flat);
assert.equal(neutral.direction, 'neutral');
assert.equal(neutral.signals.find(s => s.name === 'RSI').value, 50);
const flatEval = evaluateForecast(neutral, neutral.candles, neutral.targetEndTime);
assert.equal(flatEval.skillScore, null, '基线误差为零时不得除零');
const record = generate();
const evaluation = evaluateForecast(record, record.candles, record.targetEndTime);
assert.equal(computeForecastStats([]).hitRate, null);
const stats = computeForecastStats([{ ...record, evaluation }, neutral]);
assert.equal(stats.hitRate, 100);
assert.equal(stats.evaluated, 1);
assert.equal(stats.pending, 1);
assert.equal(stats.byInterval.find(s => s.interval === '1h').evaluated, 1);
assert.equal(stats.byInterval.find(s => s.interval === '1m').hitRate, null);
assert.equal(forecastRequest.safeParse({ symbol: '../BTC', interval: '1h' }).success, false);
assert.equal(forecastRequest.safeParse({ symbol: 'BTCUSDT', interval: '2h' }).success, false);
assert.equal(forecastRequest.parse({ symbol: ' btcusdt ', interval: '1h' }).symbol, 'BTCUSDT');
assert.equal(forecastRequest.parse({ symbol: 'WUSDT', interval: '1h' }).symbol, 'WUSDT');
assert.throws(() => generateForecast({ symbol: 'BTCUSDT', interval: '1h', source: 'binance', candles: original,
  now: 190 * INTERVAL_MS['1h'] + 1000, inputCutoffAt: 190 * INTERVAL_MS['1h'] - 2000 }), /过期/,
  '请求跨收盘时不能把抓取时未完成的 K 线当已收盘输入');
assert.equal(sameOrigin(new Request('http://localhost/api/forecast', { headers: { Origin: 'https://unrelated.example' } })), false);
assert.equal(sameOrigin(new Request('http://localhost:3100/api/forecast', { headers: { Host: '127.0.0.1:3100', Origin: 'http://127.0.0.1:3100' } })), true,
  '生产路由内部hostname与浏览器Host不同仍识别同源');
assert.equal(sameOrigin(new Request('http://localhost/api/forecast', { headers: { Origin: 'null' } })), false);

const dir = await mkdtemp(path.join(tmpdir(), 'crypto-forecast-test-'));
process.env.FORECAST_DATA_DIR = dir;
try {
  const concurrent = await Promise.all(Array.from({ length: 12 }, () => saveForecast(record)));
  assert.equal(concurrent.filter(r => !r.reused).length, 1, '并发生成只新增一条');
  await Promise.all([saveForecast(neutral), saveForecast(generate('5m'))]);
  assert.equal((await readForecasts()).length, 2, '同源同锚点即使后续输入变动，也不能重写既有预测');
  const saved = JSON.parse(await readFile(path.join(dir, `${record.id}.json`), 'utf8'));
  assert.deepEqual(saved.candles, record.candles);
  const reviews = await Promise.all(Array.from({ length: 8 }, () => saveEvaluation(record.id, evaluation)));
  assert.equal(reviews.filter(Boolean).length, 1);
  assert.equal((await readForecasts()).find(r => r.id === record.id).evaluation.closeMape, 0);
  assert.equal(JSON.parse(await readFile(path.join(dir, `${record.id}.json`), 'utf8')).evaluation, null, '复盘不改写原预测快照');
  await writeFile(path.join(dir, `${record.id}.json`), '{broken');
  await assert.rejects(readForecasts(), /JSON|property|position/i, '损坏存档必须显式报错');
} finally {
  delete process.env.FORECAST_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
}
console.log('✓ 七周期预测、无前视、OHLC、缺口/到期评估、基线与并发持久化测试通过');
