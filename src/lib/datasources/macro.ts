/**
 * 美联储数据源。
 *
 * 为什么一个加密看板要接美联储：加密资产的中长期走势主要由流动性驱动，
 * 而流动性的总闸门是联邦基金利率。技术指标能解释"这几根 K 线在做什么"，
 * 解释不了"为什么整个市场同时转向"——议息决议、点阵图、官员讲话才能。
 * 这一层是给单币种技术面提供背景的，不是用来直接择时的。
 *
 * 三个源全部免费无 Key，且实测从中国大陆直连可达（federalreserve.gov 与
 * markets.newyorkfed.org 都不在受限名单上），不需要代理：
 *   - RSS：货币政策新闻稿 / 官员讲话 / 国会证词
 *   - 纽约联储利率接口：EFFR 与当前目标区间
 *   - FOMC 会议日历：下次议息时点
 */

import { fetchJson, fetchText } from './http';
import { parseRss } from './rss';
import type { FomcMeeting, MacroSnapshot, NewsItem, PolicyRate } from './types';

interface FedFeed {
  id: string;
  label: string;
  url: string;
}

/**
 * 刻意不包含 press_all.xml（全部新闻稿）。
 * 那个源里大部分是银行监管处罚、支付系统公告这类与市场无关的内容，
 * 混进来只会稀释真正重要的三类：利率决议、讲话、证词。
 */
export const FED_FEEDS: FedFeed[] = [
  {
    id: 'fed-monetary',
    label: '美联储·货币政策',
    url: 'https://www.federalreserve.gov/feeds/press_monetary.xml',
  },
  {
    id: 'fed-speeches',
    label: '美联储·官员讲话',
    url: 'https://www.federalreserve.gov/feeds/speeches.xml',
  },
  {
    id: 'fed-testimony',
    label: '美联储·国会证词',
    url: 'https://www.federalreserve.gov/feeds/testimony.xml',
  },
];

/** 纽约联储参考利率接口，EFFR 每个业务日上午更新 */
const EFFR_URL = 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json';

const FOMC_CALENDAR_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';

/**
 * 拉取美联储资讯。
 *
 * 与加密资讯不同，这里**不做时间窗过滤**：官员讲话可能几周才一条，
 * 按"最近 24 小时"筛的话大部分时候是空的。宁可显示一条两周前的讲话，
 * 也好过让用户以为美联储最近什么都没说。
 */
export async function fetchFedNews(limit = 12): Promise<NewsItem[]> {
  const results = await Promise.allSettled(
    FED_FEEDS.map(async (f) =>
      parseRss(await fetchText(f.url, { timeoutMs: 8_000, ttlMs: 10 * 60_000 }), {
        source: f.label,
        category: 'macro',
      }),
    ),
  );

  return results
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, limit);
}

interface EffrResponse {
  refRates?: {
    effectiveDate?: string;
    percentRate?: number;
    targetRateFrom?: number;
    targetRateTo?: number;
  }[];
}

/**
 * 当前政策利率。
 *
 * 同时取 EFFR（市场实际成交的隔夜利率）和目标区间（FOMC 设定的）——
 * 两者通常只差几个基点，但 EFFR 贴近区间上沿往往意味着准备金在收紧，
 * 这是流动性的先行信号，只看目标区间看不出来。
 */
