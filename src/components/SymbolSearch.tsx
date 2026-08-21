'use client';

import { useEffect, useMemo, useState } from 'react';
import { useWatchlist } from '@/lib/stores/watchlist';
import type { RoutedSymbol } from '@/lib/datasources/market';

/** 添加自选。交易对列表一次拉全（约 500 个），在前端做匹配，无需每次输入都打接口。 */
export function SymbolSearch() {
  const add = useWatchlist((s) => s.add);
  const existing = useWatchlist((s) => s.symbols);
  const [all, setAll] = useState<RoutedSymbol[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  useEffect(() => {
    fetch('/api/market/symbols')
      .then((r) => (r.ok ? r.json() : { symbols: [] }))
      .then((d: { symbols: RoutedSymbol[] }) => setAll(d.symbols))
      .catch(() => setAll([]));
  }, []);

  const matches = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return [];
    return all
      .filter((s) => s.baseAsset.startsWith(q) || s.symbol.startsWith(q))
      // 完全匹配 baseAsset 的排最前，避免搜 BTC 时 BTCDOWN 之类排在前面
      .sort((a, b) => Number(b.baseAsset === q) - Number(a.baseAsset === q))
      .slice(0, 8);
  }, [query, all]);

  return (
    <div className="relative">
      <input
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        placeholder={all.length ? '搜索币种，如 BTC' : '加载交易对…'}
        className="w-full rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
      />
      {open && matches.length > 0 && (
        <ul className="absolute z-20 mt-1 w-full overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl">
          {matches.map((m) => {
            const added = existing.includes(m.symbol);
            return (
              <li key={m.symbol}>
                <button
                  onMouseDown={() => {
                    add(m.symbol);
                    setQuery('');
                  }}
                  className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-zinc-800"
                >
                  <span className="flex items-baseline gap-2">
                    <span className="text-zinc-100">{m.baseAsset}</span>
                    {/* 只标注非币安来源。给币安的也标会让 99% 的行多出无用噪音，
                        而「这个币的数据来自别家」是用户有权知道的信息 */}
                    {m.exchange !== 'binance' && (
                      <span className="rounded bg-zinc-800 px-1 py-0.5 text-[10px] uppercase text-zinc-500">
                        {m.exchange}
                      </span>
                    )}
                  </span>
                  <span className="text-xs text-zinc-500">
                    {added ? '已在自选' : m.symbol}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
