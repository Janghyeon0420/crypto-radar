import { NextResponse } from 'next/server';
import { dispatchText, resolveNotifiers } from '@/lib/alerts/notify';

/** 通知通道自检：向所有已配置通道真实发送一条测试消息 */
export async function POST() {
  const notifiers = resolveNotifiers();
  if (notifiers.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        detail:
          '未配置任何通知通道。可设置 ALERT_WEBHOOK_URL（企业微信/钉钉/飞书群机器人），详见 .env.example',
      },
      { status: 503 },
    );
  }

  const results = await dispatchText(
    `✅ Crypto Radar 告警通道自检\n\n如果你看到这条消息，说明通知已配置成功。\n${new Date().toLocaleString('zh-CN')}`,
  );

  const ok = results.every((r) => r.ok);
  return NextResponse.json(
    {
      ok,
      detail: results.map((r) => `${r.channel}：${r.ok ? '已发送' : r.detail}`).join('；'),
      results,
    },
    { status: ok ? 200 : 502 },
  );
}
