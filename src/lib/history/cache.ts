/**
 * 研判结果复用判定。
 *
 * 动机：每次研判都是一次真实付费调用（实测 23-95 秒不等），
 * 而几分钟内的行情变化通常不足以改变结论——反复点同一个币纯属重复付费。
 *
 * 判定思路：只有当「价格没怎么动」且「距上次研判不久」时才复用。
 * 关键在于「没怎么动」必须相对标的自身的波动率来衡量：
 * BTC 波动 1% 和某个山寨币波动 1% 完全不是一回事。
 * 这里直接复用上次研判时记录的 ATR%，它正是当时的波动率基准。
 */

import type { AnalysisRecord } from './types';

export interface CachePolicy {
  /** 超过这个时长一律重新研判，无论价格动没动 */
  maxAgeMs: number;
  /** 允许的价格漂移 = driftFactor × 上次研判时的 ATR% */
  driftFactor: number;
  /** 漂移阈值下限，防止 ATR 极小时几乎永远命中缓存 */
  minDriftPercent: number;
  /** 漂移阈值上限，防止 ATR 极大时长时间不更新 */
  maxDriftPercent: number;
}

export const DEFAULT_POLICY: CachePolicy = {
  maxAgeMs: 30 * 60_000,
  driftFactor: 0.5,
  minDriftPercent: 0.3,
  maxDriftPercent: 3,
};

/** 从环境变量读取策略，便于按个人使用习惯调整而不必改代码 */
export function policyFromEnv(): CachePolicy {
  const num = (name: string, fallback: number) => {
    const v = Number(process.env[name]);
    return Number.isFinite(v) && v >= 0 ? v : fallback;
  };
  return {
    maxAgeMs: num('ANALYSIS_CACHE_TTL_MINUTES', 30) * 60_000,
    driftFactor: num('ANALYSIS_CACHE_DRIFT_FACTOR', DEFAULT_POLICY.driftFactor),
    minDriftPercent: DEFAULT_POLICY.minDriftPercent,
    maxDriftPercent: DEFAULT_POLICY.maxDriftPercent,
  };
}

export interface CacheDecision {
  reuse: boolean;
  record: AnalysisRecord | null;
  /** 给用户看的说明，解释为什么复用/为什么重新研判 */
  reason: string;
  ageMs: number | null;
  driftPercent: number | null;
  thresholdPercent: number | null;
}

const MISS = (reason: string): CacheDecision => ({
  reuse: false,
  record: null,
  reason,
  ageMs: null,
  driftPercent: null,
  thresholdPercent: null,
});

/**
 * 判断能否复用历史研判。
 *
 * @param records 该币种的全部历史记录（无需预先排序）
 * @param currentPrice 当前价格
 */
export function decideCache(
  records: AnalysisRecord[],
  currentPrice: number,
  policy: CachePolicy = DEFAULT_POLICY,
): CacheDecision {
  if (records.length === 0) return MISS('该币种尚无研判记录');

  const latest = records.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));

  const ageMs = Date.now() - latest.createdAt;
  if (ageMs >= policy.maxAgeMs) {
    return MISS(`上次研判已过 ${Math.round(ageMs / 60_000)} 分钟，超出复用时限`);
  }

  if (!Number.isFinite(latest.priceAtAnalysis) || latest.priceAtAnalysis <= 0) {
    return MISS('上次研判缺少有效的价格基准');
  }

  const driftPercent =
    (Math.abs(currentPrice - latest.priceAtAnalysis) / latest.priceAtAnalysis) * 100;

  const thresholdPercent = clamp(
    latest.atrPercentAtAnalysis * policy.driftFactor,
    policy.minDriftPercent,
    policy.maxDriftPercent,
  );

  if (driftPercent > thresholdPercent) {
    return {
      reuse: false,
      record: null,
      reason: `价格已变动 ${driftPercent.toFixed(2)}%，超过阈值 ${thresholdPercent.toFixed(2)}%`,
      ageMs,
      driftPercent,
      thresholdPercent,
    };
  }

  return {
    reuse: true,
    record: latest,
    reason:
      `复用 ${Math.round(ageMs / 60_000)} 分钟前的研判：` +
      `价格仅变动 ${driftPercent.toFixed(2)}%，低于阈值 ${thresholdPercent.toFixed(2)}%`,
    ageMs,
    driftPercent,
    thresholdPercent,
  };
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}
