'use client';

import { useMacro, countdownToMeeting } from '@/lib/hooks/useMacro';
import { timeAgo } from '@/lib/format';
import type { HawkDoveResult } from '@/lib/macro/hawkdove';

const STANCE: Record<HawkDoveResult['stance'], { label: string; cls: string; bar: string }> = {
  hawkish: { label: '偏鹰', cls: 'text-rose-400', bar: 'bg-rose-500' },
  dovish: { label: '偏鸽', cls: 'text-emerald-400', bar: 'bg-emerald-500' },
  neutral: { label: '中性', cls: 'text-zinc-300', bar: 'bg-zinc-500' },
};

const IMPACT: Record<string, string> = {
  'risk-off': '对加密偏空',
  'risk-on': '对加密偏多',
  neutral: '方向性含义有限',
};

/**
 * 宏观面板：鹰鸽判断、流动性、政策利率、议息倒计时、数据发布日历、官方资讯。
 *
 * 排序即优先级。鹰鸽判断放最上面，因为它是这一层里唯一直接刻画
 * 「美联储态度」的量，而其余都是它的背景或结果。
 */
export function MacroPanel() {
  const { macro, loading } = useMacro();

  if (loading) return <div className="p-4 text-xs text-zinc-600">加载中…</div>;
  if (!macro) return <div className="p-4 text-xs text-zinc-600">宏观数据不可用</div>;

  const st = macro.statement;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-zinc-200">宏观 · 美联储</h3>
        <span className="text-[11px] text-zinc-600">流动性背景，非择时信号</span>
      </div>

      {/* ── 鹰鸽判断：本层最核心的一块 ── */}
      {st && (
        <section className="mb-4 rounded-lg bg-zinc-900/60 p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-zinc-500">最新声明措辞</span>
            <span className={`text-xs font-medium ${STANCE[st.analysis.stance].cls}`}>
              {STANCE[st.analysis.stance].label} {st.analysis.score > 0 ? '+' : ''}
              {st.analysis.score}
            </span>
          </div>

          {/* 分数条：中点为 0，向左鸽向右鹰 */}
          <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-600" />
            <div
              className={`absolute top-0 h-full ${STANCE[st.analysis.stance].bar}`}
              style={{
                left: st.analysis.score >= 0 ? '50%' : `${50 + st.analysis.score / 2}%`,
                width: `${Math.abs(st.analysis.score) / 2}%`,
              }}
            />
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            {st.title} ·{' '}
            {st.analysis.action === 'raise'
              ? '加息'
              : st.analysis.action === 'lower'
                ? '降息'
                : st.analysis.action === 'maintain'
                  ? '维持不变'
                  : '动作未识别'}
            {st.analysis.dissent &&
              ` · ${st.analysis.dissent.against} 票反对，主张${
                st.analysis.dissent.direction === 'hawkish' ? '更紧' : '更松'
              }`}
          </p>

          {/* 逐条依据。不可核对的情绪分在这里没有价值 */}
          <details className="mt-2 group">
            <summary className="cursor-pointer text-[11px] text-zinc-600 hover:text-zinc-400">
              逐条依据（{st.analysis.evidence.length} 条）
            </summary>
            <ul className="mt-1.5 space-y-1">
              {st.analysis.evidence.map((e, i) => (
                <li key={i} className="flex gap-2 text-[11px] leading-relaxed">
                  <span
                    className={`w-8 shrink-0 text-right font-mono tabular-nums ${
                      e.weight > 0 ? 'text-rose-400' : e.weight < 0 ? 'text-emerald-400' : 'text-zinc-600'
                    }`}
                  >
                    {e.weight > 0 ? '+' : ''}
                    {e.weight}
                  </span>
                  <span className="text-zinc-500">
                    {e.phrase}
                    {e.note && <span className="text-zinc-600"> — {e.note}</span>}
                  </span>
                </li>
              ))}
            </ul>
          </details>

          <p className="mt-2 border-t border-zinc-800 pt-2 text-[11px] leading-relaxed text-zinc-600">
            <span className={STANCE[st.analysis.stance].cls}>
              {IMPACT[st.analysis.cryptoImpact.direction]}
            </span>
            {' · '}
            {st.analysis.cryptoImpact.note}
          </p>
          <a
            href={st.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-[11px] text-zinc-600 underline hover:text-zinc-400"
          >
            读官方原文
          </a>
        </section>
      )}

      {/* ── 流动性 ── */}
      {macro.netLiquidity && (
        <section className="mb-4 rounded-lg bg-zinc-900/60 p-3">
          <p className="text-xs text-zinc-500">净流动性</p>
          <p className="mt-1 font-mono text-lg text-zinc-100 tabular-nums">
            {(macro.netLiquidity.value / 1000).toFixed(2)} 万亿
            {macro.netLiquidity.changePercent !== null && (
              <span
                className={`ml-2 text-xs ${
                  macro.netLiquidity.changePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                近月 {macro.netLiquidity.changePercent >= 0 ? '+' : ''}
                {macro.netLiquidity.changePercent.toFixed(2)}%
              </span>
            )}
          </p>
          <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-600">
            美联储总资产 {macro.netLiquidity.components.walcl.toFixed(0)} − 逆回购{' '}
            {macro.netLiquidity.components.reverseRepo.toFixed(0)} − 财政部账户{' '}
            {macro.netLiquidity.components.tga.toFixed(0)}（十亿美元）
            <br />
            度量市场上实际可用的钱，比利率水平更直接。三项频率不同，日期未必对齐。
          </p>
        </section>
      )}

      {/* ── 利率与议息 ── */}
      <div className="mb-4 grid grid-cols-2 gap-2">
        <section className="rounded-lg bg-zinc-900/60 p-3">
          <p className="text-xs text-zinc-500">联邦基金利率</p>
          {macro.policyRate ? (
            <>
              <p className="mt-1 font-mono text-zinc-100 tabular-nums">
                {macro.policyRate.targetLow.toFixed(2)}–{macro.policyRate.targetHigh.toFixed(2)}%
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-600">
                EFFR {macro.policyRate.effectiveRate.toFixed(2)}%
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-zinc-600">—</p>
          )}
        </section>

        <section className="rounded-lg bg-zinc-900/60 p-3">
          <p className="text-xs text-zinc-500">下次议息</p>
          {macro.nextMeeting ? (
            <>
              <p className="mt-1 font-mono text-amber-400 tabular-nums">
                {countdownToMeeting(macro.nextMeeting.decisionAt)}
              </p>
              <p className="mt-0.5 text-[11px] text-zinc-600">
                {macro.nextMeeting.label.replace(/^\d+ 年 /, '')}
                {macro.nextMeeting.hasProjections && ' · 点阵图'}
              </p>
            </>
          ) : (
            <p className="mt-1 text-xs text-zinc-600">—</p>
          )}
        </section>
      </div>

      {/* ── 关键数值 ── */}
      {macro.series.length > 0 && (
        <section className="mb-4">
          <h4 className="mb-1.5 text-xs font-medium text-zinc-400">关键宏观数值</h4>
          <div className="space-y-1">
            {macro.series.map((s) => {
              const delta = s.previous ? s.latest.value - s.previous.value : null;
              return (
                <div key={s.id} className="flex items-baseline gap-2 text-[11px]">
                  <span className="flex-1 truncate text-zinc-500">{s.label}</span>
                  <span className="font-mono text-zinc-300 tabular-nums">
                    {s.latest.value.toFixed(2)}
                    {s.unit === 'percent' ? '%' : ''}
                  </span>
                  {delta !== null && Math.abs(delta) > 0.001 && (
                    <span
                      className={`w-14 text-right font-mono tabular-nums ${
                        delta > 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {delta > 0 ? '+' : ''}
                      {delta.toFixed(2)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── 数据发布日历 ── */}
      {macro.releases.length > 0 && (
        <section className="mb-4">
          <h4 className="mb-1.5 text-xs font-medium text-zinc-400">即将发布</h4>
          <ul className="space-y-1">
            {macro.releases.slice(0, 5).map((r) => (
              <li key={`${r.name}${r.date}`} className="flex items-baseline gap-2 text-[11px]">
                <span className="font-mono text-zinc-600 tabular-nums">{r.date.slice(5)}</span>
                <span className="text-zinc-500">{r.name}</span>
                <span className="ml-auto text-zinc-600">{r.daysAway} 天后</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 资讯 ── */}
      <h4 className="mb-2 text-xs font-medium text-zinc-400">宏观资讯</h4>
      {macro.news.length === 0 ? (
        <p className="text-xs text-zinc-600">暂无</p>
      ) : (
        <ul className="space-y-3">
          {macro.news.map((n) => (
            <li key={n.url}>
              <a
                href={n.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-xs leading-relaxed text-zinc-300 hover:text-zinc-100"
              >
                {n.title}
              </a>
              <p className="mt-0.5 text-[11px] text-zinc-600">
                {n.source} · {timeAgo(n.publishedAt)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
