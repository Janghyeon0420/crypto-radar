#!/usr/bin/env node
/**
 * 多周期共振评分的回测。
 *
 * 规则引擎的回测已经给过一次教训：一个看起来很合理的评分，
 * 实测可能毫无信息量。所以共振分在上线前也要先量一遍，
 * 而不是因为「多周期共振听起来很有道理」就直接用。
 *
 * 跑法：npm run backtest:resonance
 *
 * 要回答两个问题：
 *   1. 共振一致（三周期同向）时，方向命中率是否高于基线？
 *   2. 长短周期背离时，是否真的更容易走成震荡？
 */
import { fetchCandles } from '../src/lib/datasources/binance-vision.ts';
import { replayResonance, resonanceStats } from '../src/lib/indicators/backtest.ts';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT', 'DOGEUSDT'];
const HORIZON = 24; // 基准为 1h，向前看 24 根 ≈ 一天

const pct = (v) => `${v.toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);

console.log('按时间对齐重放 1h / 4h / 1d 三周期…\n');

const all = [];
for (const symbol of SYMBOLS) {
  try {
    const [h1, h4, d1] = await Promise.all([
      fetchCandles(symbol, '1h', 1000),
      fetchCandles(symbol, '4h', 1000),
      fetchCandles(symbol, '1d', 1000),
    ]);
    const obs = replayResonance(
      { interval: '1h', candles: h1 },
      [
        { interval: '4h', candles: h4 },
        { interval: '1d', candles: d1 },
      ],
      HORIZON,
    );
    all.push(...obs);
    console.log(`  ${pad(symbol, 10)} ${obs.length} 个观测`);
  } catch (err) {
    console.log(`  ${pad(symbol, 10)} 失败：${err.message}`);
  }
}

console.log(`\n合计 ${all.length} 个观测\n`);
if (all.length < 500) {
  console.error('样本太少，不足以判断。');
  process.exit(1);
}

console.log('═'.repeat(72));
console.log('各共振判定的信息量');
console.log('═'.repeat(72));
console.log(`  ${pad('判定', 14)}${pad('出现次数', 10)}${pad('命中率', 10)}${pad('基线', 10)}信息量`);
console.log('  （mixed / conflicted 的「命中」= 实际确实走成震荡）\n');

const stats = resonanceStats(all);
for (const s of stats) {
  const mark = s.edge > 2 ? '  ← 有信息量' : s.edge < -2 ? '  ← 反向' : '';
  console.log(
    `  ${pad(s.verdict, 14)}${pad(s.count, 10)}${pad(pct(s.hitRate), 10)}${pad(pct(s.baseRate), 10)}` +
      `${s.edge >= 0 ? '+' : ''}${s.edge.toFixed(1)}pt${mark}`,
  );
}

// 背离单独看一遍：它是这个功能里最具体的一个主张
const div = all.filter((o) => o.hasDivergence);
const noDiv = all.filter((o) => !o.hasDivergence);
const neutralRate = (arr) =>
  arr.length ? (arr.filter((o) => o.actual === 'neutral').length / arr.length) * 100 : 0;

console.log('\n' + '═'.repeat(72));
console.log('长短周期背离的检验');
console.log('═'.repeat(72));
console.log(`  背离时走成震荡：${pct(neutralRate(div))}（${div.length} 次）`);
console.log(`  未背离走成震荡：${pct(neutralRate(noDiv))}（${noDiv.length} 次）`);
const divEdge = neutralRate(div) - neutralRate(noDiv);
console.log(`  差值：${divEdge >= 0 ? '+' : ''}${divEdge.toFixed(1)}pt`);

// ── 两条方法学检查。不做这两步，上面的数字很容易被读成它们并不支持的结论 ──
console.log('\n' + '═'.repeat(72));
console.log('这批样本可信吗');
console.log('═'.repeat(72));

const bullBase = (all.filter((o) => o.actual === 'bullish').length / all.length) * 100;
const bearBase = (all.filter((o) => o.actual === 'bearish').length / all.length) * 100;
const skew = bullBase - bearBase;
console.log(`  实际走势本底：涨 ${pct(bullBase)} / 跌 ${pct(bearBase)} / 震荡 ${pct(neutralRate(all))}`);

if (Math.abs(skew) > 3) {
  console.log(
    `\n  ⚠️  样本区间单边偏${skew > 0 ? '涨' : '跌'} ${Math.abs(skew).toFixed(1)}pt。\n` +
      `      在这种区间里，「看${skew > 0 ? '多' : '空'}」类判定天然显得准、\n` +
      `      「看${skew > 0 ? '空' : '多'}」类天然显得差，这多半是行情本身造成的，不是信号的功劳。\n` +
      '      方向类的信息量在换一段行情后未必成立；只有不依赖方向的结论\n' +
      '      （比如「背离时更容易走震荡」）受这个偏差影响较小。',
  );
}

// 相邻观测共享 horizon-1 根 K 线，独立性远低于条数所暗示的
const effective = Math.round(all.length / HORIZON);
console.log(
  `\n  观测窗口高度重叠：${all.length} 条观测中，相邻两条共享 ${HORIZON - 1} 根 K 线，\n` +
    `  有效独立样本约 ${effective} 条。几个百分点的差距在这个量级上可能只是噪音。`,
);

console.log('\n' + '─'.repeat(72));
const best = stats.reduce((a, b) => (b.edge > a.edge ? b : a), stats[0]);
if (best.edge > 2) {
  console.log(`最有信息量的是「${best.verdict}」，比基线高 ${best.edge.toFixed(1)}pt——`);
  console.log('但请先读上面那两条检查再决定要不要相信它。');
} else {
  console.log('没有任何一种共振判定显著跑赢基线（阈值 2pt）。');
  console.log('共振分应当只作为「各周期状态是否一致」的描述，不承担预测职责。');
}
console.log('─'.repeat(72));
