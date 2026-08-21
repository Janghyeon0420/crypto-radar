import { NextResponse } from 'next/server';
import { fetchOnchainSnapshot } from '@/lib/datasources/onchain';

/**
 * 链上数据：稳定币总供应 + BTC 网络状态。
 *
 * 两路都独立 settle，一路挂掉不影响另一路。
 * 上游各自带缓存（稳定币 6 小时、网络 10 分钟），反复请求不会打到人家。
 */
export async function GET() {
  const started = Date.now();
  const snapshot = await fetchOnchainSnapshot();
  const ms = Date.now() - started;

  // 稳定币接口返回 1.2MB 全量历史，冷缓存时会慢；慢到什么程度要看得见
  if (ms > 3000) {
    console.log(
      `[onchain] 快照耗时 ${ms}ms（冷缓存）· 稳定币 ${snapshot.stablecoins ? 'ok' : '无'}` +
        ` · BTC 网络 ${snapshot.btcNetwork ? 'ok' : '无'}`,
    );
  }

  return NextResponse.json(snapshot);
}
