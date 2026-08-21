/**
 * 币安公开市场数据源（现货）。
 *
 * ⚠️ 关键设计决策：本文件刻意使用 data-api.binance.vision，而不是 api.binance.com。
 *
 * 原因：api.binance.com / api1-4.binance.com / fapi.binance.com / stream.binance.com
 * 对美国出口 IP 一律返回 HTTP 451（实测见 docs/DATA-SOURCES.md）。
 * 而 *.binance.vision 是币安官方对外提供的公开市场数据镜像，不做地理封锁，
 * 数据来自同一套撮合引擎，价格与主站盘口完全一致。
 *
 * 该镜像的边界：
 *   - 只有公开行情，无任何签名/私有端点（/api/v3/account 返回 404）
 *   - 只有现货，没有合约 fapi（资金费率/持仓量请见 okx.ts）
 * 因此本项目定位为纯只读看板，不接账户、不下单。
 */

import { fetchJson } from './http';
import type { Candle, Interval, OrderBook, Ticker } from './types';

export const BINANCE_REST = 'https://data-api.binance.vision';
export const BINANCE_WS = 'wss://data-stream.binance.vision';

/** 币安 K 线的原始数组格式，字段顺序由 API 固定 */
type RawKline = [
  openTime: number,
  open: string,
  high: string,
  low: string,
  close: string,
  volume: string,
  closeTime: number,
  quoteVolume: string,
  trades: number,
  takerBuyBase: string,
  ...rest: unknown[],
];

export async function fetchCandles(
  symbol: string,
  interval: Interval,
  limit = 500,
): Promise<Candle[]> {
  const url = `${BINANCE_REST}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  // K 线只在收盘时变化，1m 线缓存 5 秒足够，长周期可以更久；这里取保守值
  const raw = await fetchJson<RawKline[]>(url, { ttlMs: 5_000 });
  return raw.map((k) => ({
    time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    trades: k[8],
    takerBuyVolume: +k[9],
  }));
}

interface RawTicker {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  highPrice: string;
  lowPrice: string;
  quoteVolume: string;
}

/** 批量取 24h 行情。传 symbols 时只取指定交易对，省带宽（全量响应约 1.5MB）。 */
export async function fetchTickers(symbols?: string[]): Promise<Ticker[]> {
  let url = `${BINANCE_REST}/api/v3/ticker/24hr`;
  if (symbols?.length) {
    url += `?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
  }
  const raw = await fetchJson<RawTicker[] | RawTicker>(url, { ttlMs: 3_000 });
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map(toTicker);
}

function toTicker(r: RawTicker): Ticker {
  return {
    symbol: r.symbol,
    last: +r.lastPrice,
    changePercent: +r.priceChangePercent,
    high24h: +r.highPrice,
    low24h: +r.lowPrice,
    quoteVolume24h: +r.quoteVolume,
  };
}

export async function fetchOrderBook(symbol: string, limit = 20): Promise<OrderBook> {
  const url = `${BINANCE_REST}/api/v3/depth?symbol=${symbol}&limit=${limit}`;
  const raw = await fetchJson<{ bids: [string, string][]; asks: [string, string][] }>(url, {
    ttlMs: 2_000,
  });
  const num = (l: [string, string][]) => l.map(([p, q]) => [+p, +q] as [number, number]);
  return { symbol, bids: num(raw.bids), asks: num(raw.asks) };
}

export interface SymbolInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
}

/**
 * 拉取全部可交易的 USDT 交易对，供"添加自选"搜索用。
 * exchangeInfo 响应较大（~600KB）且几乎不变，缓存 1 小时。
 */
export async function fetchUsdtSymbols(): Promise<SymbolInfo[]> {
  const url = `${BINANCE_REST}/api/v3/exchangeInfo`;
  const raw = await fetchJson<{
    symbols: { symbol: string; baseAsset: string; quoteAsset: string; status: string }[];
  }>(url, { ttlMs: 3_600_000, timeoutMs: 25_000 });

  return raw.symbols
    .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map(({ symbol, baseAsset, quoteAsset }) => ({ symbol, baseAsset, quoteAsset }));
}
