'use client';

import { useEffect, useState } from 'react';
import type { Resonance } from '@/lib/indicators/resonance';

const VERDICT: Record<Resonance['verdict'], { label: string; cls: string }> = {
  bullish: { label: '共振偏多', cls: 'text-emerald-400' },
  bearish: { label: '共振偏空', cls: 'text-rose-400' },
  conflicted: { label: '周期背离', cls: 'text-amber-400' },
  mixed: { label: '未形成共振', cls: 'text-zinc-400' },
};

const BIAS_MARK: Record<string, { text: string; cls: string }> = {
  bullish: { text: '多', cls: 'bg-emerald-500/15 text-emerald-400' },
  bearish: { text: '空', cls: 'bg-rose-500/15 text-rose-400' },
  neutral: { text: '中', cls: 'bg-zinc-700/50 text-zinc-500' },
};

/**
 * 多周期共振。
 *
 * 刻意不做成一个大分数配进度条：那种呈现方式会让人以为它是预测。
 * 实测里只有「背离时更容易走震荡」这一条有较弱支持，
 * 方向类结论在换一段行情后未必成立——所以这里的主角是
 * 「哪几个周期指向哪边」这个事实，分数只是它的摘要。
 */
export function ResonancePanel({ symbol }: { symbol: string }) {
  const [result, setResult] = useState<{ key: string; data: Resonance | null }>({
    key: '',
    data: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/market/resonance?symbol=${symbol}`)
      .then((r) => r.json())
      .then((d: { resonance: Resonance | null }) => {
        if (!cancelled) setResult({ key: symbol, data: d.resonance });
      })
      .catch(() => {
        if (!cancelled) setResult({ key: symbol, data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  const res = result.key === symbol ? result.data : null;
  if (!res) return null;

  const v = VERDICT[res.verdict];

  return (
    <div className="border-b border-zinc-800 px-4 py-3">
      <div className="flex items-center justify-between">
        <span
          className="cursor-help text-xs uppercase tracking-wide text-zinc-500"
          title="1h / 4h / 1d 三个周期的技术面状态是否指向同一方向。这是一致性的度量，不是预测——实测中只有「背离时更易走震荡」有较弱支持。"
        >
          多周期共振
        </span>
        <span className={`text-xs font-medium ${v.cls}`}>{v.label}</span>
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        {res.perInterval.map((p) => {
          const m = BIAS_MARK[p.bias] ?? BIAS_MARK.neutral;
          return (
            <span
              key={p.interval}
              className={`rounded px-1.5 py-0.5 text-[11px] tabular-nums ${m.cls}`}
              title={`${p.interval} 周期${m.text === '中' ? '无明确方向' : `偏${m.text}`}（权重 ${p.weight}）`}
            >
              {p.interval} {m.text}
            </span>
          );
        })}
        <span className="ml-auto font-mono text-[11px] text-zinc-600 tabular-nums">
          一致性 {res.agreement}%
        </span>
      </div>

      <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600">{res.summary}</p>
    </div>
  );
}
