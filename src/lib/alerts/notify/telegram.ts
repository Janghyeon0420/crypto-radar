/**
 * Telegram Bot 通知出口。
 *
 * 选它的理由：免费、无需备案或审核、手机端推送可靠，
 * 且 api.telegram.org 直连与经代理均可达（实测均为 302/200），
 * 不会因为网络方案的调整而失效。
 */

import type { Notifier } from './types';

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

export function createTelegramNotifier(cfg: TelegramConfig): Notifier {
  return {
    id: 'telegram',
    label: 'Telegram',
    send: (text) => sendTelegram(cfg, text),
  };
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
