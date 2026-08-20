/**
 * 告警消息排版。
 *
 * 一轮轮询触发的多条合并成一条发出，而不是逐条推送——
 * 同时触发五六条时手机连响的体验很糟，也更容易被整体忽略。
 *
 * 用纯文本而非各家的 markdown：企业微信、钉钉、飞书的 markdown
 * 语法与支持程度都不一致，纯文本是唯一在三家都稳定的表达。
 */

import type { AlertEvent } from '../types';
import { ALERT_LABELS } from '../types';
import { formatPrice } from '../../format';

export function formatEventsPlain(events: AlertEvent[]): string {
  const now = new Date().toLocaleString('zh-CN');

  if (events.length === 1) {
    const e = events[0];
    return (
      `🔔 ${e.symbol} ${ALERT_LABELS[e.kind]}\n\n` +
      `${e.message}\n\n` +
      `现价 ${formatPrice(e.price)}\n${now}`
    );
  }

  const lines = events.map((e) => `· ${e.message}`);
  return `🔔 ${events.length} 条告警触发\n\n${lines.join('\n')}\n\n${now}`;
}
