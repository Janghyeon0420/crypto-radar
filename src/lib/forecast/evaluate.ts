import type { Candle, Interval } from '../datasources/types';
import { INTERVALS } from '../datasources/types';
import { directionFor, validCandle } from './engine';
import { INTERVAL_MS, type ForecastEvaluation, type ForecastRecord, type ForecastStats } from './types';

/** 必须有每个目标时间的已收盘 K 线；缺口和尚未到期都不能被算成预测失败。 */
export function evaluateForecast(record: ForecastRecord, actual: Candle[], now = Date.now()): ForecastEvaluation | null {
  if (now < record.targetEndTime) return null;
  const dt = INTERVAL_MS[record.interval];
  const byTime = new Map<number, Candle>();
  for (const candle of actual) {
    if (byTime.has(candle.time)) return null;
    byTime.set(candle.time, candle);
  }
  const matched: Candle[] = [];
  for (const predicted of record.candles) {
    const candle = byTime.get(predicted.time);
    if (!candle || !validCandle(candle) || candle.time + dt > now) return null;
    matched.push(candle);
  }
  const n = matched.length;
  const closeMape = matched.reduce((sum, c, i) => sum + Math.abs(c.close - record.candles[i].close) / c.close * 100, 0) / n;
  const baselineMape = matched.reduce((sum, c) => sum + Math.abs(c.close - record.anchorPrice) / c.close * 100, 0) / n;
  const actualClose = matched[n - 1].close;
  const actualDirection = directionFor((actualClose / record.anchorPrice - 1) * 100, record.thresholdPercent);
  return {
    evaluatedAt: now, actualDirection, correct: actualDirection === record.direction, actualClose,
    closeMape, baselineMape, skillScore: baselineMape > 0 ? (1 - closeMape / baselineMape) * 100 : null,
    boundCoverage: matched.filter((c, i) => c.close >= record.candles[i].lower && c.close <= record.candles[i].upper).length / n * 100,
    actualCandles: matched,
  };
}

export function computeForecastStats(records: ForecastRecord[]): ForecastStats {
  const evaluated = records.filter((r): r is ForecastRecord & { evaluation: ForecastEvaluation } => r.evaluation !== null);
  const n = evaluated.length;
  const correct = evaluated.filter(r => r.evaluation.correct).length;
  const mean = (key: 'closeMape' | 'baselineMape' | 'boundCoverage') => n ? evaluated.reduce((sum, r) => sum + r.evaluation[key], 0) / n : null;
  const meanCloseMape = mean('closeMape');
  const meanBaselineMape = mean('baselineMape');
  return {
    total: records.length, evaluated: n, pending: records.length - n, correct,
    hitRate: n ? correct / n * 100 : null, meanCloseMape, meanBaselineMape,
    meanBoundCoverage: mean('boundCoverage'),
    skillScore: meanBaselineMape && meanCloseMape !== null ? (1 - meanCloseMape / meanBaselineMape) * 100 : null,
    byInterval: INTERVALS.map((interval: Interval) => {
      const group = evaluated.filter(r => r.interval === interval);
      return { interval, evaluated: group.length, hitRate: group.length ? group.filter(r => r.evaluation.correct).length / group.length * 100 : null };
    }),
  };
}
