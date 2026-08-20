/**
 * 通知分发。
 *
 * 支持同时配置多个通道（比如群机器人 + Telegram），逐个送达；
 * 某一路失败不影响其它路，也不影响事件落盘——
 * 通知只是送达手段，事件本身已经记录在案，界面上始终看得到。
 */

import type { AlertEvent } from '../types';
import { formatEventsPlain } from './format';
import { createWebhookBot, webhookBotFromEnv } from './webhook-bot';
import { createTelegramNotifier, telegramConfigFromEnv } from './telegram';
import type { Notifier, SendResult } from './types';

/** 读取环境变量，构造所有已配置的通道 */
export function resolveNotifiers(): Notifier[] {
  const notifiers: Notifier[] = [];

  const webhook = webhookBotFromEnv();
  if (webhook.status === 'ok') notifiers.push(createWebhookBot(webhook.config));

  const telegram = telegramConfigFromEnv();
  if (telegram) notifiers.push(createTelegramNotifier(telegram));

  return notifiers;
}

/**
 * 配置层面的问题清单，供界面显示。
 * 「填了但不生效」必须能在界面上看到原因，而不是只写进服务端日志。
 */
export function notifierConfigIssues(): string[] {
  const issues: string[] = [];
  const webhook = webhookBotFromEnv();
  if (webhook.status === 'invalid') issues.push(`ALERT_WEBHOOK_URL：${webhook.reason}`);
  return issues;
}

export interface DispatchResult {
  channel: string;
  ok: boolean;
  detail: string;
}

export async function dispatchEvents(events: AlertEvent[]): Promise<DispatchResult[]> {
  return dispatchText(formatEventsPlain(events));
}

export async function dispatchText(text: string): Promise<DispatchResult[]> {
  const notifiers = resolveNotifiers();
  // 并行发送：一个通道超时不该拖慢其它通道
  const results = await Promise.all(
    notifiers.map(async (n): Promise<DispatchResult> => {
      const r: SendResult = await n.send(text);
      return { channel: n.label, ok: r.ok, detail: r.detail };
    }),
  );
  return results;
}

export { formatEventsPlain };
export type { Notifier } from './types';
