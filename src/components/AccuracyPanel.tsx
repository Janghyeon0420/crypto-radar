'use client';

import { useEffect, useState } from 'react';
import type { AccuracyStats, AnalysisRecord } from '@/lib/history/types';
import { formatPrice, timeAgo } from '@/lib/format';

interface HistoryResponse {
  records: AnalysisRecord[];
  stats: AccuracyStats;
  globalStats: AccuracyStats | null;
}

/**
 * 研判准确率。
 *
 * 这个面板的设计目标是"不许自我感觉良好"：
 * 命中率旁边永远并排显示无脑基线，校准表直接暴露置信度是不是虚高。
 */
export function AccuracyPanel({ symbol, refreshKey }: { symbol: string; refreshKey: number }) {
  const [data, setData] = useState<HistoryResponse | null>(null);
  const [scope, setScope] = useState<'symbol' | 'all'>('all');
  const [loaded, setLoaded] = useState('');

  const requestKey = `${scope === 'symbol' ? symbol : ''}|${refreshKey}`;
  const loading = loaded !== requestKey;

  useEffect(() => {
    let cancelled = false;
    const url = scope === 'symbol' ? `/api/analysis/history?symbol=${symbol}` : '/api/analysis/history';
    fetch(url)
      .then((r) => r.json())
      .then((d: HistoryResponse) => {
        if (cancelled) return;
        setData(d);
        setLoaded(requestKey);
      })
      .catch(() => {
        if (!cancelled) setLoaded(requestKey);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, scope, requestKey]);

  const stats = data?.stats;

  return (
    <div className="space-y-3 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">研判准确率</h3>
        <button
          onClick={() => setScope((s) => (s === 'all' ? 'symbol' : 'all'))}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          {scope === 'all' ? '全部币种' : `仅 ${symbol}`}
        </button>
      </div>

      {loading && !data && <p className="text-xs text-zinc-600">加载中…</p>}

      {stats && stats.total === 0 && (
        <p className="text-xs leading-relaxed text-zinc-600">
          还没有研判记录。每次点击「开始研判」都会自动存档，
          到达该研判声明的时间尺度后（日内 24h / 数日 7d / 数周 30d）会自动检验并计入准确率。
        </p>
      )}

      {stats && stats.total > 0 && (
        <div className="space-y-4">
          <div className="flex items-baseline gap-3">
            <span className="font-mono text-2xl text-zinc-100 tabular-nums">
              {stats.evaluated ? `${stats.hitRate.toFixed(0)}%` : '—'}
            </span>
            <span className="text-xs text-zinc-500">
              {stats.correct}/{stats.evaluated} 命中
              {stats.pending > 0 && ` · ${stats.pending} 条待检验`}
            </span>
          </div>

          {stats.evaluated > 0 && (
            <>
              {/* 基线对比。跑不赢无脑基线的模型没有价值，这个对比必须显眼。 */}
              <div className="rounded-lg bg-zinc-900 p-3">
                <p className="mb-1.5 text-xs text-zinc-500">对比基线</p>
                <div className="space-y-1 text-xs">
                  <Baseline label="全猜震荡" value={stats.baseline.alwaysNeutral} actual={stats.hitRate} />
                  <Baseline label="全猜上涨" value={stats.baseline.alwaysBullish} actual={stats.hitRate} />
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">
                  置信度校准
                </p>
                <p className="mb-2 text-[11px] leading-relaxed text-zinc-600">
                  左边是模型自称的把握，右边是实际命中率。两者差距大说明置信度虚高，使用时应打折。
                </p>
                <div className="space-y-1">
                  {stats.calibration
                    .filter((c) => c.count > 0)
                    .map((c) => (
                      <div key={c.bucket} className="flex items-center gap-2 text-xs">
                        <span className="w-14 shrink-0 font-mono text-zinc-500">{c.bucket}</span>
                        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className={`h-full ${
                              c.hitRate >= c.avgConfidence ? 'bg-emerald-500' : 'bg-amber-500'
                            }`}
                            style={{ width: `${Math.min(100, c.hitRate)}%` }}
                          />
                        </div>
                        <span className="w-16 shrink-0 text-right font-mono text-zinc-400 tabular-nums">
                          {c.hitRate.toFixed(0)}%
                        </span>
                        <span className="w-6 shrink-0 text-right text-zinc-600">{c.count}</span>
                      </div>
                    ))}
                </div>
              </div>

              <div>
                <p className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">按方向</p>
                <div className="space-y-1 text-xs">
                  {stats.byDirection
                    .filter((d) => d.count > 0)
                    .map((d) => (
                      <div key={d.direction} className="flex justify-between">
                        <span className="text-zinc-400">
                          {{ bullish: '看涨', bearish: '看跌', neutral: '震荡' }[d.direction]}
                          <span className="ml-1 text-zinc-600">×{d.count}</span>
                        </span>
                        <span className="font-mono text-zinc-300 tabular-nums">
                          {d.hitRate.toFixed(0)}%
                        </span>
                      </div>
                    ))}
                </div>
              </div>

              <p className="text-xs text-zinc-500">
                失效价触及率{' '}
                <span className="font-mono text-amber-400">{stats.invalidationRate.toFixed(0)}%</span>
              </p>
            </>
          )}

          {data && data.records.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wide text-zinc-500">最近研判</p>
              <div className="space-y-2">
                {data.records.slice(0, 8).map((r) => (
                  <RecordRow key={r.id} record={r} showSymbol={scope === 'all'} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Baseline({ label, value, actual }: { label: string; value: number; actual: number }) {
  const beats = actual > value;
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-500">{label}</span>
      <span className="flex items-center gap-2">
        <span className="font-mono text-zinc-400 tabular-nums">{value.toFixed(0)}%</span>
        <span className={`text-[11px] ${beats ? 'text-emerald-400' : 'text-rose-400'}`}>
          {beats ? `领先 ${(actual - value).toFixed(0)}pt` : `落后 ${(value - actual).toFixed(0)}pt`}
        </span>
      </span>
    </div>
  );
}

const DIR_LABEL = { bullish: '看涨', bearish: '看跌', neutral: '震荡' } as const;
const DIR_COLOR = {
  bullish: 'text-emerald-400',
  bearish: 'text-rose-400',
  neutral: 'text-zinc-400',
} as const;

function RecordRow({ record, showSymbol }: { record: AnalysisRecord; showSymbol: boolean }) {
  const e = record.evaluation;
  return (
    <div className="flex items-start justify-between gap-2 text-xs">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          {showSymbol && (
            <span className="text-zinc-300">{record.symbol.replace(/USDT$/, '')}</span>
          )}
          <span className={DIR_COLOR[record.analysis.direction]}>
            {DIR_LABEL[record.analysis.direction]}
          </span>
          <span className="text-zinc-600">{record.analysis.confidence}</span>
        </div>
        <p className="truncate text-[11px] text-zinc-600">
          {timeAgo(record.createdAt)} @ {formatPrice(record.priceAtAnalysis)}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {e ? (
          <>
            <span className={e.correct ? 'text-emerald-400' : 'text-rose-400'}>
              {e.correct ? '命中' : '未中'}
            </span>
            <p className={`font-mono text-[11px] tabular-nums ${
              e.changePercent >= 0 ? 'text-emerald-400/70' : 'text-rose-400/70'
            }`}>
              {e.changePercent >= 0 ? '+' : ''}
              {e.changePercent.toFixed(1)}%
            </p>
          </>
        ) : (
          <span className="text-zinc-600">待检验</span>
        )}
      </div>
    </div>
  );
}
