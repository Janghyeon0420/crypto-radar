import { NextResponse } from 'next/server';
import { fetchCandles, fetchTickers } from '@/lib/datasources/binance-vision';
import { fetchDerivatives } from '@/lib/datasources/okx';
import { fetchFearGreed } from '@/lib/datasources/sentiment';
import { fetchNews, filterNewsByAsset } from '@/lib/datasources/news';
import { buildTechnicalSnapshot } from '@/lib/indicators/summary';
import { MissingApiKeyError, isAnalysisAvailable, runAnalysis } from '@/lib/analysis/claude';
import type { Interval } from '@/lib/datasources/types';

/** 研判用的周期组合：日内 + 中期 + 长期，用于判断多周期共振 */
const ANALYSIS_INTERVALS: Interval[] = ['1h', '4h', '1d'];

/** LLM 要拉多个源、还要推理，耗时明显长于普通接口 */
export const maxDuration = 120;

export async function POST(req: Request) {
  if (!isAnalysisAvailable()) {
    return NextResponse.json(
      { error: new MissingApiKeyError().message, code: 'NO_API_KEY' },
      { status: 503 },
    );
  }

  let symbol: string;
  try {
    const body = await req.json();
    symbol = String(body.symbol ?? '').toUpperCase();
  } catch {
    return NextResponse.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return NextResponse.json({ error: 'symbol 格式非法' }, { status: 400 });
  }
  const baseAsset = symbol.replace(/USDT$|USDC$/, '');

  // 全部并发。衍生品/情绪/资讯是可选增强，用 allSettled 保证任一失败都不影响主流程
  const [tickers, ...rest] = await Promise.all([
    fetchTickers([symbol]),
    ...ANALYSIS_INTERVALS.map((i) => fetchCandles(symbol, i, 300)),
  ]);
  const [derivatives, sentiment, news] = await Promise.allSettled([
    fetchDerivatives(symbol),
    fetchFearGreed(),
    fetchNews(60),
  ]);

  const technicals = rest
    .map((candles, i) => buildTechnicalSnapshot(candles, ANALYSIS_INTERVALS[i]))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  if (!tickers[0] || technicals.length === 0) {
    return NextResponse.json({ error: `${symbol} 数据不足，无法研判` }, { status: 422 });
  }

  try {
    const analysis = await runAnalysis({
      symbol,
      baseAsset,
      ticker: tickers[0],
      technicals,
      derivatives: derivatives.status === 'fulfilled' ? derivatives.value : null,
      sentiment: sentiment.status === 'fulfilled' ? sentiment.value : null,
      news:
        news.status === 'fulfilled' ? filterNewsByAsset(news.value, baseAsset).slice(0, 12) : [],
    });
    return NextResponse.json({ analysis, generatedAt: Date.now() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `研判失败：${message}` }, { status: 502 });
  }
}
