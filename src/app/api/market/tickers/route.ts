import { NextResponse } from 'next/server';
import { fetchTickers } from '@/lib/datasources/binance-vision';
import { apiError } from '@/lib/api-error';

/** 自选列表的 24h 行情。symbols 用逗号分隔，不传则返回全市场（响应较大，慎用）。 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get('symbols');
  const symbols = raw
    ? raw
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter((s) => /^[A-Z0-9]{5,20}$/.test(s))
    : undefined;

  try {
    return NextResponse.json({ tickers: await fetchTickers(symbols) });
  } catch (err) {
    return apiError(err, 'binance.vision');
  }
}
