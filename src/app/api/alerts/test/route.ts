import { NextResponse } from 'next/server';
import { telegramConfigFromEnv, verifyTelegram } from '@/lib/alerts/notify/telegram';

/** 通知通道自检：验证 Bot Token 与 Chat ID 并真实发送一条测试消息 */
export async function POST() {
  const cfg = telegramConfigFromEnv();
  if (!cfg) {
    return NextResponse.json(
      { ok: false, detail: '未配置 TELEGRAM_BOT_TOKEN 与 TELEGRAM_CHAT_ID，详见 .env.example' },
      { status: 503 },
    );
  }
  const result = await verifyTelegram(cfg);
  return NextResponse.json(result, { status: result.ok ? 200 : 502 });
}
