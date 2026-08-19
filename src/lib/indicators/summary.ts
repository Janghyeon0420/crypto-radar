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

  const { bias, reasons } = scoreBias({
    price,
    ma20,
    ma50,
    ma200,
    alignment,
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
    levels: { supports, resistances },
    bias,
    reasons,
  };
}

/**
 * 简单加权打分。刻意保持透明和可解释——每条理由都能对应到一个具体指标状态，
 * 这样 LLM 拿到的是"有依据的倾向"而不是黑箱分数，用户也能自己判断这套逻辑合不合理。
 */
function scoreBias(x: {
  price: number;
  ma20: number;
  ma50: number;
  ma200: number;
  alignment: Bias;
  rsi14: number;
  histNow: number;
  cross: 'golden' | 'death' | 'none';
  volRatio: number;
  squeeze: boolean;
}): { bias: Bias; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  if (x.alignment === 'bullish') {
    score += 2;
    reasons.push('均线多头排列（MA20 > MA50 > MA200）');
  } else if (x.alignment === 'bearish') {
    score -= 2;
    reasons.push('均线空头排列（MA20 < MA50 < MA200）');
  }

  if (!Number.isNaN(x.ma200)) {
    if (x.price > x.ma200) {
      score += 1;
      reasons.push('价格位于 MA200 之上，长期趋势偏多');
    } else {
      score -= 1;
      reasons.push('价格位于 MA200 之下，长期趋势偏空');
    }
  }

  if (x.histNow > 0) {
    score += 1;
    reasons.push('MACD 柱状图为正，动能偏多');
  } else if (x.histNow < 0) {
    score -= 1;
    reasons.push('MACD 柱状图为负，动能偏空');
  }

  if (x.cross === 'golden') {
    score += 1.5;
    reasons.push('MACD 刚形成金叉');
  } else if (x.cross === 'death') {
    score -= 1.5;
    reasons.push('MACD 刚形成死叉');
  }

  // RSI 极值按"反转风险"处理，而不是简单的多空信号
  if (x.rsi14 >= 70) {
    score -= 0.5;
    reasons.push(`RSI ${x.rsi14.toFixed(1)} 进入超买区，追高风险上升`);
  } else if (x.rsi14 <= 30) {
    score += 0.5;
    reasons.push(`RSI ${x.rsi14.toFixed(1)} 进入超卖区，存在反弹需求`);
  }

  if (x.volRatio >= 1.5) {
    reasons.push(`成交量为 20 周期均量的 ${x.volRatio.toFixed(1)} 倍，属放量`);
  } else if (x.volRatio <= 0.6) {
    reasons.push('成交量明显萎缩，趋势缺乏参与度');
  }

  if (x.squeeze) {
    reasons.push('布林带处于近期最窄区间（挤压），变盘概率升高');
  }

  const bias: Bias = score >= 2 ? 'bullish' : score <= -2 ? 'bearish' : 'neutral';
  return { bias, reasons };
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
