/**
 * Telegram Bot 通知出口。
 *
 * 选它的理由：免费、无需备案或审核、手机端推送可靠，
 * 且 api.telegram.org 直连与经代理均可达（实测均为 302/200），
 * 不会因为网络方案的调整而失效。
 */

import type { AlertEvent } from '../types';
import { ALERT_LABELS } from '../types';
import { formatPrice } from '../../format';

const API = 'https://api.telegram.org';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

export function telegramConfigFromEnv(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) return null;
  return { botToken, chatId };
}

/** 校验 token 与 chatId 是否可用，供设置界面做连通性自检 */
export async function verifyTelegram(
  cfg: TelegramConfig,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${API}/bot${cfg.botToken}/getMe`, {
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json();
    if (!data.ok) {
      return { ok: false, detail: `Bot Token 无效：${data.description ?? '未知错误'}` };
    }
    const botName = data.result?.username ? `@${data.result.username}` : '(未知)';

    // getMe 通过只说明 token 对，chatId 是否正确要真发一条才知道
    const sent = await sendTelegram(cfg, `✅ Crypto Radar 告警通道已连通（${botName}）`);
    return sent.ok
      ? { ok: true, detail: `已连通 ${botName}，测试消息已发送` }
      : { ok: false, detail: `Token 有效但发送失败：${sent.detail}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function sendTelegram(
  cfg: TelegramConfig,
  text: string,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(`${API}/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.chatId,
        text,
        parse_mode: 'HTML',
        // 告警是提醒，不需要链接预览占屏
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const data = await res.json();
    return data.ok
      ? { ok: true, detail: 'sent' }
      : { ok: false, detail: data.description ?? `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 把一批事件排版成一条消息。
 * 合并发送而不是逐条推送——同一轮轮询触发多条时，
 * 手机上连响五六下的体验很糟，也更容易被整体忽略。
 */
export function formatEvents(events: AlertEvent[]): string {
  if (events.length === 1) {
    const e = events[0];
    return (
      `🔔 <b>${escapeHtml(e.symbol)}</b> ${escapeHtml(ALERT_LABELS[e.kind])}\n\n` +
      `${escapeHtml(e.message)}\n\n` +
      `<i>现价 ${formatPrice(e.price)} · ${new Date(e.triggeredAt).toLocaleString('zh-CN')}</i>`
    );
  }

  const lines = events.map(
    (e) => `• <b>${escapeHtml(e.symbol)}</b> ${escapeHtml(e.message)}`,
  );
  return (
    `🔔 <b>${events.length} 条告警触发</b>\n\n` +
    lines.join('\n') +
    `\n\n<i>${new Date().toLocaleString('zh-CN')}</i>`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
