import { NextResponse } from 'next/server';
import { describeSource } from '@/lib/datasources/market';
import { fetchCandles as fetchBinanceCandles } from '@/lib/datasources/binance-vision';
import { fetchOkxCandles } from '@/lib/datasources/okx';
import { buildForecast, FORECAST_WINDOWS, unavailableForecast, type ForecastResponse } from '@/lib/indicators/forecast';

export async function GET(req: Request) {
  const symbol = new URL(req.url).searchParams.get('symbol')?.toUpperCase();
  if (!symbol || !/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return NextResponse.json({ error: 'symbol 格式非法' }, { status: 400 });
  }
  const source = await describeSource(symbol);
  // The table has one source label, so every row must use that exchange.
  const fetchCandles = source === 'binance' ? fetchBinanceCandles : fetchOkxCandles;
  const sets = await Promise.allSettled(
    FORECAST_WINDOWS.map((config) => fetchCandles(symbol, config.interval, 1000)),
  );
  const now = Date.now();
  const rows = sets.map((result, i) => result.status === 'fulfilled'
    ? buildForecast(result.value, FORECAST_WINDOWS[i], now)
    : unavailableForecast(FORECAST_WINDOWS[i], '该周期行情获取失败，请稍后刷新'));
  const response: ForecastResponse = { symbol, source, generatedAt: now, model: 'analog-v1', rows };
  return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
}
