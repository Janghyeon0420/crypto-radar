/**
 * 技术指标计算。
 *
 * 全部自己实现而不引第三方库，原因有三：
 *   1. 这些指标公式固定且简单，依赖带来的版本风险大于收益；
 *   2. 需要精确控制"数据不足时返回 NaN"的语义，好让 UI 和 LLM 明确知道哪段没有值；
 *   3. 返回数组与输入 K 线等长、下标对齐，方便直接喂给图表库叠加绘制。
 *
 * 约定：所有函数返回与输入等长的数组，前面数据不足的位置填 NaN。
 */

/** 简单移动平均 */
export function sma(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/** 指数移动平均。首值用前 period 根的 SMA 作为种子，与主流看盘软件一致。 */
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** RSI，Wilder 平滑法 */
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export interface MacdResult {
  macd: number[];
  signal: number[];
  histogram: number[];
}

export function macd(closes: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const fastEma = ema(closes, fast);
  const slowEma = ema(closes, slow);
  const macdLine = closes.map((_, i) => fastEma[i] - slowEma[i]);

  // signal 线是 MACD 线的 EMA，但 MACD 前段是 NaN，
  // 必须先切掉 NaN 段再算，否则 EMA 会被污染成全 NaN。
  const firstValid = macdLine.findIndex((v) => !Number.isNaN(v));
  const signal = new Array<number>(closes.length).fill(NaN);
  if (firstValid >= 0) {
    const sig = ema(macdLine.slice(firstValid), signalPeriod);
    sig.forEach((v, i) => (signal[firstValid + i] = v));
  }

  return {
    macd: macdLine,
    signal,
    histogram: macdLine.map((v, i) => v - signal[i]),
  };
}

export interface BollingerResult {
  upper: number[];
  middle: number[];
  lower: number[];
  /** 带宽 (upper-lower)/middle，用于识别挤压后的变盘 */
  bandwidth: number[];
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerResult {
  const middle = sma(closes, period);
  const upper = new Array<number>(closes.length).fill(NaN);
  const lower = new Array<number>(closes.length).fill(NaN);
  const bandwidth = new Array<number>(closes.length).fill(NaN);

  for (let i = period - 1; i < closes.length; i++) {
    const win = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = win.reduce((a, v) => a + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
    bandwidth[i] = (upper[i] - lower[i]) / mean;
  }
  return { upper, middle, lower, bandwidth };
}

/** 平均真实波幅，用来量化波动率和设止损距离 */
export function atr(
  high: number[],
  low: number[],
  close: number[],
  period = 14,
): number[] {
  const tr = high.map((h, i) => {
    if (i === 0) return h - low[i];
    return Math.max(h - low[i], Math.abs(h - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  });
  // ATR 用 Wilder 平滑，等价于 period 为 2*period-1 的 EMA
  const out = new Array<number>(tr.length).fill(NaN);
  if (tr.length < period) return out;
  let prev = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < tr.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

export interface KdjResult {
  k: number[];
  d: number[];
  j: number[];
}

export function kdj(high: number[], low: number[], close: number[], period = 9): KdjResult {
  const k = new Array<number>(close.length).fill(NaN);
  const d = new Array<number>(close.length).fill(NaN);
  const j = new Array<number>(close.length).fill(NaN);

  let prevK = 50;
  let prevD = 50;
  for (let i = period - 1; i < close.length; i++) {
    const hh = Math.max(...high.slice(i - period + 1, i + 1));
    const ll = Math.min(...low.slice(i - period + 1, i + 1));
    const rsv = hh === ll ? 50 : ((close[i] - ll) / (hh - ll)) * 100;
    prevK = (2 / 3) * prevK + (1 / 3) * rsv;
    prevD = (2 / 3) * prevD + (1 / 3) * prevK;
    k[i] = prevK;
    d[i] = prevD;
    j[i] = 3 * prevK - 2 * prevD;
  }
  return { k, d, j };
}

/** 成交量加权均价（按整段数据累计，用于判断多空成本线） */
export function vwap(high: number[], low: number[], close: number[], volume: number[]): number[] {
  const out = new Array<number>(close.length).fill(NaN);
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < close.length; i++) {
    const typical = (high[i] + low[i] + close[i]) / 3;
    pv += typical * volume[i];
    vol += volume[i];
    out[i] = vol === 0 ? NaN : pv / vol;
  }
  return out;
}

/**
 * 基于分形高低点识别支撑/阻力。
 * left/right 是判定极值所需的两侧根数，越大越"重要"但数量越少。
 */
export function pivotLevels(
  high: number[],
  low: number[],
  left = 5,
  right = 5,
): { support: number[]; resistance: number[] } {
  const support: number[] = [];
  const resistance: number[] = [];

  for (let i = left; i < high.length - right; i++) {
    const isHigh = high.slice(i - left, i + right + 1).every((v) => v <= high[i]);
    const isLow = low.slice(i - left, i + right + 1).every((v) => v >= low[i]);
    if (isHigh) resistance.push(high[i]);
    if (isLow) support.push(low[i]);
  }
  return { support, resistance };
}
