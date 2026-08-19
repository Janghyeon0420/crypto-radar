/**
 * 资讯聚合。
 *
 * 走 RSS 而不是 CryptoPanic/NewsAPI 这类聚合服务，是因为后者免费额度都需要注册 key，
 * 且 CryptoPanic 实测对本项目的出口 IP 返回 403。RSS 无 key、无限流、实测可用。
 *
 * 注意：RSS 拉取必须在服务端做（app/api/news），浏览器直接 fetch 会被 CORS 拦。
 */

import { fetchText } from './http';
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
 * 极简 RSS 解析。只取 item 的 title/link/pubDate/description 四个字段，
 * 不引入 xml 解析库——RSS 2.0 结构稳定，这点需求不值得加依赖。
 */
function parseRss(xml: string, source: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item[\s>][\s\S]*?<\/item>/gi;
  const matches = xml.match(itemRe) ?? [];

  for (const block of matches) {
    const title = pick(block, 'title');
    const link = pick(block, 'link');
    if (!title || !link) continue;
    const pubDate = pick(block, 'pubDate');
    const desc = pick(block, 'description');
    items.push({
      title: decode(title),
      url: decode(link),
      source,
      publishedAt: pubDate ? Date.parse(pubDate) || Date.now() : Date.now(),
      summary: desc ? decode(stripTags(desc)).slice(0, 280) : undefined,
    });
  }
  return items;
}

function pick(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return null;
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * 并发拉所有 feed，单个源失败不影响整体。
 * 按发布时间倒序，截断到 limit 条。
 */
export async function fetchNews(limit = 40): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    FEEDS.map(async (f) => parseRss(await fetchText(f.url, { timeoutMs: 8_000 }), f.label)),
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
