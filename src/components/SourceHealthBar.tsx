'use client';

import { useEffect, useState } from 'react';
import type { SourceHealth } from '@/lib/datasources/types';

/**
 * 数据源状态条。
 *
 * 在受地区限制的网络下，"哪个源今天通不通"是会变的，必须显式暴露给用户，
 * 否则图表空白时无从判断是网络问题、上游故障还是代码 bug。
 * 其中「币安主站」是故意保留的对照探针，预期为红色。
 */
export function SourceHealthBar() {
  const [sources, setSources] = useState<SourceHealth[]>([]);
  const [llmConfigured, setLlmConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    const load = () =>
      fetch('/api/health')
        .then((r) => r.json())
        .then((d: { sources: SourceHealth[]; llmConfigured: boolean }) => {
          setSources(d.sources);
          setLlmConfigured(d.llmConfigured);
        })
        .catch(() => setSources([]));
    load();
    const timer = setInterval(load, 120_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
      {sources.map((s) => {
        // 主站探针失败是预期结果，不该显示成告警红
        const expectedFail = s.id === 'binance-main';
        const color = s.ok
          ? 'bg-emerald-500'
          : expectedFail
            ? 'bg-zinc-600'
            : 'bg-rose-500';
        return (
          <span key={s.id} className="flex items-center gap-1.5" title={s.error ?? `${s.latencyMs}ms`}>
            <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
            {s.label}
            {expectedFail && !s.ok && <span className="text-zinc-700">已封锁·符合预期</span>}
          </span>
        );
      })}
      {llmConfigured === false && (
        <span className="flex items-center gap-1.5 text-amber-500/70">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          未配置 ANTHROPIC_API_KEY
        </span>
      )}
    </div>
  );
}
