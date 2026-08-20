'use client';

import { useMacro, countdownToMeeting } from '@/lib/hooks/useMacro';
import { timeAgo } from '@/lib/format';

/**
 * 宏观面板：美联储政策利率、下次议息、官方资讯。
 *
 * 单独成一个标签页而不是塞进资讯流，是因为这两类信息的节奏完全不同——
 * 加密资讯是"刷"的，宏观是"查"的。混在一起，几周一条的美联储讲话
 * 会被每小时几十条的行业资讯永久挤到列表末尾。
 */
export function MacroPanel() {
  const { macro, loading } = useMacro();

  return (
    <div className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-zinc-200">宏观 · 美联储</h3>
        <span className="text-[11px] text-zinc-600">流动性背景，非择时信号</span>
      </div>

      {loading && <p className="text-xs text-zinc-600">加载中…</p>}

      {!loading && macro && (
        <>
          {/* 政策利率 */}
          <section className="mb-4 rounded-lg bg-zinc-900/60 p-3">
            <p className="text-xs text-zinc-500">联邦基金利率</p>
            {macro.policyRate ? (
              <>
                <p className="mt-1 font-mono text-lg text-zinc-100 tabular-nums">
                  {macro.policyRate.targetLow.toFixed(2)}–{macro.policyRate.targetHigh.toFixed(2)}%
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-600">
                  目标区间 · 实际成交（EFFR）{macro.policyRate.effectiveRate.toFixed(2)}%
                  {macro.policyRate.effectiveDate && ` · ${macro.policyRate.effectiveDate}`}
                  {' · '}
                  {macro.policyRate.source}
                </p>
              </>
            ) : (
              <p className="mt-1 text-xs text-zinc-600">数据不可用</p>
            )}
          </section>

          {/* 下次议息 */}
          <section className="mb-4 rounded-lg bg-zinc-900/60 p-3">
            <p className="text-xs text-zinc-500">下次议息（FOMC）</p>
            {macro.nextMeeting ? (
              <>
                <p className="mt-1 text-sm text-zinc-100">
                  {macro.nextMeeting.label}
                  <span className="ml-2 font-mono text-amber-400 tabular-nums">
                    {countdownToMeeting(macro.nextMeeting.decisionAt)}
                  </span>
                </p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-600">
                  决议于美东 14:00 公布（北京时间{' '}
                  {new Date(macro.nextMeeting.decisionAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                  ）
                  {macro.nextMeeting.hasProjections && ' · 同场发布经济预测与点阵图'}
                </p>
              </>
            ) : (
              <p className="mt-1 text-xs text-zinc-600">
                日历不可用——官方未提供结构化接口，页面结构变动会导致解析失败
              </p>
            )}
          </section>

          {/* 官方资讯 */}
          <h4 className="mb-2 text-xs font-medium text-zinc-400">美联储官方发布</h4>
          {macro.news.length === 0 ? (
            <p className="text-xs text-zinc-600">暂无（资讯源不可用）</p>
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
        </>
      )}

      {!loading && !macro && <p className="text-xs text-zinc-600">宏观数据不可用</p>}
    </div>
  );
}
