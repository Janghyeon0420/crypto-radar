'use client';

import { useEffect, useState } from 'react';
import type { Interval } from '@/lib/datasources/types';
import type { ForecastRecord, ForecastStats } from '@/lib/forecast/types';

interface ForecastHistory {
  records: ForecastRecord[];
  stats: ForecastStats;
  evaluationErrors?: string[];
}

async function readResponse<T>(response: Response): Promise<T> {
  const body = await response.text();
  let data: T & { error?: string };
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error(`服务返回了无法解析的响应（HTTP ${response.status}），请稍后重试`);
  }
  if (!response.ok) throw new Error(data.error ?? `请求失败（HTTP ${response.status}）`);
  return data;
}

/** 预测和复盘都按币种、周期隔离；切换后旧请求既中止，也不能写入当前状态。 */
export function useForecast({
  symbol, interval, enabled, anchorTime,
}: {
  symbol: string;
  interval: Interval;
  enabled: boolean;
  anchorTime: number | null;
}) {
  const contextKey = `${symbol}|${interval}`;
  const [attempt, setAttempt] = useState(0);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [generation, setGeneration] = useState<{
    key: string; record: ForecastRecord | null; error: string | null;
  }>({ key: '', record: null, error: null });
  const [history, setHistory] = useState<{
    key: string; contextKey: string; data: ForecastHistory | null; error: string | null;
  }>({ key: '', contextKey: '', data: null, error: null });

  const generationKey = `${contextKey}|${anchorTime}|${attempt}`;
  const historyKey = `${contextKey}|${historyVersion}`;

  useEffect(() => {
    if (!enabled || !symbol || anchorTime == null) return;
    const ac = new AbortController();
    let cancelled = false;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; ac.abort(); }, 65_000);
    fetch('/api/forecast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, interval }),
      signal: ac.signal,
    })
      .then(readResponse<{ record: ForecastRecord; reused: boolean }>)
      .then(({ record }) => {
        if (cancelled) return;
        if (record.symbol !== symbol || record.interval !== interval) {
          throw new Error('预测与当前币种或周期不匹配，请重试');
        }
        if (record.anchorTime < anchorTime) {
          throw new Error('预测使用的收盘数据早于当前行情，请重试');
        }
        setGeneration({ key: generationKey, record, error: null });
        setHistoryVersion((v) => v + 1);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setGeneration({
          key: generationKey,
          record: null,
          error: timedOut ? '预测请求超时，请重试' : error instanceof Error ? error.message : '预测失败，请重试',
        });
      })
      .finally(() => clearTimeout(timeout));
    return () => { cancelled = true; clearTimeout(timeout); ac.abort(); };
  }, [enabled, symbol, interval, anchorTime, generationKey]);

  useEffect(() => {
    if (!symbol) return;
    const ac = new AbortController();
    let cancelled = false;
    let running = false;

    const load = async (forceReview: boolean) => {
      if (running) return;
      running = true;
      let timedOut = false;
      const request = new AbortController();
      const abort = () => request.abort();
      ac.signal.addEventListener('abort', abort, { once: true });
      const timeout = setTimeout(() => { timedOut = true; request.abort(); }, 65_000);
      try {
        let data = await fetch(`/api/forecast?symbol=${encodeURIComponent(symbol)}&interval=${interval}`, {
          signal: request.signal, cache: 'no-store',
        }).then(readResponse<ForecastHistory>);
        const hasDue = data.records.some((r) => !r.evaluation && r.targetEndTime <= Date.now());
        if (forceReview || hasDue) {
          data = await fetch('/api/forecast/review', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ symbol, interval }), signal: request.signal,
          }).then(readResponse<ForecastHistory>);
        }
        if (!cancelled) setHistory({ key: historyKey, contextKey, data, error: null });
      } catch (error) {
        if (!cancelled) setHistory((old) => ({
          key: historyKey, contextKey,
          data: old.contextKey === contextKey ? old.data : null,
          error: timedOut ? '历史复盘请求超时，请重试' : error instanceof Error ? error.message : '无法加载预测记录',
        }));
      } finally {
        clearTimeout(timeout);
        ac.signal.removeEventListener('abort', abort);
        running = false;
      }
    };

    void load(historyVersion > 0);
    const timer = setInterval(() => { void load(false); }, 60_000);
    return () => { cancelled = true; clearInterval(timer); ac.abort(); };
  }, [symbol, interval, contextKey, historyKey, historyVersion]);

  const hasCurrentGeneration = enabled && generation.key === generationKey;
  return {
    record: hasCurrentGeneration ? generation.record : null,
    generating: enabled && Boolean(symbol) && anchorTime != null && generation.key !== generationKey,
    error: hasCurrentGeneration ? generation.error : null,
    history: history.contextKey === contextKey ? history.data : null,
    historyLoading: Boolean(symbol) && history.key !== historyKey,
    historyError: history.contextKey === contextKey ? history.error : null,
    retry: () => setAttempt((v) => v + 1),
    review: () => setHistoryVersion((v) => v + 1),
  };
}

export type ForecastState = ReturnType<typeof useForecast>;
