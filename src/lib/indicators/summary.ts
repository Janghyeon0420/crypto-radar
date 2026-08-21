/**
 * 把原始指标数组压缩成"当前技术面快照"。
 *
 * 这一层存在的意义：LLM 不需要（也不该）看到 500 根 K 线的原始数组——
 * 那既浪费 token 又容易让模型算错。这里先用确定性代码把事实算清楚，
 * 只把结论性的数字和状态交给模型，模型负责解读和串联，不负责计算。
 * 同时这些结构化数据也直接驱动 UI 的指标面板。
 */

import type { Candle, Interval } from '../datasources/types';
import { atr, bollinger, ema, kdj, macd, pivotLevels, rsi, sma, vwap } from './index';

export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface TechnicalSnapshot {
  interval: Interval;
  price: number;
  /** 相对上一根 K 线的涨跌幅 % */
  changePercent: number;

  ma: {
    ma20: number;
    ma50: number;
    ma200: number;
    ema12: number;
    ema26: number;
    /** 均线多头排列 / 空头排列 / 缠绕 */
    alignment: Bias;
    /** 价格在 MA200 之上还是之下——长期趋势的粗判 */
    aboveMa200: boolean;
  };

  rsi14: number;
  rsiState: 'overbought' | 'oversold' | 'normal';

  macd: {
    macd: number;
    signal: number;
    histogram: number;
    /** 柱状图刚由负转正 / 由正转负，是最常用的择时信号 */
    cross: 'golden' | 'death' | 'none';
  };

  bollinger: {
    upper: number;
    middle: number;
    lower: number;
    bandwidth: number;
    /** 价格在带内的相对位置，0=下轨 1=上轨 */
    percentB: number;
    /** 带宽处于近 120 根的低位，通常预示变盘 */
    squeeze: boolean;
  };

  kdj: { k: number; d: number; j: number };

  volatility: {
    atr14: number;
    /** ATR 占价格比例，跨币种可比的波动率口径 */
    atrPercent: number;
  };

  volume: {
    current: number;
    /** 相对近 20 根均量的倍数，>1.5 视为放量 */
    ratio20: number;
    vwap: number;
  };

  /**
   * 主动成交方向。唯一能从 K 线里读出的微观结构信息。
   *
   * takerBuyRatio 本身没什么用——它常年在 50% 附近，而波动幅度随周期
   * 差好几倍（实测 1h 标准差 8.4、1d 只有 2.5）。真正有含义的是
   * **相对该周期自身分布偏离了多少**，所以同时给出 z 分数。
   */
  flow: {
    /** 主动买入占总成交的比例 % */
    takerBuyRatio: number;
    /** 相对近 60 根的均值偏离了几个标准差 */
    zScore: number;
  } | null;

  levels: {
    /** 距现价最近的下方支撑，从近到远 */
    supports: number[];
    resistances: number[];
  };

  /** 各维度打分汇总出的方向倾向，仅作为 LLM 的输入参考，不是交易建议 */
  bias: Bias;
  /** 支撑该 bias 的具体理由，同时用于 UI 展示和 prompt */
  reasons: string[];
}

const last = (a: number[]) => a[a.length - 1];
const prev = (a: number[]) => a[a.length - 2];

