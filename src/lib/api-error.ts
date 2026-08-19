import { NextResponse } from 'next/server';
import { UpstreamError, isGeoBlocked } from './datasources/http';

/**
 * 统一的上游错误响应。
 *
 * 特别处理地理封锁：如果哪天代码被改回 api.binance.com，或者用户换了网络环境，
 * 451 会被翻译成一句能直接照做的提示，而不是一个让人摸不着头脑的 500。
 */
export function apiError(err: unknown, source: string) {
  if (isGeoBlocked(err)) {
    return NextResponse.json(
      {
        error: `${source} 返回地理封锁（HTTP ${(err as UpstreamError).status}）。` +
          '本项目应使用 data-api.binance.vision 公开镜像，该域名不受地区限制；' +
          '若该提示出现，说明请求打到了受限的 api.binance.com。',
        code: 'GEO_BLOCKED',
      },
      { status: 502 },
    );
  }
  const message = err instanceof Error ? err.message : String(err);
  return NextResponse.json({ error: `${source} 请求失败：${message}` }, { status: 502 });
}
