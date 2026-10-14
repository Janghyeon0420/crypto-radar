import { createHash } from 'node:crypto';
import { atr, bollinger, ema, macd, rsi } from '../indicators';
import type { Candle, Interval } from '../datasources/types';
import { INTERVAL_MS, type ForecastCandle, type ForecastDirection, type ForecastProfile, type ForecastRecord } from './types';
import { knowledgeEntries, knowledgeVersion } from './knowledge';

export const MODEL_VERSION = 'technical-scenario-v1';
// 初始启发式参数，尚未经样本外校准；任何调参必须升级版本。
export const PROFILES: Record<Interval, ForecastProfile> = {
  '1m': { horizonBars: 12, fast: 8, slow: 21, momentumBars: 6, trendWeight: .22, reversionWeight: .48, decay: .82 },
  '5m': { horizonBars: 12, fast: 10, slow: 26, momentumBars: 8, trendWeight: .30, reversionWeight: .40, decay: .86 },
  '15m': { horizonBars: 8, fast: 12, slow: 26, momentumBars: 8, trendWeight: .38, reversionWeight: .32, decay: .88 },
  '1h': { horizonBars: 12, fast: 12, slow: 36, momentumBars: 12, trendWeight: .48, reversionWeight: .22, decay: .91 },
  '4h': { horizonBars: 6, fast: 16, slow: 48, momentumBars: 12, trendWeight: .55, reversionWeight: .18, decay: .93 },
  '1d': { horizonBars: 7, fast: 20, slow: 50, momentumBars: 14, trendWeight: .60, reversionWeight: .14, decay: .94 },
  '1w': { horizonBars: 4, fast: 13, slow: 40, momentumBars: 8, trendWeight: .64, reversionWeight: .10, decay: .95 },
};

export class ForecastInputError extends Error {}
const clamp = (v: number, min = -1, max = 1) => Math.max(min, Math.min(max, v));
const last = (v: number[]) => v[v.length - 1];
export const directionFor = (changePercent: number, thresholdPercent: number): ForecastDirection =>
  changePercent > thresholdPercent ? 'bullish' : changePercent < -thresholdPercent ? 'bearish' : 'neutral';

export function validCandle(c: Candle): boolean {
  return [c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite)
    && c.time >= 0 && Number.isInteger(c.time) && c.low > 0 && c.volume >= 0
    && c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close);
}