export function buildTechnicalSnapshot(
  candles: Candle[],
  interval: Interval,
): TechnicalSnapshot | null {
  // 200 根是 MA200 的最低要求，不足就不给快照，避免输出一堆 NaN 误导模型
  if (candles.length < 60) return null;

  const close = candles.map((c) => c.close);
  const high = candles.map((c) => c.high);
  const low = candles.map((c) => c.low);
  const volume = candles.map((c) => c.volume);

  const price = last(close);
  const ma20 = last(sma(close, 20));
  const ma50 = last(sma(close, 50));
  const ma200 = candles.length >= 200 ? last(sma(close, 200)) : NaN;
  const ema12 = last(ema(close, 12));
  const ema26 = last(ema(close, 26));

  const rsiSeries = rsi(close, 14);
  const rsi14 = last(rsiSeries);

  const m = macd(close);
  const histNow = last(m.histogram);
  const histPrev = prev(m.histogram);
  const cross: 'golden' | 'death' | 'none' =
    histPrev < 0 && histNow >= 0 ? 'golden' : histPrev > 0 && histNow <= 0 ? 'death' : 'none';

  const bb = bollinger(close, 20, 2);
  const bbUpper = last(bb.upper);
  const bbLower = last(bb.lower);
  const bandwidth = last(bb.bandwidth);
  const recentBw = bb.bandwidth.slice(-120).filter((v) => !Number.isNaN(v));
  const squeeze =
    recentBw.length > 20 && bandwidth <= quantile(recentBw, 0.2);

  const k = kdj(high, low, close);
  const atrSeries = atr(high, low, close, 14);
  const atr14 = last(atrSeries);

  const vol20 = sma(volume, 20);
  const volRatio = last(vol20) ? last(volume) / last(vol20) : 1;

  const flow = takerFlow(candles);

  const { support, resistance } = pivotLevels(high, low, 5, 5);
  const supports = [...new Set(support.filter((v) => v < price))]
    .sort((a, b) => b - a)
    .slice(0, 3);
  const resistances = [...new Set(resistance.filter((v) => v > price))]
    .sort((a, b) => a - b)
    .slice(0, 3);

  const alignment: Bias =
    ma20 > ma50 && (Number.isNaN(ma200) || ma50 > ma200)
      ? 'bullish'
      : ma20 < ma50 && (Number.isNaN(ma200) || ma50 < ma200)
        ? 'bearish'
        : 'neutral';

  const rsiState =
    rsi14 >= 70 ? 'overbought' : rsi14 <= 30 ? 'oversold' : ('normal' as const);

  // ma20 / ma50 不必传：它们的信息已经被 alignment 概括，
  // 多传两个未被使用的字段只会让 SignalInput 的契约含糊
  const { bias, reasons } = scoreBias({
    price,
    ma200,
    alignment,
    flowZ: flow?.zScore ?? null,
    rsi14,
    histNow,
    cross,
    volRatio,
    squeeze,
  });

  return {
    interval,
    price,
    changePercent: ((price - prev(close)) / prev(close)) * 100,
    ma: { ma20, ma50, ma200, ema12, ema26, alignment, aboveMa200: price > ma200 },
    rsi14,
    rsiState,
    macd: { macd: last(m.macd), signal: last(m.signal), histogram: histNow, cross },
    bollinger: {
      upper: bbUpper,
      middle: last(bb.middle),
      lower: bbLower,
      bandwidth,
      percentB: (price - bbLower) / (bbUpper - bbLower),
      squeeze,
    },
    kdj: { k: last(k.k), d: last(k.d), j: last(k.j) },
    volatility: { atr14, atrPercent: (atr14 / price) * 100 },
    volume: { current: last(volume), ratio20: volRatio, vwap: last(vwap(high, low, close, volume)) },
    flow,
    levels: { supports, resistances },
    bias,
    reasons,
  };
}

/**
 * 规则引擎的信号定义与权重。
 *
 * 每个信号只回答一件事：**此刻它指向多还是空**。
 * 检测与加权刻意分开——不分开就没法单独衡量一个信号值多少钱：
 * 回测需要知道「均线多头排列出现时，后面涨的概率是多少」，
 * 这个问题与「它该占几分」是两件事。
 */
export type SignalId =
  | 'ma_alignment'
  | 'above_ma200'
  | 'macd_histogram'
  | 'macd_cross'
  | 'rsi_extreme'
  | 'taker_flow';

export interface Signal {
  id: SignalId;
  direction: 'bullish' | 'bearish';
  reason: string;
}

