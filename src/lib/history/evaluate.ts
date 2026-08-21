/**
 * 研判准确率评估。
 *
 * 评估的诚实性比评估的"好看"重要得多，所以这里有几个刻意的选择：
 *   - 阈值由标的自身的 ATR 推导，而不是固定百分比。否则高波动币种会被
 *     判定为"总是判断正确"（因为它总在大涨大跌），低波动币种则相反。
 *   - 同时记录一个"永远猜震荡/永远猜涨"的基线。模型跑不赢基线就是没价值，
 *     这个对比必须自动摆在眼前，而不是等人想起来算。
 */

import { fetchCandles } from '../datasources/binance-vision';
import { readRecords, updateRecords } from './store';
import type { AnalysisRecord, AccuracyStats, Evaluation } from './types';
import { HORIZON_MS } from './types';

/**
 * 判定"有效波动"的阈值。
 *
 * 导出供规则引擎回测复用：两边若各写一套定义，
 * 「面板上的命中率」和「回测出的命中率」会对不上，而用户无从判断谁对。
 * 取研判当时 ATR% 的 1 倍，并夹在 1%~10% 之间——
 * ATR 极小时阈值太松会把噪音算成方向正确，极大时太严则永远判不对。
 */
export function thresholdFor(atrPercent: number): number {
  if (!Number.isFinite(atrPercent) || atrPercent <= 0) return 2;
  return Math.min(Math.max(atrPercent, 1), 10);
}

/** 某条记录是否已到检验时点 */
export function isDue(record: AnalysisRecord): boolean {
  const horizon = HORIZON_MS[record.analysis.timeframe];
  return Date.now() >= record.createdAt + horizon;
}

/**
 * 对一条到期记录做评估。
 * 拉取研判时点之后到检验时点之间的日线，取区间末价与区间高低点。
 */
export async function evaluateRecord(record: AnalysisRecord): Promise<Evaluation | null> {
  const horizon = HORIZON_MS[record.analysis.timeframe];
  const endTime = record.createdAt + horizon;

  // 日内用小时线，中长期用日线，保证区间内有足够的采样点
  const interval = record.analysis.timeframe === 'intraday' ? '1h' : '1d';
  const candles = await fetchCandles(record.symbol, interval, 500);

  const window = candles.filter((c) => c.time >= record.createdAt && c.time <= endTime);
  if (window.length === 0) return null;

  const priceAtHorizon = window[window.length - 1].close;
  const highDuring = Math.max(...window.map((c) => c.high));
  const lowDuring = Math.min(...window.map((c) => c.low));

  const changePercent = ((priceAtHorizon - record.priceAtAnalysis) / record.priceAtAnalysis) * 100;
  const thresholdPercent = thresholdFor(record.atrPercentAtAnalysis);

  const actualDirection =
    changePercent > thresholdPercent
      ? 'bullish'
      : changePercent < -thresholdPercent
        ? 'bearish'
        : 'neutral';

  const invalidation = record.analysis.levels.invalidation;
  // 失效价在现价之上还是之下，决定了"触及"是向上突破还是向下跌破
  const invalidationHit = Number.isFinite(invalidation)
    ? invalidation > record.priceAtAnalysis
      ? highDuring >= invalidation
      : lowDuring <= invalidation
    : false;

  return {
    evaluatedAt: Date.now(),
    priceAtHorizon,
    changePercent,
    thresholdPercent,
    actualDirection,
    correct: actualDirection === record.analysis.direction,
    invalidationHit,
    highDuring,
    lowDuring,
  };
}

