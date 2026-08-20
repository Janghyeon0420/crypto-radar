/**
 * 资讯聚合。
 *
 * 走 RSS 而不是 CryptoPanic/NewsAPI 这类聚合服务，是因为后者免费额度都需要注册 key，
 * 且 CryptoPanic 实测对本项目的出口 IP 返回 403。RSS 无 key、无限流、实测可用。
 *
 * 注意：RSS 拉取必须在服务端做（app/api/news），浏览器直接 fetch 会被 CORS 拦。
 *
 * 这里只管**行业资讯**。美联储等宏观源在 macro.ts，两者刻意不合并——
 * 理由见 types.ts 中 NewsItem.category 的注释。
 */

import { fetchText } from './http';
import { parseRss } from './rss';
import type { NewsItem } from './types';

interface Feed {
  id: string;
  label: string;
  url: string;
}

export const FEEDS: Feed[] = [
  { id: 'cointelegraph', label: 'Cointelegraph', url: 'https://cointelegraph.com/rss' },
  { id: 'coindesk', label: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/' },
  { id: 'decrypt', label: 'Decrypt', url: 'https://decrypt.co/feed' },
  {
    id: 'binance-announcement',
    label: '币安公告',
    url: 'https://www.binance.com/en/support/announcement/rss',
  },
];

/**
 * 并发拉所有 feed，单个源失败不影响整体。
 * 按发布时间倒序，截断到 limit 条。
 */
export async function fetchNews(limit = 40): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (f) =>
      parseRss(await fetchText(f.url, { timeoutMs: 8_000 }), {
        source: f.label,
        category: 'crypto',
      }),
    ),
  );

  return results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}

/**
 * 按币种过滤资讯。用 baseAsset 和常见别名做关键词匹配——
 * 粗糙但够用，真要做语义相关性得上 embedding，属于后续迭代。
 */
export function filterNewsByAsset(news: NewsItem[], baseAsset: string): NewsItem[] {
  const aliases: Record<string, string[]> = {
    BTC: ['bitcoin', 'btc'],
    ETH: ['ethereum', 'eth', 'ether'],
    SOL: ['solana', 'sol'],
    BNB: ['bnb', 'binance coin'],
    XRP: ['xrp', 'ripple'],
    DOGE: ['dogecoin', 'doge'],
  };
  const keys = aliases[baseAsset] ?? [baseAsset.toLowerCase()];
  return news.filter((n) => {
    const hay = `${n.title} ${n.summary ?? ''}`.toLowerCase();
    return keys.some((k) => hay.includes(k));
  });
}