/**
 * 各信号权重。
 *
 * ⚠️ 这些数字仍然是**凭经验拍的**。`npm run backtest` 已经能测了，
 * 但测出来的结论是：不该照测得的值改。原因见下。
 *
 * ── 2026-08-21 实测（8 个币种 × 1h/4h/1d，22216 个观测，7:3 切分）──
 *
 * 各信号相对基线的信息量（命中率 − 该方向本来的出现频率）：
 *
 *   rsi_extreme      +5.7pt   出现 1383 次
 *   macd_histogram   +0.9pt   出现 15544 次
 *   macd_cross       -1.9pt   出现 1223 次
 *   above_ma200      -2.2pt   出现 12208 次
 *   ma_alignment     -3.3pt   出现 10312 次
 *
 * 也就是说，除了 RSI 极值，趋势类信号在这段样本上**略微反向**。
 *
 * 按实测值推导出的权重会把 5.16/6.0 全压在 rsi_extreme 上，
 * 使引擎的表态比例从 79% 掉到 7.4%。整体命中率确实从 30.2% 升到 51.1%，
 * 但这个提升完全来自「几乎不表态」——是沉默换来的，不是预测力换来的。
 * 而且 51.1% 仍然低于「无脑全猜震荡」的 51.9%。
 *
 * 结论：**规则引擎在本样本上不具备方向预测价值**，调权重解决不了。
 * 所以保留原权重，并把它的定位从「方向判断」改成「技术面状态的透明描述」——
 * 见 prompt.ts 里对 bias 的说明。
 *
 * 两点方法上的保留：观测窗口高度重叠（1h 上向前看 24 根，相邻观测共享 23 小时），
 * 有效独立样本约为 22216/horizon 量级；且样本以近年行情为主，
 * 换一段行情结论未必相同。要重新验证就跑 npm run backtest。
 */
export const SIGNAL_WEIGHTS: Record<SignalId, number> = {
  ma_alignment: 2,
  above_ma200: 1,
  macd_histogram: 1,
  macd_cross: 1.5,
  rsi_extreme: 0.5,
  // 候选信号，权重为 0 = 参与检测与展示，但不影响 bias。
  // 回测证明有信息量之前不给它话语权——这是规则引擎那次留下的规矩
  taker_flow: 0,
};

/** 上次跑回测核对这套权重的日期。npm run backtest -- --apply 会更新它 */
export const WEIGHTS_MEASURED_AT = '2026-08-21';

export interface SignalInput {
  price: number;
  ma200: number;
  alignment: Bias;
  rsi14: number;
  histNow: number;
  cross: 'golden' | 'death' | 'none';
  volRatio: number;
  squeeze: boolean;
  /** 主动成交方向的 z 分数，无数据时为 null */
  flowZ: number | null;
}

/**
 * 检测当前触发了哪些方向性信号。
 *
 * 只包含**有方向的**信号。成交量与布林挤压不在其中——
 * 它们描述的是「这个判断可不可靠」而非「往哪边走」，
 * 放进加权求和会把两种语义混为一谈。它们仍会作为理由显示。
 */
