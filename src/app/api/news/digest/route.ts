import { NextResponse } from 'next/server';
import { fetchNews, filterNewsByAsset } from '@/lib/datasources/news';
import { runNewsDigest, type NewsDigest } from '@/lib/analysis/news-digest';
import {
  ProviderNotConfiguredError,
  describeProvider,
  isAnalysisAvailable,
} from '@/lib/analysis/runner';

/** LLM 调用比普通接口慢得多，给足余量 */
export const maxDuration = 120;

/**
 * 送进模型的资讯条数。
 *
 * 面板本身只显示 15 条，多送的部分模型也标不到界面上，纯属烧 token。
 * 取 18 是留一点余量：前端拿到的列表与这里各拉各的，两边不完全一致，
 * 多几条能让重合度更高。
 */
const DIGEST_SIZE = 18;

interface CacheEntry {
  digest: NewsDigest;
  generatedAt: number;
  /** 生成这份汇总用的模型，显示给用户看 */
  model: string;
}

/**
 * 汇总结果按「币种 + 范围」缓存在进程内。
 *
 * 必须缓存：面板一挂载就会请求它，而每次请求都是一次真实付费调用。
 * 没有缓存的话，在自选列表里点几下就是几次调用。
 *
 * 用内存而不是像研判那样落盘：汇总是对「此刻这批资讯」的概括，
 * 过了这阵子就没有回看价值，也不进准确率统计，落盘只是徒增文件。
 */
const cache = new Map<string, CacheEntry>();

/**
 * 正在生成中的请求，按同一把 key 合并。
 *
 * 必须有：缓存只在生成**完成后**才写入，而面板挂载时 React 开发模式会重复触发
 * effect，实测同一个币会同时打进来 4 个请求——它们全部绕过缓存，
 * 变成 4 次真实付费调用。让后来者直接等前一个的结果即可。
 *
 * force 也走同一把 key：既然此刻正在生成的就是新鲜结果，
 * 「强制刷新」要的东西它已经在做了，没有理由再发一次。
 */
const inflight = new Map<string, Promise<CacheEntry>>();

function ttlMs(): number {
  const minutes = Number(process.env.NEWS_DIGEST_TTL_MINUTES);
  return (Number.isFinite(minutes) && minutes > 0 ? minutes : 20) * 60_000;
}

/**
 * 资讯 AI 汇总。
 *
 * 与 /api/news 分开而不是合并成一个接口：资讯列表几百毫秒就能返回，
 * 汇总要等模型十几到几十秒。合并的结果是列表也得跟着一起等，
 * 而先出列表、后出汇总，等待期间界面是有内容可读的。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const asset = url.searchParams.get('asset')?.toUpperCase() || null;
  const force = url.searchParams.get('force') === '1';

  if (asset && !/^[A-Z0-9]{2,20}$/.test(asset)) {
    return NextResponse.json({ error: 'asset 格式非法' }, { status: 400 });
  }

  if (!isAnalysisAvailable()) {
    return NextResponse.json(
      {
        digest: null,
        error:
          '未配置 LLM 供应商，资讯汇总不可用（资讯列表本身不受影响）。' +
          '可选 DeepSeek（国内直连，无需代理）、Anthropic 或任意 OpenAI 格式中转站，详见 .env.example。',
        code: 'NO_PROVIDER',
      },
      { status: 503 },
    );
  }

  const key = asset ?? '__all__';
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.generatedAt < ttlMs()) {
    return NextResponse.json({
      digest: hit.digest,
      generatedAt: hit.generatedAt,
      model: hit.model,
      cached: true,
    });
  }

  try {
    const entry = await (inflight.get(key) ?? start(key, asset));
    return NextResponse.json({
      digest: entry.digest,
      generatedAt: entry.generatedAt,
      model: entry.model,
      cached: false,
    });
  } catch (err) {
    if (err instanceof NoNewsError) {
      return NextResponse.json({ digest: null, error: err.message, code: 'NO_NEWS' });
    }
    if (err instanceof ProviderNotConfiguredError) {
      return NextResponse.json(
        { digest: null, error: err.message, code: 'NO_PROVIDER' },
        { status: 503 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ digest: null, error: `资讯汇总失败：${message}` }, { status: 502 });
  }
}

class NoNewsError extends Error {}

/** 发起一次生成，并把它登记进 inflight，让同期的请求能搭上车 */
function start(key: string, asset: string | null): Promise<CacheEntry> {
  const task = (async () => {
    const all = await fetchNews(60);
    const scoped = asset ? filterNewsByAsset(all, asset) : all;
    const news = scoped.slice(0, DIGEST_SIZE);

    if (news.length === 0) {
      throw new NoNewsError(asset ? `未匹配到 ${asset} 相关资讯` : '暂无资讯');
    }

    const entry: CacheEntry = {
      digest: await runNewsDigest({ baseAsset: asset, news }),
      generatedAt: Date.now(),
      model: describeProvider().label ?? '未知模型',
    };
    cache.set(key, entry);
    return entry;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}