export function generateForecast(input: {
  symbol: string; interval: Interval; source: 'binance' | 'okx'; candles: Candle[]; now?: number; inputCutoffAt?: number;
}): ForecastRecord {
  const now = input.now ?? Date.now();
  const inputCutoffAt = input.inputCutoffAt ?? now;
  const dt = INTERVAL_MS[input.interval];
  const profile = PROFILES[input.interval];
  if (!dt || !profile) throw new ForecastInputError('不支持的预测周期');
  // 未收盘的 K 线不参与指标，未来数据也绝不进入训练窗口。
  const candles = input.candles.filter(c => c.time + dt <= Math.min(now, inputCutoffAt)).slice(-180);
  if (candles.length < 80) throw new ForecastInputError('至少需要 80 根已收盘 K 线才能预测');
  if (candles.some((c, i) => !validCandle(c) || (i > 0 && c.time - candles[i - 1].time !== dt))) {
    throw new ForecastInputError('K 线包含无效价量、重复时间或缺口，请刷新行情后重试');
  }
  const anchor = candles[candles.length - 1];
  if (now - (anchor.time + dt) >= dt) throw new ForecastInputError('行情已过期，无法生成当前走势预测');
  const closes = candles.map(c => c.close);
  const a = last(atr(candles.map(c => c.high), candles.map(c => c.low), closes));
  const scale = Math.max(a, anchor.close * .000001);
  const trend = clamp((last(ema(closes, profile.fast)) - last(ema(closes, profile.slow))) / (scale * 2));
  const histogram = clamp(last(macd(closes).histogram) / scale * 3);
  // Wilder RSI 在完全横盘时返回 100；这里按无变动=50 处理，避免虚假的超买信号。
  const flat = closes.slice(-15).every(p => p === anchor.close);
  const rsiValue = flat ? 50 : last(rsi(closes));
  const reversal = clamp((50 - rsiValue) / 35);
  const bands = bollinger(closes);
  const bandPosition = clamp((last(bands.middle) - anchor.close) / scale / 2);
  const momentum = clamp((anchor.close - closes[closes.length - 1 - profile.momentumBars]) / (scale * profile.momentumBars));
  const volumeMean = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20;
  const volumeRatio = volumeMean > 0 ? anchor.volume / volumeMean : 1;
  const volumeFactor = clamp(volumeRatio, .5, 1.5);
  const prior = candles[candles.length - 2];
  const engulfing = anchor.close > anchor.open && prior.close < prior.open && anchor.close >= prior.open && anchor.open <= prior.close ? 1
    : anchor.close < anchor.open && prior.close > prior.open && anchor.close <= prior.open && anchor.open >= prior.close ? -1 : 0;
  const trending = Math.abs(trend) > .55;
  const score = clamp((trend * profile.trendWeight + histogram * .16 + momentum * .24) * volumeFactor
    + (reversal * .6 + bandPosition * .4) * profile.reversionWeight * (trending ? .25 : 1) + engulfing * .06);
  const drift = scale * score * .45;
  // 预测从下一根完整、尚未开始的 K 线起步，跳过已经形成一部分的当前 K 线。
  const skip = now > anchor.time + dt ? 1 : 0;
  const forecast: ForecastCandle[] = [];
  let previous = anchor.close;
  for (let step = 1; step <= profile.horizonBars + skip; step++) {
    const close = Math.max(anchor.close * .01, previous + drift * profile.decay ** (step - 1));
    const wick = scale * .35;
    const range = scale * Math.sqrt(step) * 1.5;
    if (step > skip) forecast.push({
      time: anchor.time + step * dt, open: previous, close,
      high: Math.max(previous, close) + wick,
      low: Math.max(anchor.close * .001, Math.min(previous, close) - wick),
      volume: 0, lower: Math.max(anchor.close * .001, close - range), upper: close + range,
    });
    previous = close;
  }
  const thresholdPercent = Math.max(.01, (a / anchor.close) * 100 * Math.sqrt(profile.horizonBars) * .25);
  const key = [input.symbol, input.interval, input.source, anchor.time, forecast[0].time, MODEL_VERSION, knowledgeVersion].join('|');
  return {
    id: createHash('sha256').update(key).digest('hex').slice(0, 32),
    symbol: input.symbol, interval: input.interval, source: input.source, createdAt: now, inputCutoffAt,
    anchorTime: anchor.time, anchorPrice: anchor.close, targetEndTime: forecast[forecast.length - 1].time + dt,
    modelVersion: MODEL_VERSION, knowledgeVersion, horizonBars: profile.horizonBars, profile: { ...profile },
    direction: directionFor((previous / anchor.close - 1) * 100, thresholdPercent), thresholdPercent,
    signals: [
      { name: '均线趋势', value: trend, detail: `EMA${profile.fast} / EMA${profile.slow}，趋势权重 ${profile.trendWeight}` },
      { name: 'MACD 动量', value: histogram, detail: '12/26/9 柱值按当前周期 ATR 归一化' },
      { name: 'RSI', value: rsiValue, detail: trending ? '趋势较强，降低反转权重' : '区间行情，结合布林位置衡量均值回归' },
      { name: '量比', value: volumeRatio, detail: '相对前 20 根成交量；只调整趋势支持度，不单独决定方向' },
      { name: '吞没形态', value: engulfing, detail: '只作低权重辅助，不能单凭形态确认反转' },
      { name: 'ATR', value: a, detail: '情景范围随步长扩大，未经概率校准，不代表置信区间' },
      { name: '综合倾向', value: score, detail: '启发式分数，不是上涨概率；尚待真实到期记录验证' },
    ],
    knowledgeIds: knowledgeEntries.filter(e => e.timeframes.includes(input.interval)).map(e => e.id),
    inputCandles: candles, candles: forecast, evaluation: null,
  };
}
