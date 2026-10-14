import type { Candle } from '../datasources/types';
import type { Bias } from './summary';
import { atr, rsi, sma } from './index';

export const FORECAST_WINDOWS = [
  { id: 'short', label: '短期', interval: '1h', barMs: 3_600_000, bars: 24, window: '24 小时' },
  { id: 'medium', label: '中期', interval: '4h', barMs: 14_400_000, bars: 42, window: '7 天' },
  { id: 'long', label: '长期', interval: '1d', barMs: 86_400_000, bars: 60, window: '60 天' },
] as const;

export type ForecastWindow = (typeof FORECAST_WINDOWS)[number];
export interface ForecastRow {
  id: ForecastWindow['id'];
  label: string;
  interval: ForecastWindow['interval'];
  window: string;
  status: 'ready' | 'unavailable';
  reason: string;
  asOf: number | null;
  expiresAt: number | null;
  referencePrice: number | null;
  bias: Bias | null;
  target: number | null;
  range: [number, number] | null;
  changePercent: number | null;
  invalidation: number | null;
  rewardRisk: number | null;
  touchHours: [number, number] | null;
  touchSamples: number;
  samples: number;
  nonOverlappingSamples: number;
}

export interface ForecastResponse {
  symbol: string;
  source: string;
  generatedAt: number;
  model: 'analog-v1';
  rows: ForecastRow[];
}

export function unavailableForecast(config: ForecastWindow, reason: string): ForecastRow {
  return {
    id: config.id, label: config.label, interval: config.interval, window: config.window,
    status: 'unavailable', reason, asOf: null, expiresAt: null, referencePrice: null,
    bias: null, target: null, range: null, changePercent: null, invalidation: null,
    rewardRisk: null, touchHours: null, touchSamples: 0, samples: 0, nonOverlappingSamples: 0,
  };
}

function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (sorted.length - 1) * q;
  const lower = Math.floor(at);
  return sorted[lower] + (sorted[Math.ceil(at)] - sorted[lower]) * (at - lower);
}

/**
 * 历史类比情景，不是经样本外验证的交易策略。
 * 特征仅使用当时已收盘数据；候选的完整未来窗口必须已结束。
 * 收益以当时 ATR/价格归一化，再映射到当前波动尺度。
 * 重叠观测保留以描述分布，但同时披露互不重叠窗口数，不能当独立试验算胜率。
 */
export function buildForecast(input: Candle[], config: ForecastWindow, now = Date.now()): ForecastRow {
  const row = unavailableForecast(config, '已收盘历史不足，暂不预判');
  if (input.some((c) => !Number.isFinite(c.time))) return { ...row, reason: 'K 线时间异常，暂不预判' };
  const candles = input.filter((c) => c.time + config.barMs <= now);
  if (candles.some((c, i) =>
    ![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
    Math.min(c.open, c.high, c.low, c.close) <= 0 || c.volume < 0 ||
    c.low > Math.min(c.open, c.close) || c.high < Math.max(c.open, c.close) ||
    (i > 0 && c.time - candles[i - 1].time !== config.barMs)
  )) return { ...row, reason: 'K 线缺失或异常，暂不预判' };
  if (candles.length < 60 + config.bars) return row;

  const last = candles.length - 1;
  const price = candles[last].close;
  const asOf = candles[last].time + config.barMs;
  Object.assign(row, { asOf, expiresAt: asOf + config.bars * config.barMs, referencePrice: price });
  if (now - asOf > config.barMs + 60_000) return { ...row, reason: '行情已过期，等待新的已收盘 K 线' };

  const closes = candles.map((c) => c.close);
  const ma20 = sma(closes, 20);
  const ma50 = sma(closes, 50);
  const strength = rsi(closes, 14);
  const volatility = atr(candles.map((c) => c.high), candles.map((c) => c.low), closes, 14)
    .map((value, i) => value / closes[i]);
  const scale = volatility[last];
  if (!Number.isFinite(scale) || scale < 1e-8) return { ...row, reason: '有效波动不足，暂不推算价位' };

  const regime = (i: number) => `${closes[i] >= ma50[i]}|${ma20[i] >= ma50[i]}|${
    strength[i] < 30 ? 0 : strength[i] < 50 ? 1 : strength[i] < 70 ? 2 : 3
  }`;
  const currentRegime = regime(last);
  const matches: number[] = [];
  let previousEnd = -1;
  for (let i = 59; i + config.bars <= last; i++) {
    if (regime(i) !== currentRegime || volatility[i] < scale / 2 || volatility[i] > scale * 2) continue;
    matches.push(i);
    if (i > previousEnd) {
      row.nonOverlappingSamples++;
      previousEnd = i + config.bars;
    }
  }
  row.samples = matches.length;
  if (matches.length < 30 || row.nonOverlappingSamples < 3) {
    return { ...row, reason: '相似样本不足（需 ≥30 个观测、≥3 个不重叠窗口）' };
  }

  const normalized = (value: number, i: number) => Math.log(value / closes[i]) / volatility[i];
  const returns = matches.map((i) => normalized(closes[i + config.bars], i));
  const median = quantile(returns, 0.5);
  const bias: Bias = median > 0.5 ? 'bullish' : median < -0.5 ? 'bearish' : 'neutral';
  const toPrice = (value: number) => price * Math.exp(value * scale);
  const target = toPrice(median);
  const range: [number, number] = [toPrice(quantile(returns, 0.25)), toPrice(quantile(returns, 0.75))];
  const adverse: number[] = [];
  const touches: number[] = [];
  if (bias !== 'neutral') {
    for (const i of matches) {
      let worst = 0;
      let touch: number | null = null;
      for (let step = 1; step <= config.bars; step++) {
        const c = candles[i + step];
        const high = normalized(c.high, i);
        const low = normalized(c.low, i);
        worst = bias === 'bullish' ? Math.min(worst, low) : Math.max(worst, high);
        if (touch === null && (bias === 'bullish' ? high >= median : low <= median)) {
          touch = step * config.barMs / 3_600_000;
        }
      }
      adverse.push(worst);
      if (touch !== null) touches.push(touch);
    }
  }
  // 至少保留 1 ATR 风险距离；极端不利路径的 10% 尾部仅作重评参考。
  const stop = bias === 'bullish' ? Math.min(-1, quantile(adverse, 0.1))
    : bias === 'bearish' ? Math.max(1, quantile(adverse, 0.9)) : null;
  const invalidation = stop === null ? null : toPrice(stop);
  const rewardRisk = invalidation === null ? null : Math.abs(target - price) / Math.abs(price - invalidation);
  if (![target, ...range, ...(invalidation === null ? [] : [invalidation])].every((v) => Number.isFinite(v) && v > 0) ||
    (rewardRisk !== null && !Number.isFinite(rewardRisk))) {
    return { ...row, reason: '波动映射超出有效范围，暂不推算价位' };
  }

  return {
    ...row, status: 'ready', bias, target, range, invalidation, rewardRisk,
    changePercent: (target / price - 1) * 100,
    touchSamples: touches.length,
    touchHours: touches.length >= 10 ? [quantile(touches, 0.25), quantile(touches, 0.75)] : null,
    reason: `价格${price >= ma50[last] ? '高于' : '低于'} MA50 · MA20 ${ma20[last] >= ma50[last] ? '≥' : '<'} MA50 · RSI ${strength[last].toFixed(0)}`,
  };
}
