/**
 * 美联储官方文本抓取。
 *
 * 鹰鸽判断必须基于**官方原文**，而不是新闻转述——转述会加入记者的解读，
 * 而且同一份声明在不同媒体笔下可以是"美联储态度强硬"或"美联储按兵不动"。
 * 原文里的措辞变化才是真正的信号，这正是市场逐字读 FOMC 声明的原因。
 */

import { fetchText } from './http';

const HOST = 'https://www.federalreserve.gov';

/**
 * 从 federalreserve.gov 页面提取正文。
 *
 * 页面用 Bootstrap 栅格，正文在固定的列容器里。抓不到就退回全页去标签——
 * 宁可多一些导航噪音，也好过返回空字符串让上层以为这份声明没有内容。
 */
export function extractArticleText(html: string): string {
  const m = /<div[^>]*class="col-xs-12 col-sm-8 col-md-8"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/.exec(html);
  const body = m ? m[1] : html;
  return decode(
    body
      // 脚本与样式里的内容不是正文，先整块去掉
      .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim();
}

function decode(s: string): string {
  return s
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–');
}

/** 抓取一篇官方文档的正文。文档一经发布不再变动，可以长时间缓存。 */
export async function fetchFedDocument(url: string): Promise<string> {
  const full = url.startsWith('http') ? url : `${HOST}${url}`;
  const html = await fetchText(full, { timeoutMs: 12_000, ttlMs: 24 * 3600_000 });
  return extractArticleText(html);
}

/**
 * 由会议日期推出声明的 URL。
 *
 * 美联储的新闻稿地址是有规律的：monetary{YYYYMMDD}a.htm，
 * 日期取会期**最后一天**（决议当天）。这个规律从 2000 年代沿用至今，
 * 但它毕竟是约定而非承诺——抓不到时返回 null，不要伪造内容。
 */
export function statementUrlFor(decisionDate: Date): string {
  const y = decisionDate.getUTCFullYear();
  const m = String(decisionDate.getUTCMonth() + 1).padStart(2, '0');
  const d = String(decisionDate.getUTCDate()).padStart(2, '0');
  return `${HOST}/newsevents/pressreleases/monetary${y}${m}${d}a.htm`;
}
