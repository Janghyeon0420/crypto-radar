import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { describeSource, fetchCandles, fetchTickers } from '@/lib/datasources/market';
import { fetchDerivatives } from '@/lib/datasources/okx';
import { fetchFearGreed } from '@/lib/datasources/sentiment';
import { fetchNews, filterNewsByAsset } from '@/lib/datasources/news';
import { fetchMacroSnapshot } from '@/lib/datasources/macro';
import { fetchOnchainSnapshot } from '@/lib/datasources/onchain';
import { buildTechnicalSnapshot } from '@/lib/indicators/summary';
import {
  describeProvider,
  isAnalysisAvailable,
  runAnalysis,
} from '@/lib/analysis/runner';
import { explainMarketError, explainModelError, withRetry } from '@/lib/analysis/errors';
import { appendRecord, readRecords } from '@/lib/history/store';
import { decideCache, policyFromEnv } from '@/lib/history/cache';
import { calibrateConfidence } from '@/lib/history/calibrate';
import type { Interval } from '@/lib/datasources/types';

/** 研判用的周期组合：日内 + 中期 + 长期，用于判断多周期共振 */
const ANALYSIS_INTERVALS: Interval[] = ['1h', '4h', '1d'];

/**
 * LLM 要拉多个源、还要推理，耗时明显长于普通接口。
 * 实测中转站 claude-opus-5 约 23 秒、deepseek-v4-pro 约 95 秒，
 * 故留足余量，避免模型思考较久时被平台超时切断。
 */
export const maxDuration = 300;

/**
 * 研判接口。返回 **NDJSON 流**而不是单个 JSON。
 *
 * 动机：实测单次研判 23-95 秒，期间界面只有一个「研判中…」，
 * 用户分不清是在正常工作还是卡死了。
 *
 * 没有走「流式输出模型 token」那条路——研判结果必须完整到齐才能通过
 * Zod 校验，半个 JSON 驱动不了 UI。真正有用的是**走到哪一步了**，
 * 而那个信息服务端一直都有，只是以前没往外说。
 *
 * 每行一个 JSON 对象：
 *   {"stage":"quote"|"klines"|"context"|"model"}   进度
 *   {"stage":"retry", "attempt":2, "reason":"..."}  模型输出不合格，自动重试中
 *   {"stage":"done", ...研判结果}                    成功
 *   {"stage":"error", "error":"...", "code":"...", "retryable":bool}   失败
 */
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

  const encoder = new TextEncoder();
  /**
   * 客户端中途走掉（刷新页面、切走网络）后流被取消，此后 enqueue 会抛 TypeError。
   * 让它冒上去，取数阶段断线会在下一次 send 处中止整个流程，已拉好的数据白费；
   * 模型阶段断线则在收尾处抛出没人接的异常。
   * 所以断线后 send 变成空操作，流程照常跑完：结果照样写进历史，
   * 用户再点一次研判会直接命中缓存，不会为同一次推理付两次钱。
   */
  let closed = false;
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch {
          closed = true;
        }
      };

      try {
        await runAnalysisFlow(symbol, force, send);
      } catch (err) {
        const e = explainModelError(err);
        send({ stage: 'error', error: e.message, code: e.code, retryable: e.retryable });
      } finally {
        if (!closed) {
          try {
            controller.close();
          } catch {
            // 已被客户端取消，无需再关
          }
        }
      }
    },
    cancel() {
      closed = true;
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
      // 关掉中间层缓冲，否则进度会攒到最后一起吐出来，等于没做
      'x-accel-buffering': 'no',
    },
  });
}

type Send = (obj: Record<string, unknown>) => void;

