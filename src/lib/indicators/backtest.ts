/**
 * 规则引擎回测。
 *
 * 存在的理由：`summary.ts` 里的权重原本是凭经验拍的（均线排列 2 分、
 * MACD 金叉 1.5 分……），没有任何数据支撑。而规则引擎是**确定性**的，
 * 这意味着它和 LLM 研判不同——不必等真实调用慢慢积累样本，
 * 直接在历史 K 线上逐根重放就能拿到几千个观测。
 *
 * 全流程的核心是一件事：**减去基线**。
 * 牛市里「看多」本来就有六成对，一个信号只有跑赢这个本底才算有信息量。
 * 不减基线的话，所有看多信号在牛市样本上都会显得很准，
 * 据此调出来的权重只是把历史行情的方向背了下来。
 */

import type { Candle, Interval } from '../datasources/types';
import { thresholdFor } from '../history/evaluate';
import { computeResonance, type Resonance } from './resonance';
import {
  buildTechnicalSnapshot,
  detectSignals,
  scoreSignals,
  SIGNAL_WEIGHTS,
  type SignalId,
} from './summary';

/** 与生产一致的回看窗口：研判接口每次也只取 300 根 */
const LOOKBACK = 300;

export type Direction = 'bullish' | 'bearish' | 'neutral';

export interface Observation {
  /** 该时点触发了哪些信号，以及各自方向 */
  signals: { id: SignalId; direction: 'bullish' | 'bearish' }[];
  /** 规则引擎当时给出的倾向（用当前权重） */
  bias: Direction;
  /** 未来 horizon 根之后的实际方向 */
  actual: Direction;
  changePercent: number;
}

/**
 * 判定「有效波动」的阈值函数。
 *
 * 默认用 history/evaluate.ts 那一套（ATR% 夹在 1%~10%），它是为
 * 数日到数周的研判设计的。但**短周期短跨度必须换一套**：
 * 5 分钟线向前看 3 根，要求 1% 的波动等于几乎一切都被判成震荡，
 * 于是任何信号都测不出方向性——那不是信号没用，是尺子不对。
 */
export type ThresholdFn = (atrPercent: number, horizon: number) => number;

export const defaultThreshold: ThresholdFn = (atrPercent) => thresholdFor(atrPercent);

/**
 * 短跨度用的阈值：按 ATR% 乘以 √horizon 缩放，不设下限钳制。
 * √ 是因为随机游走下波动随时间的平方根增长。
 */
export const shortHorizonThreshold: ThresholdFn = (atrPercent, horizon) => {
  const base = Number.isFinite(atrPercent) && atrPercent > 0 ? atrPercent : 0.2;
  return Math.max(base * Math.sqrt(horizon) * 0.5, 0.02);
};

/**
 * 在一段 K 线上逐根重放规则引擎。
 *
 * @param horizon 向前看多少根判定结果。取值应与该周期的实际用途匹配——
 *   1h 上看 24 根≈一天，1d 上看 7 根≈一周。
 * @param threshold 判定有效波动的口径，短跨度须传 shortHorizonThreshold
 */
export function replay(
  candles: Candle[],
  interval: Interval,
  horizon: number,
  threshold: ThresholdFn = defaultThreshold,
): Observation[] {
  const out: Observation[] = [];
  // 至少要 60 根才出快照（summary.ts 的下限），再留出 horizon 根用于检验
  const start = 60;
  const end = candles.length - horizon - 1;

  for (let i = start; i <= end; i++) {
    const window = candles.slice(Math.max(0, i - LOOKBACK + 1), i + 1);
    const snap = buildTechnicalSnapshot(window, interval);
    if (!snap) continue;

    const signals = detectSignals({
      price: snap.price,
      ma200: snap.ma.ma200,
      alignment: snap.ma.alignment,
      rsi14: snap.rsi14,
      histNow: snap.macd.histogram,
      cross: snap.macd.cross,
      volRatio: snap.volume.ratio20,
      squeeze: snap.bollinger.squeeze,
      flowZ: snap.flow?.zScore ?? null,
    });

    const from = candles[i].close;
    const to = candles[i + horizon].close;
    const changePercent = ((to - from) / from) * 100;

    const band = threshold(snap.volatility.atrPercent, horizon);
    const actual: Direction =
      changePercent > band ? 'bullish' : changePercent < -band ? 'bearish' : 'neutral';

    out.push({
      signals: signals.map((s) => ({ id: s.id, direction: s.direction })),
      bias: scoreSignals(signals).bias,
      actual,
      changePercent,
    });
  }

  return out;
}

