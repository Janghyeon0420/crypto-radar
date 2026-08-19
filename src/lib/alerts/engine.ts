/**
 * 告警求值。
 *
 * 全部是纯函数：输入当前行情与技术面快照，输出触发的事件。
 * 由 lib/alerts/worker.ts 在服务端定时调用，浏览器不再自行求值。
 */

import type { TechnicalSnapshot } from '../indicators/summary';
import type { AlertEvent, AlertRule } from './types';
import { formatPrice } from '../format';

export interface EvalContext {
  symbol: string;
  price: number;
  technical: TechnicalSnapshot | null;
  /** 上一次求值时的技术面，用于识别"状态发生了变化"而非"状态持续为真" */
  previousTechnical: TechnicalSnapshot | null;
}

/**
 * 同一规则的最小重复触发间隔。
 * 没有这个的话，价格在阈值附近抖动会瞬间刷出几十条通知。
 */
const COOLDOWN_MS = 15 * 60_000;

export function evaluateRules(rules: AlertRule[], ctx: EvalContext): AlertEvent[] {
  const events: AlertEvent[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.symbol !== ctx.symbol) continue;
    if (rule.lastTriggeredAt && Date.now() - rule.lastTriggeredAt < COOLDOWN_MS) continue;

    const message = check(rule, ctx);
    if (!message) continue;

    events.push({
      id: `${rule.id}-${Date.now()}`,
      ruleId: rule.id,
      symbol: ctx.symbol,
      kind: rule.kind,
      message,
      price: ctx.price,
      triggeredAt: Date.now(),
    });
  }

  return events;
}

function check(rule: AlertRule, ctx: EvalContext): string | null {
  const { price, technical: t, previousTechnical: prev } = ctx;
  const base = rule.symbol.replace(/USDT$|USDC$/, '');

  switch (rule.kind) {
    case 'price_above':
      return rule.threshold != null && price >= rule.threshold
        ? `${base} 价格 ${formatPrice(price)} 已突破 ${formatPrice(rule.threshold)}`
        : null;

    case 'price_below':
      return rule.threshold != null && price <= rule.threshold
        ? `${base} 价格 ${formatPrice(price)} 已跌破 ${formatPrice(rule.threshold)}`
        : null;

    case 'rsi_above':
      return t && rule.threshold != null && t.rsi14 >= rule.threshold
        ? `${base} ${rule.interval} RSI ${t.rsi14.toFixed(1)} 已高于 ${rule.threshold}`
        : null;

    case 'rsi_below':
      return t && rule.threshold != null && t.rsi14 <= rule.threshold
        ? `${base} ${rule.interval} RSI ${t.rsi14.toFixed(1)} 已低于 ${rule.threshold}`
        : null;

    case 'macd_cross':
      // cross 字段本身就只在交叉发生的那根 K 线上为真，无需与上一次比较
      return t && t.macd.cross !== 'none'
        ? `${base} ${rule.interval} MACD 形成${t.macd.cross === 'golden' ? '金叉' : '死叉'}`
        : null;

    case 'bb_squeeze_release':
      // 关键是"从挤压变为不挤压"这个转变，而不是当前是否挤压
      return prev?.bollinger.squeeze && t && !t.bollinger.squeeze
        ? `${base} ${rule.interval} 布林带挤压结束，变盘可能开始`
        : null;

    case 'volume_spike':
      return t && rule.threshold != null && t.volume.ratio20 >= rule.threshold
        ? `${base} ${rule.interval} 成交量达均量 ${t.volume.ratio20.toFixed(1)} 倍`
        : null;

    default:
      return null;
  }
}
