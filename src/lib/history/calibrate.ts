/**
 * 用历史命中率校准模型自称的置信度。
 *
 * 动机：准确率面板已经能算出「模型说 75 分时实际只对 50%」这类偏差，
 * 但那张表要主动去翻。真正需要这个信息的时刻是**正在看一条研判结论**的时候——
 * 让两个已有的模块互相知道对方的存在，不需要改模型、不需要加数据。
 *
 * 这个功能做错的方式比做对的方式多，所以先说清三条原则：
 *
 * 1. **没有证据时不做修正。** 校准值向模型自称的分数收缩，
 *    而不是向 50% 或向基线收缩。样本为零时校准值 = 原分数，
 *    表示「暂时没有理由认为你说得不对」，而不是「你说的都不算数」。
 *
 * 2. **小样本不出数。** 2 条样本能算出「校准后 0%」，那个数字毫无意义，
 *    但显示出来会被当真。样本不够就明说不够，并告诉还差多少。
 *
 * 3. **永远带着不确定度一起显示。** 「41%」看起来像个结论，
 *    「41% ± 14%」才诚实地表达了它其实是一团糊。
 */

import type { AnalysisRecord, Evaluation } from './types';

/** 少于这么多条已评估记录，一律不出校准值 */
export const MIN_EVALUATED = 10;

/** 少于这么多条，出值但标记为参考性弱 */
export const WEAK_BELOW = 30;

/** 同置信度区间内至少要有这么多条，才用区间内数据；否则退回全部样本 */
const MIN_BUCKET = 3;

/**
 * 先验强度（相当于多少条虚拟样本）。
 *
 * 取 8：需要约 8 条真实样本，证据的权重才追平模型的自称分数；
 * 到 30 条时证据占 79%。这个数字决定了「多快开始相信数据而不是模型」，
 * 调大更保守、调小更激进。
 */
const PRIOR_STRENGTH = 8;

export type Calibration =
  | {
      status: 'insufficient';
      evaluated: number;
      /** 还差多少条 */
      needed: number;
    }
  | {
      status: 'ok';
      /** 模型自称的置信度 */
      stated: number;
      /** 校准后的置信度 */
      calibrated: number;
      /** 后验标准差，用于显示「±X」 */
      uncertainty: number;
      /** 本次校准用了多少条样本 */
      sampleSize: number;
      /** 用的是同区间样本还是全部样本 */
      scope: 'bucket' | 'all';
      /** 样本量仍偏少，结论参考性弱 */
      weak: boolean;
    };

type Evaluated = AnalysisRecord & { evaluation: Evaluation };

const isEvaluated = (r: AnalysisRecord): r is Evaluated => r.evaluation !== null;

/**
 * 置信度分区间。与 evaluate.ts 的 CONFIDENCE_BUCKETS 保持一致：
 * 两边用不同的分桶会让面板上的校准表和结论旁的校准值对不上，
 * 而用户没有任何办法看出是哪边错了。
 */
export function bucketOf(confidence: number): [min: number, max: number] {
  if (confidence < 40) return [0, 40];
  if (confidence < 55) return [40, 55];
  if (confidence < 70) return [55, 70];
  if (confidence < 85) return [70, 85];
  return [85, 101];
}

/**
 * 计算校准后的置信度。
 *
 * 用 Beta 后验的均值：先验中心取模型自称的分数、强度 PRIOR_STRENGTH，
 * 再用同区间（或全部）已评估样本的命中情况更新。
 */
export function calibrateConfidence(
  records: AnalysisRecord[],
  statedConfidence: number,
): Calibration {
  const evaluated = records.filter(isEvaluated);

  if (evaluated.length < MIN_EVALUATED) {
    return {
      status: 'insufficient',
      evaluated: evaluated.length,
      needed: MIN_EVALUATED - evaluated.length,
    };
  }

  const [min, max] = bucketOf(statedConfidence);
  const inBucket = evaluated.filter(
    (r) => r.analysis.confidence >= min && r.analysis.confidence < max,
  );

  // 同区间样本够就用它——不同置信度区间的偏差方向可能相反，
  // 混在一起算会把「高分虚高、低分保守」这种结构抹平
  const useBucket = inBucket.length >= MIN_BUCKET;
  const sample = useBucket ? inBucket : evaluated;

  const n = sample.length;
  const hits = sample.filter((r) => r.evaluation.correct).length;

  const prior = clamp01(statedConfidence / 100);
  const posterior = (hits + prior * PRIOR_STRENGTH) / (n + PRIOR_STRENGTH);

  // Beta 后验的标准差。样本越多越窄，但永远不会是 0
  const alpha = hits + prior * PRIOR_STRENGTH;
  const beta = n - hits + (1 - prior) * PRIOR_STRENGTH;
  const variance = (alpha * beta) / ((alpha + beta) ** 2 * (alpha + beta + 1));

  return {
    status: 'ok',
    stated: statedConfidence,
    calibrated: Math.round(posterior * 100),
    uncertainty: Math.round(Math.sqrt(variance) * 100),
    sampleSize: n,
    scope: useBucket ? 'bucket' : 'all',
    weak: evaluated.length < WEAK_BELOW,
  };
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : 0.5);
