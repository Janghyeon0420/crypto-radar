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
