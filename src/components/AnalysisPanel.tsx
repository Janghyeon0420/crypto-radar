'use client';

import { useState } from 'react';
import type { Analysis } from '@/lib/analysis/schema';
import type { Calibration } from '@/lib/history/calibrate';
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
  macro: '宏观',
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
  /** 本次结果是否来自缓存，以及复用的理由 */
  const [cache, setCache] = useState<{ cached: boolean; reason?: string } | null>(null);
  /** 用历史命中率校准后的置信度。样本不够时是 insufficient，不出数 */
  const [calibration, setCalibration] = useState<Calibration | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * @param force 跳过缓存强制重新生成。
   *   默认走缓存是为了控制成本——每次研判都是一次真实付费调用，
   *   而几分钟内的行情变化通常不足以改变结论。
   */
  const run = async (force = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/analysis', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, force }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setAnalysis(data.analysis);
      setGeneratedAt(data.generatedAt);
      setCache({ cached: Boolean(data.cached), reason: data.cacheReason });
      setCalibration(data.calibration ?? null);
      // 命中缓存时没有新记录产生，不必刷新准确率面板
      if (!data.cached) onAnalyzed?.();
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
          onClick={() => run(false)}
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
          {/* 命中缓存时明确告知，并提供强制重算入口——
              让用户清楚这次没有产生费用，也知道怎么拿到最新结论 */}
          {cache?.cached && (
            <div className="flex items-start justify-between gap-2 rounded-lg bg-sky-500/10 px-3 py-2 ring-1 ring-sky-500/20">
              <p className="text-[11px] leading-relaxed text-sky-300/90">
                {cache.reason ?? '复用了此前的研判结果'}，本次未产生调用费用
              </p>
              <button
                onClick={() => run(true)}
                disabled={loading}
                className="shrink-0 text-[11px] text-sky-400 underline-offset-2 hover:underline disabled:text-zinc-600"
              >
                强制重算
              </button>
            </div>
          )}

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
            <CalibrationNote calibration={calibration} />
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
            {generatedAt && `${cache?.cached ? '原研判生成于' : '生成于'} ${timeAgo(generatedAt)}。`}
            以上为模型基于公开数据的分析，不构成投资建议。加密市场波动剧烈，请自行判断并承担风险。
          </p>
        </div>
      )}
    </div>
  );
}

/**
 * 历史校准后的置信度。
 *
 * 这里的克制是刻意的：样本不足时**不显示任何数字**，只说还差多少条。
 * 用 2 条样本算出的「校准后 0%」看起来和用 200 条算出的一样权威，
 * 而它的用途恰恰是判断「这条结论该信几分」——宁可不说，不能误导。
 */
function CalibrationNote({ calibration }: { calibration: Calibration | null }) {
  if (!calibration) return null;

  if (calibration.status === 'insufficient') {
    return (
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
        历史样本不足，暂不校准（已检验 {calibration.evaluated} 条，还需 {calibration.needed} 条）。
        研判到期后会自动检验，攒够了这里会显示按历史命中率修正过的置信度。
      </p>
    );
  }

  const delta = calibration.calibrated - calibration.stated;
  // 只有下调才是需要警惕的信号：模型说得比实际准，用的时候要打折
  const tone = delta <= -5 ? 'text-amber-400' : 'text-zinc-400';

  return (
    <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
      <span className={tone}>
        历史校准后约 {calibration.calibrated}%（±{calibration.uncertainty}）
      </span>
      {' · '}
      基于 {calibration.sampleSize} 条
      {calibration.scope === 'bucket' ? '同区间' : '全部'}样本
      {calibration.weak && ' · 样本仍偏少，参考性弱'}
    </p>
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
