'use client';

import { useEffect, useState } from 'react';
import { useWatchlist } from '@/lib/stores/watchlist';
import { formatPrice } from '@/lib/format';
import type { CompareRow } from '@/app/api/market/compare/route';

type Window = 'h1' | 'h24' | 'd7';

const WINDOWS: { key: Window; label: string }[] = [
  { key: 'h1', label: '1 小时' },
  { key: 'h24', label: '24 小时' },
  { key: 'd7', label: '7 天' },
];

/**
 * 多币种横向对比。
 *
 * 核心不是「谁涨了多少」，而是**相对 BTC 的超额收益**。
 * 加密市场高度同涨同跌，「涨了 5%」本身说明不了什么——
 * 同一天里 BTC 涨 6% 的话，这个 5% 其实是跑输的。
 *
 * 这是描述而非预测：它告诉你资金过去这段时间流向了哪里，
 * 不告诉你接下来会流向哪里。
 */
export function ComparePanel() {
  const { symbols, active, setActive } = useWatchlist();
  const [sortBy, setSortBy] = useState<Window>('h24');
  const [result, setResult] = useState<{ key: string; rows: CompareRow[]; benchmark: string | null }>(
    { key: '', rows: [], benchmark: null },
  );

  const requestKey = [...symbols].sort().join(',');
  const loading = result.key !== requestKey;

  useEffect(() => {
    if (symbols.length === 0) return;
    const ac = new AbortController();
    fetch(`/api/market/compare?symbols=${symbols.join(',')}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((d: { rows?: CompareRow[]; benchmark?: string | null }) => {
        setResult({ key: requestKey, rows: d.rows ?? [], benchmark: d.benchmark ?? null });
      })
      .catch(() => {
        // 中断或失败时保留上一次结果，比闪成空白好
      });
    return () => ac.abort();
  }, [requestKey, symbols]);

  if (symbols.length === 0) {
    return <div className="p-4 text-xs text-zinc-600">自选为空，先添加几个币种</div>;
  }

  // 相对强弱缺失时（自选里没有 BTC）退回绝对涨跌排序
  const rows = [...result.rows].sort((a, b) => {
    const av = a.relative[sortBy] ?? a.returns[sortBy] ?? -Infinity;
    const bv = b.relative[sortBy] ?? b.returns[sortBy] ?? -Infinity;
    return bv - av;
  });

  return (
    <div className="p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-zinc-200">多币种对比</h3>
        <div className="flex gap-0.5 rounded-lg bg-zinc-900 p-0.5">
          {WINDOWS.map((w) => (
            <button
              key={w.key}
              onClick={() => setSortBy(w.key)}
              className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
                sortBy === w.key ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <p className="mb-3 text-[11px] leading-relaxed text-zinc-600">
        {result.benchmark
          ? '括号内为相对 BTC 的超额收益。加密同涨同跌，涨多少不重要，跑赢没跑赢才是信息。'
          : '自选中没有 BTC，无法计算相对强弱——只显示绝对涨跌。'}
      </p>

      {loading && result.rows.length === 0 && <p className="text-xs text-zinc-600">加载中…</p>}

      <div className="space-y-1">
        {rows.map((r) => {
          const base = r.symbol.replace(/USDT$|USDC$/, '');
          const abs = r.returns[sortBy];
          const rel = r.relative[sortBy];
          return (
            <button
              key={r.symbol}
              onClick={() => setActive(r.symbol)}
              className={`flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left transition-colors ${
                r.symbol === active ? 'bg-zinc-800' : 'hover:bg-zinc-900'
              }`}
            >
              <span className="w-12 shrink-0 text-xs font-medium text-zinc-200">{base}</span>
              <span className="w-20 shrink-0 font-mono text-[11px] text-zinc-500 tabular-nums">
                {formatPrice(r.price)}
              </span>

              <span
                className={`w-16 shrink-0 text-right font-mono text-xs tabular-nums ${
                  abs == null ? 'text-zinc-600' : abs >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {abs == null ? '—' : `${abs >= 0 ? '+' : ''}${abs.toFixed(2)}%`}
              </span>

              {/* 超额收益用中性色：它已经是「相对」的量，
                  再叠一层涨绿跌红会让人误读成又一个涨跌幅 */}
              <span className="ml-auto w-16 shrink-0 text-right font-mono text-[11px] text-zinc-500 tabular-nums">
                {rel == null
                  ? ''
                  : r.symbol === result.benchmark
                    ? '基准'
                    : `(${rel >= 0 ? '+' : ''}${rel.toFixed(1)})`}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
