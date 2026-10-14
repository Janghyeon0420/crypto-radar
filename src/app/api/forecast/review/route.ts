import { NextResponse } from 'next/server';
import { forecastHistory, reviewForecasts } from '@/lib/forecast/service';
import { forecastRequest, sameOrigin } from '@/lib/forecast/request';

export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: '不允许跨站复盘' }, { status: 403 });
  const parsed = forecastRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '请选择有效的交易对和 K 线周期' }, { status: 400 });
  try {
    const reviewed = await reviewForecasts(parsed.data);
    return NextResponse.json({ ...await forecastHistory(parsed.data), ...reviewed });
  } catch {
    return NextResponse.json({ error: '复盘存档读写失败，请检查 data/forecasts 的权限与文件完整性' }, { status: 500 });
  }
}
