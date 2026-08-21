/**
 * 带超时、重试和内存缓存的 fetch 封装。
 *
 * 为什么需要：本项目的数据源全部是公共免费接口，限流严格（CoinGecko 尤其），
 * 且在受限网络下偶发超时。统一在这里做退避重试和短 TTL 缓存，
 * 避免每个 adapter 各写一遍，也避免前端刷新把上游打挂。
 */

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

/**
 * 缓存挂在 globalThis 上，而不是模块级变量。
 *
 * 与 alerts/worker.ts 是同一个原因：Next.js 把 instrumentation 与 API 路由
 * 编译进不同的模块图，模块级变量在两边是各自独立的副本。
 * 后果是启动预热拉到的数据，API 路由根本看不见——预热等于白做，
 * 而告警 worker 与路由也会各自向上游要一遍同样的数据。
 *
 * 这类问题不会报错，只会表现为「明明缓存了却还是慢」。
 */
const CACHE_KEY = Symbol.for('crypto-radar.http.cache');
const g = globalThis as unknown as Record<symbol, Map<string, CacheEntry> | undefined>;
g[CACHE_KEY] ??= new Map<string, CacheEntry>();
const cache = g[CACHE_KEY];

export interface FetchOptions {
  /** 缓存存活时间（毫秒），0 表示不缓存 */
  ttlMs?: number;
  timeoutMs?: number;
  retries?: number;
  headers?: Record<string, string>;
}

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

/**
 * 451 是币安主站对受限地区的响应码。单独识别出来，
 * 好让上层给出"该走 binance.vision 镜像"的明确提示，而不是笼统报错。
 */
export function isGeoBlocked(err: unknown): boolean {
  return err instanceof UpstreamError && (err.status === 451 || err.status === 403);
}

export async function fetchJson<T>(url: string, opts: FetchOptions = {}): Promise<T> {
  const { ttlMs = 0, timeoutMs = 10_000, retries = 2, headers } = opts;

  if (ttlMs > 0) {
    const hit = cache.get(url);
    if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  }

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { accept: 'application/json', ...headers },
        cache: 'no-store',
      });
      if (!res.ok) {
        throw new UpstreamError(`HTTP ${res.status} from ${hostOf(url)}`, res.status, url);
      }
      const value = (await res.json()) as T;
      if (ttlMs > 0) cache.set(url, { value, expiresAt: Date.now() + ttlMs });
      return value;
    } catch (err) {
      lastErr = err;
      // 地理封锁和 4xx 重试没有意义，立即抛出交给上层降级
      if (err instanceof UpstreamError && err.status && err.status < 500 && err.status !== 429) {
        throw err;
      }
      if (attempt < retries) {
        await sleep(300 * 2 ** attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * 拉取文本（RSS 是 XML，不能走 fetchJson）。
 *
 * 同样支持 ttlMs：有些文本源体积大而更新极慢——比如 FOMC 会议日历
 * 一页 160KB、一年只变几次——每次请求都重新拉纯属浪费。
 */
export async function fetchText(url: string, opts: FetchOptions = {}): Promise<string> {
  const { ttlMs = 0, timeoutMs = 10_000, headers } = opts;
  const key = `text:${url}`;

  if (ttlMs > 0) {
    const hit = cache.get(key);
    if (hit && hit.expiresAt > Date.now()) return hit.value as string;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'crypto-radar/0.1', ...headers },
      cache: 'no-store',
    });
    if (!res.ok) throw new UpstreamError(`HTTP ${res.status} from ${hostOf(url)}`, res.status, url);
    const text = await res.text();
    if (ttlMs > 0) cache.set(key, { value: text, expiresAt: Date.now() + ttlMs });
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
