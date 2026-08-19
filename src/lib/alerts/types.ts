/**
 * 告警规则。
 *
 * 设计取舍：规则在**浏览器端**求值，不做服务端定时任务。
 * 原因是这是个本地单人工具，看板开着的时候才需要盯盘；
 * 为了关掉页面还能收到通知而去搭一个常驻服务，成本远高于收益。
 * 如果将来确实需要 7×24 告警，再把这套规则搬到服务端 cron 即可——
 * 求值函数是纯函数，可以原样复用。
 */

export type AlertKind =
  | 'price_above'
  | 'price_below'
  | 'rsi_above'
  | 'rsi_below'
  | 'macd_cross'
  | 'bb_squeeze_release'
  | 'volume_spike';

export interface AlertRule {
  id: string;
  symbol: string;
  kind: AlertKind;
  /** 阈值。macd_cross 与 bb_squeeze_release 不需要阈值 */
  threshold?: number;
  /** 该规则在哪个周期上求值 */
  interval: string;
  enabled: boolean;
  /** 只触发一次后自动关闭，适合"突破 7 万提醒我"这类一次性目标 */
  once: boolean;
  createdAt: number;
  lastTriggeredAt?: number;
}

export interface AlertEvent {
  id: string;
  ruleId: string;
  symbol: string;
  kind: AlertKind;
  message: string;
  price: number;
  triggeredAt: number;
}

export const ALERT_LABELS: Record<AlertKind, string> = {
  price_above: '价格突破',
  price_below: '价格跌破',
  rsi_above: 'RSI 高于',
  rsi_below: 'RSI 低于',
  macd_cross: 'MACD 交叉',
  bb_squeeze_release: '布林带挤压结束',
  volume_spike: '放量',
};

/** 哪些规则需要用户填阈值 */
export const NEEDS_THRESHOLD: AlertKind[] = [
  'price_above',
  'price_below',
  'rsi_above',
  'rsi_below',
  'volume_spike',
];
