/**
 * 告警规则。
 *
 * 求值在**服务端**进行（lib/alerts/worker.ts），只要服务在跑，
 * 无论浏览器是否打开都会持续监控并推送通知。
 * 浏览器只订阅结果，不参与判定——两边同时求值会导致重复触发与重复通知。
 *
 * 规则随之存在服务端文件（data/alert-rules.json）而非 localStorage：
 * 存在浏览器里的话，常驻进程根本读不到。
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
