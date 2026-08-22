'use client';

import { useEffect, useMemo, useState } from 'react';
import type { NewsItem } from '@/lib/datasources/types';
import type { DigestMark, Impact, NewsDigest, Stance } from '@/lib/analysis/news-digest';
import { timeAgo } from '@/lib/format';

/**
 * 鹰 = 收紧 / 风险偏好受压，鸽 = 宽松 / 风险偏好改善。
 * 配色与宏观面板保持一致：鹰红鸽绿。同一套语义在两处用不同颜色是纯粹的认知负担。
 */
const STANCE: Record<Stance, { label: string; short: string; cls: string; bar: string; ring: string }> = {
  hawkish: {
    label: '偏鹰',
    short: '鹰',
    cls: 'text-rose-400',
    bar: 'bg-rose-500',
    ring: 'bg-rose-500/10 text-rose-400 ring-rose-500/20',
  },
  dovish: {
    label: '偏鸽',
    short: '鸽',
    cls: 'text-emerald-400',
    bar: 'bg-emerald-500',
    ring: 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/20',
  },
  neutral: {
    label: '中性',
    short: '中',
    cls: 'text-zinc-300',
    bar: 'bg-zinc-500',
    ring: 'bg-zinc-500/10 text-zinc-400 ring-zinc-500/20',
  },
};

const IMPACT_LABEL: Record<Impact, string> = { high: '高', medium: '中', low: '低' };

/** 影响量级的权重。用于鹰鸽对比条——一条重大监管消息不该与一条日常动态等价 */
const IMPACT_WEIGHT: Record<Impact, number> = { high: 3, medium: 2, low: 1 };

interface DigestState {
  /** 这份结果对应的请求 key。loading 由它与当前 key 的比较推导，不单独存 */
  key: string;
  digest: NewsDigest | null;
  generatedAt: number | null;
  model: string | null;
  error: string | null;
}

const IDLE: DigestState = {
  key: '',
  digest: null,
  generatedAt: null,
  model: null,
  error: null,
};

/**
 * 资讯面板：AI 汇总 + 鹰鸽标识 + 逐条来源。
 *
 * 为什么不是一列标题：十几条标题读完也说不出"现在市场在担心什么"，
 * 而人不会真的一条条点开。所以这里先给结论（整体汇总、鹰鸽对比），
 * 再把结论拆回它的来源（每条资讯挂着鹰/鸽标签和归类理由）。
 *
 * 汇总与列表分两次请求：列表几百毫秒就到，汇总要等模型十几到几十秒。
 * 等待期间列表已经可读，而不是整个面板空着。
 */
