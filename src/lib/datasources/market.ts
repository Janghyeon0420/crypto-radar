/**
 * 行情路由。
 *
 * 上层（指标、告警、研判、对比、共振）只调这里的 `fetchCandles` / `fetchTickers`，
 * 拿到的永远是统一契约里的 `Candle` / `Ticker`，不需要知道数据来自哪家交易所。
 * 这正是 `datasources/types.ts` 当初做统一契约的用意——
 * 加一家交易所时，改动被限制在这一层内部，不会扩散到上层。
 *
 * 为什么需要它：币安现货没有 HYPE（Hyperliquid），而 OKX 有
 * HYPE-USDT 现货与 HYPE-USDT-SWAP 永续。以前「数据源不稳定」是假设，
 * 现在是事实。
 *
 * 路由原则：**币安优先**。它的历史更长（1000 根 vs OKX 的 300 根）、
 * 有主动买入量字段、WebSocket 也是现成的。只有币安没有的币才走 OKX。
 */

import {
  fetchCandles as fetchBinanceCandles,
  fetchTickers as fetchBinanceTickers,
  fetchUsdtSymbols,
  type SymbolInfo,
} from './binance-vision';
import { fetchOkxCandles, fetchOkxSpotSymbols, fetchOkxTickers } from './okx';
import type { Candle, Interval, Ticker } from './types';
import { UpstreamError } from './http';

export type Exchange = 'binance' | 'okx';

interface Registry {
  binance: Set<string>;
  okx: Set<string>;
  at: number;
}

/**
 * 交易对注册表挂 globalThis。
 *
 * 与 http.ts 的缓存同一个原因：Next 把 instrumentation 与 API 路由编译进
 * 不同模块图，模块级变量在两边是各自独立的副本。告警 worker 与页面请求
 * 各建一份注册表意味着各拉一次交易对列表，且可能得出不同的路由结论。
 */
const KEY = Symbol.for('crypto-radar.market.registry');
const g = globalThis as unknown as Record<symbol, Registry | undefined>;

const TTL_MS = 3600_000;
const SOURCE_KEY = Symbol.for('crypto-radar.market.sources');
const sourceGlobal = globalThis as unknown as Record<symbol, Map<string, { source: Exchange; until: number }> | undefined>;
sourceGlobal[SOURCE_KEY] ??= new Map();
const recentSources = sourceGlobal[SOURCE_KEY];

function rememberSource(symbol: string, source: Exchange) {
  recentSources.set(symbol, { source, until: Date.now() + 60_000 });
}

async function registry(knownBinance?: SymbolInfo[]): Promise<Registry> {
  const cached = g[KEY];
  if (cached && Date.now() - cached.at < TTL_MS) return cached;

  const [binance, okx] = await Promise.allSettled([
    knownBinance ? Promise.resolve(knownBinance) : fetchUsdtSymbols(), fetchOkxSpotSymbols(),
  ]);

  const next: Registry = {
    binance: new Set(
      binance.status === 'fulfilled' ? binance.value.map((s) => s.symbol) : [],
    ),
    okx: new Set(okx.status === 'fulfilled' ? okx.value : []),
    at: Date.now(),
  };

  // 两家都没拉到时保留上一份（哪怕过期），比清空好——
  // 清空会让所有币种被判定为「币安」然后逐个失败
  if (next.binance.size === 0 && next.okx.size === 0 && cached) return cached;

  g[KEY] = next;
  return next;
}

/**
 * 这个币该向谁要数据。
 *
 * 注册表拉不到时默认币安：绝大多数币种在币安，
 * 猜错的代价是一次失败的请求，而不是把所有币都路由错。
 */
export async function resolveExchange(symbol: string): Promise<Exchange> {
  const recent = recentSources.get(symbol);
  if (recent && recent.until > Date.now()) return recent.source;
  const cached = g[KEY];
  if (cached && Date.now() - cached.at < TTL_MS) {
    if (cached.binance.has(symbol)) return 'binance';
    if (cached.okx.has(symbol)) return 'okx';
  }
  // Do not wait for OKX's registry when Binance already lists this symbol.
  // An unavailable secondary exchange used to stall every cold page request.
  const binance = await fetchUsdtSymbols().catch(() => [] as SymbolInfo[]);
  if (binance.some((entry) => entry.symbol === symbol)) return 'binance';
  const reg = await registry(binance);
  if (reg.binance.has(symbol)) return 'binance';
  if (reg.okx.has(symbol)) return 'okx';
  return 'binance';
}

export async function fetchCandles(
  symbol: string,
  interval: Interval,
  limit = 500,
): Promise<Candle[]> {
  return (await fetchCandlesWithSource(symbol, interval, limit)).candles;
}

