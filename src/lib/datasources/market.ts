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

async function registry(): Promise<Registry> {
  const cached = g[KEY];
  if (cached && Date.now() - cached.at < TTL_MS) return cached;

  const [binance, okx] = await Promise.allSettled([fetchUsdtSymbols(), fetchOkxSpotSymbols()]);

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
  const reg = await registry();
  if (reg.binance.has(symbol)) return 'binance';
  if (reg.okx.has(symbol)) return 'okx';
  return 'binance';
}

export async function fetchCandles(
  symbol: string,
  interval: Interval,
  limit = 500,
): Promise<Candle[]> {
  const ex = await resolveExchange(symbol);
  return ex === 'okx'
    ? fetchOkxCandles(symbol, interval, limit)
    : fetchBinanceCandles(symbol, interval, limit);
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

  const reg = await registry();
  const binance: string[] = [];
  const okx: string[] = [];

  for (const s of symbols) {
    if (reg.binance.has(s)) binance.push(s);
    else if (reg.okx.has(s)) okx.push(s);
    else binance.push(s);
  }

  const [b, o] = await Promise.allSettled([
    binance.length ? fetchBinanceTickers(binance) : Promise.resolve([]),
    okx.length ? fetchOkxTickers(okx) : Promise.resolve([]),
  ]);

  // 一家挂掉不该让另一家的币也没有行情
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
