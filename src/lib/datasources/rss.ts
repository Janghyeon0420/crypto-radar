/**
 * 极简 RSS 解析。
 *
 * 只取 item 的 title/link/pubDate/description 四个字段，不引入 xml 解析库——
 * RSS 2.0 结构稳定，这点需求不值得加依赖。
 *
 * 独立成文件是因为加密资讯（news.ts）与美联储（macro.ts）用的是同一套解析，
 * 两边各抄一份的话，哪天遇到某家 feed 的转义怪癖，只会修好一边。
 */

import type { NewsItem } from './types';

export interface ParseOptions {
  /** 显示用的来源名 */
  source: string;
  /** 归类：加密行业资讯还是宏观政策 */
  category: NewsItem['category'];
}

export function parseRss(xml: string, { source, category }: ParseOptions): NewsItem[] {
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
      category,
      publishedAt: pubDate ? Date.parse(pubDate) || Date.now() : Date.now(),
      summary: desc ? decode(stripTags(desc)).slice(0, 280) : undefined,
    });
  }
  return items;
}

export function pick(block: string, tag: string): string | null {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const m = re.exec(block);
  if (!m) return null;
  return m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
}

export const stripTags = (s: string) => s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

export function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}