const SOURCE_LABEL: Record<Exchange, string> = { binance: '币安镜像', okx: 'OKX' };
const failureText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Return provenance from the fetch itself, including a temporary fallback. */
export async function fetchCandlesWithSource(
  symbol: string, interval: Interval, limit = 500, options: { fresh?: boolean } = {},
): Promise<{ candles: Candle[]; source: Exchange }> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit 必须为 1–1000 的整数');
  const preferred = await resolveExchange(symbol);
  const failures: { source: Exchange; err: unknown }[] = [];
  for (const source of [preferred, preferred === 'binance' ? 'okx' : 'binance'] as Exchange[]) {
    try {
      const candles = await (source === 'binance' ? fetchBinanceCandles : fetchOkxCandles)(symbol, interval, limit, undefined, options);
      validateCandles(candles);
      if (candles.length === 0) throw new UpstreamError(`${source} 未返回该交易对 K 线`);
      rememberSource(symbol, source);
      return { candles, source };
    } catch (err) {
      failures.push({ source, err });
    }
  }

  // 两家都失败：以**主源**的失败为主，并说明回退源也没成。
  // 以前直接抛最后一次（回退源）的错误，会把真正的根因盖住——比如币安超时、OKX 又不认识这个交易对，
  // 用户只会看到「OKX 接口返回错误」，然后去查 OKX。状态码与 cause 也取主源的：
  // 上层（api-error）据此决定错误码与提示，排查时也能顺着 cause 找到底层错误码。
  const [primary, fallback] = failures;
  const primaryErr = primary.err instanceof UpstreamError ? primary.err : undefined;
  throw new UpstreamError(
    `${SOURCE_LABEL[primary.source]}失败：${failureText(primary.err)}；` +
      `回退到${SOURCE_LABEL[fallback.source]}也失败：${failureText(fallback.err)}`,
    primaryErr?.status,
    primaryErr?.url,
    { cause: primary.err },
  );
}

const DURATION: Record<Interval, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000,
  '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
};

/** Inclusive open-time window, pinned to the original exchange for honest review. */
export async function fetchCandleWindow(
  symbol: string, interval: Interval, startTime: number, endTime: number, source: Exchange,
): Promise<Candle[]> {
  const duration = DURATION[interval];
  if (!duration || !Number.isSafeInteger(startTime) || !Number.isSafeInteger(endTime) || startTime < 0 || endTime < startTime) {
    throw new Error('历史 K 线时间窗口非法');
  }
  const limit = Math.floor((endTime - startTime) / duration) + 1;
  if (limit > 100) throw new Error('单次复盘最多读取 100 根历史 K 线');
  if (source !== 'binance' && source !== 'okx') throw new Error('历史 K 线来源非法');
  const candles = await (source === 'binance' ? fetchBinanceCandles : fetchOkxCandles)(
    symbol, interval, limit, { startTime, endTime },
  );
  validateCandles(candles);
  return candles.filter((c) => c.time >= startTime && c.time <= endTime);
}

function validateCandles(candles: Candle[]) {
  if (candles.some((c, i) =>
    ![c.time, c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) ||
    c.time < 0 || c.low <= 0 || c.volume < 0 || c.high < Math.max(c.open, c.close, c.low) ||
    c.low > Math.min(c.open, c.close) || (i > 0 && c.time <= candles[i - 1].time)
  )) throw new UpstreamError('上游 K 线数据无效，已停止指标和预测计算');
}

/**
 * 批量行情。按交易所分组后各发一次请求，而不是逐个币种查——
 * 自选里混着两家的币时，这能把 N 次请求压到 2 次。
 *
 * **不传 symbols 表示「全市场」，而全市场只覆盖币安**。
 * 把两家的全部交易对拼起来没有意义：同一个币在两边价格略有差异，
 * 混在一张表里排序会让人以为存在套利空间，实际只是数据源不同。
 * OKX 独有的币种必须显式指定才会被查询。
 */
export async function fetchTickers(symbols?: string[]): Promise<Ticker[]> {
  if (!symbols) return fetchBinanceTickers();

  if (symbols.length === 0) return [];
  const exchanges = await Promise.all(symbols.map(resolveExchange));
  const binance: string[] = [];
  const okx: string[] = [];

  symbols.forEach((symbol, i) => {
    (exchanges[i] === 'okx' ? okx : binance).push(symbol);
  });

  const [b, o] = await Promise.allSettled([
    binance.length ? fetchBinanceTickers(binance) : Promise.resolve([]),
    okx.length ? fetchOkxTickers(okx) : Promise.resolve([]),
  ]);

  // Preserve successful results, but never present a total outage as an empty 200.
  if ((binance.length === 0 || b.status === 'rejected') && (okx.length === 0 || o.status === 'rejected')) {
    throw b.status === 'rejected' ? b.reason : o.status === 'rejected' ? o.reason : new UpstreamError('行情暂不可用');
  }
  return [
    ...(b.status === 'fulfilled' ? b.value : []),
    ...(o.status === 'fulfilled' ? o.value : []),
  ];
}

/**
 * 可搜索的全部交易对，带来源标注。
 *
 * OKX 独有的（如 HYPEUSDT）会被标成 okx，界面上可以明示
 * 「这个币的数据来自 OKX」——数据来自哪里，用户有权知道。
 */
export interface RoutedSymbol extends SymbolInfo {
  exchange: Exchange;
}

export async function fetchSymbols(): Promise<RoutedSymbol[]> {
  const [reg, binanceInfo] = await Promise.all([
    registry(),
    fetchUsdtSymbols().catch(() => [] as SymbolInfo[]),
  ]);

  const out: RoutedSymbol[] = binanceInfo.map((s) => ({ ...s, exchange: 'binance' as const }));
  const seen = new Set(out.map((s) => s.symbol));

  for (const sym of reg.okx) {
    if (seen.has(sym)) continue;
    const m = /^([A-Z0-9]+)(USDT|USDC)$/.exec(sym);
    if (!m) continue;
    out.push({ symbol: sym, baseAsset: m[1], quoteAsset: m[2], exchange: 'okx' });
  }
  return out;
}

/** 某个币种的数据来源，用于在界面上标注 */
export async function describeSource(symbol: string): Promise<Exchange> {
  return resolveExchange(symbol);
}
