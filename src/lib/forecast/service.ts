import { fetchCandlesWithSource, fetchCandleWindow } from '../datasources/market';
import type { Interval } from '../datasources/types';
import { ForecastInputError, generateForecast, MODEL_VERSION } from './engine';
import { INTERVAL_MS } from './types';
import { knowledgeVersion } from './knowledge';
import { computeForecastStats, evaluateForecast } from './evaluate';
import { readForecasts, saveEvaluation, saveForecast } from './store';

export interface ForecastScope { symbol?: string; interval?: Interval }
const attemptKey = Symbol.for('crypto-radar.forecast.review-attempts');
const shared = globalThis as unknown as Record<symbol, Map<string, number> | undefined>;
const attempts = shared[attemptKey] ??= new Map<string, number>();
export async function createForecast(symbol: string, interval: Interval) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const inputCutoffAt = Date.now();
    const { candles, source } = await fetchCandlesWithSource(symbol, interval, 200, { fresh: true });
    const now = Date.now();
    const dt = INTERVAL_MS[interval];
    const anchor = candles.filter(c => c.time + dt <= inputCutoffAt).at(-1);
    // 请求横跨收盘边界时重取；不能把请求开始时还未结束的蜡烛认定为已收盘。
    if (anchor && now - anchor.time - dt >= dt && attempt === 0) continue;
    return saveForecast(generateForecast({ symbol, interval, source, candles, now, inputCutoffAt }));
  }
  throw new ForecastInputError('行情更新跨越收盘边界，请重试');
}

export async function forecastHistory(scope: ForecastScope = {}) {
  const records = (await readForecasts()).filter(r => (!scope.symbol || r.symbol === scope.symbol) && (!scope.interval || r.interval === scope.interval));
  // 版本间的统计不能混用，历史记录仍保留以供审计。
  const current = records.filter(r => r.modelVersion === MODEL_VERSION && r.knowledgeVersion === knowledgeVersion);
  return { records: records.slice(0, 100), stats: computeForecastStats(current), modelVersion: MODEL_VERSION, knowledgeVersion };
}

export async function reviewForecasts(scope: ForecastScope = {}) {
  const now = Date.now();
  const allDue = (await readForecasts()).filter(r => !r.evaluation && r.targetEndTime <= now);
  const due = allDue.filter(r => (!scope.symbol || r.symbol === scope.symbol) && (!scope.interval || r.interval === scope.interval));
  const evaluationErrors: string[] = [];
  let evaluated = 0;
  // 最多处理 20 条，旧记录先补；并发受限以免断网时堆积无限请求。
  const batch = due.slice().sort((a, b) => (attempts.get(a.id) ?? 0) - (attempts.get(b.id) ?? 0)
    || a.createdAt - b.createdAt).slice(0, 20);
  // 失败的旧记录仍会重试，但不会永远霸占每轮名额。
  for (const record of batch) attempts.set(record.id, now);
  const pendingIds = new Set(allDue.map(r => r.id));
  for (const id of attempts.keys()) if (!pendingIds.has(id)) attempts.delete(id);
  for (let offset = 0; offset < batch.length; offset += 4) {
    await Promise.all(batch.slice(offset, offset + 4).map(async record => {
      try {
        const actual = await fetchCandleWindow(record.symbol, record.interval, record.candles[0].time, record.targetEndTime, record.source);
        const evaluation = evaluateForecast(record, actual, Date.now());
        if (!evaluation) {
          evaluationErrors.push(`${record.symbol} ${record.interval} ${new Date(record.createdAt).toISOString()}：目标 K 线未齐，保留待复盘`);
          return;
        }
        if (await saveEvaluation(record.id, evaluation)) evaluated++;
      } catch (err) {
        evaluationErrors.push(`${record.symbol} ${record.interval}：${err instanceof Error ? err.message : '复盘行情请求失败'}`);
      }
    }));
  }
  return { evaluated, remaining: due.length - evaluated, evaluationErrors };
}
