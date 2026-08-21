import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { fetchCandles, fetchTickers } from '@/lib/datasources/binance-vision';
import { fetchDerivatives } from '@/lib/datasources/okx';
import { fetchFearGreed } from '@/lib/datasources/sentiment';
import { fetchNews, filterNewsByAsset } from '@/lib/datasources/news';
import { fetchMacroSnapshot } from '@/lib/datasources/macro';
import { buildTechnicalSnapshot } from '@/lib/indicators/summary';
import { ProviderNotConfiguredError, isAnalysisAvailable, runAnalysis } from '@/lib/analysis/runner';
import { appendRecord, readRecords } from '@/lib/history/store';
import { decideCache, policyFromEnv } from '@/lib/history/cache';
import { calibrateConfidence } from '@/lib/history/calibrate';
import type { Interval } from '@/lib/datasources/types';
import { apiError } from '@/lib/api-error';

/** 研判用的周期组合：日内 + 中期 + 长期，用于判断多周期共振 */
const ANALYSIS_INTERVALS: Interval[] = ['1h', '4h', '1d'];

/**
 * LLM 要拉多个源、还要推理，耗时明显长于普通接口。
 * 实测中转站 claude-opus-5 约 23 秒、deepseek-v4-pro 约 95 秒，
 * 故留足余量，避免模型思考较久时被平台超时切断。
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
  let force = false;
  try {
    const body = await req.json();
    symbol = String(body.symbol ?? '').toUpperCase();
    force = body.force === true;
  } catch {
    return NextResponse.json({ error: '请求体必须是 JSON' }, { status: 400 });
  }
  if (!/^[A-Z0-9]{5,20}$/.test(symbol)) {
    return NextResponse.json({ error: 'symbol 格式非法' }, { status: 400 });
  }
  const baseAsset = symbol.replace(/USDT$|USDC$/, '');

  // ── 第一步：先只拉行情快照做缓存判定 ──
  // 刻意放在拉 K 线之前：命中缓存时可以把 3 次 K 线请求和 1 次 LLM 调用一并省掉。
  // 波动率基准直接用上次研判时记录的 ATR%，无需重新计算。
  // 上游异常必须翻译成 JSON 错误。裸抛会让 Next 返回空响应体的 500，
  // 界面上只能看到一句「Unexpected end of JSON input」——
  // 那既看不出是网络问题还是代码问题，也和其它数据路由的行为不一致
  let tickers;
  try {
    tickers = await fetchTickers([symbol]);
  } catch (err) {
    return apiError(err, 'binance.vision');
  }
  if (!tickers[0]) {
    return NextResponse.json({ error: `${symbol} 行情不可用` }, { status: 422 });
  }
  const currentPrice = tickers[0].last;

  // 读一次记录，缓存判定与置信度校准共用。
  // 校准刻意用**全部币种**的历史而不是本币种：模型的置信度是否虚高
  // 是模型自身的属性，按币种拆开只会让本就不多的样本更稀薄。
  const allRecords = await readRecords();

  if (!force) {
    const history = allRecords.filter((r) => r.symbol === symbol);
    const decision = decideCache(history, currentPrice, policyFromEnv());
    if (decision.reuse && decision.record) {
      console.log(`[analysis] ${symbol} 命中缓存 · ${decision.reason}`);
      return NextResponse.json({
        analysis: decision.record.analysis,
        generatedAt: decision.record.createdAt,
        recordId: decision.record.id,
        // 命中缓存时不写新记录——同一次研判若被计入准确率两次会污染回测数据
        cached: true,
        cacheReason: decision.reason,
        priceAtAnalysis: decision.record.priceAtAnalysis,
        currentPrice,
        calibration: calibrateConfidence(allRecords, decision.record.analysis.confidence),
      });
    }
  }

  // ── 第二步：缓存未命中，拉全量数据做研判 ──
  let candleSets;
  try {
    candleSets = await Promise.all(ANALYSIS_INTERVALS.map((i) => fetchCandles(symbol, i, 300)));
  } catch (err) {
    return apiError(err, 'binance.vision');
  }

  // 衍生品/情绪/资讯/宏观是可选增强，任一失败都不该阻塞主流程
  const [derivatives, sentiment, news, macro] = await Promise.allSettled([
    fetchDerivatives(symbol),
    fetchFearGreed(),
    fetchNews(60),
    fetchMacroSnapshot(),
  ]);

  const technicals = candleSets
    .map((candles, i) => buildTechnicalSnapshot(candles, ANALYSIS_INTERVALS[i]))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  if (technicals.length === 0) {
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
      macro: macro.status === 'fulfilled' ? macro.value : null,
    });

    // 记录本次研判及当时的价格与波动率基准，供日后检验准确率，
    // 同时作为下一次缓存判定的依据。落盘失败不该让用户白等一次研判。
    const record = {
      id: randomUUID(),
      symbol,
      createdAt: Date.now(),
      priceAtAnalysis: currentPrice,
      // 用最长周期的 ATR% 作为波动基准，它比短周期稳定
      atrPercentAtAnalysis: technicals[technicals.length - 1]?.volatility.atrPercent ?? NaN,
      analysis,
      evaluation: null,
    };
    await appendRecord(record).catch((e) => {
      console.warn('[analysis] 研判历史落盘失败：', e);
    });

    return NextResponse.json({
      analysis,
      generatedAt: record.createdAt,
      recordId: record.id,
      cached: false,
      currentPrice,
      // 用本次之前的历史校准——刚生成的这条还没有检验结果，计入也没有意义
      calibration: calibrateConfidence(allRecords, analysis.confidence),
    });
  } catch (err) {
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json({ error: err.message, code: 'NO_PROVIDER' }, { status: 503 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `研判失败：${message}` }, { status: 502 });
  }
}
