#!/usr/bin/env node
/**
 * 主动成交方向（taker flow）的回测。
 *
 * 单独一个脚本，因为它需要与其它信号**不同的尺子**：
 * 微观结构信号的有效期是分钟级，用 24 小时的跨度去测它，
 * 测不出来也说明不了任何事——那是尺子不对，不是信号没用。
 *
 * 所以这里在短周期（5m/15m/1h）上用短跨度（1~12 根）逐个试，
 * 有效波动阈值也换成按 √跨度 缩放的口径，不再钳到 1% 下限。
 *
 * 跑法：npm run backtest:flow
 */
import { fetchCandles } from '../src/lib/datasources/binance-vision.ts';
import { replay, signalStats, shortHorizonThreshold } from '../src/lib/indicators/backtest.ts';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT'];
const SETUPS = [
  { interval: '5m', horizons: [1, 3, 6, 12] },
  { interval: '15m', horizons: [1, 3, 6, 12] },
  { interval: '1h', horizons: [1, 3, 6] },
];

const pad = (s, n) => String(s).padEnd(n);
const pct = (v) => `${v.toFixed(1)}%`;

console.log('主动成交方向在不同周期/跨度下的信息量\n');
console.log(`  ${pad('周期', 8)}${pad('跨度', 8)}${pad('触发次数', 10)}${pad('命中率', 10)}${pad('基线', 10)}信息量`);
console.log('  ' + '─'.repeat(60));

const results = [];

for (const setup of SETUPS) {
  const candlesBySymbol = [];
  for (const s of SYMBOLS) {
    try {
      candlesBySymbol.push(await fetchCandles(s, setup.interval, 1000));
    } catch {
      // 单个币种失败不影响整体
    }
  }

  for (const horizon of setup.horizons) {
    const obs = candlesBySymbol.flatMap((c) =>
      replay(c, setup.interval, horizon, shortHorizonThreshold),
    );
    const stat = signalStats(obs).find((x) => x.id === 'taker_flow');
    if (!stat) {
      console.log(`  ${pad(setup.interval, 8)}${pad(horizon + ' 根', 8)}未触发`);
      continue;
    }
    const mark = stat.edge > 2 ? '  ← 有效' : stat.edge < -2 ? '  ← 反向' : '';
    console.log(
      `  ${pad(setup.interval, 8)}${pad(horizon + ' 根', 8)}${pad(stat.count, 10)}` +
        `${pad(pct(stat.hitRate), 10)}${pad(pct(stat.baseRate), 10)}` +
        `${stat.edge >= 0 ? '+' : ''}${stat.edge.toFixed(1)}pt${mark}`,
    );
    results.push({ ...stat, interval: setup.interval, horizon, n: obs.length });
  }
}

console.log('\n' + '─'.repeat(64));
const best = results.reduce((a, b) => (b.edge > (a?.edge ?? -99) ? b : a), null);
if (!best) {
  console.log('所有组合都没有触发，检查 K 线是否带 takerBuyVolume 字段。');
} else if (best.edge > 2) {
  console.log(
    `最好的一组是 ${best.interval} / ${best.horizon} 根，信息量 +${best.edge.toFixed(1)}pt（${best.count} 次触发）。`,
  );
  console.log('可以考虑给它权重——但先确认这不是在十几组里挑出来的最好看的那个：');
  console.log(`本次一共试了 ${results.length} 组，多重比较下偶然出现一组 +2~3pt 是很正常的。`);
} else {
  console.log(
    `所有 ${results.length} 组的信息量都不超过 +2pt（最好的一组 ${best.interval}/${best.horizon} 根 ` +
      `为 ${best.edge >= 0 ? '+' : ''}${best.edge.toFixed(1)}pt）。`,
  );
  console.log('已经用了合适的尺子——短周期、短跨度、按 √跨度 缩放的阈值——仍然测不出方向性。');
  console.log('结论：主动买卖占比可以作为「刚刚发生了什么」的描述，但不构成方向信号。');
}
console.log('─'.repeat(64));
