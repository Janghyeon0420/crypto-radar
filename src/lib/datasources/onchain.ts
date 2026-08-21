/**
 * 链上数据。
 *
 * 挑选标准与宏观那一层一致：**传导路径要清楚**，而不是「链上能查到什么就放什么」。
 * 活跃地址数、Gas 消耗这类指标看着很链上，但它们影响价格要经过好几层，
 * 而且没有可信的基线可比。
 *
 * 目前只接两类：
 *
 *   稳定币总供应   加密圈自己的「净流动性」——链上有多少可以随时买币的钱。
 *                 与美联储净流动性构成一对：一个是宏观水位，一个是场内水位。
 *   BTC 网络状态   算力、难度、mempool 拥堵、手续费。描述网络本身的健康与拥堵，
 *                 不假装它能预测价格。
 *
 * 实测于 2026-08-21（出口美国）：
 *   DefiLlama       ✅ 免费无 key，稳定币历史可回溯到 2017-11
 *   Blockchair      ✅ 免费无 key，一次请求 37 个字段
 *   mempool.space   ❌ 两次尝试均超时，判定不可用
 *   Glassnode / CryptoQuant  多数指标付费，未接入
 */

import { fetchJson } from './http';

export interface StablecoinSupply {
  /** 当前总供应（十亿美元），与美联储净流动性同单位，便于并排看 */
  totalBillions: number;
  date: string;
  change7d: number | null;
  change30d: number | null;
  /** 最近 90 天的日度序列，用于画趋势 */
  series: { date: string; billions: number }[];
}

interface LlamaChartPoint {
  date: string;
  totalCirculatingUSD?: { peggedUSD?: number };
}

const day = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

/**
 * 稳定币总供应及其变化。
 *
 * 为什么它重要：稳定币是加密市场的「现金」。供应上升意味着有资金
 * 通过法币通道进场并停在链上，那是买盘的燃料；供应萎缩则相反。
 * 这个口径不受币价涨跌影响——它统计的是发行量，不是市值。
 *
 * ⚠️ 上游返回 1.2MB 的全量历史（3188 天），所以缓存 6 小时且只保留近 90 天。
 * 数据本身是日频，更频繁地拉没有任何意义。
 */
export async function fetchStablecoinSupply(): Promise<StablecoinSupply | null> {
  const raw = await fetchJson<LlamaChartPoint[]>(
    'https://stablecoins.llama.fi/stablecoincharts/all',
    { ttlMs: 6 * 3600_000, timeoutMs: 20_000 },
  );
  if (!Array.isArray(raw) || raw.length === 0) return null;

  const points = raw
    .map((p) => ({
      date: day(Number(p.date)),
      billions: (p.totalCirculatingUSD?.peggedUSD ?? 0) / 1e9,
    }))
    .filter((p) => p.billions > 0);

  if (points.length === 0) return null;

  const latest = points[points.length - 1];

  return {
    totalBillions: latest.billions,
    date: latest.date,
    change7d: changeOverDays(points, 7),
    change30d: changeOverDays(points, 30),
    series: points.slice(-90),
  };
}

export interface DatedValue {
  date: string;
  billions: number;
}

/**
 * 相对 N **天**前的变化率 %。
 *
 * 关键在于按天数回看，而不是按数组下标往回数 N 个——
 * 上游偶有缺日（节假日、抓取失败），数下标会让「7 天变化」
 * 实际上变成 9 天或 5 天的变化，而这个错误不会报任何异常，
 * 只会让显示出来的百分比悄悄失真。
 *
 * 目标日无数据时取「不晚于目标日的最近一天」，与 FRED 那边的处理一致。
 */
export function changeOverDays(points: DatedValue[], days: number): number | null {
  if (points.length === 0) return null;
  const latest = points[points.length - 1];
  const target = new Date(Date.parse(latest.date) - days * 86400_000).toISOString().slice(0, 10);

  let before: DatedValue | undefined;
  for (let i = points.length - 1; i >= 0; i--) {
    if (points[i].date <= target) {
      before = points[i];
      break;
    }
  }
  // 历史长度不够（比如只有 3 天数据却要算 30 天变化）时返回 null，
  // 而不是拿最早那天硬算——那会得出一个看着像 30 天其实是 3 天的数字
  if (!before || before.date === latest.date) return null;
  return before.billions > 0 ? ((latest.billions - before.billions) / before.billions) * 100 : null;
}

export interface BtcNetwork {
  /** EH/s */
  hashrate: number;
  difficulty: number;
  /** 待确认交易数与占用字节 */
  mempoolTransactions: number;
  mempoolBytes: number;
  /** 建议费率 sat/vB */
  suggestedFeeSatPerByte: number;
  transactions24h: number;
  /** BTC 在全市场的占比 % */
  dominance: number;
}

interface BlockchairStats {
  data?: {
    difficulty?: number;
    hashrate_24h?: string | number;
    mempool_transactions?: number;
    mempool_size?: number;
    suggested_transaction_fee_per_byte_sat?: number;
    transactions_24h?: number;
    market_dominance_percentage?: number;
  };
}

/**
 * BTC 网络状态。
 *
 * 这些是**描述**：拥堵、手续费、算力安全边际。
 * 不把它们当方向信号——「算力上升所以看涨」这类说法从没通过检验。
 */
export async function fetchBtcNetwork(): Promise<BtcNetwork | null> {
  const res = await fetchJson<BlockchairStats>('https://api.blockchair.com/bitcoin/stats', {
    // 区块 10 分钟一个，缓存 10 分钟不会错过什么
    ttlMs: 10 * 60_000,
    timeoutMs: 12_000,
  });
  const d = res?.data;
  if (!d || typeof d.difficulty !== 'number') return null;

  // hashrate_24h 是 H/s 的字符串，数值大到超出安全整数范围，先按字符串收再换算
  const hashes = Number(d.hashrate_24h ?? 0);

  return {
    hashrate: Number.isFinite(hashes) ? hashes / 1e18 : 0,
    difficulty: d.difficulty,
    mempoolTransactions: d.mempool_transactions ?? 0,
    mempoolBytes: d.mempool_size ?? 0,
    suggestedFeeSatPerByte: d.suggested_transaction_fee_per_byte_sat ?? 0,
    transactions24h: d.transactions_24h ?? 0,
    dominance: d.market_dominance_percentage ?? 0,
  };
}

export interface OnchainSnapshot {
  stablecoins: StablecoinSupply | null;
  btcNetwork: BtcNetwork | null;
}

/** 两路独立 settle：一路挂掉不该让另一路也消失 */
export async function fetchOnchainSnapshot(): Promise<OnchainSnapshot> {
  const [sc, net] = await Promise.allSettled([fetchStablecoinSupply(), fetchBtcNetwork()]);
  return {
    stablecoins: sc.status === 'fulfilled' ? sc.value : null,
    btcNetwork: net.status === 'fulfilled' ? net.value : null,
  };
}
