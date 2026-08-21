#!/usr/bin/env node
/**
 * 规则引擎权重回测。
 *
 * summary.ts 里那几个权重原本是拍脑袋定的。规则引擎是确定性的，
 * 所以不必像 LLM 研判那样等样本慢慢攒——直接在历史 K 线上逐根重放即可。
 *
 * 跑法：npm run backtest
 *       npm run backtest -- --apply    把测得的权重写回 summary.ts
 *
 * 方法：
 *   1. 多个币种 × 多个周期上逐根重放，记录每根触发了哪些信号、之后实际怎么走
 *   2. 按时间切 70/30。**只用前 70% 推权重**，后 30% 从不参与推导
 *   3. 在后 30% 上比较「原权重 / 新权重 / 无脑基线」三者
 *
 * 第 2 步是这份脚本里唯一不可省略的纪律：用全部数据推权重再用全部数据验证，
 * 一定会得出「新权重更好」的结论，而那个结论毫无意义。
 */
import { fetchCandles } from '../src/lib/datasources/binance-vision.ts';
import {
  replay,
  signalStats,
  deriveWeights,
  scorecard,
} from '../src/lib/indicators/backtest.ts';
import { SIGNAL_WEIGHTS } from '../src/lib/indicators/summary.ts';
import { writeFile, readFile } from 'node:fs/promises';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'LINKUSDT', 'DOGEUSDT'];

/**
 * 周期与检验跨度的搭配。跨度要贴近该周期的实际用途：
 * 1h 图上关心的是未来一天，日线图上关心的是未来一周。
 */
const SETUPS = [
  { interval: '1h', horizon: 24, limit: 1000 },
  { interval: '4h', horizon: 12, limit: 1000 },
  { interval: '1d', horizon: 7, limit: 1000 },
];

const pct = (v) => `${v.toFixed(1)}%`;
const pad = (s, n) => String(s).padEnd(n);

console.log('拉取历史数据并逐根重放…\n');

const train = [];
const test = [];

for (const setup of SETUPS) {
  let obsForSetup = 0;
  for (const symbol of SYMBOLS) {
    let candles;
    try {
      candles = await fetchCandles(symbol, setup.interval, setup.limit);
    } catch (err) {
      console.log(`  ${pad(symbol, 10)} ${setup.interval}  拉取失败：${err.message}`);
      continue;
    }
    const obs = replay(candles, setup.interval, setup.horizon);
    // 按时间切分：训练集在前、测试集在后，避免用未来的行情推权重
    const cut = Math.floor(obs.length * 0.7);
    train.push(...obs.slice(0, cut));
    test.push(...obs.slice(cut));
    obsForSetup += obs.length;
  }
  console.log(`  ${setup.interval} 周期（向前看 ${setup.horizon} 根）：${obsForSetup} 个观测`);
}

console.log(`\n训练集 ${train.length} 条 · 测试集 ${test.length} 条\n`);

if (train.length < 500) {
  console.error('样本太少，不足以推导权重。检查网络或数据源。');
  process.exit(1);
}

// ── 各信号的信息量 ──
console.log('═'.repeat(72));
console.log('各信号相对基线的信息量（训练集）');
console.log('═'.repeat(72));
console.log(`  ${pad('信号', 18)}${pad('出现次数', 10)}${pad('命中率', 10)}${pad('基线', 10)}信息量`);
const stats = signalStats(train);
for (const s of stats) {
  const mark = s.edge > 2 ? '  ← 有效' : s.edge < -2 ? '  ← 反向' : '';
  console.log(
    `  ${pad(s.id, 18)}${pad(s.count, 10)}${pad(pct(s.hitRate), 10)}${pad(pct(s.baseRate), 10)}` +
      `${s.edge >= 0 ? '+' : ''}${s.edge.toFixed(1)}pt${mark}`,
  );
}

// ── 推导权重 ──
const derived = deriveWeights(stats);
console.log('\n' + '═'.repeat(72));
console.log('权重对比');
console.log('═'.repeat(72));
console.log(`  ${pad('信号', 18)}${pad('原权重', 10)}新权重`);
for (const id of Object.keys(SIGNAL_WEIGHTS)) {
  const before = SIGNAL_WEIGHTS[id];
  const after = derived[id];
  const arrow = after > before ? '↑' : after < before ? '↓' : '=';
  console.log(`  ${pad(id, 18)}${pad(before, 10)}${after}  ${arrow}`);
}