export interface SignalStat {
  id: SignalId;
  /** 该信号出现的次数 */
  count: number;
  /** 信号方向与实际方向一致的比例 % */
  hitRate: number;
  /** 不看任何信号时，该方向本来就出现的频率 % */
  baseRate: number;
  /**
   * 信息量：hitRate - baseRate，单位为百分点。
   * 这才是这个信号真正贡献的东西，正数才有价值。
   */
  edge: number;
}

/** 统计每个信号相对基线的信息量 */
export function signalStats(observations: Observation[]): SignalStat[] {
  const total = observations.length;
  const baseRateOf = (dir: 'bullish' | 'bearish') =>
    total ? (observations.filter((o) => o.actual === dir).length / total) * 100 : 0;

  const ids = [...new Set(observations.flatMap((o) => o.signals.map((s) => s.id)))];

  return ids
    .map((id) => {
      const fired = observations.filter((o) => o.signals.some((s) => s.id === id));
      if (fired.length === 0) return null;

      let hits = 0;
      let baseSum = 0;
      for (const o of fired) {
        const dir = o.signals.find((s) => s.id === id)!.direction;
        if (o.actual === dir) hits++;
        // 基线按该次信号指向的方向取——看多信号要和「本来就涨的频率」比，
        // 看空信号要和「本来就跌的频率」比，混用会系统性高估其中一类
        baseSum += baseRateOf(dir);
      }

      const hitRate = (hits / fired.length) * 100;
      const baseRate = baseSum / fired.length;
      return { id, count: fired.length, hitRate, baseRate, edge: hitRate - baseRate };
    })
    .filter((v): v is SignalStat => v !== null)
    .sort((a, b) => b.edge - a.edge);
}

/**
 * 由实测信息量推导权重。
 *
 * 两个刻意的约束：
 *
 * 1. **负 edge 归零，不反转**。一个信号在样本上反向有效，多半是噪音或
 *    这段行情的特性；据此把它反过来用，是最典型的过拟合。归零意味着
 *    「测不出价值就不给它话语权」，而不是「反着信它」。
 * 2. **总权重固定为 6.0**（与原权重表一致）。这样 bias 的 ±2 阈值不必跟着变，
 *    改变的纯粹是各信号的相对轻重——这正是本次要校准的东西。
 *    否则权重整体放大会让所有标的都变成强多头或强空头。
 */
export function deriveWeights(
  stats: SignalStat[],
  totalWeight = 6,
  /** 样本收缩：edge 需要用这么多次观测才完全可信，少于此按比例打折 */
  shrinkAt = 200,
): Record<SignalId, number> {
  const raw = new Map<SignalId, number>();
  for (const s of stats) {
    const shrink = Math.min(1, s.count / shrinkAt);
    raw.set(s.id, Math.max(0, s.edge) * shrink);
  }

  const sum = [...raw.values()].reduce((a, b) => a + b, 0);
  const out = { ...SIGNAL_WEIGHTS };
  for (const id of Object.keys(out) as SignalId[]) {
    // 全部 edge 都为零时保留原权重，而不是把整套规则清零——
    // 那会让规则引擎对任何行情都输出 neutral，等于悄悄关掉了这个功能
    out[id] = sum > 0 ? Number(((raw.get(id) ?? 0) / sum * totalWeight).toFixed(2)) : SIGNAL_WEIGHTS[id];
  }
  return out;
}

export interface Scorecard {
  n: number;
  /**
   * 三分类整体命中率 %：引擎输出 neutral 也算一次预测。
   *
   * 这是唯一能公平比较两套权重的口径。只看「表态时的命中率」会被
   * **覆盖率**污染：一套几乎不表态的权重，命中率天然更高，
   * 但它把大部分时候的判断都推给了「不知道」，并不是更准。
   */
  overallHitRate: number;
  /** 同一批样本上，无脑全猜震荡的命中率 %——引擎必须跑赢它 */
  alwaysNeutralHitRate: number;
  /** 表态（非 neutral）时的命中率 % */
  directionalHitRate: number;
  /** 表态比例 %。与上一项必须一起看，单看任一项都会得出错误结论 */
  directionalRate: number;
  /** 在引擎表态的那批样本上，实际走出震荡的比例 %——表态是否真的比不表态强 */
  neutralRateWhenDirectional: number;
}

