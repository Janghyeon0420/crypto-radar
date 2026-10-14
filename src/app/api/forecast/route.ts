import { NextResponse } from 'next/server';
import { createForecast, forecastHistory } from '@/lib/forecast/service';
import { forecastRequest, sameOrigin } from '@/lib/forecast/request';
import { ForecastInputError } from '@/lib/forecast/engine';
import { apiError } from '@/lib/api-error';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const parsed = forecastRequest.safeParse({ symbol: params.get('symbol'), interval: params.get('interval') });
  if (!parsed.success) return NextResponse.json({ error: '请选择有效的交易对和 K 线周期' }, { status: 400 });
  try {
    return NextResponse.json(await forecastHistory(parsed.data), { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return NextResponse.json({ error: '读取预测存档失败，请检查 data/forecasts 的权限与文件完整性' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  if (!sameOrigin(req)) return NextResponse.json({ error: '不允许跨站生成预测' }, { status: 403 });
  const parsed = forecastRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: '请选择有效的交易对和 K 线周期' }, { status: 400 });
  try {
    return NextResponse.json(await createForecast(parsed.data.symbol, parsed.data.interval));
  } catch (err) {
    if (err instanceof ForecastInputError) return NextResponse.json({ error: err.message }, { status: 422 });
    return apiError(err, '技术预测');
  }
}