export function NewsPanel({ baseAsset }: { baseAsset: string }) {
  const [filtered, setFiltered] = useState(true);
  // 同 Dashboard：结果连同它的请求 key 一起存，loading 由两者比较推导，
  // 避免切换币种时短暂显示上一个币的资讯。
  const [result, setResult] = useState<{ key: string; news: NewsItem[] }>({
    key: '',
    news: [],
  });
  const [state, setState] = useState<DigestState>(IDLE);

  const requestKey = `${baseAsset}|${filtered}`;
  const loading = result.key !== requestKey;
  const news = result.key === requestKey ? result.news : [];

  useEffect(() => {
    let cancelled = false;
    const url = filtered ? `/api/news?asset=${baseAsset}` : '/api/news';
    fetch(url)
      .then((r) => r.json())
      .then((d: { news: NewsItem[] }) => {
        if (!cancelled) setResult({ key: requestKey, news: d.news });
      })
      .catch(() => {
        if (!cancelled) setResult({ key: requestKey, news: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [baseAsset, filtered, requestKey]);

  /**
   * 「重新汇总」按钮的状态。
   *
   * 记的是 nonce 而不是一个 loading 标志：把 nonce 拼进请求 key 之后，
   * 点一次按钮 = 换一个 key = 走与切换币种完全相同的那条路径，
   * 不需要在 effect 里同步 setState 去点亮加载态。
   * target 限定这次强制刷新只作用于当下这个币种/范围。
   */
  const [refresh, setRefresh] = useState({ target: '', nonce: 0 });
  const forcing = refresh.target === requestKey;
  const digestKey = forcing ? `${requestKey}|${refresh.nonce}` : requestKey;
  const digestLoading = state.key !== digestKey;

  /**
   * 拉汇总。默认走服务端缓存是为了控制成本——每次汇总都是一次真实付费调用，
   * 而资讯面在缓存有效期（默认 20 分钟）内通常不会改变主线。
   */
  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams();
    if (filtered) params.set('asset', baseAsset);
    if (forcing) params.set('force', '1');

    fetch(`/api/news/digest?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setState({
          key: digestKey,
          digest: d.digest ?? null,
          generatedAt: d.generatedAt ?? null,
          model: d.model ?? null,
          error: d.error ?? null,
        });
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setState({ ...IDLE, key: digestKey, error: `汇总请求失败：${err.message}` });
      });

    return () => {
      cancelled = true;
    };
  }, [baseAsset, filtered, forcing, digestKey]);

  const digest = state.key === digestKey ? state.digest : null;

  /** 汇总里的标注按 url 挂回当前列表。编号在服务端已经映射过，这里只做拼接 */
  const marks = useMemo(() => {
    const map = new Map<string, DigestMark>();
    digest?.marks.forEach((m) => map.set(m.url, m));
    return map;
  }, [digest]);

  const shown = news.slice(0, 18);
  const groups = useMemo(() => {
    const rows = { hawkish: [] as Row[], dovish: [] as Row[], rest: [] as Row[] };

    for (const n of shown) {
      const mark = marks.get(n.url);
      const side = mark && mark.stance !== 'neutral' ? mark.stance : 'rest';
      rows[side].push({ news: n, mark });
    }
    // 同一侧内按影响量级排序：先看重的那条，而不是先看最新的那条
    const byImpact = (a: Row, b: Row) =>
      (b.mark ? IMPACT_WEIGHT[b.mark.impact] : 0) - (a.mark ? IMPACT_WEIGHT[a.mark.impact] : 0);
    rows.hawkish.sort(byImpact);
    rows.dovish.sort(byImpact);
    return rows;
  }, [shown, marks]);

  // 对比条用加权份额而不是条数：一条重大监管消息与一条日常动态不该等价
  const hawkWeight = weightOf(groups.hawkish);
  const doveWeight = weightOf(groups.dovish);
  const total = hawkWeight + doveWeight;

  /** 汇总生成之后才出现、因而没被它读到的资讯。不提示的话用户会以为汇总已经涵盖了全部 */
  const generatedAt = state.key === digestKey ? state.generatedAt : null;
  const pending = generatedAt
    ? shown.filter((n) => !marks.has(n.url) && n.publishedAt > generatedAt).length
    : 0;

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">
          资讯 <span className="text-xs text-zinc-600">· AI 汇总</span>
        </h3>
        <div className="flex items-center gap-3">
          <button
            onClick={() => setFiltered((f) => !f)}
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            {filtered ? `仅 ${baseAsset}` : '全市场'}
          </button>
          <button
            onClick={() => setRefresh((r) => ({ target: requestKey, nonce: r.nonce + 1 }))}
            disabled={digestLoading}
            title="跳过缓存重新汇总（一次真实的模型调用）"
            className={`text-xs ${
              digestLoading ? 'cursor-not-allowed text-zinc-700' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            重新汇总
          </button>
        </div>
      </div>

      {/* ── 整体汇总 ── */}
      {digestLoading && (
        <p className="mb-3 rounded-lg bg-zinc-900/60 p-3 text-xs text-zinc-600">
          AI 正在汇总这批资讯…（首次约 10–40 秒，之后 20 分钟内直接复用）
        </p>
      )}

      {!digestLoading && state.error && (
        <p className="mb-3 rounded-lg bg-zinc-900/60 p-3 text-[11px] leading-relaxed text-zinc-600">
          {state.error}
        </p>
      )}

      {digest && (
        <section className="mb-4 rounded-lg bg-zinc-900/60 p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-zinc-500">资讯面整体</span>
            <span className={`text-xs font-medium ${STANCE[digest.stance].cls}`}>
              {STANCE[digest.stance].label} {digest.score > 0 ? '+' : ''}
              {digest.score}
            </span>
          </div>

          {/* 分数条：中点为 0，向左鸽向右鹰。与宏观面板同一套画法 */}
          <div className="relative mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
            <div className="absolute left-1/2 top-0 h-full w-px bg-zinc-600" />
            <div
              className={`absolute top-0 h-full ${STANCE[digest.stance].bar}`}
              style={{
                left: digest.score >= 0 ? '50%' : `${50 + digest.score / 2}%`,
                width: `${Math.abs(digest.score) / 2}%`,
              }}
            />
          </div>

          <p className="mt-2.5 text-xs leading-relaxed text-zinc-300">{digest.summary}</p>

          <p className="mt-2 text-[11px] text-zinc-600">
            覆盖 {digest.marks.length} 条 · {generatedAt ? `${timeAgo(generatedAt)}生成` : ''}
            {state.model && ` · ${state.model}`}
            {pending > 0 && (
              <span className="text-amber-500/70"> · {pending} 条新资讯尚未纳入</span>
            )}
          </p>
        </section>
      )}

      {/* ── 鹰鸽对比 ── */}
      {digest && (
        <section className="mb-4">
          <h4 className="mb-1.5 text-xs font-medium text-zinc-400">鹰鸽对比</h4>

          <div className="flex h-2 overflow-hidden rounded-full bg-zinc-800">
            {total > 0 ? (
              <>
                <div
                  className="h-full bg-emerald-500/80"
                  style={{ width: `${(doveWeight / total) * 100}%` }}
                />
                <div
                  className="h-full bg-rose-500/80"
                  style={{ width: `${(hawkWeight / total) * 100}%` }}
                />
              </>
            ) : (
              <div className="h-full w-full bg-zinc-700" />
            )}
          </div>

          <div className="mt-1 flex justify-between text-[11px]">
            <span className="text-emerald-400">
              鸽 {groups.dovish.length} 条{total > 0 && ` · ${Math.round((doveWeight / total) * 100)}%`}
            </span>
            <span className="text-rose-400">
              {total > 0 && `${Math.round((hawkWeight / total) * 100)}% · `}鹰 {groups.hawkish.length} 条
            </span>
          </div>

          <div className="mt-2 space-y-1.5">
            <SideSummary side="hawkish" text={digest.hawkishSummary} />
            <SideSummary side="dovish" text={digest.dovishSummary} />
          </div>

          <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-600">
            占比按影响量级加权（高 3 / 中 2 / 低 1），不是条数占比——
            一条重大监管消息与一条日常动态不该等价。
          </p>

          {digest.watch.length > 0 && (
            <ul className="mt-2 space-y-1">
              {digest.watch.map((w, i) => (
                <li key={i} className="flex gap-1.5 text-[11px] leading-relaxed text-zinc-500">
                  <span className="text-zinc-700">盯</span>
                  {w}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {/* ── 逐条来源 ── */}
      {loading && <p className="text-xs text-zinc-600">加载中…</p>}
      {!loading && news.length === 0 && (
        <p className="text-xs text-zinc-600">
          {filtered ? `未匹配到 ${baseAsset} 相关资讯，可切换到全市场` : '暂无资讯'}
        </p>
      )}

      {groups.hawkish.length > 0 && (
        <NewsGroup title="鹰派资讯" side="hawkish" rows={groups.hawkish} />
      )}
      {groups.dovish.length > 0 && (
        <NewsGroup title="鸽派资讯" side="dovish" rows={groups.dovish} />
      )}

      {groups.rest.length > 0 &&
        (digest ? (
          <details className="mt-3 border-t border-zinc-800 pt-2">
            <summary className="cursor-pointer text-xs text-zinc-600 hover:text-zinc-400">
              其余资讯（{groups.rest.length} 条，未定性或与方向无关）
            </summary>
            <ul className="mt-2 space-y-3">
              {groups.rest.map((r) => (
                <NewsRow key={r.news.url} row={r} />
              ))}
            </ul>
          </details>
        ) : (
          // 汇总不可用时退回原来的纯列表，面板不该因为模型没配好就变空
          <ul className="space-y-3">
            {groups.rest.slice(0, 15).map((r) => (
              <NewsRow key={r.news.url} row={r} />
            ))}
          </ul>
        ))}
    </div>
  );
}

interface Row {
  news: NewsItem;
  mark?: DigestMark;
}

function weightOf(rows: Row[]): number {
  return rows.reduce((sum, r) => sum + (r.mark ? IMPACT_WEIGHT[r.mark.impact] : 0), 0);
}

function SideSummary({ side, text }: { side: Stance; text: string }) {
  return (
    <p className="flex gap-1.5 text-[11px] leading-relaxed text-zinc-500">
      <span className={`shrink-0 font-medium ${STANCE[side].cls}`}>{STANCE[side].short}</span>
      {text}
    </p>
  );
}

function NewsGroup({ title, side, rows }: { title: string; side: Stance; rows: Row[] }) {
  return (
    <section className="mb-4">
      <h4 className="mb-2 flex items-baseline gap-1.5 text-xs font-medium">
        <span className={STANCE[side].cls}>{title}</span>
        <span className="text-zinc-600">{rows.length} 条</span>
      </h4>
      <ul className="space-y-3">
        {rows.map((r) => (
          <NewsRow key={r.news.url} row={r} />
        ))}
      </ul>
    </section>
  );
}

/**
 * 一条资讯。带标注时把「鹰/鸽 + 理由」显示出来——
 * 一个不能回溯到原文、也不说明理由的标签是没法核对的，那就等于没有价值。
 */
function NewsRow({ row: { news, mark } }: { row: Row }) {
  return (
    <li>
      <div className="flex gap-2">
        {mark && (
          <span
            className={`mt-px h-fit shrink-0 rounded px-1 py-0.5 text-[10px] leading-none ring-1 ${
              STANCE[mark.stance].ring
            }`}
            title={`影响量级：${IMPACT_LABEL[mark.impact]}`}
          >
            {STANCE[mark.stance].short}
            {mark.stance !== 'neutral' && IMPACT_LABEL[mark.impact]}
          </span>
        )}
        <a
          href={news.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block text-xs leading-relaxed text-zinc-300 hover:text-zinc-100"
        >
          {news.title}
        </a>
      </div>
      {mark?.note && (
        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{mark.note}</p>
      )}
      <p className="mt-0.5 text-[11px] text-zinc-600">
        {news.source} · {timeAgo(news.publishedAt)}
      </p>
    </li>
  );
}
