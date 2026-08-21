import { NextResponse } from 'next/server';
import { fetchCandles } from '@/lib/datasources/market';
import { buildTechnicalSnapshot } from '@/lib/indicators/summary';
import { computeResonance } from '@/lib/indicators/resonance';
import { apiError } from '@/lib/api-error';
import type { Interval } from '@/lib/datasources/types';

/** 与研判用的周期组合保持一致，否则界面上的共振分和研判里看到的对不上 */
const INTERVALS: Interval[] = ['1h', '4h', '1d'];

/**
 * 多周期共振。
 *
 * 单独成一个接口而不是塞进 klines：klines 是按当前选中周期取的，
 * 而共振天然需要多个周期。合并会让每次切换周期都多拉两次 K 线。
 */
export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get('symbol')?.toUpperCase();
  if (!symbol || !/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return NextResponse.json({ error: 'symbol 格式非法' }, { status: 400 });
  }

  try {
    const sets = await Promise.all(INTERVALS.map((i) => fetchCandles(symbol, i, 300)));
    const snapshots = sets
      .map((candles, i) => buildTechnicalSnapshot(candles, INTERVALS[i]))
      .filter((s): s is NonNullable<typeof s> => s !== null);

    return NextResponse.json({ resonance: computeResonance(snapshots) });
  } catch (err) {
    return apiError(err, 'binance.vision');
  }
}
