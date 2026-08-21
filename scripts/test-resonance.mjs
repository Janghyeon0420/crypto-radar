/**
 * 多周期共振与回测统计。
 *
 * 这批纯函数错了不会抛异常，只会给出一个看起来合理的数字——
 * 开发过程中就真的踩过一次：`scorecard` 最初只统计「引擎表态时的命中率」，
 * 却拿去和「全部样本上无脑猜震荡」比，分母不同却当成可比，
 * 差点据此得出「新权重值得采用」的错误结论。
 */
import { computeResonance } from '../src/lib/indicators/resonance.ts';
import { signalStats, deriveWeights, scorecard, resonanceStats } from '../src/lib/indicators/backtest.ts';
import { SIGNAL_WEIGHTS } from '../src/lib/indicators/summary.ts';

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
};

const snap = (interval, bias) => ({ interval, bias, price: 100 });

console.log('=== 共振方向与一致性 ===');
{
  const all = computeResonance([snap('1h', 'bullish'), snap('4h', 'bullish'), snap('1d', 'bullish')]);
  check('三周期同向看多 → bullish', all.verdict, 'bullish');
  check('  共振分为满分 +100', all.score, 100);
  check('  一致性 100%', all.agreement, 100);

  const bear = computeResonance([snap('1h', 'bearish'), snap('4h', 'bearish'), snap('1d', 'bearish')]);
  check('三周期同向看空 → bearish', bear.verdict, 'bearish');
  check('  共振分为 -100', bear.score, -100);

  const flat = computeResonance([snap('1h', 'neutral'), snap('4h', 'neutral'), snap('1d', 'neutral')]);
  check('全部中性 → mixed', flat.verdict, 'mixed');
  check('  共振分为 0', flat.score, 0);
  // 全中性是一种「高度一致」的状态，只是一致地没方向；
  // 把 neutral 计入分母会让它显示成低一致性，那是误导
  check('  一致性仍为 100%（一致地没方向）', flat.agreement, 100);
}

console.log('\n=== 摘要文案必须与实际状态相符 ===');
{
  // 曾经的 bug：1d 明明是中性，摘要却写「3 个周期偏多」
  const mixed = computeResonance([snap('1h', 'bullish'), snap('4h', 'bullish'), snap('1d', 'neutral')]);
  check('两多一中 → 摘要写 2/3 而不是 3', mixed.summary.includes('2/3'), true);
  check('  并说明另一个是中性', mixed.summary.includes('1 个中性'), true);
  const allBull = computeResonance([snap('1h', 'bullish'), snap('4h', 'bullish'), snap('1d', 'bullish')]);
  check('三个全偏多 → 不画蛇添足说「另 0 个中性」', allBull.summary.includes('中性'), false);
}

console.log('\n=== 长短背离必须被单独标出 ===');
{
  const div = computeResonance([snap('1h', 'bullish'), snap('4h', 'bullish'), snap('1d', 'bearish')]);
  check('最短偏多、最长偏空 → conflicted', div.verdict, 'conflicted');
  check('  给出背离描述', div.divergence !== null, true);
  check('  描述里点明是哪两个周期', div.divergence.includes('1h') && div.divergence.includes('1d'), true);

  // 即使多数周期看多，与主趋势相反也不该报成 bullish——
  // 那正是最容易亏钱的一种情形
  check('  不因多数看多而报 bullish', div.verdict !== 'bullish', true);

  const midOnly = computeResonance([snap('1h', 'bullish'), snap('4h', 'bearish'), snap('1d', 'bullish')]);
  check('仅中间周期相反 → 不算背离', midOnly.divergence, null);

  const withNeutral = computeResonance([snap('1h', 'neutral'), snap('4h', 'bullish'), snap('1d', 'bearish')]);
  check('端点有一个中性 → 不算背离', withNeutral.divergence, null);
}

console.log('\n=== 长周期权重更高 ===');
{
  const r = computeResonance([snap('1h', 'bearish'), snap('1d', 'bullish')]);
  check('1h 空 + 1d 多 → 分数偏多（日线权重更大）', r.score > 0, true);
  const r2 = computeResonance([snap('1h', 'bullish'), snap('1d', 'bearish')]);
  check('反过来 → 分数偏空', r2.score < 0, true);
}

console.log('\n=== 边界 ===');
{
  check('空数组 → null', computeResonance([]), null);
  const one = computeResonance([snap('1d', 'bullish')]);
  check('单周期不构成背离', one.divergence, null);
  check('单周期看多 → 分数 +100', one.score, 100);
}

