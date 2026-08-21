/**
 * 置信度校准。
 *
 * 这个功能做错了不会报错，只会安静地给出一个看起来很权威的错数字——
 * 而它的用途恰恰是「要不要相信这条结论」。三类错误都必须钉死：
 *   - 小样本出数     → 2 条样本算出「校准后 0%」，被当真
 *   - 收缩方向错     → 没有证据时把分数拉向 50%，等于凭空否定模型
 *   - 分桶与面板不一致 → 结论旁写 41%、面板上写 60%，用户无从判断谁对
 */
import {
  calibrateConfidence,
  bucketOf,
  MIN_EVALUATED,
  WEAK_BELOW,
} from '../src/lib/history/calibrate.ts';

let pass = 0;
const failures = [];
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) pass++;
  else failures.push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}`);
  if (!ok) console.log(`      实际 ${JSON.stringify(actual)}  期望 ${JSON.stringify(expected)}`);
};

/** 造 n 条已评估记录，其中 hits 条正确，置信度均为 conf */
const mk = (n, hits, conf) =>
  Array.from({ length: n }, (_, i) => ({
    id: `r${i}`,
    symbol: 'BTCUSDT',
    createdAt: Date.now(),
    priceAtAnalysis: 100,
    atrPercentAtAnalysis: 2,
    analysis: { confidence: conf, direction: 'bullish' },
    evaluation: { correct: i < hits },
  }));

/** 未评估记录：不该被计入样本 */
const pending = (n, conf) =>
  Array.from({ length: n }, (_, i) => ({
    id: `p${i}`,
    symbol: 'BTCUSDT',
    createdAt: Date.now(),
    priceAtAnalysis: 100,
    atrPercentAtAnalysis: 2,
    analysis: { confidence: conf, direction: 'bullish' },
    evaluation: null,
  }));

console.log('=== 分桶必须与准确率面板一致 ===');
check('39 → 0-40', bucketOf(39), [0, 40]);
check('40 → 40-55（边界归上一档）', bucketOf(40), [40, 55]);
check('54 → 40-55', bucketOf(54), [40, 55]);
check('55 → 55-70', bucketOf(55), [55, 70]);
check('84 → 70-85', bucketOf(84), [70, 85]);
check('85 → 85-100', bucketOf(85), [85, 101]);
check('100 → 85-100', bucketOf(100), [85, 101]);

console.log('\n=== 样本不足时不出数 ===');
{
  check('完全没有记录', calibrateConfidence([], 60), {
    status: 'insufficient', evaluated: 0, needed: MIN_EVALUATED,
  });
  // 这是今天的真实处境：10 条存档、只有 2 条到期评估过
  check('2 条已评估 + 8 条待检验', calibrateConfidence([...mk(2, 0, 40), ...pending(8, 45)], 45), {
    status: 'insufficient', evaluated: 2, needed: MIN_EVALUATED - 2,
  });
  check(`差 1 条也不出数（${MIN_EVALUATED - 1} 条）`,
    calibrateConfidence(mk(MIN_EVALUATED - 1, 5, 60), 60).status, 'insufficient');
  check(`刚好 ${MIN_EVALUATED} 条才出数`,
    calibrateConfidence(mk(MIN_EVALUATED, 5, 60), 60).status, 'ok');
}

console.log('\n=== 收缩方向：没有反证就不修正 ===');
{
  // 样本命中率与自称一致时，校准值应当就是自称值
  const r = calibrateConfidence(mk(20, 12, 60), 60);
  check('实际 60% 命中、自称 60 → 仍是 60', r.calibrated, 60);

  // 模型虚高：自称 80，实际只对 40%
  const high = calibrateConfidence(mk(20, 8, 80), 80);
  check('自称 80 实际 40% → 校准值落在两者之间', high.calibrated > 40 && high.calibrated < 80, true);
  check('  且更靠近实际值而非自称值', Math.abs(high.calibrated - 40) < Math.abs(high.calibrated - 80), true);

  // 模型保守：自称 40，实际对 80%
  const low = calibrateConfidence(mk(20, 16, 40), 40);
  check('自称 40 实际 80% → 向上修正', low.calibrated > 40, true);
}

console.log('\n=== 样本越多，先验的影响越小 ===');
{
  const few = calibrateConfidence(mk(10, 0, 80), 80);
  const many = calibrateConfidence(mk(100, 0, 80), 80);
  check('同样全错，样本少时仍受自称分数拉扯', few.calibrated > many.calibrated, true);
  check('样本足够多时逼近实际命中率（全错→接近 0）', many.calibrated < 10, true);
  check('不确定度随样本增大而收窄', many.uncertainty < few.uncertainty, true);
  check('不确定度永远不为 0', many.uncertainty >= 0 && few.uncertainty > 0, true);
}

console.log('\n=== 同区间样本优先，不够则退回全部 ===');
{
  // 60 分区间有 5 条，其它区间有 20 条 → 应当只用那 5 条
  const mixed = [...mk(5, 1, 60), ...mk(20, 18, 30)];
  const r = calibrateConfidence(mixed, 60);
  check('同区间够 3 条 → scope=bucket', r.scope, 'bucket');
  check('  样本量为区间内条数', r.sampleSize, 5);

  // 60 分区间只有 2 条 → 退回全部样本
  const sparse = [...mk(2, 0, 60), ...mk(20, 18, 30)];
  const r2 = calibrateConfidence(sparse, 60);
  check('同区间不足 3 条 → scope=all', r2.scope, 'all');
  check('  样本量为全部已评估条数', r2.sampleSize, 22);
}

console.log('\n=== 参考性弱的标记 ===');
{
  check(`${MIN_EVALUATED} 条 → weak`, calibrateConfidence(mk(MIN_EVALUATED, 5, 60), 60).weak, true);
  check(`${WEAK_BELOW - 1} 条 → weak`, calibrateConfidence(mk(WEAK_BELOW - 1, 15, 60), 60).weak, true);
  check(`${WEAK_BELOW} 条 → 不再标记`, calibrateConfidence(mk(WEAK_BELOW, 15, 60), 60).weak, false);
}

console.log('\n=== 异常输入不该产生离谱结果 ===');
{
  const zero = calibrateConfidence(mk(20, 10, 0), 0);
  check('自称 0 分', zero.calibrated >= 0 && zero.calibrated <= 100, true);
  const hundred = calibrateConfidence(mk(20, 10, 100), 100);
  check('自称 100 分', hundred.calibrated >= 0 && hundred.calibrated <= 100, true);
  const nan = calibrateConfidence(mk(20, 10, 60), NaN);
  check('自称值为 NaN 时不产生 NaN', Number.isFinite(nan.calibrated), true);
}

console.log(`\n通过 ${pass} / 失败 ${failures.length}`);
process.exit(failures.length ? 1 : 0);
