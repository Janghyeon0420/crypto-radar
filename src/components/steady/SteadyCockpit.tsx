'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import type { Holding, Plan } from '@/lib/steady/schema';
import type { SteadySummary } from '@/lib/steady/types';
import { EnvironmentStrip } from './EnvironmentStrip';
import { HoldingsEditor, PortfolioPanel } from './PortfolioPanel';
import { PlanEditor, PlanPanel } from './PlanPanel';
import { RiskPanel } from './RiskPanel';
import { TodayCard } from './TodayCard';
import { Button, Card } from './ui';

/** 页面可见时每分钟刷新一次估值。提示本身不该让人更频繁地盯盘，所以不更勤 */
const REFRESH_MS = 60_000;

type Editing = null | 'plan' | 'holdings';

/**
 * 稳健驾驶舱。
 *
 * 北极星是「稳健收益」，所以首页回答的不是「币价会怎样」，而是三个更靠谱的问题：
 *   今天我需要做什么？  → 今天要做什么（默认答案是「不用」）
 *   最坏会亏多少？      → 风险体检（历史回放 + 压力测试）
 *   我的规则是什么？    → 我的底线（冷静时写下，之后照做）
 * 行情雷达（原首页）保留在 /radar，给想自己研究的时候用。
 */
type Result = { summary: SteadySummary } | { error: string };

