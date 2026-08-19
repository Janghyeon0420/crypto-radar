'use client';

import { useState } from 'react';
import type { Analysis } from '@/lib/analysis/schema';
import { formatPrice, timeAgo } from '@/lib/format';

const DIRECTION = {
  bullish: { label: '看涨', cls: 'text-emerald-400', bar: 'bg-emerald-500' },
  bearish: { label: '看跌', cls: 'text-rose-400', bar: 'bg-rose-500' },
  neutral: { label: '震荡', cls: 'text-zinc-300', bar: 'bg-zinc-500' },
} as const;

const DIMENSION_LABEL: Record<string, string> = {
  technical: '技术面',
  momentum: '动能',
  volume: '量能',
  derivatives: '衍生品',
  sentiment: '情绪',
  news: '资讯',
};

/**
 * LLM 综合研判。
 *
 * 手动触发而非自动轮询：每次研判都是一次真金白银的 API 调用，
 * 而且行情几分钟内的变化通常不足以改变研判结论，自动刷新纯属烧钱。
 */
export function AnalysisPanel({
  symbol,
  onAnalyzed,
}: {
  symbol: string;
  /** 研判成功后通知父组件——准确率面板需要重新拉取以显示这条新记录 */
  onAnalyzed?: () => void;
}) {
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [generatedAt, setGeneratedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAnalysis(data.analysis);
      setGeneratedAt(data.generatedAt);
      onAnalyzed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">AI 综合研判</h3>
        <button
          onClick={run}
          disabled={loading}
          className="rounded-lg bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
        >
          {loading ? '研判中…' : analysis ? '重新研判' : '开始研判'}
        </button>
      </div>

      {error && (
        <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-400 ring-1 ring-rose-500/20">
          {error}
        </p>
      )}

      {!analysis && !error && !loading && (
        <p className="text-xs leading-relaxed text-zinc-500">
          结合多周期技术面、衍生品资金费率、市场情绪与近期资讯，
          输出结构化走势研判与情景推演。需在 .env.local 配置 LLM 供应商——
          DeepSeek 国内直连可达、无需代理，是成本最低的选择；
          也支持 Anthropic 官方或任意 OpenAI 格式中转站。
        </p>
      )}

      {analysis && (
        <div className="space-y-4">
          <div>
            <p className={`text-base font-medium ${DIRECTION[analysis.direction].cls}`}>
              {analysis.headline}
            </p>
            <div className="mt-2 flex items-center gap-2">
              <span className="text-xs text-zinc-500">置信度</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-zinc-800">
                <div
                  className={`h-full ${DIRECTION[analysis.direction].bar}`}
                  style={{ width: `${Math.max(0, Math.min(100, analysis.confidence))}%` }}
                />
              </div>
              <span className="font-mono text-xs text-zinc-300 tabular-nums">
                {analysis.confidence}
              </span>
            </div>
          </div>

          <Section title="因子拆解">
            {analysis.factors.map((f, i) => (
              <div key={i} className="flex gap-2 text-xs">
                <span className="w-14 shrink-0 text-zinc-500">
                  {DIMENSION_LABEL[f.dimension] ?? f.dimension}
                </span>
                <span className={`w-8 shrink-0 ${DIRECTION[f.stance].cls}`}>
                  {DIRECTION[f.stance].label}
                </span>
                <span className="text-zinc-400">{f.note}</span>
              </div>
            ))}
          </Section>

          <Section title="情景推演">
            {analysis.scenarios.map((s, i) => (
              <div key={i} className="text-xs">
                <div className="flex items-baseline justify-between">
                  <span className="text-zinc-200">{s.name}</span>
                  <span className="font-mono text-zinc-400 tabular-nums">{s.probability}%</span>
                </div>
                <p className="mt-0.5 text-zinc-500">触发：{s.trigger}</p>
                <p className="text-zinc-500">目标：{s.target}</p>
              </div>
            ))}
          </Section>

          <Section title="关键价位">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <span className="text-zinc-500">
                支撑{' '}
                <span className="font-mono text-emerald-400">
                  {analysis.levels.supports.map(formatPrice).join(' / ') || '—'}
                </span>
              </span>
              <span className="text-zinc-500">
                阻力{' '}
                <span className="font-mono text-rose-400">
                  {analysis.levels.resistances.map(formatPrice).join(' / ') || '—'}
                </span>
              </span>
              <span className="text-zinc-500">
                失效价{' '}
                <span className="font-mono text-amber-400">
                  {formatPrice(analysis.levels.invalidation)}
                </span>
              </span>
            </div>
          </Section>

          <Section title="风险">
            <ul className="space-y-1 text-xs text-zinc-400">
              {analysis.risks.map((r, i) => (
                <li key={i} className="flex gap-1.5">
                  <span className="text-amber-500">!</span>
                  {r}
                </li>
              ))}
            </ul>
          </Section>

          {analysis.dataGaps.length > 0 && (
            <Section title="数据缺口">
              <ul className="space-y-1 text-xs text-zinc-500">
                {analysis.dataGaps.map((g, i) => (
                  <li key={i}>· {g}</li>
                ))}
              </ul>
            </Section>
          )}

          <p className="border-t border-zinc-800 pt-3 text-[11px] leading-relaxed text-zinc-600">
            {generatedAt && `生成于 ${timeAgo(generatedAt)}。`}
            以上为模型基于公开数据的分析，不构成投资建议。加密市场波动剧烈，请自行判断并承担风险。
          </p>
        </div>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5 border-t border-zinc-800 pt-3">
      <p className="text-xs uppercase tracking-wide text-zinc-500">{title}</p>
      {children}
    </div>
  );
}