/** 用一套权重给观测集打分，用于比较新旧权重的优劣 */
export function scorecard(
  observations: Observation[],
  weights: Record<SignalId, number>,
): Scorecard {
  const n = observations.length;
  if (n === 0) {
    return {
      n: 0,
      overallHitRate: 0,
      alwaysNeutralHitRate: 0,
      directionalHitRate: 0,
      directionalRate: 0,
      neutralRateWhenDirectional: 0,
    };
  }

  let overallHits = 0;
  let directional = 0;
  let directionalHits = 0;
  let neutralWhenDirectional = 0;

  for (const o of observations) {
    const { bias } = scoreSignals(
      o.signals.map((s) => ({ ...s, reason: '' })),
      weights,
    );
    if (bias === o.actual) overallHits++;
    if (bias !== 'neutral') {
      directional++;
      if (bias === o.actual) directionalHits++;
      if (o.actual === 'neutral') neutralWhenDirectional++;
    }
  }

  const actualNeutral = observations.filter((o) => o.actual === 'neutral').length;

  return {
    n,
    overallHitRate: (overallHits / n) * 100,
    alwaysNeutralHitRate: (actualNeutral / n) * 100,
    directionalHitRate: directional ? (directionalHits / directional) * 100 : 0,
    directionalRate: (directional / n) * 100,
    neutralRateWhenDirectional: directional ? (neutralWhenDirectional / directional) * 100 : 0,
  };
}


// ────────────────────────────────────────────────────────────
// 多周期共振的回测
// ────────────────────────────────────────────────────────────

export interface ResonanceObservation {
  verdict: Resonance['verdict'];
  score: number;
  agreement: number;
  hasDivergence: boolean;
  actual: Direction;
}

/**
 * 按时间对齐地重放多周期共振。
 *
 * 对齐是这里唯一的难点：在基准周期的每个时点 t，高周期只能使用
 * **收盘时间不晚于 t** 的 K 线。用当天尚未收盘的日线去算日线指标，
 * 等于把未来的信息漏给了过去，测出来的任何结论都是假的。
 */
export function replayResonance(
  base: { interval: Interval; candles: Candle[] },
  higher: { interval: Interval; candles: Candle[] }[],
  horizon: number,
): ResonanceObservation[] {
  const out: ResonanceObservation[] = [];
  const start = 60;
  const end = base.candles.length - horizon - 1;

  for (let i = start; i <= end; i++) {
    const t = base.candles[i].time;

    const baseSnap = buildTechnicalSnapshot(
      base.candles.slice(Math.max(0, i - LOOKBACK + 1), i + 1),
      base.interval,
    );
    if (!baseSnap) continue;

    const snaps = [baseSnap];
    let complete = true;
    for (const h of higher) {
      // 只取已经收盘的那些
      const upto = h.candles.filter((c) => c.time <= t);
      if (upto.length < 60) {
        complete = false;
        break;
      }
      const snap = buildTechnicalSnapshot(upto.slice(-LOOKBACK), h.interval);
      if (!snap) {
        complete = false;
        break;
      }
      snaps.push(snap);
    }
    // 高周期数据不足时整条跳过，而不是用不完整的组合凑一个共振分——
    // 那会让「两个周期一致」和「三个周期一致」混在一起统计
    if (!complete) continue;

    const res = computeResonance(snaps);
    if (!res) continue;

    const from = base.candles[i].close;
    const to = base.candles[i + horizon].close;
    const changePercent = ((to - from) / from) * 100;
    const threshold = thresholdFor(baseSnap.volatility.atrPercent);
    const actual: Direction =
      changePercent > threshold ? 'bullish' : changePercent < -threshold ? 'bearish' : 'neutral';

    out.push({
      verdict: res.verdict,
      score: res.score,
      agreement: res.agreement,
      hasDivergence: res.divergence !== null,
      actual,
    });
  }

  return out;
}

export interface ResonanceStat {
  verdict: string;
  count: number;
  /** 该判定与实际方向一致的比例 %（mixed/conflicted 按「实际走震荡」算命中） */
  hitRate: number;
  /** 不看共振时该结果本来的出现频率 % */
  baseRate: number;
  edge: number;
}

/**
 * 各共振判定的信息量。
 *
 * mixed 与 conflicted 的「命中」定义为实际走出震荡——
 * 它们本来就是在说「没有明确方向」，用方向命中率去衡量它们是答非所问。
 */
export function resonanceStats(observations: ResonanceObservation[]): ResonanceStat[] {
  const total = observations.length;
  if (total === 0) return [];

  const rateOf = (d: Direction) =>
    (observations.filter((o) => o.actual === d).length / total) * 100;

  const expected: Record<string, Direction> = {
    bullish: 'bullish',
    bearish: 'bearish',
    mixed: 'neutral',
    conflicted: 'neutral',
  };

  return Object.entries(expected)
    .map(([verdict, want]) => {
      const subset = observations.filter((o) => o.verdict === verdict);
      if (subset.length === 0) return null;
      const hitRate = (subset.filter((o) => o.actual === want).length / subset.length) * 100;
      const baseRate = rateOf(want);
      return { verdict, count: subset.length, hitRate, baseRate, edge: hitRate - baseRate };
    })
    .filter((v): v is ResonanceStat => v !== null)
    .sort((a, b) => b.edge - a.edge);
}
