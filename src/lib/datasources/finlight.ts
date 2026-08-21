/**
 * Finlight —— 金融资讯 API。
 *
 * 相比原先的 RSS 聚合，它的价值在**广度与结构化**：一次请求覆盖数百家源，
 * 自带 categories / countries 标签，可以按关键词检索而不是只能拿最新一页。
 *
 * 实测于 2026-08-21，当前 key 的返回字段是：
 *   link / source / title / summary / publishDate / language / categories / countries / images
 *
 * ⚠️ **实体识别与正文属于付费档**：请求里带 `includeEntities` / `includeContent`
 * 不会报错，但也不会返回对应字段。所以本项目的鹰鸽判断**不依赖它的情绪或实体**，
 * 而是从美联储官方原文自己算（见 lib/macro/hawkdove.ts）。
 * 这样反倒更符合需求——判断该基于官方措辞，而不是媒体转述。
 *
 * 接口形态也有个坑：v2 只接受 POST，GET 一律 404（v1 才是 GET）。
 */

import type { NewsItem } from './types';

const ENDPOINT = 'https://api.finlight.me/v2/articles';

export class FinlightNotConfiguredError extends Error {
  constructor() {
    super('未配置 FINLIGHT_API_KEY，扩展资讯源不可用（RSS 源不受影响）');
    this.name = 'FinlightNotConfiguredError';
  }
}

export const isFinlightConfigured = () => Boolean(process.env.FINLIGHT_API_KEY?.trim());

interface FinlightArticle {
  link: string;
  source: string;
  title: string;
  summary?: string;
  publishDate: string;
  language?: string;
  categories?: string[];
  countries?: string[];
}

export interface FinlightQuery {
  query: string;
  pageSize?: number;
  /** 归到哪一类。宏观资讯与行业资讯在本项目里是分开呈现的 */
  category: NewsItem['category'];
  label: string;
}

/**
 * 简易内存缓存。
 *
 * 不走 http.ts 的 fetchJson，因为那边按 URL 做键，而这里是 POST——
 * 同一个 URL 不同请求体是不同结果，用 URL 当键会串数据。
 */
// 同样挂 globalThis：Next 的 instrumentation 与路由是两份模块副本，
// 模块级 Map 会导致启动预热与实际请求各用各的缓存（见 http.ts 的说明）
const CACHE_KEY = Symbol.for('crypto-radar.finlight.cache');
const g = globalThis as unknown as Record<symbol, Map<string, { at: number; items: NewsItem[] }> | undefined>;
g[CACHE_KEY] ??= new Map();
const cache = g[CACHE_KEY];
const TTL_MS = 5 * 60_000;

export async function fetchFinlight(q: FinlightQuery): Promise<NewsItem[]> {
  const key = process.env.FINLIGHT_API_KEY?.trim();
  if (!key) throw new FinlightNotConfiguredError();

  const cacheKey = `${q.query}|${q.pageSize ?? 20}|${q.category}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.items;

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: q.query,
      pageSize: q.pageSize ?? 20,
      language: 'en',
    }),
    signal: AbortSignal.timeout(12_000),
    cache: 'no-store',
  });

  if (!res.ok) {
    throw new Error(`Finlight HTTP ${res.status}`);
  }

  const data = (await res.json()) as { articles?: FinlightArticle[] };
  const items: NewsItem[] = (data.articles ?? []).map((a) => ({
    title: a.title,
    url: a.link,
    source: a.source.replace(/^www\./, ''),
    publishedAt: Date.parse(a.publishDate) || Date.now(),
    summary: a.summary?.slice(0, 280),
    category: q.category,
    tags: a.categories,
  }));

  cache.set(cacheKey, { at: Date.now(), items });
  return items;
}

/**
 * 预置的检索式。
 *
 * 分开两条而不是合成一条：宏观与行业资讯的更新频率差一个数量级，
 * 合并检索会让宏观条目被行业新闻淹没（这个教训在 RSS 那边已经吃过一次）。
 */
export const QUERIES = {
  macro: {
    query: 'Federal Reserve OR FOMC OR interest rates OR inflation OR Treasury yields',
    category: 'macro' as const,
    label: 'Finlight·宏观',
    pageSize: 15,
  },
  crypto: {
    query: 'bitcoin OR ethereum OR crypto OR stablecoin OR ETF',
    category: 'crypto' as const,
    label: 'Finlight·加密',
    pageSize: 25,
  },
} satisfies Record<string, FinlightQuery>;
