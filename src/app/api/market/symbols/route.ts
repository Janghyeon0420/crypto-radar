import { NextResponse } from 'next/server';
import { fetchUsdtSymbols } from '@/lib/datasources/binance-vision';
import { apiError } from '@/lib/api-error';

/** 全部 USDT 交易对，供「添加自选」的搜索框用。上游已缓存 1 小时。 */
export async function GET() {
  try {
    return NextResponse.json({ symbols: await fetchUsdtSymbols() });
  } catch (err) {
    return apiError(err, 'binance.vision');
  }
}