export function detectSignals(x: SignalInput): Signal[] {
  const signals: Signal[] = [];

  if (x.alignment === 'bullish') {
    signals.push({
      id: 'ma_alignment',
      direction: 'bullish',
      reason: '均线多头排列（MA20 > MA50 > MA200）',
    });
  } else if (x.alignment === 'bearish') {
    signals.push({
      id: 'ma_alignment',
      direction: 'bearish',
      reason: '均线空头排列（MA20 < MA50 < MA200）',
    });
  }

  if (!Number.isNaN(x.ma200)) {
    signals.push(
      x.price > x.ma200
        ? { id: 'above_ma200', direction: 'bullish', reason: '价格位于 MA200 之上，长期趋势偏多' }
        : { id: 'above_ma200', direction: 'bearish', reason: '价格位于 MA200 之下，长期趋势偏空' },
    );
  }

  if (x.histNow > 0) {
    signals.push({ id: 'macd_histogram', direction: 'bullish', reason: 'MACD 柱状图为正，动能偏多' });
  } else if (x.histNow < 0) {
    signals.push({ id: 'macd_histogram', direction: 'bearish', reason: 'MACD 柱状图为负，动能偏空' });
  }

  if (x.cross === 'golden') {
    signals.push({ id: 'macd_cross', direction: 'bullish', reason: 'MACD 刚形成金叉' });
  } else if (x.cross === 'death') {
    signals.push({ id: 'macd_cross', direction: 'bearish', reason: 'MACD 刚形成死叉' });
  }

  // RSI 极值按「反转风险」处理，而不是简单的多空信号：
  // 超买给空头方向的分，因为它提示的是追高风险
  if (x.rsi14 >= 70) {
    signals.push({
      id: 'rsi_extreme',
      direction: 'bearish',
      reason: `RSI ${x.rsi14.toFixed(1)} 进入超买区，追高风险上升`,
    });
  } else if (x.rsi14 <= 30) {
    signals.push({
      id: 'rsi_extreme',
      direction: 'bullish',
      reason: `RSI ${x.rsi14.toFixed(1)} 进入超卖区，存在反弹需求`,
    });
  }

  // 主动成交方向。阈值 1.5 个标准差——按正态约 13% 的时间触发，
  // 既不会天天响，也不至于几个月才出现一次
  if (x.flowZ != null && Math.abs(x.flowZ) >= 1.5) {
    signals.push(
      x.flowZ > 0
        ? {
            id: 'taker_flow',
            direction: 'bullish',
            reason: `主动买入占比异常偏高（${x.flowZ.toFixed(1)}σ），买方在吃单`,
          }
        : {
            id: 'taker_flow',
            direction: 'bearish',
            reason: `主动卖出占比异常偏高（${Math.abs(x.flowZ).toFixed(1)}σ），卖方在砸单`,
          },
    );
  }

  return signals;
}

/** 无方向的补充说明。不参与打分，但用户和模型都需要看到。 */
export function contextReasons(x: SignalInput): string[] {
  const reasons: string[] = [];
  if (x.volRatio >= 1.5) {
    reasons.push(`成交量为 20 周期均量的 ${x.volRatio.toFixed(1)} 倍，属放量`);
  } else if (x.volRatio <= 0.6) {
    reasons.push('成交量明显萎缩，趋势缺乏参与度');
  }
  if (x.squeeze) {
    reasons.push('布林带处于近期最窄区间（挤压），变盘概率升高');
  }
  return reasons;
}

/** 加权求和。权重可注入，回测据此比较不同权重表的优劣。 */
export function scoreSignals(
  signals: Signal[],
  weights: Record<SignalId, number> = SIGNAL_WEIGHTS,
): { score: number; bias: Bias } {
  const score = signals.reduce(
    (sum, s) => sum + (s.direction === 'bullish' ? 1 : -1) * (weights[s.id] ?? 0),
    0,
  );
  return { score, bias: score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral' };
}

function scoreBias(x: SignalInput): { bias: Bias; reasons: string[] } {
  const signals = detectSignals(x);
  const { bias } = scoreSignals(signals);
  return { bias, reasons: [...signals.map((s) => s.reason), ...contextReasons(x)] };
}

/**
 * 主动买入占比及其 z 分数。
 *
 * 用滚动窗口的均值与标准差，而不是固定阈值——固定阈值在 1h 上天天触发、
 * 在 1d 上永远不触发，因为两者的波动幅度差三倍以上。
 * 这与本项目里用 ATR 推导「有效波动」是同一个道理。
 */
const FLOW_WINDOW = 60;

function takerFlow(candles: Candle[]): TechnicalSnapshot['flow'] {
  const ratios = candles
    .filter((c) => c.takerBuyVolume != null && c.volume > 0)
    .map((c) => (c.takerBuyVolume! / c.volume) * 100);

  // 样本太少时标准差不可靠，宁可不给 z 分数
  if (ratios.length < 20) return null;

  const current = ratios[ratios.length - 1];
  const window = ratios.slice(-FLOW_WINDOW);
  const mean = window.reduce((a, b) => a + b, 0) / window.length;
  const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length;
  const sd = Math.sqrt(variance);

  return {
    takerBuyRatio: current,
    // 标准差为 0（成交极度单一）时 z 分数无意义，退回 0 而不是 Infinity
    zScore: sd > 0.01 ? (current - mean) / sd : 0,
  };
}

function quantile(arr: number[], q: number): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}
