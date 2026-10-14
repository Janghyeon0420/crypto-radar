import { NextResponse } from 'next/server';
import { UpstreamError, isGeoBlocked } from './datasources/http';

/** Translate upstream failures without guessing their exchange or location. */
export function apiError(err: unknown, source: string) {
  const status = err instanceof UpstreamError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const code = isGeoBlocked(err) ? 'GEO_BLOCKED'
    : status === 403 ? 'UPSTREAM_FORBIDDEN'
    : status === 429 ? 'UPSTREAM_RATE_LIMITED'
    : 'UPSTREAM_UNAVAILABLE';
  const hint = status === 451 ? ' 当前出口受到地区访问限制，请检查服务端网络或代理。'
    : status === 403 ? ' 上游拒绝访问，请检查访问策略或服务端网络。'
    : status === 429 ? ' 上游请求过于频繁，请稍后重试。' : '';
  return NextResponse.json({ error: `${source} 请求失败：${message}${hint}`, code }, { status: 502 });
}
