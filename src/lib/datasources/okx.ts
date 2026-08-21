/**
 * OKX 数据源。
 *
 * 最初只用来补币安缺失的衍生品指标：币安的 fapi 在美国 IP 下 451，
 * binance.vision 镜像又只有现货；Bybit 实测直接 403。
 * OKX 的公开接口在同样网络下正常返回 200。
 *
 * 后来还担起第二个职责：**币安没有的币种走这里**。
 * 比如 HYPE（Hyperliquid）在币安现货完全没有上架，
 * 而 OKX 有 HYPE-USDT 现货与 HYPE-USDT-SWAP 永续。
 * 这正是 datasources 层当初做统一契约的用意——
 * 上层拿到的都是 Candle / Ticker，不需要知道数据来自哪家。
 */

import { fetchJson } from './http';
import type { Candle, DerivativesSnapshot, Interval, Ticker } from './types';

const OKX_REST = 'https://www.okx.com';

interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T[];
}

/** BTCUSDT -> BTC-USDT-SWAP */
export function toOkxSwapId(symbol: string): string | null {
  const m = /^([A-Z0-9]+)(USDT|USDC)$/.exec(symbol);
  if (!m) return null;
  return `${m[1]}-${m[2]}-SWAP`;
}

export async function fetchDerivatives(symbol: string): Promise<DerivativesSnapshot | null> {
  const instId = toOkxSwapId(symbol);
  if (!instId) return null;

  // 两个接口互相独立，并发取；任一失败就整体降级为 null，
  // 因为衍生品数据是"锦上添花"，不该阻塞主行情渲染。
  const [funding, oi] = await Promise.allSettled([
    fetchJson<OkxResponse<{ fundingRate: string; fundingTime: string }>>(
      `${OKX_REST}/api/v5/public/funding-rate?instId=${instId}`,
      { ttlMs: 60_000 },
    ),
    fetchJson<OkxResponse<{ oi: string; oiCcy: string }>>(
      `${OKX_REST}/api/v5/public/open-interest?instType=SWAP&instId=${instId}`,
      { ttlMs: 60_000 },
    ),
  ]);

  if (funding.status !== 'fulfilled' || !funding.value.data?.[0]) return null;
  const f = funding.value.data[0];

  return {
    symbol,
    fundingRate: +f.fundingRate,
    nextFundingTime: +f.fundingTime,
    openInterest: oi.status === 'fulfilled' && oi.value.data?.[0] ? +oi.value.data[0].oiCcy : 0,
    source: 'okx',
  };
}


// ────────────────────────────────────────────────────────────
// 现货：供币安没有的币种使用
// ────────────────────────────────────────────────────────────

/** BTCUSDT -> BTC-USDT（现货） */
export function toOkxSpotId(symbol: string): string | null {
  const m = /^([A-Z0-9]+)(USDT|USDC)$/.exec(symbol);
  return m ? `${m[1]}-${m[2]}` : null;
}

/**
 * 周期名映射。OKX 的小时以上用大写（1H/4H/1D/1W），分钟用小写（1m/5m/15m），
 * 传错不会报错，只会返回空数组——这种「静默返回空」最难查，所以做成显式表。
 */
const BAR: Record<Interval, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1H',
  '4h': '4H',
  '1d': '1D',
  '1w': '1W',
};

type OkxCandleRow = [
  ts: string,
  o: string,
  h: string,
  l: string,
  c: string,
  vol: string,
  volCcy: string,
  volCcyQuote: string,
  confirm: string,
];

/**
 * 现货 K 线。
 *
 * 两处与币安不同，都会静默出错：
 *   1. **返回是倒序的**（最新在前），必须反转，否则所有指标都会算反
 *   2. 单次上限 300 根（币安是 1000）。要更多得翻页，这里不翻——
 *      300 根足够 MA200 与本项目的全部指标，翻页只会增加失败面
 */
export async function fetchOkxCandles(
  symbol: string,
  interval: Interval,
  limit = 300,
): Promise<Candle[]> {
  const instId = toOkxSpotId(symbol);
  if (!instId) return [];

  const capped = Math.min(limit, 300);
  const res = await fetchJson<OkxResponse<OkxCandleRow>>(
    `${OKX_REST}/api/v5/market/candles?instId=${instId}&bar=${BAR[interval]}&limit=${capped}`,
    { ttlMs: 5_000, timeoutMs: 12_000 },
  );
  if (res.code !== '0' || !Array.isArray(res.data)) return [];

  return res.data
    .map((k) => ({
      time: +k[0],
      open: +k[1],
      high: +k[2],
      low: +k[3],
      close: +k[4],
      volume: +k[5],
      // OKX 不提供主动买入量，对应的微观结构指标会自动降级为不可用
      takerBuyVolume: undefined,
    }))
    .reverse();
}

interface OkxTickerRow {
  instId: string;
  last: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volCcy24h: string;
}

/** 现货 24h 行情。一次请求取回全部现货，再按需筛，比逐个查省得多。 */
export async function fetchOkxTickers(symbols: string[]): Promise<Ticker[]> {
  const wanted = new Map<string, string>();
  for (const s of symbols) {
    const id = toOkxSpotId(s);
    if (id) wanted.set(id, s);
  }
  if (wanted.size === 0) return [];

  const res = await fetchJson<OkxResponse<OkxTickerRow>>(
    `${OKX_REST}/api/v5/market/tickers?instType=SPOT`,
    { ttlMs: 5_000, timeoutMs: 12_000 },
  );
  if (res.code !== '0' || !Array.isArray(res.data)) return [];

  const out: Ticker[] = [];
  for (const t of res.data) {
    const symbol = wanted.get(t.instId);
    if (!symbol) continue;
    const open = +t.open24h;
    out.push({
      symbol,
      last: +t.last,
      changePercent: open > 0 ? ((+t.last - open) / open) * 100 : 0,
      high24h: +t.high24h,
      low24h: +t.low24h,
      quoteVolume24h: +t.volCcy24h,
    });
  }
  return out;
}

/** OKX 现货全部 USDT/USDC 交易对，归一化成 BTCUSDT 形式 */
export async function fetchOkxSpotSymbols(): Promise<string[]> {
  const res = await fetchJson<OkxResponse<{ instId: string; state: string }>>(
    `${OKX_REST}/api/v5/public/instruments?instType=SPOT`,
    // 交易对列表变动很慢，缓存 1 小时
    { ttlMs: 3600_000, timeoutMs: 15_000 },
  );
  if (res.code !== '0' || !Array.isArray(res.data)) return [];

  return res.data
    .filter((i) => i.state === 'live' && /-(USDT|USDC)$/.test(i.instId))
    .map((i) => i.instId.replace('-', ''));
}
