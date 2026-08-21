/**
 * FRED / ALFRED —— 美联储圣路易斯分行的宏观数据库。
 *
 * 取代原先只拉一个「当前政策利率」的做法。对加密资产来说，
 * **利率水平本身不如流动性重要**：真正驱动风险资产估值的是
 * 「市场上有多少钱」，而那要靠美联储资产负债表、逆回购、财政部账户
 * 三个序列一起算，光看联邦基金利率看不出来。
 *
 * 两个必须小心的地方，错了都不会报错：
 *
 * 1. **单位不统一**。WALCL 与 WTREGEN 是「百万美元」，RRPONTSYD 是「十亿美元」。
 *    直接相减会差 1000 倍，得到一个看着像模像样的错数字。
 * 2. **频率不统一**。WALCL/WTREGEN 是周频、RRPONTSYD 是日频、M2 是月频。
 *    按数组下标对齐等于把不同日期的值相减，必须按日期取「截至该日的最新值」。
 */

import { fetchJson } from './http';

const BASE = 'https://api.stlouisfed.org/fred';

export class FredNotConfiguredError extends Error {
  constructor() {
    super('未配置 FRED_API_KEY，宏观数值不可用。免费申请：https://fred.stlouisfed.org/docs/api/api_key.html');
    this.name = 'FredNotConfiguredError';
  }
}

const apiKey = () => {
  const k = process.env.FRED_API_KEY?.trim();
  if (!k) throw new FredNotConfiguredError();
  return k;
};

export const isFredConfigured = () => Boolean(process.env.FRED_API_KEY?.trim());

/** 归一化后的单位。货币量一律换算成十亿美元，避免跨序列相减时出错 */
export type MacroUnit = 'percent' | 'billionsUSD' | 'index';

export interface MacroPoint {
  date: string;
  value: number;
}

export interface MacroSeries {
  id: string;
  label: string;
  unit: MacroUnit;
  latest: MacroPoint;
  /** 上一期观测，用于显示变化方向 */
  previous: MacroPoint | null;
  /** 约一个月前的值，用于看趋势而非单期噪音 */
  monthAgo: MacroPoint | null;
  frequency: string;
}

interface FredObservationsResponse {
  observations: { date: string; value: string }[];
}

/**
 * 本项目关注的序列。
 *
 * 挑选标准是「对加密资产的传导路径清楚」，而不是「宏观上重要」——
 * 失业率对债市很重要，但它影响加密要经过好几层，所以排在流动性之后。
 */
export const SERIES: Record<string, { label: string; unit: MacroUnit; scale?: number }> = {
  // ── 流动性：对加密最直接 ──
  WALCL: { label: '美联储总资产', unit: 'billionsUSD', scale: 1 / 1000 }, // 百万 → 十亿
  RRPONTSYD: { label: '隔夜逆回购', unit: 'billionsUSD' },
  WTREGEN: { label: '财政部一般账户（TGA）', unit: 'billionsUSD', scale: 1 / 1000 },
  M2SL: { label: 'M2 货币供应', unit: 'billionsUSD' },

  // ── 利率 ──
  DFF: { label: '联邦基金有效利率', unit: 'percent' },
  DGS10: { label: '10 年期美债收益率', unit: 'percent' },
  T10Y2Y: { label: '10 年-2 年利差', unit: 'percent' },

  // ── 决定美联储下一步的两个数据 ──
  CPIAUCSL: { label: 'CPI 指数', unit: 'index' },
  UNRATE: { label: '失业率', unit: 'percent' },

  // ── 美元：风险资产的反向指标 ──
  DTWEXBGS: { label: '美元指数（广义）', unit: 'index' },
};

export type SeriesId = keyof typeof SERIES;

/** 拉取一个序列的观测值，最新的在前 */
export async function fetchObservations(id: string, limit = 60): Promise<MacroPoint[]> {
  const url =
    `${BASE}/series/observations?series_id=${id}&api_key=${apiKey()}&file_type=json` +
    `&sort_order=desc&limit=${limit}`;
  // 宏观数据最快也是日频，缓存 1 小时绰绰有余
  const data = await fetchJson<FredObservationsResponse>(url, { ttlMs: 3600_000, timeoutMs: 12_000 });

  const scale = SERIES[id]?.scale ?? 1;
  return data.observations
    // FRED 用 "." 表示该期无数据（节假日等），不能当 0 处理
    .filter((o) => o.value !== '.' && o.value !== '')
    .map((o) => ({ date: o.date, value: Number(o.value) * scale }))
    .filter((p) => Number.isFinite(p.value));
}

export async function fetchSeries(id: SeriesId): Promise<MacroSeries | null> {
  const points = await fetchObservations(id, 60);
  if (points.length === 0) return null;

  const meta = SERIES[id];
  const latest = points[0];
  const monthAgoDate = new Date(Date.parse(latest.date) - 30 * 86400_000).toISOString().slice(0, 10);

  return {
    id,
    label: meta.label,
    unit: meta.unit,
    latest,
    previous: points[1] ?? null,
    // 取「不晚于一个月前」的第一个点，而不是固定往回数 N 个——
    // 序列频率不同，往回数 N 个在日频和月频上含义完全不同
    monthAgo: points.find((p) => p.date <= monthAgoDate) ?? null,
    frequency: '',
  };
}

/** 并发拉多个序列，单个失败不影响其它 */
export async function fetchSeriesSet(ids: SeriesId[]): Promise<MacroSeries[]> {
  const results = await Promise.allSettled(ids.map((id) => fetchSeries(id)));
  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((s): s is MacroSeries => s !== null);
}

