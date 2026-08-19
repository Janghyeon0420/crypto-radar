import { NextResponse } from 'next/server';
import { fetchCandles, fetchTickers } from '@/lib/datasources/binance-vision';
import { fetchDerivatives } from '@/lib/datasources/okx';
import { fetchFearGreed } from '@/lib/datasources/sentiment';
import { fetchNews, filterNewsByAsset } from '@/lib/datasources/news';
import { buildTechnicalSnapshot } from '@/lib/indicators/summary';
import { ProviderNotConfiguredError, isAnalysisAvailable, runAnalysis } from '@/lib/analysis/runner';
import { appendRecord } from '@/lib/history/store';
import { randomUUID } from 'node:crypto';
import type { Interval } from '@/lib/datasources/types';

/** 研判用的周期组合：日内 + 中期 + 长期，用于判断多周期共振 */
const ANALYSIS_INTERVALS: Interval[] = ['1h', '4h', '1d'];

/**
 * LLM 要拉多个源、还要推理，耗时明显长于普通接口。
 * 实测 deepseek-v4-pro 做一次多周期研判约 95 秒（推理模型），
 * 故留足余量，避免在模型思考较久时被平台超时切断。
 */
export const maxDuration = 300;

export async function POST(req: Request) {
  if (!isAnalysisAvailable()) {
    return NextResponse.json(
      {
        error:
          '未配置 LLM 供应商，AI 研判不可用（看板其余功能不受影响）。' +
          '可选 DeepSeek（国内直连，无需代理）、Anthropic 或任意 OpenAI 格式中转站，详见 .env.example。',
        code: 'NO_PROVIDER',
      },
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
    // 记录本次研判及当时的价格与波动率基准，供日后回头检验准确率。
    // 落盘失败不该让用户白等一次研判，所以只告警不抛错。
    const record = {
      id: randomUUID(),
      symbol,
      createdAt: Date.now(),
      priceAtAnalysis: tickers[0].last,
      // 用最长周期的 ATR% 作为波动基准，它比短周期稳定
      atrPercentAtAnalysis:
        technicals[technicals.length - 1]?.volatility.atrPercent ?? NaN,
      analysis,
      evaluation: null,
    };
    await appendRecord(record).catch((e) => {
      console.warn('[analysis] 研判历史落盘失败：', e);
    });

    return NextResponse.json({ analysis, generatedAt: record.createdAt, recordId: record.id });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message, code: 'NO_PROVIDER' }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `研判失败：${message}` }, { status: 502 });
  }
}
