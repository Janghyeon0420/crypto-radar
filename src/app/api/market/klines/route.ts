import { NextResponse } from 'next/server';
import { fetchCandles } from '@/lib/datasources/binance-vision';
import { buildTechnicalSnapshot } from '@/lib/indicators/summary';
import { INTERVALS, type Interval } from '@/lib/datasources/types';
import { apiError } from '@/lib/api-error';

/**
 * K 线 + 技术面快照。
 *
 * 指标在服务端算，前端只负责渲染：避免把 500 根 K 线的计算压在浏览器主线程上，
 * 也保证图表、指标面板和 LLM 研判用的是同一份计算结果，不会出现三处数字对不上。
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const symbol = (searchParams.get('symbol') ?? 'BTCUSDT').toUpperCase();
  const interval = searchParams.get('interval') as Interval | null;
  const limit = Math.min(Number(searchParams.get('limit')) || 500, 1000);

  if (!interval || !INTERVALS.includes(interval)) {
    return NextResponse.json(
      { error: `interval 必须是 ${INTERVALS.join(' / ')} 之一` },
      { status: 400 },
    );
  }
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return NextResponse.json({ error: 'symbol 格式非法' }, { status: 400 });
  }

  try {
    const candles = await fetchCandles(symbol, interval, limit);
    return NextResponse.json({
      symbol,
      interval,
      candles,
      technical: buildTechnicalSnapshot(candles, interval),
    });
  } catch (err) {
    return apiError(err, 'binance.vision');
  }
}
