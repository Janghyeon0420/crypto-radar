/**
 * 统一数据契约。
 *
 * 所有数据源适配器都必须把各家交易所/服务商的原始响应，
 * 归一化成这里定义的结构。上层（指标计算、UI、LLM 研判）只认这些类型，
 * 这样换数据源时改动被限制在 adapter 内部。
 */

/** 支持的 K 线周期。与币安 interval 字符串保持一致，其它源在 adapter 内做映射。 */
export type Interval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

export const INTERVALS: Interval[] = ['1m', '5m', '15m', '1h', '4h', '1d', '1w'];

/** 一根 K 线。时间戳统一为毫秒 UTC，价量统一为 number。 */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** 成交笔数，部分数据源可能缺失 */
  trades?: number;
}

/** 24 小时行情快照 */
export interface Ticker {
  symbol: string;
  last: number;
  changePercent: number;
  high24h: number;
  low24h: number;
  /** 计价币成交额（USDT），用于排序和流动性判断 */
  quoteVolume24h: number;
}

/** 订单簿快照，用于买卖压力分析 */
export interface OrderBook {
  symbol: string;
  bids: [price: number, qty: number][];
  asks: [price: number, qty: number][];
}

/** 永续合约衍生品指标。现货看板用它来判断杠杆情绪。 */
export interface DerivativesSnapshot {
  symbol: string;
  /** 当期资金费率，正数=多头付费给空头=市场偏多 */
  fundingRate: number;
  nextFundingTime: number;
  /** 未平仓合约量（张/币，随源不同） */
  openInterest: number;
  source: string;
}

/** 市场情绪 */
export interface SentimentSnapshot {
  /** 恐惧贪婪指数 0-100 */
  fearGreed: number;
  classification: string;
  updatedAt: number;
}

/** 资讯条目 */
export interface NewsItem {
  title: string;
  url: string;
  source: string;
  publishedAt: number;
  summary?: string;
  /**
   * crypto = 行业资讯，macro = 宏观政策（目前是美联储）。
   *
   * 这两类必须分开呈现，不能混在一个按时间倒序的列表里：
   * 加密资讯每小时几十条，美联储讲话几周才一条——
   * 混排的结果是宏观信息永远被挤到列表末尾，等于没接。
   */
  category: 'crypto' | 'macro';
}

/**
 * 美联储政策利率。
 *
 * 对加密资产而言这是最重要的单一宏观变量：它直接决定无风险收益率，
 * 进而决定风险资产的估值基准与市场流动性。
 */
export interface PolicyRate {
  /** 联邦基金有效利率（EFFR），市场实际成交出来的隔夜利率 */
  effectiveRate: number;
  /** FOMC 设定的目标区间下沿 / 上沿 */
  targetLow: number;
  targetHigh: number;
  /** 该利率对应的业务日 */
  effectiveDate: string;
  source: string;
}

/** 一次 FOMC 议息会议 */
export interface FomcMeeting {
  /** 会期描述，如 "2026 年 9 月 15-16 日" */
  label: string;
  /**
   * 决议公布时刻（毫秒 UTC）。
   * 取会期最后一天的美东时间 14:00——声明就是这个点发布的，
   * 而不是会议开始的那天。
   */
  decisionAt: number;
  /** 该次会议是否同时发布经济预测摘要（点阵图），日历上以 * 标注 */
  hasProjections: boolean;
}

/** 宏观环境快照 */
export interface MacroSnapshot {
  policyRate: PolicyRate | null;
  /** 下一次议息会议，日历拉取失败或年内已开完时为 null */
  nextMeeting: FomcMeeting | null;
  /** 美联储官方资讯（货币政策新闻稿、官员讲话、国会证词） */
  news: NewsItem[];
}

/** 数据源健康状态，用于前端显示"哪个源挂了" */
export interface SourceHealth {
  id: string;
  label: string;
  ok: boolean;
  latencyMs?: number;
  error?: string;
  checkedAt: number;
}