export async function fetchPolicyRate(): Promise<PolicyRate | null> {
  const data = await fetchJson<EffrResponse>(EFFR_URL, {
    // 每个业务日只更新一次，缓存 6 小时足够
    ttlMs: 6 * 3600_000,
    timeoutMs: 8_000,
  });

  const r = data.refRates?.[0];
  if (!r || typeof r.percentRate !== 'number') return null;
  if (typeof r.targetRateFrom !== 'number' || typeof r.targetRateTo !== 'number') return null;

  return {
    effectiveRate: r.percentRate,
    targetLow: r.targetRateFrom,
    targetHigh: r.targetRateTo,
    effectiveDate: r.effectiveDate ?? '',
    source: 'NY Fed',
  };
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * 从 FOMC 会议日历页解析出所有会议。
 *
 * 这是本项目里唯一一处 HTML 抓取，官方没有提供日历的结构化接口。
 * 页面结构变了解析就会失败——所以**失败时返回空数组而不是兜底猜测**：
 * 显示"日历不可用"是诚实的，显示一个过期的硬编码日程会让人错过议息夜。
 */
export function parseFomcCalendar(html: string, now = Date.now()): FomcMeeting[] {
  const meetings: FomcMeeting[] = [];

  // 页面按年份分 panel，年份不是按序排列（2027 排在最后），故用前瞻切块
  const yearRe =
    /<a id="\d+">(\d{4}) FOMC Meetings<\/a>([\s\S]*?)(?=<a id="\d+">\d{4} FOMC Meetings<\/a>|$)/g;

  for (const [, yearStr, block] of html.matchAll(yearRe)) {
    const year = Number(yearStr);
    // 每行先出现月份，紧接着是日期；两者都在 fomc-meeting__ 前缀的 div 里
    const rowRe =
      /fomc-meeting__month[^>]*>\s*<strong>([^<]+)<\/strong>[\s\S]*?fomc-meeting__date[^>]*>([^<]+)</g;

    for (const [, rawMonth, rawDate] of block.matchAll(rowRe)) {
      const meeting = parseMeetingRow(year, rawMonth, rawDate);
      if (meeting) meetings.push(meeting);
    }
  }

  return meetings.filter((m) => Number.isFinite(m.decisionAt) && m.decisionAt > now - YEAR_MS);
}

const YEAR_MS = 365 * 24 * 3600_000;

/**
 * 解析一行会议记录。
 *
 * 需要处理三种写法：
 *   "January" + "27-28"     普通两日会议
 *   "March"   + "17-18*"    带 * = 同时发布经济预测摘要（点阵图）
 *   "April/May" + "28-1"    跨月会议，结束日属于后一个月
 * 解析不出来的行（历史上的临时会议等）返回 null 跳过，不猜。
 */
function parseMeetingRow(year: number, rawMonth: string, rawDate: string): FomcMeeting | null {
  const monthNames = rawMonth.trim().toLowerCase().split('/');
  const hasProjections = rawDate.includes('*');
  const days = rawDate.replace(/\*/g, '').trim().split('-');

  const startDay = Number(days[0]);
  const endDay = Number(days[days.length - 1]);
  if (!Number.isInteger(startDay) || !Number.isInteger(endDay)) return null;

  const startMonth = MONTHS.indexOf(monthNames[0]);
  const endMonth = MONTHS.indexOf(monthNames[monthNames.length - 1]);
  if (startMonth < 0 || endMonth < 0) return null;

  // 跨年只可能是 12 月跨到次年 1 月
  const endYear = endMonth < startMonth ? year + 1 : year;

  // 声明固定在会期最后一天的美东时间 14:00 发布
  const decisionAt = Date.UTC(
    endYear,
    endMonth,
    endDay,
    14 + easternUtcOffset(endYear, endMonth, endDay),
  );

  const label =
    startMonth === endMonth
      ? `${year} 年 ${startMonth + 1} 月 ${startDay}${startDay === endDay ? '' : `-${endDay}`} 日`
      : `${year} 年 ${startMonth + 1} 月 ${startDay} 日 - ${endYear} 年 ${endMonth + 1} 月 ${endDay} 日`;

  return { label, decisionAt, hasProjections };
}

/**
 * 美东时区相对 UTC 的小时数（4 或 5）。
 *
 * 自己算而不是用 Intl：这里只需要一个整数偏移，
 * 而美国夏令时规则简单且稳定——3 月第二个周日起，11 月第一个周日止。
 */
function easternUtcOffset(year: number, month: number, day: number): number {
  const firstSunday = (m: number) => {
    const dow = new Date(Date.UTC(year, m, 1)).getUTCDay();
    return 1 + ((7 - dow) % 7);
  };
  const dstStart = Date.UTC(year, 2, firstSunday(2) + 7);
  const dstEnd = Date.UTC(year, 10, firstSunday(10));
  const ts = Date.UTC(year, month, day);
  return ts >= dstStart && ts < dstEnd ? 4 : 5;
}

/** 下一次议息会议。全部已过期（日历只到今年、明年日程还没发）时返回 null。 */
export async function fetchNextFomcMeeting(): Promise<FomcMeeting | null> {
  // 一年只变几次，缓存 12 小时；这一页有 160KB，不缓存每次都拉很浪费
  const html = await fetchText(FOMC_CALENDAR_URL, { timeoutMs: 10_000, ttlMs: 12 * 3600_000 });
  const now = Date.now();
  const upcoming = parseFomcCalendar(html, now)
    .filter((m) => m.decisionAt > now)
    .sort((a, b) => a.decisionAt - b.decisionAt);
  return upcoming[0] ?? null;
}

/**
 * 宏观快照。三个源相互独立，任一失败不影响其它两个——
 * 利率接口挂了不该连带让美联储资讯也消失。
 */
export async function fetchMacroSnapshot(): Promise<MacroSnapshot> {
  const [rate, meeting, news] = await Promise.allSettled([
    fetchPolicyRate(),
    fetchNextFomcMeeting(),
    fetchFedNews(12),
  ]);

  return {
    policyRate: rate.status === 'fulfilled' ? rate.value : null,
    nextMeeting: meeting.status === 'fulfilled' ? meeting.value : null,
    news: news.status === 'fulfilled' ? news.value : [],
  };
}