/** 读取或更新都走这一个函数：任何失败都变成一句可展示的话，调用方不用各写一遍 try/catch */
async function request(init?: RequestInit): Promise<Result> {
  try {
    const res = await fetch('/api/steady', { cache: 'no-store', ...init });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return { error: (data && data.error) || `HTTP ${res.status}` };
    return { summary: data as SteadySummary };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function SteadyCockpit() {
  const [summary, setSummary] = useState<SteadySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing>(null);

  const take = useCallback((r: Result): string | null => {
    if ('error' in r) return r.error;
    setSummary(r.summary);
    setError(null);
    return null;
  }, []);

  const reload = useCallback(async () => {
    const err = take(await request());
    if (err) setError(err);
  }, [take]);

  useEffect(() => {
    let cancelled = false;
    const run = () =>
      request().then((r) => {
        if (cancelled) return;
        const err = take(r);
        if (err) setError(err);
      });
    run();
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') run();
    }, REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [take]);

  const save = useCallback(
    async (body: { plan?: Plan | null; holdings?: Holding[] }): Promise<string | null> => {
      const err = take(
        await request({
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      if (!err) setEditing(null);
      return err;
    },
    [take],
  );

  const plan = summary?.plan ?? null;
  const hasHoldings = (summary?.holdings.length ?? 0) > 0;
  const firstRun = summary != null && !plan;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-200">
      <header className="border-b border-zinc-800/80">
        <div className="mx-auto flex max-w-4xl items-center justify-between gap-3 px-4 py-3">
          <div>
            <h1 className="text-base font-semibold text-zinc-100">稳健驾驶舱</h1>
            <p className="text-[11px] text-zinc-500">先看风险，再谈机会 · 你的规则，你自己执行</p>
          </div>
          <Link
            href="/radar"
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs text-zinc-400 ring-1 ring-zinc-800 transition-colors hover:text-zinc-200 hover:ring-zinc-600"
          >
            行情雷达 →
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-4xl space-y-4 px-4 py-5">
        {error && (
          <div className="flex items-start justify-between gap-3 rounded-lg bg-rose-500/10 px-3 py-2 ring-1 ring-rose-500/20">
            <p className="text-xs leading-relaxed text-rose-400">{error}</p>
            <button onClick={reload} className="shrink-0 text-xs text-rose-300 underline-offset-2 hover:underline">
              重试
            </button>
          </div>
        )}

        {!summary && !error && <p className="py-10 text-center text-xs text-zinc-600">正在读取你的计划与行情…</p>}

        {summary && firstRun && (
          <>
            <Intro />
            <PlanEditor initial={null} firstRun onSave={(p) => save({ plan: p })} />
          </>
        )}

        {summary && plan && (
          <>
            <TodayCard actions={summary.actions} />

            {editing === 'plan' ? (
              <PlanEditor initial={plan} onSave={(p) => save({ plan: p })} onCancel={() => setEditing(null)} />
            ) : null}

            {!hasHoldings && editing !== 'holdings' && (
              <Card title="下一步：录入你的持仓" hint="只存在这台电脑上。有了持仓才能做风险体检。">
                <Button variant="primary" onClick={() => setEditing('holdings')}>
                  录入持仓
                </Button>
              </Card>
            )}

            {editing === 'holdings' && (
              <HoldingsEditor
                holdings={summary.holdings}
                onSave={(h) => save({ holdings: h })}
                onCancel={() => setEditing(null)}
              />
            )}

            {/* 组合表格有五列，需要比计划卡更宽：计划 2 : 组合 3 */}
            <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
              {editing !== 'plan' && (
                <div className={hasHoldings && summary.portfolio && editing !== 'holdings' ? 'min-w-0 md:col-span-2' : 'min-w-0 md:col-span-5'}>
                  <PlanPanel plan={plan} budget={summary.budget} onEdit={() => setEditing('plan')} />
                </div>
              )}
              {hasHoldings && summary.portfolio && editing !== 'holdings' && (
                <div className={editing !== 'plan' ? 'min-w-0 md:col-span-3' : 'min-w-0 md:col-span-5'}>
                  <PortfolioPanel
                    portfolio={summary.portfolio}
                    drift={summary.drift}
                    onEdit={() => setEditing('holdings')}
                  />
                </div>
              )}
            </div>

            {hasHoldings && <RiskPanel summary={summary} />}
            {summary.environment && <EnvironmentStrip env={summary.environment} />}

            {summary.dataGaps.length > 0 && (
              <Card title="数据缺口" hint="这些数字不能全信，请知悉。">
                <ul className="space-y-1 text-[11px] leading-relaxed text-zinc-500">
                  {summary.dataGaps.map((g, i) => (
                    <li key={i}>· {g}</li>
                  ))}
                </ul>
              </Card>
            )}
          </>
        )}

        <Disclaimer />
      </main>
    </div>
  );
}

function Intro() {
  return (
    <div className="rounded-xl bg-zinc-900/50 p-4 ring-1 ring-zinc-800">
      <h2 className="text-sm font-medium text-zinc-100">欢迎。先说一件事：这个页面不预测涨跌。</h2>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        对想要「稳健收益」的人来说，决定结果的往往不是猜中了多少次，而是三件事：<b className="text-zinc-300">别亏过头</b>、
        <b className="text-zinc-300">别在恐慌或兴奋时乱操作</b>、<b className="text-zinc-300">按规则持续做</b>。
        所以这里的做法是：你先在冷静时写下自己的底线，系统据此告诉你最多该持有多少加密资产、最坏会亏多少，
        并在每天告诉你「按你的规则，今天要不要做点什么」——大多数日子，答案是不用。
      </p>
    </div>
  );
}

function Disclaimer() {
  return (
    <footer className="space-y-1.5 pb-8 pt-2 text-[11px] leading-relaxed text-zinc-600">
      <p>
        <b className="text-zinc-500">这不是投资建议，也不保证收益。</b>
        页面里的所有提示都来自你自己设定的规则和公开历史数据的算术，不是对价格的预测，也不构成买卖建议。
        「稳健」不等于「保本」：加密资产历史上多次出现 75% 以上的回撤，你的本金可能出现大幅亏损。
      </p>
      <p>
        持仓与计划只保存在这台电脑的 data/steady.json 里，不上传、不需要任何交易所 API Key。
        风险数字依赖公开行情，行情源出问题时会在「数据缺口」里说明。
      </p>
    </footer>
  );
}