export interface NetLiquidity {
  /** 十亿美元 */
  value: number;
  /** 一个月前的值，用于判断在放水还是抽水 */
  monthAgo: number | null;
  changePercent: number | null;
  /** 三个构成项，让用户能自己核对这个数是怎么来的 */
  components: { walcl: number; reverseRepo: number; tga: number };
  /** 各构成项的观测日期。频率不同，日期不会完全一致，必须显示出来 */
  asOf: { walcl: string; reverseRepo: string; tga: string };
}

/**
 * 净流动性 = 美联储总资产 − 隔夜逆回购 − 财政部一般账户。
 *
 * 这是加密圈广泛使用的流动性口径：美联储资产是投放的总量，
 * 而逆回购和 TGA 里的钱是「趴着不动」的，没有进入市场循环。
 * 三者都换算成十亿美元后再相减。
 *
 * 注意各项频率不同（周/日/周），所以取的是各自的最新值，
 * 观测日期未必对齐——`asOf` 把实际日期一并返回，不假装它们是同一天。
 */
export async function fetchNetLiquidity(): Promise<NetLiquidity | null> {
  const [walcl, rrp, tga] = await Promise.all([
    fetchObservations('WALCL', 20).catch(() => []),
    fetchObservations('RRPONTSYD', 40).catch(() => []),
    fetchObservations('WTREGEN', 20).catch(() => []),
  ]);
  if (!walcl[0] || !rrp[0] || !tga[0]) return null;

  const value = walcl[0].value - rrp[0].value - tga[0].value;

  // 一个月前：各序列各自取「截至那天的最新值」，而不是按下标回退
  const cutoff = new Date(Date.parse(walcl[0].date) - 30 * 86400_000).toISOString().slice(0, 10);
  const at = (pts: MacroPoint[]) => pts.find((p) => p.date <= cutoff)?.value ?? null;
  const [w0, r0, t0] = [at(walcl), at(rrp), at(tga)];
  const monthAgo = w0 !== null && r0 !== null && t0 !== null ? w0 - r0 - t0 : null;

  return {
    value,
    monthAgo,
    changePercent: monthAgo ? ((value - monthAgo) / monthAgo) * 100 : null,
    components: { walcl: walcl[0].value, reverseRepo: rrp[0].value, tga: tga[0].value },
    asOf: { walcl: walcl[0].date, reverseRepo: rrp[0].date, tga: tga[0].date },
  };
}

export interface ReleaseEvent {
  name: string;
  date: string;
  daysAway: number;
}

/**
 * 关注列表里的数据发布日历。
 *
 * FRED 的发布日历一次返回三千多条，绝大多数与加密无关。
 * 只保留会引发跨资产波动的那几类——这些日子的行情性质与平时不同，
 * 值得在盘面上提前知道。
 */
const WATCHED_RELEASES = [
  { match: /consumer price index/i, name: 'CPI 通胀数据' },
  { match: /employment situation/i, name: '非农就业' },
  { match: /personal income and outlays/i, name: 'PCE 物价指数' },
  { match: /gross domestic product/i, name: 'GDP' },
  { match: /^h\.4\.1|factors affecting reserve balances/i, name: '美联储资产负债表（H.4.1）' },
];

export async function fetchReleaseCalendar(daysAhead = 21): Promise<ReleaseEvent[]> {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + daysAhead * 86400_000).toISOString().slice(0, 10);
  const url =
    `${BASE}/releases/dates?api_key=${apiKey()}&file_type=json&sort_order=asc` +
    `&include_release_dates_with_no_data=true&realtime_start=${today}&realtime_end=${end}&limit=1000`;

  const data = await fetchJson<{ release_dates: { release_name: string; date: string }[] }>(url, {
    ttlMs: 6 * 3600_000,
    timeoutMs: 12_000,
  });

  const out: ReleaseEvent[] = [];
  const seen = new Set<string>();
  for (const r of data.release_dates ?? []) {
    const hit = WATCHED_RELEASES.find((w) => w.match.test(r.release_name));
    if (!hit) continue;
    const key = `${hit.name}|${r.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: hit.name,
      date: r.date,
      daysAway: Math.round((Date.parse(r.date) - Date.now()) / 86400_000),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8);
}

export interface Revision {
  date: string;
  /** 首次公布值 */
  initial: number;
  /** 当前值（历经修订后） */
  current: number;
  revisedBy: number;
}

/**
 * ALFRED 修订历史。
 *
 * 用途不是"看新闻"，而是**防止回测作弊**：用修订后的 GDP 去检验
 * 当时基于初值做出的判断，等于把未来的信息漏给了过去。
 * 这里把两者的差异摆出来，提醒差异有多大。
 */
export async function fetchRevisions(id: string, limit = 6): Promise<Revision[]> {
  const url =
    `${BASE}/series/observations?series_id=${id}&api_key=${apiKey()}&file_type=json` +
    `&output_type=2&sort_order=desc&limit=${limit}`;
  const data = await fetchJson<{ observations: Record<string, string>[] }>(url, {
    ttlMs: 24 * 3600_000,
    timeoutMs: 12_000,
  });

  const out: Revision[] = [];
  for (const row of data.observations ?? []) {
    // output_type=2 的列名形如 CPIAUCSL_20260820，一行里可能有多个 vintage
    const vintages = Object.entries(row)
      .filter(([k, v]) => k !== 'date' && v !== '.' && v !== '')
      .sort(([a], [b]) => a.localeCompare(b));
    if (vintages.length < 2) continue;
    const initial = Number(vintages[0][1]);
    const current = Number(vintages[vintages.length - 1][1]);
    if (!Number.isFinite(initial) || !Number.isFinite(current)) continue;
    out.push({ date: row.date, initial, current, revisedBy: current - initial });
  }
  return out;
}