console.log('\n=== 信号信息量必须减去基线 ===');
{
  // 全样本都在涨：一个「永远看多」的信号命中率 100%，但信息量应为 0
  const obs = Array.from({ length: 100 }, () => ({
    signals: [{ id: 'ma_alignment', direction: 'bullish' }],
    bias: 'bullish',
    actual: 'bullish',
    changePercent: 5,
  }));
  const [s] = signalStats(obs);
  check('命中率 100%', s.hitRate, 100);
  check('但基线也是 100%', s.baseRate, 100);
  check('  所以信息量为 0（没有跑赢行情本身）', s.edge, 0);
}

console.log('\n=== 权重推导 ===');
{
  const stats = [
    { id: 'ma_alignment', count: 500, hitRate: 60, baseRate: 40, edge: 20 },
    { id: 'macd_cross', count: 500, hitRate: 45, baseRate: 40, edge: 5 },
    { id: 'rsi_extreme', count: 500, hitRate: 30, baseRate: 40, edge: -10 },
  ];
  const w = deriveWeights(stats);
  check('负信息量的信号权重归零（不反转使用）', w.rsi_extreme, 0);
  check('信息量大的权重更高', w.ma_alignment > w.macd_cross, true);
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  check('总权重仍为 6（±0.1），bias 阈值无需跟着改', Math.abs(total - 6) < 0.1, true);

  // 样本少的信号要打折，否则偶然出现三次全中就能拿到高权重
  const few = deriveWeights([
    { id: 'ma_alignment', count: 200, hitRate: 60, baseRate: 40, edge: 20 },
    { id: 'macd_cross', count: 10, hitRate: 60, baseRate: 40, edge: 20 },
  ]);
  check('同样的信息量，样本少的权重更低', few.macd_cross < few.ma_alignment, true);

  // 全部信号都测不出价值时，保留原权重而不是清零——
  // 清零会让引擎对任何行情都输出 neutral，等于悄悄关掉功能
  const none = deriveWeights([{ id: 'ma_alignment', count: 500, hitRate: 30, baseRate: 40, edge: -10 }]);
  check('全部无价值时保留原权重', none.ma_alignment, SIGNAL_WEIGHTS.ma_alignment);
}

console.log('\n=== 打分卡：整体命中率必须对覆盖率免疫 ===');
{
  // 50 条实际震荡、25 条涨、25 条跌
  const obs = [
    ...Array.from({ length: 50 }, () => ({ signals: [], bias: 'neutral', actual: 'neutral', changePercent: 0 })),
    ...Array.from({ length: 25 }, () => ({
      signals: [{ id: 'ma_alignment', direction: 'bullish' }], bias: 'bullish', actual: 'bullish', changePercent: 5,
    })),
    ...Array.from({ length: 25 }, () => ({
      signals: [{ id: 'ma_alignment', direction: 'bearish' }], bias: 'bearish', actual: 'bearish', changePercent: -5,
    })),
  ];
  // 权重 2 ≥ 阈值 2，单个信号即可表态
  const card = scorecard(obs, SIGNAL_WEIGHTS);
  check('整体命中率把 neutral 也算作一次预测', card.overallHitRate, 100);
  check('全猜震荡的命中率', card.alwaysNeutralHitRate, 50);
  check('表态比例', card.directionalRate, 50);

  // 一套「从不表态」的权重：整体命中率应等于全猜震荡，不该显得更好
  const mute = scorecard(obs, { ...SIGNAL_WEIGHTS, ma_alignment: 0 });
  check('从不表态时整体命中率 = 全猜震荡', mute.overallHitRate, mute.alwaysNeutralHitRate);
  check('  且表态比例为 0', mute.directionalRate, 0);
}

console.log('\n=== 共振统计：mixed/conflicted 按「走成震荡」算命中 ===');
{
  const obs = [
    { verdict: 'conflicted', score: 0, agreement: 50, hasDivergence: true, actual: 'neutral' },
    { verdict: 'conflicted', score: 0, agreement: 50, hasDivergence: true, actual: 'bullish' },
    { verdict: 'bullish', score: 80, agreement: 100, hasDivergence: false, actual: 'bullish' },
    { verdict: 'bullish', score: 80, agreement: 100, hasDivergence: false, actual: 'neutral' },
  ];
  const stats = resonanceStats(obs);
  const conf = stats.find((s) => s.verdict === 'conflicted');
  const bull = stats.find((s) => s.verdict === 'bullish');
  check('conflicted 命中率按震荡算', conf.hitRate, 50);
  check('bullish 命中率按看涨算', bull.hitRate, 50);
  check('未出现的判定不列入', stats.some((s) => s.verdict === 'bearish'), false);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
