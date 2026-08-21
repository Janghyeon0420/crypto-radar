import { NextResponse } from 'next/server';
import { fetchSymbols } from '@/lib/datasources/market';
import { apiError } from '@/lib/api-error';

/**
 * 全部 USDT 交易对，供「添加自选」的搜索框用。上游已缓存 1 小时。
 *
 * 含币安与 OKX 两家：币安没有的币种（如 HYPE）走 OKX，
 * 返回里带 exchange 字段标明来源。
 */
export async function GET() {
  try {
    return NextResponse.json({ symbols: await fetchSymbols() });
  } catch (err) {
    return apiError(err, 'binance.vision');
  }
}