// ── 在从未参与推导的测试集上比较 ──
const oldCard = scorecard(test, SIGNAL_WEIGHTS);
const newCard = scorecard(test, derived);

console.log('\n' + '═'.repeat(72));
console.log('测试集表现（这部分数据从未参与推导权重）');
console.log('═'.repeat(72));
console.log(`  ${pad('', 20)}${pad('整体命中率', 14)}${pad('表态时命中', 14)}${pad('表态比例', 12)}`);
console.log(`  ${pad('原权重', 20)}${pad(pct(oldCard.overallHitRate), 14)}${pad(pct(oldCard.directionalHitRate), 14)}${pad(pct(oldCard.directionalRate), 12)}`);
console.log(`  ${pad('新权重', 20)}${pad(pct(newCard.overallHitRate), 14)}${pad(pct(newCard.directionalHitRate), 14)}${pad(pct(newCard.directionalRate), 12)}`);
console.log(`  ${pad('无脑全猜震荡', 20)}${pad(pct(oldCard.alwaysNeutralHitRate), 14)}`);
console.log(
  `\n  引擎表态的那批样本里，实际走出震荡的占 ` +
    `${pct(oldCard.neutralRateWhenDirectional)}（原权重）/ ${pct(newCard.neutralRateWhenDirectional)}（新权重）`,
);

// 只用三分类整体命中率做判定：它对覆盖率免疫，两套权重可比
const delta = newCard.overallHitRate - oldCard.overallHitRate;
const beatsBaseline = newCard.overallHitRate > newCard.alwaysNeutralHitRate;

console.log('\n' + '─'.repeat(72));
if (delta > 0.5) {
  console.log(`新权重整体命中率高出 ${delta.toFixed(1)}pt。`);
} else if (delta < -0.5) {
  console.log(`新权重整体命中率低了 ${Math.abs(delta).toFixed(1)}pt，不应采用。`);
} else {
  console.log(`两套权重整体命中率差异不足 0.5pt（${delta >= 0 ? '+' : ''}${delta.toFixed(1)}pt），谈不上改进。`);
}
if (!beatsBaseline) {
  console.log(
    '\n⚠️  比权重更要紧的结论：规则引擎跑不赢「无脑全猜震荡」这个基线。\n' +
      '    这说明它在本样本上不具备方向预测价值，调权重解决不了这件事。\n' +
      '    它仍然是有用的——作为「当前技术面处于什么状态」的透明描述——\n' +
      '    但不该被当作方向判断依据，也不该作为 LLM 的对照基线来用。',
  );
}
console.log('─'.repeat(72));

if (process.argv.includes('--apply')) {
  // 两道闸门缺一不可。
  // 只看 delta 是不够的：一套「几乎不表态」的权重能靠沉默把整体命中率顶上去，
  // 那不是校准，是把功能悄悄关掉——必须同时要求跑赢基线。
  if (delta <= 0.5) {
    console.error('\n测试集未显示改进，拒绝写回。');
    process.exit(1);
  }
  if (!beatsBaseline) {
    console.error(
      '\n拒绝写回：新权重仍跑不赢「无脑全猜震荡」。\n' +
        '整体命中率的提升若来自「更少表态」，那是沉默换来的，不是预测力换来的。',
    );
    process.exit(1);
  }
  const p = new URL('../src/lib/indicators/summary.ts', import.meta.url).pathname;
  let src = await readFile(p, 'utf8');
  const block = `export const SIGNAL_WEIGHTS: Record<SignalId, number> = {
${Object.entries(derived).map(([k, v]) => `  ${k}: ${v},`).join('\n')}
};`;
  src = src.replace(/export const SIGNAL_WEIGHTS: Record<SignalId, number> = \{[\s\S]*?\};/, block);
  src = src.replace(
    /export const WEIGHTS_MEASURED_AT = '[^']*';/,
    `export const WEIGHTS_MEASURED_AT = '${new Date().toISOString().slice(0, 10)}';`,
  );
  await writeFile(p, src);
  console.log('\n已写回 summary.ts');
}
