'use client';

import { useEffect, useState } from 'react';
import type { Interval } from '@/lib/datasources/types';
import type { ForecastRecord } from '@/lib/forecast/types';
import type { ForecastState } from '@/lib/hooks/useForecast';
import { formatPrice } from '@/lib/format';

const DIRECTIONS = { bullish: '看涨', bearish: '看跌', neutral: '震荡' };
const DIRECTION_COLOR = { bullish: 'text-emerald-400', bearish: 'text-rose-400', neutral: 'text-zinc-300' };
const percent = (value: number | null | undefined) => value == null ? '—' : `${value.toFixed(1)}%`;
const dateTime = (time: number) => new Date(time).toLocaleString('zh-CN', {
  month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC',
}) + ' UTC';

export function TechnicalForecastPanel({
  symbol, interval, enabled, onEnabledChange, forecast,
}: {
  symbol: string;
  interval: Interval;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  forecast: ForecastState;
}) {
  const { record, history, historyLoading, historyError, generating, error } = forecast;
  const stats = history?.stats;

  return (
    <div className="space-y-5 p-4 text-xs">
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-zinc-200">技术走势预测</h3>
          <span className="rounded bg-zinc-900 px-2 py-1 text-zinc-400">{symbol} · {interval}</span>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-zinc-200">
          <input type="checkbox" checked={enabled} onChange={(e) => onEnabledChange(e.target.checked)}
            className="h-3.5 w-3.5 accent-violet-400" disabled={!symbol} />
          在主图显示预测走势
        </label>
        <p className="leading-relaxed text-zinc-500">
          分周期启发式情景，尚待实盘复盘验证。紫色空心 K 线是预测，虚线是 ATR 情景范围，未经概率校准。
          仅使用已收盘数据，从下一根尚未开始的完整 K 线起预测。
        </p>
        {generating && <p role="status" className="text-violet-300">正在生成 {interval} 预测并存档…</p>}
        {enabled && !generating && !record && !error && (
          <p className="text-zinc-500">等待当前周期行情加载后生成预测。</p>
        )}
        {error && <ErrorNotice message={error} retry={forecast.retry} />}
        {record && (
          <div className="space-y-3 rounded-lg border border-violet-400/20 bg-violet-400/5 p-3">
            <div className="flex items-center justify-between">
              <span className={DIRECTION_COLOR[record.direction]}>{DIRECTIONS[record.direction]}</span>
              <span className="text-zinc-400">未来 {record.horizonBars} 根 · 每根 {interval}</span>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-zinc-500">预测期末收盘</span>
              <span className="font-mono text-base text-violet-200">{formatPrice(record.candles.at(-1)?.close)}</span>
            </div>
            <p className="text-[11px] leading-relaxed text-zinc-500">
              {dateTime(record.candles[0].time)} — {dateTime(record.targetEndTime)}
              <br />数据源 {record.source.toUpperCase()} · {record.modelVersion}
            </p>
            <details>
              <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">预测依据与周期参数</summary>
              <div className="mt-3 space-y-3">
                {record.signals.map((signal) => (
                  <div key={signal.name}>
                    <div className="flex justify-between gap-2 text-zinc-300">
                      <span>{signal.name}</span>
                      <span className="font-mono">{signal.value.toFixed(3)}</span>
                    </div>
                    <p className="mt-1 leading-relaxed text-zinc-500">{signal.detail}</p>
                  </div>
                ))}
                <p className="leading-relaxed text-zinc-500">
                  方向判定阈值 ±{record.thresholdPercent.toFixed(2)}%；阈值内归为震荡。
                  每次结果已存档，相同已收盘锚点复用已有预测。
                </p>
              </div>
            </details>
          </div>
        )}
      </div>

      <section className="space-y-3 border-t border-zinc-800 pt-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-medium text-zinc-200">到期复盘</h3>
          <button type="button" onClick={forecast.review} disabled={historyLoading || !symbol}
            className="text-zinc-400 hover:text-zinc-100 disabled:cursor-wait disabled:text-zinc-600">
            {historyLoading ? '复盘中…' : '刷新复盘'}
          </button>
        </div>
        <p className="leading-relaxed text-zinc-500">
          仅统计 {symbol} · {interval}。预测区间全部收盘后，以同一数据源真实 K 线逐根复盘；待到期和缺失数据均不计为错误。
        </p>
        {historyError && <ErrorNotice message={historyError} retry={forecast.review} />}
        {stats && (
          <>
            <div className="flex items-baseline gap-3">
              <span className="font-mono text-2xl text-zinc-100">{percent(stats.hitRate)}</span>
              <span className="text-zinc-500">方向命中 · {stats.correct}/{stats.evaluated} 已复盘</span>
            </div>
            <div className="grid grid-cols-2 gap-2 rounded-lg bg-zinc-900 p-3 text-zinc-400">
              <Metric label="预测收盘误差" value={percent(stats.meanCloseMape)} />
              <Metric label="持平基线误差" value={percent(stats.meanBaselineMape)} />
              <Metric label="情景范围覆盖率" value={percent(stats.meanBoundCoverage)} />
              <Metric label="相对基线改善" value={percent(stats.skillScore)} />
            </div>
            <p className="text-[11px] leading-relaxed text-zinc-500">
              共 {stats.total} 条，{stats.pending} 条待复盘。收盘误差越低越好；相对基线改善大于 0 才优于价格保持不变。
              {stats.evaluated === 0 && ' 暂无到期样本，尚不能判断准确率。'}
            </p>
          </>
        )}
        {history?.evaluationErrors?.length ? (
          <div role="status" className="rounded bg-amber-500/10 p-2.5 text-amber-300">
            <p>部分到期记录暂未取得完整行情，保留待复盘：</p>
            {history.evaluationErrors.slice(0, 3).map((message, i) => <p key={i} className="mt-1 break-words">{message}</p>)}
          </div>
        ) : null}
        {history?.records.length === 0 && <p className="text-zinc-500">尚无预测记录。勾选预测走势后自动存档。</p>}
        <div className="space-y-2">
          {history?.records.slice(0, 12).map((item) => <HistoryRow key={item.id} record={item} />)}
        </div>
      </section>
      <KnowledgeNotes interval={interval} />
    </div>
  );
}

