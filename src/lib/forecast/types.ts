import type { Candle, Interval } from '../datasources/types';

export const INTERVAL_MS: Record<Interval, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
  '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};
export type ForecastDirection = 'bullish' | 'bearish' | 'neutral';
export interface ForecastCandle extends Candle { lower: number; upper: number }
export interface ForecastProfile {
  horizonBars: number;
  fast: number;
  slow: number;
  momentumBars: number;
  trendWeight: number;
  reversionWeight: number;
  decay: number;
}
export interface ForecastEvaluation {
  evaluatedAt: number;
  actualDirection: ForecastDirection;
  correct: boolean;
  closeMape: number;
  boundCoverage: number;
  baselineMape: number;
  skillScore: number | null;
  actualClose: number;
  actualCandles: Candle[];
}
export interface ForecastRecord {
  id: string;
  symbol: string;
  interval: Interval;
  source: 'binance' | 'okx';
  createdAt: number;
  inputCutoffAt: number;
  anchorTime: number;
  anchorPrice: number;
  targetEndTime: number;
  modelVersion: string;
  knowledgeVersion: string;
  horizonBars: number;
  direction: ForecastDirection;
  thresholdPercent: number;
  profile: ForecastProfile;
  signals: { name: string; value: number; detail: string }[];
  knowledgeIds: string[];
  inputCandles: Candle[];
  candles: ForecastCandle[];
  evaluation: ForecastEvaluation | null;
}
export interface ForecastStats {
  total: number;
  evaluated: number;
  pending: number;
  correct: number;
  hitRate: number | null;
  meanCloseMape: number | null;
  meanBoundCoverage: number | null;
  meanBaselineMape: number | null;
  skillScore: number | null;
  byInterval: { interval: Interval; evaluated: number; hitRate: number | null }[];
}
