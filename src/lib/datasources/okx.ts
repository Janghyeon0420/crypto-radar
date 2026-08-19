/**
 * OKX 永续合约数据源，用来补币安缺失的衍生品指标。
 *
 * 为什么是 OKX：币安的 fapi 在美国 IP 下 451，binance.vision 镜像又只有现货；
 * Bybit 实测直接 403。OKX 的公开接口在同样网络下正常返回 200，
 * 且 BTC/ETH 等主流币的永续持仓量足够有代表性，可以作为杠杆情绪的代理指标。
 */

import { fetchJson } from './http';
import type { DerivativesSnapshot } from './types';

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