function ErrorNotice({ message, retry }: { message: string; retry: () => void }) {
  return (
    <div role="alert" className="space-y-2 rounded bg-rose-500/10 p-3 text-rose-300">
      <p className="break-words leading-relaxed">{message}</p>
      <button type="button" onClick={retry} className="underline underline-offset-2">重试</button>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><p className="text-[11px] text-zinc-500">{label}</p><p className="mt-1 font-mono">{value}</p></div>;
}

function HistoryRow({ record }: { record: ForecastRecord }) {
  const evaluation = record.evaluation;
  return (
    <details className="rounded border border-zinc-800 px-3 py-2">
      <summary className="cursor-pointer list-none">
        <div className="flex justify-between gap-2">
          <span className={DIRECTION_COLOR[record.direction]}>{DIRECTIONS[record.direction]} · {record.horizonBars} 根</span>
          <span className={evaluation ? evaluation.correct ? 'text-emerald-400' : 'text-rose-400' : 'text-zinc-500'}>
            {evaluation ? evaluation.correct ? '方向命中' : '方向未中' : '待复盘'}
          </span>
        </div>
        <p className="mt-1 text-[11px] text-zinc-500">生成 {dateTime(record.createdAt)} · 到期 {dateTime(record.targetEndTime)}</p>
      </summary>
      <div className="mt-3 space-y-2 border-t border-zinc-800 pt-2 text-zinc-400">
        <p>预测期末 {formatPrice(record.candles.at(-1)?.close)}{evaluation && ` · 实际 ${formatPrice(evaluation.actualClose)}`}</p>
        {evaluation && <p>收盘误差 {percent(evaluation.closeMape)} · 范围覆盖 {percent(evaluation.boundCoverage)}</p>}
        <p className="break-all text-[11px] text-zinc-500">{record.source} · {record.modelVersion} · 知识库 {record.knowledgeVersion}</p>
      </div>
    </details>
  );
}

interface KnowledgeEntry {
  id: string;
  title: string;
  summary: string;
  timeframes: Interval[];
  limitations: string[];
  sources: { title: string; url: string; publisher: string; retrievedAt: string }[];
}

function KnowledgeNotes({ interval }: { interval: Interval }) {
  const [data, setData] = useState<{ version: string; entries: KnowledgeEntry[] } | null>(null);
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ac = new AbortController();
    fetch('/api/forecast/knowledge', { signal: ac.signal })
      .then(async (response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((value) => { if (!ac.signal.aborted) { setData(value); setError(false); } })
      .catch(() => { if (!ac.signal.aborted) setError(true); });
    return () => ac.abort();
  }, [attempt]);
  return (
    <details className="border-t border-zinc-800 pt-4">
      <summary className="cursor-pointer text-zinc-300">技术预测知识库 · 来源与局限</summary>
      <div className="mt-3 space-y-4">
        {!data && !error && <p className="text-zinc-500">加载知识库…</p>}
        {error && <ErrorNotice message="知识库加载失败" retry={() => setAttempt((v) => v + 1)} />}
        {data?.entries.filter((entry) => entry.timeframes.includes(interval)).map((entry) => (
          <div key={entry.id} className="space-y-2">
            <h4 className="text-zinc-300">{entry.title}</h4>
            <p className="leading-relaxed text-zinc-500">{entry.summary}</p>
            <p className="leading-relaxed text-amber-300/75">{entry.limitations.join('；')}</p>
            <div className="flex flex-wrap gap-x-3 gap-y-1">
              {entry.sources.map((source) => (
                <a key={source.url} href={source.url} target="_blank" rel="noreferrer"
                  title={source.title} className="text-violet-300 hover:underline">{source.publisher} ↗</a>
              ))}
            </div>
          </div>
        ))}
        {data && <p className="text-[11px] text-zinc-600">知识库版本 {data.version}</p>}
      </div>
    </details>
  );
}
