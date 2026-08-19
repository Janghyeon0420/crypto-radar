'use client';

import { useEffect, useMemo, useState } from 'react';
import { useWatchlist } from '@/lib/stores/watchlist';
import { useLiveTickers } from '@/lib/hooks/useLiveTickers';
import { formatCompact, formatPercent, formatPrice, trendColor } from '@/lib/format';
import type { Ticker } from '@/lib/datasources/types';

/**
 * 自选列表。价格走 WebSocket 实时更新，24h 涨跌幅由 REST 定时兜底，
 * 两者合并显示——WS 的 miniTicker 里有 open24h，可以直接算出实时涨跌幅。
 */
export function Watchlist() {
  const { symbols, active, setActive, remove } = useWatchlist();
  const ticks = useLiveTickers(symbols);
  const [rest, setRest] = useState<Record<string, Ticker>>({});

  // REST 兜底：WS 建连前、以及冷门币无成交时保证有数据
  useEffect(() => {
    if (symbols.length === 0) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`/api/market/tickers?symbols=${symbols.join(',')}`);
        if (!res.ok) return;
        const { tickers } = (await res.json()) as { tickers: Ticker[] };
        if (cancelled) return;
        setRest(Object.fromEntries(tickers.map((t) => [t.symbol, t])));
      } catch {
        // 静默失败，WS 仍可能有数据；健康状态由 /api/health 统一展示
      }
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [symbols]);

  const rows = useMemo(
    () =>
      symbols.map((symbol) => {
        const tick = ticks[symbol];
        const fallback = rest[symbol];
        const last = tick?.last ?? fallback?.last;
        const changePercent = tick
          ? ((tick.last - tick.open24h) / tick.open24h) * 100
          : fallback?.changePercent;
        return {
          symbol,
          last,
          changePercent,
          volume: tick?.volume24h ?? fallback?.quoteVolume24h,
          live: Boolean(tick),
        };
      }),
    [symbols, ticks, rest],
  );

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row) => (
        <button
          key={row.symbol}
          onClick={() => setActive(row.symbol)}
          className={`group flex items-center justify-between rounded-lg px-3 py-2.5 text-left transition-colors ${
            active === row.symbol
              ? 'bg-zinc-800 ring-1 ring-zinc-700'
              : 'hover:bg-zinc-900'
          }`}
        >
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-medium text-zinc-100">
                {row.symbol.replace(/USDT$/, '')}
              </span>
              {/* 绿点表示 WS 实时流已在推送该币，让"数据是不是活的"一眼可见 */}
              {row.live && <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />}
            </div>
            <div className="text-xs text-zinc-500">
              {formatCompact(row.volume)} USDT
            </div>
          </div>
          <div className="text-right">
            <div className="font-mono text-sm text-zinc-100 tabular-nums">
              {formatPrice(row.last)}
            </div>
            <div className={`font-mono text-xs tabular-nums ${trendColor(row.changePercent ?? 0)}`}>
              {formatPercent(row.changePercent)}
            </div>
          </div>
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              remove(row.symbol);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.stopPropagation();
                remove(row.symbol);
              }
            }}
            className="ml-2 hidden text-zinc-600 hover:text-rose-400 group-hover:block"
            aria-label={`移除 ${row.symbol}`}
          >
            ×
          </span>
        </button>
      ))}
      {symbols.length === 0 && (
        <p className="px-3 py-6 text-center text-sm text-zinc-600">
          自选列表为空，用上方搜索添加币种
        </p>
      )}
    </div>
  );
}