async function runAnalysisFlow(symbol: string, force: boolean, send: Send): Promise<void> {
  const startedAt = Date.now();
  const baseAsset = symbol.replace(/USDT$|USDC$/, '');

  // ── 第一步：先只拉行情快照做缓存判定 ──
  // 刻意放在拉 K 线之前：命中缓存时可以把 3 次 K 线请求和 1 次 LLM 调用一并省掉。
  send({ stage: 'quote' });

  let tickers;
  try {
    tickers = await withRetry(async () => {
      const t = await fetchTickers([symbol]);
      // fetchTickers 为了「一家挂了不拖累另一家」会吞掉单个交易所的失败，只留下空数组。
      // 这里把空结果还原成失败：既能重试，也不会把网络超时误报成「行情不可用」
      if (!t[0]) throw new Error('交易所没有返回该交易对的行情');
      return t;
    });
  } catch (err) {
    const e = explainMarketError(err, await sourceLabel(symbol), symbol);
    send({ stage: 'error', error: e.message, code: e.code, retryable: e.retryable });
    return;
  }
  const currentPrice = tickers[0].last;

  // 读一次记录，缓存判定与置信度校准共用
  const allRecords = await readRecords();

  if (!force) {
    const history = allRecords.filter((r) => r.symbol === symbol);
    const decision = decideCache(history, currentPrice, policyFromEnv());
    if (decision.reuse && decision.record) {
      console.log(`[analysis] ${symbol} 命中缓存 · ${decision.reason}`);
      send({
        stage: 'done',
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
      return;
    }
  }

  // ── 第二步：缓存未命中，拉全量数据做研判 ──
  send({ stage: 'klines' });

  let candleSets;
  try {
    // 三个周期一个都不能少（多周期共振是研判的核心），所以逐个重试而不是容忍缺失
    candleSets = await Promise.all(
      ANALYSIS_INTERVALS.map((i) => withRetry(() => fetchCandles(symbol, i, 300))),
    );
  } catch (err) {
    const e = explainMarketError(err, await sourceLabel(symbol), symbol);
    send({ stage: 'error', error: e.message, code: e.code, retryable: e.retryable });
    return;
  }

  const technicals = candleSets
    .map((candles, i) => buildTechnicalSnapshot(candles, ANALYSIS_INTERVALS[i]))
    .filter((t): t is NonNullable<typeof t> => t !== null);

  if (technicals.length === 0) {
    send({ stage: 'error', error: `${symbol} 数据不足，无法研判` });
    return;
  }

  send({ stage: 'context' });

  // 衍生品/情绪/资讯/宏观是可选增强，任一失败都不该阻塞主流程
  const [derivatives, sentiment, news, macro, onchain] = await Promise.allSettled([
    fetchDerivatives(symbol),
    fetchFearGreed(),
    fetchNews(60),
    fetchMacroSnapshot(),
    fetchOnchainSnapshot(),
  ]);

  // 模型这一步最长。把「上次这个币用了多久」一并告诉前端——
  // 「通常 23-95 秒」这种范围太宽等于没说，「上次 47 秒」才是有依据的预期
  send({ stage: 'model', ...describeProvider(), typicalMs: typicalDuration(allRecords) });

  try {
    const analysis = await runAnalysis(
      {
        symbol,
        baseAsset,
        ticker: tickers[0],
        technicals,
        derivatives: derivatives.status === 'fulfilled' ? derivatives.value : null,
        sentiment: sentiment.status === 'fulfilled' ? sentiment.value : null,
        news:
          news.status === 'fulfilled' ? filterNewsByAsset(news.value, baseAsset).slice(0, 12) : [],
        macro: macro.status === 'fulfilled' ? macro.value : null,
        onchain: onchain.status === 'fulfilled' ? onchain.value : null,
      },
      {
        // 重试等于再等一整轮模型推理。不说的话，界面上看起来就是卡在「等待模型」，
        // 用户在第 60 秒会以为它挂了，实际是第一次输出不合格、正在跑第二次
        onRetry: ({ attempt, reason }) =>
          send({ stage: 'retry', attempt, reason: reason.split('\n')[0].slice(0, 100) }),
      },
    );

    const record = {
      id: randomUUID(),
      symbol,
      createdAt: Date.now(),
      priceAtAnalysis: currentPrice,
      // 用最长周期的 ATR% 作为波动基准，它比短周期稳定
      atrPercentAtAnalysis: technicals[technicals.length - 1]?.volatility.atrPercent ?? NaN,
      analysis,
      evaluation: null,
      durationMs: Date.now() - startedAt,
    };
    await appendRecord(record).catch((e) => {
      console.warn('[analysis] 研判历史落盘失败：', e);
    });

    send({
      stage: 'done',
      analysis,
      generatedAt: record.createdAt,
      recordId: record.id,
      cached: false,
      currentPrice,
      durationMs: record.durationMs,
      // 用本次之前的历史校准——刚生成的这条还没有检验结果，计入也没有意义
      calibration: calibrateConfidence(allRecords, analysis.confidence),
    });
  } catch (err) {
    console.warn(`[analysis] ${symbol} 研判失败：${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    const e = explainModelError(err);
    send({ stage: 'error', error: e.message, code: e.code, retryable: e.retryable });
  }
}

/** 报错里用的数据源名称。失败路径上才调用，查不出来就退回泛称，不能让它再抛一次错 */
async function sourceLabel(symbol: string): Promise<string> {
  try {
    return (await describeSource(symbol)) === 'okx' ? 'OKX ' : '币安镜像（binance.vision）';
  } catch {
    return '';
  }
}

/** 最近几次真实研判的中位耗时。没有历史时返回 null，不编一个数字 */
function typicalDuration(records: { durationMs?: number }[]): number | null {
  const durations = records
    .map((r) => r.durationMs)
    .filter((d): d is number => typeof d === 'number' && d > 0)
    .slice(-5)
    .sort((a, b) => a - b);
  return durations.length ? durations[Math.floor(durations.length / 2)] : null;
}
