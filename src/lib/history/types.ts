/**
 * 研判历史与准确率评估的数据结构。
 *
 * 存在的意义：任何"预测"如果不记录、不回头检验，就没法判断它值不值得信。
 * 这套结构的目标是让"这个模型到底准不准"变成一个可以查的数字，
 * 而不是一种感觉。
 */

import type { Analysis } from '../analysis/schema';

/** 不同时间尺度对应的检验周期。研判说的是几天内的事，就该在几天后检验。 */
export const HORIZON_MS = {
  intraday: 24 * 3600_000,
  short: 7 * 24 * 3600_000,
  medium: 30 * 24 * 3600_000,
} as const;

export interface AnalysisRecord {
  id: string;
  symbol: string;
  createdAt: number;
  /** 研判当时的价格，是后续一切评估的基准点 */
  priceAtAnalysis: number;
  /**
   * 研判当时的日线 ATR 占价格百分比。
   * 用它作为"有效波动"的阈值，而不是固定 2%——
   * BTC 的 2% 和某个山寨币的 2% 完全不是一回事。
   */
  atrPercentAtAnalysis: number;
  analysis: Analysis;
  evaluation: Evaluation | null;
  /**
   * 本次研判实际耗时（毫秒）。
   * 用途是给下一次研判一个**有依据的等待预期**——
   * 「通常 23-95 秒」这种范围太宽，等于没说；「上次用了 47 秒」才有用。
   */
  durationMs?: number;
}

export interface Evaluation {
  evaluatedAt: number;
  /** 检验时点的价格 */
  priceAtHorizon: number;
  /** 相对研判时价格的涨跌幅 % */
  changePercent: number;
  /** 判定为"有效波动"的阈值 %，由 ATR 推导 */
  thresholdPercent: number;
  /** 实际走势方向 */
  actualDirection: 'bullish' | 'bearish' | 'neutral';
  /** 方向是否判断正确 */
  correct: boolean;
  /** 期间是否触及失效价——触及说明研判前提已被证伪 */
  invalidationHit: boolean;
  /** 期间最高/最低价，用于判断失效价是否被触及 */
  highDuring: number;
  lowDuring: number;
}

export interface AccuracyStats {
  total: number;
  evaluated: number;
  pending: number;
  correct: number;
  /** 总体命中率 */
  hitRate: number;
  /**
   * 按置信度分桶的实际命中率。
   * 这是最有价值的一张表：如果模型说 80 分的时候实际只对 50%，
   * 那它的置信度就是不可信的，需要在使用时打折。
   */
  calibration: {
    bucket: string;
    count: number;
    avgConfidence: number;
    hitRate: number;
  }[];
  /** 按方向拆分——很多模型有系统性看多倾向，拆开才看得出来 */
  byDirection: {
    direction: string;
    count: number;
    hitRate: number;
  }[];
  /** 失效价被触及的比例 */
  invalidationRate: number;
  /**
   * 与"永远猜震荡"这个基线的对比。
   * 如果模型跑不赢一个不动脑子的基线，那它就没有产生价值。
   */
  baseline: {
    /** 全猜 neutral 的命中率 */
    alwaysNeutral: number;
    /** 全猜 bullish 的命中率 */
    alwaysBullish: number;
  };
}