/** 批量评估所有到期但未评估的记录 */
export async function evaluatePending(records: AnalysisRecord[]): Promise<AnalysisRecord[]> {
  const pending = records.filter((r) => !r.evaluation && isDue(r));
  if (pending.length === 0) return records;

  // 按币种分组能大幅减少请求数——同一币种的多条记录共用一次 K 线拉取的可能性很高，
  // 但为保持逻辑简单这里仍逐条评估，只是限制并发避免打爆上游
  const results = new Map<string, Evaluation | null>();
  const CONCURRENCY = 4;
  for (let i = 0; i < pending.length; i += CONCURRENCY) {
    const batch = pending.slice(i, i + CONCURRENCY);
    const evals = await Promise.all(
      batch.map((r) => evaluateRecord(r).catch(() => null)),
    );
    batch.forEach((r, idx) => results.set(r.id, evals[idx]));
  }

  return records.map((r) => {
    const evaluation = results.get(r.id);
    return evaluation ? { ...r, evaluation } : r;
  });
}

/**
 * 读取存档 → 评估到期记录 → 有变更才写盘。
 *
 * 抽成一个函数是因为有两个调用方：打开准确率面板时（`/api/analysis/history`），
 * 以及常驻 worker 定期调用。两边各写一遍「有没有变化」的判断，
 * 迟早会漂移成两种行为——而这种漂移的表现是「有时候评估了有时候没有」，
 * 极难查。
 *
 * @returns 本次新产生的评估条数
 */
export async function evaluateDueRecords(): Promise<number> {
  const records = await readRecords();
  const updated = await evaluatePending(records);

  const changed = updated.filter((r, i) => r.evaluation !== records[i].evaluation).length;
  // 没有新评估就不写盘，避免每次打开页面都无谓地重写文件
  if (changed > 0) await updateRecords(() => updated);
  return changed;
}

const CONFIDENCE_BUCKETS = [
  { label: '0-40', min: 0, max: 40 },
  { label: '40-55', min: 40, max: 55 },
  { label: '55-70', min: 55, max: 70 },
  { label: '70-85', min: 70, max: 85 },
  { label: '85-100', min: 85, max: 101 },
];

export function computeStats(records: AnalysisRecord[]): AccuracyStats {
  const evaluated = records.filter(
    (r): r is AnalysisRecord & { evaluation: Evaluation } => r.evaluation !== null,
  );
  const correct = evaluated.filter((r) => r.evaluation.correct).length;

  const calibration = CONFIDENCE_BUCKETS.map((b) => {
    const inBucket = evaluated.filter(
      (r) => r.analysis.confidence >= b.min && r.analysis.confidence < b.max,
    );
    return {
      bucket: b.label,
      count: inBucket.length,
      avgConfidence: inBucket.length
        ? inBucket.reduce((a, r) => a + r.analysis.confidence, 0) / inBucket.length
        : 0,
      hitRate: inBucket.length
        ? (inBucket.filter((r) => r.evaluation.correct).length / inBucket.length) * 100
        : 0,
    };
  });

  const byDirection = (['bullish', 'bearish', 'neutral'] as const).map((direction) => {
    const subset = evaluated.filter((r) => r.analysis.direction === direction);
    return {
      direction,
      count: subset.length,
      hitRate: subset.length
        ? (subset.filter((r) => r.evaluation.correct).length / subset.length) * 100
        : 0,
    };
  });

  // 基线：如果每次都无脑猜同一个方向，能对多少
  const alwaysNeutral = evaluated.length
    ? (evaluated.filter((r) => r.evaluation.actualDirection === 'neutral').length /
        evaluated.length) *
      100
    : 0;
  const alwaysBullish = evaluated.length
    ? (evaluated.filter((r) => r.evaluation.actualDirection === 'bullish').length /
        evaluated.length) *
      100
    : 0;

  return {
    total: records.length,
    evaluated: evaluated.length,
    pending: records.length - evaluated.length,
    correct,
    hitRate: evaluated.length ? (correct / evaluated.length) * 100 : 0,
    calibration,
    byDirection,
    invalidationRate: evaluated.length
      ? (evaluated.filter((r) => r.evaluation.invalidationHit).length / evaluated.length) * 100
      : 0,
    baseline: { alwaysNeutral, alwaysBullish },
  };
}
