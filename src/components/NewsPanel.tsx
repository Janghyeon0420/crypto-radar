'use client';

import { useEffect, useState } from 'react';
import type { NewsItem } from '@/lib/datasources/types';
import { timeAgo } from '@/lib/format';

/** 资讯流。按当前选中币种过滤，无匹配时退回全市场资讯。 */
export function NewsPanel({ baseAsset }: { baseAsset: string }) {
  const [filtered, setFiltered] = useState(true);
  // 同 Dashboard：结果连同它的请求 key 一起存，loading 由两者比较推导，
  // 避免切换币种时短暂显示上一个币的资讯。
  const [result, setResult] = useState<{ key: string; news: NewsItem[] }>({
    key: '',
    news: [],
  });

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

  return (
    <div className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-zinc-200">资讯</h3>
        <button
          onClick={() => setFiltered((f) => !f)}
          className="text-xs text-zinc-500 hover:text-zinc-300"
        >
          {filtered ? `仅 ${baseAsset}` : '全市场'}
        </button>
      </div>

      {loading && <p className="text-xs text-zinc-600">加载中…</p>}
      {!loading && news.length === 0 && (
        <p className="text-xs text-zinc-600">
          {filtered ? `未匹配到 ${baseAsset} 相关资讯，可切换到全市场` : '暂无资讯'}
        </p>
      )}

      <ul className="space-y-3">
        {news.slice(0, 15).map((n) => (
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
    </div>
  );
}
